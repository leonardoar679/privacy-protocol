// The controlled-RFQ interface (plan §10–§12, §40; contract §2.2, §3.3, §10): a signed hard quote inside strict bounds
// is the R1 exposure tier with its own band; the hard quote's expiry rules hold whatever the venue; UniswapX stays a
// deferred interface — a class in the shared risk model, no adapter, no record in the risk database.
import { describe, it, expect } from "vitest";
import { TIER_RANGES, capBpsFor, exposureTierOf, impactRemedy } from "../../../packages/protocol/src/wallet/exposurePolicy";
import { PROVIDER_RISK, riskModelOf } from "../../../packages/protocol/src/wallet/riskClasses";
import { checkWithinBounds } from "../../../packages/protocol/src/wallet/campaign";
import { riskDb } from "../../../packages/swap-engine/src/risk/riskDb";
import { bounds, ETH, REF_RATE } from "../helpers";

describe("R1 — controlled RFQ (plan §6, §10–§12)", () => {
  it("a solver route with a signed hard quote is R1 with the 2.5–5 % band; without the signature it is R3", () => {
    expect(exposureTierOf({ class: "R2" }, { signedHardQuote: true }).tier).toBe("R1");
    expect(exposureTierOf({ class: "R2" }, { signedHardQuote: false }).tier).toBe("R3");
    expect(TIER_RANGES.R1).toEqual([250, 500]);
    expect(capBpsFor({ tier: "high-value", mode: "balanced", exposureTier: "R1", userCapBps: 300 }).capBps, "the user may raise the cap on R1").toBe(300);
    expect(capBpsFor({ tier: "high-value", mode: "max-safety", exposureTier: "R1" }).capBps, "Maximum Safety still 1 %").toBe(100);
  });
  it("the hard quote (plan §12): after its expiry DO NOT EXECUTE — a quote outliving the campaign or already past is refused", () => {
    const b = bounds();
    const okQuote = { amount: 50n * ETH, toAmountMin: (50n * ETH * REF_RATE) / 10n ** 18n + 1n, quoteExpiresAt: b.expiry - 1, feeBps: 10, destination: "bc1qfresh", fundedBefore: 0n, now: 1_000_000 };
    expect(checkWithinBounds(b, okQuote).ok).toBe(true);
    expect(checkWithinBounds(b, { ...okQuote, quoteExpiresAt: b.expiry + 1 }).ok).toBe(false);
    expect(checkWithinBounds(b, { ...okQuote, now: b.expiry + 1 }).ok).toBe(false);
  });
  it("an RFQ venue is the second remedy for a thin market (plan §81) — none quotes today, so the stream or another venue follows", () => {
    expect(impactRemedy({ trancheImpactBps: 120, halvingFits: false, rfqQuotes: true, streamedPlan: true, otherVenues: true })).toBe("rfq");
    expect(impactRemedy({ trancheImpactBps: 120, halvingFits: false, rfqQuotes: false, streamedPlan: true, otherVenues: true })).toBe("streaming");
  });
  it("UniswapX is an interface: a class in the shared model (R2 solver), no record in the risk database, no adapter", () => {
    expect(PROVIDER_RISK.uniswapx).toMatchObject({ class: "R2", custody: "solver" });
    expect(riskModelOf("uniswapx", { plan: { mode: "auction" } }, { symbol: "ETH" }, { symbol: "USDC" })).toMatchObject({ class: "R2", flags: ["R7"] });
    expect(riskDb().override("uniswapx")).toBeNull();
    expect(riskDb().providerRisk("uniswapx")).toBeNull();
  });
});
