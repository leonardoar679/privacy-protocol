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
// V7 Stage 15 (spec v3.0 §6): a second step, V6 → V7 (`v: 3`): REVIEW → READY_TO_REVIEW · AWAITING_SIGNATURE → PREPARING_PROOF at
// the witness / proof / local-verify step, SUBMITTING at the submitting step, AWAITING_AUTHORIZATION otherwise · SIGNED →
// SUBMITTING · SUBMITTED, CONFIRMING → SOURCE_CONFIRMING · EXECUTING → PROVIDER_EXECUTING · SETTLING → DESTINATION_CONFIRMING ·
// QUOTE_EXPIRED → RECOVERY_REQUIRED with `minimum_moved` once submitted, READY_TO_REVIEW with `quote_expired` before · every
// other name unchanged; the history renamed the same way and merged. A V5 record goes through both steps.
import { STATE_CROSSWALK_V2, type OperationStateV2 } from "@privacy-wallet/protocol-types";
import type { FundsClass, OperationKind, OperationPhase, OperationReason, OperationRecord, OperationState } from "../wallet/operationRecord";
import { isDraft } from "../wallet/operationRecord";
import { failureTarget } from "./errors/codes";

/** A record as V5 wrote it (or as V6 does: `v: 2`, or V7: `v: 3`). */
export type StoredOperation = Omit<OperationRecord, "state" | "history" | "v"> & {
  v?: number;
  state: string;
  history: { state: string; at: number; note?: string }[];
  failure?: { code: string; class: FundsClass; detail?: string };
};

const SWAP_KINDS: readonly OperationKind[] = ["swap", "cross-chain"];
const FAILURE: readonly string[] = ["QUOTE_EXPIRED", "FAILED", "RECOVERY_REQUIRED"]; // V6 names: this step speaks V6

/** The V6 name of a V5 state; `last` is the record's current line (a stored rejection is final, one in the past was retried). */
export function upgradeState(
  v5: string,
  kind: OperationKind,
  phase: OperationPhase | undefined,
  failure: { code: string; fundsClass: FundsClass } | undefined,
  last: boolean,
): OperationStateV2 {
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
      return v5 as OperationStateV2;
  }
}

/** A record in the V6 vocabulary (`v: 2`): the first step's output, the second step's input. */
export type StoredOperationV2 = Omit<OperationRecord, "state" | "history" | "v"> & {
  v: 2;
  state: string;
  history: { state: string; at: number; note?: string }[];
};

/** One record in the V6 vocabulary from a V5 one (the first step; a V6 record is returned as it is). */
export function upgradeRecordV6(stored: StoredOperation | StoredOperationV2): StoredOperationV2 {
  if (stored.v === 2) return stored as StoredOperationV2;
  const r = stored as StoredOperation;
  const { failure, ...rest } = r;
  const known = failure ? { code: failure.code, fundsClass: failure.class } : r.reason;
  const state = upgradeState(r.state, r.kind, r.phase, known, true);
  // the history: renamed, consecutive equal lines merged (the first time kept, the notes joined)
  const history: StoredOperationV2["history"] = []; // V6 names: this step speaks V6
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
  let out = { ...(rest as Omit<StoredOperation, "failure">), v: 2 as const, state, history } as unknown as StoredOperationV2;
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

const SUBMITTED_V2: readonly string[] = ["SIGNED", "SUBMITTED", "CONFIRMING", "EXECUTING", "SETTLING", "REFUNDING"]; // SIGNED → SUBMITTING, a submitted state in V7 (the review round of 2026-11-02)
const PROOF_STEPS: readonly string[] = ["witness", "proof", "local-verify"];

/** The V7 name of a V6 state (spec v3.0 §6); `last`: the record's current line (the progress step decides the signature's split). */
export function upgradeStateV7(
  v2: string,
  rec: { kind?: string; state: string; progress?: { step?: string }; history: { state: string }[]; refs?: { relayerUrl?: string } },
  last: boolean,
): OperationState {
  switch (v2) {
    case "AWAITING_SIGNATURE": {
      // a Protect's step is the external wallet's prompt, never a proof or a send of its own: its state stays the authorization;
      // so is a spend's "submitting" step through the connected wallet (no relayer kept: the review round of 2026-11-02)
      const step = last && rec.kind !== "protect" ? rec.progress?.step : undefined;
      if (step && PROOF_STEPS.includes(step)) return "PREPARING_PROOF";
      return step === "submitting" && rec.refs?.relayerUrl ? "SUBMITTING" : "AWAITING_AUTHORIZATION";
    }
    case "QUOTE_EXPIRED": {
      const submitted = SUBMITTED_V2.includes(rec.state) || rec.history.some((h) => SUBMITTED_V2.includes(h.state));
      return submitted ? "RECOVERY_REQUIRED" : "READY_TO_REVIEW";
    }
    default:
      return (STATE_CROSSWALK_V2 as Readonly<Record<string, OperationState | undefined>>)[v2] ?? (v2 as OperationState);
  }
}

/** One record in the V7 vocabulary from a V6 one (the second step): the state, the history renamed and merged, the expired quote's reason. */
export function upgradeRecordV7(r: StoredOperationV2): OperationRecord {
  const state = upgradeStateV7(r.state, r, true);
  const history: OperationRecord["history"] = [];
  const lines = Array.isArray(r.history) ? r.history : [];
  lines.forEach((h, i) => {
    const s = i === lines.length - 1 && h.state === r.state ? state : upgradeStateV7(h.state, r, false);
    const prev = history[history.length - 1];
    if (prev && prev.state === s) {
      if (h.note) prev.note = prev.note ? `${prev.note}; ${h.note}` : h.note;
      return;
    }
    history.push({ state: s, at: h.at, ...(h.note ? { note: h.note } : {}) });
  });
  if (!history.length || history[history.length - 1].state !== state) history.push({ state, at: r.updatedAt });
  let out = { ...r, v: 3 as const, state, history } as OperationRecord;
  if (r.state === "QUOTE_EXPIRED") {
    // the expired quote by the record: after the funding the user's choice (a new minimum or the money back), before it a new quote
    out =
      state === "RECOVERY_REQUIRED"
        ? {
            ...out,
            reason: r.reason ?? { code: "minimum_moved", fundsClass: "still-protected" },
            recovery: out.recovery ?? { state: "monitoring", since: r.updatedAt },
          }
        : { ...out, reason: r.reason ?? { code: "quote_expired", fundsClass: "not-moved" } };
  }
  return out;
}

/** One record in the V7 vocabulary; a V7 record (`v: 3`) is returned unchanged (the same object); a V5 one takes both steps. */
export function upgradeRecord(stored: StoredOperation | OperationRecord): OperationRecord {
  if (stored.v === 3) return stored as OperationRecord;
  return upgradeRecordV7(upgradeRecordV6(stored as StoredOperation | StoredOperationV2));
}

/**
 * The journal's list in the V6 vocabulary (idempotent). It runs inside the journal's decryption, so a record it cannot
 * read is kept as it is — one malformed record never makes the whole journal unreadable.
 */
export const upgradeOperations = (list: readonly (StoredOperation | OperationRecord)[]): OperationRecord[] =>
  list.flatMap((r) => {
    try {
      const u = upgradeRecord(r);
      // a draft is never journaled (spec v3.0 §6): one an upgrade yields — a V6 quote expired before its funding — leaves the
      // journal here rather than stay an invisible record for good (the review round of 2026-11-02)
      return isDraft(u.state) ? [] : [u];
    } catch {
      return [r as OperationRecord];
    }
  });
