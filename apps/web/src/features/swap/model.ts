// The Swap screen's model (spec v2.0 §3, §7.5, §13.4, §14.1; doc §26, §29–§33): the destination of a cross-chain swap and
// its three checks, the quote's lines in dollars from the one funding split (the privacy fee p(A), the relayer's F plus
// the executor's tip, the provider's own fees; V6 Stage 12: a same-chain swap's shield tip, in the output asset — what
// reaches the protected balance is the delivery less it), the minimum, the time (the provider's estimate plus the funding's),
// the protection from the privacy assessment, the countdown to the quote's expiry, the route's facts under Advanced,
// and the blockers re-checked when the user confirms (packages/risk-engine assessRisk). Pure: the screen gathers the
// facts.
import { swapFunding, type FeeTerms } from "@privacy-wallet/protocol/wallet/fees";
import type { SwapPrivacy } from "@privacy-wallet/protocol/wallet/privacyAssessment";
import { assessRisk, type BlockerCode } from "@privacy-wallet/risk-engine";
import type { CheckState } from "@privacy-wallet/ui";
import { feeSummary, type QuoteSet, type ServiceQuote } from "@privacy-wallet/sdk/swapService";
import { amountOf, centsOf } from "../amounts";
import { hours, type Target } from "./targets";
import type { Level, SwapModel } from "./View";

/** What the funding adds to the provider's time: the proof and the withdrawal's confirmation (until Stage 15 measures this device). */
export const FUNDING_SECONDS: [number, number] = [30, 150];

export interface SwapDestinationFacts {
  value: string;
  /** the fresh address of this wallet (not typed) */
  fresh: boolean;
  /** the address parses for the target's chain */
  ok: boolean;
  reason?: string;
  /** another chain's address was typed (by its format) */
  otherChain: string | null;
}

/** The three checks under a cross-chain destination (doc §31). */
export function destinationChecks(d: SwapDestinationFacts, targetKind: string): NonNullable<SwapModel["destination"]>["checks"] {
  if (!d.value.trim()) return { valid: "idle", network: "idle", compatible: "idle" };
  const network: CheckState = d.otherChain && d.otherChain !== targetKind ? "fail" : "ok";
  const valid: CheckState = d.ok ? "ok" : "fail";
  return { valid, network, compatible: valid === "ok" && network === "ok" ? "ok" : "fail" };
}

export interface QuoteFacts {
  quotes: QuoteSet;
  /** the relayer's terms the funding split used (null: the connected wallet funds — no fee note) */
  terms: FeeTerms | null;
  units: bigint;
  from: { symbol: string; decimals: number; usd1e8: bigint | null };
  to: Target;
  /** the output asset's price (a same-chain swap's shield tip is in it) */
  toUsd1e8?: bigint | null;
  privacy: SwapPrivacy | null;
}

/** V6 Stage 12: a protected destination's shield tip, in the output's base units (0 elsewhere). */
export const shieldTipOf = (q: QuoteSet | null): bigint => BigInt(q?.shieldTip ?? "0");

/** The chosen route's quote, or null. */
export const chosenQuoteOf = (q: QuoteSet | null): ServiceQuote | null =>
  q?.chosen ? (q.quotes.find((x) => x.provider === q.chosen!.provider) ?? null) : null;

