// The operation state machine's reducer (spec v2.0 §12): the table's happy paths for a send and a swap, the invariants
// I-O1 (a terminal state never changes), I-O2 (monotone timestamps), I-O3 (every failure carries a catalog reason),
// I-O4 (COMPLETED needs a settlement reference), I-O6 (FAILED only for funds not moved or still protected), I-O7 (after
// SUBMITTED never back before the submission), the field events — a delay and the settlement are attributes, a declined
// prompt goes back to the review — and the cancel rule.
import { describe, expect, it } from "vitest";
import { ALLOWED, DEFAULT_CODES, failureTarget, replay, transition } from "@privacy-wallet/sdk/operations/reducer";
import { CATALOG, CODES } from "@privacy-wallet/sdk/operations/errors/catalog";
import { STATE_EVENT_TARGET, type OperationEvent } from "@privacy-wallet/sdk/operations/types";
import { FAILURE_STATES, OPERATION_STATES, PRE_SUBMISSION_STATES, TERMINAL_STATES, type OperationRecord, type OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { record } from "../helpers/operations";

const at = (rec: OperationRecord, state: OperationState, history: OperationState[] = [state]): OperationRecord => record({ ...rec, state, history: history.map((s) => ({ state: s, at: rec.updatedAt })) });
const HASH = "0x" + "ab".repeat(32);

describe("the table's happy paths", () => {
  it("a private send: review → the signature's progress → the relayer → the receipt → completed, with the refs and the phases", () => {
    const events: OperationEvent[] = [
      { type: "review" }, { type: "confirm" }, { type: "progress", step: "fee-terms" }, { type: "progress", step: "merging", i: 1, n: 2 }, { type: "progress", step: "proof" },
      { type: "submitted", txHash: HASH, by: "relayer" }, { type: "confirming", txHash: HASH }, { type: "completed", ref: { txHash: HASH, leafIndex: 41 } },
    ];
    const { record: r, refused } = replay(record(), events, 2_000);
    expect(refused).toBeUndefined();
    expect(r.state).toBe("COMPLETED");
    expect(r.history.map((h) => h.state)).toEqual(["DRAFT", "REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMING", "COMPLETED"]);
    expect(r.refs).toEqual({ txHashes: [HASH], leafIndex: 41 });
    expect(r.phase).toBe("settlement");
    expect(r.progress).toBeUndefined();
    expect(r.reason).toBeUndefined();
  });
  it("a swap: quote → the review with the checklist → funding → the executor → the settlement → completed with what was delivered", () => {
    const events: OperationEvent[] = [
      { type: "quote" }, { type: "quoted", expectedOutput: "18000000", minimumOutput: "17600000", provider: "thorchain", quoteId: "q-1" }, { type: "review" },
      { type: "confirm", checklist: { destination: true, route: true, execution: true, limits: true } }, { type: "signed" }, { type: "submitted", jobId: "job-1", orderId: "order-1" },
      { type: "confirming" }, { type: "relayer-executing", executionTx: HASH }, { type: "verifying" }, { type: "settlement", settlement: "DESTINATION_PENDING" }, { type: "completed", ref: { tracker: true }, delivered: "17900000" },
    ];
    const { record: r, refused } = replay(record({ kind: "cross-chain", tier: "large-protected" }), events, 2_000);
    expect(refused).toBeUndefined();
    expect(r.state).toBe("COMPLETED");
    expect(r.history.map((h) => h.state), "a re-quote in the review is no new line").toEqual(["DRAFT", "QUOTING", "REVIEW", "AWAITING_SIGNATURE", "SIGNED", "SUBMITTED", "CONFIRMING", "EXECUTING", "SETTLING", "COMPLETED"]);
    expect(r.amounts).toMatchObject({ expectedOutput: "18000000", minimumOutput: "17600000", delivered: "17900000" });
    expect(r.refs).toEqual({ txHashes: [], provider: "thorchain", quoteId: "q-1", jobId: "job-1", orderId: "order-1", executionTx: HASH });
    expect(r.protectedExecution).toEqual({ checklist: { destination: true, route: true, execution: true, limits: true } });
    expect(r.settlement, "the completion settles the settlement").toBe("COMPLETED");
    expect(r.phase).toBe("settlement");
  });
  it("a protect: the wallet prompt is AWAITING_SIGNATURE with progress; the hash is SUBMITTED, the receipt pending CONFIRMING, the leaf COMPLETED", () => {
    const { record: r } = replay(record({ kind: "protect" }), [{ type: "review" }, { type: "confirm" }, { type: "progress", step: "submitting", i: 1, n: 2 }, { type: "submitted", txHash: HASH, by: "wallet" }, { type: "confirming", txHash: HASH }, { type: "completed", ref: { txHash: HASH, leafIndex: 7 } }], 5_000);
    expect(r.state).toBe("COMPLETED");
    expect(r.refs.leafIndex).toBe(7);
    expect(r.v).toBeUndefined(); // the helper's record; the store writes `v: 2`
  });
});

describe("the invariants", () => {
  it("I-O1: a terminal state never changes, whatever the event", () => {
    for (const s of TERMINAL_STATES) for (const ev of [{ type: "review" }, { type: "cancel" }, { type: "completed", ref: { tracker: true } }, { type: "refunded", ref: { tracker: true } }, { type: "progress", step: "proof" }, { type: "settlement", settlement: "COMPLETED" }, { type: "delayed" }] as OperationEvent[]) {
      const t = transition(at(record(), s), ev, 9_000);
      expect(t.ok).toBe(false);
      if (!t.ok) expect(t.reason).toBe("terminal");
    }
    expect(TERMINAL_STATES).toEqual(["COMPLETED", "REFUNDED", "CANCELLED", "FAILED"]);
  });
  it("I-O4: COMPLETED needs a settlement reference — a leaf, a hash, a destination transaction or the tracker's completion", () => {
    const open = at(record(), "SUBMITTED");
    for (const ref of [{}, { jobId: "j" }, { tracker: false }]) {
      const t = transition(open, { type: "completed", ref }, 9_000);
      expect(t.ok).toBe(false);
      if (!t.ok) expect(t.reason).toBe("needs-settlement-ref");
    }
    for (const ref of [{ leafIndex: 0 }, { txHash: HASH }, { destinationTx: HASH }, { tracker: true }]) expect(transition(open, { type: "completed", ref }, 9_000).ok).toBe(true);
  });
  it("I-O3: every failure carries a catalog reason — the event's default, the named code, or `unknown` with the original kept as the detail", () => {
    expect(DEFAULT_CODES).toEqual({ "quote-expired": "quote_expired", rejected: "user_rejected", delayed: "network_delayed" });
    const expired = transition(at(record(), "REVIEW"), { type: "quote-expired" }, 9_000);
    expect(expired.ok && expired.record.reason).toEqual({ code: "quote_expired", fundsClass: "not-moved" });
    const missing = transition(at(record(), "SUBMITTED"), { type: "submission-failed", code: "" }, 9_000);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("needs-code");
    const named = transition(at(record(), "AWAITING_SIGNATURE"), { type: "submission-failed", code: "simulation_failed", detail: "UnknownRoot()" }, 9_000);
    expect(named.ok && named.record).toMatchObject({ state: "FAILED", reason: { code: "simulation_failed", fundsClass: "not-moved", detail: "UnknownRoot()" } });
    const strange = transition(at(record(), "EXECUTING"), { type: "provider-failed", code: "nope_never_seen", detail: "x" }, 9_000);
    expect(strange.ok && strange.record.reason).toEqual({ code: "unknown", fundsClass: "unknown", detail: "nope_never_seen: x" });
    expect(strange.ok && strange.record.recovery?.state).toBe("monitoring");
    for (const s of FAILURE_STATES) expect(OPERATION_STATES).toContain(s);
    expect(FAILURE_STATES).toEqual(["QUOTE_EXPIRED", "FAILED", "RECOVERY_REQUIRED"]);
  });
  it("I-O6: FAILED only when the funds did not move or are still protected and nothing is left to track or return — an unknown outcome needs recovery", () => {
    expect(failureTarget({ code: "bad_fee", fundsClass: "not-moved" })).toBe("FAILED");
    expect(failureTarget({ code: "receipt_reverted", fundsClass: "not-moved" })).toBe("FAILED");
    expect(failureTarget({ code: "send_failed", fundsClass: "unknown" })).toBe("RECOVERY_REQUIRED");
    expect(failureTarget({ code: "relayer_unreachable", fundsClass: "unknown" })).toBe("RECOVERY_REQUIRED");
    expect(failureTarget({ code: "nullifier_in_flight", fundsClass: "still-protected" }), "something is in flight: tracked, not final").toBe("RECOVERY_REQUIRED");
    expect(failureTarget({ code: "bad_deadlines", fundsClass: "still-protected" }), "the escrow can be returned: not final").toBe("RECOVERY_REQUIRED");
    expect(failureTarget({ code: "nope", fundsClass: "not-moved" }), "an unknown code is unknown").toBe("RECOVERY_REQUIRED");
    for (const code of CODES) {
      const t = transition(at(record(), "AWAITING_SIGNATURE"), { type: "submission-failed", code }, 9_000);
      expect(t.ok, code).toBe(true);
      if (!t.ok) continue;
      if (t.record.state === "FAILED") expect(["not-moved", "still-protected"], code).toContain(t.record.reason!.fundsClass);
      if (CATALOG[code].fundsClass === "unknown") expect(t.record.state, code).toBe("RECOVERY_REQUIRED");
    }
    const settling = transition(at(record(), "SETTLING", ["SUBMITTED", "SETTLING"]), { type: "submission-failed", code: "bad_fee" }, 9_000);
    expect(settling.ok, "money on its way never fails finally").toBe(false);
  });
  it("I-O7: once submitted a record never returns to a state before its submission — nothing is ever re-sent", () => {
    const expiredAfterFunding = at(record({ kind: "swap" }), "QUOTE_EXPIRED", ["AWAITING_SIGNATURE", "SUBMITTED", "QUOTE_EXPIRED"]);
    for (const ev of [{ type: "review" }, { type: "edit" }, { type: "quote" }, { type: "confirm" }, { type: "resume", to: "SIGNED" }] as OperationEvent[]) {
      const t = transition(expiredAfterFunding, ev, 9_000);
      expect(t.ok, ev.type).toBe(false);
      if (!t.ok) expect(t.reason, ev.type).toBe(ev.type === "resume" ? "not-allowed" : "after-submission");
    }
    expect(transition(expiredAfterFunding, { type: "resume", to: "EXECUTING" }, 9_000).ok, "the price accepted: execution resumes").toBe(true);
    const expiredBefore = at(record({ kind: "swap" }), "QUOTE_EXPIRED", ["QUOTING", "QUOTE_EXPIRED"]);
    expect(transition(expiredBefore, { type: "review" }, 9_000).ok, "before the submission a new quote is a review").toBe(true);
    expect(PRE_SUBMISSION_STATES).toEqual(["DRAFT", "QUOTING", "REVIEW", "AWAITING_SIGNATURE", "SIGNED"]);
  });
  it("I-O2: timestamps never go backwards — a clock behind the record's last update is lifted to it", () => {
    const r = at(record({ updatedAt: 50_000 }), "REVIEW");
    const t = transition(r, { type: "confirm" }, 10_000);
    expect(t.ok && t.record.updatedAt).toBe(50_000);
    expect(t.ok && t.record.history[t.record.history.length - 1].at).toBe(50_000);
    const { record: r2 } = replay(r, [{ type: "confirm" }, { type: "progress", step: "proof" }, { type: "submitted", txHash: HASH }], 10_000);
    for (let i = 1; i < r2.history.length; i++) expect(r2.history[i].at).toBeGreaterThanOrEqual(r2.history[i - 1].at);
  });
});

describe("the table", () => {
  it("covers every state with known targets only; the terminal rows are empty; the events' targets are states of the list", () => {
    expect(Object.keys(ALLOWED).sort()).toEqual([...OPERATION_STATES].sort());
    for (const [from, tos] of Object.entries(ALLOWED)) {
      for (const to of tos) expect(OPERATION_STATES, `${from} → ${to}`).toContain(to);
      expect(tos.includes(from as OperationState), `${from}: a self-transition is a field update, not a table row`).toBe(false);
    }
    for (const s of TERMINAL_STATES) expect(ALLOWED[s]).toEqual([]);
    for (const target of Object.values(STATE_EVENT_TARGET)) if (target !== null) expect(OPERATION_STATES).toContain(target);
    expect(OPERATION_STATES).toHaveLength(16);
  });
  it("refuses what the table does not allow: DRAFT → SUBMITTED, REVIEW → COMPLETED, SUBMITTED → DRAFT, REFUNDING → COMPLETED", () => {
    const refused = (s: OperationState, ev: OperationEvent, history?: OperationState[]) => { const t = transition(at(record(), s, history), ev, 9_000); return t.ok ? "ok" : t.reason; };
    expect(refused("DRAFT", { type: "submitted", txHash: HASH })).toBe("not-allowed");
    expect(refused("REVIEW", { type: "completed", ref: { tracker: true } })).toBe("not-allowed");
    expect(refused("SUBMITTED", { type: "edit" })).toBe("not-allowed");
    expect(refused("REFUNDING", { type: "completed", ref: { tracker: true } })).toBe("not-allowed");
    expect(refused("SUBMITTED", { type: "cancel" }), "nothing in flight is cancelled from the wallet").toBe("not-allowed");
    expect(refused("DRAFT", { type: "cancel" })).toBe("ok");
    expect(refused("REVIEW", { type: "cancel" }), "a declined prompt's review can be closed").toBe("ok");
    expect(refused("QUOTE_EXPIRED", { type: "cancel" }, ["QUOTING", "QUOTE_EXPIRED"]), "an expired quote before anything moved can be closed").toBe("ok");
    expect(refused("RECOVERY_REQUIRED", { type: "cancel" }, ["SUBMITTED", "RECOVERY_REQUIRED"]), "a recovery is never cancelled").toBe("not-allowed");
  });
  it("progress, monitor, delay and settlement change fields, not the state; a note joins the state's history line; a resume returns through the table", () => {
    const r = at(record(), "AWAITING_SIGNATURE");
    const p = transition(r, { type: "progress", step: "merging", i: 1, n: 3 }, 9_000);
    expect(p.ok && p.record).toMatchObject({ state: "AWAITING_SIGNATURE", progress: { step: "merging", i: 1, n: 3 } });
    expect(p.ok && p.record.history).toHaveLength(1);
    const m = transition(at(record(), "CONFIRMING"), { type: "monitor", at: 12_000 }, 9_000);
    expect(m.ok && m.record).toMatchObject({ state: "CONFIRMING", recovery: { state: "monitoring", since: 9_000, lastCheckedAt: 12_000 } });
    const n = transition(r, { type: "note", note: "approval 0xabc" }, 9_000);
    expect(n.ok && n.record.history, "a note joins the current state's line").toEqual([{ state: "AWAITING_SIGNATURE", at: 1_000, note: "approval 0xabc" }]);
    const twice = transition(n.ok ? n.record : r, { type: "note", note: "second" }, 9_001);
    expect(twice.ok && twice.record.history[0].note).toBe("approval 0xabc; second");
    const back = transition(at(record({ kind: "swap" }), "QUOTE_EXPIRED", ["SUBMITTED", "QUOTE_EXPIRED"]), { type: "resume", to: "CONFIRMING" }, 9_000);
    expect(back.ok && back.record.state).toBe("CONFIRMING");
    const bad = transition(at(record(), "QUOTE_EXPIRED"), { type: "resume", to: "COMPLETED" }, 9_000);
    expect(bad.ok).toBe(false);
    const s = transition(at(record({ kind: "swap" }), "EXECUTING"), { type: "settlement", settlement: "PROVIDER_PENDING" }, 9_000);
    expect(s.ok && s.record).toMatchObject({ state: "EXECUTING", settlement: "PROVIDER_PENDING" });
    const again = transition(s.ok ? s.record : r, { type: "settlement", settlement: "PROVIDER_PENDING" }, 9_100);
    expect(again.ok && again.changed, "the same settlement writes nothing").toBe(false);
  });
  it("a delay is an attribute of the phase's state (I-O5): it keeps its start, a state event ends it; on a draft or a terminal record it is refused", () => {
    const d1 = transition(at(record(), "SUBMITTED"), { type: "delayed" }, 9_000);
    expect(d1.ok && d1.record).toMatchObject({ state: "SUBMITTED", delayed: { since: 9_000, code: "network_delayed" }, recovery: { state: "monitoring", since: 9_000 } });
    expect(d1.ok && d1.record.reason, "a delay is not a failure").toBeUndefined();
    const d2 = transition(d1.ok ? d1.record : record(), { type: "delayed", code: "provider_timeout" }, 12_000);
    expect(d2.ok && d2.record.delayed).toEqual({ since: 9_000, code: "provider_timeout" });
    const moved = transition(d2.ok ? d2.record : record(), { type: "confirming", txHash: HASH }, 13_000);
    expect(moved.ok && moved.record).toMatchObject({ state: "CONFIRMING" });
    expect(moved.ok && moved.record.delayed).toBeUndefined();
    const same = transition(at(record({ kind: "swap" }), "EXECUTING"), { type: "delayed", code: "provider_timeout" }, 9_000);
    const resumed = transition(same.ok ? same.record : record(), { type: "relayer-executing" }, 9_500);
    expect(resumed.ok && resumed.record, "the same state confirmed by its event ends the delay without a new line").toMatchObject({ state: "EXECUTING", history: [{ state: "EXECUTING" }] });
    expect(resumed.ok && resumed.record.delayed).toBeUndefined();
    expect(transition(at(record(), "REVIEW"), { type: "delayed" }, 9_000).ok).toBe(false);
  });
  it("a declined prompt goes back to the review with `declined` (nothing was signed); the next confirmation clears it", () => {
    const d = transition(at(record(), "AWAITING_SIGNATURE", ["DRAFT", "REVIEW", "AWAITING_SIGNATURE"]), { type: "rejected" }, 9_000);
    expect(d.ok && d.record).toMatchObject({ state: "REVIEW", declined: { at: 9_000, code: "user_rejected" } });
    expect(d.ok && d.record.reason).toBeUndefined();
    const c = transition(d.ok ? d.record : record(), { type: "confirm" }, 9_500);
    expect(c.ok && c.record.state).toBe("AWAITING_SIGNATURE");
    expect(c.ok && c.record.declined).toBeUndefined();
    expect(transition(at(record(), "SUBMITTED"), { type: "rejected" }, 9_000).ok, "a prompt after the submission is not this record's").toBe(false);
  });
  it("a recovery follows the settlement: a refund is offered when the escrow can return it; refund-offered → refunding → refunded ends terminal", () => {
    const pending = transition({ ...at(record({ kind: "swap", refs: { txHashes: [], orderId: "0x1" } }), "EXECUTING", ["SUBMITTED", "EXECUTING"]), settlement: "PROVIDER_PENDING" }, { type: "provider-failed", code: "execute_failed" }, 9_000);
    expect(pending.ok && pending.record.recovery?.state, "the money left the escrow: watch, no refund").toBe("monitoring");
    const r = replay({ ...at(record({ kind: "swap" }), "EXECUTING", ["SUBMITTED", "EXECUTING"]), settlement: "REFUND_AVAILABLE" }, [{ type: "recovery-required", code: "execute_failed" }, { type: "refunding", jobId: "job-9" }, { type: "refunded", ref: { txHash: HASH }, refunded: "1000" }], 9_000);
    expect(r.refused).toBeUndefined();
    expect(r.record.state).toBe("REFUNDED");
    expect(r.record.recovery).toMatchObject({ state: "refunded" });
    expect(r.record.refs).toMatchObject({ jobId: "job-9", txHashes: [HASH] });
    expect(r.record.settlement).toBe("COMPLETED");
    expect(r.record.history.map((h) => h.state)).toEqual(["SUBMITTED", "EXECUTING", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"]);
    const offered = transition({ ...at(record({ kind: "swap" }), "EXECUTING", ["SUBMITTED", "EXECUTING"]), settlement: "REFUND_AVAILABLE" }, { type: "recovery-required", code: "execute_failed" }, 9_000);
    expect(offered.ok && offered.record.recovery?.state).toBe("refund-offered");
    const seen = replay(r.record, [{ type: "note", note: "late" }], 20_000);
    expect(seen.refused?.reason).toBe("terminal");
  });
});
