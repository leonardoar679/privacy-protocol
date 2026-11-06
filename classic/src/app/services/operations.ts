// The Classic operation adapter (spec v3.0 §6, §7.7): the fifteen state names of the Privacy Wallet's engine as this
// app's own type, the two machines — a deposit and a relayed or wallet-mode withdrawal — and the record the device keeps
// of each: ids, the pool, the state, a transaction hash, the relayer's job id and state. Never a note, never a recipient — an open withdrawal
// keeps a keyed digest of its nullifier hash, never the hash. Pure; the storage is storage/historyDb.ts's jobs store.
import { keccak256 } from "js-sha3";
import type { PoolId } from "../../config";
import type { JobState } from "../../relayer/schema";
import type { HistoryRow } from "../../model/types";
import type { MessageKey } from "../i18n/messages";

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
  /**
   * keccak256(the record's id ‖ the note's nullifier hash), kept while the record is open (the eleventh review round, 2026-11-04, C11-1): History
   * completes a relayed withdrawal only on a Withdrawal event naming this note — a relayer's CONFIRMED with another withdrawal's transaction of
   * the pool had completed it, and a user discards a note never withdrawn. Dropped once the record ends: kept on a closed one, it would link
   * this device to the note's later withdrawal made elsewhere.
   */
  noteDigest?: string;
  /** the history's block when the withdrawal was submitted: its Withdrawal event comes after it (the critique of C11-1: a bounded match) */
  fromBlock?: number;
  /** the relayer reported FAILED or CONFIRMED and the pool could not be asked whether the note is spent (the critique of C11-13): the words say so */
  spentUnread?: true;
  /** the relayer's reward account the proof pays (public): History completes the record only on the note's withdrawal paid to it */
  relayerAccount?: string;
  /** the refusal's catalog words, beside its English reason (the critique: the new refusals had reached a Korean reader in English) */
  failedKey?: MessageKey;
}

/** The record's keyed digest of a nullifier hash (C11-1): only this record's id opens the match. */
export function noteDigestOf(jobId: string, nullifierHash: string): string {
  const id = new TextEncoder().encode(jobId);
  const hex = nullifierHash.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  const nh = Uint8Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  const bytes = new Uint8Array(id.length + 32);
  bytes.set(id, 0);
  bytes.set(nh, id.length);
  return keccak256(bytes);
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

/** How long a relayed withdrawal that ended before its relayer's outcome keeps its pool's history held: the relayer may still publish it. */
export const IN_FLIGHT_HOLD_MS = 15 * 60_000;
/**
 * A relayed withdrawal whose job may still be published: not ended, its relayer not reporting it mined, confirmed or failed — one running in
 * a page of the device, one whose page closed during it, one whose answer was lost or whose job is no longer followed (the critique: the
 * device's records hold its pool on every page, and only the last two had held it, and only on the page that ran it).
 */
export const inFlight = (job: JobRecord): boolean =>
  job.kind === "withdrawal" &&
  job.via === "relayer" &&
  !isTerminal(job.state) &&
  job.relayerState !== "FAILED" &&
  job.relayerState !== "MINED" &&
  job.relayerState !== "CONFIRMED";

/** Whether the machine of `kind` allows the step; the records are only ever moved along these edges. */
export function canMove(kind: JobKind, from: OperationState, to: OperationState): boolean {
  return ((kind === "deposit" ? DEPOSIT_NEXT : WITHDRAWAL_NEXT)[from] ?? []).includes(to);
}

export function move(job: JobRecord, to: OperationState, now: number, extra: Partial<JobRecord> = {}): JobRecord {
  if (!canMove(job.kind, job.state, to)) throw new Error(`a ${job.kind} does not go from ${job.state} to ${to}`);
  return closedRecord({ ...job, ...extra, state: to, updatedAt: now });
}
/** A record that ended keeps no digest of its note (C11-1). */
export function closedRecord(job: JobRecord): JobRecord {
  if (!isTerminal(job.state) || job.noteDigest === undefined) return job;
  const { noteDigest: _gone, ...rest } = job;
  return rest;
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
  // a relayer's CONFIRMED the pool does not show yet is the relayer's report, never "Confirmed" (the tenth review round, C10-3)
  if (job.relayerState === "CONFIRMED" && job.state !== "COMPLETED") return { ...base, status: "reported" };
  // a relayer's FAILED for a note the pool reported spent (the eleventh review round's critique of C11-13): its outcome is unknown until the
  // note's Withdrawal event completes it — then withdrawn, whatever the relayer reported
  if (job.relayerState === "FAILED" && job.state === "RECOVERY_REQUIRED") return { ...base, status: "unknown" };
  if (job.relayerState && job.relayerState !== "CONFIRMED" && job.state === "COMPLETED") return { ...base, status: "withdrawn" };
  if (job.relayerState) return { ...base, status: job.relayerState };
  // a submission whose answer was lost (the eleventh review round, VC-N1): its outcome is unknown, never "Waiting for receipt" for good
  if (job.state === "RECOVERY_REQUIRED") return { ...base, status: "unknown" };
  const status = job.state === "COMPLETED" ? "withdrawn" : job.state === "FAILED" || job.state === "CANCELLED" ? "failed" : "waiting";
  return { ...base, status };
}
