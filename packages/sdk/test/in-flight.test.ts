// V7 Stage 13 (spec v3.0 §4): the $50K–$100K band's exposure limit counts the band's open single orders and its running
// campaigns — never a campaign's own step, a closed order, a finished campaign or another band's operation.
import { describe, expect, it } from "vitest";
import type { Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { protectedInFlightOf } from "../src/wallet/inFlight";
import type { JournalData, StoredSwap } from "../src/wallet/journal";

const swap = (over: Partial<StoredSwap>): StoredSwap =>
  ({
    orderId: "0x1",
    attemptId: "0x2",
    refundCounter: 0,
    provider: "thorchain",
    policy: "balanced",
    request: {},
    params: {},
    endpoint: "0x3",
    createdAt: 0,
    state: "funded",
    ...over,
  }) as StoredSwap;
const campaign = (over: Partial<Campaign>): Campaign => ({ id: "c", tier: "large-protected", state: "running", ...over }) as Campaign;
const journal = (swaps: StoredSwap[], campaigns: Campaign[] = []): JournalData => ({ swaps, campaigns }) as unknown as JournalData;

describe("the band's operations in flight (spec v3.0 §4)", () => {
  it("counts the band's open orders and its campaigns still running, paused or winding down", () => {
    expect(protectedInFlightOf(journal([]))).toBe(0);
    expect(protectedInFlightOf(journal([swap({ tier: "large-protected" })]))).toBe(1);
    expect(protectedInFlightOf(journal([swap({ tier: "large-protected" }), swap({ tier: "large-protected", orderId: "0x9", state: "executing" })]))).toBe(2);
    expect(protectedInFlightOf(journal([], [campaign({})]))).toBe(1);
    expect(
      protectedInFlightOf(journal([swap({ tier: "large-protected" })], [campaign({ state: "paused" }), campaign({ id: "d", state: "winding-down" })])),
    ).toBe(3);
  });
  it("never a closed order, a finished campaign, a campaign's own step or another band's operation", () => {
    for (const state of ["completed", "refunded", "abandoned", "lapsed"])
      expect(protectedInFlightOf(journal([swap({ tier: "large-protected", state })])), state).toBe(0);
    for (const state of ["completed", "cancelled"] as const) expect(protectedInFlightOf(journal([], [campaign({ state })])), state).toBe(0);
    expect(protectedInFlightOf(journal([swap({ tier: "large-protected", campaign: { id: "c", index: 0 } })], [campaign({})])), "a step is its campaign's").toBe(
      1,
    );
    expect(protectedInFlightOf(journal([swap({ tier: "enhanced" }), swap({ tier: "large" }), swap({})], [campaign({ tier: "institutional" })]))).toBe(0);
  });
});
