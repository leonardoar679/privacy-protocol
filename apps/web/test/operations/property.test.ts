// The spec's §12 invariants under 2,000 random event sequences (spec v2.0 §12.3): whatever the order of events, a
// terminal state is final (I-O1), the history's timestamps are monotone (I-O2), a failure state always carries a catalog
// reason (I-O3), COMPLETED is only ever reached through a settlement reference (I-O4), FAILED only for funds that did
// not move or are still protected (I-O6), and a submitted record never returns to a state before its submission (I-O7);
// the state is one of the list, the last history line is the state, a delay never sits on a draft or a terminal record.
import { describe, expect, it } from "vitest";
import { transition } from "@privacy-wallet/sdk/operations/reducer";
import { CODES } from "@privacy-wallet/sdk/operations/errors/catalog";
import type { OperationEvent } from "@privacy-wallet/sdk/operations/types";
import { FAILURE_STATES, OPERATION_STATES, PRE_SUBMISSION_STATES, SETTLEMENT_STATES, SUBMITTED_STATES, TERMINAL_STATES, isDraft, type OperationRecord, type OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { OPERATION_STATES as CONTRACT_STATES } from "@privacy-wallet/protocol-types";
import { record } from "../helpers/operations";

// mulberry32: consecutive draws are independent enough that an event's kind and its reference are not correlated (an LCG's are)
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(rng: () => number, xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
const HASH = "0x" + "cd".repeat(32);
const STEPS = ["fee-terms", "merging", "syncing", "verifying", "witness", "proof", "local-verify", "submitting"] as const;

function randomEvent(rng: () => number): OperationEvent {
  const code = rng() < 0.85 ? pick(rng, CODES) : "made_up_" + Math.floor(rng() * 100);
  const ref = rng() < 0.6 ? pick(rng, [{ leafIndex: Math.floor(rng() * 100) }, { txHash: HASH }, { destinationTx: HASH }, { tracker: true as const }]) : pick(rng, [{}, { jobId: "j" }, { tracker: false as const }]);
  const kinds: (() => OperationEvent)[] = [
    () => ({ type: "quote" }), () => ({ type: "quoted", expectedOutput: "10", minimumOutput: "9" }), () => ({ type: "review" }), () => ({ type: "edit" }), () => ({ type: "confirm" }),
    () => ({ type: "progress", step: pick(rng, STEPS), i: 1, n: 2 }), () => ({ type: "signed" }), () => ({ type: "submitted", txHash: HASH, by: "relayer" }), () => ({ type: "relayer-executing", jobId: "job" }),
    () => ({ type: "confirming" }), () => ({ type: "verifying" }), () => ({ type: "completed", ref, delivered: "9" }), () => ({ type: "quote-expired" }), () => ({ type: "rejected" }),
    () => ({ type: "submission-failed", code }), () => ({ type: "delayed", code }), () => ({ type: "provider-failed", code }), () => ({ type: "recovery-required", code }), () => ({ type: "refunding" }),
    () => ({ type: "refunded", ref }), () => ({ type: "cancel" }), () => ({ type: "resume", to: pick(rng, OPERATION_STATES) }), () => ({ type: "monitor" }), () => ({ type: "note", note: "n" }),
    () => ({ type: "settlement", settlement: pick(rng, SETTLEMENT_STATES) }), () => ({ type: "costs", costs: { actualWei: String(Math.floor(rng() * 1e6)) } }),
  ];
  return pick(rng, kinds)();
}

describe("spec v2.0 §12.3 — the invariants hold under random event sequences", () => {
  it("2,000 sequences of up to 40 events each", () => {
    const rng = seeded(11);
    let terminalReached = 0, completions = 0, failures = 0, refusals = 0, finalFailures = 0, afterSubmission = 0, delays = 0;
    for (let n = 0; n < 2000; n++) {
      let rec: OperationRecord = record({ kind: pick(rng, ["protect", "send", "withdraw", "swap", "cross-chain"] as const), updatedAt: 1_000 + Math.floor(rng() * 1000) });
      let clock = 1_000;
      const steps = 1 + Math.floor(rng() * 40);
      for (let i = 0; i < steps; i++) {
        clock += Math.floor(rng() * 1000) - 200; // the clock may run backwards; the record's may not
        const wasTerminal = TERMINAL_STATES.includes(rec.state);
        const ev = randomEvent(rng);
        const t = transition(rec, ev, clock);
        if (wasTerminal) { expect(t.ok, "I-O1").toBe(false); if (!t.ok) expect(t.reason).toBe("terminal"); expect(t.record).toBe(rec); continue; }
        if (!t.ok) { refusals++; if (t.reason === "after-submission") afterSubmission++; expect(t.record).toBe(rec); continue; }
        const next = t.record;
        expect(OPERATION_STATES).toContain(next.state);
        expect(next.updatedAt, "I-O2").toBeGreaterThanOrEqual(rec.updatedAt);
        for (let k = 1; k < next.history.length; k++) expect(next.history[k].at, "I-O2 history").toBeGreaterThanOrEqual(next.history[k - 1].at);
        expect(next.history[next.history.length - 1].state, "the last line is the state").toBe(next.state);
        if (FAILURE_STATES.includes(next.state)) { failures++; expect(next.reason, "I-O3").toBeDefined(); expect(CODES, "I-O3 a catalog code").toContain(next.reason!.code); }
        if (next.state === "FAILED") { finalFailures++; expect(["not-moved", "still-protected"], "I-O6").toContain(next.reason!.fundsClass); }
        if (next.state === "COMPLETED" && rec.state !== "COMPLETED") {
          completions++;
          expect(ev.type, "I-O4").toBe("completed");
          const r = (ev as { ref: { leafIndex?: number; txHash?: string; destinationTx?: string; tracker?: boolean } }).ref;
          expect(r.leafIndex !== undefined || !!r.txHash || !!r.destinationTx || r.tracker === true, "I-O4 a settlement reference").toBe(true);
        }
        if (next.history.some((h) => SUBMITTED_STATES.includes(h.state))) expect(PRE_SUBMISSION_STATES, "I-O7").not.toContain(next.state);
        if (next.delayed) { delays++; expect(isDraft(next.state) || TERMINAL_STATES.includes(next.state), "a delay qualifies an open state").toBe(false); }
        if (TERMINAL_STATES.includes(next.state)) terminalReached++;
        rec = next;
      }
    }
    // every path is exercised (V6: FAILED is terminal, so fewer walks reach a completion than in V5)
    expect(terminalReached).toBeGreaterThan(500);
    expect(completions).toBeGreaterThan(25);
    expect(failures).toBeGreaterThan(500);
    expect(finalFailures).toBeGreaterThan(25);
    expect(refusals).toBeGreaterThan(5000);
    expect(afterSubmission, "I-O7 is exercised").toBeGreaterThan(10);
    expect(delays).toBeGreaterThan(50);
  });
  it("I-O7 exhaustively: from every open state of a submitted record, every event and every resume aiming before the submission is refused", () => {
    const back: OperationEvent[] = [{ type: "quote" }, { type: "quoted" }, { type: "review" }, { type: "edit" }, { type: "confirm" }, { type: "signed" }, { type: "rejected" }, ...PRE_SUBMISSION_STATES.map((to) => ({ type: "resume", to }) as OperationEvent)];
    let checked = 0;
    for (const state of OPERATION_STATES) {
      if (TERMINAL_STATES.includes(state) || PRE_SUBMISSION_STATES.includes(state)) continue;
      const rec = record({ kind: "swap", state, history: [{ state: "AWAITING_SIGNATURE", at: 1_000 }, { state: "SUBMITTED", at: 1_000 }, ...(state === "SUBMITTED" ? [] : [{ state, at: 1_000 }])] });
      for (const ev of back) {
        const t = transition(rec, ev, 2_000);
        expect(t.ok, `${state} ← ${ev.type}${ev.type === "resume" ? ` ${ev.to}` : ""}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(7 * 12);
  });
  it("the state names are the frozen contract's sixteen — the doc's fifteen and CANCELLED", () => {
    const spec: OperationState[] = ["DRAFT", "QUOTING", "REVIEW", "AWAITING_SIGNATURE", "SIGNED", "SUBMITTED", "CONFIRMING", "EXECUTING", "SETTLING", "COMPLETED", "QUOTE_EXPIRED", "FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED", "CANCELLED"];
    expect([...OPERATION_STATES]).toEqual(spec);
    expect([...OPERATION_STATES]).toEqual([...CONTRACT_STATES]);
  });
});
