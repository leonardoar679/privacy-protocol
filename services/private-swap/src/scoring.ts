// Route scoring (spec §9; whale spec §4): six components, policy-weighted; the best price never wins by itself.
import type { Health, Policy, Preference, ProviderId, Quote, Tier } from "./types";
import { atLeast } from "../../../reference/typescript/src/wallet/valuation";
import { BASELINE_PRIVACY, chainHalted, reliabilityScore, securityScore } from "./health";

export interface RouteScore {
  provider: ProviderId;
  components: { price: number; security: number; privacy: number; latency: number; liquidity: number; reliability: number };
  total: number;
  filtered?: string; // reason the route was excluded before scoring
}

export const WEIGHTS: Record<Policy, RouteScore["components"]> = {
  "best-privacy": { privacy: 0.45, security: 0.25, reliability: 0.15, price: 0.10, latency: 0.05, liquidity: 0 },
  "best-price": { price: 0.45, security: 0.20, reliability: 0.15, privacy: 0.10, latency: 0.05, liquidity: 0.05 },
  fastest: { latency: 0.40, reliability: 0.25, security: 0.15, price: 0.10, privacy: 0.10, liquidity: 0 },
  balanced: { privacy: 0.25, price: 0.25, security: 0.20, reliability: 0.15, latency: 0.10, liquidity: 0.05 },
  "privacy-execution": { privacy: 0.30, security: 0.25, reliability: 0.20, price: 0.15, liquidity: 0.10, latency: 0 },
};

/** whale spec §4 (calibrated 2026-10-07): a plan whose own impact figure exceeds this is not chosen at the high-value tiers when another route quoted the size. */
export const IMPACT_CAP_BPS = 50;
/** whale spec §12 (calibrated 2026-10-07): a streamed plan longer than this is not chosen automatically when a faster route quoted; alone, it is offered with its duration stated. */
export const STREAM_MAX_SECONDS = 14_400;

/** The policy a preference and a tier give (whale spec §4): `native` is balanced plus a filter; from the high-value tier everything but best-privacy becomes privacy-execution. */
export function policyFor(preference: Preference, tier: Tier): Policy {
  const base: Policy = preference === "native" ? "balanced" : preference;
  return atLeast(tier, "high-value") && base !== "best-privacy" ? "privacy-execution" : base;
}

export interface ScoringContext {
  /** the order's value tier (the impact cap applies from high-value) */
  tier?: Tier;
  /** the net amount quoted (provider limits are checked against it) */
  amount?: bigint;
  /** the order's chains (a provider halted on one of them is filtered) */
  chains?: string[];
  /** providers skipped by the circuit breaker (whale spec §16) */
  skipped?: Partial<Record<ProviderId, string>>;
  /** providers filtered by the request itself (the native-assets preference) */
  filteredBy?: Partial<Record<ProviderId, string>>;
}

const bps = (q: Quote) => q.impactBps ?? 0;
const live = (q: Quote, now: number) => q.expiresAt * 1000 > now;

