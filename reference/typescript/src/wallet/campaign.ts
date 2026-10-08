// High-value protection — the shared core (spec V3 docs/high-value-protection-spec-v1.0.md §2–§9): a large
// order is executed as a CAMPAIGN of TRANCHES, each one external execution risk boundary and one ordinary
// V1.1/V2 order (its own escrow). This module is pure and JSON-safe (bigints travel as decimal strings in the
// journal): the tranche splitter (§4), the exposure accounting with its invariants (§5), the settlement gate
// per risk class (§6), the bounds check (§3), the pause detection (§8) and the reducer that tells the wallet's
// runner the one next action (§7). The wallet, the service's recommendation and the labs run exactly this code.
import { bucketsFor } from "./amounts";
import type { Tier } from "./valuation";

export type RiskClass = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
export type Gate = "source" | "destination-submitted" | "destination-final";
export type ProtectionMode = "balanced" | "max-privacy" | "max-safety";
export type Sizing = "bucket" | "varied";
export type Concurrency = "sequential" | "parallel";
export type CampaignState = "user-confirmed" | "preparing-notes" | "running" | "paused" | "reassessing" | "requoting" | "rerouting" | "winding-down" | "completed" | "cancelled";
export type TrancheState = "planned" | "ready" | "committed" | "funded" | "signed" | "executing" | "source-confirmed" | "destination-submitted" | "settled" | "partial" | "refunding" | "refunded" | "failed" | "skipped";
export type PauseReason = "price-deviation" | "provider-error" | "chain-congestion" | "route-degraded" | "unexpected-destination" | "security-incident" | "anomaly" | "reconcile" | "bounds" | "user" | "wallet-pause";

export interface AssetRefLike { chain: string; asset: string; decimals: number; symbol: string }
export type DestinationPolicy = { kind: "fresh-per-tranche" } | { kind: "entered" | "book"; address: string; bookId?: string };

/** What one confirmation binds (§3): the provider never gets more than this allows. */
export interface ExecutionBounds {
  orderId: string;
  assetIn: AssetRefLike;
  chainIn: string;
  /** the whole order in base units; the sum of every tranche funded never exceeds it */
  amountInLimit: string;
  assetOut: AssetRefLike;
  chainOut: string;
  destination: DestinationPolicy;
  /** the minimum output per source unit, 1e18 fixed point (destination base units per source base unit × 1e18) */
  minimumOutput: string;
  /** unix seconds: no tranche is committed after it */
  expiry: number;
  /** the tip plus the relayer fee ceiling per tranche, bps of the tranche */
  maxFeeBps: number;
  privacyMode: ProtectionMode;
  /** the in-flight cap in base units (§5) */
  maxExternalExposure: string;
  /** the per-tranche execution window: executeDeadline = the quote's expiry + this */
  executeWindowSeconds: number;
}

export interface TranchePlan {
  riskClass: RiskClass;
  /** the tranche band, bps of the order */
  bandBps: [number, number];
  /** the in-flight cap, bps of the order */
  capBps: number;
  sizing: Sizing;
  concurrency: Concurrency;
  maxParallel: number;
  gate: Gate;
  /** the random delay before a release, seconds */
  cadenceSeconds: [number, number];
  providerShareCapBps: number;
  executeWindowSeconds: number;
  estimatedTranches: number;
  estimatedSeconds: number;
  /** the campaign needs its notes reshaped before the first tranche (§4) */
  shapeNotes: boolean;
  elpfUsd?: number;
}

export interface Tranche {
  index: number;
  amount: string;
  state: TrancheState;
  /** a requote after a pause is a new attempt: a new orderId, a new one-time key */
  attempt: number;
  orderId?: string;
  destination?: string;
  destinationIndex?: number;
  provider?: string;
  riskClass?: RiskClass;
  gate?: Gate;
  /** the cadence draw: not released before this (unix ms) */
  notBefore?: number;
  expected?: { minOut: string; rateE18: string; etaSeconds: number };
  outcome?: { delivered?: string; refunded?: string; deviationBps?: number };
  handedOverAt?: number;
  /** when the tracker first reported the destination delivered (the finality margin counts from here) */
  deliveredSince?: number;
  settledAt?: number;
  history: { state: TrancheState; at: number; note?: string }[];
}

