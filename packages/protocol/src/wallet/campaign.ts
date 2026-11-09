// High-value protection — the shared core (spec V3 docs/high-value-protection-spec-v1.0.md §2–§9): a large
// order is executed as a CAMPAIGN of TRANCHES, each one external execution risk boundary and one ordinary
// V1.1/V2 order (its own escrow). This module is pure and JSON-safe (bigints travel as decimal strings in the
// journal): the tranche splitter (§4), the exposure accounting with its invariants (§5), the settlement gate
// per risk class (§6), the bounds check (§3), the pause detection (§8) and the reducer that tells the wallet's
// runner the one next action (§7). The wallet, the service's recommendation and the labs run exactly this code.
import { bucketsFor } from "./amounts";
import { lateRefundHeld } from "./settlement";
import { feeForWithdrawal, PRIVACY_FEE_BPS } from "./fees";
import type { Tier } from "./valuation";

export type RiskClass = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7";
export type Gate = "source" | "destination-submitted" | "destination-final";
/** V4 (contract §2.1, plan §90): Best Execution keeps the band's cap, releases in parallel where the class allows and scores under the best-execution preset. */
export type ProtectionMode = "balanced" | "max-privacy" | "max-safety" | "best-execution";
export type Sizing = "bucket" | "varied";
export type Concurrency = "sequential" | "parallel";
export type CampaignState = "user-confirmed" | "preparing-notes" | "running" | "paused" | "reassessing" | "requoting" | "rerouting" | "winding-down" | "completed" | "cancelled";
/**
 * `destination-confirmed` (V4, contract §4.2): the destination delivered, the finality margin running — the plan's DESTINATION_CONFIRMED
 * before FINALIZED. `undelivered` (the seventh review round, 2026-11-03): the step ended at its provider without delivering the order's
 * asset — refunded at the destination, delivered in another token, or failed with nothing back in its escrow — out of the protected
 * balance, never counted as completed (I5), never planned again, and its route paused on (§9). Such steps had settled as completed,
 * or stayed failed or partial for good.
 */
