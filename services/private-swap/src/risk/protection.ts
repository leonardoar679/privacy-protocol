// The protection recommendation (High-Value Protection spec §10, §14): from a competition's quotes, the request, the
// tier and the mode — the route's risk class and gate, the tranche band and the cap, sequential or parallel release,
// the estimated steps and time, the thin-market flag, provider concentration, ELPF, and whether a $100K–$1M order
// should be staged. It is advice computed with the shared core (reference/typescript/src/wallet/campaign.ts): the
// wallet recomputes its own bounds and accounting from the same code. Stateless: nothing here remembers a user.
import { planTranches, type Gate, type ProtectionMode, type RiskClass, type Sizing } from "../../../../reference/typescript/src/wallet/campaign";
import { expectedLossPerFailure, narrowedBand, riskModelOf, type RiskModel } from "../../../../reference/typescript/src/wallet/riskClasses";
import { atLeast, type Tier } from "../../../../reference/typescript/src/wallet/valuation";
import { capBpsFor as policyCap, exposureTierOf, impactRemedy as remedyOf, type ExposureTier, type ImpactRemedy } from "../../../../reference/typescript/src/wallet/exposurePolicy";
import { chainHalted } from "../health";
import type { QuoteSet } from "../engine";
import type { ProviderHealthTracker } from "../health";
import { reliabilityScore } from "../health";
import { IMPACT_CAP_BPS } from "../scoring";
import type { ProviderId, QuoteRequest } from "../types";
import { daysSinceIncident, securityBreakdown, type SecurityBreakdown } from "./security";
import { riskDb, type Incident, type RiskDb } from "./riskDb";

export const CADENCE_SECONDS: Record<ProtectionMode, [number, number]> = { balanced: [600, 5400], "max-privacy": [1800, 21600], "max-safety": [600, 3600], "best-execution": [600, 3600] }; // lab-calibrated (Stage 2); best-execution (V4): the shortest window
export const EXECUTE_WINDOW_SECONDS = 7200;
export const FINALITY_MARGIN: Record<string, number> = { bitcoin: 3600, solana: 60, default: 900 };
export const PROVIDER_SHARE_CAP_BPS = 3000; // plan §46 (V4): at ≥ $5M with two or more venues, no provider above 30 % of the order

export interface Protection {
  provider: ProviderId;
  riskClass: RiskClass;
  flags: RiskClass[];
  custody: string;
  bandBps: [number, number];
  capBps: number;
  sizing: Sizing;
  concurrency: "sequential" | "parallel";
  maxParallel: number;
  gate: Gate;
  cadenceSeconds: [number, number];
  providerShareCapBps: number;
  executeWindowSeconds: number;
  estimatedTranches: number;
  estimatedSeconds: number;
  /** the smallest and largest piece in USD, when the order is valued */
  trancheUsd: [number, number] | null;
  capUsd: number | null;
  /** the chosen quote's impact scaled to one tranche, bps; null when the provider states none */
  trancheImpactBps: number | null;
  thinMarket: boolean;
  /** the ceiling a piece got from the thin-market rule or the provider's instant limit (base units), or null */
  maxPieceUnits: string | null;
  concentration: { providers: { id: ProviderId; shareBps: number }[]; singleVenue: boolean; capBps: number };
  elpf: { prior: number; pFailure: number; perTrancheUsd: number | null; perCampaignUsd: number | null };
  /** $100K–$1M: stage the order although the tier does not require it (a single venue with high impact or low reliability) */
  staged: boolean;
  reasons: string[];
  // V4 (contract §2.2–§2.3, §3.4)
  /** the route's exposure tier, derived from the risk model and the live facts, and why */
  exposureTier: ExposureTier;
  exposureReasons: string[];
  /** the market-impact remedy applied (plan §81) */
  impactRemedy: ImpactRemedy;
  /** the plan's §26 ledger before anything is funded, base units */
  ledgerPreview: { totalOrderValue: string; maxExternalExposure: string; firstTranche: string };
}

export interface ProviderRisk { model: RiskModel; security: SecurityBreakdown; incidents: Incident[]; reliability: number | null }

