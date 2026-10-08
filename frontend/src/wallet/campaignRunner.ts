// The campaign runner (High-Value Protection spec §5–§9): one action per tick, chosen by the pure reducer of the
// shared core (reference/typescript/src/wallet/campaign.ts nextAction) from the journaled campaign and fresh facts.
// Every tick first RECONCILES every open tranche from what the wallet can observe — its journal, the predicted
// escrow's balance, the executor's job by orderId, the tracker — so a crash between a send and its journal entry
// never funds or hands over twice (§9); then it tracks what is in flight, applies the settlement gate of §6 with the
// elapsed-time margin, computes the pause facts of §8, and performs the one next step with exactly the machinery a
// single order uses (sdk/swapExecute.ts). The tick runs from the App-level scheduler on any tab while the wallet is
// unlocked and plans its own next tick. Money-moving failures with an unknown outcome pause with `reconcile`; a
// failure before anything was sent is thrown to the scheduler's backoff (§9: no automatic retry on money movement).
import type { Hex } from "viem";
import {
  canRelease, detectPause, exposure, nextAction, settledBy, withCampaignState, withTrancheState, checkWithinBounds, rateE18,
  FINALITY_MARGIN_SECONDS, PAUSED_TRACK_INTERVAL_MS, TRACK_INTERVAL_MS, RATE_SCALE,
  type Action, type Campaign, type PauseFacts, type PauseReason, type Tranche, type TrancheState,
} from "@ref/wallet/campaign";
import { availablePrice } from "@ref/wallet/valuation";
import { atLeast } from "@ref/wallet/valuation";
import type { Deployment } from "../sdk/chain";
import { assetsOf, type Asset } from "../sdk/assets";
import { escrowBalance, trackOrder, type Tracked } from "../sdk/orderTracker";
import { priceStore } from "../sdk/prices";
import { ensureSpendable } from "../sdk/privateTx";
import { relayerInfo, relayerSwapStatus, type SwapJob } from "../sdk/relayer";
import { commitOrder, handOverSigned, prepareAndSign, resumeOrder, returnOrderToBalance, type Signed } from "../sdk/swapExecute";
import { abandonSwap, fundEscrow } from "../sdk/swapFunding";
import { swapService, type QuoteSet, type RiskView, type ServiceOrder } from "../sdk/swapService";
import type { MinimumMoved } from "../sdk/providerCall";
import { chainKindOf, consumeFreshAddress, peekFreshAddress } from "../keys/chainKeys";
import { alertKindFor, withAlert } from "./alerts";
import { campaignById, childOrder, expectedOut, forgetCampaignTick, largestPlanned, notesShapedFor, putCampaign, replanRemainder, scheduleTick, sourceEquivalent, cryptoUniform, TERMINAL_STATES } from "./campaigns";
import type { ScheduledAction, StoredSwap } from "./journal";
import { noteStore } from "./notes";
import { notify } from "./notifications";
import { cancelAction, sampleDueAt, schedulerStatus } from "./schedule";
import { session as defaultSession, type WalletSession } from "./session";
import { settings as defaultSettings, type Settings } from "./settings";

/** Everything the runner reads or moves, behind one interface: the wallet's modules by default, fakes in the tests. */
export interface CampaignIo {
  commit(c: Campaign, t: Tranche, destination: string): Promise<{ stored: StoredSwap; order: ServiceOrder }>;
  /** the private withdrawal into the tranche's escrow; `onStatus` lines say when the submission starts (the reconcile boundary) */
  fund(stored: StoredSwap, onStatus: (line: string) => void): Promise<{ txHash: string }>;
  escrowBalance(stored: StoredSwap): Promise<bigint | null>;
  sign(stored: StoredSwap): Promise<Signed | { moved: MinimumMoved }>;
  handOver(stored: StoredSwap, signed: Signed): Promise<{ job?: SwapJob }>;
  /** the executor's job for this order, if it has one (keyed by orderId) */
  job(stored: StoredSwap): Promise<SwapJob | null>;
  track(stored: StoredSwap): Promise<{ tracked: Tracked; job: SwapJob | null }>;
  refund(stored: StoredSwap): Promise<SwapJob>;
  quote(c: Campaign, amount: bigint): Promise<QuoteSet>;
  risk(provider: string): Promise<RiskView | null>;
  gasPriceWei(): Promise<string | null>;
  crossRateE18(c: Campaign): bigint | null;
  shape(c: Campaign, needed: bigint, onStatus: (line: string) => void): Promise<void>;
  notesShaped(c: Campaign, needed: bigint): boolean;
  freshDestination(c: Campaign): { address: string; index?: number };
}

