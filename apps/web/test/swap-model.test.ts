// The Swap screen's model (spec v2.0 §3, §7.5, §13.4): the three destination checks; the quote's lines in integer cents
// from the one funding split — the privacy fee p(A), the relayer's F with the executor's tip, the provider's own fees —
// the minimum and the time (the provider's estimate plus the funding's); the countdown; the route's facts; and the
// blockers re-checked when the user confirms, each of which stops the operation before anything moves.
import { describe, expect, it } from "vitest";
import type { QuoteSet, ServiceQuote } from "@privacy-wallet/sdk/swapService";
import {
  chosenQuoteOf,
  confirmBlockers,
  destinationChecks,
  expiresInOf,
  FUNDING_SECONDS,
  fundingSeconds,
  netOfShield,
  quoteLines,
  routeDetails,
} from "../src/features/swap/model";
import { TARGETS } from "../src/features/swap/targets";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const quote: ServiceQuote = {
  provider: "thorchain",
  category: "A",
  toAmount: "17800000",
  toAmountMin: "17600000",
  fees: [{ kind: "network", amount: "1000", asset: "BTC", usd: 24.1 }],
  etaSeconds: 600,
  expiresAt: Math.floor(NOW / 1000) + 45,
  nativeAssets: true,
  minOutEncoded: true,
  hops: ["ETH.ETH", "BTC.BTC"],
};
const score = { provider: "thorchain", total: 80, components: { price: 90, security: 90, privacy: 72, latency: 60, liquidity: 80, reliability: 90 } };
const set: QuoteSet = { quotes: [quote], scores: [score], errors: {}, chosen: score, executorTip: "100000000000000" } as QuoteSet;
const ETH = { symbol: "ETH", decimals: 18, usd1e8: 3_000_00000000n };

describe("the destination's checks (doc §31)", () => {
  it("idle while empty; a valid address of the right chain passes all three; another chain's fails the network", () => {
    expect(destinationChecks({ value: "", fresh: false, ok: false, otherChain: null }, "bitcoin")).toEqual({
      valid: "idle",
      network: "idle",
      compatible: "idle",
    });
    expect(destinationChecks({ value: "bc1q…", fresh: true, ok: true, otherChain: null }, "bitcoin")).toEqual({ valid: "ok", network: "ok", compatible: "ok" });
    expect(destinationChecks({ value: "0x…", fresh: false, ok: false, otherChain: "evm" }, "bitcoin")).toEqual({
      valid: "fail",
      network: "fail",
      compatible: "fail",
    });
  });
});