/** The quote's lines (spec v2.0 §3): what arrives and the three fees in cents — never a float, always the one split. */
export function quoteLines(f: QuoteFacts): SwapModel["quote"] {
  const quote = chosenQuoteOf(f.quotes);
  if (!quote) return null;
  const split = f.terms ? swapFunding(f.units, f.terms) : { privacy: 0n, network: 0n, delivered: f.units };
  const tip = BigInt(f.quotes.executorTip ?? "0");
  const cents = (u: bigint) => (f.from.usd1e8 !== null ? centsOf(u, f.from.decimals, f.from.usd1e8) : 0n);
  const providerUsd = (quote.fees ?? []).reduce((s, x) => s + (typeof x.usd === "number" ? x.usd : 0), 0);
  const providerCents = BigInt(Math.round(providerUsd * 100));
  const level: Level = f.privacy?.level ?? "medium";
  const eta: [number, number] = [quote.etaSeconds + FUNDING_SECONDS[0], quote.etaSeconds + FUNDING_SECONDS[1]];
  const shield = f.to.protected ? shieldTipOf(f.quotes) : 0n;
  const expected = amountOf(BigInt(quote.toAmount) - shield, f.to.ref.symbol, f.to.ref.decimals, f.to.ref.chain);
  const minimum = amountOf(BigInt(quote.toAmountMin) - shield, f.to.ref.symbol, f.to.ref.decimals, f.to.ref.chain);
  if (f.to.ref.chain === "ethereum") {
    const shieldCents = shield > 0n && f.toUsd1e8 ? centsOf(shield, f.to.ref.decimals, f.toUsd1e8) : 0n;
    return {
      kind: "same-chain",
      expected,
      minimum,
      protection: level,
      feesUsdCents: cents(split.privacy) + cents(split.network + tip) + shieldCents + providerCents,
      eta,
    };
  }
  return {
    kind: "cross-chain",
    expected,
    minimum,
    protection: level,
    fees: { privacyUsdCents: cents(split.privacy), relayerUsdCents: cents(split.network + tip), providerUsdCents: providerCents },
    eta,
  };
}

/** Seconds until the chosen quote expires (its `expiresAt` is unix seconds). */
export const expiresInOf = (q: QuoteSet | null, nowMs: number): number | null => {
  const quote = chosenQuoteOf(q);
  return quote ? Math.floor(quote.expiresAt - nowMs / 1000) : null;
};

/** Advanced (doc §29): the route's facts in words. */
export function routeDetails(q: QuoteSet, to: Target, privacy: SwapPrivacy | null, riskWords: string): SwapModel["details"] {
  const quote = chosenQuoteOf(q);
  if (!quote || !q.chosen) return null;
  return {
    provider: q.chosen.provider,
    route: quote.hops.length ? quote.hops.join(" → ") : quote.category,
    expected: amountOf(BigInt(quote.toAmount), to.ref.symbol, to.ref.decimals, to.ref.chain),
    fee: feeSummary(quote),
    time: `~${hours(quote.etaSeconds)}`,
    risk: riskWords,
    privacy: privacy ? `${privacy.score} / 100` : `${q.chosen.components.privacy} / 100`,
  };
}

export interface ConfirmFacts {
  now: number;
  quotedAt: number;
  quote: ServiceQuote;
  /** the minimum the user approved on the Review: the shown quote's */
  approvedMin: bigint;
  destinationValid: boolean;
  providerHealthy: boolean;
  chainId: number;
  crossChain: boolean;
  usd?: number;
  largeTrade: boolean;
}

/** The blockers re-checked when the user confirms (spec v2.0 §13.4): one stops the operation before anything moves. */
export function confirmBlockers(f: ConfirmFacts): BlockerCode[] {
  return assessRisk({
    now: f.now,
    quote: {
      fetchedAt: f.quotedAt,
      expiresAt: f.quote.expiresAt * 1000,
      minimumOut: BigInt(f.quote.toAmountMin),
      approvedMinimum: f.approvedMin,
      impactBps: f.quote.impactBps ?? 0,
      slippageBps: 50,
      parametersMatch: true,
    },
    asset: { status: "supported" },
    destination: { valid: f.destinationValid },
    provider: { healthy: f.providerHealthy, recentFailures: 0 },
    network: { expectedChainId: f.chainId, chainId: f.chainId },
    execution: { steps: 1, crossChain: f.crossChain },
    ...(f.usd !== undefined ? { usd: f.usd } : {}),
    largeTrade: f.largeTrade,
  }).blockers;
}
