// The exposure policy (contract §2; plan §4–§6, §62, §80–§81, §90): the §4 table per value band, the exposure tier derived
// from the risk class and the live facts, the effective cap from band × tier × mode × the user's fraction, the
// market-impact remedies in the plan's order, and the velocity limit.
import { describe, it, expect } from "vitest";
import { EXPOSURE_POLICY, IMPACT_LIMIT_BPS, TIER_RANGES, capBpsFor, exposureTierOf, impactRemedy, velocityExceeded } from "../src/wallet/exposurePolicy";

describe("the policy table (plan §4)", () => {
  it("Normal below $100K, Protected 5 % at $100K–$1M (staged or opt-in), 2.5 % at $1M–$10M, 2 % above $10M inside the plan's 1–2.5 %", () => {
    expect(EXPOSURE_POLICY.standard).toMatchObject({ word: "Normal", capBps: null, activation: "none" });
    expect(EXPOSURE_POLICY.enhanced).toMatchObject({ word: "Protected", capBps: 500, range: [100, 500], activation: "staged-or-opt-in" });
    expect(EXPOSURE_POLICY["high-value"]).toMatchObject({ word: "High Value", capBps: 250, activation: "always" });
    expect(EXPOSURE_POLICY["high-value-secondary"]).toMatchObject({ word: "Very High Value", capBps: 250 });
    expect(EXPOSURE_POLICY.institutional).toMatchObject({ word: "Extreme Value", capBps: 200, range: [100, 250] });
    expect(TIER_RANGES.R4[1]).toBe(100);
  });
  it("V5 (spec §11): the consumer bands — Normal at $20K, four sequential quarters at $50K", () => {
    expect(EXPOSURE_POLICY.large).toMatchObject({ word: "Normal", capBps: null, activation: "none" });
    expect(EXPOSURE_POLICY["large-protected"]).toMatchObject({ word: "Protected", capBps: 2500, range: [2500, 5000], activation: "staged-or-opt-in" });
  });
  it("V5: the $50K band's cap is the band's own — the tier ceilings and the mode ceiling of the high-value layer do not apply", () => {
    expect(capBpsFor({ tier: "large-protected", mode: "balanced", exposureTier: "R3" })).toMatchObject({ capBps: 2500, range: [2500, 5000], reasons: [] });
    expect(capBpsFor({ tier: "large-protected", mode: "balanced", exposureTier: "R2", userCapBps: 5000 }).capBps).toBe(5000);
    expect(capBpsFor({ tier: "large-protected", mode: "balanced", exposureTier: "R3", userCapBps: 1000 })).toMatchObject({ capBps: 2500, reasons: [expect.stringMatching(/clipped to 25–50 %/)] });
    expect(capBpsFor({ tier: "large-protected", mode: "max-safety", exposureTier: "R3" }).capBps, "Maximum Safety is sequential and destination-final here, not 1 % pieces").toBe(2500);
    const r4 = capBpsFor({ tier: "large-protected", mode: "balanced", exposureTier: "R4" });
    expect(r4.capBps).toBe(2500);
    expect(r4.reasons.join(" ")).toMatch(/next healthy route/);
    expect(capBpsFor({ tier: "large", mode: "balanced", exposureTier: "R3" }).capBps, "below the band the enhanced row still applies (opt-in): the R3 ceiling under the 5 %").toBe(250);
    expect(capBpsFor({ tier: "large", mode: "balanced", exposureTier: "R1" }).capBps).toBe(500);
    expect(capBpsFor({ tier: "enhanced", mode: "balanced", exposureTier: "R3" }).capBps, "unchanged").toBe(250);
  });
});

describe("exposureTierOf (plan §6)", () => {
  it("R0 for an atomic class, R1 for a signed hard quote on a solver route, R2 for a stream on a bridge route, R3 otherwise", () => {
    expect(exposureTierOf({ class: "R1" }).tier).toBe("R0");
    expect(exposureTierOf({ class: "R2" }, { signedHardQuote: true }).tier).toBe("R1");
    expect(exposureTierOf({ class: "R2" }, { planMode: "intent" }).tier).toBe("R3");
    expect(exposureTierOf({ class: "R5" }, { planMode: "streaming" }).tier).toBe("R2");
    expect(exposureTierOf({ class: "R5" }, { planMode: "dca" }).tier).toBe("R2");
    expect(exposureTierOf({ class: "R5" }, { planMode: "single" }).tier).toBe("R3");
  });
  it("R4 for a thin market, an unknown provider, a halted chain, an incident within 30 days, an open breaker, a low security score or an OTC route — with every reason named", () => {
    expect(exposureTierOf({ class: "R5" }, { planMode: "streaming", thinMarket: true })).toMatchObject({ tier: "R4", reasons: ["low liquidity for this size"] });
    expect(exposureTierOf({ class: "R5" }, { knownProvider: false }).tier).toBe("R4");
    expect(exposureTierOf({ class: "R5" }, { chainHalted: true }).tier).toBe("R4");
    expect(exposureTierOf({ class: "R5" }, { incidentWithinDays: 12 }).tier).toBe("R4");
    expect(exposureTierOf({ class: "R5" }, { incidentWithinDays: 45 }).tier).toBe("R3");
    expect(exposureTierOf({ class: "R5" }, { incidentWithinDays: null }).tier).toBe("R3");
    expect(exposureTierOf({ class: "R5" }, { breakerOpen: true }).tier).toBe("R4");
    expect(exposureTierOf({ class: "R5" }, { security: 59 }).tier).toBe("R4");
    expect(exposureTierOf({ class: "R1" }, { security: 59 }).tier).toBe("R4"); // the facts outrank the class
    expect(exposureTierOf({ class: "R6" }).tier).toBe("R4");
    const r = exposureTierOf({ class: "R5" }, { thinMarket: true, breakerOpen: true, incidentWithinDays: 3 });
    expect(r.reasons).toHaveLength(3);
  });
});

