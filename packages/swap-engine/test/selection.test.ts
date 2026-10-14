// Route selection and settlement, the doc's §81–§82 cases the V6 swap relies on (spec v2.0 §13.3–§13.4, §12.4): the
// lowest fee wins between routes otherwise alike; a partial quote — no minimum output, no expiry — is refused whatever
// its nominal output; a provider that delivered while its callback is late stays pending, never failed and never
// refunded.
import { describe, expect, it } from "vitest";
import { chooseRoute, scoreRoutes } from "../src/scoring";
import { nextSettlement, settlementOf } from "../src/settlement";
import type { Health, Quote } from "../src/types";

const q = (provider: Quote["provider"], toMin: bigint, extra: Partial<Quote> = {}): Quote => ({
  provider,
  category: "A",
  toAmount: toMin + 100n,
  toAmountMin: toMin,
  fees: [],
  etaSeconds: 600,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  nativeAssets: true,
  minOutEncoded: true,
  hops: [],
  raw: null,
  obtainedAt: Date.now(),
  ...extra,
});
const ok = (provider: Quote["provider"]): Health => ({ provider, reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now() });
const health = { thorchain: ok("thorchain"), chainflip: ok("chainflip"), mayan: ok("mayan") } as Record<Quote["provider"], Health>;

describe("route selection (spec v2.0 §13.3)", () => {
  it("the lowest fee — the higher guaranteed output — scores the higher price and wins under the best-price preference", () => {
    const cheap = q("thorchain", 1_000_000n, { fees: [{ kind: "network", amount: 1_000n, asset: "BTC" }] });
    const dear = q("chainflip", 990_000n, { fees: [{ kind: "network", amount: 11_000n, asset: "BTC" }] });
    const scores = scoreRoutes([dear, cheap], health, "best-price");
    const price = (p: string) => scores.find((s) => s.provider === p)!.components.price;
    expect(price("thorchain")).toBe(100);
    expect(price("chainflip"), "1 % less guaranteed: 10 points less").toBe(90);
    expect(chooseRoute(scores)?.provider).toBe("thorchain");
  });

  it("a partial quote is refused whatever its output: no minimum output, or no expiry", () => {
    const noMinimum = q("thorchain", 0n, { toAmount: 5_000_000n });
    const noExpiry = q("chainflip", 4_000_000n, { expiresAt: undefined as unknown as number });
    const honest = q("mayan", 900_000n);
    const scores = scoreRoutes([noMinimum, noExpiry, honest], health, "balanced");
    expect(scores.find((s) => s.provider === "thorchain")?.filtered).toBe("a partial quote: no minimum output");
    expect(scores.find((s) => s.provider === "chainflip")?.filtered).toBe("a partial quote: no expiry");
    expect(chooseRoute(scores)?.provider).toBe("mayan");
    expect(chooseRoute(scoreRoutes([noMinimum, noExpiry], health, "fastest")), "never chosen, under any policy").toBeUndefined();
  });
});

describe("settlement when the provider delivered and its callback is late (doc §82)", () => {
  it("executed, the provider's status still pending: PROVIDER_PENDING — not completed, not failed, no refund offered", () => {
    expect(settlementOf({ funded: true, executed: true, provider: "pending", refundable: false })).toBe("PROVIDER_PENDING");
    expect(settlementOf({ funded: true, executed: true, provider: "destination-submitted", refundable: false })).toBe("DESTINATION_PENDING");
    // the callback arrives: completed; an outage in between never downgrades what was known
    expect(nextSettlement("DESTINATION_PENDING", null)).toBe("DESTINATION_PENDING");
    expect(nextSettlement("DESTINATION_PENDING", { funded: true, executed: true, provider: "delivered", refundable: false })).toBe("COMPLETED");
  });
});