export type TrancheState = "planned" | "ready" | "committed" | "funded" | "signed" | "executing" | "source-confirmed" | "destination-submitted" | "destination-confirmed" | "settled" | "partial" | "refunding" | "refunded" | "failed" | "skipped" | "undelivered";
export type PauseReason = "price-deviation" | "provider-error" | "chain-congestion" | "route-degraded" | "unexpected-destination" | "security-incident" | "anomaly" | "reconcile" | "bounds" | "user" | "wallet-pause" | "velocity";
/** The alert kinds of §15 (plan V3 §76), plus the campaign's own milestones. */
export type AlertKind = "provider-degraded" | "price-changed" | "liquidity-dropped" | "destination-changed" | "route-changed" | "execution-delayed" | "chain-congested" | "security-incident" | "paused" | "resumed" | "step-settled" | "completed" | "cancelled";
/** `code`: a pause's catalog code when the runner knows its cause, read by the screens before the kind (the fourth critique of slice 4). */
export interface CampaignAlert { kind: AlertKind; at: number; text: string; trancheIndex?: number; code?: string }

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
  /**
   * The same per unit the provider is paid — a tranche's escrow less its executor tip — when the confirmation knew the tip
   * its quote set was net of (a V6 follow-up of 2026-10-17, audit c55). Each tranche pays its own tip, so per unit of the
   * escrow a tranche looked worse than the market as the gas price rose, and paused at commit; the tips are held by
   * `maxFeeBps`, the price by this. Optional: a campaign from before keeps `minimumOutput`.
   */
  minimumOutputNet?: string;
  /** unix seconds: no tranche is committed after it */
  expiry: number;
  /** the tip plus the relayer fee ceiling per tranche, bps of the tranche */
  maxFeeBps: number;
  /**
   * The most one step's executor tip may be, source base units: the Review's tip × CONGESTION_FACTOR, the congestion pause's own
   * threshold (the seventh review round, 2026-11-03). The stated Minimum is computed with it, so the steps together never deliver below
   * it; each step had been held only per unit net of its own tip, and a gas rise under the pause took the campaign below the Minimum
   * the user approved. Absent when the confirmation knew no tip, and on a campaign from before.
   */
  maxExecutorTip?: string;
  /**
   * V7 (spec v3.0 §3): the relayer's F the Review showed, source base units — each piece's funding never pays more than its
   * privacy share plus this (`StoredSwap.reviewedFee`, the Review's `F × n`); absent on a campaign from before
   */
  maxRelayerFee?: string;
  /**
   * V7 Stage 12 follow-up: the relayer's privacy fee in basis points at the Review (`FeeTerms.feePercentBps`) — with
   * `maxRelayerFee`, the terms every piece's funding is bound by (the product's 100 when a campaign recorded none)
   */
  relayerFeeBps?: number;
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
  /** V5 (spec §11): the consumer band's exact quarters (planTranches `exact`); absent on every earlier campaign */
  exact?: boolean;
  /** the campaign needs its notes reshaped before the first tranche (§4) */
  shapeNotes: boolean;
  /** the thin-market or instant-limit ceiling on a piece in base units (the service's `maxPieceUnits`), kept for every re-plan (the seventh review round) */
  maxPiece?: string;
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
  /** `delivered` in SOURCE base units (the destination amount converted at the expected rate, so the accounting of §5 adds like with like); `deliveredOut` as the tracker reported it, destination base units */
  outcome?: {
    delivered?: string;
    deliveredOut?: string;
    refunded?: string;
    deviationBps?: number;
    /** how an `undelivered` step ended; `refunded-other-token` (the twelfth review round, C12-4): it came back in another token than the order's */
    undelivered?: "refunded-at-destination" | "other-token" | "lost" | "refunded-other-token";
    /** what came back in other tokens than the order's, by vault (C12-4): never planned again in the order's asset */
    returnedOther?: { vault: string; amount: string }[];
    /** a `refunded-other-token` step its provider delivered in part, without saying how much (C12-4): how much of it came back is not known either */
    deliveredInPart?: boolean;
    /** a skipped last step too small to swap on its own, left in the private balance (the seventh review round) */
    kept?: boolean;
  };
  /**
   * The amount the step's escrow was funded with, kept when a partial fill settles `amount` to its delivered part (the seventh review
   * round, 2026-11-03): what neither arrived nor came back counts as ended, never as remaining to swap again.
   */
  funded?: string;
  /** the hard quote's expiry (unix s) and the executor's job id, mirrored from the child order for the Review */
  quoteExpiresAt?: number;
  jobId?: string;
  handedOverAt?: number;
  /** when the tracker first reported the destination delivered (the finality margin counts from here) */
  deliveredSince?: number;
  settledAt?: number;
  /** V4 (plan §110): the last settlement read that failed; the screens say "Unknown / reconnecting" while it is newer than the last successful read */
  lastReadFailedAt?: number;
  /** V4 (plan §111): when the funding was first seen in the escrow by the RPC quorum — a balance below the amount after this is a possible reorganization (the runner pauses `reconcile`; the tranche is never funded twice) */
  fundedSeenAt?: number;
  /**
   * When a relayer last refused to return this held step (refund_not_watched: a job it will not reopen; the twelfth review round, XI's critique):
   * while the rest returns, the step is asked again after REFUSED_RETRY_MS and the steps behind it are returned meanwhile; cleared once a return is
   * accepted.
   */
  refundRefusedAt?: number;
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
  /** the provider every tranche is quoted from (the confirmation's choice, or the one adopted on a reroute, §8) */
  provider?: string;
  /** the policy the tranches are ordered under (the service derives it from the preference and the tier, V2 §4) */
  policy?: string;
  /** the relayer's gas price at confirmation (wei), the reference of the congestion pause (§8) */
  gasPriceAtConfirmationWei?: string;
  /** a reroute waiting for the user's Review (§8): the provider a fresh competition chose and its recommendation */
  pendingReroute?: { provider: string; protection?: unknown; at: number };
  /** the alerts of §15, newest last; the screens show the unread tail */
  alerts?: CampaignAlert[];
  /** the privacy lint at confirmation and the valuation, kept for the export */
  lint?: unknown;
  value?: unknown;
  /**
   * `code`: the catalog code of the cause, when the runner knows it (the eleventh review round's third critique of slice 4): a reason is coarse —
   * a step the relayer cannot fund, or a commit the swap service could not take, had read "The provider reported an error on a step"
   */
  pause?: { reason: PauseReason; detail: string; at: number; trancheIndex?: number; code?: string };
  /** the user's last answer (pause, resume, a reroute's answer, return the rest), unix ms: a tick that ran while it was given
   *  keeps it (the audit round of 2026-10-16, c36); optional */
  decidedAt?: number;
  /**
   * No step is committed before this (unix ms): the institutional review hold and an entered destination's cooling-off at the
   * confirmation (the seventh review round, 2026-11-03). They had lived only in the first step's `notBefore`, which the requote of
   * every Resume overwrote with a cadence draw: a Pause and a Resume paid a cooling destination within the hour.
   */
  holdUntil?: number;
  /** when the campaign paused to ask before a step that came back is swapped again (the seventh review round, B1): a Resume after it is the user's word */
  replanAskedAt?: number;
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
  /**
   * V5 (Privacy Wallet Web spec §11): pieces of exactly the band's upper edge instead of the alphabet's buckets — the
   * consumer band's four sequential quarters. The remainder joins the last piece while that stays under the cap, else it
   * is a piece of its own (a few base units at most when the order is not a multiple of four).
   */
  exact?: boolean;
}
export interface Split { pieces: bigint[]; /** pieces that are not a bucket or a sum of two (the remainder, or a band no bucket fits) */ exact: number; /** the band in base units */ band: [bigint, bigint] }

