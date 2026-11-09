// The twelfth review round, 2026-11-06, VZ-2 (HIGH): the order inside LI.FI's MayanFacet locks what the forwarder hands Mayan. LI.FI's published
// MayanFacet checks the order's receiver and, for an ERC-20, its amount, but never its tokenIn; Mayan's forwarder pulls the bridged token, max-approves the protocol and calls the order as is; Swift
// V2 pulls whatever the order's tokenIn names. A call whose order locked another token — WETH's alias 0, any token the service likes, WETH
// instead of the leg's USDC — had passed the wallet's signing gate, and the whole bridged amount would have stayed in the forwarder, anyone's to
// take. The wallet now binds the order's tokenIn to what the forwarder hands Mayan — the bridged ERC-20, or the leg's USDC —; bridge-only with an
// ERC-20, its amountIn to what the facet bridges; a Fast-MCTP order to USDC handed over. ETH reaches the order only through the facet's leg into
// USDC: bridged alone, the facet forwards it as value to an entry that takes none, and the call reverts (the twelfth review round's first critique
// of the slice, YA). The probes of the round's verifier (W3), on the exact calldata the wallet would sign, now refused; the honest shapes signed.
import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, padHex, parseAbi, type Address, type Hex } from "viem";
import { applyConfig, testConfig } from "../src/config";
import { PINNED, bytes32Of, checkProviderCall, middleFloorUsdc, type CallExpectation } from "@privacy-wallet/sdk/providerCall";
import { checkBeforeSigning, type JournaledOrder } from "@privacy-wallet/sdk/swapSign";
import { executionDigest, predictEscrow } from "@privacy-wallet/sdk/swapGuard";
import { deriveOrderKey, deriveRefundNote } from "@privacy-wallet/sdk/keys/swapKeys";
import type { Prepared, ServiceOrder, ServiceOrderParams } from "@privacy-wallet/sdk/swapService";
import { addressHex32, encodeCreateOrder, encodeSwiftCreateOrder, type OrderPayload, type SwiftOrder } from "@privacy-wallet/swap-engine/adapters/mayan";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const X_TOKEN = getAddress("0x00000000000000000000000000000000000bad01"); // any token the service likes (its own)
const ROUTER = getAddress("0x00000000000000000000000000000000000c0de1"); // a router the service names for the leg
const USDC_REF = { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" };
const ETH_REF = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const SOL = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
const DEST_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NON_EVM = "0x11f111f111f111f111f111f111f111f111f111f1" as Address;
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
const USDC_VAULT = getAddress("0x00000000000000000000000000000000000000e8");
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const NOW = 1_790_000_000;
const seed = new TextEncoder().encode("review12-W3-lifi-mayan-token-in!");
const POOLED = [{ token: USDC, symbol: "USDC", decimals: 6 }];
const USD = { ETH: 3000n * 10n ** 8n, USDC: 10n ** 8n };

const STRUCTS = [
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
  "struct MayanData { bytes32 nonEVMReceiver; address mayanProtocol; bytes protocolData; address swapProtocol; bytes swapData; address middleToken; uint256 minMiddleAmount; address refundRecipient; uint256 mayanAmountIn; }",
] as const;
const LIFI = parseAbi([
  ...STRUCTS,
  "function startBridgeTokensViaMayan(BridgeData _bridgeData, MayanData _mayanData) payable",
  "function swapAndStartBridgeTokensViaMayan(BridgeData _bridgeData, SwapData[] _swapData, MayanData _mayanData) payable",
]);
const FORWARDER = parseAbi([
  "struct PermitParams { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function forwardERC20(address tokenIn, uint256 amountIn, PermitParams permitParams, address mayanProtocol, bytes protocolData) payable",
]);

beforeAll(() => applyConfig(testConfig()));

function orderOf(asset: "usdc" | "eth", net: bigint, tip: bigint) {
  const key = deriveOrderKey(seed, ("0x" + (asset === "usdc" ? "ab" : "cd").repeat(32)) as Hex);
  const refund = deriveRefundNote(seed, asset === "usdc" ? 5 : 6);
  const params = {
    orderId: ("0x" + (asset === "usdc" ? "11" : "22").repeat(32)) as Hex,
    assetType: asset === "usdc" ? 1 : 0,
    asset: asset === "usdc" ? USDC : ZERO,
    amount: (net + tip).toString(),
    orderSigner: key.address as Address,
    executeDeadline: NOW + 3000,
    refundAfter: NOW + 3000 + 7200,
    refundVault: asset === "usdc" ? USDC_VAULT : ETH_VAULT,
    refundOwnerCommitment: refund.ownerCommitment.toString(),
    refundNoteSecret: refund.noteSecret.toString(),
    refundNoteDataHash: refund.noteDataHash,
    executorTip: tip.toString(),
  } as ServiceOrderParams;
  const escrow = predictEscrow(FACTORY, params);
  const so: ServiceOrder = { orderId: params.orderId, endpoint: escrow, state: "COMMITTED", quote: { provider: "lifi" }, params } as unknown as ServiceOrder;
  const journaled = (approved: bigint, refundTarget = "escrow") =>
    ({
      request: { from: asset === "usdc" ? USDC_REF : ETH_REF, to: SOL, destination: DEST_SOL },
      params,
      policy: "best-privacy",
      approvedMin: approved.toString(),
      provider: "lifi",
      quote: { provider: "lifi", toAmountMin: approved.toString(), refundTarget },
    }) as unknown as JournaledOrder;
  const prepare = (provider: Address, value: bigint, calldata: Hex): Prepared => {
    const deadline = NOW + 900;
    return { digest: executionDigest(1n, escrow, params.orderId, provider, value, calldata, deadline), provider, value: value.toString(), calldata, deadline };
  };
  return { escrow, so, journaled, prepare };
}

const swiftOrder = (escrow: Address, approved: bigint): SwiftOrder => ({
  payloadType: 1,
  trader: addressHex32("ethereum", escrow),
  destAddr: addressHex32("solana", DEST_SOL),
  destChainId: 1,
  referrerAddr: Buffer.alloc(32),
  tokenOut: Buffer.alloc(32),
  minAmountOut: approved / 10n,
  gasDrop: 0n,
  cancelFee: 0n,
  refundFee: 0n,
  deadline: BigInt(NOW + 1500),
  referrerBps: 0,
  auctionMode: 2,
  random: Buffer.alloc(32, 7),
});
const bd = (o: { sendingAssetId: Address; minAmount: bigint; hasSourceSwaps?: boolean }) => ({
  transactionId: padHex("0x01", { size: 32 }),
  bridge: "mayan",
  integrator: "lifi-api",
  referrer: ZERO,
  sendingAssetId: o.sendingAssetId,
  receiver: NON_EVM,
  minAmount: o.minAmount,
  destinationChainId: 1151111081099710n,
  hasSourceSwaps: !!o.hasSourceSwaps,
  hasDestinationCall: false,
});
const md = (escrow: Address, protocolData: Hex, extra: Partial<{ mayanProtocol: Address; swapProtocol: Address; swapData: Hex; middleToken: Address; minMiddleAmount: bigint; mayanAmountIn: bigint }> = {}) => ({
  nonEVMReceiver: bytes32Of("solana", DEST_SOL),
  mayanProtocol: PINNED.mayanSwiftV2,
  protocolData,
  swapProtocol: ZERO,
  swapData: "0x" as Hex,
  middleToken: ZERO,
  minMiddleAmount: 0n,
  refundRecipient: escrow,
  mayanAmountIn: 0n,
  ...extra,
});
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

describe("VZ-2: a USDC order bridged alone through LI.FI's MayanFacet", () => {
  // a USDC → SOL order: the escrow forwards 10,000 USDC; the approved minimum is 40 SOL
  const NET = 10_000_000_000n, TIP = 5_000_000n, APPROVED = 40_000_000_000n;
  const u = orderOf("usdc", NET, TIP);
  const eUsdc = (): CallExpectation => ({ escrow: u.escrow, from: USDC_REF as never, to: SOL as never, destination: DEST_SOL, net: NET, policy: "best-privacy", now: NOW, chainId: 1n, pooled: POOLED });
  const viaLifi = (protocolData: Hex, mayanProtocol: Address = PINNED.mayanSwiftV2) =>
    encodeFunctionData({ abi: LIFI, functionName: "startBridgeTokensViaMayan", args: [bd({ sendingAssetId: USDC, minAmount: NET }) as never, md(u.escrow, protocolData, { mayanProtocol }) as never] });
  const gate = (calldata: Hex) => checkBeforeSigning({ prepared: u.prepare(PINNED.lifiDiamond, 0n, calldata), order: u.so, journaled: u.journaled(APPROVED), factory: FACTORY, chainId: 1n, now: NOW, pooled: POOLED });

  it("the order locking the bridged USDC, the amount bridged: signed as before", async () => {
    const call = viaLifi(encodeSwiftCreateOrder(USDC, NET, swiftOrder(u.escrow, APPROVED)) as Hex);
    const c = await checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: call }, eUsdc());
    expect(c).toMatchObject({ provider: "lifi", minOut: APPROVED, refundTo: "escrow" });
    expect((await gate(call)).ok).toBe(true);
  });

  it("(a) an order locking WETH (tokenIn 0) for the amount bridged: refused at the call's check and at the signing gate", async () => {
    const call = viaLifi(encodeSwiftCreateOrder(ZERO, NET, swiftOrder(u.escrow, APPROVED)) as Hex);
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: call }, eUsdc()))).toMatch(/the order inside locks 0x0000000000000000000000000000000000000000, not the 0xA0b8/);
    await expect(gate(call), "the signing gate refuses it too").rejects.toThrow(/the order inside locks 0x0000000000000000000000000000000000000000/);
  });

  it("(b) an order locking a token the service names: refused", async () => {
    const call = viaLifi(encodeSwiftCreateOrder(X_TOKEN, NET, swiftOrder(u.escrow, APPROVED)) as Hex);
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: call }, eUsdc()))).toMatch(/the order inside locks 0x00000000000000000000000000000000000BAD01/i);
  });

  it("(c) the same order through the direct forwarder call: refused, as before", async () => {
    const inner = encodeSwiftCreateOrder(ZERO, NET, swiftOrder(u.escrow, APPROVED)) as Hex;
    const direct = encodeFunctionData({ abi: FORWARDER, functionName: "forwardERC20", args: [USDC, NET, { value: 0n, deadline: 0n, v: 0, r: padHex("0x", { size: 32 }), s: padHex("0x", { size: 32 }) }, PINNED.mayanSwiftV2, inner] });
    expect(await refusal(checkProviderCall({ provider: PINNED.mayanForwarder, value: 0n, calldata: direct }, eUsdc()))).toMatch(/locks 0x0000000000000000000000000000000000000000, not USDC/);
  });

  it("(d) 1 USDC of the 10,000 bridged: refused by the wallet itself, whatever the facet's version checks", async () => {
    const call = viaLifi(encodeSwiftCreateOrder(USDC, 1_000_000n, swiftOrder(u.escrow, APPROVED)) as Hex);
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: call }, eUsdc()))).toMatch(/orders 1000000, not the 10000000000 the facet bridges/);
    // ... nor one unit more (YC's critique: "exactly" had been pinned from below only)
    const more = viaLifi(encodeSwiftCreateOrder(USDC, NET + 1n, swiftOrder(u.escrow, APPROVED)) as Hex);
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: more }, eUsdc()))).toMatch(/orders 10000000001, not the 10000000000 the facet bridges/);
  });

  it("(g) a Fast-MCTP order: funded in USDC (as before), for the amount bridged", async () => {
    const order = (tokenIn: Address, amountIn: bigint) =>
      encodeCreateOrder(tokenIn, amountIn, 0n, 5, 1000, {
        destAddr: addressHex32("solana", DEST_SOL),
        tokenOut: Buffer.alloc(32),
        amountOutMin: APPROVED / 10n,
        gasDrop: 0n,
        redeemFee: 0n,
        refundFee: 0n,
        deadline: BigInt(NOW + 1800),
        referrerAddr: Buffer.alloc(32),
        referrerBps: 0,
      }) as Hex;
    const e = { ...eUsdc() };
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: viaLifi(order(X_TOKEN, NET), PINNED.mayanFastMctp) }, e))).toMatch(/not funded in USDC/);
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: viaLifi(order(USDC, NET / 2n), PINNED.mayanFastMctp) }, e))).toMatch(/not the 10000000000 the facet bridges/);
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: viaLifi(order(USDC, NET + 1n), PINNED.mayanFastMctp) }, e))).toMatch(/orders 10000000001, not the 10000000000 the facet bridges/);
  });
});

