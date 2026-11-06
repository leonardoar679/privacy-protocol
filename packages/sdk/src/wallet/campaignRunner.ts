// The campaign runner (High-Value Protection spec §5–§9): one action per tick, chosen by the pure reducer of the
// shared core (packages/protocol/src/wallet/campaign.ts nextAction) from the journaled campaign and fresh facts.
// Every tick first RECONCILES every open tranche from what the wallet can observe — its journal, the predicted
// escrow's balance, the executor's job by orderId, the tracker — so a crash between a send and its journal entry
// never funds or hands over twice (§9); then it tracks what is in flight, applies the settlement gate of §6 with the
// elapsed-time margin, computes the pause facts of §8, and performs the one next step with exactly the machinery a
// single order uses (sdk/swapExecute.ts). The tick runs from the App-level scheduler on any tab while the wallet is
// unlocked and plans its own next tick. Money-moving failures with an unknown outcome pause with `reconcile`; a
// failure before anything was sent is thrown to the scheduler's backoff (§9: no automatic retry on money movement).
import type { Hex } from "viem";
import {
  canRelease, detectPause, exposure, nextAction, settledBy, swappedInFull, withCampaignState, withTrancheState, checkWithinBounds, rateE18, trancheMinimum,
  FINALITY_MARGIN_SECONDS, PAUSED_TRACK_INTERVAL_MS, STALL_FACTOR, TRACK_INTERVAL_MS, RATE_SCALE,
  type Action, type Campaign, type PauseFacts, type PauseReason, type Tranche, type TrancheState,
} from "@privacy-wallet/protocol/wallet/campaign";
import { velocityExceeded } from "@privacy-wallet/protocol/wallet/exposurePolicy";

import { incidentSpan } from "@privacy-wallet/protocol/wallet/riskClasses";
import { availablePrice } from "@privacy-wallet/protocol/wallet/valuation";
import { atLeast } from "@privacy-wallet/protocol/wallet/valuation";
import type { Deployment } from "../chain";
import { assetsOf, type Asset } from "../assets";
import { escrowBalance, trackOrder, type Tracked } from "../orderTracker";
import { priceStore } from "../prices";
import { ensureSpendable } from "../privateTx";
import { relayerInfo, relayerSwapStatus, type SwapJob } from "../relayer";
import { commitOrder, handOverSigned, prepareAndSign, resumeOrder, returnOrderToBalance, type Signed } from "../swapExecute";
import { abandonSwap, fundEscrow, fundingFate, fundingReads, FUNDING_MARGIN_MS, patchSwap, windowEndOf, type FundingFate } from "../swapFunding";
import { swapService, type QuoteSet, type RiskView, type ServiceOrder } from "../swapService";
import { ProviderCallUnverified, type MinimumMoved } from "../providerCall";
import { ApiError } from "../api/client";
import { chainKindOf, consumeFreshAddress } from "../keys/chainKeys";
import { destinationCheck, markAddressSettled, markAddressUsed } from "./addressBook";
import { alertKindFor, withAlert } from "./alerts";
import { campaignById, childOrder, expectedOut, fitPlanned, forgetCampaignTick, keepDecisions, largestPlanned, notesShapedFor, pieceCeiling, putCampaign as journalCampaign, replanRemainder, scheduleTick, sourceEquivalent, stepReviewedFee, withRoute, cryptoUniform, TERMINAL_STATES } from "./campaigns";
import type { ScheduledAction, StoredSwap } from "./journal";
import { noteStore } from "./notes";
import { notify } from "./notifications";
import { cancelAction, sampleDueAt, schedulerStatus } from "./schedule";
import { HELD_SCAN_RETRY_MS, scheduleDiscovery } from "./discovery";
import { session as defaultSession, type WalletSession } from "./session";
import { settings as defaultSettings, type Settings } from "./settings";

