// The local encrypted journal (plan §73, §109–§110; contract §1, §3.6): the campaign with its bounds, plan, tranches,
// outcomes and history is plain JSON that round-trips byte for byte (bigints travel as decimal strings); on restart the
// reducer continues from the journaled state (the chain and the executor are asked by the runner, never a second
// send); an unreadable state keeps its exposure ("Unknown / reconnecting", never "failed").
import { describe, it, expect } from "vitest";
import { createCampaign, exposure, nextAction, withTrancheState, withCampaignState, replan } from "../../../packages/protocol/src/wallet/campaign";
import { campaign, bounds, plan, ETH, ETH_REF, BTC_REF, REF_RATE } from "../helpers";

describe("the journal (plan §73)", () => {
  it("a campaign is JSON: a copy equals the original, no bigint leaks, no undefined keys survive", () => {
    let c = createCampaign({ id: "0xabc", now: 1_000, mode: "balanced", tier: "institutional", request: { from: ETH_REF, to: BTC_REF, amount: (2500n * ETH).toString(), preference: "balanced" }, bounds: bounds(), plan: plan(), pieces: [50n * ETH, 50n * ETH], referenceRateE18: REF_RATE, riskSnapshot: { privacyScore: 72 } });
    c = withTrancheState(c, 0, "executing", 2_000, { orderId: "0x1", provider: "thorchain", jobId: "job-1", handedOverAt: 2_000, expected: { minOut: "1", rateE18: REF_RATE.toString(), etaSeconds: 1400 } });
    c = withTrancheState(c, 0, "destination-confirmed", 3_000, { deliveredSince: 3_000, outcome: { deliveredOut: "150000000", delivered: (50n * ETH).toString() } });
    c = withCampaignState(c, "running", 1_500);
    const text = JSON.stringify(c);
    expect(text).not.toMatch(/undefined/);
    const copy = JSON.parse(text);
    expect(copy).toEqual(c);
    expect(JSON.stringify(copy)).toBe(text);
    expect(typeof copy.tranches[0].amount).toBe("string");
    expect(copy.tranches[0].history.map((h: { state: string }) => h.state)).toEqual(["planned", "executing", "destination-confirmed"]);
  });
  it("§109: after a crash the reducer continues from the journaled state — a flying step is tracked, a signed one handed over, nothing starts again from scratch", () => {
    const c = campaign([50n * ETH, 50n * ETH, 50n * ETH], ["settled", "executing", "planned"], { state: "running" }, { capBps: 5000 });
    const restored = JSON.parse(JSON.stringify(c));
    expect(nextAction(restored, { now: 10, pause: null, notesShaped: true })).toMatchObject({ kind: "track", indexes: [1] });
    const signed = JSON.parse(JSON.stringify(campaign([50n * ETH, 50n * ETH], ["settled", "signed"], { state: "running" }, { capBps: 5000 })));
    expect(nextAction(signed, { now: 10, pause: null, notesShaped: true })).toMatchObject({ kind: "hand-over", index: 1 });
    // a refund that came back is re-planned from the remainder, never re-funded from the same order
    const refunded = campaign([50n * ETH, 50n * ETH], ["settled", "refunded"], { state: "running" }, { capBps: 5000 });
    expect(nextAction(refunded, { now: 10, pause: null, notesShaped: true })).toMatchObject({ kind: "replan" });
    const again = replan(refunded, [50n * ETH], 11);
    expect(again.tranches).toHaveLength(3);
    expect(again.tranches[2]).toMatchObject({ index: 2, state: "planned", attempt: 0 });
  });
  it("§110: an unreadable state keeps the step where it is and its exposure as it was — 'Unknown / reconnecting', never 'failed'", () => {
    const c = campaign([50n * ETH, 50n * ETH], ["settled", "executing"], {}, { capBps: 5000 });
    const unknown = withTrancheState(c, 1, "executing", 9, { lastReadFailedAt: 9 });
    expect(exposure(unknown)).toMatchObject({ inFlight: 50n * ETH, completed: 50n * ETH });
    expect(unknown.tranches[1].state).toBe("executing");
    expect(unknown.tranches[1].history.at(-1)!.state, "a mark is not a transition").toBe("executing");
    expect(unknown.tranches[1].history).toHaveLength(c.tranches[1].history.length);
  });
});
