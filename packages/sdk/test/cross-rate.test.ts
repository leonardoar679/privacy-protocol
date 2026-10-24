// The campaign's cross-rate at the time of use (audit round 2, n18): a price kept after failed refreshes was still trusted by
// its read-time flag, and the price-deviation pause compared the market with it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { priceStore } from "../src/prices";
import { crossRateFromPrices } from "../src/wallet/campaignRunner";

const NOW = 1_800_000_000; // seconds
const price = (symbol: string, usd1e8: bigint, updatedAt: number) => ({
  symbol,
  usd1e8,
  updatedAt,
  roundId: 1n,
  source: "chainlink",
  endpoints: 2,
  stale: false,
  heartbeatSeconds: 3600,
});
const campaign = { request: { from: { symbol: "ETH", decimals: 18 }, to: { symbol: "BTC", decimals: 8 } } } as never;

afterEach(() => vi.restoreAllMocks());

describe("the cross-rate", () => {
  it("is the prices' while they are fresh, and none once they are stale by the time of use", () => {
    vi.spyOn(priceStore, "state").mockReturnValue({
      prices: { chainId: 1, at: NOW, feeds: { ETH: price("ETH", 2_500_00000000n, NOW - 600), BTC: price("BTC", 100_000_00000000n, NOW - 600) } },
    } as never);
    expect(crossRateFromPrices(campaign, NOW * 1000)).toBe(2_500_000n); // 0.025 BTC per ETH: 2.5e6 sats per 1e18 wei
    expect(crossRateFromPrices(campaign, (NOW + 3 * 3600) * 1000), "kept after failed refreshes: stale by now").toBeNull();
  });
});