/** Everything the runner reads or moves, behind one interface: the wallet's modules by default, fakes in the tests. */
export interface CampaignIo {
  /** the order at the step's size: the service runs the competition at that size and may choose another provider than the campaign's (a route change, §8) */
  commit(c: Campaign, t: Tranche, destination: string): Promise<{ stored: StoredSwap; order: ServiceOrder; protection?: unknown }>;
  /** the private withdrawal into the tranche's escrow; `onStatus` lines say when the submission starts (the reconcile boundary) */
  fund(stored: StoredSwap, onStatus: (line: string) => void): Promise<{ txHash: string }>;
  /** what became of the step's journaled funding (swapFunding.ts `fundingFate`); absent: unknown, so nothing is sent */
  fundingFate?(stored: StoredSwap): Promise<FundingFate>;
  escrowBalance(stored: StoredSwap): Promise<bigint | null>;
  /** `acceptMin`: the least the step's call may guarantee — the campaign's price bound for it (V3 §3), not its own quote at commit */
  sign(stored: StoredSwap, acceptMin?: bigint): Promise<Signed | { moved: MinimumMoved }>;
  handOver(stored: StoredSwap, signed: Signed): Promise<{ job?: SwapJob }>;
  /** the executor's job for this order, if it has one (keyed by orderId) */
  job(stored: StoredSwap): Promise<SwapJob | null>;
  /** `stall`: the hand-over time (unix s) and the plan's seconds, reported so the service counts a settlement stall (§10) */
  track(stored: StoredSwap, stall?: { since: number; expected: number }): Promise<{ tracked: Tracked; job: SwapJob | null }>;
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
export function resetRunnerMemory(): void { orders.clear(); signedCache.clear(); factCache.clear(); signRetries.clear(); }
/**
 * How many ticks in a row a step's signing may fail for a passing reason — the gateways did not answer, the network failed before
 * anything was signed — and be tried again at the next tick, before the scheduler's backoff applies (the sixth review round,
 * 2026-11-03: the backoff — ten minutes, then twenty — had let a funded step's window close through one short outage).
 */
export const SIGN_RETRIES_BEFORE_BACKOFF = 5;
/** the passing failures in a row of each campaign's current signing (not journaled: a reload starts the count again) */
const signRetries = new Map<string, number>();

/**
 * Audit gap 44: why a route the campaign has left behind may not carry a step it already funded (§8, §10) — its breaker
 * open, or a security incident reported since the campaign started (read fresh: the pause facts watch the campaign's own
 * route only). Null while the route is sound or cannot be read; the step's minimum and the provider call are checked anyway.
 */
async function leftRouteUnsound(provider: string, c: Campaign, io: CampaignIo, now: number): Promise<string | null> {
  const risk = await cached(`risk:${provider}`, now, () => io.risk(provider), true).catch(() => null);
  if (risk?.breaker.open) return `its own route, ${provider}, is skipped after repeated failures`;
  // an incident dated by day counts the whole of its day: one dated the day the operation started is not before it (n07)
  if (risk?.security.incidentList.some((i) => (incidentSpan(i.date)?.to ?? -Infinity) >= c.createdAt)) return `a security incident at ${provider} was reported after this operation started`;
  return null;
}
// V6 Stages 15–16 (spec v2.0 §8, §19): a lock forgets this memory. The hook is registered when this module loads, so
// nothing has to load the module just to wipe it (the first route stays light).
defaultSession.onLock(resetRunnerMemory);


const assetOf = (deployment: Deployment | null, c: Campaign): Asset => {
  const assets = assetsOf(deployment);
  return assets.find((a) => (a.token ?? "native").toLowerCase() === c.request.from.asset.toLowerCase()) ?? assets[0];
};

/**
 * The Chainlink cross-rate (destination base units per source base unit, 1e18) from the price store, when both feeds are
 * usable at the time of use (audit round 2, n18): a price kept after failed refreshes is stale by then though its read was
 * fresh, and the price-deviation pause had compared the market with it.
 */
export function crossRateFromPrices(c: Campaign, nowMs = Date.now()): bigint | null {
  const p = priceStore.state().prices;
  const now = Math.floor(nowMs / 1000);
  const from = availablePrice(p, c.request.from.symbol, now), to = availablePrice(p, c.request.to.symbol, now);
  if (!from || !to || to.usd1e8 <= 0n) return null;
  return (from.usd1e8 * 10n ** BigInt(c.request.to.decimals) * RATE_SCALE) / (to.usd1e8 * 10n ** BigInt(c.request.from.decimals));
}

export function defaultIo(d: IoDeps): CampaignIo {
  const relayerUrl = d.submission.kind === "relayer" ? d.submission.url : null;
  const orderFor = async (stored: StoredSwap): Promise<ServiceOrder> => {
    const hit = orders.get(stored.orderId.toLowerCase());
    if (hit) return hit;
    const order = await resumeOrder(d.deployment, stored, d.session);
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
        policy: (c.policy ?? "balanced") as never, fromAsset, preference: c.request.preference as never, walletTier: c.tier, schedule: null, campaign: { id: c.id, index: t.index },
        // V7 (spec v3.0 §3): the piece's funding pays at most its privacy share plus the relayer's F the Review showed (the Review's F × n)
        ...(stepReviewedFee(c.bounds, BigInt(t.amount)) !== undefined ? { reviewedFee: stepReviewedFee(c.bounds, BigInt(t.amount)) } : {}),
        // each merge a step's funding needs pays at most the Review's F (the review round of 2026-11-03, E3)
        ...(c.bounds.maxRelayerFee ? { reviewedMergeFee: BigInt(c.bounds.maxRelayerFee) } : {}),
        // V6 Stage 13: at the $50K band every step takes the route the user approved (a smaller piece of the same route keeps
        // or betters its rate); above it the competition at the step's size decides and a change is reviewed (V3 §8)
        ...(c.tier === "large-protected" && c.provider ? { provider: c.provider } : {}),
      });
      orders.set(r.stored.orderId.toLowerCase(), r.order);
      return { stored: r.stored, order: r.order, protection: r.response.protection ?? null };
    },
    fund: (stored, onStatus) => fundEscrow({ masterSeed: d.masterSeed, deployment: d.deployment, stored, session: d.session, onStatus, relayerUrl }),
    fundingFate: async (stored) => (d.deployment && stored.fundingAttempt ? fundingFate(stored.fundingAttempt, fundingReads(d.deployment), undefined, stored.endpoint) : "unknown"),
    escrowBalance: async (stored) => {
      if (!d.deployment) return null;
      const token = (stored.request as { from?: { asset?: string } })?.from?.asset;
      return escrowBalance(d.deployment, stored.endpoint as `0x${string}`, token && token !== "native" ? (token as `0x${string}`) : null).catch(() => null);
    },
    sign: async (stored, acceptMin) => prepareAndSign({ masterSeed: d.masterSeed, deployment: d.deployment, session: d.session, stored, order: await orderFor(stored), submission: d.submission, ...(acceptMin !== undefined ? { acceptMin } : {}), onStatus: (l) => schedulerStatus.progress(l) }),
    handOver: async (stored, signed) => handOverSigned({ deployment: d.deployment, session: d.session, stored, order: await orderFor(stored), signed, submission: d.submission }),
    job: (stored) => (relayerUrl ? relayerSwapStatus(relayerUrl, stored.orderId).catch(() => null) : Promise.resolve(null)),
    track: (stored, stall) => trackOrder(stored, { deployment: d.deployment, relayerUrl, session: d.session, stall }),
    refund: (stored) => returnOrderToBalance({ deployment: d.deployment, session: d.session, stored, submission: d.submission }),
    // an indicative quote carries no destination (the sixth review round, 2026-11-03): the engine quotes a placeholder, and the
    // step's fresh address reaches the chosen provider at its commit — the service had seen the next fresh address at every requote
    quote: (c, amount) => swapService.quote({ from: c.request.from, to: c.request.to, amount: amount.toString(), destination: "", slippageBps: 50, preference: c.request.preference as never, tier: c.tier, mode: c.mode, destinationKind: c.bounds.destination.kind === "fresh-per-tranche" ? "fresh" : "entered", preferNative: c.request.preference === "native" }),
    risk: (provider) => swapService.risk(provider).catch(() => null),
    gasPriceWei: () => (relayerUrl ? relayerInfo(relayerUrl).then((i) => i.gasPriceWei).catch(() => null) : Promise.resolve(null)),
    crossRateE18: crossRateFromPrices,
    shape: async (c, needed, onStatus) => { if (!d.deployment) throw new Error("No deployment configured."); await ensureSpendable({ masterSeed: d.masterSeed, deployment: d.deployment, needed, vault: assetOf(d.deployment, c).vault as Hex, onStatus, ...(c.bounds.maxRelayerFee ? { maxMergeFee: BigInt(c.bounds.maxRelayerFee) } : {}) }); },
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
/** A step's next state from its order's reading (exported for its tests). */
export function trancheStateOf(t: Tranche, tracked: Tracked, job: SwapJob | null, stored: StoredSwap, gate: Campaign["plan"]["gate"], chain: string, now: number, margins: Record<string, number>): { state: TrancheState; patch: Partial<Tranche>; note?: string } | null {
  const s = tracked.state;
  const patch: Partial<Tranche> = { ...(job?.id && !t.jobId ? { jobId: job.id } : {}) };
  const rate = big(t.expected?.rateE18);
  // the delivered units (a V6 follow-up of 2026-10-16, audit c11): `deliveredAmount` is the tracker's words ("0.03 BTC"), which
  // read as 0 — every delivered step paused as an anomaly, and a partial fill re-planned what was already delivered
  // this read's units, else the ones the step recorded before (the seventh review round, 2026-11-03): a read without them — a failed
  // provider read — had turned a partial fill into a refund in full, and the delivered part was planned and swapped again
  const deliveredOut = tracked.deliveredUnits !== undefined ? parseDelivered(tracked.deliveredUnits) : t.outcome?.deliveredOut !== undefined ? parseDelivered(t.outcome.deliveredOut) : undefined;
  // a delivery with the rest refunded is a partial fill settled for what was delivered (audit c32): never a refund in full, which
  // re-planned the delivered part and swapped it again
  const partialBack = s === "REFUNDED" && deliveredOut !== undefined && deliveredOut > 0n;
  // what came back: the refund notes the scan found, in the order's own asset (audit round 2, n19)
  const vault = String((stored.params as { refundVault?: string }).refundVault ?? "").toLowerCase();
  const back = (stored.refunds ?? []).filter((x) => x.vault.toLowerCase() === vault).reduce((a, x) => a + big(x.amount), 0n);
  const amount = big(t.amount);
  if (s === "REFUNDED" && !partialBack) {
    // the refund note is what came back — the step's amount less its tip, or the provider's refund less its fees — and what is planned
    // again (the seventh review round, D9): the whole amount had been planned again, and the difference funded a second time. Until
    // the scan finds the note, the step is still returning
    if (back <= 0n) return t.state === "refunding" ? null : { state: "refunding", patch, note: "returned to the private balance; waiting for the scan to find its refund note" };
    return { state: "refunded", patch: { ...patch, outcome: { ...t.outcome, refunded: (back > amount ? amount : back).toString() } }, note: "the escrow returned to the private balance" };
  }
  // an execution that failed with its money in the escrow, and a refund that came back after the executor stopped watching (audit
  // round 2, r36): the step waits for its own refund — after the user's Resume (the seventh review round, D6)
  if (s === "FAILED" || s === "LATE_REFUND") return { state: "failed", patch, note: tracked.detail };
  // the step ended at its provider without delivering the order's asset (the seventh review round, D5–D7): failed with nothing back in
  // its escrow, refunded at the destination (Mayan Fast-MCTP: USDC to the fresh address), or delivered in another token (LI.FI's
  // PARTIAL) — out of the balance, never completed or planned again, and the campaign pauses on it. They had settled as completed, or
  // stayed failed or partial for good
  if (s === "PROVIDER_FAILED") return { state: "undelivered", patch: { ...patch, outcome: { ...t.outcome, undelivered: "lost" } }, note: tracked.detail };
  if (s === "REFUNDED_AT_DESTINATION") return { state: "undelivered", patch: { ...patch, outcome: { ...t.outcome, undelivered: "refunded-at-destination" } }, note: tracked.detail };
  if (s === "PARTIAL" && (tracked.otherToken || tracked.deliveredAsset !== undefined) && deliveredOut === undefined) return { state: "undelivered", patch: { ...patch, outcome: { ...t.outcome, undelivered: "other-token" } }, note: tracked.detail };
  if (s === "REFUND_PENDING" || s === "PROVIDER_TIMEOUT" || s === "DESTINATION_FAILED") return t.state === "refunding" ? null : { state: "refunding", patch, note: tracked.detail };
  if (s === "EXPIRED" || s === "CANCELLED") return t.state === "committed" ? { state: "skipped", patch, note: "the order expired before it was funded" } : null;
  if (s === "PARTIAL" || partialBack) {
    const outcome = { ...t.outcome, ...(deliveredOut !== undefined ? { deliveredOut: deliveredOut.toString(), delivered: sourceEquivalent(deliveredOut, rate).toString() } : {}) };
    // the rest is back once the scan found its refund note (n19); nothing more comes back once the executor's watch ended (its job
    // `completed`) with no note — the seventh review round (D9): `completed` had read as "the rest came back", and the rest's
    // expected-rate equivalent was planned again though nothing had returned
    // the provider's word of a delivery without its amount, the rest back (the eleventh review round's K4 critique, its third pass): settled for
    // what did not come back — the step had come back "partial" at every pass, its whole amount in flight and the campaign paused as an anomaly
    if (outcome.delivered === undefined && back > 0n) {
      const refunded = back > amount ? amount : back;
      return { state: "settled", patch: { ...patch, amount: (amount - refunded).toString(), funded: t.funded ?? t.amount, outcome: { ...outcome, refunded: refunded.toString() }, settledAt: now }, note: "partial fill: the rest returned to the private balance; the provider did not say how much it delivered" };
    }
    const watchEnded = job?.state === "completed" && back === 0n;
    if (outcome.delivered !== undefined && (back > 0n || watchEnded)) {
      const deliveredIn = big(outcome.delivered) > amount ? amount : big(outcome.delivered);
      // at most what the delivery left (a refund note larger than the rest — a second funding of the same escrow — is never
      // subtracted from the delivery)
      const refunded = back > amount - deliveredIn ? amount - deliveredIn : back;
      // the delivered part: what did not come back once the note is found (the fill's cost is part of it, n19); the delivery alone
      // when nothing more comes back — the rest counts as ended, never as remaining
      const settled = back > 0n ? amount - refunded : deliveredIn;
      return { state: "settled", patch: { ...patch, amount: settled.toString(), funded: t.funded ?? t.amount, outcome: { ...outcome, refunded: refunded.toString() }, settledAt: now }, note: back > 0n ? "partial fill: the rest returned to the private balance" : "partial fill: the executor's watch ended with nothing more back; the rest is not swapped again" };
    }
    return { state: "partial", patch: { ...patch, outcome }, note: tracked.detail };
  }
  const delivered = s === "DESTINATION_FINAL" || s === "COMPLETED";
  const deliveredSince = delivered ? (t.deliveredSince ?? now) : t.deliveredSince;
  const outcome = delivered && deliveredOut !== undefined ? { ...t.outcome, deliveredOut: deliveredOut.toString(), delivered: sourceEquivalent(deliveredOut, rate).toString() } : t.outcome;
  if (settledBy(gate, { state: s, deliveredSince, chain }, now, margins)) return { state: "settled", patch: { ...patch, deliveredSince, outcome: outcome ?? { delivered: t.amount }, settledAt: now }, note: `settled at the ${gate} gate` };
  // V4 (contract §4.2): delivered but not yet past the finality margin is DESTINATION_CONFIRMED, distinct from the destination transaction merely sent
  if (delivered) return t.state === "destination-confirmed" && t.deliveredSince === deliveredSince && !(deliveredOut !== undefined && t.outcome?.deliveredOut === undefined) ? null : { state: "destination-confirmed", patch: { ...patch, deliveredSince, outcome }, note: "delivered; waiting for the finality margin" };
  if (s === "DESTINATION_SUBMITTED") return t.state === "destination-submitted" ? null : { state: "destination-submitted", patch, note: tracked.detail };
  if (s === "SOURCE_FINAL" || s === "PROVIDER_EXECUTING") return t.state === "source-confirmed" ? null : { state: "source-confirmed", patch, note: tracked.detail };
  return Object.keys(patch).length ? { state: t.state, patch } : null;
}
const parseDelivered = (x: string): bigint => { try { return BigInt(x); } catch { return 0n; } };

