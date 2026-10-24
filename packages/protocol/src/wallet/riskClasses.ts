// Risk classes (spec V3 §2): every route of a large order is classified before anything is funded — the class
// decides the default tranche band, the settlement gate (§6) and the prior failure probability of ELPF (§10).
// The defaults here describe the providers as they are built today (their custody model is what the adapter
// specs of V2 §6–§11 state); the service's risk database (§10) can override any field per provider or route,
// and the lab calibrates the priors and the bands. Pure: the wallet, the service and the labs agree.
import type { Gate, ProtectionMode, RiskClass } from "./campaign";
import { gateFor } from "./campaign";

export type Custody = "tss-vaults" | "mpc-vault" | "relayer-bridge" | "cctp" | "solver" | "aggregator" | "intent" | "contract" | "counterparty";

export interface RiskModel {
  /** the carrying class (R1, R2, R4, R5, R6): the highest-risk class among the route's legs */
  class: RiskClass;
  /** R3 (a source swap before the bridge) and R7 (an issuer-controlled asset on a leg) are flags on top */
  flags: RiskClass[];
  custody: Custody;
  gate: Gate;
  /** the prior probability that one external execution fails to settle as quoted (lab-calibrated) */
  pFailPrior: number;
  /** the default tranche band, bps of the order */
  bandBps: [number, number];
}

export interface RiskModelOverride { class?: RiskClass; custody?: Custody; pFailPrior?: number; bandBps?: [number, number]; gate?: Gate }

const BAND_R5: [number, number] = [100, 250];
const BAND_R2: [number, number] = [200, 300];

/** The provider defaults (plan V3 §5–§11; the custody model from V2 §6–§11). */
export const PROVIDER_RISK: Record<string, { class: RiskClass; custody: Custody; pFailPrior: number; bandBps: [number, number] }> = {
  thorchain: { class: "R5", custody: "tss-vaults", pFailPrior: 0.02, bandBps: BAND_R5 },
  chainflip: { class: "R5", custody: "mpc-vault", pFailPrior: 0.02, bandBps: BAND_R5 },
  "uniswap-across": { class: "R5", custody: "relayer-bridge", pFailPrior: 0.015, bandBps: BAND_R5 },
  lifi: { class: "R5", custody: "aggregator", pFailPrior: 0.02, bandBps: BAND_R5 },
  mayan: { class: "R5", custody: "cctp", pFailPrior: 0.015, bandBps: BAND_R5 },
  "near-intents": { class: "R2", custody: "intent", pFailPrior: 0.03, bandBps: BAND_R2 },
  "uniswapx": { class: "R2", custody: "solver", pFailPrior: 0.02, bandBps: BAND_R2 },
  otc: { class: "R6", custody: "counterparty", pFailPrior: 0.05, bandBps: BAND_R5 },
};

export const ISSUER_CONTROLLED = new Set(["USDC", "USDT"]);

/**
 * When an incident happened (audit round 2, n07): a date by day — the risk database's own format, "2026-10-22" — is the whole
 * of that day (UTC), a time is its instant. Read as its day's midnight, a day-dated incident had opened a breaker only until the
 * next midnight, not at all when recorded the day after, and an incident dated the day an operation started read as before it.
 */
export function incidentSpan(date: string): { from: number; to: number } | null {
  const at = Date.parse(date);
  if (!Number.isFinite(at)) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? { from: at, to: at + 86_400_000 - 1 } : { from: at, to: at };
}

export interface QuoteShape { plan?: { mode: string } | null; /** the route swaps on the source chain before bridging (the Across swap leg, a LI.FI source swap) */ sourceSwap?: boolean; nativeAssets?: boolean }

/**
 * The risk model of a quoted route: the provider's class (Mayan's SWIFT auction is R2 solver execution, its
 * Fast-MCTP path R5 through CCTP), R3 when the route swaps before it bridges, R7 when either leg is an
 * issuer-controlled asset, the gate of the class under the mode, and the band — all overridable by the database.
 */
export function riskModelOf(provider: string, quote: QuoteShape, from: { symbol: string }, to: { symbol: string }, mode: ProtectionMode = "balanced", db?: RiskModelOverride | null): RiskModel {
  let base = PROVIDER_RISK[provider] ?? { class: "R5" as RiskClass, custody: "relayer-bridge" as Custody, pFailPrior: 0.03, bandBps: BAND_R5 };
  if (provider === "mayan" && quote.plan?.mode === "auction") base = { ...base, class: "R2", custody: "solver", bandBps: BAND_R2 };
  const cls = db?.class ?? base.class;
  const flags: RiskClass[] = [];
  if (quote.sourceSwap) flags.push("R3");
  if (ISSUER_CONTROLLED.has(from.symbol.toUpperCase()) || ISSUER_CONTROLLED.has(to.symbol.toUpperCase())) flags.push("R7");
  return {
    class: cls,
    flags,
    custody: db?.custody ?? base.custody,
    gate: db?.gate ?? gateFor(cls, mode),
    pFailPrior: db?.pFailPrior ?? base.pFailPrior,
    bandBps: db?.bandBps ?? base.bandBps,
  };
}

/** The band narrows to its lower edge for a provider with a low security score, an open breaker or a recent incident (§2). */
export function narrowedBand(model: RiskModel, facts: { security?: number; breakerOpenedRecently?: boolean; incidentWithinDays?: number | null }): [number, number] {
  const weak = (facts.security !== undefined && facts.security < 70) || facts.breakerOpenedRecently === true || (facts.incidentWithinDays !== null && facts.incidentWithinDays !== undefined && facts.incidentWithinDays <= 30);
  return weak ? [model.bandBps[0], model.bandBps[0]] : model.bandBps;
}

/** ELPF (§10): the expected loss of one failure, in the unit of `exposed`. */
export function expectedLossPerFailure(o: { pFailPrior: number; failuresInWindow?: number; incidentFactor?: number; exposed: number }): { pFailure: number; expectedLoss: number } {
  const p = Math.min(1, o.pFailPrior * (1 + (o.failuresInWindow ?? 0) / 3) * (o.incidentFactor ?? 1));
  return { pFailure: p, expectedLoss: p * o.exposed };
}