const bps = (x: bigint, b: number): bigint => (x * BigInt(b)) / 10000n;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** The most steps one plan cuts (the eighth review round, 2026-11-03, A-M3 / D-M3): the honest plans stay under it — a 1 % cap run three at a time cuts up to ~750 — and a dust ceiling had cut millions. */
export const MAX_TRANCHES = 1000;
/** A plan of more steps than any campaign runs: the route's figures or the request, refused before anything is planned. */
export class TooManyTranches extends Error {
  readonly code = "too_many_steps";
  constructor(readonly max: number) {
    super(`this order would be cut into more than ${max} steps on this route: it cannot be staged here`);
    this.name = "TooManyTranches";
  }
}

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
  // never more than MAX_TRANCHES steps (the eighth review round, A-M3 / D-M3): one provider's dust instant limit, or an impact halved
  // down to wei, had made a step of every few wei — millions of loop turns and gigabytes in the service's only thread and the wallet's tab
  const more = (pieces: bigint[]) => { if (pieces.length >= MAX_TRANCHES) throw new TooManyTranches(MAX_TRANCHES); };
  if (o.exact) {
    const pieces: bigint[] = [];
    let left = total;
    while (left >= upper) { more(pieces); pieces.push(upper); left -= upper; }
    let exact = pieces.length;
    if (left > 0n) { if (pieces.length && pieces[pieces.length - 1] + left <= cap) pieces[pieces.length - 1] += left; else pieces.push(left); exact++; }
    return { pieces, exact, band: [lower, upper] };
  }
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
    more(pieces);
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

export const IN_FLIGHT: readonly TrancheState[] = ["executing", "source-confirmed", "destination-submitted", "destination-confirmed", "partial"];
export const PREPARED: readonly TrancheState[] = ["funded", "signed", "failed"];
export const OPEN: readonly TrancheState[] = ["committed", ...PREPARED, ...IN_FLIGHT, "refunding"];
export const TERMINAL: readonly TrancheState[] = ["settled", "refunded", "skipped", "undelivered"];

export interface Exposure { total: bigint; cap: bigint; inFlight: bigint; prepared: bigint; completed: bigint; /** what did not arrive as asked — notAsAsked(): gone (notDelivered), back in another token (returnedOther, partlyBack) — and what a returned step did not bring back (returnCosts: its tip, its provider's fees); the seventh review round, the twelfth's XF and XG critiques — never completed, never planned again */ ended: bigint; /** the part of `ended` that came back to the private balance in another token than the order's (the twelfth review round, C12-4): never planned again in the order's asset, never "did not come back" */ returnedOther: bigint; /** the part of `ended` in steps delivered in part whose rest came back in another token, the provider not saying how much it delivered (C12-4): neither "came back" nor "did not come back" alone */ partlyBack: bigint; /** the part of `ended` that neither arrived as asked nor came back, in any token — what is gone (the eleventh review round's critique of E11-1: the screens' "did not arrive as you asked" had counted a returned step's fees); what did not arrive as asked is `notAsAsked()`, which adds what came back in another token */ notDelivered: bigint; /** the rest of `ended`: what returned steps did not bring back — their executor's tip, their provider's fees — a cost of those steps */ returnCosts: bigint; /** left in the private balance, never swapped: a last step too small to swap on its own — the campaign completes without it (the seventh review round) —, and an undelivered step's own-asset dust (the twelfth's XE critique) */ kept: bigint; remaining: bigint; protected: bigint; maxLoss: bigint; next: bigint | null; preparedCount: number; inFlightCount: number; /** V4 (plan §25, §67): the in-flight amount per provider */ byProvider: Record<string, bigint> }

const big = (s: string | undefined): bigint => BigInt(s ?? "0");

/**
 * What a settled step neither delivered nor brought back: a partial fill's rest once the executor's watch ended with nothing more back (the
 * seventh review round); 0 for a step delivered in full, or whose rest came back (its cost is then part of what it settled for).
 */
export function unreturnedOf(t: Tranche): bigint {
  if (t.state !== "settled" || t.funded === undefined) return 0n;
  const short = big(t.funded) - big(t.amount) - big(t.outcome?.refunded);
  return short > 0n ? short : 0n;
}

