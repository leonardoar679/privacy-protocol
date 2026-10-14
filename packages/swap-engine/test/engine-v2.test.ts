// V2 engine rules (whale spec §2–§5, §12, §16–§17), offline with stub adapters: the five policies and the
// preference → policy derivation, the impact cap, the stream-length and limit filters, the competition
// record with its time budget and the circuit breaker, the phase-1 placeholder destination, and the privacy
// inputs (the asset's own bucket alphabet, the destination's provenance).
import { describe, it, expect } from "vitest";
import { PrivateSwapEngine, QUOTE_TIMEOUT_MS } from "../src/engine";
import { IMPACT_CAP_BPS, STREAM_MAX_SECONDS, WEIGHTS, chooseRoute, maxGapBpsFor, policyFor, scoreRoutes } from "../src/scoring";
import { ProviderHealthTracker, chainHalted, reliabilityScore } from "../src/health";
import { PLACEHOLDER_BTC, PLACEHOLDER_EVM, PLACEHOLDER_SOL, placeholderDestination } from "../src/placeholders";
import { NO_VALUER } from "../src/valuation";
import type { AssetRef, Capabilities, Health, Ingress, POLICIES as _P, ProviderAdapter, ProviderId, Quote, QuoteRequest, TrackStatus } from "../src/types";
import { POLICIES, isPolicy } from "../src/types";
import { shareTips } from "./helpers/tips";

const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const USDC: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const DEST_BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const KEYS = { orderSigner: "0x00000000000000000000000000000000000000a1", refundOwnerCommitment: 1n, refundNoteSecret: 2n, refundNoteDataHash: ("0x" + "11".repeat(32)) as `0x${string}` };
const soon = () => Math.floor(Date.now() / 1000) + 600;
const q = (provider: ProviderId, toMin: bigint, over: Partial<Quote> = {}): Quote => ({ provider, category: "A", toAmount: toMin + 100n, toAmountMin: toMin, fees: [], etaSeconds: 600, expiresAt: soon(), nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: null, obtainedAt: Date.now(), ...over });
const ok = (provider: ProviderId, over: Partial<Health> = {}): Health => ({ provider, reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now(), ...over });
const health = (...hs: Health[]) => Object.fromEntries(hs.map((h) => [h.provider, h])) as Record<ProviderId, Health>;

describe("policies (whale spec §4)", () => {
  it("five policies whose weights sum to one; the derivation from a preference and a tier", () => {
    expect(POLICIES).toEqual(["best-privacy", "best-price", "fastest", "balanced", "privacy-execution", "best-execution", "high-privacy"]);
    for (const p of POLICIES) expect(Object.values(WEIGHTS[p]).reduce((s, w) => s + w, 0), p).toBeCloseTo(1, 9);
    expect(isPolicy("balanced")).toBe(true);
    expect(isPolicy("cheapest")).toBe(false);
    expect(policyFor("balanced", "standard")).toBe("balanced");
    expect(policyFor("native", "enhanced")).toBe("balanced");
    expect(policyFor("best-price", "enhanced")).toBe("best-price");
    expect(policyFor("best-price", "high-value")).toBe("privacy-execution");
    expect(policyFor("fastest", "institutional")).toBe("privacy-execution");
    expect(policyFor("best-privacy", "institutional")).toBe("best-privacy");
    // V4 (contract §7): the protection mode picks the plan's §43 preset from high-value; below it nothing changes
    expect(policyFor("balanced", "high-value", "best-execution")).toBe("best-execution");
    expect(policyFor("best-price", "institutional", "max-privacy")).toBe("high-privacy");
    expect(policyFor("balanced", "high-value", "max-safety")).toBe("privacy-execution");
    expect(policyFor("best-privacy", "high-value", "best-execution")).toBe("best-privacy");
    expect(policyFor("balanced", "enhanced", "best-execution")).toBe("balanced");
    expect(WEIGHTS["best-execution"]).toEqual({ price: 0.35, security: 0.20, liquidity: 0.15, reliability: 0.10, privacy: 0.10, latency: 0.10 });
    expect(WEIGHTS["high-privacy"]).toEqual({ price: 0.25, security: 0.20, liquidity: 0.10, reliability: 0.10, privacy: 0.25, latency: 0.10 });
    expect(maxGapBpsFor("enhanced")).toBe(100);
    expect(maxGapBpsFor("high-value")).toBe(50);
  });
  it("V4: PAES is reported per route beside the total — price less a quarter of the privacy and security shortfalls", () => {
    const quotes = [q("near-intents", 1_000_000n, { etaSeconds: 30 }), q("chainflip", 985_000n, { etaSeconds: 1200 })];
    const s = scoreRoutes(quotes, health(ok("near-intents"), ok("chainflip")), "best-execution");
    for (const r of s) expect(r.paes).toBe(Math.round((r.components.price - 0.25 * (100 - r.components.privacy) - 0.25 * (100 - r.components.security)) * 100) / 100);
    expect(s[0].paes).toBeLessThan(s[0].components.price);
  });
  it("balanced still counts latency; privacy-execution drops it and lets privacy and security outweigh 1.5 % of price", () => {
    const quotes = [q("near-intents", 1_000_000n, { etaSeconds: 30 }), q("chainflip", 985_000n, { etaSeconds: 1200 })];
    const h = health(ok("near-intents"), ok("chainflip"));
    expect(chooseRoute(scoreRoutes(quotes, h, "fastest"))!.provider).toBe("near-intents");
    expect(chooseRoute(scoreRoutes(quotes, h, "balanced"))!.provider).toBe("near-intents"); // 20 minutes of latency still count
    expect(chooseRoute(scoreRoutes(quotes, h, "privacy-execution"))!.provider).toBe("chainflip"); // 89.75 vs 89.45: six points of privacy and three of security beat 1.5 % of price
  });
});

