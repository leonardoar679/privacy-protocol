// The eleventh review round (2026-11-04), slice 1 after its diff critique: what the three critics found no test pinned. The inner Swift and
// Fast-MCTP orders' fee bases (D11-2), a stream's limit (D11-1), LI.FI's Across V4 exclusivity (D11-10), the reviewed route's honest paths and an
// honest route that keeps its refund target when it is prepared again (D11-4), a missing price as "could not check" (D11-7), and the engine's
// LI.FI check reading the order inside as the wallet does. The critics' probes (scratchpad review11/K1, K2) became these cases.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, padHex, parseAbi, type Address, type Hex } from "viem";
import { applyConfig, testConfig } from "../src/config";
import { PINNED, ProviderCallMismatch, ProviderCallUnverified, bytes32Of, checkProviderCall, middleFloorUsdc, thorAsset, thornodeActiveVault, type CallExpectation, type InboundLookup } from "@privacy-wallet/sdk/providerCall";
import { checkBeforeSigning, type JournaledOrder } from "@privacy-wallet/sdk/swapSign";
import { executionDigest, predictEscrow } from "@privacy-wallet/sdk/swapGuard";
import { deriveOrderKey, deriveRefundNote } from "@privacy-wallet/sdk/keys/swapKeys";
import type { Prepared, ServiceOrder, ServiceOrderParams } from "@privacy-wallet/sdk/swapService";
import { encodeDepositWithExpiry } from "@privacy-wallet/swap-engine/adapters/thorchain";
import { WETH as ENGINE_WETH, encodeDepositV3 } from "@privacy-wallet/swap-engine/adapters/across";
import { MayanAdapter, MAYAN_FAST_MCTP, MAYAN_SWIFT_V2, addressHex32, encodeCreateOrder, encodeSwiftCreateOrder, type SwiftOrder } from "@privacy-wallet/swap-engine/adapters/mayan";
import { LifiAdapter, verifyLifiTransaction } from "@privacy-wallet/swap-engine/adapters/lifi";
import { defaultEngine } from "@privacy-wallet/swap-engine/config";
import { RefundRouteUnavailable } from "@privacy-wallet/swap-engine/types";
import { ProviderFailure } from "@privacy-wallet/swap-engine/engine";
import { encodeCall } from "@privacy-wallet/swap-engine/abi";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ESCROW = getAddress("0x2b8dc27605bf11214247ae11a013fcadf2c1cb65");
const ATTACKER = getAddress("0x000000000000000000000000000000000000bad1");
const VAULT = getAddress("0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const ROUTER = getAddress("0x0000000000000000000000000000000000000e77");
const DEX = getAddress("0x1111111254eeb25477b68fb85ed929f73a960582");
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const USDC_VAULT = getAddress("0x00000000000000000000000000000000000000e8");
const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC_REF = { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" };
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const SOL = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
const ETH_BASE = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const DEST_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const DEST_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const DEST_EVM = getAddress("0x1111111111111111111111111111111111111111");
const NET = 10n ** 18n;
const NOW = 1_790_000_000;
const USD = { ETH: 2_540_00000000n };
const POOL_USDC = [{ token: USDC, symbol: "USDC", decimals: 6 }];
const NON_EVM = "0x11f111f111f111f111f111f111f111f111f111f1";
const seed = new TextEncoder().encode("review11-route-switch-seed-32-b!");

beforeAll(() => applyConfig(testConfig()));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const STRUCTS = [
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
  "struct MayanData { bytes32 nonEVMReceiver; address mayanProtocol; bytes protocolData; address swapProtocol; bytes swapData; address middleToken; uint256 minMiddleAmount; address refundRecipient; uint256 mayanAmountIn; }",
  "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
] as const;
const ABI = parseAbi([
  ...STRUCTS,
  "function startBridgeTokensViaMayan(BridgeData _bridgeData, MayanData _mayanData) payable",
  "function swapAndStartBridgeTokensViaMayan(BridgeData _bridgeData, SwapData[] _swapData, MayanData _mayanData) payable",
  "function startBridgeTokensViaAcrossV4(BridgeData _bridgeData, AcrossV4Data _acrossData) payable",
]);
const MIN = 2_189_073_633n;
const so = (o: Partial<SwiftOrder> = {}): SwiftOrder => ({
  payloadType: 1, trader: addressHex32("ethereum", ESCROW), destAddr: addressHex32("solana", DEST_SOL), destChainId: 1, referrerAddr: Buffer.alloc(32), tokenOut: Buffer.alloc(32),
  minAmountOut: MIN, gasDrop: 0n, cancelFee: 53n, refundFee: 10_651n, deadline: BigInt(NOW + 1500), referrerBps: 0, auctionMode: 2, random: Buffer.alloc(32, 7), ...o,
});
const bd = (o: Record<string, unknown> = {}) => ({ transactionId: padHex("0x01", { size: 32 }), bridge: "mayan", integrator: "lifi-api", referrer: ZERO, sendingAssetId: ZERO, receiver: NON_EVM, minAmount: NET, destinationChainId: 1151111081099710n, hasSourceSwaps: false, hasDestinationCall: false, ...o });
const md = (o: Record<string, unknown> = {}) => ({ nonEVMReceiver: bytes32Of("solana", DEST_SOL), mayanProtocol: PINNED.mayanSwiftV2, protocolData: encodeSwiftCreateOrder(ZERO, NET, so()) as Hex, swapProtocol: ZERO, swapData: "0x" as Hex, middleToken: ZERO, minMiddleAmount: 0n, refundRecipient: ESCROW, mayanAmountIn: NET, ...o });
const via = (b: ReturnType<typeof bd>, m: ReturnType<typeof md>, value: bigint) => ({ provider: PINNED.lifiDiamond, value, calldata: encodeFunctionData({ abi: ABI, functionName: "startBridgeTokensViaMayan", args: [b as never, m as never] }) });
const eEth = (o: Partial<CallExpectation> = {}): CallExpectation => ({ escrow: ESCROW, from: ETH as never, to: SOL as never, destination: DEST_SOL, net: NET, policy: "best-privacy", now: NOW, usd: USD, pooled: POOL_USDC, ...o });
const fastOrder = (net: bigint, redeemFee: bigint, refundFee: bigint, deadline = BigInt(NOW + 1800)) =>
  encodeCreateOrder(USDC, net, 0n, 5, 1000, { destAddr: addressHex32("solana", DEST_SOL), tokenOut: Buffer.alloc(32), amountOutMin: MIN, gasDrop: 0n, redeemFee, refundFee, deadline, referrerAddr: Buffer.alloc(32), referrerBps: 0 }) as Hex;

// an order the wallet journaled, with its escrow and a prepared call for it
function journaledOrder(o: { asset: Address; amount: bigint; tip: bigint; provider: string; refundTarget?: "escrow" | "destination"; approvedMin: bigint; from: object; to: object; destination: string; now: number }) {
  const key = deriveOrderKey(seed, ("0x" + "ab".repeat(32)) as Hex);
  const refund = deriveRefundNote(seed, 5);
  const params: ServiceOrderParams = {
    orderId: ("0x" + "11".repeat(32)) as Hex, assetType: o.asset === ZERO ? 0 : 1, asset: o.asset, amount: o.amount.toString(), orderSigner: key.address as Address,
    executeDeadline: o.now + 3000, refundAfter: o.now + 3000 + 7200, refundVault: o.asset === ZERO ? ETH_VAULT : USDC_VAULT, refundOwnerCommitment: refund.ownerCommitment.toString(), refundNoteSecret: refund.noteSecret.toString(),
    refundNoteDataHash: refund.noteDataHash, executorTip: o.tip.toString(),
  } as ServiceOrderParams;
  const escrow = predictEscrow(FACTORY, params);
  const order = { orderId: params.orderId, endpoint: escrow, state: "COMMITTED", quote: { provider: o.provider }, params } as unknown as ServiceOrder;
  const journaled = {
    request: { from: o.from, to: o.to, destination: o.destination }, params, policy: "best-privacy", approvedMin: o.approvedMin.toString(), provider: o.provider,
    quote: { provider: o.provider, toAmountMin: o.approvedMin.toString(), ...(o.refundTarget ? { refundTarget: o.refundTarget } : {}) },
  } as unknown as JournaledOrder;
  const prepare = (provider: Address, value: bigint, calldata: Hex): Prepared => {
    const deadline = o.now + 900;
    return { digest: executionDigest(1n, escrow, params.orderId, provider, value, calldata, deadline), provider, value: value.toString(), calldata, deadline };
  };
  return { escrow, order, journaled, prepare };
}

describe("D11-2: the inner orders' fee bases (the tests critic's G1–G3)", () => {
  it("ETH bridged into a Swift order without a leg: refused before its fees are weighed — the facet would forward the ETH to an entry that takes none (the twelfth review round, YA's critique: the honest one had been signed for a call that reverts; the 8-decimal fee base is pinned on WETH bridged after LI.FI's swap, in review12-lifi-mayan)", async () => {
    const greedy = md({ protocolData: encodeSwiftCreateOrder(ZERO, NET, so({ cancelFee: 49_500_000n, refundFee: 49_500_000n })) as Hex });
    await expect(checkProviderCall(via(bd(), greedy, NET), eEth())).rejects.toThrow(/an ETH order is neither wrapped nor swapped first/);
    await expect(checkProviderCall(via(bd(), md(), NET), eEth())).rejects.toThrow(/an ETH order is neither wrapped nor swapped first/);
  });
  it("a swap and lock leg, the leg's USDC floor its base: fees of 98 % of the leg are refused", async () => {
    const floor = middleFloorUsdc(NET, USD.ETH);
    const greedy = md({ swapProtocol: ROUTER, swapData: "0x1234" as Hex, middleToken: USDC, minMiddleAmount: floor, mayanAmountIn: NET, protocolData: encodeSwiftCreateOrder(USDC, floor, so({ cancelFee: (floor * 49n) / 100n, refundFee: (floor * 49n) / 100n })) as Hex });
    await expect(checkProviderCall(via(bd(), greedy, NET), eEth())).rejects.toThrow(/fees/);
  });
  it("a small Fast-MCTP order inside LI.FI keeps the direct decoder's 2 USDC floor: 1.6 USDC of fees on 150 USDC passes", async () => {
    const NET_USDC = 150_000_000n;
    const eUsdc: CallExpectation = { escrow: ESCROW, from: USDC_REF as never, to: SOL as never, destination: DEST_SOL, net: NET_USDC, policy: "best-privacy", now: NOW };
    const c = via(bd({ sendingAssetId: USDC, minAmount: NET_USDC }), md({ mayanProtocol: PINNED.mayanFastMctp, protocolData: fastOrder(NET_USDC, 1_200_000n, 400_000n), mayanAmountIn: NET_USDC }), 0n);
    expect((await checkProviderCall(c, eUsdc)).refundTo).toBe("destination");
  });
});

describe("D11-1: a stream's limit (G4)", () => {
  it("a stream whose limit has 81 digits (past 256 bits: THORNode cannot parse it and refunds the relayer) is refused", async () => {
    const inbound: InboundLookup = async () => ({ address: VAULT, router: PINNED.thorchainRouter, halted: false, agreeing: ["a", "b", "c"] });
    const e: CallExpectation = { escrow: ESCROW, from: ETH as never, to: BTC as never, destination: DEST_BTC, net: NET, policy: "best-privacy", now: NOW };
    const memo = "=:" + thorAsset(BTC as never) + ":" + DEST_BTC + "/" + ESCROW + ":" + "9".repeat(81) + "/3/12";
    const call = { provider: PINNED.thorchainRouter, value: NET, calldata: encodeDepositWithExpiry(VAULT, ZERO, NET, memo, BigInt(NOW + 600)) as Hex };
    await expect(checkProviderCall(call, e, { inbound })).rejects.toThrow(/not in the canonical decimal form/);
  });
});

describe("D11-10: LI.FI's Across V4 facet (G5)", () => {
  it("an exclusive relayer until the fill deadline is refused inside LI.FI too; none passes", async () => {
    const OUT = 990_000_000_000_000_000n;
    const across = (relayer: Address, parameter: number) => ({
      provider: PINNED.lifiDiamond,
      value: NET,
      calldata: encodeFunctionData({
        abi: ABI,
        functionName: "startBridgeTokensViaAcrossV4",
        args: [
          bd({ bridge: "across", receiver: DEST_EVM, destinationChainId: 8453n }) as never,
          { receiverAddress: bytes32Of("base", DEST_EVM), refundAddress: bytes32Of("ethereum", ESCROW), sendingAssetId: bytes32Of("ethereum", ENGINE_WETH.ethereum as Address), receivingAssetId: bytes32Of("base", ENGINE_WETH.base as Address), outputAmount: OUT, outputAmountMultiplier: 10n ** 18n, exclusiveRelayer: relayer === ZERO ? padHex("0x", { size: 32 }) : bytes32Of("base", relayer), quoteTimestamp: NOW - 10, fillDeadline: NOW + 6 * 3600, exclusivityParameter: parameter, message: "0x" } as never,
        ],
      }),
    });
    const e: CallExpectation = { escrow: ESCROW, from: ETH as never, to: ETH_BASE as never, destination: DEST_EVM, net: NET, policy: "best-privacy", now: NOW, pooled: [] };
    expect((await checkProviderCall(across(ZERO, 0), e)).minOut).toBe(OUT);
    await expect(checkProviderCall(across(ATTACKER, NOW + 6 * 3600), e)).rejects.toThrow(/only one relayer/);
  });
});

describe("D11-4: the reviewed route's honest paths (G6)", () => {
  it("an order committed on uniswap-across — the Across adapters' id — signs its SpokePool call", async () => {
    const now = Math.floor(Date.now() / 1000);
    const AMOUNT = 10n ** 18n, TIP = AMOUNT / 400n, OUT = 990_000_000_000_000_000n;
    const o = journaledOrder({ asset: ZERO, amount: AMOUNT, tip: TIP, provider: "uniswap-across", refundTarget: "escrow", approvedMin: OUT, from: ETH, to: ETH_BASE, destination: DEST_EVM, now });
    const calldata = encodeDepositV3({ depositor: o.escrow, recipient: DEST_EVM, inputToken: ENGINE_WETH.ethereum, outputToken: ENGINE_WETH.base, inputAmount: AMOUNT - TIP, outputAmount: OUT, destinationChainId: 8453, exclusiveRelayer: ZERO, quoteTimestamp: now - 10, fillDeadline: now + 6 * 3600, exclusivityDeadline: 0 }) as Hex;
    const g = await checkBeforeSigning({ prepared: o.prepare(PINNED.acrossSpokePool, AMOUNT - TIP, calldata), order: o.order, journaled: o.journaled, factory: FACTORY, chainId: 1n });
    expect(g.ok && g.call.provider).toBe("across");
  });
  it("an order committed on lifi whose quote said Fast-MCTP signs its destination-refunding facet call; one whose quote said escrow does not", async () => {
    const now = Math.floor(Date.now() / 1000);
    const AMOUNT = 150_002_000n, TIP = 2_000n, NET_USDC = AMOUNT - TIP;
    const call = (escrow: Address) =>
      encodeFunctionData({ abi: ABI, functionName: "startBridgeTokensViaMayan", args: [bd({ sendingAssetId: USDC, minAmount: NET_USDC }) as never, md({ mayanProtocol: PINNED.mayanFastMctp, protocolData: fastOrder(NET_USDC, 1_200_000n, 400_000n, BigInt(now + 1800)), mayanAmountIn: NET_USDC, refundRecipient: escrow }) as never] });
    const fast = journaledOrder({ asset: USDC, amount: AMOUNT, tip: TIP, provider: "lifi", refundTarget: "destination", approvedMin: 1n, from: USDC_REF, to: SOL, destination: DEST_SOL, now });
    const g = await checkBeforeSigning({ prepared: fast.prepare(PINNED.lifiDiamond, 0n, call(fast.escrow)), order: fast.order, journaled: fast.journaled, factory: FACTORY, chainId: 1n, pooled: POOL_USDC });
    expect(g.ok && g.call.provider).toBe("lifi");
    const swift = journaledOrder({ asset: USDC, amount: AMOUNT, tip: TIP, provider: "lifi", refundTarget: "escrow", approvedMin: 1n, from: USDC_REF, to: SOL, destination: DEST_SOL, now });
    await expect(checkBeforeSigning({ prepared: swift.prepare(PINNED.lifiDiamond, 0n, call(swift.escrow)), order: swift.order, journaled: swift.journaled, factory: FACTORY, chainId: 1n, pooled: POOL_USDC })).rejects.toThrow(/refund at your destination address/);
  });
  it("LI.FI's quote names the Fast-MCTP facet call's refund target: at the destination", async () => {
    const NET_USDC = 150_000_000n;
    const data = encodeFunctionData({ abi: ABI, functionName: "startBridgeTokensViaMayan", args: [bd({ sendingAssetId: USDC.toLowerCase(), minAmount: NET_USDC }) as never, md({ mayanProtocol: PINNED.mayanFastMctp, protocolData: fastOrder(NET_USDC, 1_200_000n, 400_000n, BigInt(Math.floor(Date.now() / 1000) + 1800)), mayanAmountIn: NET_USDC }) as never] });
    const a = new LifiAdapter();
    a.rawQuote = async () => ({ tool: "mayan", transactionRequest: { to: PINNED.lifiDiamond.toLowerCase(), data, value: "0x0", chainId: 1 }, action: { fromAddress: ESCROW, toAddress: DEST_SOL, fromChainId: 1, toChainId: 1151111081099710 }, estimate: { toAmount: "2190000000", toAmountMin: "2189073633", executionDuration: 30 } });
    const req = { from: USDC_REF, to: SOL, amount: NET_USDC, destination: DEST_SOL, source: ESCROW, slippageBps: 100 } as never;
    expect((await a.quote(req)).refundTarget).toBe("destination");
  });
});

describe("D11-4: an honest route keeps its refund target when it is prepared again (the correctness critic's K1 flip)", () => {
  const quotes = (now: number, swiftMin: number, fastMin: number, net: bigint) => {
    const common = { fromChain: "ethereum", toChain: "solana", fromToken: { contract: USDC.toLowerCase(), decimals: 6 }, toToken: { contract: ZERO, decimals: 9, wChainId: 1 }, effectiveAmountIn64: net.toString(), gasDrop: 0, slippageBps: 50, etaSeconds: 30 };
    return [
      { ...common, type: "SWIFT", swiftVersion: "V2", swiftMayanContract: MAYAN_SWIFT_V2, swiftInputContract: USDC.toLowerCase(), swiftWrapAndLock: false, swiftAuctionMode: 2, deadline64: String(now + 3600), cancelRelayerFee64: "1000000", refundRelayerFee64: "1000000", expectedAmountOut: swiftMin * 1.004, minAmountOut: swiftMin, redeemRelayerFee: 0 },
      { ...common, type: "FAST_MCTP", fastMctpMayanContract: MAYAN_FAST_MCTP, fastMctpInputContract: USDC.toLowerCase(), fastMctpMinFinality: 1000, deadline64: String(now + 1800), refundRelayerFee64: "500000", circleMaxFee64: "1000000", redeemRelayerFee: 0.5, expectedAmountOut: fastMin * 1.004, minAmountOut: fastMin },
    ];
  };
  const answering = (list: unknown[]) => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/quote?")) return new Response(JSON.stringify({ quotes: list }), { status: 200 });
      throw new TypeError(`unexpected fetch ${url}`);
    }) as typeof fetch;
  };
  it("Mayan offers only the committed type at a prepare: Swift where the order refunds the escrow, whichever guarantees more", async () => {
    const now = Math.floor(Date.now() / 1000);
    const net = 10_000_000_000n - 2_000_000n;
    const req = { from: USDC_REF, to: SOL, amount: net, destination: DEST_SOL, source: ESCROW, slippageBps: 50 } as never;
    const mayan = new MayanAdapter({ orderTypes: ["FAST_MCTP", "SWIFT"] });
    answering(quotes(now, 60.4, 60.5, net));
    expect((await mayan.quote(req)).refundTarget, "no committed target: the higher minimum").toBe("destination");
    expect((await mayan.quote({ ...(req as object), refundTarget: "escrow" } as never)).refundTarget).toBe("escrow");
    answering(quotes(now, 60.4, 60.5, net).filter((q) => q.type === "FAST_MCTP"));
    // Mayan's own refusal since the twelfth review round (ZB's critique): no quote of the asked type, while it quotes the other
    await expect(mayan.quote({ ...(req as object), refundTarget: "escrow" } as never), "only the other type offered: refused").rejects.toBeInstanceOf(RefundRouteUnavailable);
  });
  it("the engine's prepare asks for the committed target, and a route that now refunds elsewhere is the provider's failure — never a call to refuse after the funding (in words naming no escrow since the twelfth review round)", async () => {
    const engine = defaultEngine();
    const asked: unknown[] = [];
    const now = Math.floor(Date.now() / 1000);
    const adapter = {
      id: "mayan",
      quote: async (r: { refundTarget?: string }) => {
        asked.push(r.refundTarget);
        return { provider: "mayan", category: "B", toAmount: 1000n, toAmountMin: 990n, fees: [], etaSeconds: 30, expiresAt: now + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, refundTarget: "destination", raw: {}, obtainedAt: Date.now() };
      },
      prepareIngress: async () => {
        throw new Error("never reached");
      },
    };
    const order = { orderId: "0x" + "11".repeat(32), request: { from: USDC_REF, to: SOL, amount: 10_000_000_000n, destination: DEST_SOL, slippageBps: 50 }, params: { executorTip: 2_000_000n, executeDeadline: now + 3000 }, endpoint: ESCROW, policy: "balanced", quote: { provider: "mayan", refundTarget: "escrow" }, destination: { kind: "fresh" } };
    // an adapter answering its route of the moment whatever it is asked (LI.FI's facets): a failure, prepared again later — never Mayan's own refusal,
    // which a delayed funding's check stops on (ZC's critique: one such answer had stopped an order whose next answer was the committed route)
    const refused = engine.prepareExecution(order as never, adapter as never);
    await expect(refused).rejects.toBeInstanceOf(ProviderFailure);
    await expect(refused).rejects.not.toBeInstanceOf(RefundRouteUnavailable);
    await expect(refused).rejects.toThrow(/mayan's route now refunds a failure at the destination, not to the pool as the order was committed/);
    expect(asked).toEqual(["escrow"]);
  });
});

