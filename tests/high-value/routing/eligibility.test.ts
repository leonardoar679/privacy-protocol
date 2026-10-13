// Route eligibility, the circuit breaker and concentration (plan §44–§47; contract §7): a provider is eligible only when
// healthy, with a fresh quote, within its limits and under the impact cap; three failures open the breaker; when two or
// more venues quote the size no provider carries more than 30 % of the order; a single venue is disclosed, never
// diversified for appearance. Pins I-S 7 (no single mandatory provider).
import { describe, it, expect } from "vitest";
import { IMPACT_CAP_BPS, chooseRoute, scoreRoutes } from "../../../packages/swap-engine/src/scoring";
import { ProviderHealthTracker } from "../../../packages/swap-engine/src/health";
import { PROVIDER_SHARE_CAP_BPS, recommendProtection } from "../../../packages/swap-engine/src/risk/protection";
import { RiskDb, RISK_DB_DIR } from "../../../packages/swap-engine/src/risk/riskDb";
import type { QuoteSet } from "../../../packages/swap-engine/src/engine";
import type { Health, ProviderId, Quote, QuoteRequest } from "../../../packages/swap-engine/src/types";
import type { RouteScore } from "../../../packages/swap-engine/src/scoring";
import { providerLimit } from "../../../packages/protocol/src/wallet/campaign";
import { campaign, ETH, soon, DEST_BTC } from "../helpers";

const q = (provider: ProviderId, toMin: bigint, over: Partial<Quote> = {}): Quote => ({ provider, category: "A", toAmount: toMin + 100n, toAmountMin: toMin, fees: [], etaSeconds: 600, expiresAt: soon(), nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: null, obtainedAt: Date.now(), ...over });
const ok = (provider: ProviderId, over: Partial<Health> = {}): Health => ({ provider, reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now(), ...over });
const health = (...hs: Health[]) => Object.fromEntries(hs.map((h) => [h.provider, h])) as Record<ProviderId, Health>;
const score = (provider: ProviderId, filtered?: string): RouteScore => ({ provider, components: { price: 1, security: 1, privacy: 1, latency: 1, liquidity: 1, reliability: 1 }, total: 1, ...(filtered ? { filtered } : {}) });

describe("eligibility (plan §44)", () => {
  it("an expired quote, an unreachable or halted provider, a breaker skip, a size outside the limits and an impact above the cap exclude the route", () => {
    const h = health(ok("thorchain"), ok("chainflip", { reachable: false }), ok("mayan", { halted: true }), ok("near-intents"), ok("lifi"));
    const now = Date.now();
    const s = scoreRoutes([q("thorchain", 100n, { expiresAt: Math.floor(now / 1000) - 1 }), q("chainflip", 100n), q("mayan", 100n), q("near-intents", 100n, { limits: { max: 50n } }), q("lifi", 100n, { impactBps: IMPACT_CAP_BPS + 1 })], h, "privacy-execution", now, {}, { tier: "high-value", amount: 100n, skipped: {} });
    const by = Object.fromEntries(s.map((x) => [x.provider, x.filtered]));
    expect(by.thorchain).toBe("quote expired");
    expect(by.chainflip).toBe("provider unreachable");
    expect(by.mayan).toBe("provider halted");
    expect(by["near-intents"]).toMatch(/above the provider's limit/);
    expect(by.lifi, "another route quoted the size under the cap? none did: the impact cap filters only against an alternative").toBeUndefined();
    const two = scoreRoutes([q("thorchain", 100n), q("lifi", 100n, { impactBps: IMPACT_CAP_BPS + 1 })], health(ok("thorchain"), ok("lifi")), "privacy-execution", now, {}, { tier: "high-value", amount: 100n });
    expect(two.find((x) => x.provider === "lifi")!.filtered).toMatch(/price impact/);
    expect(chooseRoute(two)!.provider).toBe("thorchain");
    const skipped = scoreRoutes([q("thorchain", 100n)], health(ok("thorchain")), "balanced", now, {}, { skipped: { thorchain: "skipped after 3 consecutive failures" } });
    expect(skipped[0].filtered).toMatch(/skipped/);
  });
});

describe("the circuit breaker (plan §45)", () => {
  it("three consecutive failures open it; a success closes it; after it expires one probe is allowed", () => {
    const t = new ProviderHealthTracker({ breakerAfter: 3, breakerMs: 1000 });
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) t.recordFailure("thorchain", t0 + i);
    expect(t.breakerOpen("thorchain", t0 + 3)).toMatch(/3 consecutive failures/);
    expect(t.breakerOpen("thorchain", t0 + 2000), "expired: a probe").toBeNull();
    expect(t.state("thorchain", t0 + 2001).probe).toBe(true);
    t.recordFailure("thorchain", t0 + 2002);
    expect(t.breakerOpen("thorchain", t0 + 2003)).toMatch(/probe/);
    t.recordSuccess("thorchain");
    expect(t.breakerOpen("thorchain", t0 + 2004)).toBeNull();
  });
});

describe("concentration (plan §46–§47; I-S 7)", () => {
  const db = RiskDb.load(RISK_DB_DIR);
  const NOW = Date.parse("2026-10-07T00:00:00Z");
  const req = (amount: bigint): QuoteRequest => ({ from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount, destination: DEST_BTC, slippageBps: 50 });
  const setOf = (quotes: Quote[], scores = quotes.map((x) => score(x.provider))): QuoteSet => ({ quotes, errors: {}, health: Object.fromEntries(quotes.map((x) => [x.provider, ok(x.provider)])) as Record<ProviderId, Health>, scores, chosen: scores[0], links: {}, policy: "balanced", competition: [] });
  it("two venues at ≥ $5M: no provider above 30 % of the order; one venue: 100 %, disclosed", () => {
    const amount = 1250n * ETH; // $5M at $4,000
    const stream = { plan: { mode: "streaming" as const, parts: 205, intervalBlocks: 1, expectedSeconds: 1400 } };
    const two = recommendProtection({ set: setOf([q("thorchain", amount, stream), q("chainflip", amount, { plan: { mode: "dca", parts: 20, intervalBlocks: 2, expectedSeconds: 1200 } })]), req: req(amount), amount, tier: "high-value-secondary", mode: "balanced", usdPerUnit: 4000, db, now: NOW, rng: () => 0.5 })!;
    expect(PROVIDER_SHARE_CAP_BPS).toBe(3000);
    expect(two.providerShareCapBps).toBe(3000);
    expect(two.concentration).toMatchObject({ singleVenue: false, capBps: 3000 });
    const one = recommendProtection({ set: setOf([q("thorchain", amount, stream)]), req: req(amount), amount, tier: "high-value-secondary", mode: "balanced", usdPerUnit: 4000, db, now: NOW, rng: () => 0.5 })!;
    expect(one.concentration).toMatchObject({ singleVenue: true, capBps: 10000 });
    expect(one.reasons.join(" ")).toMatch(/single venue/);
    // the limit the ledger enforces at run time (I6)
    expect(providerLimit(campaign([250n * ETH, 250n * ETH, 250n * ETH, 250n * ETH], [], {}, { capBps: 10000, providerShareCapBps: 3000 }))).toBe(300n * ETH);
  });
});
