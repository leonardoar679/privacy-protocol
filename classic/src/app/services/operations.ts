// The Classic operation adapter (spec v3.0 §6, §7.7): the fifteen state names of the Privacy Wallet's engine as this
// app's own type, the two machines — a deposit and a relayed or wallet-mode withdrawal — and the record the device keeps
// of each: ids, the pool, the state, a transaction hash, the relayer's job id and state. Never a note, never a recipient.
// Pure; the storage is storage/historyDb.ts's jobs store.
import type { PoolId } from "../../config";
import type { JobState } from "../../relayer/schema";
import type { HistoryRow } from "../../model/types";

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
  "REFUNDED",
  "EXPIRED",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export type JobKind = "deposit" | "withdrawal";
export type WithdrawalVia = "relayer" | "wallet";

export interface JobRecord {
  id: string;
  kind: JobKind;
  pool: PoolId;
  state: OperationState;
  createdAt: number;
  updatedAt: number;
  /** the deposit's or the wallet-mode withdrawal's transaction */
  txHash?: `0x${string}`;
  /** the relayer's base URL and job (a relayed withdrawal) */
  via?: WithdrawalVia;
  relayerUrl?: string;
  relayerJobId?: string;
  relayerState?: JobState;
  failedReason?: string;
  /** a deposit's leaf, once its event is known */
  leafIndex?: number;
}

const DEPOSIT_NEXT: Partial<Record<OperationState, OperationState[]>> = {
  DRAFT: ["READY_TO_REVIEW", "CANCELLED"],
  READY_TO_REVIEW: ["AWAITING_AUTHORIZATION", "CANCELLED"],
  AWAITING_AUTHORIZATION: ["SUBMITTING", "FAILED", "CANCELLED"],
  SUBMITTING: ["SOURCE_CONFIRMING", "FAILED"],
  SOURCE_CONFIRMING: ["COMPLETED", "FAILED"],
};
const WITHDRAWAL_NEXT: Partial<Record<OperationState, OperationState[]>> = {
  DRAFT: ["READY_TO_REVIEW", "CANCELLED"],
  READY_TO_REVIEW: ["PREPARING_PROOF", "CANCELLED"],
  PREPARING_PROOF: ["AWAITING_AUTHORIZATION", "FAILED", "CANCELLED"],
  AWAITING_AUTHORIZATION: ["SUBMITTING", "FAILED", "CANCELLED"],
  SUBMITTING: ["SOURCE_CONFIRMING", "COMPLETED", "FAILED", "RECOVERY_REQUIRED"],
  SOURCE_CONFIRMING: ["COMPLETED", "FAILED", "RECOVERY_REQUIRED"],
  RECOVERY_REQUIRED: ["COMPLETED", "FAILED", "SOURCE_CONFIRMING"],
};

export const isTerminal = (s: OperationState): boolean => s === "COMPLETED" || s === "FAILED" || s === "CANCELLED";

/** Whether the machine of `kind` allows the step; the records are only ever moved along these edges. */
export function canMove(kind: JobKind, from: OperationState, to: OperationState): boolean {
  return ((kind === "deposit" ? DEPOSIT_NEXT : WITHDRAWAL_NEXT)[from] ?? []).includes(to);
}

export function move(job: JobRecord, to: OperationState, now: number, extra: Partial<JobRecord> = {}): JobRecord {
  if (!canMove(job.kind, job.state, to)) throw new Error(`a ${job.kind} does not go from ${job.state} to ${to}`);
  return { ...job, ...extra, state: to, updatedAt: now };
}

/** The relayer's job state as the operation's: queued, accepted and sent are still submitting; mined is confirming; resubmitted needs a look. */
export function fromRelayerState(s: JobState): OperationState {
  switch (s) {
    case "QUEUED":
    case "ACCEPTED":
    case "SENT":
      return "SUBMITTING";
    case "MINED":
      return "SOURCE_CONFIRMING";
    case "CONFIRMED":
      return "COMPLETED";
    case "FAILED":
      return "FAILED";
    case "RESUBMITTED":
      return "RECOVERY_REQUIRED";
  }
}

export const newJob = (id: string, kind: JobKind, pool: PoolId, now: number, extra: Partial<JobRecord> = {}): JobRecord => ({
  id,
  kind,
  pool,
  state: "DRAFT",
  createdAt: now,
  updatedAt: now,
  ...extra,
});

/** The history screen's row of a record (the original's words: waiting, deposited, withdrawn, failed, or the relayer's state). */
export function toHistoryRow(job: JobRecord, facts?: { depositsSince?: number; spent?: boolean }): HistoryRow {
  const base = { id: job.id, kind: job.kind, pool: job.pool, timestamp: Math.floor(job.createdAt / 1000), txHash: job.txHash, ...facts };
  if (job.kind === "deposit") {
    const status = job.state === "COMPLETED" ? "deposited" : job.state === "FAILED" || job.state === "CANCELLED" ? "failed" : "waiting";
    return { ...base, status };
  }
  if (job.relayerState) return { ...base, status: job.relayerState };
  const status = job.state === "COMPLETED" ? "withdrawn" : job.state === "FAILED" || job.state === "CANCELLED" ? "failed" : "waiting";
  return { ...base, status };
}
