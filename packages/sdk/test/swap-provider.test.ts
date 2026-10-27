// The recovery options of the swap provider facade (spec v3.0 §5; V7 Stage 14), pure over the journaled order and its record:
// the owner's five options, each with the funds class it applies to.
import { describe, expect, it } from "vitest";
import { recoveryOptionsOf } from "../src/swapProvider";

const stored = (over: Record<string, unknown> = {}) => ({ state: "committed", ...over }) as never;
const rec = (state: string, settlement?: string) => ({ state, ...(settlement ? { settlement } : {}) }) as never;

describe("the recovery options (spec v3.0 §5)", () => {
  it("an open order: monitoring; a moved minimum: accept or return; an unexecutable call: retry the hand-over or return; a closed window: return; a reconcile: monitoring with the funds unknown", () => {
    expect(recoveryOptionsOf(stored(), rec("AWAITING_AUTHORIZATION"))).toEqual([{ action: "continue-monitoring", fundsClass: "not-moved" }]);
    expect(recoveryOptionsOf(stored({ paused: { code: "minimum_moved", at: 1 } }), rec("RECOVERY_REQUIRED")), "before the funding: nothing moved").toEqual([
      { action: "accept-new-minimum", fundsClass: "not-moved" },
      { action: "return-funds", fundsClass: "not-moved" },
    ]);
    expect(recoveryOptionsOf(stored({ state: "funded", paused: { code: "minimum_moved", at: 1 } }), rec("RECOVERY_REQUIRED", "SOURCE_CONFIRMED"))).toEqual([
      { action: "accept-new-minimum", fundsClass: "still-protected" },
      { action: "return-funds", fundsClass: "still-protected" },
    ]);
    expect(
      recoveryOptionsOf(stored({ state: "funded", paused: { code: "execution_unavailable", at: 1 } }), rec("RECOVERY_REQUIRED", "SOURCE_CONFIRMED")),
    ).toEqual([
      { action: "retry-hand-over", fundsClass: "still-protected" },
      { action: "return-funds", fundsClass: "still-protected" },
    ]);
    expect(
      recoveryOptionsOf(stored({ state: "funded", paused: { code: "execution_window_closed", at: 1 } }), rec("RECOVERY_REQUIRED", "REFUND_AVAILABLE")),
    ).toEqual([{ action: "return-funds", fundsClass: "still-protected" }]);
    expect(recoveryOptionsOf(stored({ paused: { code: "reconcile", at: 1 } }), rec("AWAITING_AUTHORIZATION"))).toEqual([
      { action: "continue-monitoring", fundsClass: "unknown" },
    ]);
  });
  it("the settlement decides: a refundable escrow offers the return beside monitoring; with the provider, monitoring with the funds unknown; finished, the progress alone", () => {
    expect(recoveryOptionsOf(stored({ state: "executing" }), rec("PROVIDER_EXECUTING", "REFUND_AVAILABLE"))).toEqual([
      { action: "return-funds", fundsClass: "still-protected" },
      { action: "continue-monitoring", fundsClass: "still-protected" },
    ]);
    expect(recoveryOptionsOf(stored({ state: "executing" }), rec("PROVIDER_EXECUTING", "PROVIDER_PENDING"))).toEqual([
      { action: "continue-monitoring", fundsClass: "unknown" },
    ]);
    expect(recoveryOptionsOf(stored({ state: "executing" }), rec("DESTINATION_CONFIRMING", "DESTINATION_PENDING"))).toEqual([
      { action: "continue-monitoring", fundsClass: "unknown" },
    ]);
    expect(recoveryOptionsOf(stored({ state: "completed" }), rec("COMPLETED", "COMPLETED")), "delivered: nothing to say about the funds").toEqual([
      { action: "view-progress", fundsClass: null },
    ]);
    expect(recoveryOptionsOf(stored({ state: "refunded" }), rec("REFUNDED", "COMPLETED"))).toEqual([
      { action: "view-progress", fundsClass: "still-protected" },
    ]);
    expect(recoveryOptionsOf(stored({ state: "abandoned" }), rec("CANCELLED"))).toEqual([{ action: "view-progress", fundsClass: "not-moved" }]);
    expect(recoveryOptionsOf(stored({ state: "abandoned" }), null), "no record: the journal's state decides").toEqual([
      { action: "view-progress", fundsClass: "not-moved" },
    ]);
  });
});