export interface Campaign {
  id: string;
  createdAt: number;
  state: CampaignState;
  mode: ProtectionMode;
  tier: Tier;
  request: { from: AssetRefLike; to: AssetRefLike; amount: string; preference: string };
  bounds: ExecutionBounds;
  plan: TranchePlan;
  tranches: Tranche[];
  /** the destination/source cross-rate at confirmation, 1e18 fixed point (§3) */
  referenceRateE18: string;
  /** the service's recommendation and risk snapshot at confirmation, kept for the export */
  riskSnapshot?: unknown;
  pause?: { reason: PauseReason; detail: string; at: number; trancheIndex?: number };
  confirmations: { commit: number; secondFactor?: number; secondDevice?: number; destinationVerified?: number; emergencyOverride?: number };
  history: { state: CampaignState; at: number; note?: string }[];
}

// ---- tranche sizing (§4) ------------------------------------------------------------------------------------

export interface SplitOptions {
  decimals: number;
  bandBps: [number, number];
  capBps: number;
  sizing: Sizing;
  maxParallel: number;
  /** a tighter ceiling from the thin-market rule or a provider's instant limit (§2) */
  maxPiece?: bigint;
  /** a remainder below this joins the last piece instead of becoming one */
  dustFloor?: bigint;
  /** uniform in [0, 1) (the CSPRNG in the wallet, a seeded source in the labs) */
  rng: () => number;
  /** the order the band and the cap are fractions of — a re-plan of a remainder passes the original order (default: `total`) */
  reference?: bigint;
}
export interface Split { pieces: bigint[]; /** pieces that are not a bucket or a sum of two (the remainder, or a band no bucket fits) */ exact: number; /** the band in base units */ band: [bigint, bigint] }

const bps = (x: bigint, b: number): bigint => (x * BigInt(b)) / 10000n;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * The pieces of an order: one bucket, or the sum of two buckets, of the asset's alphabet inside the band
 * `[min, min(max, cap / maxParallel)]` of the order — `bucket`: every piece the largest size in band; `varied`:
 * consecutive pieces differ. The last piece absorbs what is below the dust floor. Every piece is ≤ the cap (I2).
 */
