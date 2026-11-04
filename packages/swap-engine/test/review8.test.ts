// The eighth review round (2026-11-03): the competition and the risk layer. The benchmark and the relative rules count only routes
// that can execute (D-M1); an outage is named positively, so an adapter's own quote-time check never opens a breaker for every user
// (D-M2); a quote's expiry and impact are held to their ranges (D-L4, M3); an incident the score has no penalty for is refused and
// a NaN total is never chosen (D-L5); the plan of a route no plan can stage is no recommendation (M3); a route record's key names
// the chain off an asset's home (D-L1).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateSwapEngine, boundedQuote, isOutage, MAX_QUOTE_TTL_SECONDS } from "../src/engine";
import { chooseRoute, scoreRoutes, type RouteScore } from "../src/scoring";
import { DEFAULT_HALF_LIFE_DAYS, incidentOf, isIncident, riskDb, routePairOf } from "../src/risk/riskDb";
import { fileIncidents } from "../src/health";
import { securityBreakdown } from "../src/risk/security";
import { protectionFor, recommendProtection } from "../src/risk/protection";
import { MAX_TRANCHES } from "@privacy-wallet/protocol/wallet/campaign";
import { NO_VALUER } from "../src/valuation";
import type { AssetRef, Capabilities, Health, Ingress, ProviderAdapter, ProviderId, Quote, QuoteRequest, TrackStatus } from "../src/types";
import { shareTips } from "./helpers/tips";

const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const DEST_BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const nowS = () => Math.floor(Date.now() / 1000);
const q = (provider: ProviderId, toMin: bigint, over: Partial<Quote> = {}): Quote => ({ provider, category: "A", toAmount: toMin + 100n, toAmountMin: toMin, fees: [], etaSeconds: 600, expiresAt: nowS() + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: null, obtainedAt: Date.now(), ...over });
const ok = (provider: ProviderId): Health => ({ provider, reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now() });
const healthOf = (quotes: Quote[]) => Object.fromEntries(quotes.map((x) => [x.provider, ok(x.provider)])) as Record<ProviderId, Health>;
const priceOf = (scores: RouteScore[], p: ProviderId) => scores.find((s) => s.provider === p)!.components.price;

describe("the benchmark and the relative rules count only routes that can execute (D-M1)", () => {
  const thor = q("thorchain", 1_000_000n), cf = q("chainflip", 960_000n);
  it("a filtered quote above every eligible one changes no eligible price and no choice", () => {
    const alone = scoreRoutes([thor, cf], healthOf([thor, cf]), "best-price");
    expect(chooseRoute(alone)?.provider).toBe("thorchain");
    for (const [label, extra, unexecutable] of [
      ["NEAR Intents 20 % above, never executable", q("near-intents", 1_200_000n), { "near-intents": "ingress from a contract sender unconfirmed by the provider" }],
      ["LI.FI above its own limit", q("lifi", 1_200_000n, { limits: { max: 1n } }), {}],
      ["a minimum a strict policy cannot verify", q("mayan", 1_200_000n, { minOutVerified: false }), {}],
    ] as const) {
      const quotes = [thor, cf, extra];
      const scores = scoreRoutes(quotes, healthOf(quotes), "best-price", Date.now(), unexecutable as Partial<Record<ProviderId, string>>, { amount: 10n ** 18n });
      expect(scores.find((s) => s.provider === extra.provider)!.filtered, label).toBeTruthy();
      expect(priceOf(scores, "thorchain"), label).toBe(priceOf(alone, "thorchain"));
      expect(priceOf(scores, "chainflip"), label).toBe(priceOf(alone, "chainflip"));
      expect(chooseRoute(scores)?.provider, label).toBe("thorchain");
    }
  });
  it("a route a strict policy refuses never knocks out the only one that can execute", () => {
    const thick = q("thorchain", 1_000_000n, { impactBps: 60 }); // above the cap at the high-value tier
    const claim = q("lifi", 990_000n, { impactBps: 5, minOutVerified: false });
    const scores = scoreRoutes([thick, claim], healthOf([thick, claim]), "privacy-execution", Date.now(), {}, { tier: "high-value", amount: 10n ** 18n });
    expect(scores.find((s) => s.provider === "lifi")!.filtered).toMatch(/not locally verifiable/);
    expect(scores.find((s) => s.provider === "thorchain")!.filtered, "no executable route quoted the size under the cap").toBeUndefined();
    expect(chooseRoute(scores)?.provider).toBe("thorchain");
  });
});

