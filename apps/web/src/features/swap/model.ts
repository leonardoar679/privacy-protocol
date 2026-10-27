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
import { whyLines } from "../privacy-center/model";
import type { Level, SwapModel } from "./View";

/** What the funding adds to the provider's time before this device has proven once: the proof and the withdrawal's confirmation. */
export const FUNDING_SECONDS: [number, number] = [30, 150];

/**
 * V6 Stage 15 (spec v2.0 §14.3): the funding's time from this device's own last proof — the proof plus one block at
 * best, twice the proof plus two minutes of confirmation at worst; the constant range until the device has proven.
 */
export function fundingSeconds(proofMs: number | null | undefined): [number, number] {
  if (proofMs === null || proofMs === undefined || !Number.isFinite(proofMs) || proofMs <= 0) return FUNDING_SECONDS;
  const s = Math.ceil(proofMs / 1000);
  return [s + 15, 2 * s + 120];
}

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
  /** V6 Stage 15: this device's last proof (ms), when it has proven once */
  proofMs?: number | null;
}

/** V6 Stage 12: a protected destination's shield tip, in the output's base units (0 elsewhere). */
export const shieldTipOf = (q: QuoteSet | null): bigint => BigInt(q?.shieldTip ?? "0");
/**
 * An output minimum as the user sees it (audit round 2, r39): a delivery into the protected balance pays its shield tip out
 * of what arrives, so the Review showed the minimum net of it, while the journaled minimum — the one the call is checked
 * against — is gross: "minimum moved" and the commit's price line said figures one tip above what the user approved.
 */
export const netOfShield = (gross: string | bigint, shieldTip: bigint): bigint => {
  const g = BigInt(gross);
  return g > shieldTip ? g - shieldTip : 0n;
};

/**
 * V6 Stage 13 (spec v2.0 §3, §13.5): a protected execution's amount — what its `n` steps' withdrawals deliver once each pays
 * its own fee note (p + F a step), less four base units a step for the exact-output rounding of each step's funding, in
 * whole steps: the steps together spend at most what the user typed. Without relayer terms (the connected wallet funds)
 * there is no fee note. Each step's F is priced when the step is funded, hours later: the steps keep a tenth more for it
 * (STEP_FEE_ROOM_BPS; audit round 2, r11 — sized at the Review's F alone, any rise left the last step of a whole balance
 * unfundable).
 */
export function protectedStepsAmount(units: bigint, reviewed: FeeTerms | null, n: number): bigint {
  const k = BigInt(Math.max(1, Math.floor(n)));
  if (!reviewed) return units - (units % k);
  const terms = { ...reviewed, minimum: (reviewed.minimum * (10_000n + STEP_FEE_ROOM_BPS)) / 10_000n };
  const q = units / k;
  let total = 0n;
  for (let i = 0n; i < k; i++) {
    const s = swapFunding(i === k - 1n ? units - q * (k - 1n) : q, terms);
    if (s.tooSmall) return 0n;
    total += s.delivered;
  }
  total -= 4n * k;
  return total > 0n ? total - (total % k) : 0n;
}

/** The room each protected step keeps for its fee note's F rising between the Review and its funding (basis points of F). */
export const STEP_FEE_ROOM_BPS = 1_000n;

/**
 * The steps' amount at the count of steps it makes itself (the audit round of 2026-10-16, c50): a lower amount can make more
 * steps — a band just under a bucket's size halves the bucket — and each step pays its own fee note, so the count is read
 * again for the amount until it no longer grows (at most a few rounds; `countFor` gives the most steps an amount can make).
 */
export function stepsAmountAtFixedPoint(units: bigint, terms: FeeTerms | null, countFor: (amount: bigint) => number): { n: number; amount: bigint } {
  let n = Math.max(1, countFor(units));
  let amount = protectedStepsAmount(units, terms, n);
  for (let i = 0; i < 4 && amount > 0n; i++) {
    const m = countFor(amount);
    if (m <= n) break;
    n = m;
    amount = protectedStepsAmount(units, terms, n);
  }
  return { n, amount };
}

/** The chosen route's quote, or null. */
export const chosenQuoteOf = (q: QuoteSet | null): ServiceQuote | null =>
  q?.chosen ? (q.quotes.find((x) => x.provider === q.chosen!.provider) ?? null) : null;

