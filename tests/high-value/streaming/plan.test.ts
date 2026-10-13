// The streaming distinction (plan §3, §35; contract §2): the policy is a maximum simultaneous exposure, not a maximum
// transaction size — a tranche a provider executes as a stream of many parts is ONE exposure; a stream on a bridge route
// is the R2 exposure tier; the step's time scales with the piece in the recommendation.
import { describe, it, expect } from "vitest";
import { exposure, withTrancheState } from "../../../packages/protocol/src/wallet/campaign";
import { exposureTierOf } from "../../../packages/protocol/src/wallet/exposurePolicy";
import { RiskDb, RISK_DB_DIR } from "../../../packages/swap-engine/src/risk/riskDb";
import { recommendProtection } from "../../../packages/swap-engine/src/risk/protection";
import type { QuoteSet } from "../../../packages/swap-engine/src/engine";
import type { Health, ProviderId, Quote, QuoteRequest } from "../../../packages/swap-engine/src/types";
import type { RouteScore } from "../../../packages/swap-engine/src/scoring";
import { campaign, ETH, soon, ETH_REF, BTC_REF, DEST_BTC } from "../helpers";

const q = (provider: ProviderId, amount: bigint, over: Partial<Quote> = {}): Quote => ({ provider, category: "A", toAmount: amount / 30n + 100n, toAmountMin: amount / 30n, fees: [], etaSeconds: 1400, expiresAt: soon(), nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: null, obtainedAt: Date.now(), plan: { mode: "streaming", parts: 205, intervalBlocks: 1, expectedSeconds: 1400 }, ...over });
const ok = (provider: ProviderId): Health => ({ provider, reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now() });
const score = (provider: ProviderId): RouteScore => ({ provider, components: { price: 1, security: 1, privacy: 1, latency: 1, liquidity: 1, reliability: 1 }, total: 1 });
const setOf = (quotes: Quote[]): QuoteSet => ({ quotes, errors: {}, health: Object.fromEntries(quotes.map((x) => [x.provider, ok(x.provider)])) as Record<ProviderId, Health>, scores: quotes.map((x) => score(x.provider)), chosen: score(quotes[0].provider), links: {}, policy: "balanced", competition: [] });
const req = (amount: bigint): QuoteRequest => ({ from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount, destination: DEST_BTC, slippageBps: 50 });
const NOW = Date.parse("2026-10-07T00:00:00Z");

describe("a stream is one exposure (plan §3)", () => {
  it("a tranche streamed in 205 parts counts once in the ledger, whatever the parts", () => {
    let c = campaign([50n * ETH, 50n * ETH], ["settled", "planned"], {}, { capBps: 5000 });
    c = withTrancheState(c, 1, "executing", 5, { provider: "thorchain", expected: { minOut: "1", rateE18: "1", etaSeconds: 1400 } });
    expect(exposure(c).inFlight).toBe(50n * ETH);
    expect(exposure(c).inFlightCount).toBe(1);
  });
  it("a stream on a bridge / MPC route is exposure tier R2 (2.5 %); a single execution on the same route is R3", () => {
    expect(exposureTierOf({ class: "R5" }, { planMode: "streaming" }).tier).toBe("R2");
    expect(exposureTierOf({ class: "R5" }, { planMode: "dca" }).tier).toBe("R2");
    expect(exposureTierOf({ class: "R5" }, { planMode: "single" }).tier).toBe("R3");
  });
  it("the recommendation scales the stream's time to the piece and adds the gate's margin: $10M in 2 % pieces is hours per step, not the whole order's stream", () => {
    const db = RiskDb.load(RISK_DB_DIR);
    const amount = 2500n * ETH;
    const p = recommendProtection({ set: setOf([q("thorchain", amount, { impactBps: 9 })]), req: req(amount), amount, tier: "institutional", mode: "balanced", usdPerUnit: 4000, db, now: NOW, rng: () => 0.5 })!;
    expect(p.exposureTier).toBe("R2");
    expect(p.estimatedTranches).toBeGreaterThan(40);
    const perStep = p.estimatedSeconds / p.estimatedTranches;
    expect(perStep).toBeGreaterThan(3600); // the Bitcoin margin alone
    expect(perStep).toBeLessThan(5 * 3600);
    expect(p.estimatedSeconds).toBeGreaterThan(1400); // never the whole order's single stream
    expect(ETH_REF.symbol + ">" + BTC_REF.symbol).toBe("ETH>BTC");
  });
});
