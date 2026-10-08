// Campaigns in the wallet (High-Value Protection spec §3, §5, §7, §8, §17): a large order confirmed once becomes a
// journaled campaign of tranches, each an ordinary order of its own (sdk/swapExecute.ts) released by the runner
// (wallet/campaignRunner.ts) under the in-flight cap. This module starts a campaign from the service's
// recommendation and the user's confirmation, and takes the user's four decisions during it: pause, resume (reassess →
// requote → reroute Review), accept or decline a reroute, cancel (return the rest). Everything lives in the encrypted
// journal (`campaigns?`, optional); nothing here is sent anywhere.
import { useSyncExternalStore } from "react";
import {
  createCampaign, exposure, planTranches, rateE18, replan, withCampaignState, withTrancheState, RATE_SCALE,
  type Campaign, type DestinationPolicy, type ExecutionBounds, type ProtectionMode, type Tranche, type TranchePlan,
} from "@ref/wallet/campaign";
import type { LintItem } from "@ref/wallet/privacyLint";
import type { Tier } from "@ref/wallet/valuation";
import type { Asset } from "../sdk/assets";
import { mergeSchedule } from "../sdk/privateTx";
import type { AssetRef, Policy, Preference, Protection, QuoteSet, ServiceQuote } from "../sdk/swapService";
import { withAlert } from "./alerts";
import { activityId, recordActivity, updateActivity } from "./activity";
import type { JournalData, StoredSwap } from "./journal";
import { noteStore } from "./notes";
import { cancelAction, scheduleAction } from "./schedule";
import { session as defaultSession, type WalletSession } from "./session";
import { CAP_BPS_RANGE, PROTECTION_DEFAULTS } from "./settings";

/** The tier's slippage inside the price bound (§3): the confirmation quote's minimum per unit, less this. */
export const BOUNDS_SLIPPAGE_BPS = 50;
/** The tip (≤ 25 bps, V1.1) plus the relayer fee ceiling per tranche (§3). */
export const DEFAULT_MAX_FEE_BPS = 100;
/** The campaign expiry: twice the estimated duration plus this margin (§3). */
export const EXPIRY_MARGIN_SECONDS = 48 * 3600;
export const TERMINAL_STATES: readonly Campaign["state"][] = ["completed", "cancelled"];

export const campaignsOf = (j: JournalData): Campaign[] => j.campaigns ?? [];
export function campaignById(id: string, s: WalletSession = defaultSession): Campaign | null {
  return s.isUnlocked() ? campaignsOf(s.journal()).find((c) => c.id === id) ?? null : null;
}
export const activeCampaigns = (s: WalletSession = defaultSession): Campaign[] => (s.isUnlocked() ? campaignsOf(s.journal()).filter((c) => !TERMINAL_STATES.includes(c.state)) : []);
/** Journal a campaign (replacing the one with its id) and mirror its state onto its Activity line. */
export function putCampaign(c: Campaign, s: WalletSession = defaultSession): void {
  s.update((j) => { j.campaigns = [...(j.campaigns ?? []).filter((x) => x.id !== c.id), c].sort((a, b) => a.createdAt - b.createdAt); });
  updateActivity(activityId("campaign", c.id), { status: c.state, note: progressLine(c) }, s);
}
export const useCampaigns = (s: WalletSession = defaultSession): Campaign[] => useSyncExternalStore((l) => s.subscribe(l), () => (s.isUnlocked() ? campaignsOf(s.journal()) : EMPTY));
const EMPTY: Campaign[] = [];
/** The child order of a tranche (its own StoredSwap), if committed. */
export const childOrder = (t: Tranche, s: WalletSession = defaultSession): StoredSwap | null => (t.orderId && s.isUnlocked() ? s.journal().swaps.find((x) => x.orderId.toLowerCase() === t.orderId!.toLowerCase()) ?? null : null);

const randomId = (): string => "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
/** A uniform draw in [0, 1) from the CSPRNG (the tranche sizes, the cadence). */
export function cryptoUniform(): number { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0] / 2 ** 32; }

