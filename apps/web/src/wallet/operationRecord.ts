// The operation record (Privacy Wallet Web spec §12; plan §3, §29, §60): one record per money flow in one vocabulary
// for every kind — protect, send, withdraw, swap, cross-chain swap, the Classic pool — journaled from the signature on
// (`JournalData.operations?`, optional and never written by emptyJournal()). The engines keep their own states;
// features/operations/adapters.ts reads them into this one. Pure types and constants: the reducer, the adapters,
// the catalog and the store live under src/features/operations.
import type { Tier } from "@ref/wallet/valuation";

export type OperationKind = "protect" | "send" | "withdraw" | "swap" | "cross-chain" | "classic-deposit" | "classic-withdraw";

export const OPERATION_STATES = [
  "DRAFT", "QUOTING", "QUOTE_READY", "REVIEW", "AWAITING_SIGNATURE", "SIGNED", "SUBMITTED", "RELAYER_EXECUTING", "NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED",
  "QUOTE_EXPIRED", "SIGNATURE_REJECTED", "SUBMISSION_FAILED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED", "CANCELLED",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

/** I-O1: a terminal state never changes. */
export const TERMINAL_STATES: readonly OperationState[] = ["COMPLETED", "REFUNDED", "CANCELLED"];
/** I-O3: these carry a catalog reason (`failure.code`). */
export const FAILURE_STATES: readonly OperationState[] = ["QUOTE_EXPIRED", "SIGNATURE_REJECTED", "SUBMISSION_FAILED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED"];
/** Before the signature: in memory only, never journaled. */
export const DRAFT_STATES: readonly OperationState[] = ["DRAFT", "QUOTING", "QUOTE_READY", "REVIEW"];
/** The happy path from the signature to completion, in order. */
export const PROGRESS_STATES: readonly OperationState[] = ["AWAITING_SIGNATURE", "SIGNED", "SUBMITTED", "RELAYER_EXECUTING", "NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED"];

export const isTerminal = (s: OperationState): boolean => TERMINAL_STATES.includes(s);
export const isFailure = (s: OperationState): boolean => FAILURE_STATES.includes(s);
export const isDraft = (s: OperationState): boolean => DRAFT_STATES.includes(s);
/** Open: signed or submitted and not yet terminal — what the Home's running line and the recovery tracking follow. */
export const isOpen = (s: OperationState): boolean => !isTerminal(s) && !isDraft(s);

/** The first sentence of every failure (spec §13). */
export type FundsClass = "not-moved" | "still-protected" | "unknown";
export type RecoveryState = "monitoring" | "refund-offered" | "refunding" | "refunded" | "resolved";
export type ProgressStep = "fee-terms" | "merging" | "syncing" | "verifying" | "witness" | "proof" | "local-verify" | "submitting";
export type OperationPhase = "funding" | "execution" | "settlement";
export type DestinationKind = "fresh" | "entered" | "book" | "privacy-address" | "escrow";

export interface FeeLine { label: string; value: string; hint?: string }

/** What makes a completion true (I-O4): a leaf index, a destination transaction, the tracker's completion or a mined hash. */
export interface SettlementRef { leafIndex?: number; txHash?: string; destinationTx?: string; tracker?: boolean; jobId?: string }

export interface OperationRecord {
  id: string;
  kind: OperationKind;
  state: OperationState;
  phase?: OperationPhase;
  createdAt: number;
  updatedAt: number;
  /** base units as decimal strings (the journal is JSON) */
  amounts: { asset: string; decimals: number; input: string; expectedOutput?: string; minimumOutput?: string; delivered?: string; outputAsset?: string; outputDecimals?: number };
  fees: FeeLine[];
  destination: { kind: DestinationKind; display: string; chain: string };
  refs: { activityId?: string; orderId?: string; campaignId?: string; jobId?: string; txHashes: string[]; executionTx?: string; executionRef?: string; leafIndex?: number; quoteId?: string; provider?: string };
  tier: Tier;
  /** spec §3.8 at the `large-protected` band and above */
  protectedExecution?: { checklist: { destination: boolean; route: boolean; execution: boolean; limits: boolean } };
  failure?: { code: string; class: FundsClass; detail?: string };
  recovery?: { state: RecoveryState; since: number; lastCheckedAt?: number };
  /** the §47 lines while AWAITING_SIGNATURE */
  progress?: { step: ProgressStep; i?: number; n?: number };
  history: { state: OperationState; at: number; note?: string }[];
}
