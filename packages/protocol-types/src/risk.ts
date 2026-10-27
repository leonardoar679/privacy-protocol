// The risk assessment and the automatic blockers (doc §47–§48; spec v2.0 §13.4). One blocker stops the operation before
// a signature: "We stopped this transaction … Your funds have not moved."

export type RiskLevel = "low" | "medium" | "high";

export const BLOCKER_CODES = [
  "quote_expired",
  "asset_unsupported",
  "destination_invalid",
  "provider_unhealthy",
  "minimum_below_limit",
  "parameters_changed",
  "network_mismatch",
  "unsafe_contract_call",
  // V7 Stage 13 (spec v3.0 §4): the $50K–$100K band's exposure limit and the route's liquidity qualification
  "in_flight_limit",
  "route_not_qualified",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

export interface RiskAssessment {
  /** 0 (no concern) … 100 */
  score: number;
  level: RiskLevel;
  blockers: BlockerCode[];
  warnings: string[];
}