const bps = (x: bigint, b: number): bigint => (x * BigInt(b)) / 10000n;
const unitsToUsd = (units: bigint, decimals: number, usdPerUnit: number): number => (Number(units / 10n ** BigInt(Math.max(0, decimals - 6))) / 10 ** Math.min(6, decimals)) * usdPerUnit;

/** The cap of contract §2 (plan §4, §6, §90): the band's default, the exposure tier's maximum and the mode's ceiling (the user's fraction is applied by the wallet). */
export function capBpsFor(tier: Tier, mode: ProtectionMode, exposureTier: ExposureTier = "R3"): number { return policyCap({ tier, mode, exposureTier }).capBps; }

/** The risk view of every provider that quoted (for the Review's "Why" and the route health score). */
export function providerRisks(set: QuoteSet, req: QuoteRequest, mode: ProtectionMode, db: RiskDb = riskDb(), now = Date.now(), tracker?: ProviderHealthTracker): Partial<Record<ProviderId, ProviderRisk>> {
  const out: Partial<Record<ProviderId, ProviderRisk>> = {};
  for (const q of set.quotes) {
    const pair = `${req.from.symbol}>${req.to.symbol}`;
    const model = riskModelOf(q.provider, { plan: q.plan, sourceSwap: q.hops.length > 1 }, req.from, req.to, mode, db.override(q.provider, pair));
    const security = securityBreakdown(q.provider, now, db);
    const h = set.health[q.provider];
    out[q.provider] = { model, security, incidents: security.incidentList, reliability: h ? reliabilityScore(h, [req.from.chain, req.to.chain]) : null };
  }
  return out;
}

/**
 * The recommendation for the chosen route; null when nothing was chosen. `usdPerUnit` values the source asset (the
 * service's own read); `amount` is the gross order (the private withdrawal), the same the tranches are cut from.
 */