// LI.FI's own referrer, as every live LI.FI → Mayan route named it on 2026-11-09 (USDC, USDT and ETH to SOL: Swift V2 orders, 0 bps)
const LIFI_REFERRER = addressHex32("ethereum", "0xa5aa6e2171b416e1d27ec53ca8c13db3f91a89cd");

// the refusal's words name what the order does at 0 bps — it names a referrer; it carries no fee (ZH's critique: "carries a referrer fee")
describe("the owner's decision (2026-11-09): a Mayan order naming a referrer is refused at signing, even at 0 bps", () => {
  const NET = 10_000_000_000n, TIP = 5_000_000n, APPROVED = 40_000_000_000n;
  const u = orderOf("usdc", NET, TIP);
  const eUsdc = (): CallExpectation => ({ escrow: u.escrow, from: USDC_REF as never, to: SOL as never, destination: DEST_SOL, net: NET, policy: "best-privacy", now: NOW, chainId: 1n, pooled: POOLED });
  const viaLifi = (protocolData: Hex, mayanProtocol: Address = PINNED.mayanSwiftV2) =>
    encodeFunctionData({ abi: LIFI, functionName: "startBridgeTokensViaMayan", args: [bd({ sendingAssetId: USDC, minAmount: NET }) as never, md(u.escrow, protocolData, { mayanProtocol }) as never] });
  const viaForwarder = (protocolData: Hex, mayanProtocol: Address) =>
    encodeFunctionData({ abi: FORWARDER, functionName: "forwardERC20", args: [USDC, NET, { value: 0n, deadline: 0n, v: 0, r: padHex("0x", { size: 32 }), s: padHex("0x", { size: 32 }) }, mayanProtocol, protocolData] });
  const gate = (calldata: Hex) => checkBeforeSigning({ prepared: u.prepare(PINNED.lifiDiamond, 0n, calldata), order: u.so, journaled: u.journaled(APPROVED), factory: FACTORY, chainId: 1n, now: NOW, pooled: POOLED });
  const fastOrder = (over: Partial<OrderPayload> = {}) =>
    encodeCreateOrder(USDC, NET, 0n, 5, 1000, {
      destAddr: addressHex32("solana", DEST_SOL),
      tokenOut: Buffer.alloc(32),
      amountOutMin: APPROVED / 10n,
      gasDrop: 0n,
      redeemFee: 0n,
      refundFee: 0n,
      deadline: BigInt(NOW + 1800),
      referrerAddr: Buffer.alloc(32),
      referrerBps: 0,
      ...over,
    }) as Hex;
  const bent: Partial<Pick<SwiftOrder, "referrerAddr" | "referrerBps" | "gasDrop">>[] = [{ referrerAddr: LIFI_REFERRER }, { referrerBps: 5 }];

  it("LI.FI's Swift order naming LI.FI's own referrer at 0 bps — every live route's —, a referrer's bps alone, or a gas drop: refused at the call's check and at the signing gate", async () => {
    expect((await gate(viaLifi(encodeSwiftCreateOrder(USDC, NET, swiftOrder(u.escrow, APPROVED)) as Hex))).ok, "the same order naming none: signed").toBe(true);
    for (const over of [...bent, { gasDrop: 1n }]) {
      const call = viaLifi(encodeSwiftCreateOrder(USDC, NET, { ...swiftOrder(u.escrow, APPROVED), ...over }) as Hex);
      expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: call }, eUsdc())), JSON.stringify(Object.keys(over))).toMatch(/the Mayan order asks for a gas drop, names a referrer or sets a referrer fee/);
      await expect(gate(call), "the signing gate refuses it too").rejects.toThrow(/names a referrer or sets a referrer fee/);
    }
  });

  it("LI.FI's Fast-MCTP order naming LI.FI's referrer at 0 bps, a referrer's bps alone, or a gas drop: refused", async () => {
    const check = (protocolData: Hex) => checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: viaLifi(protocolData, PINNED.mayanFastMctp) }, eUsdc());
    expect(await check(fastOrder()), "the same order naming none: signed").toMatchObject({ provider: "lifi", refundTo: "destination" });
    for (const over of [...bent, { gasDrop: 1n }]) expect(await refusal(check(fastOrder(over))), JSON.stringify(Object.keys(over))).toMatch(/the Mayan order asks for a gas drop, names a referrer or sets a referrer fee/);
  });

  it("the direct forwarder's Swift and Fast-MCTP orders naming a referrer at 0 bps, or its bps alone: refused (the engine builds them with none)", async () => {
    const check = (protocolData: Hex, protocol: Address) => checkProviderCall({ provider: PINNED.mayanForwarder, value: 0n, calldata: viaForwarder(protocolData, protocol) }, eUsdc());
    expect(await check(encodeSwiftCreateOrder(USDC, NET, swiftOrder(u.escrow, APPROVED)) as Hex, PINNED.mayanSwiftV2), "Swift naming none: signed").toMatchObject({ refundTo: "escrow" });
    expect(await check(fastOrder(), PINNED.mayanFastMctp), "Fast-MCTP naming none: signed").toMatchObject({ refundTo: "destination" });
    for (const over of bent) {
      expect(await refusal(check(encodeSwiftCreateOrder(USDC, NET, { ...swiftOrder(u.escrow, APPROVED), ...over }) as Hex, PINNED.mayanSwiftV2)), `Swift ${Object.keys(over)}`).toMatch(/names a referrer or sets a referrer fee/);
      expect(await refusal(check(fastOrder(over), PINNED.mayanFastMctp)), `Fast-MCTP ${Object.keys(over)}`).toMatch(/names a referrer or sets a referrer fee/);
    }
  });
});