/** The accounting of §5 from the tranche states alone (pure). */
export function exposure(c: Campaign): Exposure {
  const total = big(c.request.amount);
  const cap = big(c.bounds.maxExternalExposure);
  let inFlight = 0n, prepared = 0n, completed = 0n, ended = 0n, notDelivered = 0n, returnedOther = 0n, partlyBack = 0n, returnCosts = 0n, kept = 0n, preparedCount = 0, inFlightCount = 0;
  const byProvider: Record<string, bigint> = {};
  const fly = (t: Tranche, amount: bigint) => { inFlight += amount; inFlightCount++; if (t.provider) byProvider[t.provider] = (byProvider[t.provider] ?? 0n) + amount; };
  for (const t of c.tranches) {
    const a = big(t.amount);
    if (t.state === "settled") {
      completed += a;
      // a partial fill settled for its delivered part: what neither arrived nor came back is spent, never remaining (the seventh review round)
      const short = unreturnedOf(t);
      ended += short;
      // its rest came back in another token (C12-4): not "did not come back"
      if (t.outcome?.returnedOther?.length) returnedOther += short;
      else notDelivered += short;
    }
    // a returned step: what did not come back (its executor tip, its provider's fees) is spent — a cost of the step, never part of the swap
    // not delivered (the eleventh review round's critique of E11-1); the refund note is what is planned again
    else if (t.state === "refunded") { const back = t.outcome?.refunded !== undefined ? big(t.outcome.refunded) : a; if (a > back) { ended += a - back; returnCosts += a - back; } }
    // a step not delivered as asked: what came back of it in the order's own asset is back in the private balance — planned again, never counted as not
    // delivered (the twelfth review round, C12-7: a destination outcome with its rest re-shielded had been booked wholly as not delivered)
    else if (t.state === "undelivered") {
      const back = t.outcome?.refunded !== undefined ? min(big(t.outcome.refunded), a) : 0n;
      ended += a - back;
      // ... dust of it kept in the balance, never planned again (the fifth critique, XE: a 1-wei note anyone can make had raised the replan's question,
      // to swap 1 wei at a privacy fee and a tip)
      if (back > 0n && !lateRefundHeld(back, a)) kept += back;
      // delivered in part, the rest back in another token, how much of each untold: neither line alone (C12-4)
      if (t.outcome?.undelivered === "refunded-other-token" && t.outcome.deliveredInPart) partlyBack += a - back;
      else if (t.outcome?.undelivered === "refunded-other-token") returnedOther += a - back;
      else notDelivered += a - back;
    }
    else if (t.state === "skipped" && t.outcome?.kept) kept += a;
    else if (t.state === "partial") { const d = big(t.outcome?.delivered); completed += d > a ? a : d; fly(t, a - (d > a ? a : d)); }
    else if (IN_FLIGHT.includes(t.state)) fly(t, a);
    // a step coming back (a provider that failed it, a return) is out of the private balance until its refund lands (the
    // audit round of 2026-10-16, c53): it had counted nowhere, and the next step went to the same provider at once
    else if (t.state === "refunding") fly(t, a);
    else if (PREPARED.includes(t.state)) { prepared += a; preparedCount++; }
  }
  const remaining = total - completed - inFlight - prepared - ended - kept;
  const next = c.tranches.find((t) => t.state === "planned" || t.state === "ready" || t.state === "committed");
  const nextAmount = next ? big(next.amount) : null;
  const protectedAmount = total - completed - ended - cap;
  return { total, cap, inFlight, prepared, completed, ended, notDelivered, returnedOther, partlyBack, returnCosts, kept, remaining: remaining < 0n ? 0n : remaining, protected: protectedAmount < 0n ? 0n : protectedAmount, maxLoss: min(cap, inFlight + (nextAmount ?? 0n)), next: nextAmount, preparedCount, inFlightCount, byProvider };
}

/**
 * What did not arrive as asked: what neither arrived nor came back, what came back in another token, and the steps delivered in part whose rest
 * came back in another token (the twelfth review round, C12-4).
 */
export const notAsAsked = (e: Pick<Exposure, "notDelivered" | "returnedOther" | "partlyBack">): bigint => e.notDelivered + e.returnedOther + e.partlyBack;

/**
 * Nothing of the order is left to return: every unit delivered as asked, kept aside as too small to swap, or spent as a returned step's fees
 * (the eleventh review round's third critique of slice 4: a campaign cancelled once its last step was on its way ends with everything swapped,
 * and had read "Delivered in part", "✓ Returned" and "The rest returned to your private balance").
 */
export const swappedInFull = (e: Exposure): boolean => e.notDelivered === 0n && e.completed + e.kept + e.returnCosts >= e.total;

/** The per-provider limit (I6, plan §46, §67): the order × the plan's share cap (10000 when one venue quotes: a single venue is disclosed, never diversified for appearance). */
export const providerLimit = (c: Campaign): bigint => bps(big(c.request.amount), Math.min(10000, Math.max(0, c.plan.providerShareCapBps || 10000)));

