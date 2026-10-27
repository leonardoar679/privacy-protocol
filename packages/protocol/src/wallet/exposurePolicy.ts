// The exposure policy (contract docs/high-value-execution-contract-v1.0.md §2; plan "High-Value Execution Engine"
// §2–§6, §62, §80–§81, §90–§93): the value band's row of the plan's §4 table, the exposure tier R0–R4 derived from the
// route's risk model and the live facts, the effective cap from band × tier × mode × the user's fraction, the
// market-impact limit with its four remedies, and the optional velocity limit. Pure; every figure here is an
// engineering default (plan §4) that the policy benchmark revises (docs/HighValuePolicyBenchmark.md), never a rule.
import type { ProtectionMode, RiskClass } from "./campaign";
import { atLeast, type Tier } from "./valuation";

export type ExposureTier = "R0" | "R1" | "R2" | "R3" | "R4";

/** One row of the plan's §4 table: the mode word, the default cap and the range the user may choose, bps of the order. */
export interface PolicyRow { word: string; capBps: number | null; range: [number, number] | null; activation: "none" | "staged-or-opt-in" | "always" }

export const EXPOSURE_POLICY: Record<Tier, PolicyRow> = {
  standard: { word: "Normal", capBps: null, range: null, activation: "none" },
  large: { word: "Normal", capBps: null, range: null, activation: "none" }, // V5 (spec §11): the Review and the lint, no split
  "large-protected": { word: "Protected", capBps: 2500, range: [2500, 5000], activation: "staged-or-opt-in" }, // V5; V7 Stage 13 (spec v3.0 §4): one order by default, steps under 25 % when staged or asked
  enhanced: { word: "Protected", capBps: 500, range: [100, 500], activation: "staged-or-opt-in" },
  "high-value": { word: "High Value", capBps: 250, range: [100, 300], activation: "always" },
  "high-value-secondary": { word: "Very High Value", capBps: 250, range: [100, 300], activation: "always" },
  institutional: { word: "Extreme Value", capBps: 200, range: [100, 250], activation: "always" }, // inside the plan's 1–2.5 %
};

// V7 Stage 13 (spec v3.0 §4): the table is an engineering hypothesis, configurable — the service reads an optional override
// (EXPOSURE_POLICY_FILE: a JSON object keyed by tier whose rows replace the compiled ones field by field) and nothing applies a
// split at the $50K band because of the table alone. A malformed override refuses at start, naming the field, never silently.
let active: Record<Tier, PolicyRow> = EXPOSURE_POLICY;
/** The table in force: the compiled defaults, or the override installed with useExposurePolicy(). */
export const exposurePolicy = (): Record<Tier, PolicyRow> => active;
/** Installs an override (null: the compiled defaults again). */
export function useExposurePolicy(rows: Record<Tier, PolicyRow> | null): void { active = rows ?? EXPOSURE_POLICY; }
const ACTIVATIONS: PolicyRow["activation"][] = ["none", "staged-or-opt-in", "always"];
const isBps = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 10000;
/** A table from JSON: every tier present is checked field by field (word, capBps, range, activation); a tier absent keeps its compiled row; anything else refuses. */
export function exposurePolicyFrom(json: unknown): Record<Tier, PolicyRow> {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("exposure policy: an object keyed by tier is expected");
  const out: Record<Tier, PolicyRow> = { ...EXPOSURE_POLICY };
  for (const [tier, row] of Object.entries(json as Record<string, unknown>)) {
    if (!(tier in EXPOSURE_POLICY)) throw new Error(`exposure policy: unknown tier "${tier}"`);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`exposure policy: ${tier} is not a row`);
    const r = row as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!["word", "capBps", "range", "activation"].includes(k)) throw new Error(`exposure policy: ${tier}.${k} is not a field`);
    const base = EXPOSURE_POLICY[tier as Tier];
    const word = r.word === undefined ? base.word : r.word;
    const capBps = r.capBps === undefined ? base.capBps : r.capBps;
    const range = r.range === undefined ? base.range : r.range;
    const activation = r.activation === undefined ? base.activation : r.activation;
    if (typeof word !== "string" || !word.trim()) throw new Error(`exposure policy: ${tier}.word must be a word`);
    if (capBps !== null && !isBps(capBps)) throw new Error(`exposure policy: ${tier}.capBps must be a whole number of basis points in 1–10000, or null`);
    if (range !== null && !(Array.isArray(range) && range.length === 2 && isBps(range[0]) && isBps(range[1]) && range[0] <= range[1]))
      throw new Error(`exposure policy: ${tier}.range must be [low, high] in basis points with low ≤ high, or null`);
    if (capBps !== null && range !== null && ((capBps as number) < (range as number[])[0] || (capBps as number) > (range as number[])[1])) throw new Error(`exposure policy: ${tier}.capBps must lie inside its range`);
    if (!ACTIVATIONS.includes(activation as PolicyRow["activation"])) throw new Error(`exposure policy: ${tier}.activation must be one of ${ACTIVATIONS.join(", ")}`);
    out[tier as Tier] = { word, capBps: capBps as number | null, range: range as [number, number] | null, activation: activation as PolicyRow["activation"] };
  }
  return out;
}

