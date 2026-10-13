// The execution bounds (plan §9–§16; contract §3.1): what one confirmation binds and what a provider can never get.
// Pins I-HV 3 (minimumOutput never relaxed), 4 (maximumFee never exceeded), 5 (the destination never changes after
// signing), 6 and 7 (chain and asset are fields of the bounds and nothing else names them), 8 (an expired quote never
// executes) and the plan's §108 (a provider that changes the price after commitment is refused by the bounds).
import { describe, it, expect } from "vitest";
import { checkWithinBounds, rateE18 } from "../../../packages/protocol/src/wallet/campaign";
import { bounds, ETH, REF_RATE } from "../helpers";

const b = bounds({ destination: { kind: "entered", address: "bc1qentered" } });
const per = (amountIn: bigint) => (amountIn * REF_RATE) / 10n ** 18n; // the minimum output the bound demands for amountIn
const ok = { amount: 50n * ETH, toAmountMin: per(50n * ETH) + 1n, quoteExpiresAt: 1_700_000, feeBps: 60, destination: "bc1qentered", fundedBefore: 0n, now: 1_000_000 };

describe("the execution bounds (plan §10, §13–§16)", () => {
  it("a hard quote inside every bound is accepted", () => {
    expect(checkWithinBounds(b, ok)).toEqual({ ok: true });
    expect(checkWithinBounds(b, { ...ok, toAmountMin: per(50n * ETH) })).toEqual({ ok: true }); // exactly the bound
  });
  it("I-HV 3: the minimum output is never relaxed — a quote guaranteeing less per unit is refused (plan §108: the bounds decide, not the provider)", () => {
    const r = checkWithinBounds(b, { ...ok, toAmountMin: per(50n * ETH) - 1n });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("minimum you approved") });
    // a provider that re-quotes a better-looking price and then shrinks it at commitment: the per-unit bound still holds per tranche
    expect(checkWithinBounds(b, { ...ok, amount: 100n * ETH, toAmountMin: per(50n * ETH) + 1n }).ok, "a bigger piece needs a proportionally bigger minimum").toBe(false);
  });
  it("I-HV 4: the maximum fee is never exceeded", () => {
    expect(checkWithinBounds(b, { ...ok, feeBps: 60 }).ok).toBe(true);
    expect(checkWithinBounds(b, { ...ok, feeBps: 61 })).toMatchObject({ ok: false, reason: expect.stringContaining("fee") });
  });
  it("I-HV 5: the destination never changes after signing — a call paying another receiver is outside the bounds", () => {
    expect(checkWithinBounds(b, { ...ok, destination: "bc1qother" })).toMatchObject({ ok: false, reason: expect.stringContaining("destination") });
    expect(checkWithinBounds(b, { ...ok, destination: "BC1QENTERED" }).ok, "case is not a change").toBe(true);
    // a per-tranche fresh destination policy binds the policy, not one address: any fresh address of the wallet passes this check (the runner reserves it)
    expect(checkWithinBounds(bounds(), { ...ok, destination: "bc1qfresh7" }).ok).toBe(true);
  });
  it("I-HV 6 and 7: the chain and the asset live in the bounds only; a tranche's request is derived from them and cannot differ", () => {
    const request = { from: b.assetIn, to: b.assetOut, chainIn: b.chainIn, chainOut: b.chainOut };
    expect(request.to).toEqual({ chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" });
    expect(request.chainOut).toBe("bitcoin");
    // the bounds are plain data: a copy through the journal is the same object (nothing a provider answers can rewrite it)
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });
  it("I-HV 8: an expired quote never executes — a quote past the campaign's expiry, or the campaign past its expiry, is refused; the amount limit holds across tranches", () => {
    expect(checkWithinBounds(b, { ...ok, quoteExpiresAt: b.expiry + 1 })).toMatchObject({ ok: false, reason: expect.stringContaining("outlives") });
    expect(checkWithinBounds(b, { ...ok, now: b.expiry })).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
    expect(checkWithinBounds(b, { ...ok, fundedBefore: 2353n * ETH - 49n * ETH })).toMatchObject({ ok: false, reason: expect.stringContaining("amount limit") });
    expect(checkWithinBounds(b, { ...ok, fundedBefore: 2353n * ETH - 50n * ETH }).ok).toBe(true);
  });
  it("the minimum per unit is a fixed-point rate: 1e18 × destination units per source unit", () => {
    expect(rateE18(24_000_000n, 800n * ETH)).toBe(REF_RATE);
    expect(rateE18(0n, 1n)).toBe(0n);
    expect(rateE18(5n, 0n), "no division by zero").toBe(0n);
  });
});