/** A stub whose quotes fail in a named way, or answer with figures out of range. */
class Stub implements ProviderAdapter {
  readonly implemented = true;
  constructor(readonly id: ProviderId, private readonly answer: () => Promise<Quote>) {}
  capabilities(): Capabilities { return { routes: ["A", "B", "C", "D", "E"], ingress: ["contract-call"], nativeAssets: true, atomic: false, chains: ["ethereum", "bitcoin"], destinationLinkPublic: true, linkEvidence: "stub" }; }
  quote(): Promise<Quote> { return this.answer(); }
  async prepareIngress(req: QuoteRequest): Promise<Ingress> { return { kind: "contract-call", to: "0x00000000000000000000000000000000000000ee", calldata: "0x", value: req.amount, expiresAt: nowS() + 600, minOutEncoded: true }; }
  async track(): Promise<TrackStatus> { return { state: "unknown" }; }
  async health(): Promise<Health> { return ok(this.id); }
}
const engine = (adapters: ProviderAdapter[]) =>
  new PrivateSwapEngine({ adapters, factory: "0x0000000000000000000000000000000000000001", escrowCreationCode: "0x00", chainId: 1n, refundVaults: { native: "0x0000000000000000000000000000000000000002" }, tips: shareTips(25n), refundWindowSeconds: 7200, valuer: NO_VALUER });
const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 50 };

describe("an outage is named positively (D-M2)", () => {
  it("an adapter's own check or a refusal of the request never counts against the provider; the network failing does", async () => {
    const checks = new Stub("lifi", async () => { throw new Error("LI.FI/Across calldata: bridges 0x0 (ETH) for USDC; the floor must be counted in the asset delivered"); });
    const near = new Stub("near-intents", async () => { throw new Error("1Click decimals for ETH are 18, expected 17"); });
    const down = new Stub("chainflip", async () => { throw new TypeError("fetch failed"); });
    const thor = new Stub("thorchain", async () => q("thorchain", 1_000_000n));
    const e = engine([thor, checks, near, down]);
    for (let i = 0; i < 4; i++) await e.quoteAll(req, "balanced");
    const now = Date.now();
    expect(e.tracker.breakerOpen("lifi", now), "the adapter's check").toBeNull();
    expect(e.tracker.breakerOpen("near-intents", now), "the request's asset").toBeNull();
    expect(e.tracker.breakerOpen("chainflip", now), "the network").toMatch(/consecutive failures/);
  });
  it("the words of an outage", () => {
    for (const m of ["HTTP 503 from thornode.example", "LI.FI HTTP 502: bad gateway", "HTTP 429 too many", "fetch failed", "connect ECONNREFUSED 127.0.0.1:443", "getaddrinfo ENOTFOUND x", "The operation was aborted due to timeout", "no THORNode endpoint reachable: TypeError: fetch failed", "host answered 503 <html>"])
      expect(isOutage(m), m).toBe(true);
    for (const m of ["HTTP 400 insufficient liquidity", "LI.FI: toAmountMin exceeds toAmount", "1Click does not list base:0xdead", "THORChain refused: trading halted", "Mayan quote: HTTP 404 {}"])
      expect(isOutage(m), m).toBe(false);
  });
});

describe("a quote's figures are held to their ranges (D-L4, A-M3 / D-M3)", () => {
  it("an expiry days ahead is an hour at most; an absurd or unreadable impact is 10,000 bps at most", async () => {
    const far = new Stub("thorchain", async () => q("thorchain", 1_000_000n, { expiresAt: nowS() + 10 * 86_400, impactBps: 1e15 }));
    const set = await engine([far]).quoteAll(req, "balanced");
    expect(set.quotes[0].expiresAt).toBeLessThanOrEqual(nowS() + MAX_QUOTE_TTL_SECONDS);
    expect(set.quotes[0].impactBps).toBe(10_000);
    expect(boundedQuote(q("thorchain", 1n, { impactBps: Number.NaN }), nowS()).impactBps).toBe(10_000);
    expect(boundedQuote(q("thorchain", 1n, { impactBps: -5 }), nowS()).impactBps).toBe(0);
    expect(boundedQuote(q("thorchain", 1n), nowS()).impactBps, "none stated: none").toBeUndefined();
  });
});

