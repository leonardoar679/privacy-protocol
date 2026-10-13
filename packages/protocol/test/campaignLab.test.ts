// The campaign lab (High-Value Protection spec §18) pinned: on a synthetic route every campaign completes, every piece
// and the in-flight exposure stay under the cap, each tranche is funded and handed over exactly once (also after the
// app crash), and each of the thirteen faults reaches at most one tranche.
import { describe, it, expect } from "vitest";
import { etaFor, FAULTS, simulateCampaign, type RouteSpec } from "../src/sim/campaignLab";

const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const route: RouteSpec = { family: "EVM→BTC", pair: "ETH>BTC", from: ETH, to: BTC, provider: "thorchain", planMode: "streaming", measured: [{ usd: 100_000, etaSeconds: 1000 }, { usd: 1_000_000, etaSeconds: 1400 }] };

describe("campaign lab", () => {
  it("interpolates the execution time between the measured sizes", () => {
    expect(etaFor(route, 50_000)).toBe(1000);
    expect(etaFor(route, 550_000)).toBe(1200);
    expect(etaFor(route, 5_000_000)).toBe(1400);
  });
  it("a $1M and a $10M campaign complete with every invariant held and each tranche funded once", () => {
    for (const sizeUsd of [1_000_000, 10_000_000]) {
      const r = simulateCampaign({ sizeUsd, route, mode: "balanced", sizing: "varied", priceUsd: 2500, seed: 1 });
      expect(r.completed).toBe(true);
      expect(r.invariantsHeld).toBe(true);
      expect(r.maxInFlightUsd).toBeLessThanOrEqual(r.capUsd + 1);
      expect(r.trancheUsd[1]).toBeLessThanOrEqual(r.capUsd + 1);
      expect(r.fundings).toBe(r.tranches);
      expect(r.handOvers).toBe(r.tranches);
      expect(r.pauses).toEqual([]);
      expect(r.concurrency).toBe("sequential"); // R5: never two pieces at once
    }
  });
  it("each fault reaches at most one tranche, never the order; permanent faults cancel and return the rest", { timeout: 120_000 }, () => {
    for (const fault of FAULTS) {
      const r = simulateCampaign({ sizeUsd: 10_000_000, route, mode: "balanced", sizing: "varied", priceUsd: 2500, seed: 2, fault });
      expect(r.invariantsHeld, fault).toBe(true);
      expect(r.fault!.maxLossUsd, fault).toBeLessThanOrEqual(r.trancheUsd[1] + 1);
      expect(r.fault!.maxLossUsd, fault).toBeLessThanOrEqual(r.capUsd + 1);
      if (["destination-error", "wrong-chain", "wrong-token"].includes(fault)) { expect(r.cancelled, fault).toBe(true); expect(r.fault!.maxLossUsd).toBe(0); }
      else expect(r.completed, fault).toBe(true);
      if (fault === "reorg" || fault === "app-crash") expect(r.pauses, fault).toEqual([]); // reconciled from the chain and the journal: no pause, nothing sent twice
      else expect(r.pauses.length, fault).toBeGreaterThanOrEqual(1);
    }
  });
});
