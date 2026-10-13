// The fee formulas (Privacy Wallet Web spec §10): the percentage rounds up, the minimum is a floor, exact-output adds
// the fee to what leaves and exact-input takes it out, the two are inverses, the breakdown says when the percentage
// covers the relayer's minimum.
import { describe, expect, it } from "vitest";
import { bpsLabel, exactInput, exactOutput, feeBreakdown, feeForDelivered, percentOf } from "../src/wallet/fees";

const T = { minimum: 500n, feePercentBps: 100 }; // F = 500 units, b = 1.00 %

describe("the fee formulas (spec §10)", () => {
  it("the percentage rounds up and is zero for no percentage or no amount", () => {
    expect(percentOf(10_000n, 100)).toBe(100n);
    expect(percentOf(10_001n, 100)).toBe(101n);
    expect(percentOf(1n, 100)).toBe(1n);
    expect(percentOf(10_000n, 0)).toBe(0n);
    expect(percentOf(0n, 100)).toBe(0n);
    expect(percentOf(10_000n, 250)).toBe(250n);
  });
  it("the fee is the larger of the minimum and the percentage", () => {
    expect(feeForDelivered(10_000n, T)).toBe(500n); // 1 % = 100 < F
    expect(feeForDelivered(50_000n, T)).toBe(500n); // exactly F
    expect(feeForDelivered(60_000n, T)).toBe(600n);
    expect(feeForDelivered(60_000n, { minimum: 500n, feePercentBps: 0 })).toBe(500n);
  });
  it("exact-output adds the fee to what leaves; exact-input takes it out and delivers nothing below the minimum", () => {
    expect(exactOutput(60_000n, T)).toEqual({ delivered: 60_000n, fee: 600n, total: 60_600n });
    expect(exactOutput(10_000n, T)).toEqual({ delivered: 10_000n, fee: 500n, total: 10_500n });
    expect(exactInput(60_600n, T)).toEqual({ delivered: 60_000n, fee: 600n, total: 60_600n });
    expect(exactInput(10_500n, T)).toEqual({ delivered: 10_000n, fee: 500n, total: 10_500n });
    expect(exactInput(400n, T)).toEqual({ delivered: 0n, fee: 400n, total: 400n });
    expect(exactInput(500n, T)).toEqual({ delivered: 0n, fee: 500n, total: 500n });
  });
  it("exact-input is the inverse of exact-output, within the rounding of one unit", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 48271) % 2147483647; return seed; };
    for (let i = 0; i < 2000; i++) {
      const delivered = BigInt(rnd() % 5_000_000) + 1n;
      const terms = { minimum: BigInt(rnd() % 10_000), feePercentBps: rnd() % 300 };
      const back = exactInput(exactOutput(delivered, terms).total, terms);
      expect(back.delivered).toBeGreaterThanOrEqual(delivered);
      expect(back.delivered - delivered).toBeLessThanOrEqual(1n);
      expect(back.fee).toBeGreaterThanOrEqual(terms.minimum);
    }
  });
  it("the breakdown names the privacy part, the relayer part and whether one covers the other; the label", () => {
    expect(feeBreakdown(60_000n, T)).toEqual({ privacy: 600n, relayer: 500n, relayerIncluded: true, total: 600n });
    expect(feeBreakdown(10_000n, T)).toEqual({ privacy: 100n, relayer: 500n, relayerIncluded: false, total: 500n });
    expect(bpsLabel(100)).toBe("1.00 %");
    expect(bpsLabel(25)).toBe("0.25 %");
  });
});