export interface IoDeps { masterSeed: Uint8Array; deployment: Deployment | null; session: WalletSession; submission: Settings["submission"] }

/** The service forgets orders at a restart: the runner keeps the ones it committed and rebuilds the others from the journal. */
const orders = new Map<string, ServiceOrder>();
/** Signatures stay in the wallet until the hand-over; a tranche whose signature was lost (a reload) is signed again. */
const signedCache = new Map<string, Signed>();
/** Facts read at most once a minute: the provider's risk view and the relayer's gas price. */
const factCache = new Map<string, { at: number; value: unknown }>();
const FACT_TTL_MS = 60_000;
async function cached<T>(key: string, now: number, read: () => Promise<T>, fresh = false): Promise<T> {
  const hit = factCache.get(key);
  if (!fresh && hit && now - hit.at < FACT_TTL_MS) return hit.value as T;
  const value = await read();
  factCache.set(key, { at: now, value });
  return value;
}
/** Tests: forget what the runner keeps in memory. */
export function resetRunnerMemory(): void { orders.clear(); signedCache.clear(); factCache.clear(); }

const assetOf = (deployment: Deployment | null, c: Campaign): Asset => {
  const assets = assetsOf(deployment);
  return assets.find((a) => (a.token ?? "native").toLowerCase() === c.request.from.asset.toLowerCase()) ?? assets[0];
};

/** The Chainlink cross-rate (destination base units per source base unit, 1e18) from the price store, when both feeds are usable. */
export function crossRateFromPrices(c: Campaign): bigint | null {
  const p = priceStore.state().prices;
  const from = availablePrice(p, c.request.from.symbol), to = availablePrice(p, c.request.to.symbol);
  if (!from || !to || to.usd1e8 <= 0n) return null;
  return (from.usd1e8 * 10n ** BigInt(c.request.to.decimals) * RATE_SCALE) / (to.usd1e8 * 10n ** BigInt(c.request.from.decimals));
}

export function defaultIo(d: IoDeps): CampaignIo {
  const relayerUrl = d.submission.kind === "relayer" ? d.submission.url : null;
  const orderFor = async (stored: StoredSwap): Promise<ServiceOrder> => {
    const hit = orders.get(stored.orderId.toLowerCase());
    if (hit) return hit;
    const order = await resumeOrder(d.deployment, stored);
    orders.set(stored.orderId.toLowerCase(), order);
    return order;
  };
  return {
    async commit(c, t, destination) {
      const fromAsset = assetOf(d.deployment, c);
      const entered = c.bounds.destination.kind !== "fresh-per-tranche";
      const r = await commitOrder({
        masterSeed: d.masterSeed, deployment: d.deployment, session: d.session,
        request: { from: c.request.from, to: c.request.to, amount: t.amount, destination, slippageBps: 50, preference: c.request.preference as never, tier: c.tier, destinationKind: entered ? "entered" : "fresh", preferNative: c.request.preference === "native", mode: c.mode, executeWindowSeconds: c.bounds.executeWindowSeconds },
        policy: (c.policy ?? "balanced") as never, provider: c.provider, fromAsset, preference: c.request.preference as never, walletTier: c.tier, schedule: null, campaign: { id: c.id, index: t.index },
      });
      orders.set(r.stored.orderId.toLowerCase(), r.order);
      return { stored: r.stored, order: r.order };
    },
    fund: (stored, onStatus) => fundEscrow({ masterSeed: d.masterSeed, deployment: d.deployment, stored, session: d.session, onStatus }),
    escrowBalance: async (stored) => {
      if (!d.deployment) return null;
      const token = (stored.request as { from?: { asset?: string } })?.from?.asset;
      return escrowBalance(d.deployment, stored.endpoint as `0x${string}`, token && token !== "native" ? (token as `0x${string}`) : null).catch(() => null);
    },
    sign: async (stored) => prepareAndSign({ masterSeed: d.masterSeed, deployment: d.deployment, session: d.session, stored, order: await orderFor(stored), submission: d.submission, onStatus: (l) => schedulerStatus.progress(l) }),
    handOver: async (stored, signed) => handOverSigned({ deployment: d.deployment, session: d.session, stored, order: await orderFor(stored), signed, submission: d.submission }),
    job: (stored) => (relayerUrl ? relayerSwapStatus(relayerUrl, stored.orderId).catch(() => null) : Promise.resolve(null)),
    track: (stored) => trackOrder(stored, { deployment: d.deployment, relayerUrl, session: d.session }),
    refund: (stored) => returnOrderToBalance({ deployment: d.deployment, session: d.session, stored, submission: d.submission }),
    quote: (c, amount) => swapService.quote({ from: c.request.from, to: c.request.to, amount: amount.toString(), destination: c.bounds.destination.kind === "fresh-per-tranche" ? peekFreshAddress(d.masterSeed, chainKindOf(c.request.to.chain), d.session).address : c.bounds.destination.address, slippageBps: 50, preference: c.request.preference as never, tier: c.tier, mode: c.mode, destinationKind: c.bounds.destination.kind === "fresh-per-tranche" ? "fresh" : "entered", preferNative: c.request.preference === "native" }),
    risk: (provider) => swapService.risk(provider).catch(() => null),
    gasPriceWei: () => (relayerUrl ? relayerInfo(relayerUrl).then((i) => i.gasPriceWei).catch(() => null) : Promise.resolve(null)),
    crossRateE18: crossRateFromPrices,
    shape: async (c, needed, onStatus) => { if (!d.deployment) throw new Error("No deployment configured."); await ensureSpendable({ masterSeed: d.masterSeed, deployment: d.deployment, needed, vault: assetOf(d.deployment, c).vault as Hex, onStatus }); },
    notesShaped: (c, needed) => notesShapedFor(assetOf(d.deployment, c).vault, needed),
    freshDestination: (c) => (c.bounds.destination.kind === "fresh-per-tranche" ? (() => { const a = consumeFreshAddress(d.masterSeed, chainKindOf(c.request.to.chain), d.session); return { address: a.address, index: a.index }; })() : { address: c.bounds.destination.address }),
  };
}