export function planTranches(total: bigint, o: SplitOptions): Split {
  if (total <= 0n) return { pieces: [], exact: 0, band: [0n, 0n] };
  const alphabet = bucketsFor(o.decimals);
  const ref = o.reference && o.reference > 0n ? o.reference : total;
  const cap = bps(ref, o.capBps);
  const lower = bps(ref, o.bandBps[0]);
  let upper = min(bps(ref, o.bandBps[1]), cap / BigInt(Math.max(1, o.maxParallel)));
  if (o.maxPiece !== undefined && o.maxPiece > 0n) upper = min(upper, o.maxPiece);
  if (upper <= 0n) upper = min(total, cap);
  const dust = o.dustFloor ?? alphabet[0];
  // candidates: single buckets inside the band, and sums of two buckets of the same or the adjacent decade
  // (50 + 5, never 50 + 0.001: a bucket plus a crumb is an exact amount in disguise)
  const singles = alphabet.filter((b) => b >= lower && b <= upper);
  const pairs: bigint[] = [];
  for (let i = 0; i < alphabet.length; i++) for (let j = 0; j <= i; j++) {
    if (alphabet[j] * 10n < alphabet[i]) continue;
    const s = alphabet[i] + alphabet[j];
    if (s >= lower && s <= upper && !singles.includes(s) && !pairs.includes(s)) pairs.push(s);
  }
  const sorted = (xs: bigint[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // `bucket`: single buckets only (pairs when no single fits); `varied`: both, so consecutive pieces can differ
  let candidates = o.sizing === "bucket" ? (singles.length ? sorted(singles) : sorted(pairs)) : sorted([...singles, ...pairs]);
  let exact = 0;
  if (!candidates.length) {
    // no common size fits the band: the largest bucket below the ceiling, else the ceiling itself (an exact piece)
    const below = alphabet.filter((b) => b <= upper);
    if (below.length) candidates = [below[below.length - 1]];
    else { candidates = [upper]; exact = -1; } // every piece exact; counted below
  }
  const pieces: bigint[] = [];
  let left = total;
  let last: bigint | null = null;
  while (left >= candidates[0]) {
    let pick: bigint;
    if (o.sizing === "bucket" || candidates.length === 1) pick = candidates[candidates.length - 1];
    else {
      const pool = candidates.filter((c) => c !== last && c <= left);
      const from = pool.length ? pool : candidates.filter((c) => c <= left);
      pick = from[Math.min(from.length - 1, Math.floor(o.rng() * from.length))];
    }
    if (pick > left) { const fit = candidates.filter((c) => c <= left); if (!fit.length) break; pick = fit[fit.length - 1]; }
    pieces.push(pick); left -= pick; last = pick;
  }
  if (exact === -1) exact = pieces.length;
  if (left > 0n) {
    // the remainder (below the smallest candidate): a piece of its own when it is inside the band, else it joins
    // the last piece while that stays under the ceiling, else a smaller piece of its own (always allowed, §2)
    if (!pieces.length) { pieces.push(left); exact++; }
    else if (left >= lower || left < dust || pieces[pieces.length - 1] + left > upper) {
      if (left < dust && pieces.length) pieces[pieces.length - 1] += left; else pieces.push(left);
      exact++;
    } else { pieces[pieces.length - 1] += left; exact++; }
  }
  // I2: never above the cap (a merged remainder could exceed it only when the cap is below one piece)
  for (let i = 0; i < pieces.length; i++) if (pieces[i] > cap && cap > 0n) { const over = pieces[i] - cap; pieces[i] = cap; pieces.splice(i + 1, 0, over); exact++; }
  return { pieces, exact, band: [lower, upper] };
}

// ---- exposure accounting (§5) ----------------------------------------------------------------------------------

export const IN_FLIGHT: readonly TrancheState[] = ["executing", "source-confirmed", "destination-submitted", "partial"];
export const PREPARED: readonly TrancheState[] = ["funded", "signed", "failed"];
export const OPEN: readonly TrancheState[] = ["committed", ...PREPARED, ...IN_FLIGHT, "refunding"];
export const TERMINAL: readonly TrancheState[] = ["settled", "refunded", "skipped"];

export interface Exposure { total: bigint; cap: bigint; inFlight: bigint; prepared: bigint; completed: bigint; remaining: bigint; protected: bigint; maxLoss: bigint; next: bigint | null; preparedCount: number; inFlightCount: number }

const big = (s: string | undefined): bigint => BigInt(s ?? "0");

/** The accounting of §5 from the tranche states alone (pure). */
export function exposure(c: Campaign): Exposure {
  const total = big(c.request.amount);
  const cap = big(c.bounds.maxExternalExposure);
  let inFlight = 0n, prepared = 0n, completed = 0n, preparedCount = 0, inFlightCount = 0;
  for (const t of c.tranches) {
    const a = big(t.amount);
    if (t.state === "settled") completed += a;
    else if (t.state === "partial") { const d = big(t.outcome?.delivered); completed += d > a ? a : d; inFlight += a - (d > a ? a : d); inFlightCount++; }
    else if (IN_FLIGHT.includes(t.state)) { inFlight += a; inFlightCount++; }
    else if (PREPARED.includes(t.state)) { prepared += a; preparedCount++; }
  }
  const remaining = total - completed - inFlight - prepared;
  const next = c.tranches.find((t) => t.state === "planned" || t.state === "ready" || t.state === "committed");
  const nextAmount = next ? big(next.amount) : null;
  const protectedAmount = total - completed - cap;
  return { total, cap, inFlight, prepared, completed, remaining: remaining < 0n ? 0n : remaining, protected: protectedAmount < 0n ? 0n : protectedAmount, maxLoss: min(cap, inFlight + (nextAmount ?? 0n)), next: nextAmount, preparedCount, inFlightCount };
}

/** I1, I2, I4 for releasing (handing over) a tranche of `size`; the first tranche is always alone (§6). */
export function canRelease(c: Campaign, size: bigint): { ok: true } | { ok: false; reason: string } {
  const e = exposure(c);
  if (size > e.cap) return { ok: false, reason: "the piece is above the in-flight cap (I2)" };
  if (e.inFlight + size > e.cap) return { ok: false, reason: "the cap would be exceeded while earlier tranches are unsettled (I1)" };
  const first = c.tranches[0];
  if (first && first.state !== "settled" && first.state !== "refunded" && first.state !== "skipped" && e.inFlightCount > 0) return { ok: false, reason: "the first tranche is the live health test: it settles alone (§6)" };
  if (c.plan.concurrency === "sequential" && e.inFlightCount > 0) return { ok: false, reason: "sequential mode: one tranche in flight at a time" };
  if (e.inFlightCount >= c.plan.maxParallel) return { ok: false, reason: "the parallel limit is reached" };
  return { ok: true };
}

/** I4 for preparing (funding) a tranche. */
export function canPrepare(c: Campaign): { ok: true } | { ok: false; reason: string } {
  const e = exposure(c);
  if (e.preparedCount + e.inFlightCount >= c.plan.maxParallel) return { ok: false, reason: "as many tranches as the mode allows are prepared or in flight (I4)" };
  return { ok: true };
}

// ---- gates (§6) -------------------------------------------------------------------------------------------------

export const FINALITY_MARGIN_SECONDS: Record<string, number> = { bitcoin: 3600, solana: 60, default: 900 }; // lab-calibrated

export function gateFor(riskClass: RiskClass, mode: ProtectionMode): Gate {
  if (mode === "max-safety") return "destination-final";
  if (riskClass === "R1") return "source";
  if (riskClass === "R2" || riskClass === "R4") return "destination-submitted";
  return "destination-final";
}

export interface SettlementFacts {
  /** the tracker's order state (frontend/src/sdk/orderTracker.ts deriveState) */
  state: string;
  /** when the destination was first seen delivered (unix ms); the finality margin counts from here */
  deliveredSince?: number;
  /** the destination chain, for the margin */
  chain: string;
}

/** Whether a tranche counts as settled under `gate` (§6). An unknown state never settles (I3). */
export function settledBy(gate: Gate, f: SettlementFacts, now: number, margins: Record<string, number> = FINALITY_MARGIN_SECONDS): boolean {
  const s = f.state;
  const delivered = s === "DESTINATION_FINAL" || s === "COMPLETED";
  const submitted = delivered || s === "DESTINATION_SUBMITTED";
  const sourceFinal = submitted || s === "SOURCE_FINAL" || s === "PROVIDER_EXECUTING";
  if (gate === "source") return sourceFinal;
  if (gate === "destination-submitted") return submitted;
  if (!delivered || f.deliveredSince === undefined) return false;
  const margin = (margins[f.chain] ?? margins.default ?? 0) * 1000;
  return now >= f.deliveredSince + margin;
}

// ---- bounds (§3) ------------------------------------------------------------------------------------------------

export const RATE_SCALE = 10n ** 18n;
/** destination base units per source base unit, 1e18 fixed point */
export const rateE18 = (out: bigint, amountIn: bigint): bigint => (amountIn > 0n ? (out * RATE_SCALE) / amountIn : 0n);

export interface BoundsCheckInput {
  amount: bigint;
  /** the hard quote's guaranteed minimum for this tranche */
  toAmountMin: bigint;
  quoteExpiresAt: number;
  /** the tranche's fee (tip + relayer fee) in bps of the tranche */
  feeBps: number;
  destination: string;
  /** what every earlier tranche funded, base units */
  fundedBefore: bigint;
  now: number;
}

export function checkWithinBounds(b: ExecutionBounds, x: BoundsCheckInput): { ok: true } | { ok: false; reason: string } {
  if (x.fundedBefore + x.amount > big(b.amountInLimit)) return { ok: false, reason: "the tranche would exceed the order's amount limit" };
  if (x.now >= b.expiry) return { ok: false, reason: "the campaign has expired" };
  if (x.quoteExpiresAt > b.expiry) return { ok: false, reason: "the quote outlives the campaign expiry" };
  if (rateE18(x.toAmountMin, x.amount) < big(b.minimumOutput)) return { ok: false, reason: "the hard quote guarantees less per unit than the minimum you approved" };
  if (x.feeBps > b.maxFeeBps) return { ok: false, reason: "the fee is above the maximum you approved" };
  if (b.destination.kind !== "fresh-per-tranche" && x.destination.toLowerCase() !== b.destination.address.toLowerCase()) return { ok: false, reason: "the destination differs from the one you approved" };
  return { ok: true };
}

// ---- pause detection (§8) ---------------------------------------------------------------------------------------

export const MAX_DEVIATION_BPS = 100; // lab-calibrated
export const CONGESTION_FACTOR = 3;
export const STALL_FACTOR = 3;

export interface PauseFacts {
  now: number;
  walletPaused: boolean;
  /** the Chainlink cross-rate now (destination over source), 1e18 fixed point; undefined when unavailable */
  crossRateE18?: string;
  /** the active tranche's hard quote per unit, once prepared */
  hardQuoteRateE18?: string;
  /** the provider call's receiver differs from the tranche's destination (the wallet already refused the call) */
  receiverMismatch?: boolean;
  /** incidents of the chosen provider, as unix ms dates */
  incidentDates?: number[];
  providerHealth?: { reliability?: number; breakerOpen?: boolean };
  liveQuotes?: number;
  gasPriceWei?: string;
  gasPriceAtConfirmationWei?: string;
  jobState?: string;
  trackState?: string;
  /** the active tranche's delivered amount vs its guaranteed minimum, destination base units */
  delivered?: string;
  guaranteedMin?: string;
  /** seconds since the active tranche was handed over, and the plan's expected time */
  settlementAgeSeconds?: number;
  expectedSeconds?: number;
  /** a money-moving step ended with an unknown outcome */
  reconcileNeeded?: boolean;
  boundsViolation?: string;
}

/** The first pause condition that holds, in the order of §8's severity; null when the campaign is healthy. */
export function detectPause(c: Campaign, f: PauseFacts): { reason: PauseReason; detail: string } | null {
  if (f.walletPaused) return { reason: "wallet-pause", detail: "Large operations are paused by you; in-flight steps are still tracked." };
  if (f.reconcileNeeded) return { reason: "reconcile", detail: "A step ended without a known outcome; the chain and the executor are read before anything is sent again." };
  if (f.receiverMismatch) return { reason: "unexpected-destination", detail: "The provider call would pay a different destination; nothing was signed." };
  const since = c.createdAt;
  if (f.incidentDates?.some((d) => d >= since)) return { reason: "security-incident", detail: "A security incident for the chosen provider was reported after this operation started." };
  if (f.jobState === "execute-failed" || f.jobState === "refund-failed" || f.trackState === "FAILED" || f.providerHealth?.breakerOpen) return { reason: "provider-error", detail: f.providerHealth?.breakerOpen ? "The provider is skipped after repeated failures." : "The executor or the provider reported a failure on the current step." };
  if (f.delivered !== undefined && f.guaranteedMin !== undefined && big(f.delivered) < big(f.guaranteedMin)) return { reason: "anomaly", detail: `The step delivered less than its guaranteed minimum (${f.delivered} of at least ${f.guaranteedMin}).` };
  if (f.trackState === "PARTIAL") return { reason: "anomaly", detail: "The step was filled only in part; the rest returns to your private balance before anything continues." };
  if (f.settlementAgeSeconds !== undefined && f.expectedSeconds !== undefined && f.expectedSeconds > 0 && f.settlementAgeSeconds > STALL_FACTOR * f.expectedSeconds) return { reason: "anomaly", detail: "The current step is taking far longer than expected." };
  if (f.hardQuoteRateE18 !== undefined && big(f.hardQuoteRateE18) < big(c.bounds.minimumOutput)) return { reason: "price-deviation", detail: "The hard quote guarantees less per unit than the minimum you approved." };
  if (f.crossRateE18 !== undefined) {
    const ref = big(c.referenceRateE18), now = big(f.crossRateE18);
    if (ref > 0n && now * 10000n < ref * BigInt(10000 - MAX_DEVIATION_BPS)) return { reason: "price-deviation", detail: `The market moved more than ${MAX_DEVIATION_BPS / 100} % against this operation since you confirmed it.` };
  }
  if ((f.providerHealth?.reliability !== undefined && f.providerHealth.reliability < 60) || f.liveQuotes === 0) return { reason: "route-degraded", detail: f.liveQuotes === 0 ? "No provider quotes this step right now." : "The chosen provider's reliability dropped." };
  if (f.gasPriceWei !== undefined && f.gasPriceAtConfirmationWei !== undefined && big(f.gasPriceAtConfirmationWei) > 0n && big(f.gasPriceWei) > big(f.gasPriceAtConfirmationWei) * BigInt(CONGESTION_FACTOR)) return { reason: "chain-congestion", detail: "The network fee is several times what it was when you confirmed." };
  if (f.boundsViolation) return { reason: "bounds", detail: f.boundsViolation };
  return null;
}

// ---- the reducer (§7) -------------------------------------------------------------------------------------------

export type Action =
  | { kind: "none" }
  | { kind: "wait"; until: number; why: string }
  | { kind: "shape-notes" }
  | { kind: "commit"; index: number }
  | { kind: "fund"; index: number }
  | { kind: "sign"; index: number }
  | { kind: "hand-over"; index: number }
  | { kind: "track"; indexes: number[] }
  | { kind: "pause"; reason: PauseReason; detail: string; index?: number }
  | { kind: "replan" }
  | { kind: "requote" }
  | { kind: "wind-down" }
  | { kind: "complete" };

export interface ReducerFacts {
  now: number;
  /** the pause condition on fresh facts (detectPause), already computed by the runner */
  pause: { reason: PauseReason; detail: string } | null;
  /** the notes are shaped for the campaign (or shaping is not needed) */
  notesShaped: boolean;
}

export const TRACK_INTERVAL_MS = 15_000;
export const PAUSED_TRACK_INTERVAL_MS = 60_000;

const inFlightIndexes = (c: Campaign): number[] => c.tranches.filter((t) => IN_FLIGHT.includes(t.state) || t.state === "refunding").map((t) => t.index);

/**
 * The one next action for the runner, from the journaled campaign and fresh facts. One action per tick; the
 * runner journals before and after it and re-reads the journal at the next tick (§7, §9).
 */
export function nextAction(c: Campaign, f: ReducerFacts): Action {
  const flying = inFlightIndexes(c);
  const track: Action = flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: f.now + PAUSED_TRACK_INTERVAL_MS, why: "paused" };
  switch (c.state) {
    case "completed": case "cancelled": return { kind: "none" };
    case "paused": return track;
    case "reassessing": return f.pause ? { kind: "pause", reason: f.pause.reason, detail: f.pause.detail } : { kind: "requote" };
    case "requoting": return { kind: "requote" };
    case "rerouting": return track.kind === "track" ? track : { kind: "none" }; // waits for the user's Review
    case "winding-down": {
      const open = c.tranches.some((t) => OPEN.includes(t.state) || t.state === "ready");
      if (!open) return { kind: "complete" };
      const funded = c.tranches.find((t) => t.state === "funded" || t.state === "signed" || t.state === "failed");
      if (funded) return { kind: "wind-down" }; // the runner hands the funded tranche a refund-only job (§8)
      return flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: f.now + TRACK_INTERVAL_MS, why: "winding down" };
    }
    case "user-confirmed": return c.plan.shapeNotes && !f.notesShaped ? { kind: "shape-notes" } : { kind: "commit", index: 0 };
    case "preparing-notes": return f.notesShaped ? { kind: "commit", index: 0 } : { kind: "shape-notes" };
    case "running": break;
  }
  // running
  if (f.pause) return { kind: "pause", reason: f.pause.reason, detail: f.pause.detail };
  // a tranche awaiting a wallet action advances first (the lowest one): a committed order is funded and signed before
  // any new one is committed, so quotes never wait and the pipeline holds one tranche at a time
  const pending = c.tranches.find((t) => t.state === "ready" || t.state === "committed" || t.state === "funded" || t.state === "signed" || t.state === "failed");
  if (pending) {
    const i = pending.index;
    switch (pending.state) {
      case "ready": return { kind: "commit", index: i };
      case "committed": return { kind: "fund", index: i };
      case "funded": return { kind: "sign", index: i };
      case "signed": { const r = canRelease(c, big(pending.amount)); return r.ok ? { kind: "hand-over", index: i } : flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: f.now + TRACK_INTERVAL_MS, why: r.reason }; }
      default: return { kind: "pause", reason: "provider-error", detail: "The step failed; its funds are in its escrow and return to your private balance.", index: i };
    }
  }
  const e = exposure(c);
  const next = c.tranches.find((t) => t.state === "planned");
  if (next) {
    if (next.notBefore !== undefined && next.notBefore > f.now) return flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: next.notBefore, why: "the random delay before the next step" };
    const p = canPrepare(c);
    const r = canRelease(c, big(next.amount));
    if (p.ok && r.ok) return { kind: "commit", index: next.index };
    const why = !p.ok ? p.reason : !r.ok ? r.reason : "waiting";
    return flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: f.now + TRACK_INTERVAL_MS, why };
  }
  if (flying.length) return { kind: "track", indexes: flying };
  if (e.remaining > 0n) return { kind: "replan" }; // a refund came back: the remainder is planned again
  return { kind: "complete" };
}

