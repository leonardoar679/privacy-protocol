// The eleventh review round (2026-11-04), part D — the provider adapters against the wallet's guard. THORNode reads a single swap's limit with
// Go's base-0 rule (a leading 0 is octal; a number it cannot parse invalidates the memo, refunded to the relayer): only the canonical decimal
// is signed, a stream's numbers too (D11-1). The Mayan order inside LI.FI is bounded as a direct one — its fees (D11-2), its ETH → USDC leg on what the facet forwards
// (D11-3), its swap & lock USDC named for the re-shield (D11-6). Chainflip's Option tags are 0 or 1 (D11-5); Across hands over no WETH where
// ETH was asked (D11-8) and names no long exclusivity (D11-10); THORChain's destination halt is read (D11-9); the route the user reviewed is
// the one signed (D11-4). The reviewer's probes (scratchpad review11/D) became these cases; honest calls are built with the engine's encoders.
import { beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeFunctionData, getAddress, hexToBytes, padHex, parseAbi, type Address, type Hex } from "viem";
import { applyConfig, testConfig } from "../src/config";
import { ACROSS_DESTINATION, PINNED, ProviderCallMismatch, ProviderCallUnverified, bytes32Of, checkProviderCall, decodeCfParameters, middleFloorUsdc, thorAsset, thornodeInbound, type CallExpectation, type InboundLookup } from "@privacy-wallet/sdk/providerCall";
import { checkGuestInstruction } from "@privacy-wallet/sdk/guestGuard";
import { checkBeforeSigning, type JournaledOrder } from "@privacy-wallet/sdk/swapSign";
import { executionDigest, predictEscrow } from "@privacy-wallet/sdk/swapGuard";
import { deriveOrderKey, deriveRefundNote } from "@privacy-wallet/sdk/keys/swapKeys";
import type { Prepared, ServiceOrder, ServiceOrderParams } from "@privacy-wallet/sdk/swapService";
import { buildMemo, encodeDepositWithExpiry } from "@privacy-wallet/swap-engine/adapters/thorchain";
import { decodeCfParameters as engineDecode } from "@privacy-wallet/swap-engine/adapters/chainflip";
import { SPOKE_POOL, WETH as ENGINE_WETH, encodeDepositV3 } from "@privacy-wallet/swap-engine/adapters/across";
import { acrossSwapPins, verifyAcrossSwapCall } from "@privacy-wallet/swap-engine/adapters/acrossSwap";
import { addressHex32, encodeCreateOrder, encodeSwiftCreateOrder, type SwiftOrder } from "@privacy-wallet/swap-engine/adapters/mayan";
import { lifiRefundTarget } from "@privacy-wallet/swap-engine/adapters/lifi";
import { encodeCall } from "@privacy-wallet/swap-engine/abi";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ESCROW = getAddress("0x2b8dc27605bf11214247ae11a013fcadf2c1cb65");
const ATTACKER = getAddress("0x000000000000000000000000000000000000bad1");
const VAULT = getAddress("0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const ROUTER = getAddress("0x0000000000000000000000000000000000000e77");
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

beforeAll(() => applyConfig(testConfig()));

// ------------------------------------------------------------------------------------------------ D11-1, D11-9: THORChain
describe("THORChain: a memo's numbers as THORNode reads them (D11-1)", () => {
  const inbound: InboundLookup = async () => ({ address: VAULT, router: PINNED.thorchainRouter, halted: false, agreeing: ["a", "b", "c"] });
  const e = (): CallExpectation => ({ escrow: ESCROW, from: ETH as never, to: BTC as never, destination: DEST_BTC, net: NET, policy: "best-privacy", now: NOW });
  const call = (memo: string) => ({ provider: PINNED.thorchainRouter, value: NET, calldata: encodeDepositWithExpiry(VAULT, ZERO, NET, memo, BigInt(NOW + 600)) as Hex });
  const memoWith = (limit: string) => `=:${thorAsset(BTC as never)}:${DEST_BTC}/${ESCROW}:${limit}`;

  it("a leading zero (octal to THORNode: 050000000 is 10,485,760 sats), a number it cannot parse, or a 31-digit limit is refused", async () => {
    for (const lim of ["050000000", "077777777", "09999999999", "1" + "0".repeat(30), "9".repeat(300)]) {
      await expect(checkProviderCall(call(memoWith(lim)), e(), { inbound }), lim.slice(0, 12)).rejects.toThrow(/not in the canonical decimal form/);
    }
    // a stream's numbers too, with their own words: THORNode reads them in base 10, and the wallet signs the canonical form only
    await expect(checkProviderCall(call(`${memoWith("77777777")}/0001/10`), e(), { inbound })).rejects.toThrow(/not plain decimals of at most 5 digits/);
    await expect(checkProviderCall(call(`${memoWith("77777777")}/1/010`), e(), { inbound })).rejects.toThrow(/not plain decimals of at most 5 digits/);
    await expect(checkProviderCall(call(`${memoWith("77777777")}/1/100000`), e(), { inbound })).rejects.toThrow(/not plain decimals of at most 5 digits/);
    await expect(checkProviderCall(call(`${memoWith("077777777")}/1/10`), e(), { inbound }), "a stream's limit").rejects.toThrow(/not in the canonical decimal form/);
  });

  it("the engine's canonical memo still passes, a single swap and a stream, and a limit of 0 reads as no minimum", async () => {
    const one = await checkProviderCall(call(buildMemo(thorAsset(BTC as never), DEST_BTC, 3_000_000n, ESCROW)), e(), { inbound });
    expect(one.minOut).toBe(3_000_000n);
    const stream = await checkProviderCall(call(`${memoWith("3000000")}/3/12`), e(), { inbound });
    expect(stream.minOut).toBe(3_000_000n);
    expect((await checkProviderCall(call(memoWith("0")), e(), { inbound })).minOut).toBe(0n);
  });

  it("the guest guard reads the limit the same way: a leading zero is refused", async () => {
    const ins = (limit: string) => ({ provider: "thorchain", ingress: { to: "bc1qvault000000000000000000000000000000000", memo: `=:ETH.ETH:${DEST_EVM}:${limit}`, amount: "100000000", expiresAt: NOW + 600 } });
    const g = { from: BTC as never, to: ETH as never, destination: DEST_EVM, amount: 100_000_000n, approvedMin: 10n ** 18n, now: NOW, inbound: async () => ({ address: "bc1qvault000000000000000000000000000000000", halted: false, agreeing: ["a", "b"] }) };
    await expect(checkGuestInstruction(ins("0777777777777") as never, g as never)).rejects.toThrow(/not written as THORNode reads it/);
    expect((await checkGuestInstruction(ins("777777777777") as never, g as never)).minOut).toBe(777777777777n * 10n ** 10n);
  });
});

describe("THORChain: the destination chain's halt (D11-9)", () => {
  it("a call into a halted or trading-paused destination is an outage, never signed; read from the same gateway answers as the source", async () => {
    const asked: string[] = [];
    const inbound = (btcHalted: boolean): InboundLookup => async (chain) => {
      asked.push(chain);
      return { address: VAULT, router: PINNED.thorchainRouter, halted: false, agreeing: ["a", "b", "c"], haltedChains: btcHalted ? ["BTC"] : [] };
    };
    const memo = buildMemo(thorAsset(BTC as never), DEST_BTC, 3_000_000n, ESCROW);
    const call = { provider: PINNED.thorchainRouter, value: NET, calldata: encodeDepositWithExpiry(VAULT, ZERO, NET, memo, BigInt(NOW + 600)) as Hex };
    const e: CallExpectation = { escrow: ESCROW, from: ETH as never, to: BTC as never, destination: DEST_BTC, net: NET, policy: "best-privacy", now: NOW };
    await expect(checkProviderCall(call, e, { inbound: inbound(true) })).rejects.toThrow(ProviderCallUnverified);
    expect(asked, "one round of the gateways, never one per chain").toEqual(["ETH"]);
    expect((await checkProviderCall(call, e, { inbound: inbound(false) })).provider).toBe("thorchain");
  });

  it("the gateways' lists name every halted chain: one gateway that reports BTC trading-paused is enough", async () => {
    const lists: Record<string, unknown[]> = {
      "https://a.test": [{ chain: "ETH", address: VAULT, router: PINNED.thorchainRouter, halted: false }, { chain: "BTC", address: "bc1qthorvault0000000000000000000000000000", halted: false }],
      "https://b.test": [{ chain: "ETH", address: VAULT, router: PINNED.thorchainRouter, halted: false }, { chain: "BTC", address: "bc1qthorvault0000000000000000000000000000", halted: false, chain_trading_paused: true }],
    };
    const fetchFn = (async (url: string) => new Response(JSON.stringify(lists[new URL(url).origin] ?? []))) as unknown as typeof fetch;
    const v = await thornodeInbound("ETH", { gateways: Object.keys(lists), quorum: 2, fetchFn });
    expect(v.halted).toBe(false);
    expect(v.haltedChains).toEqual(["BTC"]);
  });
});

// ------------------------------------------------------------------------------------------------ D11-5: Chainflip
describe("Chainflip: an Option tag other than 0 or 1 (D11-5)", () => {
  const cf = (oracleTag: number, dcaTag: number, ccmTag = 0): Uint8Array => {
    const out: number[] = [1];
    const u32 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    u32(150);
    out.push(...hexToBytes(ESCROW));
    const price = (3n << 128n) / 1000n;
    for (let k = 0; k < 32; k++) out.push(Number((price >> BigInt(8 * k)) & 0xffn));
    out.push(ccmTag, oracleTag);
    if (oracleTag === 1) out.push(0, 0);
    out.push(dcaTag);
    if (dcaTag === 1) out.push(2, 0, 0, 0, 1, 0, 0, 0);
    out.push(0, ...new Array(32).fill(7), 0, 0, 0);
    return new Uint8Array(out);
  };
  it("is refused by both decoders — Chainflip ignores such a vault swap: no swap, no refund — and 0 or 1 still read", () => {
    for (const [o, d] of [[2, 0], [0, 2], [255, 0]]) {
      expect(() => decodeCfParameters(cf(o, d)), `${o}/${d}`).toThrow(/not 0 or 1/);
      expect(() => engineDecode(Buffer.from(cf(o, d))), `${o}/${d}`).toThrow(/not 0 or 1/);
    }
    // the refund CCM's tag too (the tests critic): the engine had read it as "present" only at 1
    expect(() => decodeCfParameters(cf(0, 0, 2))).toThrow();
    expect(() => engineDecode(Buffer.from(cf(0, 0, 2)))).toThrow(/refund CCM option's tag is 2/);
    expect(decodeCfParameters(cf(0, 0))).toMatchObject({ refundAddress: ESCROW, dca: null });
    expect(decodeCfParameters(cf(1, 1)).dca).toEqual({ chunks: 2, interval: 1 });
    expect(engineDecode(Buffer.from(cf(1, 0))).maxOracleSlippage).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ D11-8, D11-10: Across
describe("Across: the native destination and the exclusivity (D11-8, D11-10)", () => {
  const OUT = 700_000_000_000_000_000n;
  const NET_USDC = 2_000_000_000n;
  const PERIPHERY_ABI = parseAbi([
    "struct Fees { uint256 amount; address recipient; }",
    "struct BaseDepositData { address inputToken; bytes32 outputToken; uint256 outputAmount; address depositor; bytes32 recipient; uint256 destinationChainId; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
    "struct SwapAndDepositData { Fees submissionFees; BaseDepositData depositData; address swapToken; address exchange; uint8 transferType; uint256 swapTokenAmount; uint256 minExpectedInputTokenAmount; bytes routerCalldata; bool enableProportionalAdjustment; address spokePool; uint256 nonce; }",
    "function swapAndBridge(SwapAndDepositData swapAndDepositData) payable",
  ]);
  const HANDLER_MESSAGE = [{ type: "tuple", components: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "callData", type: "bytes" }, { name: "value", type: "uint256" }] }, { name: "fallbackRecipient", type: "address" }] }] as const;
  const abi = parseAbi(["function drainLeftoverTokens(address token, address destination)", "function emitData(bytes data)", "function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)", "function withdraw(uint256 wad)"]);
  const HANDLER = ACROSS_DESTINATION.handler.base, EMITTER = ACROSS_DESTINATION.emitter.base;
  const WETH_B = ENGINE_WETH.base as Address;
  type Call = { target: Address; callData: Hex; value: bigint };
  const drain = (token: string): Call => ({ target: HANDLER, callData: encodeFunctionData({ abi, functionName: "drainLeftoverTokens", args: [token as Address, DEST_EVM] }), value: 0n });
  const emit = (): Call => ({ target: EMITTER, callData: encodeFunctionData({ abi, functionName: "emitData", args: ["0x1234"] }), value: 0n });
  const unwrap = (): Call => ({ target: HANDLER, value: 0n, callData: encodeFunctionData({ abi, functionName: "makeCallWithBalance", args: [WETH_B, encodeFunctionData({ abi, functionName: "withdraw", args: [0n] }), 0n, [{ token: WETH_B, offset: 4n }]] }) });
  const message = (calls: Call[]) => encodeAbiParameters(HANDLER_MESSAGE, [{ calls, fallbackRecipient: ZERO }]);
  const leg = (calls: Call[], dd: Record<string, unknown> = {}) => ({
    provider: PINNED.acrossPeriphery,
    value: 0n,
    calldata: encodeFunctionData({
      abi: PERIPHERY_ABI,
      functionName: "swapAndBridge",
      args: [
        {
          submissionFees: { amount: 0n, recipient: ZERO },
          depositData: { inputToken: ENGINE_WETH.ethereum as Address, outputToken: bytes32Of("base", WETH_B), outputAmount: OUT, depositor: ESCROW, recipient: bytes32Of("base", HANDLER), destinationChainId: 8453n, exclusiveRelayer: padHex("0x", { size: 32 }), quoteTimestamp: NOW - 10, fillDeadline: NOW + 7200, exclusivityParameter: 0, message: message(calls), ...dd },
          swapToken: USDC, exchange: PINNED.lifiDiamond, transferType: 0, swapTokenAmount: NET_USDC, minExpectedInputTokenAmount: OUT, routerCalldata: "0xabcd" as Hex, enableProportionalAdjustment: true, spokePool: PINNED.acrossSpokePool, nonce: 0n,
        } as never,
      ],
    }),
  });
  const en: CallExpectation = { escrow: ESCROW, from: USDC_REF as never, to: ETH_BASE as never, destination: DEST_EVM, net: NET_USDC, policy: "best-privacy", now: NOW, pooled: [] };
  const reqN = { from: USDC_REF, to: ETH_BASE, amount: NET_USDC, destination: DEST_EVM, source: ESCROW, slippageBps: 50 } as never;
  const service = (calldata: Hex) => {
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = "";
    try {
      return verifyAcrossSwapCall(reqN, { to: PINNED.acrossPeriphery, data: calldata, value: 0n } as never, acrossSwapPins(reqN, { spokePool: SPOKE_POOL, weth: ENGINE_WETH, chainId: { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10 } } as never));
    } finally {
      if (saved === undefined) delete process.env.ERC20_VAULTS;
      else process.env.ERC20_VAULTS = saved;
    }
  };

  it("a drain of the WETH before the unwrap — the fill handed over as WETH — is refused by both decoders; the honest unwrap then drain passes", async () => {
    const bent = leg([drain(WETH_B), unwrap(), drain(ZERO), emit()]);
    await expect(checkProviderCall(bent, en)).rejects.toThrow(/WETH/);
    expect(() => service(bent.calldata)).toThrow(/before unwrapping/);
    const honest = leg([unwrap(), drain(ZERO), emit()]);
    expect((await checkProviderCall(honest, en)).minOut).toBe(OUT);
    expect(service(honest.calldata).minOut).toBe(OUT);
  });

  it("an exclusive relayer for hours is refused — direct, the swap leg — and none, or one for a few minutes, passes", async () => {
    const direct = (relayer: Address, exclusivity: number) => ({
      provider: PINNED.acrossSpokePool,
      value: NET,
      calldata: encodeDepositV3({ depositor: ESCROW, recipient: DEST_EVM, inputToken: ENGINE_WETH.ethereum, outputToken: ENGINE_WETH.base, inputAmount: NET, outputAmount: OUT, destinationChainId: 8453, exclusiveRelayer: relayer, quoteTimestamp: NOW - 10, fillDeadline: NOW + 6 * 3600, exclusivityDeadline: exclusivity }) as Hex,
    });
    const eEth = { ...en, from: ETH as never, net: NET };
    await expect(checkProviderCall(direct(ATTACKER, NOW + 6 * 3600), eEth)).rejects.toThrow(/exclusivity|only one relayer/);
    await expect(checkProviderCall(direct(ATTACKER, 3600), eEth)).rejects.toThrow(/only one relayer/);
    expect((await checkProviderCall(direct(ZERO, 0), eEth)).minOut).toBe(OUT);
    expect((await checkProviderCall(direct(ATTACKER, 60), eEth)).minOut).toBe(OUT);
    expect((await checkProviderCall(direct(ATTACKER, NOW + 120), eEth)).minOut).toBe(OUT);
    const long = leg([unwrap(), drain(ZERO), emit()], { exclusiveRelayer: bytes32Of("base", ATTACKER), exclusivityParameter: NOW + 7200 });
    await expect(checkProviderCall(long, en)).rejects.toThrow(/only one relayer/);
  });
});

// ------------------------------------------------------------------------------------------------ D11-2, D11-3, D11-6: LI.FI → Mayan
describe("the Mayan order inside LI.FI, bounded as a direct one (D11-2, D11-3, D11-6)", () => {
  const STRUCTS = [
    "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
    "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
    "struct MayanData { bytes32 nonEVMReceiver; address mayanProtocol; bytes protocolData; address swapProtocol; bytes swapData; address middleToken; uint256 minMiddleAmount; address refundRecipient; uint256 mayanAmountIn; }",
  ] as const;
  const ABI = parseAbi([...STRUCTS, "function startBridgeTokensViaMayan(BridgeData _bridgeData, MayanData _mayanData) payable"]);
  const MIN = 2_189_073_633n; // 21.89 SOL in Swift's 8 decimals
  const so = (o: Partial<SwiftOrder> = {}): SwiftOrder => ({
    payloadType: 1, trader: addressHex32("ethereum", ESCROW), destAddr: addressHex32("solana", DEST_SOL), destChainId: 1, referrerAddr: Buffer.alloc(32), tokenOut: Buffer.alloc(32),
    minAmountOut: MIN, gasDrop: 0n, cancelFee: 53n, refundFee: 10_651n, deadline: BigInt(NOW + 1500), referrerBps: 0, auctionMode: 2, random: Buffer.alloc(32, 7), ...o,
  });
  const bd = (o: Record<string, unknown> = {}) => ({ transactionId: padHex("0x01", { size: 32 }), bridge: "mayan", integrator: "lifi-api", referrer: ZERO, sendingAssetId: ZERO, receiver: NON_EVM, minAmount: NET, destinationChainId: 1151111081099710n, hasSourceSwaps: false, hasDestinationCall: false, ...o });
  const md = (o: Record<string, unknown> = {}) => ({ nonEVMReceiver: bytes32Of("solana", DEST_SOL), mayanProtocol: PINNED.mayanSwiftV2, protocolData: encodeSwiftCreateOrder(USDC, 1n, so()) as Hex, swapProtocol: ROUTER, swapData: "0x1234" as Hex, middleToken: USDC, minMiddleAmount: 1n, refundRecipient: ESCROW, mayanAmountIn: 1n, ...o });
  const via = (b: ReturnType<typeof bd>, m: ReturnType<typeof md>, value: bigint) => ({ provider: PINNED.lifiDiamond, value, calldata: encodeFunctionData({ abi: ABI, functionName: "startBridgeTokensViaMayan", args: [b as never, m as never] }) });
  const eEth = (o: Partial<CallExpectation> = {}): CallExpectation => ({ escrow: ESCROW, from: ETH as never, to: SOL as never, destination: DEST_SOL, net: NET, policy: "best-privacy", now: NOW, usd: USD, pooled: POOL_USDC, ...o });
  const NET_USDC = 10_000_000_000n; // 10,000 USDC
  const eUsdc: CallExpectation = { escrow: ESCROW, from: USDC_REF as never, to: SOL as never, destination: DEST_SOL, net: NET_USDC, policy: "best-privacy", now: NOW };
  const usdcBridge = (mayanProtocol: Address, protocolData: Hex) =>
    via(bd({ sendingAssetId: USDC, minAmount: NET_USDC }), md({ mayanProtocol, protocolData, swapProtocol: ZERO, swapData: "0x", middleToken: ZERO, minMiddleAmount: 0n, mayanAmountIn: NET_USDC }), 0n);

  it("the bridge-only entry's ETH → USDC leg is bounded on the ETH the facet forwards: a one-unit floor (mayanAmountIn 1 wei) is refused", async () => {
    await expect(checkProviderCall(via(bd(), md(), NET), eEth())).rejects.toThrow(/below/);
    const floor = middleFloorUsdc(NET, USD.ETH);
    const honest = md({ minMiddleAmount: floor, mayanAmountIn: NET, protocolData: encodeSwiftCreateOrder(USDC, floor, so()) as Hex });
    expect((await checkProviderCall(via(bd(), honest, NET), eEth())).minOut).toBe(MIN * 10n);
  });

  it("a Swift order's cancel + refund fees of nearly the whole order are refused inside LI.FI, as directly; an honest order's pass", async () => {
    const greedy = encodeSwiftCreateOrder(USDC, NET_USDC, so({ cancelFee: 4_995_000_000n, refundFee: 4_995_000_000n })) as Hex;
    await expect(checkProviderCall(usdcBridge(PINNED.mayanSwiftV2, greedy), eUsdc)).rejects.toThrow(/fees/);
    const fair = encodeSwiftCreateOrder(USDC, NET_USDC, so({ cancelFee: 1_000_000n, refundFee: 2_000_000n })) as Hex;
    expect((await checkProviderCall(usdcBridge(PINNED.mayanSwiftV2, fair), eUsdc)).refundTo).toBe("escrow");
  });

  it("a Fast-MCTP order's redeem + refund fees, or Circle's maximum fee, above 1 % are refused inside LI.FI", async () => {
    const order = (redeemFee: bigint, refundFee: bigint, circleMaxFee: bigint) =>
      encodeCreateOrder(USDC, NET_USDC, circleMaxFee, 5, 1000, { destAddr: addressHex32("solana", DEST_SOL), tokenOut: Buffer.alloc(32), amountOutMin: MIN, gasDrop: 0n, redeemFee, refundFee, deadline: BigInt(NOW + 1800), referrerAddr: Buffer.alloc(32), referrerBps: 0 }) as Hex;
    await expect(checkProviderCall(usdcBridge(PINNED.mayanFastMctp, order(4_995_000_000n, 4_995_000_000n, 0n)), eUsdc)).rejects.toThrow(/fees/);
    await expect(checkProviderCall(usdcBridge(PINNED.mayanFastMctp, order(1_000_000n, 1_000_000n, NET_USDC / 2n)), eUsdc)).rejects.toThrow(/Circle/);
    expect((await checkProviderCall(usdcBridge(PINNED.mayanFastMctp, order(1_000_000n, 1_000_000n, 1_000_000n)), eUsdc)).refundTo).toBe("destination");
  });

  it("swap & lock refunds USDC to the escrow: refused without a USDC vault, and with one the executor is told USDC and its floor", async () => {
    const floor = middleFloorUsdc(NET, USD.ETH);
    const honest = md({ minMiddleAmount: floor, mayanAmountIn: NET, protocolData: encodeSwiftCreateOrder(USDC, floor, so()) as Hex });
    await expect(checkProviderCall(via(bd(), honest, NET), eEth({ pooled: [] }))).rejects.toThrow(/USDC vault/);
    const c = await checkProviderCall(via(bd(), honest, NET), eEth());
    expect(c.refundTokens).toEqual([USDC]);
    expect(c.refundFloors?.[USDC.toLowerCase()]).toBe((floor / 100n).toString());
  });

  it("the engine's LI.FI quote names where the order inside refunds: Swift the escrow, Fast-MCTP the destination", () => {
    const floor = middleFloorUsdc(NET, USD.ETH);
    const swift = via(bd(), md({ minMiddleAmount: floor, mayanAmountIn: NET, protocolData: encodeSwiftCreateOrder(USDC, floor, so()) as Hex }), NET);
    expect(lifiRefundTarget(swift.calldata)).toBe("escrow");
    expect(lifiRefundTarget(usdcBridge(PINNED.mayanFastMctp, "0x").calldata)).toBe("destination");
    expect(lifiRefundTarget("0x12345678")).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------ D11-4: the reviewed route at signing
describe("the route the user reviewed is the one signed (D11-4)", () => {
  const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
  const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
  const seed = new TextEncoder().encode("review11-route-switch-seed-32-b!");
  const now = Math.floor(Date.now() / 1000);
  const AMOUNT = 10n ** 18n, TIP = AMOUNT / 400n, NET_ = AMOUNT - TIP;
  const APPROVED = 15_000_000_000n;
  const fixture = () => {
    const key = deriveOrderKey(seed, ("0x" + "ab".repeat(32)) as Hex);
    const refund = deriveRefundNote(seed, 5);
    const params: ServiceOrderParams = {
      orderId: ("0x" + "11".repeat(32)) as Hex, assetType: 0, asset: ZERO, amount: AMOUNT.toString(), orderSigner: key.address as Address,
      executeDeadline: now + 3000, refundAfter: now + 3000 + 7200, refundVault: ETH_VAULT, refundOwnerCommitment: refund.ownerCommitment.toString(), refundNoteSecret: refund.noteSecret.toString(),
      refundNoteDataHash: refund.noteDataHash, executorTip: TIP.toString(),
    };
    const escrow = predictEscrow(FACTORY, params);
    const minMiddle = middleFloorUsdc(NET_, USD.ETH);
    const createOrder = encodeCreateOrder(USDC, NET_, 1_000_000n, 5, 1000, { destAddr: addressHex32("solana", DEST_SOL), tokenOut: Buffer.alloc(32), amountOutMin: APPROVED / 10n, gasDrop: 0n, redeemFee: 500_000n, refundFee: 500_000n, deadline: BigInt(now + 1800), referrerAddr: Buffer.alloc(32), referrerBps: 0 });
    const calldata = encodeCall("swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)", [
      { t: "uint", v: NET_ }, { t: "address", v: ROUTER }, { t: "bytes", v: "0x1234" }, { t: "address", v: USDC }, { t: "uint", v: minMiddle }, { t: "address", v: PINNED.mayanFastMctp }, { t: "bytes", v: createOrder },
    ]) as Hex;
    const deadline = now + 900;
    const prepared: Prepared = { digest: executionDigest(1n, escrow, params.orderId, PINNED.mayanForwarder, NET_, calldata, deadline), provider: PINNED.mayanForwarder, value: NET_.toString(), calldata, deadline };
    const order = { orderId: params.orderId, endpoint: escrow, state: "COMMITTED", quote: { provider: "thorchain" }, params } as unknown as ServiceOrder;
    return { params, prepared, order };
  };
  const journaled = (params: ServiceOrderParams, provider: string, refundTarget?: string) =>
    ({ request: { from: ETH, to: SOL, destination: DEST_SOL }, params, policy: "best-privacy", approvedMin: APPROVED.toString(), provider, quote: { provider, toAmountMin: APPROVED.toString(), ...(refundTarget ? { refundTarget } : {}) } }) as unknown as JournaledOrder;

  it("an order committed on THORChain is never signed as a Mayan Fast-MCTP call, whose unfilled refund lands at the destination", async () => {
    const { params, prepared, order } = fixture();
    await expect(checkBeforeSigning({ prepared, order, journaled: journaled(params, "thorchain"), factory: FACTORY, chainId: 1n, usd: USD })).rejects.toThrow(/runs on thorchain/);
  });

  it("an order committed on Mayan signs a Fast-MCTP call only where its quote said a failure refunds at the destination", async () => {
    const { params, prepared, order } = fixture();
    await expect(checkBeforeSigning({ prepared, order, journaled: journaled(params, "mayan", "escrow"), factory: FACTORY, chainId: 1n, usd: USD })).rejects.toThrow(/refund at your destination/);
    const g = await checkBeforeSigning({ prepared, order, journaled: journaled(params, "mayan", "destination"), factory: FACTORY, chainId: 1n, usd: USD });
    expect(g.ok && g.call.provider).toBe("mayan");
  });

  it("refusals are the guard's own mismatch (an unsafe call), never an outage tried again", async () => {
    const { params, prepared, order } = fixture();
    await expect(checkBeforeSigning({ prepared, order, journaled: journaled(params, "chainflip"), factory: FACTORY, chainId: 1n, usd: USD })).rejects.toThrow(ProviderCallMismatch);
  });
});

// ------------------------------------------------------------------------------------------------ the verifier's NF-1: LI.FI's source swap before Mayan
describe("LI.FI's swap before the Mayan facet is bounded at this wallet's own prices (the verifier's NF-1)", () => {
  const ABI = parseAbi([
    "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
    "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
    "struct MayanData { bytes32 nonEVMReceiver; address mayanProtocol; bytes protocolData; address swapProtocol; bytes swapData; address middleToken; uint256 minMiddleAmount; address refundRecipient; uint256 mayanAmountIn; }",
    "function swapAndStartBridgeTokensViaMayan(BridgeData _bridgeData, SwapData[] _swapData, MayanData _mayanData) payable",
  ]);
  const DEX = getAddress("0x1111111254eeb25477b68fb85ed929f73a960582");
  const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
  const APPROVED = 15_000_000_000n;
  const so = (): SwiftOrder => ({
    payloadType: 1, trader: addressHex32("ethereum", ESCROW), destAddr: addressHex32("solana", DEST_SOL), destChainId: 1, referrerAddr: Buffer.alloc(32), tokenOut: Buffer.alloc(32),
    minAmountOut: APPROVED / 10n, gasDrop: 0n, cancelFee: 0n, refundFee: 0n, deadline: BigInt(NOW + 1500), referrerBps: 0, auctionMode: 2, random: Buffer.alloc(32, 7),
  });
  const call = (net: bigint, value: bigint, fromAsset: Address, bridged: Address, minAmount: bigint, md: Record<string, unknown>) => ({
    provider: PINNED.lifiDiamond,
    value,
    calldata: encodeFunctionData({
      abi: ABI,
      functionName: "swapAndStartBridgeTokensViaMayan",
      args: [
        { transactionId: padHex("0x01", { size: 32 }), bridge: "mayan", integrator: "lifi-api", referrer: ZERO, sendingAssetId: bridged, receiver: NON_EVM, minAmount, destinationChainId: 1151111081099710n, hasSourceSwaps: true, hasDestinationCall: false } as never,
        [{ callTo: DEX, approveTo: DEX, sendingAssetId: fromAsset, receivingAssetId: bridged, fromAmount: net, callData: "0x1234" as Hex, requiresDeposit: true }] as never,
        { nonEVMReceiver: bytes32Of("solana", DEST_SOL), mayanProtocol: PINNED.mayanSwiftV2, protocolData: "0x" as Hex, swapProtocol: ZERO, swapData: "0x" as Hex, middleToken: ZERO, minMiddleAmount: 0n, refundRecipient: ESCROW, mayanAmountIn: minAmount, ...md } as never,
      ],
    }),
  });
  const eEth = (pooled = POOL_USDC): CallExpectation => ({ escrow: ESCROW, from: ETH as never, to: SOL as never, destination: DEST_SOL, net: NET, policy: "best-privacy", now: NOW, usd: USD, pooled });

  it("a source swap bounded at one unit — into USDC, into WETH, or USDC into ETH ahead of a Mayan leg — is refused", async () => {
    await expect(checkProviderCall(call(NET, NET, ZERO, USDC, 1n, { protocolData: encodeSwiftCreateOrder(USDC, 1n, so()) as Hex }), eEth())).rejects.toThrow(/swap before the bridge/);
    await expect(checkProviderCall(call(NET, NET, ZERO, WETH, 10n ** 10n, { protocolData: encodeSwiftCreateOrder(WETH, 10n ** 10n, so()) as Hex }), eEth([]))).rejects.toThrow(/swap before the bridge/);
    const NET_USDC = 10_000_000_000n;
    const leg = { swapProtocol: ROUTER, swapData: "0x1234" as Hex, middleToken: USDC, minMiddleAmount: 1n, protocolData: encodeSwiftCreateOrder(USDC, 1n, so()) as Hex };
    const eUsdc: CallExpectation = { escrow: ESCROW, from: USDC_REF as never, to: SOL as never, destination: DEST_SOL, net: NET_USDC, policy: "best-privacy", now: NOW, usd: USD, pooled: POOL_USDC };
    await expect(checkProviderCall(call(NET_USDC, 0n, USDC, ZERO, 1n, leg), eUsdc)).rejects.toThrow(/swap before the bridge/);
  });

  it("an honest floor — within 2 % of the order at the wallet's price — passes, and without a fresh price nothing is signed", async () => {
    const floor = middleFloorUsdc(NET, USD.ETH); // 2,489.2 USDC for 1 ETH at $2,540
    const honest = call(NET, NET, ZERO, USDC, floor, { protocolData: encodeSwiftCreateOrder(USDC, floor, so()) as Hex });
    expect((await checkProviderCall(honest, eEth())).minOut).toBe(APPROVED);
    await expect(checkProviderCall(honest, { ...eEth(), usd: {} })).rejects.toThrow(/no fresh agreed price/);
    await expect(checkProviderCall(honest, { ...eEth(), usd: {} }), "could not check: an outage").rejects.toThrow(ProviderCallUnverified);
  });
});