describe("size-aware filters (whale spec §2, §4, §12)", () => {
  it("the impact cap applies from the high-value tier and only when another route quoted the size", () => {
    const quotes = [q("thorchain", 1_000_000n, { impactBps: 169 }), q("mayan", 990_000n, { impactBps: 20 })];
    const h = health(ok("thorchain"), ok("mayan"));
    expect(scoreRoutes(quotes, h, "balanced", Date.now(), {}, { tier: "enhanced" }).map((s) => s.filtered)).toEqual([undefined, undefined]);
    const high = scoreRoutes(quotes, h, "privacy-execution", Date.now(), {}, { tier: "high-value" });
    expect(high[0].filtered).toMatch(new RegExp(`169 bps above the ${IMPACT_CAP_BPS} bps cap`));
    expect(chooseRoute(high)!.provider).toBe("mayan");
    // alone, the route stays, impact and all
    expect(scoreRoutes([quotes[0]], h, "privacy-execution", Date.now(), {}, { tier: "institutional" })[0].filtered).toBeUndefined();
  });
  it("a stream longer than four hours is not chosen automatically when a faster route quoted; alone it stays", () => {
    const slow = q("thorchain", 1_000_000n, { plan: { mode: "streaming", parts: 14_399, intervalBlocks: 1, expectedSeconds: 86_000 } });
    const fast = q("mayan", 990_000n, { plan: { mode: "single", parts: 1, intervalBlocks: 0, expectedSeconds: 60 } });
    const h = health(ok("thorchain"), ok("mayan"));
    expect(scoreRoutes([slow, fast], h, "balanced")[0].filtered).toMatch(/hour stream when a faster route quoted/);
    expect(scoreRoutes([slow], h, "balanced")[0].filtered).toBeUndefined();
    expect(STREAM_MAX_SECONDS).toBe(14_400);
  });
  it("a quote outside the provider's stated limits is filtered; the liquidity component reads the impact figure", () => {
    const limited = q("uniswap-across", 1_000_000n, { limits: { min: 10n, max: 1_000n }, impactBps: 0 });
    const h = health(ok("uniswap-across"));
    expect(scoreRoutes([limited], h, "balanced", Date.now(), {}, { amount: 5_000n })[0].filtered).toMatch(/above the provider's limit/);
    expect(scoreRoutes([limited], h, "balanced", Date.now(), {}, { amount: 5n })[0].filtered).toMatch(/below the provider's minimum/);
    expect(scoreRoutes([limited], h, "balanced", Date.now(), {}, { amount: 500n })[0].components.liquidity).toBe(100);
    expect(scoreRoutes([q("thorchain", 1n, { impactBps: 350 })], health(ok("thorchain")), "balanced")[0].components.liquidity).toBe(65);
  });
  it("a provider halted on one of the order's chains is filtered, whatever form it writes the chain in", () => {
    const h = health(ok("thorchain", { haltedChains: ["BTC"] }), ok("chainflip", { haltedChains: ["bitcoin"] }), ok("mayan"));
    const s = scoreRoutes([q("thorchain", 1n), q("chainflip", 1n), q("mayan", 1n)], h, "balanced", Date.now(), {}, { chains: ["ethereum", "bitcoin"] });
    expect(s.map((x) => x.filtered)).toEqual(["provider halted on bitcoin", "provider halted on bitcoin", undefined]);
    expect(chainHalted({ haltedChains: ["ETH"] }, ["ethereum"])).toBe("ethereum");
    expect(chainHalted({ haltedChains: ["SOL"] }, ["ethereum", "bitcoin"])).toBeNull();
  });
});

describe("health: failures, the breaker and the cache (whale spec §16)", () => {
  it("reliability falls with the order's halted chain and recent failures; the breaker opens after three and closes half-open", () => {
    expect(reliabilityScore(ok("thorchain"))).toBe(100);
    expect(reliabilityScore(ok("thorchain", { haltedChains: ["BTC"] }), ["bitcoin"])).toBe(90);
    expect(reliabilityScore(ok("thorchain", { failures: { consecutive: 1, windowCount: 2 } }))).toBe(80);
    expect(reliabilityScore(ok("thorchain", { failures: { consecutive: 9, windowCount: 9 } }))).toBe(70);
    const t = new ProviderHealthTracker({ windowMs: 3600_000, breakerAfter: 3, breakerMs: 300_000, cacheMs: 30_000 });
    const t0 = 1_000_000;
    t.recordFailure("lifi", t0); t.recordFailure("lifi", t0 + 1);
    expect(t.breakerOpen("lifi", t0 + 2)).toBeNull();
    t.recordFailure("lifi", t0 + 2);
    expect(t.breakerOpen("lifi", t0 + 3)).toMatch(/skipped after 3 consecutive failures/);
    expect(t.failures("lifi", t0 + 3)).toMatchObject({ consecutive: 3, windowCount: 3 });
    expect(t.breakerOpen("lifi", t0 + 300_001)).toMatch(/1 s left/); // opened at the third failure (t0 + 2)
    expect(t.breakerOpen("lifi", t0 + 300_003)).toBeNull(); // expired: one attempt allowed
    t.recordSuccess("lifi");
    expect(t.failures("lifi", t0 + 300_004).consecutive).toBe(0);
    expect(t.failures("lifi", t0 + 4_000_000).windowCount).toBe(0); // outside the window
    const h = ok("lifi");
    t.rememberHealth("lifi", h, t0);
    expect(t.cachedHealth("lifi", t0 + 10_000)?.provider).toBe("lifi");
    expect(t.cachedHealth("lifi", t0 + 40_000)).toBeNull();
  });
});

/** Stub adapters: a THORChain that quotes and remembers the destination it was asked for; a Chainflip that refuses the size; a Mayan that hangs. */
class Stub implements ProviderAdapter {
  readonly implemented = true;
  seen: string[] = [];
  constructor(readonly id: ProviderId, private readonly mode: "quote" | "refuse" | "hang" | "outage", private readonly nativeAssets = true) {}
  capabilities(): Capabilities { return { routes: ["A", "B", "C", "D", "E"], ingress: ["contract-call"], nativeAssets: this.nativeAssets, atomic: false, chains: ["ethereum", "bitcoin", "solana"], destinationLinkPublic: true, linkEvidence: "stub adapter: the calldata names the destination" }; }
  async quote(req: QuoteRequest): Promise<Quote> {
    this.seen.push(req.destination);
    if (this.mode === "refuse") throw new Error("HTTP 400 insufficient liquidity for the requested amount");
    if (this.mode === "outage") throw new TypeError("fetch failed");
    if (this.mode === "hang") await new Promise((r) => setTimeout(r, 200));
    return q(this.id, req.amount / 30n, { nativeAssets: this.nativeAssets, plan: req.plan === "stream" ? { mode: "streaming", parts: 205, intervalBlocks: 1, expectedSeconds: 1400 } : undefined });
  }
  async prepareIngress(req: QuoteRequest): Promise<Ingress> { return { kind: "contract-call", to: "0x00000000000000000000000000000000000000ee", calldata: "0x", value: req.amount, expiresAt: soon(), minOutEncoded: true }; }
  async track(): Promise<TrackStatus> { return { state: "unknown" }; }
  async health(): Promise<Health> { return ok(this.id); }
}
const engine = (adapters: ProviderAdapter[], over: Partial<ConstructorParameters<typeof PrivateSwapEngine>[0]> = {}) =>
  new PrivateSwapEngine({ adapters, factory: "0x0000000000000000000000000000000000000001", escrowCreationCode: "0x00", chainId: 1n, refundVaults: { native: "0x0000000000000000000000000000000000000002", [USDC.asset]: "0x0000000000000000000000000000000000000003" }, tips: shareTips(25n), refundWindowSeconds: 7200, valuer: NO_VALUER, ...over });
const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 50 };

describe("the competition record, the time budget and the breaker (whale spec §2, §3, §16)", () => {
  it("records what every capable provider answered; a hang is a timeout; a refusal of the size is not an outage", async () => {
    const thor = new Stub("thorchain", "quote"), cf = new Stub("chainflip", "refuse"), mayan = new Stub("mayan", "hang");
    const e = engine([thor, cf, mayan], { quoteTimeoutMs: 50 });
    const set = await e.quoteAll(req, "balanced");
    const by = Object.fromEntries(set.competition.map((c) => [c.provider, c]));
    expect(by.thorchain.outcome).toBe("quoted");
    expect(by.chainflip).toMatchObject({ outcome: "refused", reason: expect.stringContaining("insufficient liquidity") });
    expect(by.mayan).toMatchObject({ outcome: "timeout", reason: expect.stringContaining("no answer within") });
    expect(set.chosen?.provider).toBe("thorchain");
    expect(set.policy).toBe("balanced");
    expect(set.tier).toBe("high-value"); // no price source: the fail-safe tier
    expect(QUOTE_TIMEOUT_MS).toBe(25_000);
    // the refusal did not count against Chainflip; the timeout counted against Mayan
    expect(e.tracker.failures("chainflip").consecutive).toBe(0);
    expect(e.tracker.failures("mayan").consecutive).toBe(1);
  });
  it("three outages open the breaker: the provider is skipped for a while and the competition says so", async () => {
    const thor = new Stub("thorchain", "quote"), lifi = new Stub("lifi", "outage");
    const e = engine([thor, lifi]);
    for (let i = 0; i < 3; i++) await e.quoteAll(req, "balanced");
    const set = await e.quoteAll(req, "balanced");
    expect(set.competition.find((c) => c.provider === "lifi")).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("skipped after 3 consecutive failures") });
    expect(set.errors.lifi).toMatch(/skipped/);
    expect(set.chosen?.provider).toBe("thorchain");
  });
  it("V4 (contract §3.2): every quoted line carries the normalized quote — outputs, fees, duration, the route's class and exposure tier, the privacy of the path", async () => {
    const thor = new Stub("thorchain", "quote"), cf = new Stub("chainflip", "refuse");
    const e = engine([thor, cf]);
    const set = await e.quoteAll(req, { preference: "balanced" }, { mode: "best-execution" });
    expect(set.policy).toBe("best-execution"); // the fail-safe tier is high-value: the mode's preset
    const line = set.competition.find((c) => c.provider === "thorchain")!;
    const quote = set.quotes[0];
    expect(line.normalized).toEqual({
      provider: "thorchain", netAmountOut: quote.toAmountMin.toString(), grossAmountOut: quote.toAmount.toString(), providerFee: "0", networkFee: "0", estimatedGas: null, estimatedDuration: 1400,
      routeRisk: { class: "R5", flags: [], exposureTier: "R2", security: set.scores[0].components.security, reliability: set.scores[0].components.reliability },
      privacyRisk: { score: set.scores[0].components.privacy, linkPublic: true },
    });
    expect(set.competition.find((c) => c.provider === "chainflip")!.normalized).toBeUndefined();
    // fees in USD only when every fee of the kind is valued
    const valued = q("thorchain", 10n, { fees: [{ kind: "network", amount: 1n, asset: "ETH", usd: 2.5 }, { kind: "liquidity", amount: 1n, asset: "BTC", usd: 10 }, { kind: "affiliate", amount: 1n, asset: "BTC" }] });
    const { normalizeQuote } = await import("../src/normalize");
    const n = normalizeQuote(valued, { req, score: set.scores[0], linkPublic: true });
    expect(n).toMatchObject({ networkFee: "2.5", providerFee: null, estimatedDuration: 600, routeRisk: { exposureTier: "R3" } });
  });
  it("the policy derives from the preference and the tier; the native preference filters a wrapped route when a native one quoted", async () => {
    const native = new Stub("thorchain", "quote", true), wrapped = new Stub("lifi", "quote", false);
    const e = engine([native, wrapped]);
    const set = await e.quoteAll(req, { preference: "native" });
    expect(set.policy).toBe("privacy-execution"); // the fail-safe tier is high-value → the override
    expect(set.scores.find((s) => s.provider === "lifi")!.filtered).toMatch(/native route quoted/);
    expect(set.competition.find((c) => c.provider === "lifi")!.outcome).toBe("filtered");
    expect((await e.quoteAll(req, { preference: "best-privacy" })).policy).toBe("best-privacy");
  });
});