/** The largest piece still to fund; the notes must pay it with the withdrawal's inputs, or the campaign shapes them first (§4). */
export const largestPlanned = (c: Campaign): bigint => c.tranches.filter((t) => t.state === "planned" || t.state === "ready").reduce((m, t) => (BigInt(t.amount) > m ? BigInt(t.amount) : m), 0n);
/** Whether the unspent notes of the vault can pay `needed` without merges (sdk/privateTx.ts mergeSchedule). */
export function notesShapedFor(vault: string, needed: bigint): boolean {
  if (needed <= 0n) return true;
  const notes = noteStore.unspent(BigInt(vault)).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount }));
  const sched = mergeSchedule(notes, needed, 0n);
  return sched.ok && sched.pairs.length === 0;
}

/** "Step k of ~N · completed / in flight / protected" for Activity and Home. */
export function progressLine(c: Campaign): string {
  const e = exposure(c);
  const settled = c.tranches.filter((t) => t.state === "settled").length;
  const total = c.tranches.filter((t) => t.state !== "skipped").length;
  const dec = c.request.from.decimals, sym = c.request.from.symbol;
  const f = (u: bigint) => { const base = 10n ** BigInt(dec); const frac = (u % base).toString().padStart(dec, "0").slice(0, 4).replace(/0+$/, ""); return `${u / base}${frac ? `.${frac}` : ""}`; };
  return `Step ${Math.min(settled + 1, Math.max(total, 1))} of ~${Math.max(total, 1)} · ${f(e.completed)} ${sym} completed · ${f(e.inFlight)} ${sym} in flight · ${f(e.protected)} ${sym} protected`;
}

export interface StartCampaignInput {
  quotes: QuoteSet;
  /** the provider the user confirmed (the chosen route, or the one picked under Route details) */
  provider: string;
  from: AssetRef;
  fromAsset: Asset;
  to: AssetRef;
  amount: bigint;
  tier: Tier;
  mode: ProtectionMode;
  preference: Preference;
  policy: Policy;
  destination: DestinationPolicy;
  usd: number | null;
  lint?: LintItem[] | null;
  /** the user's exposure fraction from Settings (bps); clamped by what the risk engine permits (§14) */
  capBps?: number;
  /** the Chainlink cross-rate at confirmation (destination base units per source base unit, 1e18), when both feeds exist */
  crossRateE18?: bigint | null;
  gasPriceWei?: string | null;
  confirmations?: Partial<Campaign["confirmations"]>;
  now?: number;
  rng?: () => number;
  session?: WalletSession;
}