describe("capBpsFor (contract §2.2)", () => {
  it("the band's default on an R2 / R3 route; the tier's maximum on R4; Maximum Safety is 1 % everywhere", () => {
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R3" }).capBps).toBe(250);
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R2" }).capBps).toBe(250);
    expect(capBpsFor({ tier: "institutional", mode: "balanced", exposureTier: "R2" }).capBps).toBe(200);
    expect(capBpsFor({ tier: "enhanced", mode: "balanced", exposureTier: "R3" }).capBps).toBe(250); // the tier's maximum, under the band's 5 %
    expect(capBpsFor({ tier: "enhanced", mode: "balanced", exposureTier: "R1" }).capBps).toBe(500);
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R4" })).toMatchObject({ capBps: 100, reasons: expect.arrayContaining([expect.stringContaining("R4")]) });
    expect(capBpsFor({ tier: "high-value", mode: "max-safety", exposureTier: "R2" })).toMatchObject({ capBps: 100 });
    expect(capBpsFor({ tier: "standard", mode: "balanced", exposureTier: "R3" }).capBps).toBe(250); // the enhanced row applies below it
    expect(capBpsFor({ tier: "high-value", mode: "best-execution", exposureTier: "R3" }).capBps).toBe(250);
    expect(capBpsFor({ tier: "high-value", mode: "max-privacy", exposureTier: "R3" }).capBps).toBe(250);
  });
  it("the user may lower the cap anywhere, raise it above the default only on an R0 / R1 route, and never above the band's range", () => {
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R3", userCapBps: 150 }).capBps).toBe(150);
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R3", userCapBps: 300 })).toMatchObject({ capBps: 250, range: [100, 250], reasons: [expect.stringContaining("clipped")] });
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R1", userCapBps: 300 })).toMatchObject({ capBps: 300, range: [100, 300] });
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R0", userCapBps: 900 }).capBps).toBe(300); // the band's range, not the tier's
    expect(capBpsFor({ tier: "institutional", mode: "balanced", exposureTier: "R1", userCapBps: 300 }).capBps).toBe(250);
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R3", userCapBps: 50 }).capBps).toBe(100);
    expect(capBpsFor({ tier: "high-value", mode: "max-safety", exposureTier: "R1", userCapBps: 300 }).capBps).toBe(100);
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R4", userCapBps: 300 }).capBps).toBe(100);
  });
});

describe("the market-impact limit (plan §80–§81)", () => {
  const base = { halvingFits: false, rfqQuotes: false, streamedPlan: false, otherVenues: false };
  it("no remedy under the limit; then reduce the tranche, an RFQ venue, a stream, another venue, in that order", () => {
    expect(impactRemedy({ ...base, trancheImpactBps: null })).toBe("none");
    expect(impactRemedy({ ...base, trancheImpactBps: IMPACT_LIMIT_BPS })).toBe("none");
    expect(impactRemedy({ ...base, trancheImpactBps: 180, halvingFits: true, rfqQuotes: true, streamedPlan: true, otherVenues: true })).toBe("reduce-tranche");
    expect(impactRemedy({ ...base, trancheImpactBps: 180, rfqQuotes: true, streamedPlan: true, otherVenues: true })).toBe("rfq");
    expect(impactRemedy({ ...base, trancheImpactBps: 180, streamedPlan: true, otherVenues: true })).toBe("streaming");
    expect(impactRemedy({ ...base, trancheImpactBps: 180, otherVenues: true })).toBe("other-venue");
    expect(impactRemedy({ ...base, trancheImpactBps: 180 })).toBe("reduce-tranche");
  });
});

describe("velocity (plan §62)", () => {
  it("counts the trailing 24 h of hand-overs; a missing limit never refuses", () => {
    const now = 100 * 3600_000;
    const h = [{ at: now - 23 * 3600_000, usd: 400_000 }, { at: now - 25 * 3600_000, usd: 900_000 }, { at: now - 60_000, usd: 100_000 }];
    expect(velocityExceeded(h, 250_000, 1_000_000, now)).toEqual({ exceeded: false, usedUsd: 500_000 });
    expect(velocityExceeded(h, 600_000, 1_000_000, now)).toEqual({ exceeded: true, usedUsd: 500_000 });
    expect(velocityExceeded(h, 600_000, undefined, now).exceeded).toBe(false);
    expect(velocityExceeded(h, 600_000, 0, now).exceeded).toBe(false);
  });
});
