// The operation state machine's reducer (spec §12): the table's happy paths for a send and a swap, the invariants
// I-O1 (a terminal state never changes), I-O2 (monotone timestamps), I-O3 (every failure carries a catalog reason),
// I-O4 (COMPLETED needs a settlement reference), the field events, a delay that recovers, the cancel rule.
import { describe, expect, it } from "vitest";
import { ALLOWED, DEFAULT_CODES, replay, transition } from "../../src/features/operations/reducer";
import { STATE_EVENT_TARGET, type OperationEvent } from "../../src/features/operations/types";
import { FAILURE_STATES, OPERATION_STATES, TERMINAL_STATES, type OperationRecord, type OperationState } from "../../src/wallet/operationRecord";
import { record } from "../helpers/operations";

const at = (rec: OperationRecord, state: OperationState): OperationRecord => record({ ...rec, state, history: [{ state, at: rec.updatedAt }] });
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
    expect(r.history.map((h) => h.state)).toEqual(["DRAFT", "REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "NETWORK_CONFIRMING", "COMPLETED"]);
    expect(r.refs).toEqual({ txHashes: [HASH], leafIndex: 41 });
    expect(r.phase).toBe("settlement");
    expect(r.progress).toBeUndefined();
    expect(r.failure).toBeUndefined();
  });
  it("a swap: quote → review with the checklist → funding → the executor → the network → the settlement → completed with what was delivered", () => {
    const events: OperationEvent[] = [
      { type: "quote" }, { type: "quoted", expectedOutput: "18000000", minimumOutput: "17600000", provider: "thorchain", quoteId: "q-1" }, { type: "review" },
      { type: "confirm", checklist: { destination: true, route: true, execution: true, limits: true } }, { type: "signed" }, { type: "submitted", jobId: "job-1", orderId: "order-1" },
      { type: "relayer-executing" }, { type: "confirming", executionTx: HASH }, { type: "verifying" }, { type: "completed", ref: { tracker: true }, delivered: "17900000" },
    ];
    const { record: r, refused } = replay(record({ kind: "cross-chain", tier: "large-protected" }), events, 2_000);
    expect(refused).toBeUndefined();
    expect(r.state).toBe("COMPLETED");
    expect(r.history.map((h) => h.state)).toEqual(["DRAFT", "QUOTING", "QUOTE_READY", "REVIEW", "AWAITING_SIGNATURE", "SIGNED", "SUBMITTED", "RELAYER_EXECUTING", "NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED"]);
    expect(r.amounts).toMatchObject({ expectedOutput: "18000000", minimumOutput: "17600000", delivered: "17900000" });
    expect(r.refs).toEqual({ txHashes: [], provider: "thorchain", quoteId: "q-1", jobId: "job-1", orderId: "order-1", executionTx: HASH });
    expect(r.protectedExecution).toEqual({ checklist: { destination: true, route: true, execution: true, limits: true } });
  });
  it("a protect: the wallet prompt is AWAITING_SIGNATURE with progress; the hash is SUBMITTED, the receipt pending NETWORK_CONFIRMING, the leaf COMPLETED", () => {
    const { record: r } = replay(record({ kind: "protect" }), [{ type: "review" }, { type: "confirm" }, { type: "progress", step: "submitting", i: 1, n: 2 }, { type: "submitted", txHash: HASH, by: "wallet" }, { type: "confirming", txHash: HASH }, { type: "completed", ref: { txHash: HASH, leafIndex: 7 } }], 5_000);
    expect(r.state).toBe("COMPLETED");
    expect(r.refs.leafIndex).toBe(7);
  });
});

