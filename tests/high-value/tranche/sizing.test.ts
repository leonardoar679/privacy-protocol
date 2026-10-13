// The tranche engine (plan §22–§24; contract §3.6): the pieces of an order are one bucket, or the sum of two, inside the
// band and under the cap; the last piece absorbs the remainder; `varied` never puts two equal pieces side by side
// (I-P 4: identical tranche patterns are discouraged); randomness alone is never the privacy argument — the pattern
// is measured (privacy/). Over many seeds, sizes and decimals.
import { describe, it, expect } from "vitest";
import { planTranches } from "../../../packages/protocol/src/wallet/campaign";
import { bucketsFor } from "../../../packages/protocol/src/wallet/amounts";
import { seeded, sum, ETH, USDC } from "../helpers";

const bucketish = (x: bigint, d: number): boolean => { const a = bucketsFor(d); return a.includes(x) || a.some((p) => a.some((q) => q * 10n >= p && p + q === x)); };

describe("the splitter (plan §22–§24)", () => {
  it("$10M in ETH at 2.5 %: every piece under the cap, in band or the remainder, the whole order covered, ≈ 40–80 steps", () => {
    const total = 2500n * ETH;
    for (const sizing of ["bucket", "varied"] as const) {
      const r = planTranches(total, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing, maxParallel: 1, rng: seeded(3) });
      const cap = (total * 250n) / 10000n, lower = (total * 200n) / 10000n;
      expect(sum(r.pieces)).toBe(total);
      for (const p of r.pieces) expect(p <= cap).toBe(true);
      for (const p of r.pieces.slice(0, -1)) { expect(p >= lower).toBe(true); expect(bucketish(p, 18), `${p}`).toBe(true); }
      expect(r.pieces.length).toBeGreaterThanOrEqual(40);
      expect(r.pieces.length).toBeLessThanOrEqual(80);
    }
  });
  it("I-P 4: varied sizing never repeats a size twice in a row when two sizes fit the band — over 200 seeds, sizes and both decimals", () => {
    let checked = 0;
    for (let s = 0; s < 200; s++) {
      const rng = seeded(100 + s);
      const decimals = s % 2 ? 18 : 6;
      const total = BigInt(1000 + Math.floor(rng() * 20000)) * 10n ** BigInt(decimals);
      const r = planTranches(total, { decimals, bandBps: [200, 300], capBps: 300, sizing: "varied", maxParallel: 1, rng });
      const sizes = new Set(r.pieces.slice(0, -1).map(String));
      if (sizes.size < 2) continue; // one size fits the band: nothing to vary
      checked++;
      for (let i = 1; i < r.pieces.length - 1; i++) expect(r.pieces[i] !== r.pieces[i - 1], `seed ${s} pieces ${i - 1},${i}`).toBe(true);
    }
    expect(checked).toBeGreaterThan(100);
  });
  it("the plan's §23 example: pieces between 2.0 % and 3.0 % of the order differ (never 250K, 250K, 250K …)", () => {
    const total = 10_000_000n * USDC;
    const r = planTranches(total, { decimals: 6, bandBps: [200, 300], capBps: 300, sizing: "varied", maxParallel: 1, rng: seeded(9) });
    const fractions = r.pieces.slice(0, -1).map((p) => Number((p * 10000n) / total) / 100);
    for (const f of fractions) { expect(f).toBeGreaterThanOrEqual(2); expect(f).toBeLessThanOrEqual(3); }
    expect(new Set(fractions).size).toBeGreaterThan(1);
  });
  it("the thin-market ceiling and the parallel mode shrink the piece; a zero order plans nothing", () => {
    const total = 2500n * ETH;
    const a = planTranches(total, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded(1) });
    const b = planTranches(total, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing: "bucket", maxParallel: 2, rng: seeded(1) });
    const ceiling = planTranches(total, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing: "bucket", maxParallel: 1, maxPiece: 20n * ETH, rng: seeded(1) });
    expect(Math.max(...b.pieces.map(Number))).toBeLessThanOrEqual(Math.max(...a.pieces.map(Number)));
    for (const p of ceiling.pieces.slice(0, -1)) expect(p <= 20n * ETH).toBe(true);
    expect(planTranches(0n, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing: "bucket", maxParallel: 1, rng: seeded(1) }).pieces).toEqual([]);
  });
});