describe("the quote's lines (spec v2.0 §3)", () => {
  it("cross-chain: the minimum leads, the three fees in cents from one split, the time is the provider's plus the funding's", () => {
    const facts = {
      quotes: set,
      terms: { minimum: 10n ** 15n, feePercentBps: 100 },
      units: 4n * 10n ** 18n,
      from: ETH,
      to: TARGETS.BTC,
      privacy: null,
    };
    const lines = quoteLines(facts);
    expect(lines?.kind).toBe("cross-chain");
    if (lines?.kind !== "cross-chain") return;
    expect(lines.minimum.units).toBe(17_600_000n);
    expect(lines.expected.units).toBe(17_800_000n);
    expect(lines.fees).toEqual({
      privacyUsdCents: 12_000n /* 1 % of 4 ETH at $3,000 */,
      relayerUsdCents: 330n /* 0.001 + the 0.0001 tip */,
      providerUsdCents: 2410n,
    });
    expect(lines.eta).toEqual([600 + FUNDING_SECONDS[0], 600 + FUNDING_SECONDS[1]]);
    // V6 Stage 15: once the device has proven, its own time — the proof plus a block, twice it plus two minutes
    expect(quoteLines({ ...facts, proofMs: 4_200 })!.eta).toEqual([600 + 5 + 15, 600 + 10 + 120]);
    expect(fundingSeconds(null)).toEqual(FUNDING_SECONDS);
    expect(lines.protection, "no assessment yet: medium").toBe("medium");
  });
  it("funded by the connected wallet (no relayer terms): no fee note, the tip alone on the relayer line", () => {
    const lines = quoteLines({ quotes: set, terms: null, units: 10n ** 18n, from: ETH, to: TARGETS.BTC, privacy: null });
    expect(lines?.kind === "cross-chain" ? lines.fees.privacyUsdCents : null).toBe(0n);
    expect(lines?.kind === "cross-chain" ? lines.fees.relayerUsdCents : null).toBe(30n);
  });
  it("V6 Stage 12: into the protected balance — what arrives is the delivery less the shield tip, which joins the fees in dollars", () => {
    const sameChain: ServiceQuote = { ...quote, toAmount: "2310000000000000000", toAmountMin: "2280000000000000000", fees: [] };
    const target = { id: "ETH", ref: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, network: "Ethereum", protected: true };
    const USDC = { symbol: "USDC", decimals: 6, usd1e8: 1_00000000n };
    const lines = quoteLines({
      quotes: { ...set, quotes: [sameChain], executorTip: "5000000", shieldTip: "2000000000000000" } as QuoteSet,
      terms: { minimum: 4_100_000n, feePercentBps: 100 },
      units: 8_000n * 10n ** 6n,
      from: USDC,
      to: target,
      toUsd1e8: 3_500_00000000n,
      privacy: null,
    });
    expect(lines?.kind).toBe("same-chain");
    if (lines?.kind !== "same-chain") return;
    expect(lines.expected.units).toBe(2_308_000_000_000_000_000n);
    expect(lines.minimum.units).toBe(2_278_000_000_000_000_000n);
    // 1 % privacy ($80) + the relayer's F and the 5 USDC tip + the 0.002 ETH shield tip ($7) — F is 4.10 USDC with the 1 % of what leaves
    expect(lines.feesUsdCents! > 8_000n + 500n + 700n).toBe(true);
    const without = quoteLines({
      quotes: { ...set, quotes: [sameChain], executorTip: "5000000" } as QuoteSet,
      terms: { minimum: 4_100_000n, feePercentBps: 100 },
      units: 8_000n * 10n ** 6n,
      from: USDC,
      to: target,
      toUsd1e8: 3_500_00000000n,
      privacy: null,
    });
    expect(without?.kind === "same-chain" ? lines.feesUsdCents! - without.feesUsdCents! : null, "the shield tip's $7.00").toBe(700n);
  });
  it("no price for the input asset: no dollars — the fees in that asset, never $0.00 (audit round 2, r56)", () => {
    const unpriced = { ...ETH, usd1e8: null };
    const lines = quoteLines({
      quotes: set,
      terms: { minimum: 10n ** 15n, feePercentBps: 100 },
      units: 4n * 10n ** 18n,
      from: unpriced,
      to: TARGETS.BTC,
      privacy: null,
    });
    expect(lines?.kind).toBe("cross-chain");
    if (lines?.kind !== "cross-chain") return;
    expect(lines.fees.privacyUsdCents).toBeNull();
    expect(lines.fees.relayerUsdCents).toBeNull();
    expect(lines.feeAmounts?.privacy.units, "1 % of what leaves").toBe(4n * 10n ** 16n);
    const target = { id: "ETH", ref: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, network: "Ethereum", protected: true };
    const same = quoteLines({
      quotes: { ...set, quotes: [{ ...quote, toAmount: "2310000000000000000", toAmountMin: "2280000000000000000", fees: [] }] } as QuoteSet,
      terms: null,
      units: 10n ** 9n,
      from: { symbol: "USDT", decimals: 6, usd1e8: null },
      to: target,
      privacy: null,
    });
    expect(same?.kind === "same-chain" ? same.feesUsdCents : "?").toBeNull();
    // the input priced, the output not: a shield tip of unknown value makes the total unknown, never one tip short
    const tipUnpriced = quoteLines({
      quotes: {
        ...set,
        quotes: [{ ...quote, toAmount: "2310000000000000000", toAmountMin: "2280000000000000000", fees: [] }],
        executorTip: "5000000",
        shieldTip: "2000000000000000",
      } as QuoteSet,
      terms: { minimum: 4_100_000n, feePercentBps: 100 },
      units: 8_000n * 10n ** 6n,
      from: { symbol: "USDC", decimals: 6, usd1e8: 1_00000000n },
      to: target,
      privacy: null,
    });
    expect(tipUnpriced?.kind === "same-chain" ? tipUnpriced.feesUsdCents : "?").toBeNull();
  });
  it("an output minimum as the user saw it: net of a protected delivery's shield tip, never below nothing (audit round 2, r39)", () => {
    expect(netOfShield("3100000000000000000", 5_000_000_000_000_000n)).toBe(3_095_000_000_000_000_000n);
    expect(netOfShield(3n, 0n)).toBe(3n);
    expect(netOfShield(3n, 5n)).toBe(0n);
  });
  it("no chosen route, no lines; the countdown from the quote's expiry; the route's facts under Advanced", () => {
    expect(quoteLines({ quotes: { ...set, chosen: undefined }, terms: null, units: 1n, from: ETH, to: TARGETS.BTC, privacy: null })).toBeNull();
    expect(chosenQuoteOf(set)).toBe(quote);
    expect(expiresInOf(set, NOW)).toBe(45);
    expect(expiresInOf(set, NOW + 50_000)).toBe(-5);
    expect(routeDetails(set, TARGETS.BTC, null, "Low")).toMatchObject({
      provider: "thorchain",
      route: "ETH.ETH → BTC.BTC",
      fee: "$24.10",
      risk: "Low",
      privacy: "72 / 100",
    });
  });
});

describe("the blockers at the confirmation (spec v2.0 §13.4)", () => {
  const base = {
    now: NOW,
    quotedAt: NOW - 5_000,
    quote,
    approvedMin: 17_600_000n,
    destinationValid: true,
    providerHealthy: true,
    chainId: 1,
    crossChain: true,
    largeTrade: false,
  };
  it("none for a fresh, honest quote", () => {
    expect(confirmBlockers(base)).toEqual([]);
  });
  it("each fact that fails stops it: the quote expired, a minimum below the approved one, an invalid destination, an unhealthy provider", () => {
    expect(confirmBlockers({ ...base, now: NOW + 46_000 })).toEqual(["quote_expired"]);
    expect(confirmBlockers({ ...base, approvedMin: 17_700_000n })).toEqual(["minimum_below_limit"]);
    expect(confirmBlockers({ ...base, destinationValid: false })).toEqual(["destination_invalid"]);
    expect(confirmBlockers({ ...base, providerHealthy: false })).toEqual(["provider_unhealthy"]);
  });
});
