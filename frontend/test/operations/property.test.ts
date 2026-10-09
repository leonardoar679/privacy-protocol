// The spec's §12 invariants under 2,000 random event sequences: whatever the order of events, a terminal state is
// final (I-O1), the history's timestamps are monotone (I-O2), a failure state always carries a catalog code (I-O3),
// COMPLETED is only ever reached through a settlement reference (I-O4), the state is one of the list and the last
// history line is the state.
import { describe, expect, it } from "vitest";
import { transition } from "../../src/features/operations/reducer";
import { CODES } from "../../src/features/operations/errors/catalog";
import type { OperationEvent } from "../../src/features/operations/types";
import { FAILURE_STATES, OPERATION_STATES, TERMINAL_STATES, type OperationRecord, type OperationState } from "../../src/wallet/operationRecord";
import { record } from "../helpers/operations";

const seeded = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
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
    () => ({ type: "submission-failed", code }), () => ({ type: "delayed" }), () => ({ type: "provider-failed", code }), () => ({ type: "recovery-required", code }), () => ({ type: "refunding" }),
    () => ({ type: "refunded", ref }), () => ({ type: "cancel" }), () => ({ type: "resume", to: pick(rng, OPERATION_STATES) }), () => ({ type: "monitor" }), () => ({ type: "note", note: "n" }),
  ];
  return pick(rng, kinds)();
}

describe("plan §12 — the invariants hold under random event sequences", () => {
  it("2,000 sequences of up to 40 events each", () => {
    const rng = seeded(11);
    let terminalReached = 0, completions = 0, failures = 0, refusals = 0;
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
        if (!t.ok) { refusals++; expect(t.record).toBe(rec); continue; }
        const next = t.record;
        expect(OPERATION_STATES).toContain(next.state);
        expect(next.updatedAt, "I-O2").toBeGreaterThanOrEqual(rec.updatedAt);
        for (let k = 1; k < next.history.length; k++) expect(next.history[k].at, "I-O2 history").toBeGreaterThanOrEqual(next.history[k - 1].at);
        if (next.state !== rec.state) expect(next.history[next.history.length - 1].state).toBe(next.state);
        if (FAILURE_STATES.includes(next.state)) { failures++; expect(next.failure, "I-O3").toBeDefined(); expect(CODES, "I-O3 a catalog code").toContain(next.failure!.code); }
        if (next.state === "COMPLETED" && rec.state !== "COMPLETED") {
          completions++;
          expect(ev.type, "I-O4").toBe("completed");
          const r = (ev as { ref: { leafIndex?: number; txHash?: string; destinationTx?: string; tracker?: boolean } }).ref;
          expect(r.leafIndex !== undefined || !!r.txHash || !!r.destinationTx || r.tracker === true, "I-O4 a settlement reference").toBe(true);
        }
        if (TERMINAL_STATES.includes(next.state)) terminalReached++;
        rec = next;
      }
    }
    expect(terminalReached).toBeGreaterThan(200);
    expect(completions).toBeGreaterThan(50);
    expect(failures).toBeGreaterThan(500);
    expect(refusals).toBeGreaterThan(1000);
  });
  it("the state names are the spec's twenty, no more", () => {
    const spec: OperationState[] = ["DRAFT", "QUOTING", "QUOTE_READY", "REVIEW", "AWAITING_SIGNATURE", "SIGNED", "SUBMITTED", "RELAYER_EXECUTING", "NETWORK_CONFIRMING", "SETTLEMENT_VERIFYING", "COMPLETED", "QUOTE_EXPIRED", "SIGNATURE_REJECTED", "SUBMISSION_FAILED", "NETWORK_DELAYED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "REFUNDING", "REFUNDED", "CANCELLED"];
    expect([...OPERATION_STATES]).toEqual(spec);
  });
});
