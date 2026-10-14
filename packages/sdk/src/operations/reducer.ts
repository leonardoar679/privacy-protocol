// The transition table of the operation state machine (spec v2.0 §12) and the pure reducer over it. I-O1: a terminal
// state never changes. I-O2: history timestamps are monotone. I-O3: every failure state carries a catalog reason —
// an event without a code gets its default, an unknown code is recorded as `unknown` with the original kept as the
// detail. I-O4: COMPLETED needs a settlement reference. V6: I-O6 — FAILED only when the funds did not move or are still
// protected (an unknown outcome is RECOVERY_REQUIRED); I-O7 — after SUBMITTED a record never returns to a state before
// its submission (nothing is re-sent). A delay, a declined prompt and the settlement are fields, not states. The engines
// are not called from here; the adapters and the flows feed events in.
import { FAILURE_STATES, PRE_SUBMISSION_STATES, TERMINAL_STATES, wasSubmitted, type OperationReason, type OperationRecord, type OperationState, type RecoveryState, type SettlementState } from "../wallet/operationRecord";
import { CATALOG, failureTarget, hasCode } from "./errors/codes";
import { costNotes } from "./costs";
import { STATE_EVENT_TARGET, type EventRefs, type OperationEvent, type TransitionRefused, type TransitionResult } from "./types";

export { failureTarget } from "./errors/codes";

/** The legal next states (spec v2.0 §12.1 read as a graph); a self-transition updates fields and adds no history line. */
export const ALLOWED: Record<OperationState, readonly OperationState[]> = {
  DRAFT: ["QUOTING", "REVIEW", "CANCELLED"],
  QUOTING: ["REVIEW", "DRAFT", "QUOTE_EXPIRED", "CANCELLED"],
  REVIEW: ["AWAITING_SIGNATURE", "DRAFT", "QUOTING", "QUOTE_EXPIRED", "CANCELLED"],
  AWAITING_SIGNATURE: ["SIGNED", "SUBMITTED", "REVIEW", "QUOTE_EXPIRED", "FAILED", "RECOVERY_REQUIRED", "CANCELLED"],
  SIGNED: ["SUBMITTED", "FAILED", "QUOTE_EXPIRED", "RECOVERY_REQUIRED"],
  // a funded swap whose price moved before its execution waits as QUOTE_EXPIRED for the user's choice (a new minimum or the money back)
  SUBMITTED: ["CONFIRMING", "EXECUTING", "SETTLING", "COMPLETED", "QUOTE_EXPIRED", "FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  CONFIRMING: ["EXECUTING", "SETTLING", "COMPLETED", "QUOTE_EXPIRED", "FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  // a reorg sends a leg back (EXECUTING → CONFIRMING, SETTLING → EXECUTING); nothing is re-sent
  EXECUTING: ["CONFIRMING", "SETTLING", "COMPLETED", "QUOTE_EXPIRED", "FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  SETTLING: ["EXECUTING", "COMPLETED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"],
  COMPLETED: [],
  QUOTE_EXPIRED: ["DRAFT", "QUOTING", "REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMING", "EXECUTING", "FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED", "CANCELLED"],
  FAILED: [],
  RECOVERY_REQUIRED: ["CONFIRMING", "EXECUTING", "SETTLING", "COMPLETED", "FAILED", "REFUNDING", "REFUNDED"],
  REFUNDING: ["REFUNDED", "RECOVERY_REQUIRED"],
  REFUNDED: [],
  CANCELLED: [],
};

/** The code a failure event carries when it names none (I-O3). */
export const DEFAULT_CODES: Partial<Record<OperationEvent["type"], string>> = { "quote-expired": "quote_expired", rejected: "user_rejected", delayed: "network_delayed" };

/** The states a delay can qualify: from the signature until the money arrived somewhere (spec v2.0 §12.1). */
export const DELAYABLE: readonly OperationState[] = ["AWAITING_SIGNATURE", "SIGNED", "SUBMITTED", "CONFIRMING", "EXECUTING", "SETTLING", "REFUNDING"];

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
const hasRefs = (ev: OperationEvent): boolean => REFS.some((k) => k in ev);

/** The catalog reason of a code (I-O3): an unknown code becomes `unknown` with the original kept in the detail. */
export function reasonOf(code: string | undefined, fallback: string, detail?: string): OperationReason {
  const c = code || fallback;
  if (hasCode(c)) return { code: c, fundsClass: CATALOG[c].fundsClass, ...(detail ? { detail } : {}) };
  return { code: "unknown", fundsClass: CATALOG.unknown.fundsClass, detail: detail ? `${c}: ${detail}` : c };
}

const hasSettlementRef = (ref: { leafIndex?: number; txHash?: string; destinationTx?: string; tracker?: boolean; jobId?: string } | undefined): boolean =>
  !!ref && (ref.leafIndex !== undefined || !!ref.txHash || !!ref.destinationTx || ref.tracker === true);

function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): T {
  const c = { ...o };
  for (const k of keys) delete c[k];
  return c;
}

/** A note joins the current state's history line (the history is one line per state). */
function withNote(rec: OperationRecord, note: string, at: number): OperationRecord {
  const last = rec.history[rec.history.length - 1];
  const line = last ? { ...last, note: last.note ? `${last.note}; ${note}` : note } : { state: rec.state, at, note };
  return { ...rec, updatedAt: at, history: last ? [...rec.history.slice(0, -1), line] : [line] };
}

/** The recovery's own state from where the money is: a refund is offered only when the escrow can return it (spec v2.0 §12.4). */
export function recoveryFor(rec: OperationRecord, code: string, at: number): NonNullable<OperationRecord["recovery"]> {
  const offered = rec.settlement !== undefined ? rec.settlement === "REFUND_AVAILABLE" : CATALOG[code]?.actions.includes("start-refund") === true;
  return { state: offered ? "refund-offered" : "monitoring", since: rec.recovery?.since ?? at, lastCheckedAt: at };
}
const SETTLEMENT_RECOVERY: Partial<Record<SettlementState, RecoveryState>> = { REFUND_AVAILABLE: "refund-offered", REFUNDING: "refunding", SOURCE_CONFIRMED: "monitoring", PROVIDER_PENDING: "monitoring", DESTINATION_PENDING: "monitoring" };

const same = (a: OperationRecord, b: OperationRecord): boolean => JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });

/** The events that change fields, not the state. */
function fieldEvent(rec: OperationRecord, ev: OperationEvent, at: number): TransitionResult {
  switch (ev.type) {
    case "progress": return { ok: true, changed: true, record: { ...rec, updatedAt: at, progress: { step: ev.step, ...(ev.i !== undefined ? { i: ev.i } : {}), ...(ev.n !== undefined ? { n: ev.n } : {}) } } };
    case "monitor": {
      const since = rec.recovery?.since ?? at;
      return { ok: true, changed: true, record: { ...rec, updatedAt: at, recovery: { ...(rec.recovery ?? {}), state: rec.recovery?.state ?? "monitoring", since, lastCheckedAt: ev.at ?? at } } };
    }
    case "note": return { ok: true, changed: true, record: withNote(rec, ev.note, at) };
    case "costs": {
      // V6 (spec v2.0 §3): the costs merge; a deviation joins the history as a note
      const costs = { ...(rec.costs ?? {}), ...ev.costs };
      return { ok: true, changed: true, record: costNotes(costs).reduce<OperationRecord>((r, n) => withNote(r, n, at), { ...rec, updatedAt: at, costs }) };
    }
    case "delayed": {
      // V6: a delay qualifies the phase the state names (I-O5); it ends with the next state event
      if (!DELAYABLE.includes(rec.state)) return { ok: false, record: rec, reason: "not-allowed" };
      const { code } = reasonOf(ev.code, DEFAULT_CODES.delayed!, ev.detail);
      let next: OperationRecord = { ...rec, updatedAt: at, delayed: { since: rec.delayed?.since ?? at, code }, recovery: { ...(rec.recovery ?? {}), state: rec.recovery?.state ?? "monitoring", since: rec.recovery?.since ?? at, lastCheckedAt: at } };
      if (hasRefs(ev)) next = { ...next, refs: mergeRefs(next.refs, ev as EventRefs) };
      return same(next, rec) ? { ok: true, changed: false, record: rec } : { ok: true, changed: true, record: next };
    }
    case "settlement": {
      // V6 (spec v2.0 §12.4): where the money is; an open recovery follows it
      if (rec.settlement === ev.settlement) return { ok: true, changed: false, record: rec };
      const follows = rec.recovery && rec.state === "RECOVERY_REQUIRED" ? SETTLEMENT_RECOVERY[ev.settlement] : undefined;
      return { ok: true, changed: true, record: { ...rec, updatedAt: at, settlement: ev.settlement, ...(follows && rec.recovery ? { recovery: { ...rec.recovery, state: follows, lastCheckedAt: at } } : {}) } };
    }
    default: return { ok: true, changed: false, record: rec };
  }
}

