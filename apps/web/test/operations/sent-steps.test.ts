// The progress timeline and the recovery legs (the review round of 2026-11-02): SUBMITTING is the send in progress — the
// "Submitted" step active, the source leg active —, not a send that reached the chain; a hash, or a state at or after
// SOURCE_CONFIRMING now or in the history, is.
import { describe, expect, it } from "vitest";
import type { OperationRecord, OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { wasSent } from "@privacy-wallet/sdk/wallet/operationRecord";
import { timelineOf } from "../../src/features/operations/OperationProgress";
import { legsOf } from "../../src/features/operations/RecoveryCard";

const t = ((key: string) => key) as unknown as Parameters<typeof timelineOf>[1];
const HASH = "0x" + "ab".repeat(32);
const record = (state: OperationState, history: OperationState[], txHashes: string[] = []): OperationRecord =>
  ({
    v: 3,
    id: "send:1",
    kind: "send",
    state,
    createdAt: 1_000,
    updatedAt: 2_000,
    amounts: { asset: "ETH", decimals: 18, input: "1" },
    fees: [],
    destination: { kind: "privacy-address", display: "pp1…", chain: "ethereum" },
    tier: "standard",
    refs: { txHashes },
    history: history.map((s, i) => ({ state: s, at: 1_000 + i })),
  }) as unknown as OperationRecord;

describe("sent means handed to the chain", () => {
  it("a Send still submitting: the Submitted step active, the source leg active; with its hash, or once confirming, done", () => {
    const submitting = record("SUBMITTING", ["AWAITING_AUTHORIZATION", "PREPARING_PROOF", "SUBMITTING"]);
    expect(wasSent(submitting)).toBe(false);
    expect(timelineOf(submitting, t).map((s) => s.state)).toEqual(["done", "active", "waiting", "waiting"]);
    expect(legsOf(submitting).source).toBe("active");
    const withHash = record("SUBMITTING", ["AWAITING_AUTHORIZATION", "PREPARING_PROOF", "SUBMITTING"], [HASH]);
    expect(wasSent(withHash)).toBe(true);
    expect(timelineOf(withHash, t)[1].state).toBe("done");
    const confirming = record("SOURCE_CONFIRMING", ["AWAITING_AUTHORIZATION", "PREPARING_PROOF", "SUBMITTING", "SOURCE_CONFIRMING"]);
    expect(timelineOf(confirming, t).map((s) => s.state)).toEqual(["done", "done", "active", "waiting"]);
    expect(legsOf(confirming).source).toBe("done");
    const recovery = record("RECOVERY_REQUIRED", ["AWAITING_AUTHORIZATION", "SUBMITTING", "RECOVERY_REQUIRED"]);
    expect(timelineOf(recovery, t)[1].state, "needs attention with nothing known to have reached the chain: not done").not.toBe("done");
    expect(legsOf(recovery).source).toBe("active");
  });
});