describe("every incident naming a provider and a date is weighed; a NaN total is never chosen (D-L5; the ninth review round, A9-2)", () => {
  const base = { provider: "chainflip", date: "2026-10-01", title: "operator: exploit", lossUsd: 50_000_000, class: "key-compromise", halfLifeDays: 30, source: "ops" };
  it("a class without a penalty, a half-life not above zero, a loss that is no number: kept, normalized — they had been dropped silently", () => {
    expect(isIncident(base)).toBe(true);
    for (const x of [{ ...base, class: "exploit" }, { ...base, class: "other" }, { ...base, halfLifeDays: 0 }, { ...base, halfLifeDays: -3 }, { ...base, lossUsd: Number.NaN }, { ...base, lossUsd: null }])
      expect(isIncident(x), JSON.stringify(x)).toBe(true);
    expect(incidentOf({ ...base, halfLifeDays: 0 })!.halfLifeDays).toBe(DEFAULT_HALF_LIFE_DAYS);
    expect(incidentOf({ ...base, lossUsd: null })!.lossUsd).toBeUndefined();
    expect(incidentOf({ ...base, date: "never" }), "no date: nothing to weigh").toBeNull();
    expect(incidentOf({ ...base, provider: "" })).toBeNull();
  });
  it("an unknown class costs the most, and the operator's file keeps such records: the breaker's lever never fails open", () => {
    const at = Date.parse("2026-10-03");
    const known = securityBreakdown("chainflip", at, riskDb(), [incidentOf(base)!]).total;
    expect(securityBreakdown("chainflip", at, riskDb(), [incidentOf({ ...base, class: "exploit" })!]).total).toBe(known);
    const dir = mkdtempSync(join(tmpdir(), "incidents-"));
    try {
      const file = join(dir, "incidents.json");
      writeFileSync(file, JSON.stringify([{ ...base, class: "other", halfLifeDays: 0, lossUsd: null }, { provider: "thorchain", title: "no date" }]));
      expect(fileIncidents(Date.now(), file)).toMatchObject([{ provider: "chainflip", class: "other", halfLifeDays: DEFAULT_HALF_LIFE_DAYS }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the score stays a number even so, and a NaN total is not chosen", () => {
    const s = securityBreakdown("chainflip", Date.parse("2026-10-03"), riskDb(), [{ ...base, class: "exploit" as never }]);
    expect(Number.isFinite(s.total)).toBe(true);
    const nan: RouteScore = { provider: "chainflip", components: { price: 1, security: Number.NaN, privacy: 1, latency: 1, liquidity: 1, reliability: 1 }, total: Number.NaN };
    const fine: RouteScore = { provider: "thorchain", components: { price: 1, security: 1, privacy: 1, latency: 1, liquidity: 1, reliability: 1 }, total: 10 };
    expect(chooseRoute([nan, fine])?.provider).toBe("thorchain");
    expect(chooseRoute([fine, nan])?.provider).toBe("thorchain");
  });
});

describe("no plan of more steps than any campaign runs (A-M3 / D-M3)", () => {
  const amount = 1250n * 10n ** 18n;
  const set = (quote: Quote) => ({ quotes: [quote], errors: {}, health: healthOf([quote]), scores: [{ provider: quote.provider, components: { price: 1, security: 1, privacy: 1, latency: 1, liquidity: 1, reliability: 1 }, total: 1 }], chosen: { provider: quote.provider, components: { price: 1, security: 1, privacy: 1, latency: 1, liquidity: 1, reliability: 1 }, total: 1 }, links: {}, policy: "balanced", competition: [], executorTip: 0n }) as never;
  const reqBase: QuoteRequest = { from: ETH, to: { ...ETH, chain: "base" }, amount, destination: "0x" + "ab".repeat(20), slippageBps: 50 };
  it("a dust instant limit is planned at the exposure cap — never one unprotected order (the ninth review round, A9-1) — and the planner never loops past its bound", () => {
    const t0 = Date.now();
    const out = protectionFor(set(q("uniswap-across", 1n, { plan: undefined, limits: { maxInstant: 1n } })), reqBase, amount, "high-value-secondary", "balanced", 4000);
    expect(out.protection, "a plan, at the cap").toBeDefined();
    expect(out.protection!.maxPieceUnits).toBeNull();
    expect(out.protection!.estimatedTranches).toBeLessThanOrEqual(MAX_TRANCHES);
    expect(out.protection!.reasonCodes.map((r) => r.code)).toContain("instant-limit");
    expect(Date.now() - t0, "bounded, never seconds").toBeLessThan(2_000);
  });
  it("an absurd impact halves the piece only down to the step bound", () => {
    const p = recommendProtection({ set: set(q("thorchain", 1n, { impactBps: 1e15 })), req: { ...reqBase, to: BTC, destination: DEST_BTC }, amount, tier: "high-value-secondary", mode: "balanced", usdPerUnit: 4000, rng: () => 0.5 });
    expect(p, "a recommendation, bounded").not.toBeNull();
    expect(BigInt(p!.maxPieceUnits!)).toBeGreaterThanOrEqual(amount / BigInt(MAX_TRANCHES));
    expect(p!.estimatedTranches).toBeLessThanOrEqual(MAX_TRANCHES);
  });
});

describe("a route record's key names the chain off an asset's home (D-L1)", () => {
  it("as the lab names them, and every Base record is found", () => {
    const base = (symbol: string, decimals: number): AssetRef => ({ chain: "base", asset: "native", decimals, symbol });
    expect(routePairOf(ETH, BTC)).toBe("ETH>BTC");
    expect(routePairOf(ETH, base("ETH", 18))).toBe("ETH>ETH(Base)");
    expect(routePairOf(ETH, base("USDC", 6))).toBe("ETH>USDC(Base)");
    expect(riskDb().routeRisk(routePairOf(ETH, base("ETH", 18)), "uniswap-across")?.servedUpToUsd).toBe(2_000_000);
    for (const p of ["thorchain", "near-intents", "mayan"]) expect(riskDb().routeRisk(routePairOf(ETH, base("USDC", 6)), p), p).not.toBeNull();
  });
});
