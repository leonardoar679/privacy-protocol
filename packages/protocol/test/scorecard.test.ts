// Privacy scorecard (plan §78): six categories per action, monotonic in every privacy lever, honest
// about what is public by design, and shaped like the plan's example for a private transfer.
import { describe, it, expect } from "vitest";
import { AMOUNT_FACTOR, TIMING_FACTOR, effectiveAnonymity, scorecard, type ScorecardFacts } from "../src/wallet/scorecard";

const base: ScorecardFacts = { poolSize: 5000, delaySeconds: 24 * 3600, amountIsBucket: true, privateSubmission: true, rpcEndpoints: 2, recipientFresh: true };
const keys = ["financial", "network", "recipient", "timing", "amount", "provider", "overall"] as const;

describe("scorecard", () => {
  it("has the six categories and an overall, all within 0..100, for every action", () => {
    for (const action of ["shield", "transfer", "withdraw", "swap", "credit"] as const) {
      const s = scorecard(action, { ...base, provider: { crossChainScore: 80, nativeAssets: true, kind: "deposit-address" }, credit: { runtimeKey: true, freshFunding: true } });
      for (const k of keys) { expect(s[k]).toBeGreaterThanOrEqual(0); expect(s[k]).toBeLessThanOrEqual(100); expect(Number.isInteger(s[k])).toBe(true); }
      expect(s.notes.length).toBeGreaterThan(0);
    }
  });

  it("a private transfer scores like the plan's example: nothing public but the transaction", () => {
    const s = scorecard("transfer", base);
    expect(s.financial).toBeGreaterThanOrEqual(95);
    expect(s.recipient).toBe(100);
    expect(s.amount).toBe(100);
    expect(s.timing).toBe(100);
    expect(s.overall).toBeGreaterThanOrEqual(90);
  });

  it("a shield is public by design: recipient 0 with the explanation; a bucket still protects the amount class", () => {
    const s = scorecard("shield", base);
    expect(s.recipient).toBe(0);
    expect(s.notes.join(" ")).toMatch(/public by design/);
    expect(scorecard("shield", { ...base, amountIsBucket: false }).financial).toBeLessThan(s.financial);
  });

  it("is monotonic in delay, bucketing, endpoints, submission and destination freshness for a withdrawal", () => {
    const w = (p: Partial<ScorecardFacts>) => scorecard("withdraw", { ...base, ...p });
    expect(w({ delaySeconds: 0 }).timing).toBeLessThan(w({ delaySeconds: 1800 }).timing);
    expect(w({ delaySeconds: 1800 }).timing).toBeLessThan(w({ delaySeconds: 7200 }).timing);
    expect(w({ delaySeconds: 7200 }).timing).toBeLessThan(w({ delaySeconds: 2 * 86400 }).timing);
    expect(w({ amountIsBucket: false }).amount).toBeLessThan(w({}).amount);
    expect(w({ amountIsBucket: false }).financial).toBeLessThan(w({}).financial);
    expect(w({ rpcEndpoints: 1 }).network).toBeLessThan(w({ rpcEndpoints: 2 }).network);
    expect(w({ privateSubmission: false }).network).toBeLessThan(w({}).network);
    expect(w({ recipientFresh: false }).recipient).toBeLessThan(w({}).recipient);
    expect(w({ poolSize: 50 }).financial).toBeLessThan(w({ poolSize: 50_000 }).financial);
    expect(w({ delaySeconds: 0, amountIsBucket: false, rpcEndpoints: 1, privateSubmission: false, recipientFresh: false }).overall).toBeLessThan(w({}).overall);
    expect(w({ delaySeconds: 0 }).notes.join(" ")).toMatch(/within an hour/);
    expect(w({ rpcEndpoints: 1 }).notes.join(" ")).toMatch(/one RPC endpoint/);
  });

  it("the effective anonymity set follows the lab factors and the financial score is a log scale of it", () => {
    expect(TIMING_FACTOR(0)).toBe(3.0);
    expect(TIMING_FACTOR(86400)).toBe(1.05);
    expect(AMOUNT_FACTOR(true)).toBe(2.9);
    expect(AMOUNT_FACTOR(false)).toBe(19.4);
    expect(effectiveAnonymity({ poolSize: 2000, delaySeconds: 3600, amountIsBucket: true })).toBeCloseTo(2000 / (1.2 * 2.9), 6);
    expect(effectiveAnonymity({ poolSize: 1, delaySeconds: 0, amountIsBucket: false })).toBe(1);
    expect(scorecard("withdraw", { ...base, poolSize: 1 }).financial).toBe(0);
    expect(scorecard("withdraw", { ...base, poolSize: 3000 * 1.05 * 2.9 }).financial).toBeGreaterThanOrEqual(99);
  });

  it("swap provider score follows the engine's cross-chain score; wrapped legs and aggregator APIs cost a little; credit depends on runtime-key mode and fresh funding", () => {
    const sw = (p: NonNullable<ScorecardFacts["provider"]>) => scorecard("swap", { ...base, provider: p }).provider;
    expect(sw({ crossChainScore: 80, nativeAssets: true, kind: "deposit-address" })).toBe(80);
    expect(sw({ crossChainScore: 80, nativeAssets: false, kind: "aggregator-api" })).toBe(70);
    expect(sw({ crossChainScore: 40, nativeAssets: true, kind: "signed-intent" })).toBeLessThan(sw({ crossChainScore: 80, nativeAssets: true, kind: "signed-intent" }));
    const cr = (c: NonNullable<ScorecardFacts["credit"]>) => scorecard("credit", { ...base, credit: c }).provider;
    expect(cr({ runtimeKey: true, freshFunding: true })).toBeGreaterThan(cr({ runtimeKey: true, freshFunding: false }));
    expect(cr({ runtimeKey: true, freshFunding: false })).toBeGreaterThan(cr({ runtimeKey: false, freshFunding: true }));
  });
});
