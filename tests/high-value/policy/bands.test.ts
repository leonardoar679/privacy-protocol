// The consumer bands (Privacy Wallet Web spec §11; plan V5 decision 3; V7 Stage 13, spec v3.0 §4): the ladder stays monotone
// with the two bands below `enhanced` — every V2–V4 rule keyed on `enhanced` and above keeps its meaning —, and the $50K band's
// cap is the band's own (a quarter), unmoved by the exposure tier and the mode of the high-value layer; its steps, when the
// order is staged or the user asks, are varied pieces under that quarter — never identical quarters. The enhanced row from $100K is unchanged.
import { describe, it, expect } from "vitest";
import { TIERS, TIER_DEFAULTS, atLeast, checkThresholds, tierOf, tierRank } from "../../../packages/protocol/src/wallet/valuation";
import { EXPOSURE_POLICY, capBpsFor, type ExposureTier } from "../../../packages/protocol/src/wallet/exposurePolicy";
import { planTranches } from "../../../packages/protocol/src/wallet/campaign";
import type { ProtectionMode } from "../../../packages/protocol/src/wallet/campaign";
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
  it("the $50K band's cap is 25 % whatever the route's exposure tier and the mode; the steps, when staged or asked, are varied pieces between an eighth and a quarter (V7 Stage 13: never identical quarters); the enhanced row from $100K is unchanged", () => {
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
    // the band's steps (spec v3.0 §4): the planner's varied pieces inside [12.5 %, 25 %] of the order — the whole order, every
    // piece under the quarter, no two neighbours alike (the last aside), never four identical quarters — $60K and $80K orders of ETH, $60K of USDC
    for (const [total, decimals] of [[15n * ETH, 18], [60_000n * USDC, 6], [60_000n * USDC + 2n, 6], [32n * ETH, 18]] as [bigint, number][]) {
      for (const seed of [1, 7, 42]) {
        const split = planTranches(total, { decimals, bandBps: [1250, 2500], capBps: 2500, sizing: "varied", maxParallel: 1, rng: seeded(seed) });
        expect(sum(split.pieces)).toBe(total);
        expect(split.pieces.length).toBeGreaterThanOrEqual(4);
        for (const p of split.pieces) expect(p <= (total * 2500n) / 10000n, `${p} under the quarter of ${total}`).toBe(true);
        expect(new Set(split.pieces.map(String)).size, `${total} seed ${seed}: varied sizes`).toBeGreaterThan(1);
        for (let i = 1; i < split.pieces.length - 1; i++) expect(split.pieces[i], `${total} seed ${seed}: piece ${i} differs from its neighbour`).not.toBe(split.pieces[i - 1]);
        expect(split.pieces.slice(0, 4), "never the V5 quarters").not.toEqual([total / 4n, total / 4n, total / 4n, total / 4n]);
      }
    }
    // the enhanced row below the band and from $100K: as V4 pinned
    expect(capBpsFor({ tier: "enhanced", mode: "balanced", exposureTier: "R3" }).capBps).toBe(250);
    expect(capBpsFor({ tier: "enhanced", mode: "balanced", exposureTier: "R1" }).capBps).toBe(500);
    expect(capBpsFor({ tier: "large", mode: "balanced", exposureTier: "R3" }).capBps).toBe(250);
    expect(capBpsFor({ tier: "high-value", mode: "max-safety", exposureTier: "R2" }).capBps).toBe(100);
  });
});
