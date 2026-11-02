// The operation vocabulary of the screens (spec §12): the record and its constants from the wallet layer, and the
// events the reducer consumes. One module re-exports both so a feature imports from one place.
import type { FundsClass, OperationCosts, OperationRecord, OperationState, ProgressStep, SettlementRef, SettlementState } from "../wallet/operationRecord";

export type {
  DestinationKind,
  FeeLine,
  FundsClass,
  OperationKind,
  OperationPhase,
  OperationReason,
  OperationRecord,
  OperationState,
  ProgressStep,
  RecoveryState,
  SettlementRef,
  SettlementState,
} from "../wallet/operationRecord";
export {
  DRAFT_STATES,
  FAILURE_STATES,
  OPERATION_STATES,
  PRE_SUBMISSION_STATES,
  PROGRESS_STATES,
  SETTLEMENT_STATES,
  SUBMITTED_STATES,
  TERMINAL_STATES,
  isDraft,
  isFailure,
  isOpen,
  isTerminal,
  wasSubmitted,
} from "../wallet/operationRecord";

/** The references an event may carry into the record. */
export interface EventRefs {
  txHash?: string;
  jobId?: string;
  orderId?: string;
  campaignId?: string;
  executionTx?: string;
  executionRef?: string;
  quoteId?: string;
  provider?: string;
  activityId?: string;
}

/** What moves a record (the reducer's input); every failure event names a catalog code or gets the event's default. */
export type OperationEvent =
  | { type: "quote" }
  | ({ type: "quoted"; expectedOutput?: string; minimumOutput?: string } & EventRefs)
  | { type: "review" }
  | { type: "edit" }
  | { type: "confirm"; checklist?: { destination: boolean; route: boolean; execution: boolean; limits: boolean } }
  /** at "submitting", what the record keeps to be settled from the chain if its page goes away (operations/stale.ts) */
  | {
      type: "progress";
      step: ProgressStep;
      i?: number;
      n?: number;
      noteCounter?: number;
      nullifiers?: [string, string];
      relayerUrl?: string;
      /** who a "submitting" step hands to: the relayer (irreversible: SUBMITTING), or the connected wallet, whose prompt it is (declinable: the record waits as AWAITING_AUTHORIZATION) */
      by?: "relayer" | "wallet";
    }
  | ({ type: "signed" } & EventRefs)
  | ({ type: "submitted"; by?: "relayer" | "wallet" } & EventRefs)
  | ({ type: "relayer-executing" } & EventRefs)
  | ({ type: "confirming" } & EventRefs)
  | ({ type: "verifying" } & EventRefs)
  | ({ type: "completed"; ref: SettlementRef; delivered?: string } & EventRefs)
  | { type: "quote-expired"; code?: string; detail?: string }
  /** V6: the wallet prompt was declined — back to READY_TO_REVIEW with `declined` (nothing was signed) */
  | { type: "rejected"; code?: string; detail?: string }
  /** V6: FAILED when the funds did not move or are still protected with nothing left to track or return, else RECOVERY_REQUIRED (I-O6) */
  | ({ type: "submission-failed"; code: string; detail?: string } & EventRefs)
  /** V6: an attribute of the phase the state names, never a state (I-O5) */
  | ({ type: "delayed"; code?: string; detail?: string } & EventRefs)
  | ({ type: "provider-failed"; code: string; detail?: string } & EventRefs)
  | ({ type: "recovery-required"; code: string; detail?: string } & EventRefs)
  | ({ type: "refunding" } & EventRefs)
  | ({ type: "refunded"; ref: SettlementRef; refunded?: string } & EventRefs)
  | { type: "cancel"; note?: string }
  /** a post-signature return to an open state (a campaign resuming after a requote, a tracked resume that found the transaction) */
  | ({ type: "resume"; to: OperationState } & EventRefs)
  | { type: "monitor"; at?: number }
  | { type: "note"; note: string }
  /** V6 (spec v2.0 §3): the network cost, recorded before the completion freezes the record (I-O1) */
  | { type: "costs"; costs: OperationCosts }
  /** V6 (spec v2.0 §12.4): where a swap's money is, derived by settlementOf from the legs (a failed read sends none) */
  | { type: "settlement"; settlement: SettlementState };

export type OperationEventType = OperationEvent["type"];

export interface TransitionOk {
  ok: true;
  record: OperationRecord;
  changed: boolean;
}
/** `after-submission`: I-O7 — once submitted, a record never returns to a state before its submission. */
export interface TransitionRefused {
  ok: false;
  record: OperationRecord;
  reason: "terminal" | "not-allowed" | "after-submission" | "needs-settlement-ref" | "needs-code";
}
export type TransitionResult = TransitionOk | TransitionRefused;

/** The words of a failure's first sentence, by class (spec §13). */
export const FUNDS_HEADLINE_KEY: Record<FundsClass, "op.funds.notMoved" | "op.funds.stillProtected" | "op.funds.unknown"> = {
  "not-moved": "op.funds.notMoved",
  "still-protected": "op.funds.stillProtected",
  unknown: "op.funds.unknown",
};

/** What a failed or delayed operation offers; a retry is a new quote or a tracked resume, never a re-send of the same transaction. */
export type RecoveryAction =
  "edit" | "review" | "new-quote" | "wait" | "resume-tracking" | "continue-monitoring" | "start-refund" | "check-wallet" | "check-settings" | "housekeeping";

/**
 * The state an event moves a record to (null: a field event). V6: `quoted` lands in READY_TO_REVIEW, `rejected` goes back to
 * READY_TO_REVIEW, `submission-failed` to FAILED (the reducer sends it to RECOVERY_REQUIRED under I-O6), `delayed` is a field.
 * V7 (spec v3.0 §6): a `progress` step moves the record to PREPARING_PROOF or SUBMITTING (the reducer), and `quote-expired`
 * after the funding to RECOVERY_REQUIRED (the reducer): before it the draft returns to the review with the expiry as its reason.
 */
export const STATE_EVENT_TARGET: Record<OperationEventType, OperationState | null> = {
  quote: "QUOTING",
  quoted: "READY_TO_REVIEW",
  review: "READY_TO_REVIEW",
  edit: "DRAFT",
  confirm: "AWAITING_AUTHORIZATION",
  progress: null,
  signed: "SUBMITTING",
  submitted: "SOURCE_CONFIRMING",
  "relayer-executing": "PROVIDER_EXECUTING",
  confirming: "SOURCE_CONFIRMING",
  verifying: "DESTINATION_CONFIRMING",
  completed: "COMPLETED",
  "quote-expired": "READY_TO_REVIEW",
  rejected: "READY_TO_REVIEW",
  "submission-failed": "FAILED",
  delayed: null,
  "provider-failed": "RECOVERY_REQUIRED",
  "recovery-required": "RECOVERY_REQUIRED",
  refunding: "REFUNDING",
  refunded: "REFUNDED",
  cancel: "CANCELLED",
  resume: null,
  monitor: null,
  note: null,
  costs: null,
  settlement: null,
};
