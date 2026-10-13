// Quote normalization (contract docs/high-value-execution-contract-v1.0.md §3.2, §7; plan §42): every provider's quote in
// one shape, so routes compare like with like — the guaranteed and expected outputs, the provider's and the network's
// fees in USD when the adapter states them (null, never a guess), the source-side gas when stated, the duration, the
// route's risk (class, flags, the exposure tier of contract §2.2, the security and reliability components) and its
// privacy (the provider path's score and whether the escrow → destination link is public). Attached to the competition
// record of every quoted provider by the engine; stateless.
import type { Health, ProviderId, Quote, QuoteRequest } from "./types";
import type { RouteScore } from "./scoring";
import { IMPACT_CAP_BPS } from "./scoring";
import { chainHalted } from "./health";
import { daysSinceIncident } from "./risk/security";
import { riskDb, type RiskDb } from "./risk/riskDb";
import { riskModelOf } from "@privacy-wallet/protocol/wallet/riskClasses";
import { exposureTierOf, type ExposureTier } from "@privacy-wallet/protocol/wallet/exposurePolicy";
import type { RiskClass } from "@privacy-wallet/protocol/wallet/campaign";

export interface NormalizedQuote {
  provider: ProviderId;
  /** toAmountMin: what the destination is guaranteed, base units of `to` */
  netAmountOut: string;
  /** toAmount: the expected output before the provider's own deductions, base units of `to` */
  grossAmountOut: string;
  /** protocol + affiliate + liquidity fees in USD when every such fee is valued; null otherwise */
  providerFee: string | null;
  /** network + gas fees in USD when every such fee is valued; null otherwise */
  networkFee: string | null;
  /** the source-side gas of the provider call in units, when the adapter states it; null otherwise (no adapter does today) */
  estimatedGas: string | null;
  /** seconds: the plan's expected time, else the quote's ETA */
  estimatedDuration: number;
  routeRisk: { class: RiskClass; flags: RiskClass[]; exposureTier: ExposureTier; security: number; reliability: number };
  privacyRisk: { score: number; linkPublic: boolean };
}

export interface NormalizeContext {
  req: Pick<QuoteRequest, "from" | "to">;
  score: RouteScore;
  health?: Health;
  /** the breaker skipped this provider in the competition */
  breakerOpen?: boolean;
  linkPublic: boolean;
  db?: RiskDb;
  now?: number;
}

const usdOf = (q: Quote, kinds: string[]): string | null => {
  const fees = q.fees.filter((f) => kinds.includes(f.kind));
  if (!fees.length) return "0";
  if (fees.some((f) => f.usd === undefined || !Number.isFinite(f.usd))) return null;
  return (Math.round(fees.reduce((s, f) => s + (f.usd ?? 0), 0) * 100) / 100).toString();
};

export function normalizeQuote(q: Quote, ctx: NormalizeContext): NormalizedQuote {
  const db = ctx.db ?? riskDb();
  const now = ctx.now ?? Date.now();
  const pair = `${ctx.req.from.symbol}>${ctx.req.to.symbol}`;
  const model = riskModelOf(q.provider, { plan: q.plan, sourceSwap: q.hops.length > 1 }, ctx.req.from, ctx.req.to, "balanced", db.override(q.provider, pair));
  const tier = exposureTierOf(model, {
    planMode: q.plan?.mode,
    thinMarket: (q.impactBps ?? 0) > IMPACT_CAP_BPS,
    knownProvider: db.providerRisk(q.provider) !== null,
    chainHalted: ctx.health ? chainHalted(ctx.health, [ctx.req.from.chain, ctx.req.to.chain]) !== null || ctx.health.halted : false,
    incidentWithinDays: daysSinceIncident(q.provider, now, db),
    breakerOpen: !!ctx.breakerOpen,
    security: ctx.score.components.security,
  });
  const raw = q.raw as { estimatedGas?: unknown } | null;
  const gas = raw && typeof raw === "object" && (typeof raw.estimatedGas === "number" || typeof raw.estimatedGas === "string") && /^\d+$/.test(String(raw.estimatedGas)) ? String(raw.estimatedGas) : null;
  return {
    provider: q.provider,
    netAmountOut: q.toAmountMin.toString(),
    grossAmountOut: q.toAmount.toString(),
    providerFee: usdOf(q, ["protocol", "affiliate", "liquidity"]),
    networkFee: usdOf(q, ["network", "gas"]),
    estimatedGas: gas,
    estimatedDuration: q.plan?.expectedSeconds ?? q.etaSeconds,
    routeRisk: { class: model.class, flags: model.flags, exposureTier: tier.tier, security: ctx.score.components.security, reliability: ctx.score.components.reliability },
    privacyRisk: { score: ctx.score.components.privacy, linkPublic: ctx.linkPublic },
  };
}
