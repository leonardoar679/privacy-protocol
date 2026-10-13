// The operation contract (doc §37–§41; spec v2.0 §12): ONE state vocabulary for the wallet and the API. The doc's
// fifteen states plus CANCELLED (abandoning before money moves is not a failure). The wallet adopts it in V6 Stage 8
// (its records upgrade from the V5 names on read); until then this is the frozen target.

export const OPERATION_STATES = [
  "DRAFT",
  "QUOTING",
  "REVIEW",
  "AWAITING_SIGNATURE",
  "SIGNED",
  "SUBMITTED",
  "CONFIRMING",
  "EXECUTING",
  "SETTLING",
  "COMPLETED",
  "QUOTE_EXPIRED",
  "FAILED",
  "RECOVERY_REQUIRED",
  "REFUNDING",
  "REFUNDED",
  "CANCELLED",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** A terminal state never changes (I-O1). */
export const TERMINAL_STATES: readonly OperationState[] = ["COMPLETED", "REFUNDED", "CANCELLED", "FAILED"];
/** In memory only: a record is journaled from AWAITING_SIGNATURE. */
export const DRAFT_STATES: readonly OperationState[] = ["DRAFT", "QUOTING", "REVIEW"];

/** Where the money is, derived from the legs of a swap (doc §41): the recovery path follows it. */
export const SETTLEMENT_STATES = ["SOURCE_CONFIRMED", "PROVIDER_PENDING", "DESTINATION_PENDING", "REFUND_AVAILABLE", "REFUNDING", "COMPLETED"] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/** What a failure means for the funds (the first sentence the user reads). */
export type FundsClass = "not-moved" | "still-protected" | "unknown";

export type OperationKind = "protect" | "send" | "withdraw" | "swap" | "cross-chain" | "classic-deposit" | "classic-withdraw";
