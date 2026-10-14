// The fee model (Privacy Wallet Web spec v2.0 §3; doc §80): exactly 1 % of round amounts in 6, 8 and 18 decimals, the
// ceiling at 1 / 99 / 100 / 101 base units and at 2^255, exact output as the least input that delivers exactly R
// (10,000 seeded cases), the wallet's every split accepted by the relayer's rule, the rule's two refusals, the
// document's figures (5,000 USDC protected → 4,950; 2,500 USDC sent with F = 4.10 → 2,470.90), ProtectRouter's own fee
// (forge's vector), and no floating point anywhere in the fee code.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PRIVACY_FEE_BPS,
  bpsLabel,
  bpsOf,
  exactInput,
  exactOutput,
  feeForWithdrawal,
  feeMeetsTerms,
  privacyFee,
  protectSplit,
  swapFunding,
  type FeeTerms,
} from "../src/wallet/fees";

const USDC = 10n ** 6n;

/** mulberry32: the seeded cases are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const big = (r: () => number, digits: number): bigint => {
  let s = "";
  for (let i = 0; i < digits; i++) s += String(Math.floor(r() * 10));
  return BigInt(s);
};

describe("the privacy fee p(A) = ⌈A·b/10000⌉ (spec §3)", () => {
  it("is exactly 1 % of $1,000, $10,000 and $100,000 in 6, 8 and 18 decimals", () => {
    for (const decimals of [6n, 8n, 18n])
      for (const usd of [1_000n, 10_000n, 100_000n]) {
        const amount = usd * 10n ** decimals;
        expect(privacyFee(amount, PRIVACY_FEE_BPS), `${usd} at ${decimals} decimals`).toBe(amount / 100n);
      }
  });
  it("rounds up: 1, 99, 100, 101 base units pay 1, 1, 1, 2; 2^255 pays its exact ceiling", () => {
    expect([1n, 99n, 100n, 101n].map((a) => privacyFee(a, 100))).toEqual([1n, 1n, 1n, 2n]);
    expect(privacyFee(2n ** 255n, 100)).toBe(2n ** 255n / 100n + 1n);
    expect(privacyFee(0n, 100)).toBe(0n);
    expect(privacyFee(10_000n, 0)).toBe(0n);
  });
  it("refuses a fee that is not an integer number of basis points below 100 %", () => {
    expect(() => bpsOf(1.5)).toThrow(RangeError);
    expect(() => bpsOf(-1)).toThrow(RangeError);
    expect(() => bpsOf(10_000)).toThrow(RangeError);
    expect(bpsLabel(100)).toBe("1.00 %");
    expect(bpsLabel(25)).toBe("0.25 %");
    expect(bpsLabel(250)).toBe("2.50 %");
  });
  it("is ProtectRouter's own fee: forge's vector (contracts/test/periphery/vectors/protect-fee.json)", () => {
    const path = fileURLToPath(new URL("../../../contracts/test/periphery/vectors/protect-fee.json", import.meta.url));
    const v = JSON.parse(readFileSync(path, "utf8")) as { feeBps: number; cases: { gross: string; fee: string }[] };
    expect(v.feeBps).toBe(PRIVACY_FEE_BPS);
    expect(v.cases.length).toBeGreaterThan(10);
    for (const c of v.cases) {
      const s = protectSplit(BigInt(c.gross));
      expect(s.fee, `gross ${c.gross}`).toBe(BigInt(c.fee));
      expect(s.fee + s.net).toBe(BigInt(c.gross));
    }
  });
});

describe("the operations' splits (spec §3)", () => {
  const F = 4_100_000n; // 4.10 USDC: the relayer's 3.727273 with the wallet's 10 % margin, the document's example
  const T: FeeTerms = { minimum: F, feePercentBps: 100 };
  it("Protect 5,000 USDC: the note is 4,950, the fee 50", () => {
    expect(protectSplit(5_000n * USDC)).toEqual({ gross: 5_000n * USDC, fee: 50n * USDC, net: 4_950n * USDC });
  });
  it("Send 2,500 USDC (exact input): 25 + 4.10 in one fee note, 2,470.90 arrives", () => {
    expect(exactInput(2_500n * USDC, T)).toEqual({
      total: 2_500n * USDC,
      delivered: 2_470_900_000n,
      fee: 29_100_000n,
      privacy: 25n * USDC,
      network: F,
      tooSmall: false,
    });
  });
  it("Send so that 2,470.90 arrives (exact output): the least input is 2,500", () => {
    const s = exactOutput(2_470_900_000n, T);
    expect(s.total).toBe(2_500n * USDC);
    expect(s.total - s.fee).toBe(2_470_900_000n);
  });
  it("Swap 10,000 USDC: W = 10,000 − 100 − F funds the escrow; the fee note is 100 + F", () => {
    const s = swapFunding(10_000n * USDC, T);
    expect(s.privacy).toBe(100n * USDC);
    expect(s.delivered).toBe(10_000n * USDC - 100n * USDC - F);
    expect(s.fee + s.delivered).toBe(10_000n * USDC);
  });
  it("an input that does not cover the fees delivers nothing", () => {
    expect(exactInput(F, T)).toMatchObject({ delivered: 0n, tooSmall: true });
    const least = exactOutput(1n, T).total; // F plus its own 1 %, rounded up
    expect(least).toBe(4_141_416n);
    expect(exactInput(least - 1n, T)).toMatchObject({ delivered: 0n, tooSmall: true });
    expect(exactInput(least, T)).toMatchObject({ delivered: 1n, tooSmall: false });
    expect(exactOutput(0n, T)).toMatchObject({ tooSmall: true, total: 0n });
  });
});

describe("exact output is the least input that delivers exactly R (10,000 seeded cases)", () => {
  it("round trip and minimality", () => {
    const r = rng(80);
    for (let i = 0; i < 10_000; i++) {
      const terms: FeeTerms = { minimum: big(r, 1 + Math.floor(r() * 8)), feePercentBps: Math.floor(r() * 500) };
      const R = big(r, 1 + Math.floor(r() * 30)) + 1n;
      const out = exactOutput(R, terms);
      const back = exactInput(out.total, terms);
      expect(back.delivered, `R ${R} with ${terms.minimum} and ${terms.feePercentBps} bps`).toBe(R);
      expect(back.fee).toBe(out.fee);
      expect(exactInput(out.total - 1n, terms).delivered, "one unit less delivers less").toBeLessThan(R);
    }
  });
});

describe("the relayer's rule f ≥ ⌈(W + f)·b/10000⌉ + m (spec §3)", () => {
  it("accepts every split the wallet makes, whatever the relayer's minimum m ≤ F", () => {
    const r = rng(42);
    for (let i = 0; i < 5_000; i++) {
      const m = big(r, 1 + Math.floor(r() * 7));
      const F = m + (m * BigInt(Math.floor(r() * 2_000))) / 10_000n; // the wallet's margin over the relayer's minimum
      const b = Math.floor(r() * 300);
      const terms: FeeTerms = { minimum: F, feePercentBps: b };
      const A = big(r, 1 + Math.floor(r() * 24)) + F + 2n;
      const sent = exactInput(A, terms);
      if (!sent.tooSmall) expect(feeMeetsTerms(sent.delivered, sent.fee, b, m).ok, `exact input ${A}`).toBe(true);
      const W = big(r, 1 + Math.floor(r() * 24)) + 1n;
      expect(feeMeetsTerms(W, feeForWithdrawal(W, terms), b, m).ok, `a withdrawal of ${W}`).toBe(true);
    }
  });
  it("names its refusals: below the minimum, then below the percentage", () => {
    expect(feeMeetsTerms(10_000n, 99n, 100, 100n)).toEqual({ ok: false, code: "fee_too_low", required: 201n });
    expect(feeMeetsTerms(10_000n, 150n, 100, 100n)).toEqual({ ok: false, code: "fee_below_percent", required: 202n });
    expect(feeMeetsTerms(10_000n, 202n, 100, 100n), "202 raises W + f to 10,202: ⌈102.02⌉ + 100").toMatchObject({ ok: false, required: 203n });
    expect(feeMeetsTerms(10_000n, 203n, 100, 100n)).toEqual({ ok: true, required: 203n });
    expect(feeForWithdrawal(10_000n, { minimum: 100n, feePercentBps: 100 }), "the wallet pays exactly that").toBe(203n);
  });
  it("a swap's escrow funding pays the percentage too (the V5 exemption is gone)", () => {
    const terms: FeeTerms = { minimum: 4_100_000n, feePercentBps: 100 };
    const s = swapFunding(10_000n * USDC, terms);
    expect(feeMeetsTerms(s.delivered, s.fee, 100, 3_727_273n).ok).toBe(true);
    expect(feeMeetsTerms(s.delivered, terms.minimum, 100, 3_727_273n)).toMatchObject({ ok: false, code: "fee_below_percent" });
  });
});

describe("no floating point in the fee code", () => {
  it("fees.ts calls no Number(, parseFloat or Math.", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/wallet/fees.ts", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bNumber\(|\bparseFloat\b|\bparseInt\b|\bMath\.|toFixed\(/);
  });
});