export function recommendProtection(o: { set: QuoteSet; req: QuoteRequest; amount: bigint; tier: Tier; mode: ProtectionMode; usdPerUnit: number | null; db?: RiskDb; tracker?: ProviderHealthTracker; now?: number; rng?: () => number }): Protection | null {
  const chosen = o.set.chosen ? o.set.quotes.find((q) => q.provider === o.set.chosen!.provider) : undefined;
  if (!chosen) return null;
  const db = o.db ?? riskDb();
  const now = o.now ?? Date.now();
  const risks = providerRisks(o.set, o.req, o.mode, db, now, o.tracker);
  const mine = risks[chosen.provider]!;
  const model = mine.model;
  const reasons: string[] = [];
  const incidentDays = daysSinceIncident(chosen.provider, now, db);
  const failures = o.tracker?.failures(chosen.provider, now).windowCount ?? 0;
  const band0 = narrowedBand(model, { security: mine.security.total, breakerOpenedRecently: failures >= 3, incidentWithinDays: incidentDays });
  if (band0[1] < model.bandBps[1]) reasons.push("the band is narrowed to its lower edge: the provider's security score, breaker or a recent incident");
  // the exposure tier (contract §2.2) from the class and the live facts; a thin market is judged at the band's own cap
  const health = o.set.health[chosen.provider];
  const baseCap = capBpsFor(o.tier, o.mode, "R3");
  const rawImpact = chosen.impactBps !== undefined ? chosen.impactBps * (baseCap / 10000) : null;
  const breakerOpen = failures >= 3 || !!o.tracker?.breakerOpen(chosen.provider, now);
  const xt = exposureTierOf(model, { planMode: chosen.plan?.mode, thinMarket: rawImpact !== null && rawImpact > IMPACT_CAP_BPS, knownProvider: db.providerRisk(chosen.provider) !== null, chainHalted: health ? health.halted || chainHalted(health, [o.req.from.chain, o.req.to.chain]) !== null : false, incidentWithinDays: incidentDays, breakerOpen, security: mine.security.total });
  if (xt.tier === "R4") reasons.push(`an unknown or high-risk route (${xt.reasons.join("; ")}): the exposure is capped at 1 %`);
  const capBps = capBpsFor(o.tier, o.mode, xt.tier);
  let band: [number, number] = atLeast(o.tier, "institutional") ? [Math.min(200, capBps), Math.min(250, capBps)] : [Math.min(band0[0], capBps), Math.min(band0[1], capBps)];
  if (band[0] > band[1]) band = [band[1], band[1]];
  if (o.tier === "large-protected") band = [capBps, capBps]; // V5 (spec §11): exact pieces of the cap — four sequential steps of 25 %
  const sequential = o.mode === "max-safety" || o.tier === "large-protected" || atLeast(o.tier, "institutional") || model.class === "R5" || model.class === "R6";
  if (model.class === "R5" || model.class === "R6") reasons.push("a bridge / MPC / counterparty route runs one piece at a time (sequential safety mode)");
  const sizing: Sizing = o.mode === "max-privacy" ? "bucket" : "varied";
  const gate = o.mode === "max-safety" ? "destination-final" : model.gate;
  // the thin-market rule and the provider's instant limit cap the piece
  const capUnits = bps(o.amount, capBps);
  let maxPiece: bigint | null = null;
  if (chosen.limits?.maxInstant !== undefined && chosen.limits.maxInstant < capUnits) { maxPiece = chosen.limits.maxInstant; reasons.push("pieces stay under the provider's instant limit"); }
  const capFraction = capBps / 10000;
  let trancheImpactBps: number | null = chosen.impactBps !== undefined ? Math.max(0, Math.round(chosen.impactBps * capFraction * 100) / 100) : null;
  let thinMarket = false;
  let halvingFits = false;
  if (trancheImpactBps !== null && trancheImpactBps > IMPACT_CAP_BPS) {
    let piece = maxPiece ?? capUnits;
    let impact = trancheImpactBps;
    while (impact > IMPACT_CAP_BPS && piece > 1n) { piece /= 2n; impact /= 2; }
    maxPiece = piece; halvingFits = impact <= IMPACT_CAP_BPS; trancheImpactBps = Math.round(impact * 100) / 100; thinMarket = true;
    reasons.push("thin market: the piece is halved until its impact fits under the cap");
  }
  // the remedy applied (plan §81, contract §2.3): reduce the tranche, an RFQ venue (none today), a stream, another venue
  const othersUnderLimit = o.set.quotes.some((x) => x.provider !== chosen.provider && !o.set.scores.find((s) => s.provider === x.provider)?.filtered && (x.impactBps ?? 0) * capFraction <= IMPACT_CAP_BPS);
  const impactRemedy = remedyOf({ trancheImpactBps: rawImpact === null ? null : Math.round(rawImpact * 100) / 100, halvingFits, rfqQuotes: false, streamedPlan: !!chosen.plan && chosen.plan.mode !== "single", otherVenues: othersUnderLimit });
  const split = planTranches(o.amount, { decimals: o.req.from.decimals, bandBps: band, capBps, sizing, maxParallel: sequential ? 1 : 2, maxPiece: maxPiece ?? undefined, rng: o.rng ?? Math.random, exact: o.tier === "large-protected" });
  const pieces = split.pieces;
  const steps = pieces.length;
  const largest = pieces.length ? pieces.reduce((m, p) => (p > m ? p : m), 0n) : 0n;
  const smallest = pieces.length ? pieces.reduce((m, p) => (p < m ? p : m), pieces[0]) : 0n;
  // the time per step: the stream scales with the piece (never under 10 min), a single execution keeps its ETA; then the delivered margin and the cadence
  const scaled = chosen.plan && chosen.plan.mode !== "single" && o.amount > 0n ? Math.max(600, (chosen.etaSeconds * Number(largest / 10n ** BigInt(Math.max(0, o.req.from.decimals - 6)))) / Math.max(1, Number(o.amount / 10n ** BigInt(Math.max(0, o.req.from.decimals - 6))))) : chosen.etaSeconds;
  const margin = gate === "destination-final" ? (FINALITY_MARGIN[o.req.to.chain] ?? FINALITY_MARGIN.default) : 0;
  const cadence = CADENCE_SECONDS[o.mode];
  const perStep = scaled + 60 + margin + (cadence[0] + cadence[1]) / 2;
  const estimatedSeconds = Math.round((steps * perStep) / (sequential ? 1 : 2));
  // concentration: the venues that quoted this size
  const quoted = o.set.scores.filter((s) => !s.filtered).map((s) => s.provider);
  const singleVenue = quoted.length < 2;
  const shareCap = !singleVenue && atLeast(o.tier, "high-value-secondary") ? PROVIDER_SHARE_CAP_BPS : 10000;
  if (singleVenue && atLeast(o.tier, "high-value")) reasons.push("single venue: only one provider quotes this size, so nothing is diversified for appearance");
  const usd = (u: bigint) => (o.usdPerUnit === null ? null : unitsToUsd(u, o.req.from.decimals, o.usdPerUnit));
  const trancheUsd = o.usdPerUnit === null || !pieces.length ? null : ([usd(smallest)!, usd(largest)!] as [number, number]);
  const capUsd = usd(capUnits);
  const incidentFactor = incidentDays !== null && incidentDays <= 90 ? 1.5 : 1;
  const e1 = expectedLossPerFailure({ pFailPrior: model.pFailPrior, failuresInWindow: failures, incidentFactor, exposed: trancheUsd ? trancheUsd[1] : 0 });
  const e2 = expectedLossPerFailure({ pFailPrior: model.pFailPrior, failuresInWindow: failures, incidentFactor, exposed: capUsd ?? 0 });
  const reliability = mine.reliability;
  const staged = (o.tier === "enhanced" || o.tier === "large-protected") && singleVenue && ((chosen.impactBps ?? 0) > IMPACT_CAP_BPS || (reliability !== null && reliability < 60));
  if (staged) reasons.push("staged below $1M: the only venue quotes with high impact or low reliability");
  return {
    provider: chosen.provider, riskClass: model.class, flags: model.flags, custody: model.custody, bandBps: band, capBps, sizing,
    concurrency: sequential ? "sequential" : "parallel", maxParallel: sequential ? 1 : 2, gate, cadenceSeconds: cadence, providerShareCapBps: shareCap,
    executeWindowSeconds: o.tier === "large-protected" ? Math.min(EXECUTE_WINDOW_SECONDS, 1800) : EXECUTE_WINDOW_SECONDS, estimatedTranches: steps, estimatedSeconds, trancheUsd, capUsd, trancheImpactBps, thinMarket, // V5: a strict window at the $50K band
    maxPieceUnits: maxPiece === null ? null : maxPiece.toString(),
    concentration: { providers: quoted.map((id) => ({ id, shareBps: Math.floor(10000 / Math.max(1, quoted.length)) })), singleVenue, capBps: shareCap },
    elpf: { prior: model.pFailPrior, pFailure: e1.pFailure, perTrancheUsd: trancheUsd ? e1.expectedLoss : null, perCampaignUsd: capUsd === null ? null : e2.expectedLoss },
    staged, reasons,
    exposureTier: xt.tier, exposureReasons: xt.reasons, impactRemedy,
    ledgerPreview: { totalOrderValue: o.amount.toString(), maxExternalExposure: capUnits.toString(), firstTranche: (pieces[0] ?? 0n).toString() },
  };
}

/** For the quote set: the recommendation and the risk view, from the enhanced tier up (V2 §13). */
export function protectionFor(set: QuoteSet, req: QuoteRequest, amount: bigint, tier: Tier | undefined, mode: ProtectionMode, usdPerUnit: number | null, tracker?: ProviderHealthTracker, db: RiskDb = riskDb()): { protection?: Protection; risk?: Partial<Record<ProviderId, ProviderRisk>> } {
  if (!tier || !atLeast(tier, "large-protected")) return {}; // V5 (spec §11): from the $50K band
  const risk = providerRisks(set, req, mode, db, Date.now(), tracker);
  const protection = recommendProtection({ set, req, amount, tier, mode, usdPerUnit, db, tracker });
  return { ...(protection ? { protection } : {}), risk };
}

