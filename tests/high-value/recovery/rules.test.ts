// Recovery (plan §31–§33, §71–§72, §109–§111; contract §8): an unknown state is not a failed state and never
// auto-retries (I-HV 9, I-S 6); reconcile outranks every other pause but the global switch and carries its own detail
// (a possible reorganization); a paused campaign only tracks; a crash resumes from the journaled state; the lab's crash,
// reorg and disconnect faults fund and hand over every step exactly once.
import { describe, it, expect } from "vitest";
import { detectPause, exposure, nextAction, settledBy, withCampaignState, withTrancheState } from "../../../packages/protocol/src/wallet/campaign";
import { simulateCampaign } from "../../../packages/protocol/src/sim/campaignLab";
import { campaign, ETH, labRoutes } from "../helpers";

describe("unknown ≠ failed (plan §71–§72, §110)", () => {
  it("I3: an unknown tracking state never settles and keeps the tranche in flight; the exposure does not move", () => {
    const c = campaign([50n * ETH, 50n * ETH], ["settled", "executing"], { state: "running" }, { capBps: 5000 });
    expect(settledBy("destination-final", { state: "UNKNOWN", chain: "bitcoin" }, 10 ** 12)).toBe(false);
    const marked = withTrancheState(c, 1, "executing", 5, { lastReadFailedAt: 5 });
    expect(marked.tranches[1].state).toBe("executing");
    expect(exposure(marked).inFlight).toBe(50n * ETH);
    expect(nextAction(marked, { now: 6, pause: null, notesShaped: true })).toMatchObject({ kind: "track", indexes: [1] });
  });
  it("I-HV 9: a paused campaign tracks what flies and never commits, funds or hands over until resumed; a reassess with a live fact pauses again", () => {
    const paused = withCampaignState(campaign([50n * ETH, 50n * ETH, 50n * ETH], ["settled", "signed", "planned"], {}, { capBps: 5000 }), "paused", 7, "x", { pause: { reason: "reconcile", detail: "x", at: 7 } });
    const a = nextAction(paused, { now: 8, pause: null, notesShaped: true });
    expect(["track", "wait"]).toContain(a.kind);
    const flying = withCampaignState(campaign([50n * ETH, 50n * ETH], ["executing", "planned"], {}, { capBps: 5000 }), "paused", 7, "x", { pause: { reason: "reconcile", detail: "x", at: 7 } });
    expect(nextAction(flying, { now: 8, pause: null, notesShaped: true })).toMatchObject({ kind: "track", indexes: [0] });
    const reassessing = withCampaignState(flying, "reassessing", 9);
    expect(nextAction(reassessing, { now: 10, pause: { reason: "provider-error", detail: "still down" }, notesShaped: true })).toMatchObject({ kind: "pause", reason: "provider-error" });
    expect(nextAction(reassessing, { now: 10, pause: null, notesShaped: true })).toMatchObject({ kind: "requote" });
  });
  it("reconcile outranks every pause but the global switch and carries the runner's detail — a possible reorganization (plan §111)", () => {
    const c = campaign([50n * ETH, 50n * ETH], ["funded", "planned"], {}, { capBps: 5000 });
    const detail = "The funding of step 1 was seen in its escrow and is no longer there (a chain reorganization?); the chain is read again before anything is sent.";
    expect(detectPause(c, { now: 1, walletPaused: false, reconcileNeeded: true, reconcileDetail: detail, incidentDates: [c.createdAt + 1], providerHealth: { breakerOpen: true } })).toEqual({ reason: "reconcile", detail });
    expect(detectPause(c, { now: 1, walletPaused: true, reconcileNeeded: true })).toMatchObject({ reason: "wallet-pause" });
    expect(detectPause(c, { now: 1, walletPaused: false, reconcileNeeded: true })!.detail).toMatch(/read before anything is sent again/);
  });
});

describe("the journal is the state (plan §109): the reducer continues from where the journal says", () => {
  it("a signed tranche is handed over, a funded one signed, a committed one funded; a flying one is tracked — no state is ever repeated from scratch", () => {
    for (const [state, kind] of [["signed", "hand-over"], ["funded", "sign"], ["committed", "fund"], ["ready", "commit"]] as const) {
      const c = campaign([50n * ETH, 50n * ETH], ["settled", state], { state: "running" }, { capBps: 5000 });
      expect(nextAction(c, { now: 1, pause: null, notesShaped: true }), state).toMatchObject({ kind, index: 1 });
    }
  });
});

describe("the lab's recovery faults (plan §109–§111): every step funded and handed over exactly once", () => {
  const { routes, prices } = labRoutes();
  const ref = routes.find((r) => r.pair === "ETH>BTC" && r.provider === "thorchain") ?? routes[0];
  it("app crash, network disconnect, RPC failure and reorg at the middle step: the campaign completes with the invariants held and no duplicate send", () => {
    for (const fault of ["app-crash", "network-disconnect", "rpc-failure", "reorg"] as const) {
      const row = simulateCampaign({ sizeUsd: 5_000_000, route: ref, mode: "balanced", sizing: "varied", priceUsd: prices[ref.from.symbol], seed: 77, fault });
      expect(row.invariantsHeld, fault).toBe(true);
      expect(row.completed, fault).toBe(true);
      expect(row.fundings, `${fault}: one funding per tranche`).toBe(row.tranches);
      expect(row.handOvers, `${fault}: one hand-over per tranche`).toBe(row.tranches);
      expect(row.fault!.maxLossUsd).toBeLessThanOrEqual(row.capUsd + 1);
    }
  });
});
