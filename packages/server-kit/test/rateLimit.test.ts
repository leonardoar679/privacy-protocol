// Abuse limits: a caller gets its burst, then one request per interval; keys are independent;
// retry-after is honest; the table evicts stale callers before growing without bound.
import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/rateLimit";

describe("rate limiter", () => {
  it("allows the burst, then refills at the configured rate", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 60, burst: 3, now: () => t });
    expect([rl.allow("a"), rl.allow("a"), rl.allow("a")]).toEqual([true, true, true]);
    expect(rl.allow("a")).toBe(false);
    expect(rl.retryAfterSeconds("a")).toBe(1);
    t = 999;
    expect(rl.allow("a")).toBe(false);
    t = 1000;
    expect(rl.allow("a")).toBe(true); // one token per second at 60/min
    expect(rl.allow("a")).toBe(false);
    t = 61_000;
    expect([rl.allow("a"), rl.allow("a"), rl.allow("a"), rl.allow("a")]).toEqual([true, true, true, false]); // never more than the burst
  });
  it("keys are independent and stale keys are evicted when the table is full", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 60, burst: 1, now: () => t, maxKeys: 2 });
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("b")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    t = 120_000; // both stale
    expect(rl.allow("c")).toBe(true); // evicted a and b
    expect(rl.size).toBe(1);
    expect(rl.allow("a")).toBe(true); // a comes back fresh with its burst
  });
  it("rejects a non-positive rate", () => {
    expect(() => new RateLimiter({ perMinute: 0 })).toThrow(/positive/);
  });
});