describe("VZ-2: an ETH order through LI.FI's MayanFacet", () => {
  // an ETH → SOL order of 1 ETH at $3,000: the leg's floor is 98 % of 3,000 USDC
  const NET_ETH = 10n ** 18n, TIP_ETH = 2n * 10n ** 15n, APPROVED_ETH = 15_000_000_000n;
  const w = orderOf("eth", NET_ETH, TIP_ETH);
  const eEth = (): CallExpectation => ({ escrow: w.escrow, from: ETH_REF as never, to: SOL as never, destination: DEST_SOL, net: NET_ETH, policy: "best-privacy", now: NOW, chainId: 1n, pooled: POOLED, usd: USD });
  const floor = middleFloorUsdc(NET_ETH, USD.ETH, USD.USDC);
  const withLeg = (inner: Hex) =>
    encodeFunctionData({
      abi: LIFI,
      functionName: "startBridgeTokensViaMayan",
      args: [bd({ sendingAssetId: ZERO, minAmount: NET_ETH }) as never, md(w.escrow, inner, { swapProtocol: ROUTER, swapData: "0x12345678", middleToken: USDC, minMiddleAmount: floor }) as never],
    });

  it("(e) with the ETH → USDC leg inside the facet: an order locking the leg's USDC is signed; one locking WETH is refused", async () => {
    // its amount free: the forwarder's swapAndForwardEth rewrites it on chain (YA's critique: every signed leg had locked the floor exactly)
    const ok = await checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: withLeg(encodeSwiftCreateOrder(USDC, floor + 12_345n, swiftOrder(w.escrow, APPROVED_ETH)) as Hex) }, eEth());
    expect(ok.minOut).toBe(APPROVED_ETH);
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: withLeg(encodeSwiftCreateOrder(ZERO, floor, swiftOrder(w.escrow, APPROVED_ETH)) as Hex) }, eEth()))).toMatch(
      /the swapped USDC is not what the order inside locks/,
    );
  });

  it("(f) the swap variant (LI.FI's own ETH → USDC swap before the facet): an order locking the bridged USDC is signed; one locking WETH is refused", async () => {
    const minAmount = middleFloorUsdc(NET_ETH, USD.ETH, USD.USDC) + 10_000_000n; // the source swap's floor, above 98 %
    const swap = { callTo: ROUTER, approveTo: ROUTER, sendingAssetId: ZERO, receivingAssetId: USDC, fromAmount: NET_ETH, callData: "0xabcdef01" as Hex, requiresDeposit: true };
    const call = (tokenIn: Address, amountIn = minAmount) =>
      encodeFunctionData({
        abi: LIFI,
        functionName: "swapAndStartBridgeTokensViaMayan",
        args: [bd({ sendingAssetId: USDC, minAmount, hasSourceSwaps: true }) as never, [swap] as never, md(w.escrow, encodeSwiftCreateOrder(tokenIn, amountIn, swiftOrder(w.escrow, APPROVED_ETH)) as Hex, { mayanAmountIn: minAmount }) as never],
      });
    const g = (calldata: Hex) => checkBeforeSigning({ prepared: w.prepare(PINNED.lifiDiamond, NET_ETH, calldata), order: w.so, journaled: w.journaled(APPROVED_ETH), factory: FACTORY, chainId: 1n, now: NOW, pooled: POOLED, usd: USD });
    expect((await g(call(USDC))).ok).toBe(true);
    expect((await g(call(USDC, minAmount + 12_345n))).ok, "its amount, which the facet rewrites on chain, stays free").toBe(true);
    await expect(g(call(ZERO))).rejects.toThrow(/the order inside locks 0x0000000000000000000000000000000000000000/);
  });

  it("ETH bridged alone into a Fast-MCTP order: refused — the facet would forward the ETH to an entry that takes none", async () => {
    const fast = encodeCreateOrder(USDC, NET_ETH, 0n, 5, 1000, {
      destAddr: addressHex32("solana", DEST_SOL),
      tokenOut: Buffer.alloc(32),
      amountOutMin: APPROVED_ETH / 10n,
      gasDrop: 0n,
      redeemFee: 0n,
      refundFee: 0n,
      deadline: BigInt(NOW + 1800),
      referrerAddr: Buffer.alloc(32),
      referrerBps: 0,
    }) as Hex;
    const call = encodeFunctionData({
      abi: LIFI,
      functionName: "startBridgeTokensViaMayan",
      args: [bd({ sendingAssetId: ZERO, minAmount: NET_ETH }) as never, md(w.escrow, fast, { mayanProtocol: PINNED.mayanFastMctp }) as never],
    });
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: call }, eEth()))).toMatch(/an ETH order is neither wrapped nor swapped first/);
  });

  it("ETH bridged alone into a Swift order: refused whatever it locks — the facet forwards the ETH as value, which Swift's entry never takes (YA's critique: tokenIn 0 had been signed as Swift's wrap & lock, for a call that reverts)", async () => {
    const call = (tokenIn: Address) =>
      encodeFunctionData({
        abi: LIFI,
        functionName: "startBridgeTokensViaMayan",
        args: [bd({ sendingAssetId: ZERO, minAmount: NET_ETH }) as never, md(w.escrow, encodeSwiftCreateOrder(tokenIn, NET_ETH, swiftOrder(w.escrow, APPROVED_ETH)) as Hex) as never],
      });
    for (const tokenIn of [ZERO, USDC])
      expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: call(tokenIn) }, eEth())), tokenIn).toMatch(/an ETH order is neither wrapped nor swapped first/);
  });

  it("LI.FI's own fee swap of ETH into ETH before the facet, then no leg: refused — the facet would forward the ETH as value (YB)", async () => {
    const swap = { callTo: ROUTER, approveTo: ROUTER, sendingAssetId: ZERO, receivingAssetId: ZERO, fromAmount: NET_ETH, callData: "0xabcdef01" as Hex, requiresDeposit: true };
    const call = encodeFunctionData({
      abi: LIFI,
      functionName: "swapAndStartBridgeTokensViaMayan",
      args: [
        bd({ sendingAssetId: ZERO, minAmount: NET_ETH, hasSourceSwaps: true }) as never,
        [swap] as never,
        md(w.escrow, encodeSwiftCreateOrder(ZERO, NET_ETH, swiftOrder(w.escrow, APPROVED_ETH)) as Hex, { mayanAmountIn: NET_ETH }) as never,
      ],
    });
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: call }, eEth()))).toMatch(/an ETH order is neither wrapped nor swapped first/);
  });

  it("LI.FI's ETH → WETH swap before the facet into a Swift order locking WETH: its fees weighed in Swift's 8 decimals — cancel + refund fees of 99 % refused, fair ones signed (D11-2's pin, moved from the ETH-alone case that reverts; YB)", async () => {
    const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    const MIN = (NET_ETH * 995n) / 1000n;
    const order8 = MIN / 10n ** 10n; // the order in Swift's 8 decimals
    const swap = { callTo: ROUTER, approveTo: ROUTER, sendingAssetId: ZERO, receivingAssetId: WETH, fromAmount: NET_ETH, callData: "0x1234" as Hex, requiresDeposit: true };
    const call = (fee: bigint, refundFee = fee) =>
      encodeFunctionData({
        abi: LIFI,
        functionName: "swapAndStartBridgeTokensViaMayan",
        args: [
          bd({ sendingAssetId: WETH, minAmount: MIN, hasSourceSwaps: true }) as never,
          [swap] as never,
          md(w.escrow, encodeSwiftCreateOrder(WETH, MIN, { ...swiftOrder(w.escrow, APPROVED_ETH), cancelFee: fee, refundFee }) as Hex, { mayanAmountIn: MIN }) as never,
        ],
      });
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: call((order8 * 495n) / 1000n) }, eEth()))).toMatch(/fees/);
    // the bound bracketed (YC's critique: a fee base normalized to 6 decimals, or to none, had passed): 1.01 % refused, 0.99 % and the live quote's
    // fees (53 + 10,651 in Swift's 8 decimals) signed
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: call((order8 * 101n) / 20_000n) }, eEth())), "1.01 %").toMatch(/fees/);
    for (const [cancel, refund] of [[(order8 * 99n) / 20_000n, (order8 * 99n) / 20_000n], [53n, 10_651n], [1000n, 1000n]])
      await expect(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: call(cancel, refund) }, eEth()), `${cancel} + ${refund}`).resolves.toMatchObject({ provider: "lifi", refundTo: "escrow" });
  });

  it("with the ETH → USDC leg inside the facet into a Fast-MCTP order in USDC: signed, its amount free (YA)", async () => {
    const fast = encodeCreateOrder(USDC, floor + 12_345n, 0n, 5, 1000, {
      destAddr: addressHex32("solana", DEST_SOL),
      tokenOut: Buffer.alloc(32),
      amountOutMin: APPROVED_ETH / 10n,
      gasDrop: 0n,
      redeemFee: 0n,
      refundFee: 0n,
      deadline: BigInt(NOW + 1800),
      referrerAddr: Buffer.alloc(32),
      referrerBps: 0,
    }) as Hex;
    const call = encodeFunctionData({
      abi: LIFI,
      functionName: "startBridgeTokensViaMayan",
      args: [
        bd({ sendingAssetId: ZERO, minAmount: NET_ETH }) as never,
        md(w.escrow, fast, { mayanProtocol: PINNED.mayanFastMctp, swapProtocol: ROUTER, swapData: "0x12345678", middleToken: USDC, minMiddleAmount: floor }) as never,
      ],
    });
    await expect(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: call }, eEth())).resolves.toMatchObject({ provider: "lifi", refundTo: "destination" });
  });

  it("a middle token or floor named without a swap protocol: refused — the facet runs no leg, and ignores them (YA)", async () => {
    const call = encodeFunctionData({
      abi: LIFI,
      functionName: "startBridgeTokensViaMayan",
      args: [
        bd({ sendingAssetId: ZERO, minAmount: NET_ETH }) as never,
        md(w.escrow, encodeSwiftCreateOrder(USDC, floor, swiftOrder(w.escrow, APPROVED_ETH)) as Hex, { middleToken: USDC, minMiddleAmount: floor }) as never,
      ],
    });
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: NET_ETH, calldata: call }, eEth()))).toMatch(/a middle token or floor is named for a swap the facet does not run/);
  });
});