// ---- pure transitions -------------------------------------------------------------------------------------------

export function withTrancheState(c: Campaign, index: number, state: TrancheState, at: number, patch: Partial<Tranche> = {}, note?: string): Campaign {
  const tranches = c.tranches.map((t) => (t.index === index ? { ...t, ...patch, state, history: t.state === state ? t.history : [...t.history, { state, at, ...(note ? { note } : {}) }] } : t));
  return { ...c, tranches };
}

export function withCampaignState(c: Campaign, state: CampaignState, at: number, note?: string, patch: Partial<Campaign> = {}): Campaign {
  return { ...c, ...patch, state, history: c.state === state ? c.history : [...c.history, { state, at, ...(note ? { note } : {}) }] };
}

/** A new campaign at the confirmation (§7): its tranches planned, nothing funded. */
export function createCampaign(o: { id: string; now: number; mode: ProtectionMode; tier: Tier; request: Campaign["request"]; bounds: ExecutionBounds; plan: TranchePlan; pieces: bigint[]; referenceRateE18: bigint; riskSnapshot?: unknown; confirmations?: Partial<Campaign["confirmations"]> }): Campaign {
  return {
    id: o.id, createdAt: o.now, state: "user-confirmed", mode: o.mode, tier: o.tier, request: o.request, bounds: o.bounds, plan: o.plan,
    tranches: o.pieces.map((p, index) => ({ index, amount: p.toString(), state: "planned" as TrancheState, attempt: 0, history: [{ state: "planned" as TrancheState, at: o.now }] })),
    referenceRateE18: o.referenceRateE18.toString(), riskSnapshot: o.riskSnapshot,
    confirmations: { commit: o.now, ...o.confirmations },
    history: [{ state: "user-confirmed", at: o.now }],
  };
}

/** Re-plan the unfunded remainder after a refund (the reducer's `replan`): planned tranches are replaced. */
export function replan(c: Campaign, pieces: bigint[], now: number): Campaign {
  const kept = c.tranches.filter((t) => t.state !== "planned");
  const base = kept.length;
  const fresh = pieces.map((p, i) => ({ index: base + i, amount: p.toString(), state: "planned" as TrancheState, attempt: 0, history: [{ state: "planned" as TrancheState, at: now, note: "re-planned" }] }));
  return { ...c, tranches: [...kept, ...fresh] };
}

/** The share of the order each provider carried or is carrying (§10, concentration). */
export function providerShares(c: Campaign): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const t of c.tranches) if (t.provider && t.state !== "planned" && t.state !== "skipped" && t.state !== "refunded") out[t.provider] = (out[t.provider] ?? 0n) + big(t.amount);
  return out;
}

/** The plan §46 maximum-loss model in base units: order, cap, maximum external exposure, remaining protected. */
export function maximumLossModel(c: Campaign): { order: bigint; cap: bigint; maxExposure: bigint; protected: bigint } {
  const e = exposure(c);
  return { order: e.total, cap: e.cap, maxExposure: min(e.cap, e.total), protected: e.total - min(e.cap, e.total) };
}
