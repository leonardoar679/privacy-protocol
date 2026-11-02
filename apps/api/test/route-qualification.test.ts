// V7 Stage 13 (spec v3.0 §4; the owner's decision 4): the §46 quote carries the route's liquidity qualification — an order
// above the route's measured limit (the risk database's servedUpToUsd) is blocked with `route_not_qualified`; an order within
// the limit, or on an unmeasured route, is not. The wallet closes Review Swap and blocks the confirmation on this word.
import { describe, expect, it } from "vitest";
import type { QuoteSet } from "@privacy-wallet/swap-engine/engine";
import type { QuoteRequest } from "@privacy-wallet/swap-engine/types";
import { quoteOf } from "../src/quote";

const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" } as const;
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" } as const;
const NOW = 1_800_000_000_000;
const amount = 50n * 10n ** 18n;
const request = { from: ETH, to: BTC, amount, destination: "", slippageBps: 50 } as unknown as QuoteRequest;
const score = { provider: "thorchain", total: 90, components: { price: 90, security: 69, privacy: 80, latency: 80, liquidity: 90, reliability: 100 } };
const set = (usd: number): QuoteSet =>
  ({
    quotes: [
      {
        provider: "thorchain",
        category: "A",
        toAmount: 150_000_000n,
        toAmountMin: 149_000_000n,
        fees: [],
        etaSeconds: 600,
        expiresAt: Math.floor(NOW / 1000) + 600,
        obtainedAt: NOW - 1000,
        impactBps: 5,
        nativeAssets: true,
        minOutEncoded: true,
        hops: [],
        raw: {},
      },
    ],
    scores: [score],
    chosen: score,
    errors: {},
    health: { thorchain: { provider: "thorchain", reachable: true, apiLatencyMs: 1, halted: false, haltedChains: [], checkedAt: NOW } },
    links: { thorchain: { public: true, evidence: "memo" } },
    value: { usd, at: NOW },
    tier: "enhanced",
    policy: "balanced",
    competition: [],
    executorTip: 0n,
  }) as unknown as QuoteSet;
const facts = (usd: number, routeLimitUsd: number | null | undefined) => ({
  id: "qt_1",
  request,
  set: set(usd),
  terms: null,
  chainId: 1,
  now: NOW,
  recentFailures: () => 0,
  healthy: () => true,
  ...(routeLimitUsd !== undefined ? { routeLimitUsd } : {}),
});

describe("the route's liquidity qualification in the §46 quote (spec v3.0 §4)", () => {
  it("an order above the route's measured limit is blocked with route_not_qualified; one within it, or on an unmeasured route, is not", () => {
    expect(quoteOf(facts(150_000, 100_000))!.risk).toMatchObject({ blockers: ["route_not_qualified"], level: "high", score: 100 });
    expect(quoteOf(facts(100_000, 100_000))!.risk.blockers, "at the limit: qualified").toEqual([]);
    expect(quoteOf(facts(150_000, null))!.risk.blockers, "unmeasured: nothing to refuse by").toEqual([]);
    expect(quoteOf(facts(150_000, undefined))!.risk.blockers, "no fact: nothing to refuse by").toEqual([]);
    expect(quoteOf(facts(150_000, 25_000_000))!.risk.blockers, "THORChain's measured $25M: a $150K order is qualified").toEqual([]);
  });
  it("the qualification judges what the user pays: the set is valued at the escrow's funding, the gross amount scales it (the review round of 2026-11-02)", () => {
    const f = facts(100_000, 100_000); // the funding W valued at the limit
    const gross = (amount * 3n) / 2n; // what the user pays: $150,000 — over the route's measured limit
    expect(quoteOf({ ...f, request: { ...request, grossAmount: gross } })!.risk.blockers).toEqual(["route_not_qualified"]);
    expect(quoteOf({ ...f, request: { ...request, grossAmount: amount } })!.risk.blockers, "gross = funding: as valued").toEqual([]);
  });
});
