// The executor tip (Privacy Wallet Web spec v2.0 §3): the execution's gas — ⌈units × (2·baseFee + priorityFee) × 1.2⌉
// from eth_feeHistory, never a percentage and never a fixed gas price — in the order's asset (wei; a token through the
// agreed Chainlink prices, tip_unpriced without them), refused above the escrow's 1 % cap (amount_too_small); the
// fee history read from every endpoint, the higher answer kept; the engine quotes net of the tip, stamps it on every
// quote and commits exactly that tip, and prepares against the committed one even after the gas moves.
import { describe, expect, it } from "vitest";
import { GAS_UNITS } from "@privacy-wallet/contracts";
import type { Prices } from "@privacy-wallet/protocol/wallet/valuation";
import { AssetMismatchError, PrivateSwapEngine } from "../src/engine";
import { NO_VALUER, type Valuer } from "../src/valuation";
import {
  ERC20_ORDER_UNITS,
  PROVIDER_CALL_UNITS,
  RpcFeeSource,
  TipError,
  executionUnits,
  executorTip,
  gasTips,
  tipInAsset,
  tipWei,
  type FeeSource,
  type GasFees,
} from "../src/tips";
import type { AssetRef, Capabilities, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../src/types";

const GWEI = 10n ** 9n;
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const fees = (base: bigint, prio: bigint): FeeSource => ({ fees: async () => ({ baseFeePerGas: base * GWEI, priorityFeePerGas: prio * GWEI }) });
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
const valuer = (feeds: Prices["feeds"]): Valuer => ({ prices: async () => ({ chainId: 1, at: 0, feeds }) });

describe("the tip's units and formula", () => {
  it("units: forge's measured deployAndExecute plus the provider's own call, and an ERC-20 order's approval and transfers", () => {
    expect(executionUnits(ETH)).toBe(GAS_UNITS.escrowExecuteETH + PROVIDER_CALL_UNITS);
    expect(executionUnits(USDC)).toBe(GAS_UNITS.escrowExecuteETH + PROVIDER_CALL_UNITS + ERC20_ORDER_UNITS);
  });
  it("⌈units × (2·baseFee + priorityFee) × 1.2⌉ wei", () => {
    const f: GasFees = { baseFeePerGas: 10n * GWEI, priorityFeePerGas: GWEI };
    expect(tipWei(1_000_000n, f)).toBe(25_200_000n * GWEI); // 1M × 21 gwei × 1.2
    expect(tipWei(1n, { baseFeePerGas: 1n, priorityFeePerGas: 0n })).toBe(3n); // 2 × 1.2 = 2.4 → 3
  });
});

describe("the tip in the order's asset", () => {
  it("ETH: wei; a 10 ETH order at 10 gwei pays the gas (about 0.052 ETH), never a percentage of it", async () => {
    const tip = await executorTip(ETH, 10n * 10n ** 18n, { fees: fees(10n, 1n) });
    expect(tip).toBe(tipWei(executionUnits(ETH), { baseFeePerGas: 10n * GWEI, priorityFeePerGas: GWEI }));
    expect(await executorTip(ETH, 100n * 10n ** 18n, { fees: fees(10n, 1n) }), "ten times the order, the same gas").toBe(tip);
  });
  it("an ERC-20: the same gas at the agreed ETH and USDC prices, rounded up", async () => {
    const wei = tipWei(executionUnits(USDC), { baseFeePerGas: 10n * GWEI, priorityFeePerGas: GWEI });
    const v = valuer({ ETH: price("ETH", 4_000n), USDC: price("USDC", 1n) });
    const tip = await executorTip(USDC, 100_000n * 10n ** 6n, { fees: fees(10n, 1n), valuer: v });
    expect(tip).toBe((wei * 4_000n * 10n ** 6n + 10n ** 18n - 1n) / 10n ** 18n);
    expect(
      tipInAsset(10n ** 18n, USDC, { chainId: 1, at: 0, feeds: { ETH: price("ETH", 4_000n), USDC: price("USDC", 1n) } }),
      "1 ETH of gas is 4,000 USDC",
    ).toBe(4_000n * 10n ** 6n);
  });
  it("an ERC-20 without agreed prices: tip_unpriced, never a guess", async () => {
    await expect(executorTip(USDC, 100_000n * 10n ** 6n, { fees: fees(10n, 1n), valuer: NO_VALUER })).rejects.toMatchObject({ code: "tip_unpriced" });
    await expect(
      executorTip(USDC, 100_000n * 10n ** 6n, {
        fees: fees(10n, 1n),
        valuer: valuer({ ETH: price("ETH", 4_000n), USDC: { unavailable: true, reason: "stale" } }),
      }),
    ).rejects.toBeInstanceOf(TipError);
  });
  it("more than the escrow's 1 % cap: amount_too_small; no fee history: fee_history_unavailable", async () => {
    const tip = await executorTip(ETH, 10n ** 20n, { fees: fees(10n, 1n) });
    await expect(executorTip(ETH, tip * 100n - 1n, { fees: fees(10n, 1n) })).rejects.toMatchObject({ code: "amount_too_small" });
    await expect(executorTip(ETH, tip * 100n, { fees: fees(10n, 1n) })).resolves.toBe(tip);
    await expect(
      executorTip(ETH, 10n ** 20n, {
        fees: {
          fees: async () => {
            throw new Error("all endpoints down");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "fee_history_unavailable" });
  });
});

describe("the fee history (RpcFeeSource)", () => {
  const history = (base: string[], rewards: string[]) => ({
    jsonrpc: "2.0",
    id: 1,
    result: { oldestBlock: "0x1", baseFeePerGas: base, reward: rewards.map((r) => [r]) },
  });
  const mockFetch = (answers: Record<string, unknown>, calls: string[]): typeof fetch =>
    (async (url: string) => {
      calls.push(String(url));
      const a = answers[String(url)];
      if (a instanceof Error) throw a;
      return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  it("the next block's base fee and the median priority fee, the higher endpoint kept, a failing endpoint tolerated, cached", async () => {
    const calls: string[] = [];
    const source = new RpcFeeSource(
      ["https://a", "https://b", "https://c"],
      mockFetch(
        {
          "https://a": history(["0x1", "0x2", "0x3", "0x4", "0x5", "0x3b9aca00"], ["0x1", "0x5", "0x3"]), // next base 1 gwei, median priority 3
          "https://b": history(["0x1", "0x77359400"], ["0x2"]), // next base 2 gwei
          "https://c": new Error("timeout"),
        },
        calls,
      ),
    );
    expect(await source.fees()).toEqual({ baseFeePerGas: 2n * GWEI, priorityFeePerGas: 3n });
    expect(await source.fees(), "cached").toEqual({ baseFeePerGas: 2n * GWEI, priorityFeePerGas: 3n });
    expect(calls).toHaveLength(3);
  });
  it("every endpoint failing fails", async () => {
    const source = new RpcFeeSource(["https://a"], mockFetch({ "https://a": { jsonrpc: "2.0", id: 1, error: { message: "method not found" } } }, []));
    await expect(source.fees()).rejects.toThrow(/method not found/);
  });
  it("an endpoint's error names its host, never its path, where a key lives (2026-10-15)", async () => {
    const url = "https://eth-mainnet.g.alchemy.com/v2/SECRET-KEY-123";
    const source = new RpcFeeSource([url], mockFetch({ [url]: { jsonrpc: "2.0", id: 1, error: { message: "rate limited" } } }, []));
    const e = (await source.fees().catch((x: Error) => x)) as Error;
    expect(e.message).toContain("eth-mainnet.g.alchemy.com: rate limited");
    expect(e.message).not.toContain("SECRET-KEY-123");
  });
});

/** A provider that quotes 1:30 of what it is asked to swap and remembers the amounts. */
class Stub implements ProviderAdapter {
  readonly id = "thorchain" as const;
  readonly implemented = true;
  asked: bigint[] = [];
  capabilities(): Capabilities {
    return {
      routes: ["A"],
      ingress: ["contract-call"],
      nativeAssets: true,
      atomic: false,
      chains: ["ethereum", "bitcoin"],
      destinationLinkPublic: true,
      linkEvidence: "a stub provider for the tip's tests, publishing every deposit",
    } as Capabilities;
  }
  async quote(req: QuoteRequest): Promise<Quote> {
    this.asked.push(req.amount);
    return {
      provider: this.id,
      category: "A",
      toAmount: req.amount / 30n + 100n,
      toAmountMin: req.amount / 30n,
      fees: [],
      etaSeconds: 600,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      obtainedAt: Math.floor(Date.now() / 1000),
      nativeAssets: true,
      minOutEncoded: true,
      hops: [],
      raw: {},
    } as Quote;
  }
  async prepareIngress(req: QuoteRequest): Promise<Ingress> {
    return {
      kind: "contract-call",
      to: "0x00000000000000000000000000000000000000ee",
      calldata: "0x",
      value: req.amount,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      minOutEncoded: true,
    };
  }
  async track(): Promise<TrackStatus> {
    return { state: "unknown" };
  }
  async health(): Promise<Health> {
    return { provider: this.id, reachable: true, apiLatencyMs: 10, halted: false, haltedChains: [], checkedAt: Date.now() };
  }
}

describe("an order is built only in the pool's asset, as the pool names it (a V6 follow-up of 2026-10-16)", () => {
  // its tip is the execution's gas valued in that asset, and the relayer takes it as its pay: USDC said to have no decimals
  // made a few dollars of gas a few millionths of a cent, on an order the service vouched for
  const USDC_VAULT = "0x00000000000000000000000000000000000ca5de";
  const engine = (poolAssets?: Record<string, { symbol: string; decimals: number }>) =>
    new PrivateSwapEngine({
      adapters: [],
      factory: "0x0000000000000000000000000000000000000001",
      escrowCreationCode: "0x00",
      chainId: 1n,
      refundVaults: { native: "0x0000000000000000000000000000000000000002", [USDC.asset]: USDC_VAULT },
      refundWindowSeconds: 7200,
      valuer: NO_VALUER,
      tips: { tipFor: async () => 1n },
      ...(poolAssets ? { poolAssets } : {}),
    });
  const POOL = { native: { symbol: "ETH", decimals: 18 }, [USDC.asset.toLowerCase()]: { symbol: "USDC", decimals: 6 } };
  const quote = {
    provider: "thorchain",
    category: "A",
    toAmount: 2n,
    toAmountMin: 1n,
    fees: [],
    etaSeconds: 600,
    expiresAt: 2_000_000_000,
    obtainedAt: 0,
    nativeAssets: true,
    minOutEncoded: true,
    hops: [],
    raw: {},
    executorTip: 1n,
  } as unknown as Quote;
  const keys = {
    orderSigner: "0x00000000000000000000000000000000000000a1",
    refundOwnerCommitment: 1n,
    refundNoteSecret: 2n,
    refundNoteDataHash: ("0x" + "11".repeat(32)) as `0x${string}`,
  };
  const order = (e: PrivateSwapEngine, from: AssetRef, over: Partial<QuoteRequest> = {}) =>
    e.buildOrder(
      { from, to: BTC, amount: 10n ** 9n, destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", slippageBps: 50, ...over },
      "balanced",
      quote,
      keys,
    );

  it("the pool's ETH and USDC as the pool names them pass", () => {
    expect(order(engine(POOL), ETH).params.assetType).toBe(0);
    expect(order(engine(POOL), USDC).params.asset).toBe(USDC.asset);
    expect(order(engine(POOL), { ...USDC, symbol: "usdc" }).params.asset, "a symbol in another case is the same symbol").toBe(USDC.asset);
  });
  it("refuses another decimals or symbol, a token the pool does not have, ETH in another unit", () => {
    for (const from of [
      { ...USDC, decimals: 0 },
      { ...USDC, decimals: 18 },
      { ...USDC, symbol: "WBTC" },
      { ...ETH, decimals: 6 },
      { ...USDC, asset: "0x00000000000000000000000000000000000000aa" },
    ]) {
      expect(() => order(engine(POOL), from), `${from.symbol} ${from.decimals} ${from.asset}`).toThrow(AssetMismatchError);
    }
    expect(() => order(engine(POOL), { ...USDC, decimals: 0 })).toThrow(/USDC with 6 decimals in this pool, not USDC with 0/);
  });
  it("a protected delivery too: its shield tip is valued in it", () => {
    const into = { chain: "ethereum", asset: USDC.asset, decimals: 6, symbol: "USDC" } as AssetRef;
    expect(() => order(engine(POOL), ETH, { to: into, destinationType: "protected" })).not.toThrow();
    expect(() => order(engine(POOL), ETH, { to: { ...into, decimals: 0 }, destinationType: "protected" })).toThrow(AssetMismatchError);
    expect(() => order(engine(POOL), ETH, { to: { ...BTC }, destinationType: "protected" }), "a protected delivery outside the pool").toThrow(
      AssetMismatchError,
    );
    expect(() => order(engine(POOL), ETH, { to: { ...into, decimals: 0 } }), "a delivery elsewhere is the caller's own").not.toThrow();
  });
  it("an engine without the pool's assets checks nothing (the tests' own engines)", () => {
    expect(() => order(engine(), { ...USDC, decimals: 0 })).not.toThrow();
  });
});

describe("the engine and the tip", () => {
  it("quotes net of the tip, stamps it on every quote and the set, commits exactly it, and prepares against the committed one", async () => {
    let base = 10n;
    const stub = new Stub();
    const engine = new PrivateSwapEngine({
      adapters: [stub],
      factory: "0x0000000000000000000000000000000000000001",
      escrowCreationCode: "0x00",
      chainId: 1n,
      refundVaults: { native: "0x0000000000000000000000000000000000000002" },
      refundWindowSeconds: 7200,
      valuer: NO_VALUER,
      tips: gasTips({ fees: async () => ({ baseFeePerGas: base * GWEI, priorityFeePerGas: GWEI }) }),
    });
    const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 19n, destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", slippageBps: 50 };
    const set = await engine.quoteAll(req, "balanced");
    const tip = tipWei(executionUnits(ETH), { baseFeePerGas: 10n * GWEI, priorityFeePerGas: GWEI });
    expect(set.executorTip).toBe(tip);
    expect(set.quotes[0].executorTip).toBe(tip);
    expect(stub.asked.at(-1), "the provider is asked for the amount net of the tip").toBe(req.amount - tip);
    const order = engine.buildOrder(req, set.policy, set.quotes[0], {
      orderSigner: "0x00000000000000000000000000000000000000a1",
      refundOwnerCommitment: 1n,
      refundNoteSecret: 2n,
      refundNoteDataHash: ("0x" + "11".repeat(32)) as `0x${string}`,
    });
    expect(order.params.executorTip).toBe(tip);
    expect(order.params.amount, "the escrow holds the gross; the tip comes out of it").toBe(req.amount);
    base = 50n; // the gas moves between the commit and the hand-over
    await engine.prepareExecution(order, stub);
    expect(stub.asked.at(-1), "prepared against the committed tip, not a new one").toBe(req.amount - tip);
    expect(() =>
      engine.buildOrder(
        req,
        set.policy,
        { ...set.quotes[0], executorTip: undefined },
        {
          orderSigner: "0x00000000000000000000000000000000000000a1",
          refundOwnerCommitment: 1n,
          refundNoteSecret: 2n,
          refundNoteDataHash: ("0x" + "11".repeat(32)) as `0x${string}`,
        },
      ),
    ).toThrow(/names no executor tip/);
  });
  it("an order whose execution would cost more than 1 % of it is refused at the quote", async () => {
    const engine = new PrivateSwapEngine({
      adapters: [new Stub()],
      factory: "0x0000000000000000000000000000000000000001",
      escrowCreationCode: "0x00",
      chainId: 1n,
      refundVaults: { native: "0x0000000000000000000000000000000000000002" },
      refundWindowSeconds: 7200,
      valuer: NO_VALUER,
      tips: gasTips(fees(10n, 1n)),
    });
    await expect(
      engine.quoteAll({ from: ETH, to: BTC, amount: 10n ** 16n, destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", slippageBps: 50 }, "balanced"),
    ).rejects.toMatchObject({ code: "amount_too_small" });
  });
});