/** The plan's §26 ledger (contract §3.5): derived from the tranche states alone, never stored. */
export interface ExposureLedger { orderId: string; totalOrderValue: string; maxExternalExposure: string; completed: string; inFlight: string; pending: string; remaining: string; /** spent, or not delivered as asked: exposure().ended (gone, back in another token, a returned step's costs) */ ended: string; /** left in the balance, never swapped: exposure().kept */ kept: string; byProvider: Record<string, { inFlight: string; limit: string }> }
export function ledger(c: Campaign): ExposureLedger {
  const e = exposure(c);
  const limit = providerLimit(c).toString();
  const byProvider: ExposureLedger["byProvider"] = {};
  for (const [p, v] of Object.entries(e.byProvider)) byProvider[p] = { inFlight: v.toString(), limit };
  return { orderId: c.id, totalOrderValue: e.total.toString(), maxExternalExposure: e.cap.toString(), completed: e.completed.toString(), inFlight: e.inFlight.toString(), pending: e.prepared.toString(), remaining: e.remaining.toString(), ended: e.ended.toString(), kept: e.kept.toString(), byProvider };
}

/** I1, I2, I4 and (V4) I6 for releasing (handing over) a tranche of `size` with `provider`; the first tranche is always alone (§6). */
export function canRelease(c: Campaign, size: bigint, provider?: string): { ok: true } | { ok: false; reason: string } {
  const e = exposure(c);
  if (size > e.cap) return { ok: false, reason: "the piece is above the in-flight cap (I2)" };
  if (e.inFlight + size > e.cap) return { ok: false, reason: "the cap would be exceeded while earlier tranches are unsettled (I1)" };
  if (provider && (e.byProvider[provider] ?? 0n) + size > providerLimit(c)) return { ok: false, reason: `${provider} would carry more than its share of the order at once (I6)` };
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

const GATE_RANK: Record<Gate, number> = { source: 0, "destination-submitted": 1, "destination-final": 2 };
/** The stricter of two gates (the seventh review round, 2026-11-03): the wallet's own and the service's recommendation. */
export const stricterGate = (a: Gate, b: Gate): Gate => (GATE_RANK[a] >= GATE_RANK[b] ? a : b);
const CLASS_RANK: Record<RiskClass, number> = { R1: 1, R2: 2, R4: 3, R3: 4, R7: 4, R5: 5, R6: 6 };
/** The riskier of two classes (the seventh review round): R1 < R2 < R4 < the R3 / R7 flags < R5 < R6 (spec §2). */
export const riskierClass = (a: RiskClass, b: RiskClass): RiskClass => (CLASS_RANK[a] >= CLASS_RANK[b] ? a : b);

export interface SettlementFacts {
  /** the tracker's order state (packages/sdk/src/orderTracker.ts deriveState) */
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
  /** the tranche's executor tip (source base units): with `minimumOutputNet`, the price is checked per unit paid to the provider */
  executorTip?: bigint;
  destination: string;
  /** what every earlier tranche funded, base units */
  fundedBefore: bigint;
  now: number;
}

/**
 * What a tranche's call must guarantee (§3): its amount paid to the provider (the escrow less its own tip) at
 * `minimumOutputNet` when the bounds have it and the tip is known, else its amount at `minimumOutput`.
 */
export function trancheMinimum(b: ExecutionBounds, amount: bigint, executorTip?: bigint): bigint {
  if (b.minimumOutputNet !== undefined && executorTip !== undefined) {
    const paid = amount > executorTip ? amount - executorTip : 0n;
    return (paid * big(b.minimumOutputNet)) / RATE_SCALE;
  }
  return (amount * big(b.minimumOutput)) / RATE_SCALE;
}

export function checkWithinBounds(b: ExecutionBounds, x: BoundsCheckInput): { ok: true } | { ok: false; reason: string } {
  if (x.fundedBefore + x.amount > big(b.amountInLimit)) return { ok: false, reason: "the tranche would exceed the order's amount limit" };
  if (x.now >= b.expiry) return { ok: false, reason: "the campaign has expired" };
  if (x.quoteExpiresAt > b.expiry) return { ok: false, reason: "the quote outlives the campaign expiry" };
  // per unit paid to the provider when the bounds and the tranche know the tip (audit c55), else per unit of the tranche
  const net = b.minimumOutputNet !== undefined && x.executorTip !== undefined;
  const per = net ? rateE18(x.toAmountMin, x.amount > x.executorTip! ? x.amount - x.executorTip! : 0n) : rateE18(x.toAmountMin, x.amount);
  if (per < big(net ? b.minimumOutputNet! : b.minimumOutput)) return { ok: false, reason: "the hard quote guarantees less per unit than the minimum you approved" };
  if (x.feeBps > b.maxFeeBps) return { ok: false, reason: "the fee is above the maximum you approved" };
  if (b.maxExecutorTip !== undefined && x.executorTip !== undefined && x.executorTip > big(b.maxExecutorTip)) return { ok: false, reason: "the step's executor tip is above what you approved" };
  if (b.destination.kind !== "fresh-per-tranche" && x.destination.toLowerCase() !== b.destination.address.toLowerCase()) return { ok: false, reason: "the destination differs from the one you approved" };
  return { ok: true };
}

// ---- pause detection (§8) ---------------------------------------------------------------------------------------

export const MAX_DEVIATION_BPS = 100; // lab-calibrated
export const CONGESTION_FACTOR = 3;
export const STALL_FACTOR = 3;
/**
 * The shortest wait before a settlement reads as stalled (the eighth review round, 2026-11-03, D-L2): a fast route's ETA of seconds,
 * timed from the hand-over, had counted the relayer's own poll and the block as a stall — two of them opened the provider's breaker
 * for every user, and a campaign paused itself on its own latency.
 */
export const STALL_FLOOR_SECONDS = 600;
/** When a step's settlement reads as stalled: three times its expected seconds, never under STALL_FLOOR_SECONDS. */
export const stallAfterSeconds = (expectedSeconds: number): number => Math.max(STALL_FACTOR * expectedSeconds, STALL_FLOOR_SECONDS);

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
  /** what the reconcile is about, when the runner knows (a possible reorganization, a missing order) */
  reconcileDetail?: string;
  boundsViolation?: string;
  /** V4 (contract §2.4): the next hand-over would take the trailing 24 h above the velocity limit the user set */
  velocityExceeded?: boolean;
  /** the seventh review round: a limit is set, and the next step or a hand-over in the trailing 24 h has no price to be counted at (fail closed) */
  velocityUnknown?: boolean;
  /** the seventh review round (§9): a step ended at its provider this tick without delivering the order's asset — the pause's words */
  stepUndelivered?: string;
}

