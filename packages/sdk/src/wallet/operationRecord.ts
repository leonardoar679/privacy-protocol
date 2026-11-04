// The operation record (Privacy Wallet Web spec v2.0 §12; doc §37–§41): one record per money flow in one vocabulary for
// every kind — protect, send, withdraw, swap, cross-chain swap, the Classic pool — journaled from the signature on
// (`JournalData.operations?`, optional and never written by emptyJournal()). V6: the states are the frozen contract's
// (`@privacy-wallet/protocol-types`, shared with the API) — V7 Stage 15 (spec v3.0 §6): the document's fifteen, exactly; a delay and a declined
// signature are attributes, not states; `reason` replaces V5's `failure`; a V5 record upgrades on read
// (../operations/upgrade.ts). The engines keep their own states; ../operations/adapters.ts reads them into this one.
// Pure types and constants.
import {
  DRAFT_STATES as CONTRACT_DRAFT_STATES,
  OPERATION_STATES as CONTRACT_STATES,
  SETTLEMENT_STATES as CONTRACT_SETTLEMENT_STATES,
  TERMINAL_STATES as CONTRACT_TERMINAL_STATES,
  type FundsClass,
  type OperationKind,
  type OperationState,
  type SettlementState,
} from "@privacy-wallet/protocol-types";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";

export type { FundsClass, OperationKind, OperationState, SettlementState };

export const OPERATION_STATES: readonly OperationState[] = CONTRACT_STATES;
export const SETTLEMENT_STATES: readonly SettlementState[] = CONTRACT_SETTLEMENT_STATES;

/** I-O1: a terminal state never changes. */
export const TERMINAL_STATES: readonly OperationState[] = CONTRACT_TERMINAL_STATES;
/** I-O3: these carry a catalog reason (`reason.code`). */
export const FAILURE_STATES: readonly OperationState[] = ["FAILED", "RECOVERY_REQUIRED"];
/** Before the signature: in memory only, never journaled. */
export const DRAFT_STATES: readonly OperationState[] = CONTRACT_DRAFT_STATES;
/** I-O7 (V7: from SUBMITTING on): the states before a submission — a record that reached SUBMITTING never returns to one of them (nothing is re-sent). */
export const PRE_SUBMISSION_STATES: readonly OperationState[] = ["DRAFT", "QUOTING", "READY_TO_REVIEW", "AWAITING_AUTHORIZATION", "PREPARING_PROOF"];
/** Reached only once something was handed to the relayer or the network (I-O7 reads the history for them). */
export const SUBMITTED_STATES: readonly OperationState[] = ["SUBMITTING", "SOURCE_CONFIRMING", "PROVIDER_EXECUTING", "DESTINATION_CONFIRMING", "REFUNDING"];
/** The states after the send itself reached the chain or the relayer accepted it: SUBMITTING is the send in progress, not yet one (the review round of 2026-11-02). */
export const SENT_STATES: readonly OperationState[] = ["SOURCE_CONFIRMING", "PROVIDER_EXECUTING", "DESTINATION_CONFIRMING", "REFUNDING", "COMPLETED", "REFUNDED"];
/** Whether the record's send reached the chain: a hash known, or a state at or after SOURCE_CONFIRMING now or in its history. */
export const wasSent = (r: { state: OperationState; history: { state: OperationState }[]; refs: { txHashes: string[] } }): boolean =>
  r.refs.txHashes.length > 0 || SENT_STATES.includes(r.state) || r.history.some((h) => SENT_STATES.includes(h.state));
/** The happy path from the authorization to completion, in order (a Protect skips the proof; a Protect and a Send skip the provider's and the destination's states). */
export const PROGRESS_STATES: readonly OperationState[] = [
  "AWAITING_AUTHORIZATION",
  "PREPARING_PROOF",
  "SUBMITTING",
  "SOURCE_CONFIRMING",
  "PROVIDER_EXECUTING",
  "DESTINATION_CONFIRMING",
  "COMPLETED",
];

export const isTerminal = (s: OperationState): boolean => TERMINAL_STATES.includes(s);
export const isFailure = (s: OperationState): boolean => FAILURE_STATES.includes(s);
export const isDraft = (s: OperationState): boolean => DRAFT_STATES.includes(s);
/** Open: signed or submitted and not yet terminal — what the Home's running line and the recovery tracking follow. */
export const isOpen = (s: OperationState): boolean => !isTerminal(s) && !isDraft(s);
/** I-O7: the record was submitted at some point (its history holds a submitted state). */
export const wasSubmitted = (r: { state: OperationState; history: { state: OperationState }[] }): boolean =>
  SUBMITTED_STATES.includes(r.state) || r.history.some((h) => SUBMITTED_STATES.includes(h.state));

