// The operation contract (doc V1.1 §11, doc V1 §37–§41; spec v3.0 §6; V7 Stage 15): ONE state vocabulary for the wallet and
// the API — the document's fifteen states, exactly. The V6 names (spec v2.0 §12.1: sixteen, with QUOTE_EXPIRED and one state
// for the signature and the proof) upgrade on read in the wallet (packages/sdk/src/operations/upgrade.ts, `v: 3`) and in place
// in the API (apps/api/src/db.ts, migration 3); the crosswalk below names the renames, the record-dependent ones are the upgrade's.

export const OPERATION_STATES = [
  "DRAFT",
  "QUOTING",
  "READY_TO_REVIEW",
  "AWAITING_AUTHORIZATION",
  "PREPARING_PROOF",
  "SUBMITTING",
  "SOURCE_CONFIRMING",
  "PROVIDER_EXECUTING",
  "DESTINATION_CONFIRMING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "RECOVERY_REQUIRED",
  "REFUNDING",
  "REFUNDED",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** A terminal state never changes (I-O1). */
export const TERMINAL_STATES: readonly OperationState[] = ["COMPLETED", "REFUNDED", "CANCELLED", "FAILED"];
/** In memory only: a record is journaled from AWAITING_AUTHORIZATION. */
export const DRAFT_STATES: readonly OperationState[] = ["DRAFT", "QUOTING", "READY_TO_REVIEW"];

/** The V6 vocabulary (spec v2.0 §12.1) that stored records and the API's rows upgrade from (V7 Stage 15). */
export const OPERATION_STATES_V2 = [
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
export type OperationStateV2 = (typeof OPERATION_STATES_V2)[number];
/**
 * The V6 → V7 renames (spec v3.0 §6). The record decides two of them, in the upgrade: AWAITING_SIGNATURE is PREPARING_PROOF at
 * the witness / proof / local-verify step and SUBMITTING at the submitting step — a Protect's record excepted, whose step is
 * the external wallet's prompt (its plain rename, AWAITING_AUTHORIZATION, is here); QUOTE_EXPIRED is READY_TO_REVIEW with `quote_expired` before the funding and RECOVERY_REQUIRED with `minimum_moved`
 * after it (not here).
 */
export const STATE_CROSSWALK_V2: Readonly<Partial<Record<OperationStateV2, OperationState>>> = {
  REVIEW: "READY_TO_REVIEW",
  AWAITING_SIGNATURE: "AWAITING_AUTHORIZATION",
  SIGNED: "SUBMITTING",
  SUBMITTED: "SOURCE_CONFIRMING",
  CONFIRMING: "SOURCE_CONFIRMING",
  EXECUTING: "PROVIDER_EXECUTING",
  SETTLING: "DESTINATION_CONFIRMING",
};

/** Where the money is, derived from the legs of a swap (doc §41): the recovery path follows it. */
export const SETTLEMENT_STATES = ["SOURCE_CONFIRMED", "PROVIDER_PENDING", "DESTINATION_PENDING", "REFUND_AVAILABLE", "REFUNDING", "COMPLETED"] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/** What a failure means for the funds (the first sentence the user reads). */
export type FundsClass = "not-moved" | "still-protected" | "unknown";

export type OperationKind = "protect" | "send" | "withdraw" | "swap" | "cross-chain" | "classic-deposit" | "classic-withdraw";
