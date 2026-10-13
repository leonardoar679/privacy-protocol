// Risk classes (High-Value Protection spec §2, §10): the class per provider and quote, the flags, the gate under
// each mode, database overrides, the narrowed band, and ELPF.
import { describe, it, expect } from "vitest";
import { expectedLossPerFailure, narrowedBand, riskModelOf } from "../src/wallet/riskClasses";

const ETH = { symbol: "ETH" }, BTC = { symbol: "BTC" }, USDC = { symbol: "USDC" };

describe("riskModelOf", () => {
  it("THORChain and Chainflip are R5 with a destination-final gate; NEAR is R2 at destination submitted; Mayan depends on its plan", () => {
    expect(riskModelOf("thorchain", { plan: { mode: "streaming" } }, ETH, BTC)).toMatchObject({ class: "R5", custody: "tss-vaults", gate: "destination-final", bandBps: [100, 250], flags: [] });
    expect(riskModelOf("chainflip", { plan: { mode: "dca" } }, ETH, BTC)).toMatchObject({ class: "R5", custody: "mpc-vault" });
    expect(riskModelOf("near-intents", { plan: { mode: "intent" } }, ETH, BTC)).toMatchObject({ class: "R2", custody: "intent", gate: "destination-submitted", bandBps: [200, 300] });
    expect(riskModelOf("mayan", { plan: { mode: "auction" } }, ETH, { symbol: "SOL" })).toMatchObject({ class: "R2", custody: "solver", gate: "destination-submitted" });
    expect(riskModelOf("mayan", { plan: { mode: "single" } }, ETH, { symbol: "SOL" })).toMatchObject({ class: "R5", custody: "cctp", gate: "destination-final" });
  });
  it("flags: a source swap adds R3, an issuer-controlled leg adds R7; an unknown provider is treated as R5", () => {
    expect(riskModelOf("uniswap-across", { sourceSwap: true }, ETH, USDC).flags).toEqual(["R3", "R7"]);
    expect(riskModelOf("lifi", {}, USDC, BTC).flags).toEqual(["R7"]);
    expect(riskModelOf("someone-new", {}, ETH, BTC)).toMatchObject({ class: "R5", pFailPrior: 0.03 });
  });
  it("Maximum Safety raises the gate; the database overrides fields", () => {
    expect(riskModelOf("near-intents", {}, ETH, BTC, "max-safety").gate).toBe("destination-final");
    expect(riskModelOf("thorchain", {}, ETH, BTC, "balanced", { pFailPrior: 0.05, bandBps: [100, 200], gate: "destination-submitted" })).toMatchObject({ pFailPrior: 0.05, bandBps: [100, 200], gate: "destination-submitted" });
  });
  it("the band narrows to its lower edge for a weak provider; ELPF multiplies the probability by the exposure", () => {
    const m = riskModelOf("thorchain", {}, ETH, BTC);
    expect(narrowedBand(m, { security: 90 })).toEqual([100, 250]);
    expect(narrowedBand(m, { security: 69 })).toEqual([100, 100]);
    expect(narrowedBand(m, { breakerOpenedRecently: true })).toEqual([100, 100]);
    expect(narrowedBand(m, { incidentWithinDays: 12 })).toEqual([100, 100]);
    expect(narrowedBand(m, { incidentWithinDays: 120 })).toEqual([100, 250]);
    expect(expectedLossPerFailure({ pFailPrior: 0.02, exposed: 250_000 })).toEqual({ pFailure: 0.02, expectedLoss: 5_000 });
    expect(expectedLossPerFailure({ pFailPrior: 0.02, failuresInWindow: 3, incidentFactor: 2, exposed: 250_000 })).toEqual({ pFailure: 0.08, expectedLoss: 20_000 });
    expect(expectedLossPerFailure({ pFailPrior: 0.9, failuresInWindow: 30, exposed: 1 }).pFailure).toBe(1);
  });
});
