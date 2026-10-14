// Provider failure (plan §105–§108; contract §8): a provider incident pauses the affected routes (I-HV 12) and the
// breaker routes the next competition elsewhere (plan §107, I-S 7); an issuer restriction on a stablecoin leg is flagged
// on that leg and that vault only (plan §106); a provider that changes the price after commitment is refused by the
// bounds and by the price guard (plan §108).
import { describe, it, expect } from "vitest";
import { detectPause, checkWithinBounds } from "../../../packages/protocol/src/wallet/campaign";
import { riskModelOf } from "../../../packages/protocol/src/wallet/riskClasses";
import { exposureTierOf } from "../../../packages/protocol/src/wallet/exposurePolicy";
import { PrivateSwapEngine } from "../../../packages/swap-engine/src/engine";
import { ProviderHealthTracker } from "../../../packages/swap-engine/src/health";
import { priceGuard, PriceGuardError } from "../../../packages/swap-engine/src/scoring";
import { riskDb } from "../../../packages/swap-engine/src/risk/riskDb";
import { NO_VALUER } from "../../../packages/swap-engine/src/valuation";
import type { Capabilities, Health, Ingress, ProviderAdapter, ProviderId, Quote, QuoteRequest, TrackStatus } from "../../../packages/swap-engine/src/types";
import { campaign, bounds, ETH, REF_RATE, soon, DEST_BTC, USDT_REF, USDC_REF, ETH_REF, BTC_REF } from "../helpers";

const q = (provider: ProviderId, toMin: bigint, over: Partial<Quote> = {}): Quote => ({ provider, category: "A", toAmount: toMin + 100n, toAmountMin: toMin, fees: [], etaSeconds: 600, expiresAt: soon(), nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: null, obtainedAt: Date.now(), ...over });
const ok = (provider: ProviderId): Health => ({ provider, reachable: true, apiLatencyMs: 300, halted: false, haltedChains: [], checkedAt: Date.now() });

/** Stub adapters: one quotes, one is down (a network error every time). */
class Stub implements ProviderAdapter {
  readonly implemented = true;
  constructor(readonly id: ProviderId, private readonly mode: "quote" | "outage") {}
  capabilities(): Capabilities { return { routes: ["A", "B", "C", "D", "E"], ingress: ["contract-call"], nativeAssets: true, atomic: false, chains: ["ethereum", "bitcoin", "solana"], destinationLinkPublic: true, linkEvidence: "stub" }; }
  async quote(req: QuoteRequest): Promise<Quote> { if (this.mode === "outage") throw new TypeError("fetch failed"); return q(this.id, req.amount / 30n); }
  async prepareIngress(req: QuoteRequest): Promise<Ingress> { return { kind: "contract-call", to: "0x00000000000000000000000000000000000000ee", calldata: "0x", value: req.amount, expiresAt: soon(), minOutEncoded: true }; }
  async track(): Promise<TrackStatus> { return { state: "unknown" }; }
  async health(): Promise<Health> { return ok(this.id); }
}
const engine = (adapters: ProviderAdapter[]) => new PrivateSwapEngine({ adapters, factory: "0x0000000000000000000000000000000000000001", escrowCreationCode: "0x00", chainId: 1n, refundVaults: { native: "0x0000000000000000000000000000000000000002" }, tips: { tipFor: async (_from, amount) => amount / 400n } /* a fixed 0.25 %: the service prices the gas (swap-engine tips.ts) */, refundWindowSeconds: 7200, valuer: NO_VALUER, healthTracker: new ProviderHealthTracker({ breakerAfter: 3, breakerMs: 300_000 }) });
const req: QuoteRequest = { from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 50 };

describe("plan §105: a provider incident pauses the affected routes (I-HV 12)", () => {
  it("an incident dated after the campaign started pauses with security-incident; an open breaker with provider-error; the rest of the order stays protected", () => {
    const c = campaign([50n * ETH, 50n * ETH, 50n * ETH], ["settled", "executing", "planned"], {}, { capBps: 5000 });
    expect(detectPause(c, { now: c.createdAt + 10, walletPaused: false, incidentDates: [c.createdAt + 5] })).toMatchObject({ reason: "security-incident" });
    expect(detectPause(c, { now: c.createdAt + 10, walletPaused: false, incidentDates: [c.createdAt - 5] }), "an older incident is a score, not a pause").toBeNull();
    expect(detectPause(c, { now: c.createdAt + 10, walletPaused: false, providerHealth: { breakerOpen: true } })).toMatchObject({ reason: "provider-error" });
    // what is reachable at the pause: one tranche; the remaining $100K of $150K never left the private balance
    expect(exposureTierOf({ class: "R5" }, { incidentWithinDays: 1 }).tier).toBe("R4");
  });
});

describe("plan §107: THORChain's breaker routes the competition elsewhere (I-S 7)", () => {
  it("three outages open the breaker; the competition skips the provider and chooses another", async () => {
    const thor = new Stub("thorchain", "outage"), cf = new Stub("chainflip", "quote");
    const e = engine([thor, cf]);
    for (let i = 0; i < 3; i++) await e.quoteAll(req, "balanced");
    const set = await e.quoteAll(req, "balanced");
    expect(set.competition.find((c) => c.provider === "thorchain")).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("skipped after 3 consecutive failures") });
    expect(set.chosen?.provider).toBe("chainflip");
    expect(e.tracker.breakerOpen("thorchain")).toMatch(/skipped/);
  });
});

describe("plan §106: an issuer failure stays inside its vault", () => {
  it("USDT legs carry the issuer flag and the asset record states the freeze risk; ETH and the core are untouched", () => {
    expect(riskModelOf("thorchain", {}, USDT_REF, BTC_REF).flags).toEqual(["R7"]);
    expect(riskModelOf("thorchain", {}, USDC_REF, BTC_REF).flags).toEqual(["R7"]);
    expect(riskModelOf("thorchain", {}, ETH_REF, BTC_REF).flags).toEqual([]);
    expect(riskDb().assetRisk("USDT")).toMatchObject({ freezeRisk: true });
    expect(riskDb().assetRisk("USDC")).toMatchObject({ freezeRisk: true });
    expect(riskDb().assetRisk("ETH")).toMatchObject({ freezeRisk: false });
  });
});

describe("plan §108: quote manipulation is refused", () => {
  it("a hard quote below the bound is outside the envelope; a re-quote far below the live alternatives is refused by the price guard", () => {
    const b = bounds();
    const minFor = (50n * ETH * REF_RATE) / 10n ** 18n;
    expect(checkWithinBounds(b, { amount: 50n * ETH, toAmountMin: minFor - 1n, quoteExpiresAt: 1_700_000, feeBps: 10, destination: "x", fundedBefore: 0n, now: 1_000_000 })).toMatchObject({ ok: false });
    const alternatives = [q("chainflip", 1_000_000n)];
    expect(() => priceGuard(q("thorchain", 900_000n), alternatives, 50)).toThrow(PriceGuardError);
    expect(() => priceGuard(q("thorchain", 996_000n), alternatives, 50)).not.toThrow();
  });
});
