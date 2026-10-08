// Valuation and tiers (whale-execution spec §13): the pure rules the wallet and the engine share.
import { describe, it, expect } from "vitest";
import {
  TIER_DEFAULTS, TIERS, agreePrices, assess, atLeast, checkThresholds, decodeLatestRoundData, decodeString, feedsFor, formatUsd, higherTier, isStale, parsePrices, serializePrices, tierOf, usdOf, type FeedSpec, type PriceRead, type Prices,
} from "../src/wallet/valuation";

const ETH: FeedSpec = { symbol: "ETH", description: "ETH / USD", heartbeatSeconds: 3600, proxy: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" };
const read = (usd: number, over: Partial<PriceRead> = {}): PriceRead => ({ symbol: "ETH", usd1e8: BigInt(Math.round(usd * 1e8)), roundId: 100n, updatedAt: 1_000_000, source: "rpc-a", ...over });
const NOW = 1_000_600;
const prices = (usd: number, over: Partial<PriceRead> = {}, at = NOW): Prices => {
  const a = agreePrices([read(usd, over)], ETH, NOW);
  if ("disagree" in a) throw new Error(a.disagree);
  return { chainId: 1, at, feeds: { ETH: a } };
};

describe("tiers (spec §13)", () => {
  it("places a USD value by the plan V2 §13 thresholds, boundaries inclusive", () => {
    expect(tierOf(0)).toBe("standard");
    expect(tierOf(99_999.99)).toBe("standard");
    expect(tierOf(100_000)).toBe("enhanced");
    expect(tierOf(999_999)).toBe("enhanced");
    expect(tierOf(1_000_000)).toBe("high-value");
    expect(tierOf(4_999_999)).toBe("high-value");
    expect(tierOf(5_000_000)).toBe("high-value-secondary");
    expect(tierOf(10_000_000)).toBe("institutional");
    expect(tierOf(3_420_000, { ...TIER_DEFAULTS, highValueSecondary: 3_000_000 })).toBe("high-value-secondary");
    expect(() => tierOf(-1)).toThrow();
  });
  it("orders tiers and refuses nonsense thresholds", () => {
    expect(TIERS).toEqual(["standard", "enhanced", "high-value", "high-value-secondary", "institutional"]);
    expect(higherTier("enhanced", "institutional")).toBe("institutional");
    expect(atLeast("high-value", "enhanced")).toBe(true);
    expect(atLeast("standard", "enhanced")).toBe(false);
    expect(() => checkThresholds({ ...TIER_DEFAULTS, highValue: 50_000 })).toThrow(/increase/);
    expect(() => checkThresholds({ ...TIER_DEFAULTS, enhanced: 0 })).toThrow(/positive/);
  });
});

describe("prices (spec §13)", () => {
  it("values base units with an 8-decimal price exactly to the cent", () => {
    expect(usdOf(10n ** 18n, 18, 2_571_28730658n)).toBe(2571.28);
    expect(usdOf(1_330n * 10n ** 18n, 18, 2_567_97000000n)).toBe(3_415_400.1);
    expect(usdOf(5_000_000n * 10n ** 6n, 6, 99_977_851n)).toBe(4_998_892.55);
    expect(usdOf(0n, 8, 83_279_00000000n)).toBe(0);
    expect(() => usdOf(-1n, 18, 1n)).toThrow();
  });
  it("decodes a real latestRoundData() and description() answer", () => {
    // ETH / USD on mainnet, 2026-10-07: round 0x7000000000000865c, answer 0x3be1459022 = 257182502946 ($2,571.83), updatedAt 0x6ac66cdf
    const rd = decodeLatestRoundData("0x000000000000000000000000000000000000000000000007000000000000865c0000000000000000000000000000000000000000000000000000003be1459022000000000000000000000000000000000000000000000000000000006ac66ccc000000000000000000000000000000000000000000000000000000006ac66cdf000000000000000000000000000000000000000000000007000000000000865c");
    expect(rd.answer).toBe(257182502946n);
    expect(rd.updatedAt).toBe(0x6ac66cdf);
    expect(rd.roundId).toBe(0x7000000000000865cn);
    expect(decodeString("0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000009455448202f205553440000000000000000000000000000000000000000000000")).toBe("ETH / USD");
    expect(() => decodeLatestRoundData("0x1234")).toThrow(/short/);
  });
  it("agrees reads within 0.5 % and one round, takes the newest, flags staleness at twice the heartbeat", () => {
    const a = agreePrices([read(2500), read(2500 * 1.004, { source: "rpc-b", roundId: 101n, updatedAt: 1_000_300 })], ETH, NOW);
    expect("disagree" in a).toBe(false);
    if (!("disagree" in a)) { expect(a.roundId).toBe(101n); expect(a.endpoints).toBe(2); expect(a.stale).toBe(false); expect(a.source).toBe("rpc-b"); }
    expect(agreePrices([read(2500), read(2500 * 1.02, { source: "rpc-b" })], ETH, NOW)).toMatchObject({ disagree: expect.stringContaining("answers") });
    expect(agreePrices([read(2500), read(2500, { source: "rpc-b", roundId: 97n })], ETH, NOW)).toMatchObject({ disagree: expect.stringContaining("rounds behind") });
    expect(agreePrices([], ETH, NOW)).toMatchObject({ disagree: "no endpoint answered" });
    expect(isStale({ updatedAt: NOW - 7200 }, ETH, NOW)).toBe(false);
    expect(isStale({ updatedAt: NOW - 7201 }, ETH, NOW)).toBe(true);
    const stale = agreePrices([read(2500, { updatedAt: NOW - 8000 })], ETH, NOW);
    if (!("disagree" in stale)) expect(stale.stale).toBe(true);
  });
  it("round-trips a read through its JSON (journal) form and refuses a broken one", () => {
    const p = prices(2571.28);
    p.feeds.SOL = { unavailable: true, reason: "stale" };
    const j = JSON.parse(JSON.stringify(serializePrices(p)));
    expect(parsePrices(j)).toEqual(p);
    expect(parsePrices(null)).toBeNull();
    expect(parsePrices({ chainId: 1, at: 1, feeds: { ETH: { ...j.feeds.ETH, usd1e8: "abc" } } })).toBeNull();
  });
  it("knows the mainnet and Sepolia feed tables and nothing for a devnet unless told", () => {
    expect(feedsFor(1).map((f) => f.symbol)).toEqual(["ETH", "BTC", "USDC", "USDT", "SOL"]);
    expect(feedsFor(11155111).map((f) => f.symbol)).toEqual(["ETH", "BTC", "USDC"]);
    expect(feedsFor(31337)).toEqual([]);
    expect(feedsFor(31337, [ETH])).toEqual([ETH]);
  });
});

describe("assess (spec §1, §13)", () => {
  it("values an amount with a live price and tiers it", () => {
    const a = assess({ amount: 1_330n * 10n ** 18n, decimals: 18, symbol: "ETH", prices: prices(2567.97), now: NOW });
    expect(a.failSafe).toBe(false);
    expect(a.tier).toBe("high-value");
    expect(a.value).toMatchObject({ usd: 3_415_400.1, source: "chainlink", feeds: [{ pair: "ETH / USD", roundId: "100" }] });
  });
  it("without a usable price the fail-safe applies: at least high-value, or the tier the last journaled price implies", () => {
    const none = assess({ amount: 10n ** 18n, decimals: 18, symbol: "ETH", prices: null, now: NOW });
    expect(none).toMatchObject({ tier: "high-value", failSafe: true, value: { unavailable: true, reason: "no price read yet" } });
    const stale = assess({ amount: 10n ** 18n, decimals: 18, symbol: "ETH", prices: prices(2500, { updatedAt: NOW - 90_000 }), now: NOW });
    expect(stale).toMatchObject({ tier: "high-value", failSafe: true });
    expect((stale.value as { reason: string }).reason).toMatch(/stale/);
    const noFeed = assess({ amount: 10n ** 18n, decimals: 18, symbol: "SOL", prices: prices(2500), now: NOW });
    expect((noFeed.value as { reason: string }).reason).toMatch(/no SOL \/ USD feed/);
    // the last journaled price (< 24 h) implies institutional for 5,000 ETH: the higher tier wins
    const remembered = assess({ amount: 5_000n * 10n ** 18n, decimals: 18, symbol: "ETH", prices: null, lastPrices: prices(2500, {}, NOW - 3600), now: NOW });
    expect(remembered.tier).toBe("institutional");
    // the same memory a day later counts for nothing beyond the floor
    const forgotten = assess({ amount: 5_000n * 10n ** 18n, decimals: 18, symbol: "ETH", prices: null, lastPrices: prices(2500, {}, NOW - 90_000), now: NOW });
    expect(forgotten.tier).toBe("high-value");
    // a small amount is still at least high-value without a price: a few extra checks, never under-protection
    expect(assess({ amount: 10n ** 15n, decimals: 18, symbol: "ETH", prices: null, now: NOW }).tier).toBe("high-value");
  });
});

describe("formatUsd", () => {
  it("prints money the way the screens show it", () => {
    expect(formatUsd(3_420_000)).toBe("$3,420,000");
    expect(formatUsd(4_281_924.2)).toBe("$4,281,924");
    expect(formatUsd(120_345.5)).toBe("$120,345.50");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(4_281_924.2, { compact: true })).toBe("$4.28M");
    expect(formatUsd(120_000, { compact: true })).toBe("$120K");
    expect(formatUsd(2_500, { compact: true })).toBe("$2.5K");
    expect(formatUsd(950, { compact: true })).toBe("$950");
    expect(formatUsd(NaN)).toBe("—");
  });
});