export type RecoveryState = "monitoring" | "refund-offered" | "refunding" | "refunded" | "resolved";
export type ProgressStep = "fee-terms" | "merging" | "syncing" | "verifying" | "witness" | "proof" | "local-verify" | "submitting";
export type OperationPhase = "funding" | "execution" | "settlement";
export type DestinationKind = "fresh" | "entered" | "book" | "privacy-address" | "escrow";

/**
 * A fee line as the page said it. `labelKey` / `labelVars` / `valueKey` (optional; audit round 2, n91): the catalog's keys, so
 * Activity says the line in the language read now — `label` and `value` keep the words of the day for a record without them.
 */
export interface FeeLine {
  label: string;
  value: string;
  hint?: string;
  labelKey?: string;
  labelVars?: Record<string, string | number>;
  valueKey?: string;
}

/**
 * V6 (Privacy Wallet Web spec v2.0 §3; doc §43): what the network part of an operation cost — the estimate shown before
 * signing and the real cost (gasUsed × effectiveGasPrice from this wallet's own receipt read), both in wei, and what the
 * relayer charged for it (its F) in the fee's own asset. Optional, never written by emptyJournal().
 */
export interface OperationCosts {
  estimatedWei?: string;
  actualWei?: string;
  charged?: { amount: string; asset: string; decimals: number };
}

/** What makes a completion true (I-O4): a leaf index, a destination transaction, the tracker's completion or a mined hash. */
export interface SettlementRef {
  leafIndex?: number;
  txHash?: string;
  destinationTx?: string;
  tracker?: boolean;
  jobId?: string;
}

/** I-O3: the catalog code of a failure, the class of its funds (the first sentence the user reads), the original detail. */
export interface OperationReason {
  code: string;
  fundsClass: FundsClass;
  detail?: string;
}

export interface OperationRecord {
  /** V7: 3 (2 is a V6 record, none a V5 one — both upgraded on read, ../operations/upgrade.ts) */
  v?: 3;
  id: string;
  kind: OperationKind;
  state: OperationState;
  phase?: OperationPhase;
  createdAt: number;
  updatedAt: number;
  /** base units as decimal strings (the journal is JSON) */
  amounts: {
    asset: string;
    decimals: number;
    input: string;
    expectedOutput?: string;
    minimumOutput?: string;
    delivered?: string;
    outputAsset?: string;
    outputDecimals?: number;
  };
  fees: FeeLine[];
  destination: { kind: DestinationKind; display: string; chain: string };
  /** `noteCounter` (a Protect's note), `nullifiers` and `relayerUrl` (a Send's spend): kept at "submitting", so a record whose
   *  page went away is settled from the chain (a V6 follow-up of 2026-10-14; operations/stale.ts) */
  refs: {
    activityId?: string;
    orderId?: string;
    campaignId?: string;
    jobId?: string;
    txHashes: string[];
    executionTx?: string;
    executionRef?: string;
    leafIndex?: number;
    quoteId?: string;
    provider?: string;
    noteCounter?: number;
    nullifiers?: [string, string];
    relayerUrl?: string;
    /** the digest of its call's public inputs (the sixth review round, 2026-11-03): a lost answer is settled only by that call */
    inputsDigest?: string;
  };
  tier: Tier;
  /** spec §3.8 at the `large-protected` band and above */
  protectedExecution?: { checklist: { destination: boolean; route: boolean; execution: boolean; limits: boolean } };
  /** V6 (replaces V5's `failure`): the reason of a failure state, kept on a CANCELLED record that a declined signature ended; V7: a READY_TO_REVIEW keeps `quote_expired` when its quote expired before the funding */
  reason?: OperationReason;
  /** V6: a delay of the phase the state names — never a state of its own (I-O5) */
  delayed?: { since: number; code: string };
  /** V6: the signature prompt was refused; the record went back to REVIEW */
  declined?: { at: number; code: string };
  /** V6 (spec v2.0 §12.4): where a swap's money is */
  settlement?: SettlementState;
  recovery?: { state: RecoveryState; since: number; lastCheckedAt?: number };
  /** the §47 lines while AWAITING_AUTHORIZATION */
  progress?: { step: ProgressStep; i?: number; n?: number };
  /** V6: the estimated, charged and actual network cost (spec v2.0 §3) */
  costs?: OperationCosts;
  /**
   * What a finished swap came to when it is not the order's whole delivery (the ninth review round, 2026-11-04, C-03/C-07): `partial`, a
   * part delivered and the rest back in the protected balance; `refunded-at-destination`, the provider refunded at the destination address
   * in its own refund asset. A COMPLETED record only; optional
   */
  outcome?: OperationOutcome;
  history: { state: OperationState; at: number; note?: string }[];
}

/** C-03/C-07: a finished swap's outcome beside its state. */
export type OperationOutcome = "partial" | "refunded-at-destination";
