// Same-chain swaps into the protected balance (spec v2.0 §11.2, §12; V6 Stage 12): `destinationType: "protected"` asks only
// the providers that quote a same-chain swap (THORChain; LI.FI's route is a follow-up), only for an output asset the pool
// has a canonical vault for, on the pool's own chain; every quote carries the shield tip — the receiver's deployment and
// deposit at today's gas (forge's measured units), in the OUTPUT asset — and a route whose minimum could not pay that tip
// a hundred times over (the receiver's 1 % rule) is filtered, never chosen.
import { describe, expect, it } from "vitest";
import { GAS_UNITS } from "@privacy-wallet/contracts";
import type { Prices } from "@privacy-wallet/protocol/wallet/valuation";
import { PrivateSwapEngine, ProtectedDestinationError } from "../src/engine";
import { NO_VALUER, type Valuer } from "../src/valuation";
import { gasTips, shieldTip, shieldUnits, tipWei } from "../src/tips";
import type { AssetRef, Capabilities, Health, Ingress, ProviderAdapter, ProviderId, Quote, QuoteRequest, TrackStatus } from "../src/types";

const GWEI = 10n ** 9n;
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const USDT: AssetRef = { chain: "ethereum", asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const FEES = { baseFeePerGas: GWEI, priorityFeePerGas: GWEI / 10n }; // 1 gwei: an $8,000 order's execution fits the escrow's 1 %
const fees = { fees: async () => FEES };
const price = (symbol: string, usd: bigint) => ({
  symbol,
  usd1e8: usd * 10n ** 8n,
  roundId: 1n,
  updatedAt: 0,
  source: "test",
  endpoints: 1,
  stale: false,
  heartbeatSeconds: 3600,
});
const valuer: Valuer = { prices: async (): Promise<Prices> => ({ chainId: 1, at: 0, feeds: { ETH: price("ETH", 3_500n), USDC: price("USDC", 1n) } }) };

/** A provider quoting `rate` output units per input unit (a ratio of base units), with or without the same-chain capability. */
class Stub implements ProviderAdapter {
  readonly implemented = true;
  asked: QuoteRequest[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly sameChain: boolean,
    private readonly out: (amount: bigint) => bigint,
  ) {}
  capabilities(): Capabilities {
    return {
      routes: ["C", "A"],
      ingress: ["contract-call"],
      nativeAssets: true,
      atomic: false,
      chains: ["ethereum", "bitcoin"],
      destinationLinkPublic: true,
      linkEvidence: "stub",
      ...(this.sameChain ? { sameChain: true } : {}),
    } as Capabilities;
  }
  async quote(req: QuoteRequest): Promise<Quote> {
    this.asked.push(req);
    const toAmount = this.out(req.amount);
    return {
      provider: this.id,
      category: "C",
      toAmount,
      toAmountMin: (toAmount * 99n) / 100n,
      fees: [],
      etaSeconds: 120,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      obtainedAt: Date.now(),
      nativeAssets: true,
      minOutEncoded: true,
      minOutVerified: true,
      hops: [],
      raw: {},
    } as Quote;
  }
  async prepareIngress(req: QuoteRequest): Promise<Ingress> {
    return {
      kind: "contract-call",
      to: "0x00000000000000000000000000000000000000ee",
      calldata: "0x",
      value: 0n,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      minOutEncoded: true,
      ...(req ? {} : {}),
    };
  }
  async track(): Promise<TrackStatus> {
    return { state: "unknown" };
  }
  async health(): Promise<Health> {
    return { provider: this.id, reachable: true, apiLatencyMs: 10, halted: false, haltedChains: [], checkedAt: Date.now() };
  }
}

// 8,000 USDC → ≈ 2.286 ETH at $3,500 (6 → 18 decimals: × 10^12 / 3,500)
const usdcToEth = (amount: bigint) => (amount * 10n ** 12n) / 3_500n;
const engineWith = (adapters: ProviderAdapter[]) =>
  new PrivateSwapEngine({
    adapters,
    factory: "0x0000000000000000000000000000000000000001",
    escrowCreationCode: "0x00",
    chainId: 1n,
    refundVaults: { native: "0x0000000000000000000000000000000000000002", [USDC.asset]: "0x0000000000000000000000000000000000000003" },
    refundWindowSeconds: 7200,
    valuer: NO_VALUER,
    tips: gasTips(fees, valuer),
  });
const protectedReq = (from: AssetRef, to: AssetRef, amount: bigint): QuoteRequest => ({
  from,
  to,
  amount,
  destination: "",
  slippageBps: 50,
  destinationType: "protected",
});

describe("same-chain swaps into the protected balance", () => {
  it("only providers that quote a same-chain swap are asked; every quote and the set carry the shield tip in the output asset", async () => {
    const thor = new Stub("thorchain", true, usdcToEth);
    const lifi = new Stub("lifi", false, usdcToEth);
    const set = await engineWith([thor, lifi]).quoteAll(protectedReq(USDC, ETH, 8_000n * 10n ** 6n), "balanced");
    expect(thor.asked).toHaveLength(1);
    expect(lifi.asked, "LI.FI's same-chain route is a follow-up").toHaveLength(0);
    const tip = tipWei(GAS_UNITS.shieldETH, FEES);
    expect(set.shieldTip).toBe(tip);
    expect(set.quotes.map((q) => q.shieldTip)).toEqual([tip]);
    expect(set.chosen?.provider).toBe("thorchain");
    expect(shieldUnits(ETH)).toBe(GAS_UNITS.shieldETH);
  });

  it("a token output's tip is the same gas at the agreed prices, in the token", async () => {
    const thor = new Stub("thorchain", true, (a) => (a * 3_500n) / 10n ** 12n);
    const set = await engineWith([thor]).quoteAll(protectedReq(ETH, USDC, 3n * 10n ** 18n), "balanced");
    const wei = tipWei(GAS_UNITS.shieldERC20, FEES);
    expect(set.shieldTip).toBe((wei * 3_500n * 10n ** 6n + 10n ** 18n - 1n) / 10n ** 18n);
    await expect(shieldTip(USDC, { fees, valuer: NO_VALUER })).rejects.toMatchObject({ code: "tip_unpriced" });
  });

  it("a minimum that cannot pay the tip a hundred times over is filtered, never chosen", async () => {
    const thor = new Stub("thorchain", true, () => 10n ** 15n); // 0.001 ETH out: far below a hundred tips
    const set = await engineWith([thor]).quoteAll(protectedReq(USDC, ETH, 8_000n * 10n ** 6n), "balanced");
    expect(set.chosen).toBeUndefined();
    expect(set.scores.find((s) => s.provider === "thorchain")?.filtered).toMatch(/cannot pay the shield's gas/);
  });

  it("another chain, or an asset without a canonical vault, cannot be received into the protected balance", async () => {
    const thor = new Stub("thorchain", true, usdcToEth);
    await expect(engineWith([thor]).quoteAll(protectedReq(USDC, BTC, 8_000n * 10n ** 6n), "balanced")).rejects.toBeInstanceOf(ProtectedDestinationError);
    await expect(engineWith([thor]).quoteAll(protectedReq(USDC, USDT, 8_000n * 10n ** 6n), "balanced")).rejects.toMatchObject({
      code: "destination_not_protectable",
    });
    expect(thor.asked).toHaveLength(0);
  });

  it("an external destination carries no shield tip", async () => {
    const thor = new Stub("thorchain", true, usdcToEth);
    const set = await engineWith([thor]).quoteAll({ ...protectedReq(USDC, ETH, 8_000n * 10n ** 6n), destinationType: undefined }, "balanced");
    expect(set.shieldTip).toBeUndefined();
    expect(set.quotes[0].shieldTip).toBeUndefined();
  });
});
