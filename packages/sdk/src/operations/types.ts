// The operation vocabulary of the screens (spec §12): the record and its constants from the wallet layer, and the
// events the reducer consumes. One module re-exports both so a feature imports from one place.
import type { FundsClass, OperationState, ProgressStep, SettlementRef } from "../wallet/operationRecord";

export type { DestinationKind, FeeLine, FundsClass, OperationKind, OperationPhase, OperationRecord, OperationState, ProgressStep, RecoveryState, SettlementRef } from "../wallet/operationRecord";
export { DRAFT_STATES, FAILURE_STATES, OPERATION_STATES, PROGRESS_STATES, TERMINAL_STATES, isDraft, isFailure, isOpen, isTerminal } from "../wallet/operationRecord";

/** The references an event may carry into the record. */
export interface EventRefs { txHash?: string; jobId?: string; orderId?: string; campaignId?: string; executionTx?: string; executionRef?: string; quoteId?: string; provider?: string; activityId?: string }

/** What moves a record (the reducer's input); every failure event names a catalog code or gets the event's default. */
export type OperationEvent =
  | { type: "quote" }
  | ({ type: "quoted"; expectedOutput?: string; minimumOutput?: string } & EventRefs)
  | { type: "review" }
  | { type: "edit" }
  | { type: "confirm"; checklist?: { destination: boolean; route: boolean; execution: boolean; limits: boolean } }
  | { type: "progress"; step: ProgressStep; i?: number; n?: number }
  | ({ type: "signed" } & EventRefs)
  | ({ type: "submitted"; by?: "relayer" | "wallet" } & EventRefs)
  | ({ type: "relayer-executing" } & EventRefs)
  | ({ type: "confirming" } & EventRefs)
  | ({ type: "verifying" } & EventRefs)
  | ({ type: "completed"; ref: SettlementRef; delivered?: string } & EventRefs)
  | { type: "quote-expired"; code?: string; detail?: string }
  | { type: "rejected"; code?: string; detail?: string }
  | ({ type: "submission-failed"; code: string; detail?: string } & EventRefs)
  | ({ type: "delayed"; code?: string; detail?: string } & EventRefs)
  | ({ type: "provider-failed"; code: string; detail?: string } & EventRefs)
  | ({ type: "recovery-required"; code: string; detail?: string } & EventRefs)
  | ({ type: "refunding" } & EventRefs)
  | ({ type: "refunded"; ref: SettlementRef; refunded?: string } & EventRefs)
  | { type: "cancel"; note?: string }
  /** a post-signature return to an open state (a campaign resuming after a requote, a tracked resume that found the transaction) */
  | ({ type: "resume"; to: OperationState } & EventRefs)
  | { type: "monitor"; at?: number }
  | { type: "note"; note: string };

export type OperationEventType = OperationEvent["type"];

export interface TransitionOk { ok: true; record: import("../wallet/operationRecord").OperationRecord; changed: boolean }
export interface TransitionRefused { ok: false; record: import("../wallet/operationRecord").OperationRecord; reason: "terminal" | "not-allowed" | "needs-settlement-ref" | "needs-code" }
export type TransitionResult = TransitionOk | TransitionRefused;

/** The words of a failure's first sentence, by class (spec §13). */
export const FUNDS_HEADLINE_KEY: Record<FundsClass, "op.funds.notMoved" | "op.funds.stillProtected" | "op.funds.unknown"> = { "not-moved": "op.funds.notMoved", "still-protected": "op.funds.stillProtected", unknown: "op.funds.unknown" };

/** What a failed or delayed operation offers; a retry is a new quote or a tracked resume, never a re-send of the same transaction. */
export type RecoveryAction = "edit" | "review" | "new-quote" | "wait" | "resume-tracking" | "continue-monitoring" | "start-refund" | "check-wallet" | "check-settings" | "housekeeping";

export const STATE_EVENT_TARGET: Record<OperationEventType, OperationState | null> = {
  quote: "QUOTING", quoted: "QUOTE_READY", review: "REVIEW", edit: "DRAFT", confirm: "AWAITING_SIGNATURE", progress: null, signed: "SIGNED", submitted: "SUBMITTED",
  "relayer-executing": "RELAYER_EXECUTING", confirming: "NETWORK_CONFIRMING", verifying: "SETTLEMENT_VERIFYING", completed: "COMPLETED", "quote-expired": "QUOTE_EXPIRED",
  rejected: "SIGNATURE_REJECTED", "submission-failed": "SUBMISSION_FAILED", delayed: "NETWORK_DELAYED", "provider-failed": "PROVIDER_FAILED", "recovery-required": "RECOVERY_REQUIRED",
  refunding: "REFUNDING", refunded: "REFUNDED", cancel: "CANCELLED", resume: null, monitor: null, note: null,
};