describe("phase-1 placeholders and the plan hint (whale spec §5, §12)", () => {
  it("quotes carry a placeholder destination; the fresh address reaches the chosen provider at prepare only", async () => {
    const thor = new Stub("thorchain", "quote"), cf = new Stub("chainflip", "quote");
    const e = engine([thor, cf]);
    const set = await e.quoteAll(req, "balanced");
    expect(thor.seen).toEqual([PLACEHOLDER_BTC]);
    expect(cf.seen).toEqual([PLACEHOLDER_BTC]);
    const order = e.buildOrder(req, set.policy, set.quotes.find((x) => x.provider === "thorchain")!, KEYS, { value: set.value!, tier: set.tier!, failSafe: true });
    expect(order.request.destination).toBe(DEST_BTC);
    expect(order.destination).toEqual({ chain: "bitcoin", asset: "native", address: DEST_BTC, kind: "fresh" });
    expect(order.plan).toMatchObject({ mode: "streaming", parts: 205 }); // the hint: from the enhanced tier the stream is asked for
    await e.prepareExecution(order, thor);
    expect(thor.seen.at(-1)).toBe(DEST_BTC);
    expect(cf.seen).toEqual([PLACEHOLDER_BTC]);
  });
  it("placeholders are format-valid addresses of the right chain, and none for a chain without one", () => {
    expect(placeholderDestination("ethereum")).toBe(PLACEHOLDER_EVM);
    expect(placeholderDestination("base")).toBe(PLACEHOLDER_EVM);
    expect(placeholderDestination("bitcoin")).toBe(PLACEHOLDER_BTC);
    expect(placeholderDestination("solana")).toBe(PLACEHOLDER_SOL);
    expect(PLACEHOLDER_SOL).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(PLACEHOLDER_SOL).not.toBe("11111111111111111111111111111111");
    expect(placeholderDestination("litecoin")).toBeNull();
  });
  it("the hard quote must keep the approved minimum; a lower one is a MinimumMovedError, a higher one passes", async () => {
    const thor = new Stub("thorchain", "quote");
    const e = engine([thor]);
    const set = await e.quoteAll(req, "balanced");
    const order = e.buildOrder(req, set.policy, set.quotes[0], KEYS);
    const min = set.quotes[0].toAmountMin;
    await expect(e.prepareExecution(order, thor, undefined, min + 1n)).rejects.toMatchObject({ approvedMin: min + 1n, newMin: min });
    await expect(e.prepareExecution(order, thor, undefined, min)).resolves.toMatchObject({ provider: "0x00000000000000000000000000000000000000ee" });
  });
});

