// The risk assessment (doc §47–§48; spec v2.0 §13.4): assessRisk(facts) composes the provider's health, the quote's age,
// the route's liquidity, the destination check, the slippage and price impact, the execution's complexity, the network's
// status, the provider's recent failures and the large-trade status into {score, level, blockers, warnings}. Pure: the
// wallet and the API gather the facts; the wallet re-runs it between the Review and every signature, and one blocker
// stops the operation before anything moves ("We stopped this transaction … Your funds have not moved.").
// The warnings are codes (WARNING_CODES): the words belong to the app's catalog.
import { BLOCKER_CODES, type AssetStatus, type BlockerCode, type RiskAssessment, type RiskLevel } from "@privacy-wallet/protocol-types";

export { BLOCKER_CODES, type BlockerCode, type RiskAssessment, type RiskLevel };

export const WARNING_CODES = [
  "quote_aging",
  "low_liquidity",
  "high_impact",
  "high_slippage",
  "multi_step",
  "cross_chain",
  "network_busy",
  "provider_failures",
  "large_trade",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface RiskFacts {
  /** when the check runs (ms since the epoch) */
  now: number;
  quote: {
    /** when it was fetched and when it expires (ms since the epoch) */
    fetchedAt: number;
    expiresAt: number;
    /** the minimum the route guarantees and the minimum the user approved, in the destination's base units */
    minimumOut: bigint;
    approvedMinimum: bigint;
    /** price impact and the slippage allowance, in basis points */
    impactBps: number;
    slippageBps: number;
    /** the order's parameters are the ones the user reviewed (amount, assets, destination, deadlines) */
    parametersMatch: boolean;
  };
  asset: { status: AssetStatus };
  destination: { valid: boolean };
  provider: {
    healthy: boolean;
    /** failures in the provider's recent window (the API's provider_health) */
    recentFailures: number;
    /** the route's depth in USD, when the provider states it */
    liquidityUsd?: number;
  };
  network: { expectedChainId: number; chainId: number | null; busy?: boolean };
  /** the wallet's own check of the provider call it is about to sign (packages/sdk/src/providerCall.ts) */
  call?: { verified: boolean };
  execution: { steps: number; crossChain: boolean };
  /** the operation's value in USD, when priced */
  usd?: number;
  /** $50K and above: the automatic protection (doc §49) */
  largeTrade: boolean;
}

/** The level of a 0–100 score: high from 60, medium from 30. */
export const riskLevelOf = (score: number): RiskLevel => (score >= 60 ? "high" : score >= 30 ? "medium" : "low");

/** The blockers among the facts, in the order of BLOCKER_CODES. */
export function blockersOf(f: RiskFacts): BlockerCode[] {
  const hit: Record<BlockerCode, boolean> = {
    quote_expired: f.now >= f.quote.expiresAt,
    asset_unsupported: f.asset.status !== "supported",
    destination_invalid: !f.destination.valid,
    provider_unhealthy: !f.provider.healthy,
    minimum_below_limit: f.quote.minimumOut < f.quote.approvedMinimum,
    parameters_changed: !f.quote.parametersMatch,
    network_mismatch: f.network.chainId !== null && f.network.chainId !== f.network.expectedChainId,
    unsafe_contract_call: f.call !== undefined && !f.call.verified,
  };
  return BLOCKER_CODES.filter((c) => hit[c]);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Each concern's share of the score (they sum to at most 100) and the warning it raises. */
function concerns(f: RiskFacts): { code: WarningCode; points: number }[] {
  const out: { code: WarningCode; points: number }[] = [];
  const window = f.quote.expiresAt - f.quote.fetchedAt;
  const used = window > 0 ? clamp((f.now - f.quote.fetchedAt) / window, 0, 1) : 1;
  if (used >= 0.5) out.push({ code: "quote_aging", points: Math.round(15 * used) });
  if (f.provider.liquidityUsd !== undefined && f.usd !== undefined && f.provider.liquidityUsd > 0) {
    const share = f.usd / f.provider.liquidityUsd;
    if (share >= 0.02) out.push({ code: "low_liquidity", points: Math.round(15 * clamp(share / 0.1, 0, 1)) });
  }
  if (f.quote.impactBps >= 50) out.push({ code: "high_impact", points: Math.round(15 * clamp(f.quote.impactBps / 300, 0, 1)) });
  if (f.quote.slippageBps > 100) out.push({ code: "high_slippage", points: Math.round(10 * clamp(f.quote.slippageBps / 300, 0, 1)) });
  if (f.execution.steps > 1) out.push({ code: "multi_step", points: Math.min(10, 5 * (f.execution.steps - 1)) });
  if (f.execution.crossChain) out.push({ code: "cross_chain", points: 10 });
  if (f.network.busy) out.push({ code: "network_busy", points: 5 });
  if (f.provider.recentFailures > 0) out.push({ code: "provider_failures", points: Math.min(10, 5 * f.provider.recentFailures) });
  if (f.largeTrade) out.push({ code: "large_trade", points: 10 });
  return out;
}

/** The assessment: any blocker makes the score 100 and the level high; otherwise the concerns' points decide it. */
export function assessRisk(f: RiskFacts): RiskAssessment {
  const blockers = blockersOf(f);
  const found = concerns(f);
  const score = blockers.length
    ? 100
    : clamp(
        found.reduce((s, c) => s + c.points, 0),
        0,
        100,
      );
  return { score, level: riskLevelOf(score), blockers, warnings: found.map((c) => c.code) };
}