/** The plan and the bounds from the recommendation and the confirmation (pure); the campaign is not journaled here. */
export function buildCampaign(i: StartCampaignInput): Campaign {
  const now = i.now ?? Date.now();
  const p: Protection | undefined = i.quotes.protection;
  if (!p) throw new Error("the swap service gave no protection plan for this order; a protected execution needs one");
  const quote: ServiceQuote | undefined = i.quotes.quotes.find((q) => q.provider === i.provider);
  if (!quote) throw new Error(`no quote from ${i.provider}`);
  const defaults = PROTECTION_DEFAULTS[i.mode];
  // the cap: the recommendation's, or the user's choice inside its range — above the recommendation only where the risk engine permits (an R1 / R2 route, §14)
  let capBps = p.capBps;
  if (i.capBps !== undefined) {
    const wanted = Math.min(CAP_BPS_RANGE[1], Math.max(CAP_BPS_RANGE[0], Math.round(i.capBps)));
    capBps = wanted <= p.capBps || p.riskClass === "R1" || p.riskClass === "R2" ? wanted : p.capBps;
  }
  const band: [number, number] = [Math.min(p.bandBps[0], capBps), Math.min(p.bandBps[1], capBps)];
  const sizing = p.sizing ?? defaults.sizing;
  const maxParallel = p.concurrency === "sequential" ? 1 : Math.max(1, p.maxParallel);
  const rng = i.rng ?? cryptoUniform;
  const split = planTranches(i.amount, { decimals: i.from.decimals, bandBps: band, capBps, sizing, maxParallel, maxPiece: p.maxPieceUnits ? BigInt(p.maxPieceUnits) : undefined, rng });
  const cap = (i.amount * BigInt(capBps)) / 10000n;
  const minimumOutput = (rateE18(BigInt(quote.toAmountMin), i.amount) * BigInt(10000 - BOUNDS_SLIPPAGE_BPS)) / 10000n;
  const estimated = Math.max(p.estimatedSeconds, 3600);
  const bounds: ExecutionBounds = {
    orderId: randomId(), assetIn: i.from, chainIn: i.from.chain, amountInLimit: i.amount.toString(), assetOut: i.to, chainOut: i.to.chain, destination: i.destination,
    minimumOutput: minimumOutput.toString(), expiry: Math.floor(now / 1000) + 2 * estimated + EXPIRY_MARGIN_SECONDS, maxFeeBps: DEFAULT_MAX_FEE_BPS, privacyMode: i.mode,
    maxExternalExposure: cap.toString(), executeWindowSeconds: p.executeWindowSeconds,
  };
  const plan: TranchePlan = {
    riskClass: p.riskClass as TranchePlan["riskClass"], bandBps: band, capBps, sizing, concurrency: maxParallel > 1 ? "parallel" : "sequential", maxParallel, gate: p.gate, cadenceSeconds: p.cadenceSeconds ?? defaults.cadenceSeconds,
    providerShareCapBps: p.providerShareCapBps, executeWindowSeconds: p.executeWindowSeconds, estimatedTranches: split.pieces.length, estimatedSeconds: p.estimatedSeconds,
    shapeNotes: !notesShapedFor(i.fromAsset.vault, split.pieces.reduce((m, x) => (x > m ? x : m), 0n)), ...(p.elpf.perCampaignUsd !== null ? { elpfUsd: p.elpf.perCampaignUsd } : {}),
  };
  // the reference rate (§3): the Chainlink cross-rate when both feeds exist, else the quote's expected rate (then the deviation check compares like with like only approximately)
  const referenceRateE18 = i.crossRateE18 && i.crossRateE18 > 0n ? i.crossRateE18 : rateE18(BigInt(quote.toAmount), i.amount);
  const c = createCampaign({
    id: bounds.orderId, now, mode: i.mode, tier: i.tier, request: { from: i.from, to: i.to, amount: i.amount.toString(), preference: i.preference }, bounds, plan, pieces: split.pieces, referenceRateE18,
    riskSnapshot: { protection: p, risk: i.quotes.risk ?? null, competition: i.quotes.competition ?? null, quote, usd: i.usd }, confirmations: i.confirmations,
  });
  return { ...c, provider: i.provider, policy: i.policy, ...(i.gasPriceWei ? { gasPriceAtConfirmationWei: i.gasPriceWei } : {}), ...(i.lint ? { lint: { items: i.lint, at: now } } : {}), ...(i.usd !== null ? { value: { usd: i.usd, at: now } } : {}) };
}

/** The confirmation (§7): journal the campaign, its Activity line and the first tick (now). */
export function startCampaign(i: StartCampaignInput): Campaign {
  const s = i.session ?? defaultSession;
  const c = buildCampaign(i);
  s.update((j) => { j.campaigns = [...(j.campaigns ?? []), c]; });
  recordActivity({ id: activityId("campaign", c.id), kind: "campaign", asset: i.from.symbol, decimals: i.from.decimals, amount: i.amount.toString(), status: c.state, ref: c.id, note: `→ ${i.to.symbol} · ${progressLine(c)}` }, s);
  scheduleTick(c.id, i.now ?? Date.now(), s);
  return c;
}

/** The runner's next tick, under the campaign's own action id (re-scheduling replaces it; the scheduler keeps a re-scheduled action pending). */
export function scheduleTick(campaignId: string, dueAt: number, s: WalletSession = defaultSession): void {
  const current = s.isUnlocked() ? s.journal().schedule.find((a) => a.id === `campaign-tick:${campaignId}`) : undefined;
  const at = current && !current.done && dueAt <= current.dueAt && current.dueAt > Date.now() ? dueAt : Math.max(dueAt, (current?.dueAt ?? 0) + 1);
  scheduleAction({ kind: "campaign-tick", orderId: campaignId, dueAt: at }, s);
}