describe("the invariants", () => {
  it("I-O1: a terminal state never changes, whatever the event", () => {
    for (const s of TERMINAL_STATES) for (const ev of [{ type: "review" }, { type: "cancel" }, { type: "completed", ref: { tracker: true } }, { type: "refunded", ref: { tracker: true } }, { type: "progress", step: "proof" }] as OperationEvent[]) {
      const t = transition(at(record(), s), ev, 9_000);
      expect(t.ok).toBe(false);
      if (!t.ok) expect(t.reason).toBe("terminal");
    }
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
    const rejected = transition(at(record(), "AWAITING_SIGNATURE"), { type: "rejected" }, 9_000);
    expect(rejected.ok && rejected.record.failure).toEqual({ code: "user_rejected", class: "not-moved" });
    const delayed = transition(at(record(), "SUBMITTED"), { type: "delayed" }, 9_000);
    expect(delayed.ok && delayed.record.failure).toEqual({ code: "network_delayed", class: "still-protected" });
    expect(delayed.ok && delayed.record.recovery).toMatchObject({ state: "monitoring", since: 9_000, lastCheckedAt: 9_000 });
    const missing = transition(at(record(), "SUBMITTED"), { type: "submission-failed", code: "" }, 9_000);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("needs-code");
    const named = transition(at(record(), "AWAITING_SIGNATURE"), { type: "submission-failed", code: "simulation_failed", detail: "UnknownRoot()" }, 9_000);
    expect(named.ok && named.record.failure).toEqual({ code: "simulation_failed", class: "not-moved", detail: "UnknownRoot()" });
    const strange = transition(at(record(), "RELAYER_EXECUTING"), { type: "provider-failed", code: "nope_never_seen", detail: "x" }, 9_000);
    expect(strange.ok && strange.record.failure).toEqual({ code: "unknown", class: "unknown", detail: "nope_never_seen: x" });
    expect(strange.ok && strange.record.recovery?.state).toBe("monitoring");
    const needs = transition(at(record(), "NETWORK_CONFIRMING"), { type: "recovery-required", code: "partial_delivery" }, 9_000);
    expect(needs.ok && needs.record.recovery?.state).toBe("refund-offered");
    for (const s of FAILURE_STATES) expect(OPERATION_STATES).toContain(s);
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
      expect(tos.includes(from as OperationState), `${from} never targets itself`).toBe(false);
    }
    for (const s of TERMINAL_STATES) expect(ALLOWED[s]).toEqual([]);
    for (const target of Object.values(STATE_EVENT_TARGET)) if (target !== null) expect(OPERATION_STATES).toContain(target);
    expect(OPERATION_STATES).toHaveLength(20);
  });
  it("refuses what the table does not allow: DRAFT → SUBMITTED, QUOTE_READY → COMPLETED, SUBMITTED → DRAFT, REFUNDING → COMPLETED", () => {
    const refused = (s: OperationState, ev: OperationEvent) => { const t = transition(at(record(), s), ev, 9_000); return t.ok ? "ok" : t.reason; };
    expect(refused("DRAFT", { type: "submitted", txHash: HASH })).toBe("not-allowed");
    expect(refused("QUOTE_READY", { type: "completed", ref: { tracker: true } })).toBe("not-allowed");
    expect(refused("SUBMITTED", { type: "edit" })).toBe("not-allowed");
    expect(refused("REFUNDING", { type: "completed", ref: { tracker: true } })).toBe("not-allowed");
    expect(refused("SUBMITTED", { type: "cancel" }), "nothing in flight is cancelled from the wallet").toBe("not-allowed");
    expect(refused("DRAFT", { type: "cancel" })).toBe("ok");
    expect(refused("SIGNATURE_REJECTED", { type: "cancel" })).toBe("ok");
    expect(refused("SUBMISSION_FAILED", { type: "cancel" }), "a failure before anything moved can be closed").toBe("ok");
  });
  it("progress and monitor change fields, not the state; a note joins the state's history line; a resume returns to an open state through the table", () => {
    const r = at(record(), "AWAITING_SIGNATURE");
    const p = transition(r, { type: "progress", step: "merging", i: 1, n: 3 }, 9_000);
    expect(p.ok && p.record).toMatchObject({ state: "AWAITING_SIGNATURE", progress: { step: "merging", i: 1, n: 3 } });
    expect(p.ok && p.record.history).toHaveLength(1);
    const m = transition(at(record(), "NETWORK_DELAYED"), { type: "monitor", at: 12_000 }, 9_000);
    expect(m.ok && m.record).toMatchObject({ state: "NETWORK_DELAYED", recovery: { state: "monitoring", since: 9_000, lastCheckedAt: 12_000 } });
    const n = transition(r, { type: "note", note: "approval 0xabc" }, 9_000);
    expect(n.ok && n.record.history, "a note joins the current state's line").toEqual([{ state: "AWAITING_SIGNATURE", at: 1_000, note: "approval 0xabc" }]);
    const twice = transition(n.ok ? n.record : r, { type: "note", note: "second" }, 9_001);
    expect(twice.ok && twice.record.history[0].note).toBe("approval 0xabc; second");
    const back = transition(at(record(), "QUOTE_EXPIRED"), { type: "resume", to: "NETWORK_CONFIRMING" }, 9_000);
    expect(back.ok && back.record.state).toBe("NETWORK_CONFIRMING");
    const bad = transition(at(record(), "QUOTE_EXPIRED"), { type: "resume", to: "COMPLETED" }, 9_000);
    expect(bad.ok).toBe(false);
  });
  it("a delay recovers and clears the failure; a recovery goes refund-offered → refunding → refunded and ends terminal", () => {
    const delayed = replay(at(record(), "SUBMITTED"), [{ type: "delayed" }, { type: "confirming", txHash: HASH }], 9_000).record;
    expect(delayed).toMatchObject({ state: "NETWORK_CONFIRMING", failure: undefined });
    const r = replay(at(record({ kind: "swap" }), "NETWORK_CONFIRMING"), [{ type: "recovery-required", code: "execute_failed" }, { type: "refunding", jobId: "job-9" }, { type: "refunded", ref: { txHash: HASH }, refunded: "1000" }], 9_000);
    expect(r.refused).toBeUndefined();
    expect(r.record.state).toBe("REFUNDED");
    expect(r.record.recovery).toMatchObject({ state: "refunded" });
    expect(r.record.refs).toMatchObject({ jobId: "job-9", txHashes: [HASH] });
    expect(r.record.history.map((h) => h.state)).toEqual(["NETWORK_CONFIRMING", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED"]);
    const seen = replay(r.record, [{ type: "note", note: "late" }], 20_000);
    expect(seen.refused?.reason).toBe("terminal");
  });
});