describe("D11-7: a check that could not be made is an outage (G7, the correctness critic's second point)", () => {
  it("a Mayan ETH leg with no agreed price (a feed outage: agreedUsd answers {}) cannot be checked yet — never a refusal that stops the order", async () => {
    const now = Math.floor(Date.now() / 1000);
    const AMOUNT = 10n ** 18n, TIP = AMOUNT / 400n, NET_ = AMOUNT - TIP, APPROVED = 15_000_000_000n;
    const o = journaledOrder({ asset: ZERO, amount: AMOUNT, tip: TIP, provider: "mayan", refundTarget: "destination", approvedMin: APPROVED, from: ETH, to: SOL, destination: DEST_SOL, now });
    const createOrder = encodeCreateOrder(USDC, NET_, 1_000_000n, 5, 1000, { destAddr: addressHex32("solana", DEST_SOL), tokenOut: Buffer.alloc(32), amountOutMin: APPROVED / 10n, gasDrop: 0n, redeemFee: 500_000n, refundFee: 500_000n, deadline: BigInt(now + 1800), referrerAddr: Buffer.alloc(32), referrerBps: 0 });
    const calldata = encodeCall("swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)", [
      { t: "uint", v: NET_ }, { t: "address", v: ROUTER }, { t: "bytes", v: "0x1234" }, { t: "address", v: USDC }, { t: "uint", v: middleFloorUsdc(NET_, USD.ETH) }, { t: "address", v: PINNED.mayanFastMctp }, { t: "bytes", v: createOrder },
    ]) as Hex;
    const prepared = o.prepare(PINNED.mayanForwarder, NET_, calldata);
    expect((await checkBeforeSigning({ prepared, order: o.order, journaled: o.journaled, factory: FACTORY, chainId: 1n, usd: USD })).ok, "with a price it passes").toBe(true);
    const err = await checkBeforeSigning({ prepared, order: o.order, journaled: o.journaled, factory: FACTORY, chainId: 1n, usd: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderCallUnverified);
    expect(String((err as Error).message)).toMatch(/no fresh agreed ETH price/);
  });
  it("one THORNode gateway behind a churn is no refusal: listed by some, the vault cannot be checked yet; listed by none, it is not THORChain's", async () => {
    const V = "0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb", W = "0x000000000000000000000000000000000000beef";
    const gateways = ["https://g1", "https://g2", "https://g3"];
    const asgard = (...a: string[]) => [{ status: "ActiveVault", addresses: a.map((address) => ({ chain: "ETH", address })) }];
    const from = (answers: Record<string, unknown>) => (async (url: string) => new Response(JSON.stringify(answers[new URL(url).origin]), { status: 200 })) as unknown as typeof fetch;
    const lag = from({ "https://g1": asgard(V, W), "https://g2": asgard(V, W), "https://g3": asgard(V) });
    await expect(thornodeActiveVault("ETH", W, { gateways, fetchFn: lag })).rejects.toBeInstanceOf(ProviderCallUnverified);
    await expect(thornodeActiveVault("ETH", "0x000000000000000000000000000000000000bad1", { gateways, fetchFn: lag })).rejects.toBeInstanceOf(ProviderCallMismatch);
  });
});

describe("the engine's LI.FI check reads the order inside as the wallet does (the tests critic's E1–E2)", () => {
  const req = { from: ETH, to: SOL, amount: NET, destination: DEST_SOL, source: ESCROW, slippageBps: 100 } as never;
  const quote = (data: Hex) => ({ tool: "mayan", transactionRequest: { to: PINNED.lifiDiamond.toLowerCase(), data, value: "0x" + NET.toString(16), chainId: 1 }, action: { fromAddress: ESCROW, toAddress: DEST_SOL, fromChainId: 1, toChainId: 1151111081099710 }, estimate: { toAmountMin: "1" } });
  const withUsdcVault = <T>(fn: () => T): T => {
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = `${USDC}:0x0000000000000000000000000000000000000a11`;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.ERC20_VAULTS;
      else process.env.ERC20_VAULTS = saved;
    }
  };
  it("a source swap into USDC bounded at one unit before the Mayan facet: refused with the service's price, as the wallet refuses it", () => {
    const data = encodeFunctionData({ abi: ABI, functionName: "swapAndStartBridgeTokensViaMayan", args: [bd({ sendingAssetId: USDC, minAmount: 1n, hasSourceSwaps: true }) as never, [{ callTo: DEX, approveTo: DEX, sendingAssetId: ZERO, receivingAssetId: USDC, fromAmount: NET, callData: "0x1234", requiresDeposit: true }] as never, md({ protocolData: encodeSwiftCreateOrder(USDC, 1n, so()) as Hex, mayanAmountIn: 1n }) as never] });
    withUsdcVault(() => expect(() => verifyLifiTransaction(req, quote(data), { ethUsd1e8: USD.ETH })).toThrow(/below/));
  });
  it("a swap & lock leg into a token the pool has no vault for, or with no floor, is not offered; with the price, a one-unit floor is refused", () => {
    const leg = (minMiddle: bigint) => encodeFunctionData({ abi: ABI, functionName: "startBridgeTokensViaMayan", args: [bd() as never, md({ swapProtocol: ROUTER, swapData: "0x1234", middleToken: USDC, minMiddleAmount: minMiddle, mayanAmountIn: NET, protocolData: encodeSwiftCreateOrder(USDC, minMiddle, so()) as Hex }) as never] });
    const saved = process.env.ERC20_VAULTS;
    delete process.env.ERC20_VAULTS;
    try {
      expect(() => verifyLifiTransaction(req, quote(leg(middleFloorUsdc(NET, USD.ETH))))).toThrow(/cannot re-shield/);
    } finally {
      if (saved !== undefined) process.env.ERC20_VAULTS = saved;
    }
    withUsdcVault(() => {
      expect(() => verifyLifiTransaction(req, quote(leg(0n)))).toThrow(/no floor/);
      expect(() => verifyLifiTransaction(req, quote(leg(1n)), { ethUsd1e8: USD.ETH })).toThrow(/below/);
      expect(verifyLifiTransaction(req, quote(leg(middleFloorUsdc(NET, USD.ETH))), { ethUsd1e8: USD.ETH }).verified).toContain("swap & lock refunds re-shieldable");
    });
  });
});