export interface TickDeps {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  session?: WalletSession;
  io?: CampaignIo;
  now?: () => number;
  settings?: () => Settings;
  /** tests: the notifier and the hidden-tab flag */
  notify?: typeof notify;
  rng?: () => number;
  /** the finality margins per chain (tests shorten them) */
  margins?: Record<string, number>;
}
export interface TickResult { action: Action; before: Campaign; after: Campaign; nextAt: number | null }

const big = (x: string | undefined): bigint => BigInt(x ?? "0");
const SENT = /handing it to the relayer|submitting through the connected wallet|Waiting for the transaction/i;

/** The tranche state a tracker reading maps to (§7); `null` keeps the current one (an unknown reading never settles, I3). */
function trancheStateOf(t: Tranche, tracked: Tracked, job: SwapJob | null, stored: StoredSwap, gate: Campaign["plan"]["gate"], chain: string, now: number, margins: Record<string, number>): { state: TrancheState; patch: Partial<Tranche>; note?: string } | null {
  const s = tracked.state;
  const patch: Partial<Tranche> = { ...(job?.id && !t.jobId ? { jobId: job.id } : {}) };
  const rate = big(t.expected?.rateE18);
  const deliveredOut = tracked.deliveredAmount !== undefined ? parseDelivered(tracked.deliveredAmount) : undefined;
  if (s === "REFUNDED") return { state: "refunded", patch: { ...patch, outcome: { ...t.outcome, refunded: t.amount } }, note: "the escrow returned to the private balance" };
  if (s === "FAILED") return { state: "failed", patch, note: tracked.detail };
  if (s === "REFUND_PENDING" || s === "PROVIDER_TIMEOUT" || s === "DESTINATION_FAILED") return t.state === "refunding" ? null : { state: "refunding", patch, note: tracked.detail };
  if (s === "EXPIRED" || s === "CANCELLED") return t.state === "committed" ? { state: "skipped", patch, note: "the order expired before it was funded" } : null;
  if (s === "PARTIAL") {
    const refundBack = job?.state === "completed" || (stored.refunds?.length ?? 0) > 0;
    const outcome = { ...t.outcome, ...(deliveredOut !== undefined ? { deliveredOut: deliveredOut.toString(), delivered: sourceEquivalent(deliveredOut, rate).toString() } : {}) };
    if (refundBack && outcome.delivered !== undefined) {
      // the rest came back: the tranche settles for what was delivered and the remainder returns to `remaining` (re-planned, §7)
      const delivered = BigInt(outcome.delivered) > BigInt(t.amount) ? t.amount : outcome.delivered;
      return { state: "settled", patch: { ...patch, amount: delivered, outcome: { ...outcome, refunded: (BigInt(t.amount) - BigInt(delivered)).toString() }, settledAt: now }, note: "partial fill: the rest returned to the private balance" };
    }
    return { state: "partial", patch: { ...patch, outcome }, note: tracked.detail };
  }
  const delivered = s === "DESTINATION_FINAL" || s === "COMPLETED";
  const deliveredSince = delivered ? (t.deliveredSince ?? now) : t.deliveredSince;
  const outcome = delivered && deliveredOut !== undefined ? { ...t.outcome, deliveredOut: deliveredOut.toString(), delivered: sourceEquivalent(deliveredOut, rate).toString() } : t.outcome;
  if (settledBy(gate, { state: s, deliveredSince, chain }, now, margins)) return { state: "settled", patch: { ...patch, deliveredSince, outcome: outcome ?? { delivered: t.amount }, settledAt: now }, note: `settled at the ${gate} gate` };
  if (delivered || s === "DESTINATION_SUBMITTED") return t.state === "destination-submitted" && t.deliveredSince === deliveredSince && !(deliveredOut !== undefined && t.outcome?.deliveredOut === undefined) ? null : { state: "destination-submitted", patch: { ...patch, deliveredSince, outcome }, note: delivered ? "delivered; waiting for the finality margin" : tracked.detail };
  if (s === "SOURCE_FINAL" || s === "PROVIDER_EXECUTING") return t.state === "source-confirmed" ? null : { state: "source-confirmed", patch, note: tracked.detail };
  return Object.keys(patch).length ? { state: t.state, patch } : null;
}
const parseDelivered = (x: string): bigint => { try { return BigInt(x); } catch { return 0n; } };