/** The plan's §6 ranges per exposure tier, bps: what a route of that tier may ever expose at once. */
export const TIER_RANGES: Record<ExposureTier, [number, number]> = { R0: [500, 1000], R1: [250, 500], R2: [250, 250], R3: [100, 250], R4: [100, 100] };
export const TIER_WORDS: Record<ExposureTier, string> = { R0: "Atomic", R1: "Controlled RFQ", R2: "Streaming", R3: "Cross-chain intent", R4: "Unknown / high-risk route" };

/** The mode's own ceiling (plan §90): Maximum Safety is 1 % everywhere; the others keep the band's default. */
export const MODE_CAP_BPS: Record<ProtectionMode, number | null> = { balanced: null, "max-privacy": null, "max-safety": 100, "best-execution": null };

export interface ExposureFacts {
  /** the chosen quote's plan mode ("streaming" | "dca" | "single" | "auction" | "intent") */
  planMode?: string;
  /** the hard quote is a signed bound with strict parameters (an R1 venue: UniswapX, deferred; none today) */
  signedHardQuote?: boolean;
  /** the thin-market rule applied (the piece's impact exceeded the limit) */
  thinMarket?: boolean;
  /** the provider has a record in the risk database (false: a new provider, plan §6 R4) */
  knownProvider?: boolean;
  chainHalted?: boolean;
  /** days since the provider's latest security incident; null when none on record */
  incidentWithinDays?: number | null;
  breakerOpen?: boolean;
  /** the security breakdown's total (0–100) */
  security?: number;
}

/** Why a route is R4, by codes (the app's catalog words each one, audit round 2, r55). */
export type ExposureReason = "thin-market" | "unknown-provider" | "chain-halted" | "recent-incident" | "breaker-open" | "low-security" | "counterparty";
/** Why a protected execution's plan is as it is, by codes: the high-risk route names its exposure reasons. */
export type ProtectionReasonCode = "band-narrowed" | "high-risk-route" | "sequential" | "instant-limit" | "thin-market" | "single-venue" | "staged";
export interface ProtectionReason { code: ProtectionReasonCode; risks?: ExposureReason[] }

/** The exposure tier of a route (contract §2.2): derived from the V3 risk class and the live facts, never stored as policy. */
export function exposureTierOf(model: { class: RiskClass }, f: ExposureFacts = {}): { tier: ExposureTier; reasons: string[]; /** an R4 route's reasons by their codes */ codes?: ExposureReason[] } {
  const reasons: string[] = [];
  const codes: ExposureReason[] = [];
  const because = (code: ExposureReason, text: string) => {
    codes.push(code);
    reasons.push(text);
  };
  if (f.thinMarket) because("thin-market", "low liquidity for this size");
  if (f.knownProvider === false) because("unknown-provider", "no record of this provider in the risk database");
  if (f.chainHalted) because("chain-halted", "a chain of this route is halted");
  if (f.incidentWithinDays !== null && f.incidentWithinDays !== undefined && f.incidentWithinDays <= 30) because("recent-incident", "a security incident within 30 days");
  if (f.breakerOpen) because("breaker-open", "the provider's circuit breaker is open");
  if (f.security !== undefined && f.security < 60) because("low-security", "the security score is below 60");
  if (model.class === "R6") because("counterparty", "a counterparty (OTC) route");
  if (reasons.length) return { tier: "R4", reasons, codes };
  if (model.class === "R1") return { tier: "R0", reasons: ["same-chain atomic execution"] };
  if (model.class === "R2" && f.signedHardQuote) return { tier: "R1", reasons: ["a signed hard quote inside strict bounds"] };
  if (model.class === "R5" && (f.planMode === "streaming" || f.planMode === "dca")) return { tier: "R2", reasons: ["a provider-controlled stream on a bridge / MPC route"] };
  return { tier: "R3", reasons: ["non-atomic cross-chain settlement (solver, bridge or MPC)"] };
}

