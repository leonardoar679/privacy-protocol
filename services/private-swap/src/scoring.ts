// Route scoring (spec §9): six components, policy-weighted; the best price never wins by itself.
import type { Health, Policy, ProviderId, Quote } from "./types";
import { BASELINE_PRIVACY, reliabilityScore, securityScore } from "./health";

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
};

export function scoreRoutes(quotes: Quote[], health: Record<ProviderId, Health>, policy: Policy, now = Date.now(), unexecutable: Partial<Record<ProviderId, string>> = {}): RouteScore[] {
  const live = quotes.filter((q) => q.expiresAt * 1000 > now);
  const bestMin = live.reduce((m, q) => (q.toAmountMin > m ? q.toAmountMin : m), 0n);
  return quotes.map((q) => {
    const h = health[q.provider];
    const filtered =
      q.expiresAt * 1000 <= now ? "quote expired"
      : h && !h.reachable ? "provider unreachable"
      : h && h.halted ? "provider halted"
      : !q.minOutEncoded && policy !== "fastest" ? "no minimum-output protection"
      : unexecutable[q.provider] ? unexecutable[q.provider]
      : q.minOutVerified === false && policy !== "fastest" ? "minimum output not locally verifiable"
      : undefined;
    // price: 100 at the best guaranteed output, −10 points per 1 % below it (a 10 % worse min-out scores 0)
    const gapPct = bestMin === 0n ? 100 : Number(((bestMin - q.toAmountMin) * 100000n) / bestMin) / 1000;
    const price = Math.max(0, 100 - 10 * gapPct);
    // latency: absolute, log scale — providers report ETAs differently (THORNode's excludes outbound
    // confirmations, Chainflip's includes deposit + egress), so a ratio to the best would over-reward
    // the optimistic reporter. ≤ 2 min → 100, 4 min → 75, 8 min → 50, 16 min → 25, ≥ 32 min → 0.
    const latency = q.etaSeconds <= 0 ? 0 : Math.round(Math.max(0, 100 - 25 * Math.log2(Math.max(1, q.etaSeconds / 120))));
    const slippage = q.fees.find((f) => f.kind === "liquidity");
    const liquidity = slippage ? Math.max(0, 100 - Number((slippage.amount * 10000n) / (q.toAmount || 1n)) / 10) : 80;
    const components = {
      price: Math.round(price),
      security: securityScore(q.provider, now),
      privacy: BASELINE_PRIVACY[q.provider] - (q.nativeAssets ? 0 : 8),
      latency,
      liquidity: Math.round(liquidity),
      reliability: h ? reliabilityScore(h) : 70,
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
