import { describe, it, expect } from "vitest";
import { BUCKETS, WEI, decompose, isBucket, planShield, planWithdrawal, selectInputs, sampleDelay, POLICY } from "../src/wallet/amounts";

const eth = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

describe("bucket alphabet", () => {
  it("is the 1-2-5 series from 0.001 to 500, sorted, distinct", () => {
    expect(BUCKETS[0]).toBe(eth(0.001));
    expect(BUCKETS.at(-1)).toBe(500n * WEI);
    expect(new Set(BUCKETS.map(String)).size).toBe(BUCKETS.length);
    for (let i = 1; i < BUCKETS.length; i++) expect(BUCKETS[i] > BUCKETS[i - 1]).toBe(true);
    expect(isBucket(eth(0.2))).toBe(true);
    expect(isBucket(eth(0.3))).toBe(false);
  });
});

describe("decomposition", () => {
  it("conserves value: pieces + remainder == amount, every piece a bucket", () => {
    for (const a of [1.73, 0.0007, 12.345678, 999]) {
      const { pieces, remainder } = decompose(eth(a), POLICY.standard);
      expect(pieces.reduce((s, p) => s + p, 0n) + remainder).toBe(eth(a));
      for (const p of pieces) expect(isBucket(p)).toBe(true);
    }
  });
  it("1.73 -> 1 + 0.5 + 0.2 + 0.02 + 0.01, nothing left", () => {
    const { pieces, remainder } = decompose(eth(1.73), POLICY.standard);
    expect(pieces).toEqual([eth(1), eth(0.5), eth(0.2), eth(0.02), eth(0.01)]);
    expect(remainder).toBe(0n);
  });
  it("respects maxBucket (high mode splits more) and maxPieces", () => {
    const s = decompose(eth(7), POLICY.standard);
    const h = decompose(eth(7), POLICY.high);
    expect(s.pieces).toEqual([eth(5), eth(2)]);
    expect(h.pieces).toEqual([eth(1), eth(1), eth(1), eth(1), eth(1), eth(1), eth(1)]);
    const capped = decompose(eth(123.456), { maxBucket: 1n * WEI, maxPieces: 3 });
    expect(capped.pieces.length).toBe(3);
    expect(capped.remainder).toBe(eth(123.456) - 3n * WEI);
  });
});

describe("plans", () => {
  it("a shield never carries an odd public amount", () => {
    const p = planShield(eth(1.7349));
    for (const x of p.pieces) expect(isBucket(x)).toBe(true);
    expect(p.pieces).toEqual([eth(1), eth(0.5), eth(0.2), eth(0.02), eth(0.01), eth(0.002)]);
    expect(p.leftOutside).toBe(eth(0.0029));
  });
  it("a withdrawal keeps the inexpressible part private", () => {
    const w = planWithdrawal(eth(0.3004), eth(2));
    expect(w.pieces).toEqual([eth(0.2), eth(0.1)]);
    expect(w.keptPrivate).toBe(eth(0.0004));
    expect(() => planWithdrawal(eth(3), eth(2))).toThrow(/insufficient/);
  });
  it("delays never undercut the policy floor", () => {
    let u = 0.0001;
    for (let i = 0; i < 100; i++) {
      const d = sampleDelay("standard", () => (u = (u * 7919) % 1));
      expect(d).toBeGreaterThanOrEqual(POLICY.standard.minDelaySeconds);
    }
  });
});

describe("UTXO selection (2-input circuit)", () => {
  const notes = [
    { id: "a", amount: eth(0.5) }, { id: "b", amount: eth(0.3) }, { id: "c", amount: eth(0.2) }, { id: "d", amount: eth(0.1) },
  ];
  it("prefers the smallest single sufficient note", () => {
    const s = selectInputs(notes, eth(0.25));
    expect(s.inputs.map((n) => n.id)).toEqual(["b"]);
    expect(s.change).toBe(eth(0.05));
  });
  it("uses a pair when no single note suffices", () => {
    const s = selectInputs(notes, eth(0.75));
    expect(s.inputs.length).toBe(2);
    expect(s.merges).toEqual([]);
    expect(s.inputs[0].amount + s.inputs[1].amount - s.change).toBe(eth(0.75));
  });
  it("plans merges when more than two notes are needed", () => {
    const s = selectInputs(notes, eth(1.05));
    expect(s.merges.length).toBeGreaterThan(0);
    expect(s.inputs.length).toBe(2);
    expect(s.inputs[0].amount + s.inputs[1].amount - s.change).toBe(eth(1.05));
  });
});
