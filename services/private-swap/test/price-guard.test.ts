// The price guard (whale spec §14): a hard quote more than maxGapBps below the best live alternative is refused as a
// typed refusal (`PriceGuardError`, answered by the service as 409 `price_guard`, never a 500): the wallet shows the
// gap and signs nothing. Seen in the local-stack browser run: THORChain's hard quote 81 bps below Chainflip's fresh
// quote at the high-value cap of 50 bps.
import { describe, it, expect } from "vitest";
import { priceGuard, PriceGuardError } from "../src/scoring";
import type { Quote } from "../src/types";

const quote = (provider: string, min: bigint): Quote => ({ provider, category: "A", toAmount: min + 1000n, toAmountMin: min, fees: [], etaSeconds: 60, expiresAt: Math.floor(Date.now() / 1000) + 600, nativeAssets: true, minOutEncoded: true, hops: [], raw: {}, obtainedAt: Date.now() } as Quote);

describe("priceGuard (whale spec §14)", () => {
  it("refuses a hard quote more than maxGapBps below the best alternative, with the gap and the cap in the error", () => {
    const hard = quote("thorchain", 2_455_000_000n), alternative = quote("chainflip", 2_475_000_000n); // 80 bps below
    let err: unknown;
    try { priceGuard(hard, [alternative], 50); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PriceGuardError);
    const e = err as PriceGuardError;
    expect(e.code).toBe("price_guard");
    expect(e.provider).toBe("thorchain");
    expect(e.best).toBe("chainflip");
    expect(e.gapBps).toBe(80);
    expect(e.maxGapBps).toBe(50);
    expect(e.message).toMatch(/80 bps below the best alternative \(chainflip\); refusing to sign/);
  });
  it("accepts a hard quote within the tolerance, and one that is itself the best", () => {
    expect(() => priceGuard(quote("thorchain", 2_465_000_000n), [quote("chainflip", 2_475_000_000n)], 50)).not.toThrow(); // 40 bps
    expect(() => priceGuard(quote("thorchain", 2_480_000_000n), [quote("chainflip", 2_475_000_000n)], 50)).not.toThrow();
  });
});
