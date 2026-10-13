// Protected execution's checks at the `large-protected` band and above (spec §3.8, §11; sdk/tiers PROTECTED_EXECUTION):
// the strict quote — the hard quote keeps at least MIN_QUOTE_TTL_S, the request's slippage is capped at
// MAX_SLIPPAGE_BPS, the approved minimum is at least toAmount·(1 − 50 bps) —, the provider's health — breaker closed,
// security ≥ 60, no incident within a day —, else the next route is quoted. Pure; the service's risk view is advice.
import { PROTECTED_EXECUTION } from "../../sdk/tiers";
import type { QuoteSet, RiskView, ServiceQuote } from "../../sdk/swapService";

export type CheckVerdict = { ok: true } | { ok: false; code: "quote_ttl_short" | "provider_unhealthy" | "slippage_too_wide"; detail: string };

/** The slippage a request at the band may carry. */
export const cappedSlippageBps = (requested: number): number => Math.min(requested, PROTECTED_EXECUTION.MAX_SLIPPAGE_BPS);

/** The hard quote must have at least MIN_QUOTE_TTL_S left when it is prepared. */
export function strictQuote(quote: Pick<ServiceQuote, "expiresAt" | "toAmount" | "toAmountMin">, nowSeconds = Math.floor(Date.now() / 1000)): CheckVerdict {
  const left = quote.expiresAt - nowSeconds;
  if (left < PROTECTED_EXECUTION.MIN_QUOTE_TTL_S) return { ok: false, code: "quote_ttl_short", detail: `${Math.max(0, left)} s left of the ${PROTECTED_EXECUTION.MIN_QUOTE_TTL_S} s a protected execution needs` };
  const toAmount = BigInt(quote.toAmount), minimum = BigInt(quote.toAmountMin);
  if (toAmount > 0n && minimum < (toAmount * BigInt(10000 - PROTECTED_EXECUTION.MAX_SLIPPAGE_BPS)) / 10000n) return { ok: false, code: "slippage_too_wide", detail: `the minimum is more than ${PROTECTED_EXECUTION.MAX_SLIPPAGE_BPS / 100} % under the expected output` };
  return { ok: true };
}

/** The provider's health from the service's risk view: the breaker closed, security ≥ 60, no incident within 24 h. */
export interface HealthView { security: { total: number }; incidents?: { date: string }[]; breaker?: RiskView["breaker"] | null }
export function providerHealthy(risk: HealthView | undefined, now = Date.now()): CheckVerdict {
  if (!risk) return { ok: true }; // no view: nothing speaks against the route; the Review's security line judges it
  if (risk.breaker?.open) return { ok: false, code: "provider_unhealthy", detail: `the provider's circuit breaker is open (${risk.breaker.open})` };
  if (risk.security.total < 60) return { ok: false, code: "provider_unhealthy", detail: `security ${risk.security.total}/100 is below 60` };
  const recent = (risk.incidents ?? []).some((i) => now - Date.parse(i.date) < 86_400_000 && now - Date.parse(i.date) >= 0);
  if (recent) return { ok: false, code: "provider_unhealthy", detail: "a security incident within the last day" };
  return { ok: true };
}

/** The providers of a quote set that pass the health check, best first (the set's scores order). */
export function healthyProviders(set: Pick<QuoteSet, "scores" | "risk">, now = Date.now()): string[] {
  return set.scores.filter((s) => !s.filtered).map((s) => s.provider).filter((p) => providerHealthy(set.risk?.[p], now).ok);
}