/** A step in flight as this tick read it: the facts its pause checks use (§8). */
interface ActiveRead { trackState: string; jobState?: string; ageSeconds?: number; expectedSeconds?: number }
interface TrackPass { campaign: Campaign; active?: ActiveRead; justSettled: { index: number; deliveredOut?: string; minOut?: string }[]; reconcileNeeded: boolean; reconcileDetail?: string; /** the seventh review round: a step ended undelivered this tick — the pause's words */ undelivered?: string }

/**
 * The step in flight whose facts the pause checks read (the seventh review round, 2026-11-03): one its provider failed first, then a
 * partial fill, then a stalled one. The lowest step in flight alone had been read, and a second step's failure went unseen (c53).
 */
function worstActive(xs: ActiveRead[]): ActiveRead | undefined {
  const rank = (a: ActiveRead): number =>
    a.jobState === "execute-failed" || a.jobState === "refund-failed" || ["FAILED", "DESTINATION_FAILED", "PROVIDER_TIMEOUT"].includes(a.trackState) ? 0
      : a.trackState === "PARTIAL" ? 1
        : a.ageSeconds !== undefined && a.expectedSeconds !== undefined && a.expectedSeconds > 0 && a.ageSeconds > STALL_FACTOR * a.expectedSeconds ? 2
          : 3;
  return xs.reduce<ActiveRead | undefined>((w, a) => (w === undefined || rank(a) < rank(w) ? a : w), undefined);
}

/** Why a step ended undelivered, for the pause it raises (§9). */
function undeliveredWords(index: number, how: "refunded-at-destination" | "other-token" | "lost"): string {
  const step = `Step ${index + 1}`;
  if (how === "refunded-at-destination") return `${step}: the provider could not deliver and refunded at its fresh destination address, in its own refund asset; nothing came back to your private balance. The next step is not sent to the same route on its own: resume to carry on, or return the rest.`;
  if (how === "other-token") return `${step}: the route delivered another token at the destination, not the one you asked for. The next step is not sent to the same route on its own: resume to carry on, or return the rest.`;
  return `${step} failed at its provider, and nothing came back while it was watched (anything that arrives later is returned from the order's own page). Resume to carry on with the rest, or return the rest.`;
}

/**
 * What a step's journaled funding became, before its order is given up (the audit round of 2026-10-16, c35): "none" (nothing
 * was sent), "dead" (it never lands: the order may go), "landed", or "pending" (on its way, or not readable: wait).
 */
async function givenUpOnlyIfDead(stored: StoredSwap, io: CampaignIo): Promise<"none" | "dead" | "landed" | "pending"> {
  if (!stored.fundingAttempt) return "none";
  const fate = await (io.fundingFate?.(stored) ?? Promise.resolve<FundingFate>("unknown")).catch((): FundingFate => "unknown");
  return fate === "dead" ? "dead" : fate === "landed" ? "landed" : "pending";
}

/** Reconcile every open tranche and track the ones in flight (§9, §6). */
async function reconcileAndTrack(c0: Campaign, io: CampaignIo, s: WalletSession, now: number, margins: Record<string, number>, rng: () => number): Promise<TrackPass> {
  let c = c0;
  const justSettled: TrackPass["justSettled"] = [];
  const reads: ActiveRead[] = [];
  let undelivered: string | undefined;
  let reconcileNeeded = false;
  let reconcileDetail: string | undefined;
  for (const t of c0.tranches) {
    if (!t.orderId || ["planned", "ready", "settled", "refunded", "skipped", "undelivered"].includes(t.state)) continue;
    const stored = childOrder(t, s);
    if (!stored) { c = withTrancheState(c, t.index, "failed", now, {}, "its order is missing from the journal"); reconcileNeeded = true; continue; }
    // a crash between a send and its journal entry: the facts decide (never a second funding or hand-over)
    if (t.state === "committed") {
      if (stored.fundedTx) c = withTrancheState(c, t.index, "funded", now, {}, "funded (reconciled from the journal)");
      else { const bal = await io.escrowBalance(stored); if (bal !== null && bal >= BigInt(t.amount)) c = withTrancheState(c, t.index, "funded", now, {}, "funded (reconciled from the escrow's balance)"); }
      continue;
    }
    // a funded or signed step the executor already has (a crash between the hand-over and its journal entry). A failed step is not one
    // (the seventh review round, D6): its state came from its own job's read, and the flip back to executing at every tick, then to
    // failed again, had grown its history without end — it is tracked below like any step in flight
    if (t.state === "funded" || t.state === "signed") {
      const job = stored.jobId ? null : await io.job(stored);
      if (stored.jobId || job) {
        const state = (job?.state ?? stored.state) === "refund-only" ? "refunding" : "executing";
        c = withTrancheState(c, t.index, state, now, { jobId: stored.jobId ?? job?.id, handedOverAt: t.handedOverAt ?? now }, `${state} (reconciled from the executor's job)`);
      }
      if (c.tranches[t.index].state !== "executing" && c.tranches[t.index].state !== "refunding") {
        // V4 (contract §8, plan §111): a funding seen in the escrow by the quorum and then gone is a possible reorganization — the local assumption is invalidated
        // and the campaign pauses `reconcile`; the tranche keeps its fundedTx, so it is never funded twice
        if (stored.fundedTx) {
          const bal = await io.escrowBalance(stored);
          const amount = BigInt(t.amount);
          if (bal !== null && bal >= amount && t.fundedSeenAt === undefined) c = withTrancheState(c, t.index, t.state, now, { fundedSeenAt: now });
          else if (bal !== null && bal < amount && t.fundedSeenAt !== undefined) { reconcileNeeded = true; reconcileDetail = `The funding of step ${t.index + 1} was seen in its escrow and is no longer there (a chain reorganization?); the chain is read again before anything is sent.`; }
        }
        continue;
      }
    }
    const current = c.tranches[t.index];
    const stall = current.handedOverAt && current.expected?.etaSeconds ? { since: Math.floor(current.handedOverAt / 1000), expected: current.expected.etaSeconds } : undefined;
    const r = await io.track(stored, stall).catch(() => null);
    if (!r) { if (current.lastReadFailedAt === undefined) c = withTrancheState(c, t.index, current.state, now, { lastReadFailedAt: now }); continue; } // an unreadable state keeps the tranche where it is (I3): "Unknown / reconnecting" (plan §110)
    if (current.lastReadFailedAt !== undefined) c = withTrancheState(c, t.index, current.state, now, { lastReadFailedAt: undefined });
    const next = trancheStateOf(current, r.tracked, r.job, stored, current.gate ?? c.plan.gate, c.request.to.chain, now, margins);
    if (next) {
      c = withTrancheState(c, t.index, next.state, now, next.patch, next.note);
      if (next.state === "refunded") scheduleDiscovery(now, s); // the step's refund note is looked for now
      if (next.state === "undelivered") undelivered ??= undeliveredWords(t.index, next.patch.outcome?.undelivered ?? "lost");
      if (next.state === "settled" && current.state !== "settled") {
        justSettled.push({ index: t.index, deliveredOut: next.patch.outcome?.deliveredOut, minOut: current.expected?.minOut });
        if (current.destination) markAddressSettled(chainKindOf(c.request.to.chain), current.destination, s, now); // §12: a fresh address retires, an entered one is paid
        c = withAlert(c, "step-settled", `Step ${t.index + 1} settled.`, now, t.index);
        // the random delay before the next release (§4): drawn at settlement
        const planned = c.tranches.find((x) => x.state === "planned" && x.notBefore === undefined);
        if (planned) c = withTrancheState(c, planned.index, "planned", now, { notBefore: sampleDueAt(c.plan.cadenceSeconds, now, rng) });
      }
    }
    const after = c.tranches[t.index];
    // the executor re-shielded the escrow and the scan has not found the note yet (D9): looked for now, then at most once a minute
    if (r.tracked.state === "REFUNDED" && after.state !== "refunded" && after.state !== "settled") scheduleDiscovery(stored.track?.state === "REFUNDED" ? now + 60_000 : now, s);
    // a step its provider failed (at the destination, or by never answering) comes back as `refunding`: its facts are the
    // pass's too, so the campaign pauses instead of sending the next step to the same provider (the audit round of 2026-10-16, c53)
    const failedAtProvider = after.state === "refunding" && ["DESTINATION_FAILED", "PROVIDER_TIMEOUT"].includes(r.tracked.state);
    if (["executing", "source-confirmed", "destination-submitted", "destination-confirmed", "partial"].includes(after.state) || failedAtProvider) {
      reads.push({ trackState: r.tracked.state, jobState: r.job?.state, ageSeconds: after.handedOverAt ? Math.floor((now - after.handedOverAt) / 1000) : undefined, expectedSeconds: after.expected?.etaSeconds });
    }
  }
  return { campaign: c, active: worstActive(reads), justSettled, reconcileNeeded, ...(reconcileDetail ? { reconcileDetail } : {}), ...(undelivered ? { undelivered } : {}) };
}

