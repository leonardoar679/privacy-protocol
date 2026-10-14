// The V5 → V6 upgrade of a journaled operation record (Privacy Wallet Web spec v2.0 §12.2): applied when the journal is
// decrypted (wallet/journal.ts decryptJournal) and again on every read of the list (idempotent — a V6 record is
// returned as it is), persisted with the journal's next write. The table:
//   QUOTE_READY → REVIEW · RELAYER_EXECUTING → EXECUTING · NETWORK_CONFIRMING → CONFIRMING (protect, send, withdraw,
//   Classic) or EXECUTING (swap, cross-chain: the tracker's source legs) · SETTLEMENT_VERIFYING → SETTLING ·
//   SIGNATURE_REJECTED → CANCELLED with `user_rejected` (a stored record; the live one goes back to REVIEW) ·
//   SUBMISSION_FAILED → FAILED (RECOVERY_REQUIRED under I-O6: an unknown funds class, or a code that leaves something to
//   track or return) · NETWORK_DELAYED → the phase's state
//   with `delayed` · PROVIDER_FAILED → RECOVERY_REQUIRED · every other name unchanged.
// `failure {code, class, detail}` becomes `reason {code, fundsClass, detail}`. History lines are renamed the same way
// (a rejection or a failure the record moved past reads as the state it went back to) and consecutive equal lines merge.
// Pure (the catalog's data only, ./errors/codes.ts), so the journal can call it.
import type { FundsClass, OperationKind, OperationPhase, OperationReason, OperationRecord, OperationState } from "../wallet/operationRecord";
import { failureTarget } from "./errors/codes";

/** A record as V5 wrote it (or as V6 does: `v: 2`). */
export type StoredOperation = Omit<OperationRecord, "state" | "history" | "v"> & {
  v?: number;
  state: string;
  history: { state: string; at: number; note?: string }[];
  failure?: { code: string; class: FundsClass; detail?: string };
};

const SWAP_KINDS: readonly OperationKind[] = ["swap", "cross-chain"];
const FAILURE: readonly OperationState[] = ["QUOTE_EXPIRED", "FAILED", "RECOVERY_REQUIRED"];

/** The V6 name of a V5 state; `last` is the record's current line (a stored rejection is final, one in the past was retried). */
export function upgradeState(
  v5: string,
  kind: OperationKind,
  phase: OperationPhase | undefined,
  failure: { code: string; fundsClass: FundsClass } | undefined,
  last: boolean,
): OperationState {
  const swap = SWAP_KINDS.includes(kind);
  switch (v5) {
    case "QUOTE_READY":
      return "REVIEW";
    case "RELAYER_EXECUTING":
      return "EXECUTING";
    case "NETWORK_CONFIRMING":
      return swap ? "EXECUTING" : "CONFIRMING";
    case "SETTLEMENT_VERIFYING":
      return "SETTLING";
    case "SIGNATURE_REJECTED":
      return last ? "CANCELLED" : "REVIEW";
    case "SUBMISSION_FAILED":
      return last && failure ? failureTarget(failure) : "RECOVERY_REQUIRED"; // I-O6
    case "NETWORK_DELAYED":
      return !swap ? "CONFIRMING" : phase === "funding" ? "CONFIRMING" : phase === "settlement" ? "SETTLING" : "EXECUTING";
    case "PROVIDER_FAILED":
      return "RECOVERY_REQUIRED";
    default:
      return v5 as OperationState;
  }
}

/** One record in the V6 vocabulary; a V6 record (`v: 2`) is returned unchanged (the same object). */
export function upgradeRecord(stored: StoredOperation | OperationRecord): OperationRecord {
  if (stored.v === 2) return stored as OperationRecord;
  const r = stored as StoredOperation;
  const { failure, ...rest } = r;
  const known = failure ? { code: failure.code, fundsClass: failure.class } : r.reason;
  const state = upgradeState(r.state, r.kind, r.phase, known, true);
  // the history: renamed, consecutive equal lines merged (the first time kept, the notes joined)
  const history: OperationRecord["history"] = [];
  const lines = Array.isArray(r.history) ? r.history : [];
  lines.forEach((h, i) => {
    const s = i === lines.length - 1 && h.state === r.state ? state : upgradeState(h.state, r.kind, r.phase, known, false);
    const prev = history[history.length - 1];
    if (prev && prev.state === s) {
      if (h.note) prev.note = prev.note ? `${prev.note}; ${h.note}` : h.note;
      return;
    }
    history.push({ state: s, at: h.at, ...(h.note ? { note: h.note } : {}) });
  });
  if (!history.length || history[history.length - 1].state !== state) history.push({ state, at: r.updatedAt });
  let out: OperationRecord = { ...(rest as Omit<StoredOperation, "failure">), v: 2, state, history } as OperationRecord;
  delete (out as { failure?: unknown }).failure;
  const reason: OperationReason | undefined = failure
    ? { code: failure.code, fundsClass: failure.class, ...(failure.detail ? { detail: failure.detail } : {}) }
    : r.reason;
  if (r.state === "SIGNATURE_REJECTED") {
    const line = [...lines].reverse().find((h) => h.state === "SIGNATURE_REJECTED");
    out = {
      ...out,
      reason: reason ?? { code: "user_rejected", fundsClass: "not-moved" },
      declined: { at: line?.at ?? r.updatedAt, code: reason?.code ?? "user_rejected" },
    };
  } else if (r.state === "NETWORK_DELAYED") {
    const line = [...lines].reverse().find((h) => h.state === "NETWORK_DELAYED");
    out = { ...out, delayed: { since: line?.at ?? r.recovery?.since ?? r.updatedAt, code: reason?.code ?? "network_delayed" } };
    delete (out as { reason?: unknown }).reason;
  } else if (FAILURE.includes(state)) {
    out = { ...out, reason: reason ?? { code: "unknown", fundsClass: "unknown" } }; // I-O3
  } else if (!(state === "CANCELLED" && r.declined)) {
    delete (out as { reason?: unknown }).reason; // an open or a finished state carries no reason (a stored decline keeps its own)
  }
  return out;
}

/**
 * The journal's list in the V6 vocabulary (idempotent). It runs inside the journal's decryption, so a record it cannot
 * read is kept as it is — one malformed record never makes the whole journal unreadable.
 */
export const upgradeOperations = (list: readonly (StoredOperation | OperationRecord)[]): OperationRecord[] =>
  list.map((r) => {
    try {
      return upgradeRecord(r);
    } catch {
      return r as OperationRecord;
    }
  });