/**
 * The provider's fees in cents (the policy's rule 1, V7 Stage 12): a fee in the source asset from its price in integer math;
 * one in another asset from the provider's own dollar figure, the one number here that is not ours (rounded to cents).
 */
export function providerFeeCents(
  fees: readonly { asset: string; decimals?: number; amount?: string; usd?: number }[] | undefined,
  symbol: string,
  decimals: number,
  usd1e8: bigint | null,
): bigint {
  let cents = 0n;
  for (const x of fees ?? []) {
    if (x.asset === symbol && x.decimals === decimals && usd1e8 !== null && typeof x.amount === "string" && /^\d+$/.test(x.amount))
      cents += centsOf(BigInt(x.amount), decimals, usd1e8);
    else if (typeof x.usd === "number" && Number.isFinite(x.usd)) cents += BigInt(Math.round(x.usd * 100));
  }
  return cents;
}

/** The quote's lines (spec v2.0 §3): what arrives and the three fees in cents — never a float, always the one split. */
export function quoteLines(f: QuoteFacts): SwapModel["quote"] {
  const quote = chosenQuoteOf(f.quotes);
  if (!quote) return null;
  const split = f.terms ? swapFunding(f.units, f.terms) : { privacy: 0n, network: 0n, delivered: f.units };
  const tip = BigInt(f.quotes.executorTip ?? "0");
  // no price, no dollars (audit round 2, r56): the card had read "Privacy fee $0.00 · Relayer/network $0.00" while 1 %, F and
  // the tip were paid; it says them in the input asset instead, as the Review does
  const cents = (u: bigint) => (f.from.usd1e8 !== null ? centsOf(u, f.from.decimals, f.from.usd1e8) : null);
  const inAsset = (u: bigint) => amountOf(u, f.from.symbol, f.from.decimals);
  const providerCents = providerFeeCents(quote.fees, f.from.symbol, f.from.decimals, f.from.usd1e8);
  const level: Level = f.privacy?.level ?? "medium";
  const funding = fundingSeconds(f.proofMs);
  const eta: [number, number] = [quote.etaSeconds + funding[0], quote.etaSeconds + funding[1]];
  const shield = f.to.protected ? shieldTipOf(f.quotes) : 0n;
  const expected = amountOf(BigInt(quote.toAmount) - shield, f.to.ref.symbol, f.to.ref.decimals, f.to.ref.chain);
  const minimum = amountOf(BigInt(quote.toAmountMin) - shield, f.to.ref.symbol, f.to.ref.decimals, f.to.ref.chain);
  if (f.to.ref.chain === "ethereum") {
    // a shield tip of unknown value makes the total unknown too, never one tip short (r56)
    const shieldCents = shield > 0n ? (f.toUsd1e8 ? centsOf(shield, f.to.ref.decimals, f.toUsd1e8) : null) : 0n;
    return {
      kind: "same-chain",
      expected,
      minimum,
      protection: level,
      ...(f.privacy ? { why: whyLines(f.privacy.reasons) } : {}),
      feesUsdCents: f.from.usd1e8 !== null && shieldCents !== null ? cents(split.privacy)! + cents(split.network + tip)! + shieldCents + providerCents : null,
      eta,
    };
  }
  return {
    kind: "cross-chain",
    expected,
    minimum,
    protection: level,
    ...(f.privacy ? { why: whyLines(f.privacy.reasons) } : {}),
    fees: { privacyUsdCents: cents(split.privacy), relayerUsdCents: cents(split.network + tip), providerUsdCents: providerCents },
    feeAmounts: { privacy: inAsset(split.privacy), relayer: inAsset(split.network + tip) },
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
  /** V6 Stage 13 (spec v2.0 §2, §13.5): from the Medium band the strict quote — at least a minute left at the confirmation */
  strictQuote?: boolean;
}

/** The time a strict quote must still have at the confirmation (sdk/tiers PROTECTED_EXECUTION.MIN_QUOTE_TTL_S). */
export const STRICT_QUOTE_TTL_SECONDS = 60;

/** The blockers re-checked when the user confirms (spec v2.0 §13.4): one stops the operation before anything moves. */
export function confirmBlockers(f: ConfirmFacts): BlockerCode[] {
  // a strict quote with less than a minute left is as good as expired: the hard quote at the signature could not keep it
  if (f.strictQuote && f.quote.expiresAt - Math.floor(f.now / 1000) < STRICT_QUOTE_TTL_SECONDS) return ["quote_expired"];
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