/**
 * The executor already has this step's order — another copy of this wallet funded and handed it over (audit round 2, r45) — or null.
 * Asked before every abandon (the seventh review round, D13): a route change and "Return the rest" had given up such a step as
 * never funded, its escrow, executed, reading empty — committed and swapped again, or reported as returned.
 */
async function handedOverElsewhere(c: Campaign, t: Tranche, stored: StoredSwap, io: CampaignIo, s: WalletSession, now: number): Promise<Campaign | null> {
  const job = await io.job(stored).catch(() => null);
  if (!job) return null;
  patchSwap(stored.orderId, { jobId: job.id, state: job.state }, s);
  const state: TrancheState = job.state === "refund-only" ? "refunding" : "executing";
  return withTrancheState(c, t.index, state, now, { jobId: job.id, handedOverAt: t.handedOverAt ?? now }, `already ${state === "refunding" ? "returning" : "handed over"} by another copy of this wallet (reconciled from the executor)`);
}

/** USD per base unit of an asset at today's price, read at the time of use (availablePrice); null without a usable price. */
function priceUsdPerUnit(symbol: string, decimals: number, now: number): number | null {
  const p = availablePrice(priceStore.state().prices, symbol, Math.floor(now / 1000));
  return p ? Number(p.usd1e8) / 1e8 / 10 ** decimals : null;
}
/** USD per base unit of a campaign's asset: its confirmation's valuation, else today's price; null without either. */
function usdPerUnit(c: Pick<Campaign, "value" | "request">, now: number): number | null {
  const v = c.value as { usd?: unknown } | undefined;
  if (v && typeof v.usd === "number" && Number.isFinite(v.usd) && v.usd >= 0) return v.usd / Math.max(1, Number(BigInt(c.request.amount)));
  return priceUsdPerUnit(c.request.from.symbol, c.request.from.decimals, now);
}
/**
 * The wallet's hand-overs in the trailing 24 h, in USD, and the next step's (V4 contract §2.4; the seventh review round, D8): every
 * campaign's steps at what was handed over and every single order, each valued at its campaign's agreed price, else today's. Null
 * when one of them has no price: with a limit set, nothing more is handed over (fail closed). A campaign confirmed without a price
 * had skipped the limit for good, two campaigns had each had a whole limit, and a partial fill had shrunk a past hand-over.
 */
function velocityWindow(c: Campaign, nextAmount: bigint, s: WalletSession, now: number): { handOvers: { at: number; usd: number }[]; nextUsd: number } | null {
  const since = now - 86_400_000;
  const per = usdPerUnit(c, now);
  if (per === null) return null;
  const handOvers: { at: number; usd: number }[] = [];
  const j = s.journal();
  // this campaign as this tick holds it (its reconcile may not be journaled yet), the others as journaled
  for (const x of [c, ...(j.campaigns ?? []).filter((y) => y.id !== c.id)]) {
    const steps = x.tranches.filter((t) => t.handedOverAt !== undefined && t.handedOverAt > since);
    if (!steps.length) continue;
    const xp = x.id === c.id ? per : usdPerUnit(x, now);
    if (xp === null) return null;
    for (const t of steps) handOvers.push({ at: t.handedOverAt!, usd: xp * Number(BigInt(t.funded ?? t.amount)) });
  }
  for (const o of j.swaps) {
    if (o.campaign || o.handedOverAt === undefined || o.handedOverAt <= since) continue;
    const from = (o.request as { from?: { symbol?: string; decimals?: number } }).from;
    const op = from?.symbol ? priceUsdPerUnit(from.symbol, from.decimals ?? 18, now) : null;
    if (op === null) return null;
    handOvers.push({ at: o.handedOverAt, usd: op * Number(BigInt((o.params as { amount: string }).amount)) });
  }
  return { handOvers, nextUsd: per * Number(nextAmount) };
}

/** Why an approved destination can no longer take a large payment (the address book's refusal). */
const refusalWords = (reason: string | undefined): string =>
  reason === "retired" ? "it is retired" : reason === "unverified" ? "it is not verified" : reason === "unapproved" ? "it is not approved for large payments" : reason === "stale" ? "it has gone unused too long and must be approved again" : reason === "unknown" ? "it is no longer in your address book" : "it cannot be used now";

/** The only step left to commit, below the band's lower edge (the seventh review round, D14): a remainder too small to swap on its own. */
const lastSmallStep = (c: Campaign, t: Tranche): boolean =>
  !c.tranches.some((x) => x.index !== t.index && ["planned", "ready", "committed", "funded", "signed", "failed"].includes(x.state)) && BigInt(t.amount) < (BigInt(c.request.amount) * BigInt(c.plan.bandBps[0])) / 10000n;