/** The first pause condition that holds, in the order of §8's severity; null when the campaign is healthy. */
export function detectPause(c: Campaign, f: PauseFacts): { reason: PauseReason; detail: string } | null {
  if (f.walletPaused) return { reason: "wallet-pause", detail: "Large operations are paused by you; in-flight steps are still tracked." };
  if (f.reconcileNeeded) return { reason: "reconcile", detail: f.reconcileDetail ?? "A step ended without a known outcome; the chain and the executor are read before anything is sent again." };
  if (f.receiverMismatch) return { reason: "unexpected-destination", detail: "The provider call would pay a different destination; nothing was signed." };
  const since = c.createdAt;
  if (f.incidentDates?.some((d) => d >= since)) return { reason: "security-incident", detail: "A security incident for the chosen provider was reported after this operation started." };
  // a provider that failed the step at its destination, or never answered it, is a provider error too (c53)
  if (f.stepUndelivered) return { reason: "provider-error", detail: f.stepUndelivered };
  if (f.jobState === "execute-failed" || f.jobState === "refund-failed" || f.trackState === "FAILED" || f.trackState === "DESTINATION_FAILED" || f.trackState === "PROVIDER_TIMEOUT" || f.providerHealth?.breakerOpen) return { reason: "provider-error", detail: f.providerHealth?.breakerOpen ? "The provider is skipped after repeated failures." : "The executor or the provider reported a failure on the current step." };
  if (f.delivered !== undefined && f.guaranteedMin !== undefined && big(f.delivered) < big(f.guaranteedMin)) return { reason: "anomaly", detail: `The step delivered less than its guaranteed minimum (${f.delivered} of at least ${f.guaranteedMin}).` };
  if (f.trackState === "PARTIAL") return { reason: "anomaly", detail: "The step was filled only in part; the rest returns to your private balance before anything continues." };
  if (f.settlementAgeSeconds !== undefined && f.expectedSeconds !== undefined && f.expectedSeconds > 0 && f.settlementAgeSeconds > stallAfterSeconds(f.expectedSeconds)) return { reason: "anomaly", detail: "The current step is taking far longer than expected." };
  if (f.hardQuoteRateE18 !== undefined && big(f.hardQuoteRateE18) < big(c.bounds.minimumOutput)) return { reason: "price-deviation", detail: "The hard quote guarantees less per unit than the minimum you approved." };
  if (f.crossRateE18 !== undefined) {
    const ref = big(c.referenceRateE18), now = big(f.crossRateE18);
    if (ref > 0n && now * 10000n < ref * BigInt(10000 - MAX_DEVIATION_BPS)) return { reason: "price-deviation", detail: `The market moved more than ${MAX_DEVIATION_BPS / 100} % against this operation since you confirmed it.` };
  }
  if ((f.providerHealth?.reliability !== undefined && f.providerHealth.reliability < 60) || f.liveQuotes === 0) return { reason: "route-degraded", detail: f.liveQuotes === 0 ? "No provider quotes this step right now." : "The chosen provider's reliability dropped." };
  if (f.gasPriceWei !== undefined && f.gasPriceAtConfirmationWei !== undefined && big(f.gasPriceAtConfirmationWei) > 0n && big(f.gasPriceWei) > big(f.gasPriceAtConfirmationWei) * BigInt(CONGESTION_FACTOR)) return { reason: "chain-congestion", detail: "The network fee is several times what it was when you confirmed." };
  if (f.velocityExceeded) return { reason: "velocity", detail: "The 24-hour limit you set for hand-overs is reached; resume once the window has moved on, or raise the limit under Settings." };
  if (f.velocityUnknown) return { reason: "velocity", detail: "The 24-hour limit you set for hand-overs is counted in US dollars, and no price is available for this operation right now: nothing more is handed over until there is. Resume once prices are back, or change the limit under Settings." };
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
  /** `replan`: the pause asks before a step that came back is swapped again (the runner records Campaign.replanAskedAt) */
  | { kind: "pause"; reason: PauseReason; detail: string; index?: number; replan?: boolean }
  | { kind: "replan" }
  | { kind: "requote" }
  /** the held step the runner hands a refund-only job while the rest returns (§8): the first one no relayer refused in the last REFUSED_RETRY_MS */
  | { kind: "wind-down"; index: number }
  /** the seventh review round: a step that failed with its money in its escrow, after the user resumed — its own refund-only job, once */
  | { kind: "refund"; index: number }
  /** V6 Stage 13: a committed step that was never funded, while the rest returns — its order is given up once the runner
   *  has read its escrow empty (nothing left the private balance) */
  | { kind: "abandon"; index: number }
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
/** A winding-down campaign asks again for a step's return a relayer refused (refund_not_watched) after this: Settings may name another by then. */
export const REFUSED_RETRY_MS = 10 * 60_000;

const inFlightIndexes = (c: Campaign): number[] => c.tranches.filter((t) => IN_FLIGHT.includes(t.state) || t.state === "refunding").map((t) => t.index);

/** The campaign's hold while it lasts (the review hold, an entered destination's cooling-off; the seventh review round): no commit before it. */
const holdLeft = (c: Campaign, now: number): number | null => (c.holdUntil !== undefined && c.holdUntil > now ? c.holdUntil : null);
/** When a tranche last entered `state` (unix ms), from its history; -Infinity when never. */
const enteredAt = (t: Tranche, state: TrancheState): number => t.history.reduce((m, h) => (h.state === state && h.at > m ? h.at : m), -Infinity);
/** Whether the user resumed the campaign after `at` (only resumeCampaign enters `reassessing`). */
const resumedSince = (c: Campaign, at: number): boolean => c.history.some((h) => h.state === "reassessing" && h.at > at);

/**
 * The pause before a step that came back is swapped again (the seventh review round, 2026-11-03): its detail opens with this sentence,
 * and a Resume after that pause is the user's word. A refund, or the rest of a partial fill, had been planned and funded again on its
 * own — a second fee note (the privacy fee and the relayer's F) and a second tip that no Review showed (fee policy: "the progress
 * screen says so before it happens").
 */
export const REPLAN_PAUSE = "Part of this swap came back to your private balance.";
/** The latest moment a step came back to the private balance: a refund, or the returned rest of a partial fill. */
function lastReturnAt(c: Campaign): number | null {
  let at = -Infinity;
  for (const t of c.tranches) {
    if (t.state === "refunded") at = Math.max(at, enteredAt(t, "refunded"));
    else if (t.state === "settled" && big(t.outcome?.refunded) > 0n) at = Math.max(at, enteredAt(t, "settled"));
    // ... and a step not delivered as asked with part of it back (the twelfth review round, XD's critique: that part was planned and swapped again with
    // no question — its privacy fee, the relayer's and a tip paid again — fee-policy §4: a second 1 % is never charged silently)
    else if (t.state === "undelivered" && lateRefundHeld(big(t.outcome?.refunded), big(t.amount))) at = Math.max(at, enteredAt(t, "undelivered"));
  }
  return at === -Infinity ? null : at;
}
/** The user resumed after the campaign asked about what came back at `back` (Campaign.replanAskedAt). */
const replanApproved = (c: Campaign, back: number): boolean => c.replanAskedAt !== undefined && c.replanAskedAt >= back && resumedSince(c, c.replanAskedAt);
const unitsText = (x: bigint, decimals: number, symbol: string): string => {
  const base = 10n ** BigInt(decimals);
  const frac = (x % base).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return `${x / base}${frac ? `.${frac}` : ""} ${symbol}`;
};
function replanDetail(c: Campaign, remaining: bigint): string {
  const { decimals, symbol } = c.request.from;
  const fee = c.bounds.maxRelayerFee !== undefined && /^\d+$/.test(c.bounds.maxRelayerFee)
    ? feeForWithdrawal(remaining, { minimum: BigInt(c.bounds.maxRelayerFee), feePercentBps: c.bounds.relayerFeeBps ?? PRIVACY_FEE_BPS })
    : null;
  return `${REPLAN_PAUSE} Swapping ${unitsText(remaining, decimals, symbol)} of it again pays its privacy fee and the relayer's fee again${fee !== null ? ` (about ${unitsText(fee, decimals, symbol)})` : ""}, and an executor tip; nothing is sent until you resume. Resume to swap it again, or return the rest.`;
}

/** The first commit waits for the campaign's hold and the first tranche's `notBefore` (§14), like any later release. */
const firstStep = (c: Campaign, f: ReducerFacts): Action => {
  const t = c.tranches.find((x) => x.state === "planned");
  if (!t) return { kind: "complete" };
  const hold = holdLeft(c, f.now) ?? (t.notBefore !== undefined && t.notBefore > f.now ? t.notBefore : null);
  if (hold !== null) return { kind: "wait", until: hold, why: "the review hold before the first step" };
  return { kind: "commit", index: t.index };
};

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
      // the runner hands a held tranche a refund-only job (§8): the first one whose return no relayer refused in the last REFUSED_RETRY_MS (the
      // twelfth review round, XI's critique: the refused step had been asked again and again, every step behind it held for good)
      const held = c.tranches.filter((t) => t.state === "funded" || t.state === "signed" || t.state === "failed");
      const due = held.find((t) => t.refundRefusedAt === undefined || f.now >= t.refundRefusedAt + REFUSED_RETRY_MS);
      if (due) return { kind: "wind-down", index: due.index };
      // V6 Stage 13 (found by the band's property test): a step committed but never funded when the rest was returned
      // would otherwise hold the campaign in winding-down forever
      const unfunded = c.tranches.find((t) => t.state === "committed");
      if (unfunded) return { kind: "abandon", index: unfunded.index };
      if (flying.length) return { kind: "track", indexes: flying };
      // ... and a refused step is asked again once its wait is over (Settings may name another relayer by then)
      if (held.length) return { kind: "wait", until: Math.min(...held.map((t) => t.refundRefusedAt! + REFUSED_RETRY_MS)), why: "a relayer refused a step's return; it is asked again" };
      return { kind: "wait", until: f.now + TRACK_INTERVAL_MS, why: "winding down" };
    }
    // the first step is released under the same facts as every later one (§6, §8): a pause condition at the start holds
    case "user-confirmed": if (f.pause) return { kind: "pause", reason: f.pause.reason, detail: f.pause.detail }; if (c.plan.shapeNotes && !f.notesShaped) return { kind: "shape-notes" }; return firstStep(c, f);
    case "preparing-notes": if (f.pause) return { kind: "pause", reason: f.pause.reason, detail: f.pause.detail }; if (!f.notesShaped) return { kind: "shape-notes" }; return firstStep(c, f);
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
      case "signed": { const r = canRelease(c, big(pending.amount), pending.provider ?? c.provider); return r.ok ? { kind: "hand-over", index: i } : flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: f.now + TRACK_INTERVAL_MS, why: r.reason }; }
      default:
        // a step that failed with its money in its escrow (the seventh review round, 2026-11-03): the pause says so, and once the user
        // resumed after it failed it returns through its own refund-only job — once — while the rest carries on; every Resume had paused again
        if (resumedSince(c, enteredAt(pending, "failed"))) return { kind: "refund", index: i };
        return { kind: "pause", reason: "provider-error", detail: "The step failed at its provider; its funds wait at the step's one-time address. Resume to return them to your private balance and carry on with the rest, or return the rest.", index: i };
    }
  }
  const e = exposure(c);
  const next = c.tranches.find((t) => t.state === "planned");
  if (next) {
    const hold = holdLeft(c, f.now);
    if (hold !== null) return flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: hold, why: "the review hold" };
    if (next.notBefore !== undefined && next.notBefore > f.now) return flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: next.notBefore, why: "the random delay before the next step" };
    const p = canPrepare(c);
    const r = canRelease(c, big(next.amount), c.provider);
    if (p.ok && r.ok) return { kind: "commit", index: next.index };
    const why = !p.ok ? p.reason : !r.ok ? r.reason : "waiting";
    return flying.length ? { kind: "track", indexes: flying } : { kind: "wait", until: f.now + TRACK_INTERVAL_MS, why };
  }
  if (flying.length) return { kind: "track", indexes: flying };
  if (e.remaining > 0n) {
    // a refund came back: the remainder is planned again — with the user's word when a step came back (its fees are paid again, B1)
    const back = lastReturnAt(c);
    if (back !== null && !replanApproved(c, back)) return { kind: "pause", reason: "bounds", detail: replanDetail(c, e.remaining), replan: true };
    return { kind: "replan" };
  }
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
