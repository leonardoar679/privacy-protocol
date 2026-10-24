// Abuse limits: a caller gets its burst, then one request per interval; keys are independent;
// retry-after is honest; the table evicts stale callers before growing without bound.
import { describe, it, expect } from "vitest";
import { RateLimiter, widerOf } from "../src/rateLimit";

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
  it("the /64s of one /48 share its allowance: sixteen bursts in all, then each waits (audit round 2, n04)", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 60, burst: 2, now: () => t });
    expect(widerOf("2001:db8:1:2::/64")).toBe("2001:db8:1::/48");
    expect([widerOf("203.0.113.7"), widerOf("unknown")]).toEqual([null, null]);
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (rl.allow(`2001:db8:1:${i.toString(16)}::/64`)) allowed++;
    expect(allowed, "16 × the burst of 2").toBe(32);
    expect(rl.retryAfterSeconds("2001:db8:1:ff::/64"), "a fresh /64 of a drained /48 waits").toBeGreaterThan(0);
    expect(rl.allow("2001:db8:2:0::/64"), "another /48 is its own").toBe(true);
    t = 1_000; // 16 tokens a second for the /48
    allowed = 0;
    for (let i = 0; i < 100; i++) if (rl.allow(`2001:db8:1:${(100 + i).toString(16)}::/64`)) allowed++;
    expect(allowed).toBe(16);
  });
  it("a full table makes room without forgiving a drained caller: the fullest bucket goes, never the oldest (audit round 2, n04)", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 1, burst: 3, now: () => t, maxKeys: 2, wider: null });
    expect([rl.allow("a"), rl.allow("a"), rl.allow("a"), rl.allow("a")]).toEqual([true, true, true, false]);
    expect(rl.allow("b")).toBe(true);
    t = 1_000;
    expect(rl.allow("c"), "room for a third: b, the fuller, went").toBe(true);
    expect(rl.allow("a"), "a, drained, is still drained").toBe(false);
  });
  it("rejects a non-positive rate", () => {
    expect(() => new RateLimiter({ perMinute: 0 })).toThrow(/positive/);
  });
});