export function scoreRoutes(quotes: Quote[], health: Record<ProviderId, Health>, policy: Policy, now = Date.now(), unexecutable: Partial<Record<ProviderId, string>> = {}, ctx: ScoringContext = {}): RouteScore[] {
  const liveQuotes = quotes.filter((q) => live(q, now));
  const bestMin = liveQuotes.reduce((m, q) => (q.toAmountMin > m ? q.toAmountMin : m), 0n);
  const strict = policy !== "fastest";
  return quotes.map((q) => {
    const h = health[q.provider];
    const haltedOn = h && ctx.chains ? chainHalted(h, ctx.chains) : null;
    const others = liveQuotes.filter((o) => o.provider !== q.provider && !unexecutable[o.provider] && !ctx.skipped?.[o.provider] && !ctx.filteredBy?.[o.provider]);
    const impactCap = ctx.tier && atLeast(ctx.tier, "high-value") && bps(q) > IMPACT_CAP_BPS && others.some((o) => bps(o) <= IMPACT_CAP_BPS);
    const longStream = !!q.plan && q.plan.mode !== "single" && q.plan.expectedSeconds > STREAM_MAX_SECONDS && others.some((o) => !(o.plan && o.plan.mode !== "single" && o.plan.expectedSeconds > STREAM_MAX_SECONDS));
    const filtered =
      !live(q, now) ? "quote expired"
      : h && !h.reachable ? "provider unreachable"
      : h && h.halted ? "provider halted"
      : haltedOn ? `provider halted on ${haltedOn}`
      : ctx.skipped?.[q.provider] ? ctx.skipped[q.provider]
      : !q.minOutEncoded && strict ? "no minimum-output protection"
      : unexecutable[q.provider] ? unexecutable[q.provider]
      : q.minOutVerified === false && strict ? "minimum output not locally verifiable"
      : ctx.filteredBy?.[q.provider] ? ctx.filteredBy[q.provider]
      : ctx.amount !== undefined && q.limits?.max !== undefined && ctx.amount > q.limits.max ? `above the provider's limit (${q.limits.max} base units)`
      : ctx.amount !== undefined && q.limits?.min !== undefined && ctx.amount < q.limits.min ? `below the provider's minimum (${q.limits.min} base units)`
      : impactCap ? `price impact ${bps(q)} bps above the ${IMPACT_CAP_BPS} bps cap (another route quoted the size)`
      : longStream ? `a ${Math.round(q.plan!.expectedSeconds / 3600)}-hour stream when a faster route quoted`
      : undefined;
    // price: 100 at the best guaranteed output, −10 points per 1 % below it (a 10 % worse min-out scores 0)
    const gapPct = bestMin === 0n ? 100 : Number(((bestMin - q.toAmountMin) * 100000n) / bestMin) / 1000;
    const price = Math.max(0, 100 - 10 * gapPct);
    // latency: absolute, log scale — providers report ETAs differently (THORNode's excludes outbound
    // confirmations, Chainflip's includes deposit + egress), so a ratio to the best would over-reward
    // the optimistic reporter. ≤ 2 min → 100, 4 min → 75, 8 min → 50, 16 min → 25, ≥ 32 min → 0.
    const latency = q.etaSeconds <= 0 ? 0 : Math.round(Math.max(0, 100 - 25 * Math.log2(Math.max(1, q.etaSeconds / 120))));
    // liquidity: the provider's own impact figure where it states one (whale spec §4), else the liquidity fee, else a default
    const slippage = q.fees.find((f) => f.kind === "liquidity");
    const liquidity = q.impactBps !== undefined ? Math.max(0, 100 - q.impactBps / 10) : slippage ? Math.max(0, 100 - Number((slippage.amount * 10000n) / (q.toAmount || 1n)) / 10) : 80;
    const components = {
      price: Math.round(price),
      security: securityScore(q.provider, now),
      privacy: BASELINE_PRIVACY[q.provider] - (q.nativeAssets ? 0 : 8),
      latency,
      liquidity: Math.round(liquidity),
      reliability: h ? reliabilityScore(h, ctx.chains ?? []) : 70,
    };
    const w = WEIGHTS[policy];
    const total = Math.round((Object.keys(w) as (keyof typeof w)[]).reduce((s, k) => s + w[k] * components[k], 0) * 100) / 100;
    return { provider: q.provider, components, total: filtered ? 0 : total, filtered };
  });
}

export function chooseRoute(scores: RouteScore[]): RouteScore | undefined {
  return scores.filter((s) => !s.filtered).sort((a, b) => b.total - a.total)[0];
}

/**
 * Changed-quote guard (plan §71 "changed quote", §74 "API malicious"): a provider that re-quotes far
 * below the best live alternative at signing time is refused, whatever its earlier quote said.
 */
export function priceGuard(q: Quote, alternatives: Quote[], maxGapBps: number, now = Date.now()): void {
  const live = alternatives.filter((a) => a.provider !== q.provider && a.expiresAt * 1000 > now);
  if (!live.length) return;
  const best = live.reduce((m, a) => (a.toAmountMin > m.toAmountMin ? a : m));
  if (q.toAmountMin * 10000n < best.toAmountMin * BigInt(10000 - maxGapBps)) {
    const gapBps = Number(((best.toAmountMin - q.toAmountMin) * 10000n) / best.toAmountMin);
    throw new Error(`re-quote from ${q.provider} is ${gapBps} bps below the best alternative (${best.provider}); refusing to sign`);
  }
}

/** The price guard's tolerance by tier (whale spec §14): 100 bps, 50 from high-value. */
export const maxGapBpsFor = (tier?: Tier): number => (tier && atLeast(tier, "high-value") ? 50 : 100);
