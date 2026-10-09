// The consumer bands (Privacy Wallet Web spec §11; plan V5 decision 3): the ladder stays monotone with the two bands
// below `enhanced` — every V2–V4 rule keyed on `enhanced` and above keeps its meaning —, and the $50K band's cap is
// the band's own (four sequential steps of a quarter), unmoved by the exposure tier and the mode of the high-value
// layer, with the enhanced row unchanged from $100K.
import { describe, it, expect } from "vitest";
import { TIERS, TIER_DEFAULTS, atLeast, checkThresholds, tierOf, tierRank } from "../../../reference/typescript/src/wallet/valuation";
import { EXPOSURE_POLICY, capBpsFor, type ExposureTier } from "../../../reference/typescript/src/wallet/exposurePolicy";
import { planTranches } from "../../../reference/typescript/src/wallet/campaign";
import type { ProtectionMode } from "../../../reference/typescript/src/wallet/campaign";
import { ETH, USDC, seeded, sum } from "../helpers";

describe("the ladder (spec §11)", () => {
  it("is monotone: seven tiers in order, the defaults increase, tierOf steps at each threshold, a crossing is refused", () => {
    expect(TIERS).toEqual(["standard", "large", "large-protected", "enhanced", "high-value", "high-value-secondary", "institutional"]);
    const thresholds = [TIER_DEFAULTS.large, TIER_DEFAULTS.largeProtected, TIER_DEFAULTS.enhanced, TIER_DEFAULTS.highValue, TIER_DEFAULTS.highValueSecondary, TIER_DEFAULTS.institutional];
    for (let i = 1; i < thresholds.length; i++) expect(thresholds[i]).toBeGreaterThan(thresholds[i - 1]);
    expect(thresholds).toEqual([20_000, 50_000, 100_000, 1_000_000, 5_000_000, 10_000_000]);
    for (let i = 0; i < thresholds.length; i++) {
      expect(tierOf(thresholds[i])).toBe(TIERS[i + 1]);
      expect(tierOf(thresholds[i] - 0.01)).toBe(TIERS[i]);
      expect(tierRank(tierOf(thresholds[i]))).toBe(i + 1);
    }
    expect(() => checkThresholds(TIER_DEFAULTS)).not.toThrow();
    expect(() => checkThresholds({ ...TIER_DEFAULTS, largeProtected: 20_000 })).toThrow(/increase/);
    expect(() => checkThresholds({ ...TIER_DEFAULTS, large: 50_000 })).toThrow(/increase/);
    expect(() => checkThresholds({ enhanced: 100_000, highValue: 1_000_000, highValueSecondary: 5_000_000, institutional: 10_000_000 }), "a V4 object without the bands still checks").not.toThrow();
    // every rule keyed on enhanced and above is untouched by the bands
    expect(atLeast("large-protected", "enhanced")).toBe(false);
    expect(atLeast("large", "enhanced")).toBe(false);
    for (const t of ["enhanced", "high-value", "high-value-secondary", "institutional"] as const) expect(atLeast(t, "large-protected")).toBe(true);
  });
  it("the $50K band's cap is 25 % whatever the route's exposure tier and the mode; the plan is four sequential quarters; the enhanced row from $100K is unchanged", () => {
    expect(EXPOSURE_POLICY["large-protected"]).toEqual({ word: "Protected", capBps: 2500, range: [2500, 5000], activation: "staged-or-opt-in" });
    expect(EXPOSURE_POLICY.large).toEqual({ word: "Normal", capBps: null, range: null, activation: "none" });
    for (const exposureTier of ["R0", "R1", "R2", "R3", "R4"] as ExposureTier[]) for (const mode of ["balanced", "max-privacy", "max-safety", "best-execution"] as ProtectionMode[]) {
      const r = capBpsFor({ tier: "large-protected", mode, exposureTier });
      expect(r.capBps, `${exposureTier} ${mode}`).toBe(2500);
      expect(r.range).toEqual([2500, 5000]);
      expect(r.reasons.some((x) => /capped at 1 %|caps the exposure|allows at most/.test(x)), `${exposureTier} ${mode}: no high-value ceiling applies`).toBe(false);
    }
    expect(capBpsFor({ tier: "large-protected", mode: "balanced", exposureTier: "R3", userCapBps: 5000 }).capBps).toBe(5000);
    expect(capBpsFor({ tier: "large-protected", mode: "balanced", exposureTier: "R3", userCapBps: 100 }).capBps, "never finer than a quarter at the band").toBe(2500);
    // four sequential steps of a quarter, exact pieces: a $60K order of ETH and one of USDC
    for (const [total, decimals] of [[15n * ETH, 18], [60_000n * USDC, 6], [60_000n * USDC + 2n, 6]] as [bigint, number][]) {
      const split = planTranches(total, { decimals, bandBps: [2500, 2500], capBps: 2500, sizing: "varied", maxParallel: 1, exact: true, rng: seeded() });
      expect(sum(split.pieces)).toBe(total);
      expect(split.pieces.length).toBeLessThanOrEqual(5); // a remainder below the dust floor is a piece of its own
      expect(split.pieces.slice(0, 4)).toEqual([total / 4n, total / 4n, total / 4n, total / 4n]);
      for (const p of split.pieces) expect(p).toBeLessThanOrEqual((total * 2500n) / 10000n);
    }
    expect(planTranches(15n * ETH, { decimals: 18, bandBps: [2500, 2500], capBps: 2500, sizing: "varied", maxParallel: 1, exact: true, rng: seeded() }).pieces).toHaveLength(4);
    // the enhanced row below the band and from $100K: as V4 pinned
    expect(capBpsFor({ tier: "enhanced", mode: "balanced", exposureTier: "R3" }).capBps).toBe(250);
    expect(capBpsFor({ tier: "enhanced", mode: "balanced", exposureTier: "R1" }).capBps).toBe(500);
    expect(capBpsFor({ tier: "large", mode: "balanced", exposureTier: "R3" }).capBps).toBe(250);
    expect(capBpsFor({ tier: "high-value", mode: "max-safety", exposureTier: "R2" }).capBps).toBe(100);
  });
});