interface TrackPass { campaign: Campaign; active?: { trackState: string; jobState?: string; ageSeconds?: number; expectedSeconds?: number }; justSettled: { index: number; deliveredOut?: string; minOut?: string }[]; reconcileNeeded: boolean }

/** Reconcile every open tranche and track the ones in flight (§9, §6). */
async function reconcileAndTrack(c0: Campaign, io: CampaignIo, s: WalletSession, now: number, margins: Record<string, number>, rng: () => number): Promise<TrackPass> {
  let c = c0;
  const justSettled: TrackPass["justSettled"] = [];
  let active: TrackPass["active"];
  let reconcileNeeded = false;
  for (const t of c0.tranches) {
    if (!t.orderId || ["planned", "ready", "settled", "refunded", "skipped"].includes(t.state)) continue;
    const stored = childOrder(t, s);
    if (!stored) { c = withTrancheState(c, t.index, "failed", now, {}, "its order is missing from the journal"); reconcileNeeded = true; continue; }
    // a crash between a send and its journal entry: the facts decide (never a second funding or hand-over)
    if (t.state === "committed") {
      if (stored.fundedTx) c = withTrancheState(c, t.index, "funded", now, {}, "funded (reconciled from the journal)");
      else { const bal = await io.escrowBalance(stored); if (bal !== null && bal >= BigInt(t.amount)) c = withTrancheState(c, t.index, "funded", now, {}, "funded (reconciled from the escrow's balance)"); }
      continue;
    }
    if (t.state === "funded" || t.state === "signed" || t.state === "failed") {
      const job = stored.jobId ? null : await io.job(stored);
      if (stored.jobId || job) {
        const state = (job?.state ?? stored.state) === "refund-only" ? "refunding" : "executing";
        c = withTrancheState(c, t.index, state, now, { jobId: stored.jobId ?? job?.id, handedOverAt: t.handedOverAt ?? now }, `${state} (reconciled from the executor's job)`);
      }
      if (c.tranches[t.index].state !== "executing" && c.tranches[t.index].state !== "refunding") continue;
    }
    const current = c.tranches[t.index];
    const r = await io.track(stored).catch(() => null);
    if (!r) continue; // an unreadable state keeps the tranche where it is (I3)
    const next = trancheStateOf(current, r.tracked, r.job, stored, current.gate ?? c.plan.gate, c.request.to.chain, now, margins);
    if (next) {
      c = withTrancheState(c, t.index, next.state, now, next.patch, next.note);
      if (next.state === "settled" && current.state !== "settled") {
        justSettled.push({ index: t.index, deliveredOut: next.patch.outcome?.deliveredOut, minOut: current.expected?.minOut });
        c = withAlert(c, "step-settled", `Step ${t.index + 1} settled.`, now, t.index);
        // the random delay before the next release (§4): drawn at settlement
        const planned = c.tranches.find((x) => x.state === "planned" && x.notBefore === undefined);
        if (planned) c = withTrancheState(c, planned.index, "planned", now, { notBefore: sampleDueAt(c.plan.cadenceSeconds, now, rng) });
      }
    }
    const after = c.tranches[t.index];
    if (!active && ["executing", "source-confirmed", "destination-submitted", "partial"].includes(after.state)) {
      active = { trackState: r.tracked.state, jobState: r.job?.state, ageSeconds: after.handedOverAt ? Math.floor((now - after.handedOverAt) / 1000) : undefined, expectedSeconds: after.expected?.etaSeconds };
    }
  }
  return { campaign: c, active, justSettled, reconcileNeeded };
}

