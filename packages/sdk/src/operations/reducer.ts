// The transition table of the operation state machine (spec §12) and the pure reducer over it. I-O1: a terminal
// state never changes. I-O2: history timestamps are monotone. I-O3: every failure state carries a catalog reason —
// an event without a code gets its default, an unknown code is recorded as `unknown` with the original kept as the
// detail. I-O4: COMPLETED needs a settlement reference. The engines are not called from here; the adapters and the
// flows feed events in.
import { FAILURE_STATES, TERMINAL_STATES, type FundsClass, type OperationRecord, type OperationState } from "../wallet/operationRecord";
import { CATALOG, hasCode } from "./errors/catalog";
import { STATE_EVENT_TARGET, type EventRefs, type OperationEvent, type TransitionRefused, type TransitionResult } from "./types";

/** The legal next states (the spec's §12 table read as a graph). */
export const ALLOWED: Record<OperationState, readonly OperationState[]> = {
  DRAFT: ["QUOTING", "QUOTE_READY", "REVIEW", "CANCELLED"],
  QUOTING: ["QUOTE_READY", "DRAFT", "QUOTE_EXPIRED", "CANCELLED"],
  QUOTE_READY: ["REVIEW", "DRAFT", "QUOTING", "QUOTE_EXPIRED", "CANCELLED"],
  REVIEW: ["AWAITING_SIGNATURE", "DRAFT", "QUOTING", "QUOTE_READY", "QUOTE_EXPIRED", "CANCELLED"],
  AWAITING_SIGNATURE: ["SIGNED", "SUBMITTED", "SIGNATURE_REJECTED", "QUOTE_EXPIRED", "SUBMISSION_FAILED", "RECOVERY_REQUIRED", "CANCELLED"],
  SIGNED: ["SUBMITTED", "SUBMISSION_FAILED", "QUOTE_EXPIRED", "RECOVERY_REQUIRED"],
  SUBMITTED: ["RELAYER_EXECUTING", "NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED", "SUBMISSION_FAILED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  RELAYER_EXECUTING: ["NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED", "SUBMISSION_FAILED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  NETWORK_CONFIRMING: ["SETTLEMENT_VERIFYING", "COMPLETED", "SUBMISSION_FAILED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  SETTLEMENT_VERIFYING: ["COMPLETED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  COMPLETED: [],
  QUOTE_EXPIRED: ["DRAFT", "QUOTING", "QUOTE_READY", "REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "NETWORK_CONFIRMING", "CANCELLED", "REFUNDING", "REFUNDED"],
  SIGNATURE_REJECTED: ["DRAFT", "REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "CANCELLED"],
  SUBMISSION_FAILED: ["DRAFT", "QUOTING", "REVIEW", "CANCELLED", "SUBMITTED", "NETWORK_CONFIRMING", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  NETWORK_DELAYED: ["SUBMITTED", "RELAYER_EXECUTING", "NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED", "SUBMISSION_FAILED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  PROVIDER_FAILED: ["SETTLEMENT_VERIFYING", "COMPLETED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  RECOVERY_REQUIRED: ["NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED", "PROVIDER_FAILED", "REFUNDING", "REFUNDED"],
  REFUNDING: ["REFUNDED", "RECOVERY_REQUIRED"],
  REFUNDED: [],
  CANCELLED: [],
};

/** The code a failure event carries when it names none (I-O3). */
export const DEFAULT_CODES: Partial<Record<OperationEvent["type"], string>> = { "quote-expired": "quote_expired", rejected: "user_rejected", delayed: "network_delayed" };

const REFS: (keyof EventRefs)[] = ["txHash", "jobId", "orderId", "campaignId", "executionTx", "executionRef", "quoteId", "provider", "activityId"];

function mergeRefs(r: OperationRecord["refs"], e: EventRefs): OperationRecord["refs"] {
  const next = { ...r, txHashes: [...r.txHashes] };
  for (const k of REFS) {
    const v = e[k];
    if (v === undefined) continue;
    if (k === "txHash") { if (!next.txHashes.includes(v)) next.txHashes.push(v); }
    else (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

function failureOf(code: string | undefined, fallback: string, detail?: string): { code: string; class: FundsClass; detail?: string } {
  const c = code ?? fallback;
  if (hasCode(c)) return { code: c, class: CATALOG[c].fundsClass, ...(detail ? { detail } : {}) };
  return { code: "unknown", class: CATALOG.unknown.fundsClass, detail: detail ? `${c}: ${detail}` : c };
}

const hasSettlementRef = (ref: { leafIndex?: number; txHash?: string; destinationTx?: string; tracker?: boolean; jobId?: string } | undefined): boolean =>
  !!ref && (ref.leafIndex !== undefined || !!ref.txHash || !!ref.destinationTx || ref.tracker === true);

/** Apply one event; the record is never mutated. */
export function transition(rec: OperationRecord, ev: OperationEvent, now = Date.now()): TransitionResult {
  const at = Math.max(now, rec.updatedAt); // I-O2
  if (TERMINAL_STATES.includes(rec.state)) return { ok: false, record: rec, reason: "terminal" }; // I-O1
  const target = ev.type === "resume" ? ev.to : STATE_EVENT_TARGET[ev.type];
  // events that change fields, not the state
  if (target === null) {
    if (ev.type === "progress") return { ok: true, changed: true, record: { ...rec, updatedAt: at, progress: { step: ev.step, ...(ev.i !== undefined ? { i: ev.i } : {}), ...(ev.n !== undefined ? { n: ev.n } : {}) } } };
    if (ev.type === "monitor") {
      const since = rec.recovery?.since ?? at;
      return { ok: true, changed: true, record: { ...rec, updatedAt: at, recovery: { ...(rec.recovery ?? {}), state: rec.recovery?.state ?? "monitoring", since, lastCheckedAt: ev.at ?? at } } };
    }
    if (ev.type === "note") {
      // a note joins the current state's history line (the history is one line per state)
      const last = rec.history[rec.history.length - 1];
      const line = last ? { ...last, note: last.note ? `${last.note}; ${ev.note}` : ev.note } : { state: rec.state, at, note: ev.note };
      return { ok: true, changed: true, record: { ...rec, updatedAt: at, history: last ? [...rec.history.slice(0, -1), line] : [line] } };
    }
    return { ok: true, changed: false, record: rec };
  }
  if (!ALLOWED[rec.state].includes(target)) return { ok: false, record: rec, reason: "not-allowed" };
  if (target === "COMPLETED" && !(ev.type === "completed" && hasSettlementRef(ev.ref))) return { ok: false, record: rec, reason: "needs-settlement-ref" }; // I-O4
  if ((ev.type === "submission-failed" || ev.type === "provider-failed" || ev.type === "recovery-required") && !ev.code) return { ok: false, record: rec, reason: "needs-code" };

  const note = ev.type === "cancel" ? ev.note : undefined;
  let next: OperationRecord = { ...rec, state: target, updatedAt: at, history: [...rec.history, { state: target, at, ...(note ? { note } : {}) }] };
  if ("txHash" in ev || "jobId" in ev || "orderId" in ev || "campaignId" in ev || "executionTx" in ev || "executionRef" in ev || "quoteId" in ev || "provider" in ev || "activityId" in ev) next = { ...next, refs: mergeRefs(rec.refs, ev as EventRefs) };
  if (FAILURE_STATES.includes(target)) {
    const code = "code" in ev ? ev.code : undefined;
    const detail = "detail" in ev ? ev.detail : undefined;
    next = { ...next, failure: failureOf(code, DEFAULT_CODES[ev.type] ?? "unknown", detail), progress: undefined };
    if (target === "NETWORK_DELAYED" || target === "PROVIDER_FAILED" || target === "RECOVERY_REQUIRED") next = { ...next, recovery: { state: target === "RECOVERY_REQUIRED" ? "refund-offered" : "monitoring", since: rec.recovery?.since ?? at, lastCheckedAt: at } };
  } else {
    next = { ...next, failure: undefined };
    if (target !== "AWAITING_SIGNATURE") next = { ...next, progress: undefined };
  }
  switch (ev.type) {
    case "quoted": next = { ...next, amounts: { ...next.amounts, ...(ev.expectedOutput !== undefined ? { expectedOutput: ev.expectedOutput } : {}), ...(ev.minimumOutput !== undefined ? { minimumOutput: ev.minimumOutput } : {}) } }; break;
    case "confirm": if (ev.checklist) next = { ...next, protectedExecution: { checklist: ev.checklist } }; break;
    case "completed":
      next = { ...next, amounts: { ...next.amounts, ...(ev.delivered !== undefined ? { delivered: ev.delivered } : {}) }, refs: mergeRefs(next.refs, { ...(ev.ref.txHash ? { txHash: ev.ref.txHash } : {}), ...(ev.ref.jobId ? { jobId: ev.ref.jobId } : {}) }) };
      if (ev.ref.leafIndex !== undefined) next = { ...next, refs: { ...next.refs, leafIndex: ev.ref.leafIndex } };
      if (ev.ref.destinationTx) next = { ...next, refs: { ...next.refs, executionTx: next.refs.executionTx ?? ev.ref.destinationTx } };
      if (rec.recovery) next = { ...next, recovery: { ...rec.recovery, state: "resolved", lastCheckedAt: at } };
      break;
    case "refunding": next = { ...next, recovery: { state: "refunding", since: rec.recovery?.since ?? at, lastCheckedAt: at } }; break;
    case "refunded":
      next = { ...next, recovery: { state: "refunded", since: rec.recovery?.since ?? at, lastCheckedAt: at }, amounts: { ...next.amounts, ...(ev.refunded !== undefined ? { delivered: ev.refunded } : {}) } };
      if (ev.ref.leafIndex !== undefined) next = { ...next, refs: { ...next.refs, leafIndex: ev.ref.leafIndex } };
      if (ev.ref.txHash && !next.refs.txHashes.includes(ev.ref.txHash)) next = { ...next, refs: { ...next.refs, txHashes: [...next.refs.txHashes, ev.ref.txHash] } };
      break;
    default: break;
  }
  if (target === "SUBMITTED" || target === "RELAYER_EXECUTING") next = { ...next, phase: next.phase ?? "execution" };
  if (target === "NETWORK_CONFIRMING" || target === "SETTLEMENT_VERIFYING") next = { ...next, phase: "settlement" };
  if (target === "AWAITING_SIGNATURE" || target === "SIGNED") next = { ...next, phase: "funding" };
  return { ok: true, changed: true, record: next };
}

/** A sequence of events, stopping at the first refusal. */
export function replay(rec: OperationRecord, events: OperationEvent[], now = Date.now()): { record: OperationRecord; refused?: { at: number; reason: TransitionRefused["reason"] } } {
  let r = rec;
  for (let i = 0; i < events.length; i++) {
    const t = transition(r, events[i], now + i);
    if (!t.ok) return { record: r, refused: { at: i, reason: t.reason } };
    r = t.record;
  }
  return { record: r };
}
