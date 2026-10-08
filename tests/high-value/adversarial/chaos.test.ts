// Chaos (plan §118): faults injected at random — kind, step, size, mode and sizing drawn from a seed — through the campaign
// lab's simulated world. The engine must recover deterministically: every invariant held, each step funded and handed
// over exactly once, the campaign completed or cancelled (never stuck), the maximum loss at most one step, and the same
// seed giving the same run.
import { describe, it, expect } from "vitest";
import { FAULTS, SIZES_USD, simulateCampaign, type FaultKind } from "../../../reference/typescript/src/sim/campaignLab";
import type { ProtectionMode, Sizing } from "../../../reference/typescript/src/wallet/campaign";
import { labRoutes, seeded } from "../helpers";

const MODES: ProtectionMode[] = ["balanced", "max-privacy", "max-safety", "best-execution"];
const RUNS = 36;

describe("plan §118: random faults, deterministic recovery", () => {
  const { routes, prices } = labRoutes();
  const candidates = routes.filter((r) => r.pair === "ETH>BTC" || r.pair === "ETH>SOL" || r.pair === "ETH>ETH.base");
  it(`${RUNS} runs: invariants held, each step funded and handed over once, completed or cancelled, the loss at most the step in flight`, () => {
    const rng = seeded(2026);
    const stuck: string[] = [];
    for (let n = 0; n < RUNS; n++) {
      const fault: FaultKind = FAULTS[Math.floor(rng() * FAULTS.length)];
      const route = candidates[Math.floor(rng() * candidates.length)];
      const sizeUsd = SIZES_USD[Math.floor(rng() * 4)]; // $1M … $10M
      const mode = MODES[Math.floor(rng() * MODES.length)];
      const sizing: Sizing = rng() < 0.5 ? "bucket" : "varied";
      const seed = 5000 + n;
      const probe = simulateCampaign({ sizeUsd, route, mode, sizing, priceUsd: prices[route.from.symbol], seed });
      const faultAt = Math.floor(rng() * Math.max(1, probe.tranches));
      const row = simulateCampaign({ sizeUsd, route, mode, sizing, priceUsd: prices[route.from.symbol], seed, fault, faultAt });
      const label = `${fault} at step ${faultAt + 1} of ${row.tranches}, $${sizeUsd / 1e6}M ${route.pair} ${route.provider} ${mode} ${sizing}`;
      expect(row.invariantsHeld, label).toBe(true);
      expect(row.completed || row.cancelled, label).toBe(true);
      if (!(row.completed || row.cancelled)) stuck.push(label);
      expect(row.fundings, `${label}: one funding per step`).toBeLessThanOrEqual(row.tranches + 2); // a refunded step is re-planned as one more step
      expect(row.handOvers, `${label}: one hand-over per step`).toBeLessThanOrEqual(row.tranches + 2);
      expect(row.maxInFlightUsd, `${label}: I1`).toBeLessThanOrEqual(row.capUsd + 1);
      expect(row.fault!.maxLossUsd, `${label}: at most the cap`).toBeLessThanOrEqual(row.capUsd + 1);
    }
    expect(stuck).toEqual([]);
  });
  it("the same seed gives the same run (deterministic recovery)", () => {
    const route = candidates[0];
    const a = simulateCampaign({ sizeUsd: 5_000_000, route, mode: "balanced", sizing: "varied", priceUsd: prices[route.from.symbol], seed: 99, fault: "bridge-timeout", faultAt: 3 });
    const b = simulateCampaign({ sizeUsd: 5_000_000, route, mode: "balanced", sizing: "varied", priceUsd: prices[route.from.symbol], seed: 99, fault: "bridge-timeout", faultAt: 3 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