const pauseWith = (c: Campaign, reason: PauseReason, detail: string, now: number, index?: number): Campaign =>
  withAlert(withCampaignState(c, "paused", now, detail, { pause: { reason, detail, at: now, ...(index !== undefined ? { trancheIndex: index } : {}) } }), alertKindFor(reason, detail), detail, now, index);

/** One tick: reconcile, track, decide, perform one action, plan the next tick. Returns null when the campaign is gone or finished. */
export async function runCampaignTick(a: ScheduledAction, deps: TickDeps): Promise<TickResult | null> {
  const s = deps.session ?? defaultSession;
  const now = deps.now?.() ?? Date.now();
  const cfg = (deps.settings ?? (() => defaultSettings.get()))();
  const rng = deps.rng ?? cryptoUniform;
  const margins = deps.margins ?? FINALITY_MARGIN_SECONDS;
  const c0 = campaignById(a.orderId, s);
  if (!c0 || TERMINAL_STATES.includes(c0.state)) { cancelAction(a.id, s); return null; }
  const io = deps.io ?? defaultIo({ masterSeed: deps.masterSeed, deployment: deps.deployment, session: s, submission: cfg.submission });
  const send = deps.notify ?? notify;
  schedulerStatus.start(a.id, "Protected swap: checking every open step…");
  try {
    const pass = await reconcileAndTrack(c0, io, s, now, margins, rng);
    let c = pass.campaign;
    // the facts of §8
    // a resume reassesses on FRESH facts (§8): the minute-old cache is bypassed while reassessing
    const fresh = c.state === "reassessing";
    const risk = await cached(`risk:${c.provider}`, now, () => io.risk(c.provider ?? ""), fresh).catch(() => null);
    const gas = await cached("gas", now, () => io.gasPriceWei(), fresh).catch(() => null);
    const settledNow = pass.justSettled[0];
    const facts: PauseFacts = {
      now, walletPaused: cfg.protection.pauseLargeOperations,
      crossRateE18: io.crossRateE18(c)?.toString(),
      incidentDates: risk?.security.incidentList.map((i) => Date.parse(i.date)).filter((d) => Number.isFinite(d)),
      providerHealth: risk ? { breakerOpen: !!risk.breaker.open } : undefined,
      gasPriceWei: gas ?? undefined, gasPriceAtConfirmationWei: c.gasPriceAtConfirmationWei,
      jobState: pass.active?.jobState, trackState: pass.active?.trackState,
      settlementAgeSeconds: pass.active?.ageSeconds, expectedSeconds: pass.active?.expectedSeconds,
      delivered: settledNow?.deliveredOut, guaranteedMin: settledNow?.minOut,
      reconcileNeeded: pass.reconcileNeeded,
    };
    const pause = c.state === "running" || c.state === "reassessing" || c.state === "user-confirmed" || c.state === "preparing-notes" ? detectPause(c, facts) : null;
    const needed = largestPlanned(c);
    const notesShaped = !c.plan.shapeNotes || io.notesShaped(c, needed);
    const action = nextAction(c, { now, pause, notesShaped });
    let nextAt: number | null = now + TRACK_INTERVAL_MS;
    const stop = (): void => { nextAt = null; };
    switch (action.kind) {
      case "none": stop(); break;
      case "wait": nextAt = Math.max(now + 1000, action.until); break;
      case "track": nextAt = now + TRACK_INTERVAL_MS; break;
      case "shape-notes": {
        if (c.state !== "preparing-notes") c = withCampaignState(c, "preparing-notes", now, "shaping the notes for the pieces");
        putCampaign(c, s);
        schedulerStatus.progress("Protected swap: shaping your private balance for the pieces…");
        await io.shape(c, needed, (l) => schedulerStatus.progress(l));
        nextAt = now + 1000;
        break;
      }
      case "commit": {
        const t = c.tranches[action.index];
        if (c.state !== "running") c = withCampaignState(c, "running", now, "the first step starts");
        const sinceS = Math.floor(now / 1000);
        if (sinceS >= c.bounds.expiry) { c = pauseWith(c, "bounds", "The operation's expiry passed before this step; nothing more is committed.", now, t.index); break; }
        const dest = io.freshDestination(c);
        c = withTrancheState(c, t.index, "ready", now, { destination: dest.address, ...(dest.index !== undefined ? { destinationIndex: dest.index } : {}), provider: c.provider, attempt: t.attempt + 1 });
        putCampaign(c, s); // journaled before the call (§9)
        schedulerStatus.progress(`Protected swap: committing step ${t.index + 1}…`);
        let r: { stored: StoredSwap; order: ServiceOrder };
        try { r = await io.commit(c, c.tranches[t.index], dest.address); }
        catch (e) {
          const m = (e as Error)?.message ?? String(e);
          c = withTrancheState(c, t.index, "planned", now, {}, `commit failed: ${m}`);
          c = pauseWith(c, /no quote|filtered|refus/i.test(m) ? "route-degraded" : "provider-error", `Step ${t.index + 1} could not be committed: ${m}`, now, t.index);
          break;
        }
        const q = r.order.quote;
        const fundedBefore = c.tranches.filter((x) => x.index !== t.index && ["funded", "signed", "failed", "executing", "source-confirmed", "destination-submitted", "partial", "refunding", "settled"].includes(x.state)).reduce((sum, x) => sum + BigInt(x.amount), 0n);
        const tipBps = Number((BigInt(r.order.params.executorTip) * 10000n) / BigInt(t.amount));
        const check = checkWithinBounds(c.bounds, { amount: BigInt(t.amount), toAmountMin: BigInt(q.toAmountMin), quoteExpiresAt: q.expiresAt, feeBps: tipBps, destination: dest.address, fundedBefore, now: sinceS });
        if (!check.ok) {
          abandonSwap(r.stored.orderId, s); // never funded: nothing left the private balance
          c = withTrancheState(c, t.index, "planned", now, { orderId: undefined }, `outside the bounds: ${check.reason}`);
          c = pauseWith(c, /minimum you approved/i.test(check.reason) ? "price-deviation" : "bounds", `Step ${t.index + 1} is outside what you approved: ${check.reason}`, now, t.index);
          break;
        }
        c = withTrancheState(c, t.index, "committed", now, { orderId: r.stored.orderId, provider: r.order.quote.provider, riskClass: c.plan.riskClass, gate: c.plan.gate, quoteExpiresAt: q.expiresAt, expected: { minOut: q.toAmountMin, rateE18: rateE18(BigInt(q.toAmount), BigInt(t.amount)).toString(), etaSeconds: q.plan?.expectedSeconds ?? q.etaSeconds } }, `order ${r.stored.orderId.slice(0, 10)}… committed with ${r.order.quote.provider}`);
        nextAt = now + 1000;
        break;
      }
      case "fund": {
        const t = c.tranches[action.index];
        const stored = childOrder(t, s);
        if (!stored) { c = withTrancheState(c, t.index, "failed", now, {}, "its order is missing from the journal"); c = pauseWith(c, "reconcile", `Step ${t.index + 1} has no order in the journal.`, now, t.index); break; }
        if (stored.fundedTx) { c = withTrancheState(c, t.index, "funded", now, {}, "already funded"); nextAt = now + 1000; break; }
        const bal = await io.escrowBalance(stored);
        if (bal !== null && bal >= BigInt(t.amount)) { c = withTrancheState(c, t.index, "funded", now, {}, "funded (the escrow already holds the amount)"); nextAt = now + 1000; break; }
        schedulerStatus.progress(`Protected swap: funding step ${t.index + 1} from your private balance…`);
        let sent = false;
        try {
          const w = await io.fund(stored, (line) => { if (SENT.test(line)) sent = true; schedulerStatus.progress(line); });
          c = withTrancheState(c, t.index, "funded", now, {}, `funded by ${w.txHash.slice(0, 10)}…`);
          nextAt = now + 1000;
        } catch (e) {
          const m = (e as Error)?.message ?? String(e);
          if (!sent) { putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw e; } // nothing was sent: the scheduler's backoff retries the tick
          c = pauseWith(c, "reconcile", `The funding of step ${t.index + 1} ended without a known outcome (${m}); the escrow is read before anything is sent again.`, now, t.index);
        }
        break;
      }
      case "sign": {
        const t = c.tranches[action.index];
        const stored = childOrder(t, s);
        if (!stored) { c = pauseWith(c, "reconcile", `Step ${t.index + 1} has no order in the journal.`, now, t.index); break; }
        schedulerStatus.progress(`Protected swap: checking and signing step ${t.index + 1}…`);
        try {
          const r = await io.sign(stored);
          if ("moved" in r) {
            // a lower minimum is a campaign-level decision, never a per-tranche tap (§3)
            c = pauseWith(c, "price-deviation", `Step ${t.index + 1} now guarantees ${r.moved.minOut} against the ${r.moved.approved} you approved; nothing was signed.`, now, t.index);
            break;
          }
          if (!r.sim.ok) { c = pauseWith(c, "provider-error", `Step ${t.index + 1} would not execute: ${r.sim.reason}. Nothing was handed over.`, now, t.index); break; }
          signedCache.set(stored.orderId.toLowerCase(), r);
          c = withTrancheState(c, t.index, "signed", now, {}, `signed and simulated (${r.label})`);
          nextAt = now + 1000;
        } catch (e) {
          const m = (e as Error)?.message ?? String(e);
          if (/receiver|does not do what this wallet asked for/i.test(m)) { c = pauseWith(c, "unexpected-destination", `Step ${t.index + 1}: ${m}`, now, t.index); break; }
          if (/escrow|digest|not the one this wallet committed|minimum/i.test(m)) { c = pauseWith(c, "provider-error", `Step ${t.index + 1}: ${m}`, now, t.index); break; }
          putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw e; // a network failure before anything was signed: backoff
        }
        break;
      }
      case "hand-over": {
        const t = c.tranches[action.index];
        const stored = childOrder(t, s);
        if (!stored) { c = pauseWith(c, "reconcile", `Step ${t.index + 1} has no order in the journal.`, now, t.index); break; }
        const existing = stored.jobId ? { id: stored.jobId, state: stored.state } : await io.job(stored);
        if (existing) { c = withTrancheState(c, t.index, "executing", now, { jobId: existing.id, handedOverAt: now }, "already handed over (reconciled)"); nextAt = now + TRACK_INTERVAL_MS; break; }
        const signed = signedCache.get(stored.orderId.toLowerCase());
        if (!signed) { c = withTrancheState(c, t.index, "funded", now, {}, "the signature is not in memory any more; signing again"); nextAt = now + 1000; break; }
        const release = canRelease(c, BigInt(t.amount));
        if (!release.ok) { nextAt = now + TRACK_INTERVAL_MS; break; }
        schedulerStatus.progress(`Protected swap: handing step ${t.index + 1} to the executor…`);
        try {
          const r = await io.handOver(stored, signed);
          signedCache.delete(stored.orderId.toLowerCase());
          c = withTrancheState(c, t.index, "executing", now, { jobId: r.job?.id, handedOverAt: now }, r.job ? `handed to the executor (job ${r.job.id.slice(0, 10)}…)` : "finalized; submitted by the connected wallet");
          nextAt = now + TRACK_INTERVAL_MS;
        } catch (e) {
          const m = (e as Error)?.message ?? String(e);
          if (/Not handed over|builds for/i.test(m)) { c = pauseWith(c, "provider-error", `Step ${t.index + 1}: ${m}`, now, t.index); break; }
          c = pauseWith(c, "reconcile", `The hand-over of step ${t.index + 1} ended without a known outcome (${m}); the executor is asked before anything is sent again.`, now, t.index);
        }
        break;
      }
      case "pause": {
        c = pauseWith(c, action.reason, action.detail, now, action.index);
        send({ kind: alertKindFor(action.reason, action.detail), title: "Protected swap paused", body: action.detail, campaignId: c.id });
        nextAt = now + PAUSED_TRACK_INTERVAL_MS;
        break;
      }
      case "replan": { c = replanRemainder(c, now, rng); nextAt = now + 1000; break; }
      case "requote": {
        if (c.state !== "requoting") c = withCampaignState(c, "requoting", now, "quoting the remaining amount again");
        const e = exposure(c);
        if (e.remaining <= 0n) { c = withCampaignState(c, "running", now, "nothing left to quote"); nextAt = now + 1000; break; }
        let set: QuoteSet;
        try { set = await io.quote(c, e.remaining); } catch (err) { c = pauseWith(c, "route-degraded", `No fresh quote for the remaining amount (${(err as Error)?.message ?? err}).`, now); break; }
        const chosen = set.chosen?.provider;
        if (!chosen) { c = pauseWith(c, "route-degraded", "No provider quotes the remaining amount right now.", now); break; }
        const snapshot = { ...(typeof c.riskSnapshot === "object" && c.riskSnapshot ? (c.riskSnapshot as object) : {}), requote: { at: now, provider: chosen, protection: set.protection ?? null, competition: set.competition ?? null } };
        if (chosen === c.provider) {
          c = withCampaignState(c, "running", now, `requoted: ${chosen} still carries the route`, { riskSnapshot: snapshot, pause: undefined });
        } else if (cfg.protection.autoReroute && !atLeast(c.tier, "high-value-secondary")) {
          c = withAlert(withCampaignState(c, "running", now, `rerouted to ${chosen} (automatic below the second-confirmation tier)`, { provider: chosen, riskSnapshot: snapshot, pause: undefined }), "route-changed", `The route changed to ${chosen} (adopted automatically, as you allowed).`, now);
          send({ kind: "route-changed", title: "Route changed", body: `The route changed to ${chosen}.`, campaignId: c.id });
        } else {
          c = withAlert(withCampaignState(c, "rerouting", now, `the route changed to ${chosen}: waiting for your review`, { pendingReroute: { provider: chosen, protection: set.protection ?? null, at: now }, riskSnapshot: snapshot }), "route-changed", `The route changed to ${chosen}; review it before the operation continues.`, now);
          send({ kind: "route-changed", title: "Route changed — review", body: `The route changed to ${chosen}.`, campaignId: c.id });
        }
        // the next release waits for the cadence again
        const planned = c.tranches.find((x) => x.state === "planned");
        if (planned) c = withTrancheState(c, planned.index, "planned", now, { notBefore: sampleDueAt(c.plan.cadenceSeconds, now, rng) });
        nextAt = now + 1000;
        break;
      }
      case "wind-down": {
        const t = c.tranches.find((x) => x.state === "funded" || x.state === "signed" || x.state === "failed")!;
        const stored = childOrder(t, s);
        if (!stored) { c = withTrancheState(c, t.index, "skipped", now, {}, "its order is missing from the journal"); nextAt = now + 1000; break; }
        schedulerStatus.progress(`Protected swap: returning step ${t.index + 1} to your private balance…`);
        try {
          const job = await io.refund(stored);
          signedCache.delete(stored.orderId.toLowerCase());
          c = withTrancheState(c, t.index, "refunding", now, { jobId: job.id }, "a refund-only job returns the escrow after its window");
          nextAt = now + 1000;
        } catch (e) {
          const m = (e as Error)?.message ?? String(e);
          putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw new Error(`returning step ${t.index + 1} failed: ${m}`); // the executor was not reached: backoff
        }
        break;
      }
      case "complete": {
        const cancelled = c.state === "winding-down";
        c = withAlert(withCampaignState(c, cancelled ? "cancelled" : "completed", now, cancelled ? "every step finished or returned" : "every step settled", { pause: undefined, pendingReroute: undefined }), cancelled ? "cancelled" : "completed", cancelled ? "The rest returned to your private balance." : "Every step settled.", now);
        send({ kind: cancelled ? "cancelled" : "completed", title: cancelled ? "Protected swap cancelled" : "Protected swap completed", body: cancelled ? "The rest returned to your private balance." : "Every step settled.", campaignId: c.id });
        stop();
        break;
      }
    }
    if (c.state === "paused" && action.kind !== "pause" && c0.state !== "paused") {
      send({ kind: c.pause ? alertKindFor(c.pause.reason, c.pause.detail) : "paused", title: "Protected swap paused", body: c.pause?.detail ?? "Paused.", campaignId: c.id });
      nextAt = now + PAUSED_TRACK_INTERVAL_MS;
    }
    putCampaign(c, s);
    if (nextAt !== null) scheduleTick(c.id, nextAt, s); else forgetCampaignTick(c.id, s);
    return { action, before: c0, after: c, nextAt };
  } finally {
    schedulerStatus.finish();
  }
}

/** The number of settled steps and the expected amount of the next one, for the screens. */
export function nextExpectedOut(c: Campaign): bigint | null {
  const t = c.tranches.find((x) => x.state !== "settled" && x.state !== "skipped" && x.state !== "refunded");
  return t?.expected ? expectedOut(BigInt(t.amount), BigInt(t.expected.rateE18)) : null;
}

export { noteStore as _notes };