export interface CapInput {
  tier: Tier;
  mode: ProtectionMode;
  exposureTier: ExposureTier;
  /** the fraction the user chose in Settings, bps; absent: the defaults */
  userCapBps?: number;
}
export interface CapResult { capBps: number; /** the range the user may choose for this band and route, bps */ range: [number, number]; reasons: string[] }

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * The effective cap (contract §2.2): min(the band's default, the tier's maximum, the mode's ceiling, the user's fraction
 * clipped to the band's range). A fraction above the band's default is allowed only on an R0 / R1 route (V3 §14's
 * "3 % only where the risk engine permits"). Below the enhanced tier the enhanced row applies (a campaign there is opt-in).
 */
export function capBpsFor(i: CapInput): CapResult {
  // V5 (spec §11), V7 Stage 13 (spec v3.0 §4): the $50K band is the consumer's Protected Large Swap — one order by default,
  // protected steps of varied size (each under the quarter cap) only when staged or asked. The
  // §6 tier ceilings and the mode ceiling are the high-value layer's (bps of a $1M+ order) and do not apply here; an
  // unknown or high-risk route is not split finer but handed to the next route by the service.
  if (i.tier === "large-protected") {
    const row = exposurePolicy()["large-protected"];
    const range = row.range!;
    const reasons: string[] = [];
    let cap = row.capBps!;
    if (i.userCapBps !== undefined && Number.isFinite(i.userCapBps)) {
      const chosen = clamp(Math.floor(i.userCapBps), range[0], range[1]);
      if (chosen !== Math.floor(i.userCapBps)) reasons.push(`the chosen fraction is clipped to ${range[0] / 100}–${range[1] / 100} % for this band`);
      cap = chosen;
    }
    if (i.exposureTier === "R4") reasons.push("an unknown or high-risk route: protected execution takes the next healthy route rather than smaller pieces");
    return { capBps: cap, range, reasons };
  }
  const policy = exposurePolicy();
  const row = policy[atLeast(i.tier, "enhanced") ? i.tier : "enhanced"]; // below enhanced the enhanced row still applies (a campaign there is opt-in)
  const base = row.capBps ?? policy.enhanced.capBps!;
  const rowRange = row.range ?? policy.enhanced.range!;
  const tierMax = TIER_RANGES[i.exposureTier][1];
  const reasons: string[] = [];
  // the user may lower the cap anywhere; raise it above the band's default only on an R0 / R1 route, and never above the tier's maximum
  const raiseAllowed = i.exposureTier === "R0" || i.exposureTier === "R1";
  const userMax = Math.min(rowRange[1], raiseAllowed ? rowRange[1] : base, tierMax);
  const range: [number, number] = [Math.min(rowRange[0], userMax), userMax];
  let cap = base;
  if (i.userCapBps !== undefined && Number.isFinite(i.userCapBps)) {
    const chosen = clamp(Math.floor(i.userCapBps), range[0], range[1]);
    if (chosen !== Math.floor(i.userCapBps)) reasons.push(`the chosen fraction is clipped to ${range[0] / 100}–${range[1] / 100} % for this route`);
    cap = chosen;
  }
  if (cap > tierMax) { cap = tierMax; reasons.push(`the route's exposure tier ${i.exposureTier} allows at most ${tierMax / 100} %`); }
  const modeCap = MODE_CAP_BPS[i.mode];
  if (modeCap !== null && cap > modeCap) { cap = modeCap; reasons.push(`${i.mode === "max-safety" ? "Maximum Safety" : i.mode} caps the exposure at ${modeCap / 100} %`); }
  if (i.exposureTier === "R4" && cap > 100) { cap = 100; reasons.push("an unknown or high-risk route is capped at 1 %"); }
  return { capBps: cap, range, reasons };
}

// ---- the market-impact limit (contract §2.3; plan §80–§81) ----------------------------------------------------------

/** A control separate from the exposure cap (lab-calibrated 2026-10-07, scoring.ts IMPACT_CAP_BPS). */
export const IMPACT_LIMIT_BPS = 50;
export type ImpactRemedy = "none" | "reduce-tranche" | "rfq" | "streaming" | "other-venue";

export interface ImpactFacts {
  /** the chosen route's impact scaled to one tranche, bps; null when the provider states none */
  trancheImpactBps: number | null;
  /** halving the piece brings its impact under the limit before the piece reaches the dust floor */
  halvingFits: boolean;
  /** an R1 (signed hard quote) venue quoted the size */
  rfqQuotes: boolean;
  /** the provider offers a streamed plan for the size */
  streamedPlan: boolean;
  /** another venue quoted the size under the limit */
  otherVenues: boolean;
}

/** The first remedy of the plan's §81 list that applies: reduce the tranche, an RFQ venue, a stream, another venue. */
export function impactRemedy(f: ImpactFacts, limit = IMPACT_LIMIT_BPS): ImpactRemedy {
  if (f.trancheImpactBps === null || f.trancheImpactBps <= limit) return "none";
  if (f.halvingFits) return "reduce-tranche";
  if (f.rfqQuotes) return "rfq";
  if (f.streamedPlan) return "streaming";
  if (f.otherVenues) return "other-venue";
  return "reduce-tranche"; // halved as far as it goes; the thin-market finding stays on the Review
}

// ---- velocity (contract §2.4; plan §62) ---------------------------------------------------------------------------

export const VELOCITY_WINDOW_MS = 24 * 3600_000;

/** Whether handing over `nextUsd` now would take the trailing 24 h of hand-overs above the limit; a missing limit never refuses. */
export function velocityExceeded(handOvers: { at: number; usd: number }[], nextUsd: number, maxUsdPer24h: number | undefined, now: number): { exceeded: boolean; usedUsd: number } {
  const usedUsd = handOvers.filter((h) => now - h.at < VELOCITY_WINDOW_MS && h.at <= now).reduce((s, h) => s + h.usd, 0);
  if (maxUsdPer24h === undefined || !Number.isFinite(maxUsdPer24h) || maxUsdPer24h <= 0) return { exceeded: false, usedUsd };
  return { exceeded: usedUsd + nextUsd > maxUsdPer24h, usedUsd };
}