/** Pause (the campaign's own button): releases stop; in-flight steps are still tracked (§8). */
export function pauseCampaign(id: string, s: WalletSession = defaultSession, now = Date.now()): Campaign | null {
  const c = campaignById(id, s);
  if (!c || TERMINAL_STATES.includes(c.state) || c.state === "paused") return c;
  const paused = withAlert(withCampaignState(c, "paused", now, "paused by you", { pause: { reason: "user", detail: "Paused by you. Steps already handed over continue and are tracked.", at: now } }), "paused", "Paused by you.", now);
  putCampaign(paused, s);
  scheduleTick(id, now, s);
  return paused;
}

/** Resume: reassess (fresh facts) → requote → a new Review when the route changed (§8). The runner does the work; this records the decision. */
export function resumeCampaign(id: string, s: WalletSession = defaultSession, now = Date.now()): Campaign | null {
  const c = campaignById(id, s);
  if (!c || (c.state !== "paused" && c.state !== "rerouting")) return c;
  const resumed = withAlert(withCampaignState(c, "reassessing", now, "resumed by you", { pause: undefined, pendingReroute: undefined }), "resumed", "Resumed: the facts are checked, then the remaining amount is quoted again.", now);
  putCampaign(resumed, s);
  scheduleTick(id, now, s);
  return resumed;
}

/** The reroute Review's answer (§8): adopt the new route and continue, or return the rest. */
export function acceptReroute(id: string, accept: boolean, s: WalletSession = defaultSession, now = Date.now()): Campaign | null {
  const c = campaignById(id, s);
  if (!c || c.state !== "rerouting" || !c.pendingReroute) return c;
  const next = accept
    ? withAlert(withCampaignState(c, "running", now, `route changed to ${c.pendingReroute.provider}, confirmed by you`, { provider: c.pendingReroute.provider, pendingReroute: undefined, pause: undefined }), "route-changed", `The route changed to ${c.pendingReroute.provider}; you confirmed it.`, now)
    : withCampaignState(c, "winding-down", now, "the new route was declined: the rest returns", { pendingReroute: undefined });
  putCampaign(next, s);
  scheduleTick(id, now, s);
  return next;
}

/** Cancel ("Return the rest to my private balance"): planned tranches are skipped, funded ones refunded, in-flight ones finish (§8). */
export function cancelCampaign(id: string, s: WalletSession = defaultSession, now = Date.now()): Campaign | null {
  const c = campaignById(id, s);
  if (!c || TERMINAL_STATES.includes(c.state)) return c;
  let next = withCampaignState(c, "winding-down", now, "cancelled by you: the rest returns to the private balance", { pendingReroute: undefined });
  for (const t of next.tranches) if (t.state === "planned" || t.state === "ready") next = withTrancheState(next, t.index, "skipped", now, {}, "cancelled before it started");
  next = withAlert(next, "cancelled", "Returning the rest to your private balance; steps already handed over finish first.", now);
  putCampaign(next, s);
  scheduleTick(id, now, s);
  return next;
}

/** Re-plan the unfunded remainder of a campaign (after a refund) with the campaign's own plan and the CSPRNG. */
export function replanRemainder(c: Campaign, now: number, rng: () => number = cryptoUniform): Campaign {
  const e = exposure(c);
  if (e.remaining <= 0n) return c;
  const split = planTranches(e.remaining, { decimals: c.request.from.decimals, bandBps: c.plan.bandBps, capBps: c.plan.capBps, sizing: c.plan.sizing, maxParallel: c.plan.maxParallel, rng, reference: e.total });
  return replan(c, split.pieces, now);
}

/** Forget a finished campaign's tick (nothing else is removed: the audit trail stays in the journal). */
export function forgetCampaignTick(id: string, s: WalletSession = defaultSession): void { cancelAction(`campaign-tick:${id}`, s); }

/** The destination amount a source amount is expected to bring at the tranche's rate (destination base units). */
export const expectedOut = (amountIn: bigint, rate: bigint): bigint => (amountIn * rate) / RATE_SCALE;
/** The source-unit equivalent of a delivered destination amount at the tranche's expected rate (for the accounting of §5). */
export const sourceEquivalent = (deliveredOut: bigint, rate: bigint): bigint => (rate > 0n ? (deliveredOut * RATE_SCALE) / rate : 0n);