// the pause's alert carries its code too, so the alert reads by the cause as the pause does (the fourth critique of slice 4: under "Paused —
// The relayer is not set up for this swap" the last alerts had said "Provider degraded (step 1)")
const pauseWith = (c: Campaign, reason: PauseReason, detail: string, now: number, index?: number, code?: string): Campaign =>
  withAlert(
    withCampaignState(c, "paused", now, detail, {
      pause: { reason, detail, at: now, ...(index !== undefined ? { trancheIndex: index } : {}), ...(code ? { code } : {}) },
    }),
    alertKindFor(reason, detail),
    detail,
    now,
    index,
    code,
  );

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
  // every write of this tick keeps an answer the user gave while it ran (c36): the tick's campaign is the one it read first
  let base = c0;
  let decided = false;
  const putCampaign = (x: Campaign, session: WalletSession): Campaign => {
    const latest = campaignById(x.id, session);
    const merged = latest ? keepDecisions(base, latest, x) : x;
    if (merged !== x) {
      base = latest!;
      decided = true;
    }
    journalCampaign(merged, session);
    return merged;
  };
  const answeredMeanwhile = (): boolean => !Object.is(campaignById(c0.id, s)?.decidedAt, base.decidedAt);
  schedulerStatus.start(a.id, "Protected swap: checking every open step…");
  try {
    const pass = await reconcileAndTrack(c0, io, s, now, margins, rng);
    let c = pass.campaign;
    // the facts of §8
    // a resume reassesses on FRESH facts (§8): the minute-old cache is bypassed while reassessing
    const fresh = c.state === "reassessing";
    const risk = await cached(`risk:${c.provider}`, now, () => io.risk(c.provider ?? ""), fresh).catch(() => null);
    const gas = await cached("gas", now, () => io.gasPriceWei(), fresh).catch(() => null);
    // the step delivered below its minimum first, of every step this tick settled (D11)
    const settledNow = pass.justSettled.find((x) => x.deliveredOut !== undefined && x.minOut !== undefined && big(x.deliveredOut) < big(x.minOut)) ?? pass.justSettled[0];
    // V4 (contract §2.4): the trailing 24 h of hand-overs against the velocity limit the user set, in USD — the wallet's, every campaign
    // and every order, and fail closed without a price (the seventh review round, D8)
    const limit = cfg.protection.velocity?.maxUsdPer24h;
    let velocity = false, velocityUnknown = false;
    if (limit !== undefined) {
      const nextUp = c.tranches.find((t) => ["signed", "funded", "committed", "ready", "planned"].includes(t.state));
      const w = nextUp ? velocityWindow(c, BigInt(nextUp.amount), s, now) : undefined;
      if (w === null) velocityUnknown = true;
      else if (w) velocity = velocityExceeded(w.handOvers, w.nextUsd, limit, now).exceeded;
    }
    const facts: PauseFacts = {
      now, walletPaused: cfg.protection.pauseLargeOperations,
      crossRateE18: io.crossRateE18(c)?.toString(),
      incidentDates: risk?.security.incidentList.map((i) => Date.parse(i.date)).filter((d) => Number.isFinite(d)),
      providerHealth: risk ? { breakerOpen: !!risk.breaker.open } : undefined,
      gasPriceWei: gas ?? undefined, gasPriceAtConfirmationWei: c.gasPriceAtConfirmationWei,
      jobState: pass.active?.jobState, trackState: pass.active?.trackState,
      settlementAgeSeconds: pass.active?.ageSeconds, expectedSeconds: pass.active?.expectedSeconds,
      delivered: settledNow?.deliveredOut, guaranteedMin: settledNow?.minOut,
      reconcileNeeded: pass.reconcileNeeded, reconcileDetail: pass.reconcileDetail,
      velocityExceeded: velocity, velocityUnknown, ...(pass.undelivered ? { stepUndelivered: pass.undelivered } : {}),
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
        c = putCampaign(c, s);
        // the user answered while this tick ran (a Pause, Return the rest): no merge is paid for it, as no other money step
        // starts after it (audit round 2, n15) — the next tick acts on the answer
        if (decided || answeredMeanwhile()) break;
        schedulerStatus.progress("Protected swap: shaping your private balance for the pieces…");
        await io.shape(c, needed, (l) => schedulerStatus.progress(l));
        nextAt = now + 1000;
        break;
      }
      case "commit": {
        const t = c.tranches[action.index];
        // an entered destination is read from the address book at every commit (the seventh review round, 2026-11-03): its cooling-off, an
        // override with the second factor, its approval, a retirement. A copy of the cooling-off's end in the first step's `notBefore` had
        // been the only guard, and the requote of every Resume overwrote it
        if (c.bounds.destination.kind !== "fresh-per-tranche") {
          const check = destinationCheck(chainKindOf(c.request.to.chain), c.bounds.destination.address, { tier: c.tier, now }, s);
          if (!check.ok && check.reason === "cooling-off" && check.until !== undefined) { nextAt = Math.max(now + 1000, check.until); break; }
          if (!check.ok) { c = pauseWith(c, "unexpected-destination", `The destination you approved can no longer take a large payment: ${refusalWords(check.reason)}. Nothing more is committed; check it in your address book, then resume, or return the rest.`, now, t.index); break; }
        }
        if (c.state !== "running") c = withCampaignState(c, "running", now, "the first step starts");
        const sinceS = Math.floor(now / 1000);
        if (sinceS >= c.bounds.expiry) { c = pauseWith(c, "bounds", "The operation's expiry passed before this step; nothing more is committed.", now, t.index); break; }
        const dest = io.freshDestination(c);
        c = withTrancheState(c, t.index, "ready", now, { destination: dest.address, ...(dest.index !== undefined ? { destinationIndex: dest.index } : {}), provider: c.provider, attempt: t.attempt + 1 });
        c = putCampaign(c, s); // journaled before the call (§9)
        if (decided || answeredMeanwhile()) { c = putCampaign(c, s); break; } // the user answered while this tick ran: the next tick acts on it (c36)
        schedulerStatus.progress(`Protected swap: committing step ${t.index + 1}…`);
        let r: { stored: StoredSwap; order: ServiceOrder; protection?: unknown };
        try { r = await io.commit(c, c.tranches[t.index], dest.address); }
        catch (e) {
          const m = (e as Error)?.message ?? String(e);
          // the wallet's own hold after a restore (audit round 2, r07): no new note before one complete scan — the step waits
          // for it, never a pause that blamed the provider and asked the user to resume; so does a step whose tips the wallet
          // cannot check yet (audit round 2, critic gap 4: no fee read or price) — committed once it can estimate the gas
          const code = (e as { code?: unknown })?.code;
          if (code === "notes_loading" || code === "cost_unknown") { nextAt = now + HELD_SCAN_RETRY_MS; break; }
          // the last step, a remainder too small to swap on its own (its executor tip would pass the escrow's 1 %), stays in the private
          // balance and the campaign completes without it (the seventh review round, D14): it had paused at every Resume for good
          if (code === "amount_too_small" && lastSmallStep(c, t)) { c = withTrancheState(c, t.index, "skipped", now, { outcome: { ...t.outcome, kept: true } }, `too small to swap on its own (${m}): it stays in your private balance`); nextAt = now + 1000; break; }
          c = withTrancheState(c, t.index, "planned", now, {}, `commit failed: ${m}`);
          // whatever the service answered, a step whose commit failed committed and sent nothing, and Resume commits it again: its pause
          // says so, the service's own words in the detail under Advanced (the fourth critique of slice 4: the third had carried the
          // service's code onto the pause, and its catalog rows speak of another moment — "the wallet tries again on its own", "we are
          // checking where your funds are", "try a larger amount"); the wallet's own refusals before it asks — its journal not kept, or not
          // read — keep their rows, which hold at any moment and name the remedy (the fifth critique)
          const own = code === "journal_not_kept" || code === "journal_unreadable" ? code : "commit_failed";
          c = pauseWith(c, /no quote|filtered|refus/i.test(m) ? "route-degraded" : "provider-error", `Step ${t.index + 1} could not be committed: ${m}`, now, t.index, own);
          break;
        }
        const q = r.order.quote;
        // the competition at this size chose another provider (§8): a route change is reviewed, or adopted below the second-confirmation tier when allowed
        if (c.provider && q.provider !== c.provider) {
          if (adoptsRoutes(c, cfg)) {
            // the new route's plan with it (the seventh review round, D4): its class, gate, concurrency and cadence, a cap that only goes down
            c = withAlert(withCampaignState(withRoute(c, q.provider, r.protection, q, now, rng), "running", now, `the route for this step is ${q.provider} (adopted automatically below the second-confirmation size)`), "route-changed", `The route changed to ${q.provider} for the steps of this size (adopted automatically, as you allowed).`, now, t.index);
            send({ kind: "route-changed", title: "Route changed", body: `The route changed to ${q.provider}.`, campaignId: c.id, words: { key: "route-changed", vars: { provider: q.provider } } });
            // a step above the new route's cap or piece ceiling is never funded: its order is given up (nothing was funded) and the steps sized again
            if (BigInt(t.amount) > pieceCeiling(c)) {
              abandonSwap(r.stored.orderId, s);
              c = fitPlanned(withTrancheState(c, t.index, "planned", now, { orderId: undefined, provider: undefined }, `the route changed to ${q.provider}, which takes smaller pieces: the step is planned again`), now, rng);
              nextAt = now + 1000;
              break;
            }
          } else {
            abandonSwap(r.stored.orderId, s); // never funded: nothing left the private balance
            c = withTrancheState(c, t.index, "planned", now, { orderId: undefined, provider: undefined }, `the competition at this size chose ${q.provider}: waiting for your review`);
            c = withAlert(withCampaignState(c, "rerouting", now, `the route changed to ${q.provider}: waiting for your review`, { pendingReroute: { provider: q.provider, protection: r.protection ?? null, at: now } }), "route-changed", `The route for the steps of this size is ${q.provider}, not ${c.provider}; review it before the operation continues.`, now, t.index);
            send({ kind: "route-changed", title: "Route changed — review", body: `The route changed to ${q.provider}.`, campaignId: c.id, words: { key: "route-review", vars: { provider: q.provider } } });
            break;
          }
        }
        const fundedBefore = c.tranches.filter((x) => x.index !== t.index && ["funded", "signed", "failed", "executing", "source-confirmed", "destination-submitted", "destination-confirmed", "partial", "refunding", "settled"].includes(x.state)).reduce((sum, x) => sum + BigInt(x.amount), 0n);
        const tipBps = Number((BigInt(r.order.params.executorTip) * 10000n) / BigInt(t.amount));
        const check = checkWithinBounds(c.bounds, { amount: BigInt(t.amount), toAmountMin: BigInt(q.toAmountMin), quoteExpiresAt: q.expiresAt, feeBps: tipBps, executorTip: BigInt(r.order.params.executorTip), destination: dest.address, fundedBefore, now: sinceS });
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
        if (t.provider && c.provider && t.provider !== c.provider && !stored.fundedTx) {
          // a funding already sent may still land (the audit round of 2026-10-16, c35): given up now, it would land in an
          // escrow nothing refunds — it is waited for, and a landed one finishes on its own route (audit gap 44)
          const sentFate = await givenUpOnlyIfDead(stored, io);
          if (sentFate === "landed") { c = withTrancheState(c, t.index, "funded", now, {}, "funded (its funding landed before the route changed)"); nextAt = now + 1000; break; }
          if (sentFate === "pending") { nextAt = now + TRACK_INTERVAL_MS; break; } // on its way: read again at the next tick
          // never given up on "dead" while the escrow cannot be read (the ninth review round, 2026-11-04, B-F1): read again at the next tick
          if (sentFate === "dead" && (await io.escrowBalance(stored)) === null) { nextAt = now + TRACK_INTERVAL_MS; break; }
          const elsewhere = await handedOverElsewhere(c, t, stored, io, s, now); // D13: never planned again while another copy's execution runs
          if (elsewhere) { c = elsewhere; nextAt = now + TRACK_INTERVAL_MS; break; }
          abandonSwap(stored.orderId, s, { fundingDead: sentFate === "dead" }); // a dead attempt says so (the sixth review round, 2026-11-03): refused as "pending" before, the tick threw and the step never moved
          c = withTrancheState(c, t.index, "planned", now, { orderId: undefined, provider: undefined }, `the route changed to ${c.provider} before this step was funded: its order is abandoned and the step planned again`);
          nextAt = now + 1000; break;
        }
        if (stored.fundedTx) { c = withTrancheState(c, t.index, "funded", now, {}, "already funded"); nextAt = now + 1000; break; }
        const bal = await io.escrowBalance(stored);
        if (bal !== null && bal >= BigInt(t.amount)) { c = withTrancheState(c, t.index, "funded", now, {}, "funded (the escrow already holds the amount)"); nextAt = now + 1000; break; }
        // the executor already has this step's order (audit round 2, r45): another copy of this wallet — a backup restored
        // while the first device kept running — funded and handed it over. Tracked from now on: never funded again, nor
        // abandoned and planned again as a step whose escrow, executed, reads empty
        // (asked whatever this copy journaled, the seventh review round, D13: a funding of this copy's that never landed does not make
        // another copy's hand-over less real — every abandon below comes after this)
        {
          const elsewhere = await handedOverElsewhere(c, t, stored, io, s, now);
          if (elsewhere) { c = elsewhere; nextAt = now + TRACK_INTERVAL_MS; break; }
        }
        // A funding already sent is never sent again before its fate is known (journaled before it was sent): a Resume after
        // an unknown outcome, or a reload, waits for it. A dead one is replaced only after the user resumed since it was
        // sent (plan §86: no automatic retry on money movement); a V6 follow-up of 2026-10-14.
        if (stored.fundingAttempt) {
          const sentAt = stored.fundingAttempt.at;
          const fate = await (io.fundingFate?.(stored) ?? Promise.resolve<FundingFate>("unknown"));
          const resumedSince = c.history.some((h) => h.state === "reassessing" && h.at > sentAt); // only resumeCampaign enters it
          // a dead funding is replaced only with the escrow read (the ninth review round, B-F1): unread, a second funding could have gone to an
          // escrow the first had funded — read again at the next tick
          if (fate === "dead" && resumedSince && bal === null) { nextAt = now + TRACK_INTERVAL_MS; break; }
          if (fate !== "dead" || !resumedSince) {
            const detail = fate === "dead"
              ? `The funding of step ${t.index + 1} never landed; nothing moved. Resume to fund it again.`
              : `The funding of step ${t.index + 1} was sent and is not confirmed yet; the escrow is read before anything is sent again.`;
            c = pauseWith(c, "reconcile", detail, now, t.index);
            break;
          }
          patchSwap(stored.orderId, { fundingAttempt: undefined }, s);
        }
        // a step whose order's execution window has closed, or is about to, is never funded: its order is abandoned and the
        // step planned again, as when the route changed before its funding (a V6 follow-up of 2026-10-14)
        if (now + FUNDING_MARGIN_MS >= windowEndOf(stored)) {
          abandonSwap(stored.orderId, s);
          c = withTrancheState(c, t.index, "planned", now, { orderId: undefined, provider: undefined }, "its order's execution window closed before it was funded: the order is abandoned and the step planned again");
          nextAt = now + 1000; break;
        }
        if (decided || answeredMeanwhile()) { c = putCampaign(c, s); break; } // the user answered while this tick ran: the next tick acts on it (c36)
        schedulerStatus.progress(`Protected swap: funding step ${t.index + 1} from your private balance…`);
        let sent = false;
        try {
          const w = await io.fund(stored, (line) => { if (SENT.test(line)) sent = true; schedulerStatus.progress(line); });
          c = withTrancheState(c, t.index, "funded", now, {}, `funded by ${w.txHash.slice(0, 10)}…`);
          nextAt = now + 1000;
        } catch (e) {
          const m = (e as Error)?.message ?? String(e);
          // the funding's own window check, by the later of the device's clock and the chain's (audit round 2, critic gap 5): a
          // device clock behind the chain had passed the step's check above — abandoned unfunded and planned again, as there
          // an order closed while its funding was proved (the tenth review round, A10-7): nothing was sent — the status line had marked it sent
          // before the event that refused it, and the step paused as "ended without a known outcome"
          if ((e as { code?: unknown })?.code === "order_closed") {
            c = withTrancheState(c, t.index, "planned", now, { orderId: undefined, provider: undefined }, "its order was closed while its funding was prepared; nothing was sent and the step is planned again");
            nextAt = now + 1000;
            break;
          }
          if (!sent && (e as { code?: unknown })?.code === "order_expired") {
            abandonSwap(stored.orderId, s);
            c = withTrancheState(c, t.index, "planned", now, { orderId: undefined, provider: undefined }, "its order's execution window had closed by the chain's clock before it was funded: the order is abandoned and the step planned again");
            nextAt = now + 1000;
            break;
          }
          // a step whose tip no longer pays its execution at today's gas price (audit round 2, p04) is committed afresh, its new
          // tip priced now — never funded to wait out its refund time at the relayer
          if (!sent && (e as { code?: unknown })?.code === "tip_stale") {
            abandonSwap(stored.orderId, s);
            c = withTrancheState(c, t.index, "planned", now, { orderId: undefined, provider: undefined }, "its order's executor tip no longer paid its execution at today's gas price: the order is abandoned unfunded and the step planned again");
            nextAt = now + 1000;
            break;
          }
          if (!sent && ((e as { code?: unknown })?.code === "order_outdated" || (e as { code?: unknown })?.code === "order_not_ours")) {
            // an order an older build committed under the privacy address's owner commitment (the audit round of 2026-10-16,
            // c18) is never funded: abandoned with nothing sent, and the step planned again under its own owner commitments
            abandonSwap(stored.orderId, s);
            // each refusal in its own words (the eleventh review round, A11-11): an order whose refund is not this wallet's had read as an older version's
            const why =
              (e as { code?: unknown })?.code === "order_not_ours"
                ? "its order's refund was not set up for this wallet's keys: the order is abandoned unfunded and the step planned again"
                : "its order was set up by an older version of the wallet under the privacy address's owner commitment: the order is abandoned unfunded and the step planned again";
            c = withTrancheState(c, t.index, "planned", now, { orderId: undefined, provider: undefined }, why);
            nextAt = now + 1000;
            break;
          }
          // the rest of the balance no longer covers this step with the relayer's fee now (audit round 2, r11): each step's fee
          // note is priced when it is funded, and a rise past the room the steps keep made the last one unfundable — to the
          // backoff, its window closing, planned and committed again, for good, while the screen said "Executing". Paused instead
          if (!sent && /insufficient shielded balance|in your private balance for this order/i.test(m)) {
            c = pauseWith(c, "bounds", `Step ${t.index + 1} no longer fits in your protected balance with the relayer's fee now; nothing was sent. Resume once fees fall, or return the rest.`, now, t.index);
            break;
          }
          // the relayer's fee for this step rose past the bound the Review showed (fee_moved; a V7 Stage 12 follow-up): a bound the
          // user approved, so the campaign pauses for the decision as the balance case does — never the silent backoff that left
          // the step "committed" for ten minutes at a time with nothing to say
          if (!sent && (e as { code?: unknown })?.code === "fee_moved") {
            c = pauseWith(c, "bounds", `Step ${t.index + 1}'s relayer fee rose above what you approved; nothing was sent. Resume to fund it once today's fee fits, or return the rest.`, now, t.index);
            break;
          }
          // the relayer that would execute the steps runs no swaps, or the wallet submits through the connected wallet (the review
          // round of 2026-11-03, E4): to the backoff, the window closing, the step abandoned and committed again — a fresh order,
          // destination and refund counter — every window for good, while the campaign read "running". Paused for the user instead
          if (!sent && (e as { code?: unknown })?.code === "relayer_not_ready") {
            // in a protected execution's words, with the way to a relayer that runs swaps (the fourth critique of slice 4: the one-order row
            // said nothing had left the protected balance, earlier steps swapped, and named a Settings relayer Simple does not show)
            c = pauseWith(c, "provider-error", `Step ${t.index + 1} cannot be funded: ${m} Resume once the relayer runs swaps, or return the rest.`, now, t.index, "step_relayer_not_ready");
            break;
          }
          if (!sent) { c = putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw e; } // nothing was sent: the scheduler's backoff retries the tick
          c = pauseWith(c, "reconcile", `The funding of step ${t.index + 1} ended without a known outcome (${m}); the escrow is read before anything is sent again.`, now, t.index);
        }
        break;
      }
      case "sign": {
        const t = c.tranches[action.index];
        const stored = childOrder(t, s);
        if (!stored) { c = pauseWith(c, "reconcile", `Step ${t.index + 1} has no order in the journal.`, now, t.index); break; }
        // audit gap 44: a step funded on a route the campaign has since left finishes there — the route it was approved on;
        // the reroute governs the steps not funded yet — while that route is sound and signs it at its approved minimum.
        // Only when it cannot (a lower minimum, the price guard's refusal, an open breaker, a new incident) does the step
        // return through its own refund (§8), which waits for the escrow's window, and is planned again.
        const leftBehind = !!t.provider && !!c.provider && t.provider !== c.provider;
        // a funded step whose execution window has closed can only refund: it returns through its refund and is planned again
        // (§8) — before (to 2026-10-14) it retried its signature on the scheduler's backoff for good
        const closed = now >= windowEndOf(stored);
        let leftRefund = closed ? "its execution window closed before it was signed" : leftBehind ? await leftRouteUnsound(t.provider!, c, io, now) : null;
        if (!leftRefund) {
          if (decided || answeredMeanwhile()) { c = putCampaign(c, s); break; } // the user answered while this tick ran: the next tick acts on it (c36)
          schedulerStatus.progress(`Protected swap: checking and signing step ${t.index + 1}…`);
          try {
            // V3 §3, the price bound: a step's call must guarantee amount × minimumOutput — the confirmation's minimum per
            // unit less the 50 bps slippage the user approved — not its own quote at commit, which a 0.04 % dip undercut
            // and paused again at every Resume (the 2026-10-14 quick pass: five in a row)
            // (per unit paid to the provider, the step's own tip aside, when the bounds have it: audit c55)
            const r = await io.sign(stored, trancheMinimum(c.bounds, BigInt(t.amount), BigInt((stored.params as { executorTip: string }).executorTip)));
            if ("moved" in r) {
              // a lower minimum is a campaign-level decision, never a per-tranche tap (§3)
              if (leftBehind) leftRefund = "its own route now guarantees less than you approved";
              else c = pauseWith(c, "price-deviation", `Step ${t.index + 1} now guarantees ${r.moved.minOut} against the ${r.moved.approved} you approved; nothing was signed.`, now, t.index);
            } else if (!r.sim.ok) {
              c = pauseWith(c, "provider-error", `Step ${t.index + 1} would not execute: ${r.sim.reason}. Nothing was handed over.`, now, t.index);
            } else {
              signedCache.set(stored.orderId.toLowerCase(), r);
              signRetries.delete(c.id);
              c = withTrancheState(c, t.index, "signed", now, {}, `signed and simulated (${r.label})${leftBehind ? ` on the route it was funded on, ${t.provider}` : ""}`);
              nextAt = now + 1000;
            }
          } catch (e) {
            const m = (e as Error)?.message ?? String(e);
            const service = e instanceof ApiError; // an answer of the swap service is never the wallet's own check of the call (r35)
            // the gateways did not answer, or the network failed before anything was signed: an outage, tried again at the next
            // tick — never an unexpected destination. The sixth review round (2026-11-03): the first SIGN_RETRIES_BEFORE_BACKOFF such
            // ticks come TRACK_INTERVAL_MS apart; the scheduler's backoff (ten minutes, then twenty) applies after them
            let passing = e instanceof ProviderCallUnverified;
            if (!passing && !service && /receiver|does not do what this wallet asked for/i.test(m)) c = pauseWith(c, "unexpected-destination", `Step ${t.index + 1}: ${m}`, now, t.index);
            else if (!passing && (e as { code?: unknown })?.code === "price_guard") { // by its code (the ninth review round, A9-5)
              if (leftBehind) leftRefund = "its own route is refused against the better one";
              else c = pauseWith(c, "route-degraded", `Step ${t.index + 1}: ${m}. The route is quoted again when you resume.`, now, t.index);
            } else if (!passing && !service && /escrow|digest|not the one this wallet committed|minimum|builds for/i.test(m)) c = pauseWith(c, "provider-error", `Step ${t.index + 1}: ${m}`, now, t.index);
            else passing = true;
            if (passing) {
              const tries = (signRetries.get(c.id) ?? 0) + 1;
              signRetries.set(c.id, tries);
              if (tries <= SIGN_RETRIES_BEFORE_BACKOFF) {
                schedulerStatus.progress(`Protected swap: step ${t.index + 1} could not be signed for the moment (${m}); trying again shortly (${tries} of ${SIGN_RETRIES_BEFORE_BACKOFF})`);
                nextAt = now + TRACK_INTERVAL_MS;
                break;
              }
              c = putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw e; // the scheduler's backoff now
            }
          }
        }
        if (leftRefund) {
          try { const job = await io.refund(stored); signedCache.delete(stored.orderId.toLowerCase()); c = withTrancheState(c, t.index, "refunding", now, { jobId: job.id }, `${closed ? leftRefund : `the route changed to ${c.provider} and ${leftRefund}`}: the funded step returns through its refund and is planned again`); nextAt = now + 1000; }
          catch (e) { c = putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw e; }
        }
        break;
      }
      case "hand-over": {
        const t = c.tranches[action.index];
        const stored = childOrder(t, s);
        if (!stored) { c = pauseWith(c, "reconcile", `Step ${t.index + 1} has no order in the journal.`, now, t.index); break; }
        const existing = stored.jobId ? { id: stored.jobId, state: stored.state } : await io.job(stored);
        if (existing) { c = withTrancheState(c, t.index, "executing", now, { jobId: existing.id, handedOverAt: now }, "already handed over (reconciled)"); nextAt = now + TRACK_INTERVAL_MS; break; }
        // audit gap 44: a step signed on a route the campaign has since left is handed over there while that route stays sound
        // a signed step whose execution window has closed is not handed over either: it returns through its refund
        const closed = now >= windowEndOf(stored);
        const unsound = closed ? "its execution window closed before it was handed over" : t.provider && c.provider && t.provider !== c.provider ? await leftRouteUnsound(t.provider, c, io, now) : null;
        if (unsound) {
          try { const job = await io.refund(stored); signedCache.delete(stored.orderId.toLowerCase()); c = withTrancheState(c, t.index, "refunding", now, { jobId: job.id }, `${closed ? unsound : `the route changed to ${c.provider} and ${unsound}`}: the signed step is not handed over; it returns through its refund`); nextAt = now + 1000; }
          catch (e) { c = putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw e; }
          break;
        }
        const signed = signedCache.get(stored.orderId.toLowerCase());
        if (!signed) { c = withTrancheState(c, t.index, "funded", now, {}, "the signature is not in memory any more; signing again"); nextAt = now + 1000; break; }
        const release = canRelease(c, BigInt(t.amount), t.provider ?? c.provider); // I1, I2, I4 and (V4) I6
        if (!release.ok) { nextAt = now + TRACK_INTERVAL_MS; break; }
        if (decided || answeredMeanwhile()) { c = putCampaign(c, s); break; } // the user answered while this tick ran: the next tick acts on it (c36)
        schedulerStatus.progress(`Protected swap: handing step ${t.index + 1} to the executor…`);
        try {
          const r = await io.handOver(stored, signed);
          signedCache.delete(stored.orderId.toLowerCase());
          c = withTrancheState(c, t.index, "executing", now, { jobId: r.job?.id, handedOverAt: now }, r.job ? `handed to the executor (job ${r.job.id.slice(0, 10)}…)` : "finalized; submitted by the connected wallet");
          if (t.destination) markAddressUsed(chainKindOf(c.request.to.chain), t.destination, c.id, s, now); // §12
          nextAt = now + TRACK_INTERVAL_MS;
        } catch (e) {
          const m = (e as Error)?.message ?? String(e);
          // the signed call came too close to its deadline, here or at the relayer (audit round 2, r02): nothing was handed
          // over, and the step is signed afresh at the next tick
          if ((e as { code?: unknown })?.code === "deadline_too_close") {
            signedCache.delete(stored.orderId.toLowerCase());
            c = withTrancheState(c, t.index, "funded", now, {}, "its signed call came too close to its deadline before the hand-over; signing a fresh one");
            nextAt = now + 1000;
            break;
          }
          if (/Not handed over|builds for/i.test(m)) { c = pauseWith(c, "provider-error", `Step ${t.index + 1}: ${m}`, now, t.index); break; }
          c = pauseWith(c, "reconcile", `The hand-over of step ${t.index + 1} ended without a known outcome (${m}); the executor is asked before anything is sent again.`, now, t.index);
        }
        break;
      }
      case "pause": {
        c = pauseWith(c, action.reason, action.detail, now, action.index);
        if (action.replan) c = { ...c, replanAskedAt: now }; // the question before a step that came back is swapped again (B1): a Resume answers it
        send({ kind: alertKindFor(action.reason, action.detail), title: "Protected swap paused", body: action.detail, campaignId: c.id, words: { key: "paused" } });
        nextAt = now + PAUSED_TRACK_INTERVAL_MS;
        break;
      }
      case "replan": { c = replanRemainder(c, now, rng); nextAt = now + 1000; break; }
      case "requote": {
        if (c.state !== "requoting") c = withCampaignState(c, "requoting", now, "quoting the remaining amount again");
        const e = exposure(c);
        if (e.remaining <= 0n) { c = withCampaignState(c, "running", now, "nothing left to quote"); nextAt = now + 1000; break; }
        // the competition at the next step's size (§8, §10): that is the size a provider executes, and where the venues differ
        const nextPlanned = c.tranches.find((x) => x.state === "planned");
        const quoteAmount = nextPlanned ? BigInt(nextPlanned.amount) : e.remaining;
        let set: QuoteSet;
        try { set = await io.quote(c, quoteAmount); } catch (err) { c = pauseWith(c, "route-degraded", `No fresh quote for the next step (${(err as Error)?.message ?? err}).`, now); break; }
        const chosen = set.chosen?.provider;
        if (!chosen) { c = pauseWith(c, "route-degraded", "No provider quotes the next step right now.", now); break; }
        const snapshot = { ...(typeof c.riskSnapshot === "object" && c.riskSnapshot ? (c.riskSnapshot as object) : {}), requote: { at: now, provider: chosen, protection: set.protection ?? null, competition: set.competition ?? null } };
        if (chosen === c.provider) {
          c = withCampaignState(c, "running", now, `requoted: ${chosen} still carries the route`, { riskSnapshot: snapshot, pause: undefined });
        } else if (adoptsRoutes(c, cfg)) {
          c = withAlert(withCampaignState(withRoute(c, chosen, set.protection, set.quotes.find((x) => x.provider === chosen), now, rng), "running", now, `rerouted to ${chosen} (automatic below the second-confirmation tier)`, { riskSnapshot: snapshot, pause: undefined }), "route-changed", `The route changed to ${chosen} (adopted automatically, as you allowed).`, now);
          send({ kind: "route-changed", title: "Route changed", body: `The route changed to ${chosen}.`, campaignId: c.id, words: { key: "route-changed", vars: { provider: chosen } } });
        } else {
          c = withAlert(withCampaignState(c, "rerouting", now, `the route changed to ${chosen}: waiting for your review`, { pendingReroute: { provider: chosen, protection: set.protection ?? null, at: now }, riskSnapshot: snapshot }), "route-changed", `The route changed to ${chosen}; review it before the operation continues.`, now);
          send({ kind: "route-changed", title: "Route changed — review", body: `The route changed to ${chosen}.`, campaignId: c.id, words: { key: "route-review", vars: { provider: chosen } } });
        }
        // the next release waits for the cadence again — never earlier than it already waited (the seventh review round, D1)
        const planned = c.tranches.find((x) => x.state === "planned");
        if (planned) c = withTrancheState(c, planned.index, "planned", now, { notBefore: Math.max(planned.notBefore ?? 0, sampleDueAt(c.plan.cadenceSeconds, now, rng)) });
        nextAt = now + 1000;
        break;
      }
      case "refund": {
        // a step that failed with its money in its escrow, after the user resumed (the seventh review round, D6): its own refund-only job
        // returns it — once — and the rest carries on
        const t = c.tranches[action.index];
        const stored = childOrder(t, s);
        if (!stored) { c = pauseWith(c, "reconcile", `Step ${t.index + 1} has no order in the journal.`, now, t.index); break; }
        schedulerStatus.progress(`Protected swap: returning step ${t.index + 1} to your private balance…`);
        try {
          const job = await io.refund(stored);
          signedCache.delete(stored.orderId.toLowerCase());
          c = withTrancheState(c, t.index, "refunding", now, { jobId: job.id }, "after your resume: the failed step returns through a refund-only job; the rest carries on");
          nextAt = now + 1000;
        } catch (e) {
          const m = (e as Error)?.message ?? String(e);
          c = putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw new Error(`returning step ${t.index + 1} failed: ${m}`); // the executor was not reached: backoff
        }
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
          c = putCampaign(c, s); scheduleTick(c.id, now + TRACK_INTERVAL_MS, s); throw new Error(`returning step ${t.index + 1} failed: ${m}`); // the executor was not reached: backoff
        }
        break;
      }
      case "abandon": {
        // V6 Stage 13: a step committed but never funded while the rest returns. The reconcile pass of this tick saw no
        // funding in the journal; the escrow is read once more, and only an escrow read EMPTY gives the order up — a
        // funding that landed is a funded step (its refund-only job next), an unreadable escrow waits for the next tick
        const t = c.tranches[action.index];
        const stored = childOrder(t, s);
        if (!stored) { c = withTrancheState(c, t.index, "skipped", now, {}, "its order is missing from the journal"); nextAt = now + 1000; break; }
        const bal = stored.fundedTx ? null : await io.escrowBalance(stored);
        if (stored.fundedTx || (bal !== null && bal >= BigInt(t.amount))) { c = withTrancheState(c, t.index, "funded", now, {}, "funded (reconciled from the escrow's balance)"); nextAt = now + 1000; break; }
        // a funding on its way is waited for, never given up with it (c35): the escrow reads empty until it lands
        const sentFate = bal === 0n ? await givenUpOnlyIfDead(stored, io) : "none";
        if (sentFate === "landed" || sentFate === "pending") { nextAt = now + TRACK_INTERVAL_MS; break; }
        if (bal === 0n) {
          const elsewhere = await handedOverElsewhere(c, t, stored, io, s, now); // D13: tracked until it finishes, never reported as returned
          if (elsewhere) { c = elsewhere; nextAt = now + TRACK_INTERVAL_MS; break; }
          abandonSwap(stored.orderId, s, { fundingDead: sentFate === "dead" }); // never funded, or its attempt dead: nothing left the private balance (the sixth review round: the flag, or the tick threw for good)
          c = withTrancheState(c, t.index, "skipped", now, {}, "never funded: given up while the rest returned");
          nextAt = now + 1000;
        }
        break;
      }
      case "complete": {
        // a cancel whose last step had already been handed over and settled returned nothing: the campaign completed (the third critique)
        const cancelled = c.state === "winding-down" && !swappedInFull(exposure(c));
        const fin = exposure(c);
        // what did not arrive as asked, never a returned step's fees (the eleventh review round's critique of E11-1)
        const finished = fin.notDelivered > 0n ? "Every step finished; part of the amount did not arrive as you asked (see the steps)." : fin.kept > 0n ? "Every step settled; a remainder too small to swap on its own stays in your private balance." : "Every step settled.";
        // a return after a step not delivered as asked says so too, and the notification carries the distinction in its own key, a
        // warning (the eleventh review round, 2026-11-04, E11-1): the app's words for "completed" and "cancelled" had replaced the runner's —
        // "Every step settled.", "The rest returned to your private balance." — while a step's value was at its destination in another
        // asset, or gone
        const returned = fin.notDelivered > 0n ? "The rest returned to your private balance; part of the amount did not arrive as you asked (see the steps)." : "The rest returned to your private balance.";
        const key = cancelled ? (fin.notDelivered > 0n ? "cancelled-not-all" : "cancelled") : fin.notDelivered > 0n ? "completed-not-all" : fin.kept > 0n ? "completed-kept" : "completed";
        c = withAlert(withCampaignState(c, cancelled ? "cancelled" : "completed", now, cancelled ? "every step finished or returned" : fin.notDelivered > 0n ? "every step finished" : "every step settled", { pause: undefined, pendingReroute: undefined }), cancelled ? "cancelled" : "completed", cancelled ? returned : finished, now);
        send({ kind: cancelled ? "cancelled" : "completed", title: cancelled ? "Protected swap cancelled" : fin.notDelivered > 0n ? "Protected swap finished" : "Protected swap completed", body: cancelled ? returned : finished, campaignId: c.id, words: { key }, ...(fin.notDelivered > 0n ? { tone: "warn" as const } : {}) });
        stop();
        break;
      }
    }
    if (c.state === "paused" && action.kind !== "pause" && c0.state !== "paused") {
      send({ kind: c.pause ? alertKindFor(c.pause.reason, c.pause.detail) : "paused", title: "Protected swap paused", body: c.pause?.detail ?? "Paused.", campaignId: c.id, words: { key: "paused", ...(c.pause?.code ? { vars: { code: c.pause.code } } : {}) } });
      nextAt = now + PAUSED_TRACK_INTERVAL_MS;
    }
    c = putCampaign(c, s);
    if (decided) nextAt = now; // the answer given meanwhile is acted on at once, never forgotten with this tick's plan
    if (nextAt !== null) scheduleTick(c.id, nextAt, s); else forgetCampaignTick(c.id, s);
    return { action, before: c0, after: c, nextAt };
  } finally {
    schedulerStatus.finish();
  }
}

/**
 * Whether a route change the competition makes at the step's size is adopted without a Review: when the user allowed it
 * below the second-confirmation tier (V3), and always at the $50K band (V6 Stage 13, spec v2.0 §2): there the protection
 * is automatic with nothing to choose — the bounds checked right after still pause a step whose rate is not what was approved.
 */
const adoptsRoutes = (c: Campaign, cfg: Settings): boolean => (cfg.protection.autoReroute || c.tier === "large-protected") && !atLeast(c.tier, "high-value-secondary");

/** The number of settled steps and the expected amount of the next one, for the screens. */
export function nextExpectedOut(c: Campaign): bigint | null {
  const t = c.tranches.find((x) => x.state !== "settled" && x.state !== "skipped" && x.state !== "refunded");
  return t?.expected ? expectedOut(BigInt(t.amount), BigInt(t.expected.rateE18)) : null;
}

export { noteStore as _notes };