describe("privacy inputs (whale spec §17)", () => {
  it("a bucketed USDC amount counts as bucketed, an entered destination lowers the score, an edited request keeps its kind", () => {
    const e = engine([new Stub("thorchain", "quote")]);
    const quote = q("thorchain", 1n, { executorTip: 1_000n });
    // 500,000 USDC is the top of USDC's alphabet (bucketsFor(6)); the 18-decimal series would not know it at all
    const usdcReq: QuoteRequest = { from: USDC, to: BTC, amount: 500_000n * 10n ** 6n, destination: DEST_BTC, slippageBps: 50 };
    const bucketed = e.buildOrder(usdcReq, "balanced", quote, KEYS);
    const odd = e.buildOrder({ ...usdcReq, amount: 1_234_567n * 10n ** 6n }, "balanced", quote, KEYS);
    expect(bucketed.privacy.amountNormalized).toBe(true);
    expect(odd.privacy.amountNormalized).toBe(false);
    expect(bucketed.privacy.score).toBeGreaterThan(odd.privacy.score);
    const fresh = e.buildOrder(req, "balanced", quote, KEYS);
    const entered = e.buildOrder({ ...req, destinationKind: "entered" }, "balanced", quote, KEYS);
    expect(entered.privacy.score).toBeLessThan(fresh.privacy.score);
    expect(entered.destination?.kind).toBe("entered");
    const restored = e.restoreOrder({ ...req, destinationKind: "entered" }, "balanced", quote, entered.params);
    expect(restored.privacy.score).toBe(entered.privacy.score);
  });
});
