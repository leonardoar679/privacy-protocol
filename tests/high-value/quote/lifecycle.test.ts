// The quote lifecycle and normalization (plan §11–§12, §41–§43; contract §3.2–§3.3, §7): INDICATIVE → REVIEW → SIGN →
// HARD → EXECUTION is quote → commit → prepare → sign → hand-over; the presets are configuration whose weights sum to
// one; the policy follows the protection mode from high-value; PAES is reported beside the total; every quote
// normalizes to the eight fields; the per-tranche execution window is clamped into the policy's budget.
import { describe, it, expect } from "vitest";
import { POLICIES, type Health, type ProviderId, type Quote } from "../../../packages/swap-engine/src/types";
import { WEIGHTS, paesOf, policyFor, scoreRoutes, chooseRoute } from "../../../packages/swap-engine/src/scoring";
import { DELAY_BUDGET, EXECUTE_WINDOW_MIN_SECONDS, executeWindowFor } from "../../../packages/swap-engine/src/engine";
import { normalizeQuote } from "../../../packages/swap-engine/src/normalize";
import { ETH_REF, BTC_REF, soon } from "../helpers";

const q = (provider: ProviderId, toMin: bigint, over: Partial<Quote> = {}): Quote => ({ provider, category: "A", toAmount: toMin + 100n, toAmountMin: toMin, fees: [], etaSeconds: 600, expiresAt: soon(), nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: null, obtainedAt: Date.now(), ...over });
const ok = (provider: ProviderId, over: Partial<Health> = {}): Health => ({ provider, reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now(), ...over });
const health = (...hs: Health[]) => Object.fromEntries(hs.map((h) => [h.provider, h])) as Record<ProviderId, Health>;

describe("the presets and the policy (plan §43; contract §7)", () => {
  it("seven policies whose weights sum to one; the plan's two presets exactly", () => {
    expect(POLICIES).toContain("best-execution");
    expect(POLICIES).toContain("high-privacy");
    for (const p of POLICIES) expect(Object.values(WEIGHTS[p]).reduce((s, w) => s + w, 0), p).toBeCloseTo(1, 9);
    expect(WEIGHTS["best-execution"]).toEqual({ price: 0.35, security: 0.2, liquidity: 0.15, reliability: 0.1, privacy: 0.1, latency: 0.1 });
    expect(WEIGHTS["high-privacy"]).toEqual({ price: 0.25, security: 0.2, liquidity: 0.1, reliability: 0.1, privacy: 0.25, latency: 0.1 });
  });
  it("the policy follows the protection mode from high-value and the preference below it", () => {
    expect(policyFor("balanced", "enhanced", "best-execution")).toBe("balanced");
    expect(policyFor("balanced", "high-value", "best-execution")).toBe("best-execution");
    expect(policyFor("best-price", "institutional", "max-privacy")).toBe("high-privacy");
    expect(policyFor("fastest", "high-value", "balanced")).toBe("privacy-execution");
    expect(policyFor("best-privacy", "high-value", "best-execution"), "the most private preference is never overridden").toBe("best-privacy");
  });
  it("PAES (plan §87) sits beside the total and never chooses by itself", () => {
    const quotes = [q("near-intents", 1_000_000n, { etaSeconds: 30 }), q("chainflip", 985_000n, { etaSeconds: 1200 })];
    const s = scoreRoutes(quotes, health(ok("near-intents"), ok("chainflip")), "best-execution");
    for (const r of s) expect(r.paes).toBe(paesOf(r.components));
    expect(paesOf({ price: 100, security: 100, privacy: 100, latency: 0, liquidity: 0, reliability: 0 })).toBe(100);
    expect(paesOf({ price: 100, security: 60, privacy: 60, latency: 0, liquidity: 0, reliability: 0 })).toBe(80);
    expect(chooseRoute(s)!.provider, "the policy's total chooses").toBe(s.slice().sort((a, b) => b.total - a.total)[0].provider);
  });
});

describe("normalization (plan §42; contract §3.2)", () => {
  const score = { provider: "thorchain" as ProviderId, components: { price: 90, security: 69, privacy: 91, latency: 50, liquidity: 80, reliability: 100 }, total: 80 };
  it("the eight fields, fees in USD only when every fee of the kind is valued, null never a guess", () => {
    const quote = q("thorchain", 10n ** 8n, { plan: { mode: "streaming", parts: 100, intervalBlocks: 1, expectedSeconds: 1400 }, fees: [{ kind: "network", amount: 1n, asset: "ETH", usd: 2.5 }, { kind: "gas", amount: 1n, asset: "ETH", usd: 0.5 }, { kind: "liquidity", amount: 1n, asset: "BTC" }] });
    const n = normalizeQuote(quote, { req: { from: ETH_REF, to: BTC_REF }, score, linkPublic: true });
    expect(Object.keys(n).sort()).toEqual(["estimatedDuration", "estimatedGas", "grossAmountOut", "netAmountOut", "networkFee", "privacyRisk", "provider", "providerFee", "routeRisk"].sort());
    expect(n).toMatchObject({ netAmountOut: (10n ** 8n).toString(), grossAmountOut: (10n ** 8n + 100n).toString(), networkFee: "3", providerFee: null, estimatedGas: null, estimatedDuration: 1400 });
    expect(n.routeRisk).toMatchObject({ class: "R5", flags: [], exposureTier: "R2", security: 69, reliability: 100 });
    expect(n.privacyRisk).toEqual({ score: 91, linkPublic: true });
  });
  it("a stated gas figure is kept as units; an unknown provider is a high-risk route; a thin market or a halted chain too", () => {
    expect(normalizeQuote(q("thorchain", 1n, { raw: { estimatedGas: 210000 } }), { req: { from: ETH_REF, to: BTC_REF }, score, linkPublic: true }).estimatedGas).toBe("210000");
    expect(normalizeQuote(q("thorchain", 1n, { impactBps: 400 }), { req: { from: ETH_REF, to: BTC_REF }, score, linkPublic: true }).routeRisk.exposureTier).toBe("R4");
    expect(normalizeQuote(q("thorchain", 1n), { req: { from: ETH_REF, to: BTC_REF }, score, health: ok("thorchain", { haltedChains: ["BTC"] }), linkPublic: true }).routeRisk.exposureTier).toBe("R4");
    expect(normalizeQuote(q("thorchain", 1n), { req: { from: ETH_REF, to: BTC_REF }, score, breakerOpen: true, linkPublic: true }).routeRisk.exposureTier).toBe("R4");
  });
});

describe("the execution window (plan §12; contract §3.3)", () => {
  it("is clamped into [10 min, the policy's delay budget]; absent, the V2 budget stands; the tranche's window is hours, not days", () => {
    expect(executeWindowFor("privacy-execution")).toBe(DELAY_BUDGET["privacy-execution"][1]);
    expect(executeWindowFor("privacy-execution", 7200)).toBe(7200);
    expect(executeWindowFor("privacy-execution", 10)).toBe(EXECUTE_WINDOW_MIN_SECONDS);
    expect(executeWindowFor("privacy-execution", 10 ** 9)).toBe(DELAY_BUDGET["privacy-execution"][1]);
    expect(executeWindowFor("best-execution", 7200)).toBe(7200);
    expect(DELAY_BUDGET["high-privacy"]).toEqual(DELAY_BUDGET["best-privacy"]);
  });
});