/** Apply one event; the record is never mutated. */
export function transition(rec: OperationRecord, ev: OperationEvent, now = Date.now()): TransitionResult {
  const at = Math.max(now, rec.updatedAt); // I-O2
  if (TERMINAL_STATES.includes(rec.state)) return { ok: false, record: rec, reason: "terminal" }; // I-O1
  let target = ev.type === "resume" ? ev.to : STATE_EVENT_TARGET[ev.type];
  if (target === null) return fieldEvent(rec, ev, at);
  if ((ev.type === "submission-failed" || ev.type === "provider-failed" || ev.type === "recovery-required") && !ev.code) return { ok: false, record: rec, reason: "needs-code" };

  // I-O3: a failure state's reason — the event's code, its default, or (a resume) the record's own
  const code = "code" in ev ? ev.code : undefined;
  const detail = "detail" in ev ? ev.detail : undefined;
  const reason = FAILURE_STATES.includes(target) ? (ev.type === "resume" && rec.reason ? rec.reason : reasonOf(code, DEFAULT_CODES[ev.type] ?? "unknown", detail)) : undefined;
  if (target === "FAILED" && reason) target = failureTarget(reason); // I-O6

  const self = target === rec.state;
  if (!self && !ALLOWED[rec.state].includes(target)) return { ok: false, record: rec, reason: "not-allowed" };
  if (PRE_SUBMISSION_STATES.includes(target) && wasSubmitted(rec)) return { ok: false, record: rec, reason: "after-submission" }; // I-O7
  if (target === "COMPLETED" && !(ev.type === "completed" && hasSettlementRef(ev.ref))) return { ok: false, record: rec, reason: "needs-settlement-ref" }; // I-O4

  const note = ev.type === "cancel" ? ev.note : undefined;
  let next: OperationRecord = self ? { ...rec, updatedAt: at } : { ...rec, state: target, updatedAt: at, history: [...rec.history, { state: target, at, ...(note ? { note } : {}) }] };
  if (hasRefs(ev)) next = { ...next, refs: mergeRefs(next.refs, ev as EventRefs) };
  next = omit(next, "delayed"); // a state event ends a delay
  if (reason) {
    next = { ...omit(next, "progress"), reason };
    if (target === "RECOVERY_REQUIRED") next = { ...next, recovery: recoveryFor(next, reason.code, at) };
  } else {
    next = omit(next, "reason");
    if (target !== "AWAITING_SIGNATURE") next = omit(next, "progress");
  }
  switch (ev.type) {
    case "quoted": next = { ...next, amounts: { ...next.amounts, ...(ev.expectedOutput !== undefined ? { expectedOutput: ev.expectedOutput } : {}), ...(ev.minimumOutput !== undefined ? { minimumOutput: ev.minimumOutput } : {}) } }; break;
    case "confirm": next = omit(ev.checklist ? { ...next, protectedExecution: { checklist: ev.checklist } } : next, "declined"); break;
    case "rejected": next = { ...next, declined: { at, code: reasonOf(ev.code, DEFAULT_CODES.rejected!).code } }; break;
    case "completed":
      next = { ...next, amounts: { ...next.amounts, ...(ev.delivered !== undefined ? { delivered: ev.delivered } : {}) }, refs: mergeRefs(next.refs, { ...(ev.ref.txHash ? { txHash: ev.ref.txHash } : {}), ...(ev.ref.jobId ? { jobId: ev.ref.jobId } : {}) }) };
      if (ev.ref.leafIndex !== undefined) next = { ...next, refs: { ...next.refs, leafIndex: ev.ref.leafIndex } };
      if (ev.ref.destinationTx) next = { ...next, refs: { ...next.refs, executionTx: next.refs.executionTx ?? ev.ref.destinationTx } };
      if (rec.recovery) next = { ...next, recovery: { ...rec.recovery, state: "resolved", lastCheckedAt: at } };
      if (next.settlement) next = { ...next, settlement: "COMPLETED" }; // the money arrived
      break;
    case "refunding": next = { ...next, recovery: { state: "refunding", since: rec.recovery?.since ?? at, lastCheckedAt: at } }; break;
    case "refunded":
      next = { ...next, recovery: { state: "refunded", since: rec.recovery?.since ?? at, lastCheckedAt: at }, amounts: { ...next.amounts, ...(ev.refunded !== undefined ? { delivered: ev.refunded } : {}) } };
      if (ev.ref.leafIndex !== undefined) next = { ...next, refs: { ...next.refs, leafIndex: ev.ref.leafIndex } };
      if (ev.ref.txHash && !next.refs.txHashes.includes(ev.ref.txHash)) next = { ...next, refs: { ...next.refs, txHashes: [...next.refs.txHashes, ev.ref.txHash] } };
      if (next.settlement) next = { ...next, settlement: "COMPLETED" }; // the refund arrived
      break;
    default: break;
  }
  const swap = rec.kind === "swap" || rec.kind === "cross-chain";
  if (target === "AWAITING_SIGNATURE" || target === "SIGNED") next = { ...next, phase: "funding" };
  if (target === "SUBMITTED") next = { ...next, phase: swap ? "funding" : (next.phase ?? "execution") };
  if (target === "CONFIRMING") next = { ...next, phase: swap ? "funding" : "settlement" };
  if (target === "EXECUTING") next = { ...next, phase: "execution" };
  if (target === "SETTLING") next = { ...next, phase: "settlement" };
  if (self && same(next, rec)) return { ok: true, changed: false, record: rec };
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