describe("VZ-2: an ERC-20 other than USDC bridged alone into a Fast-MCTP order (YA's critique)", () => {
  it("USDT bridged alone into a Fast-MCTP order locking USDC: refused — the forwarder hands it USDT, and the order would pull USDC from the forwarder", async () => {
    const NET = 10_000_000_000n;
    const u = orderOf("usdc", NET, 5_000_000n);
    const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
    const fast = encodeCreateOrder(USDC, NET, 0n, 5, 1000, {
      destAddr: addressHex32("solana", DEST_SOL),
      tokenOut: Buffer.alloc(32),
      amountOutMin: 4_000_000_000n,
      gasDrop: 0n,
      redeemFee: 0n,
      refundFee: 0n,
      deadline: BigInt(NOW + 1800),
      referrerAddr: Buffer.alloc(32),
      referrerBps: 0,
    }) as Hex;
    const call = encodeFunctionData({
      abi: LIFI,
      functionName: "startBridgeTokensViaMayan",
      args: [bd({ sendingAssetId: USDT, minAmount: NET }) as never, md(u.escrow, fast, { mayanProtocol: PINNED.mayanFastMctp }) as never],
    });
    const e: CallExpectation = {
      escrow: u.escrow,
      from: { chain: "ethereum", asset: USDT, decimals: 6, symbol: "USDT" } as never,
      to: SOL as never,
      destination: DEST_SOL,
      net: NET,
      policy: "best-privacy",
      now: NOW,
      chainId: 1n,
      pooled: [{ token: USDT, symbol: "USDT", decimals: 6 }, ...POOLED],
    };
    expect(await refusal(checkProviderCall({ provider: PINNED.lifiDiamond, value: 0n, calldata: call }, e))).toMatch(
      /the facet hands the Fast-MCTP order 0xdAC17F958D2ee523a2206206994597C13D831ec7, not USDC/,
    );
  });
});
