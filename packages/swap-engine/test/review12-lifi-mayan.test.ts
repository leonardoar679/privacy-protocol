// The twelfth review round, 2026-11-06, VZ-2 (HIGH), the engine's side (part of gap 82): a LI.FI route through the MayanFacet whose order locks
// another token than the one the forwarder hands Mayan is never offered — the engine reads the order's token, bridged alone its amount, its gas
// drop and its referrer, as the wallet does at signing (the rest of the order only the wallet reads: gap 82's residual). LI.FI's MayanFacet checks the order's receiver
// and, for an ERC-20, its amount, but never its tokenIn; Mayan's forwarder calls the order as is; Swift V2 pulls whatever its tokenIn names.
// ETH reaches the order only through a leg, a leg runs only on ETH and only into USDC, as the wallet requires. And, the owner's decision of
// 2026-11-09, an order asking for a gas drop, naming a referrer or setting a referrer fee — LI.FI's own referrer at 0 bps, as every LI.FI → Mayan
// route did on 2026-11-09 (USDC, USDT and ETH to SOL) — is never offered either: the wallet signs none.
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, padHex, parseAbi, type Address, type Hex } from "viem";
import { LIFI_DIAMOND, LifiAdapter, NON_EVM_RECEIVER, verifyLifiTransaction } from "../src/adapters/lifi";
import { addressHex32, encodeCreateOrder, encodeSwiftCreateOrder, MAYAN_FAST_MCTP, MAYAN_SWIFT_V2, type OrderPayload, type SwiftOrder } from "../src/adapters/mayan";
import { AdapterRefusal, type QuoteRequest } from "../src/types";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const X_TOKEN = getAddress("0x00000000000000000000000000000000000bad01");
const ROUTER = getAddress("0x00000000000000000000000000000000000c0de1");
const ESCROW = getAddress("0x2b8Dc27605bF11214247aE11a013fcADf2c1Cb65");
const DEST_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NET = 10_000_000_000n; // 10,000 USDC
const ONE_ETH = 10n ** 18n;
const NOW = Math.floor(Date.now() / 1000);

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

const req: QuoteRequest = {
  from: { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" },
  to: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" },
  amount: NET,
  destination: DEST_SOL,
  source: ESCROW,
  slippageBps: 50,
} as QuoteRequest;
const ethReq: QuoteRequest = { ...req, from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, amount: ONE_ETH } as QuoteRequest;
const swiftOrder = (): SwiftOrder => ({
  payloadType: 1,
  trader: addressHex32("ethereum", ESCROW),
  destAddr: addressHex32("solana", DEST_SOL),
  destChainId: 1,
  referrerAddr: Buffer.alloc(32),
  tokenOut: Buffer.alloc(32),
  minAmountOut: 4_000_000_000n,
  gasDrop: 0n,
  cancelFee: 0n,
  refundFee: 0n,
  deadline: BigInt(NOW + 1500),
  referrerBps: 0,
  auctionMode: 2,
  random: Buffer.alloc(32, 7),
});
const fastOrder = (tokenIn: Address, amountIn: bigint, over: Partial<OrderPayload> = {}) =>
  encodeCreateOrder(tokenIn, amountIn, 0n, 5, 1000, {
    destAddr: addressHex32("solana", DEST_SOL),
    tokenOut: Buffer.alloc(32),
    amountOutMin: 400_000_000n,
    gasDrop: 0n,
    redeemFee: 0n,
    refundFee: 0n,
    deadline: BigInt(NOW + 1800),
    referrerAddr: Buffer.alloc(32),
    referrerBps: 0,
    ...over,
  }) as Hex;
/** the pool's USDC vault (ERC20_VAULTS), which a leg or a source swap into USDC needs: an unfilled order refunds USDC to the escrow */
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
type Facet = {
  mayanProtocol?: string;
  sendingAssetId?: Address;
  minAmount?: bigint;
  value?: bigint;
  /** a swap leg inside the facet (MayanData.swapProtocol, middleToken, minMiddleAmount) */
  leg?: { middleToken: Address; minMiddleAmount: bigint };
  /** the leg's swap protocol, when not the router a leg names by default (ZERO: a middle token named for no swap) */
  swapProtocol?: Address;
  /** LI.FI's own swap before the facet (the swap variant) */
  swap?: { sendingAssetId: Address; receivingAssetId: Address; fromAmount: bigint };
  mayanAmountIn?: bigint;
};
/** LI.FI's quote for this request through the MayanFacet, the order inside as given */
function quote(protocolData: Hex, o: Facet = {}) {
  const bridgeData = {
    transactionId: padHex("0x01", { size: 32 }),
    bridge: "mayan",
    integrator: "lifi-api",
    referrer: ZERO,
    sendingAssetId: o.sendingAssetId ?? USDC,
    receiver: NON_EVM_RECEIVER as Address,
    minAmount: o.minAmount ?? NET,
    destinationChainId: 1151111081099710n,
    hasSourceSwaps: !!o.swap,
    hasDestinationCall: false,
  };
  const mayanData = {
    nonEVMReceiver: ("0x" + addressHex32("solana", DEST_SOL).toString("hex")) as Hex,
    mayanProtocol: getAddress(o.mayanProtocol ?? MAYAN_SWIFT_V2),
    protocolData,
    swapProtocol: o.swapProtocol ?? (o.leg ? ROUTER : ZERO),
    swapData: (o.leg ? "0x12345678" : "0x") as Hex,
    middleToken: o.leg?.middleToken ?? ZERO,
    minMiddleAmount: o.leg?.minMiddleAmount ?? 0n,
    refundRecipient: ESCROW,
    mayanAmountIn: o.mayanAmountIn ?? 0n,
  };
  const data = o.swap
    ? encodeFunctionData({
        abi: LIFI,
        functionName: "swapAndStartBridgeTokensViaMayan",
        args: [bridgeData, [{ callTo: ROUTER, approveTo: ROUTER, ...o.swap, callData: "0xabcdef01", requiresDeposit: true }], mayanData],
      })
    : encodeFunctionData({ abi: LIFI, functionName: "startBridgeTokensViaMayan", args: [bridgeData, mayanData] });
  return {
    tool: "mayan",
    transactionRequest: { to: LIFI_DIAMOND.ethereum, data, value: "0x" + (o.value ?? 0n).toString(16), chainId: 1 },
    action: { fromAddress: ESCROW, toAddress: DEST_SOL, fromChainId: 1, toChainId: 1151111081099710 },
    estimate: { toAmountMin: "40000000000" },
  };
}
const ethAlone = { sendingAssetId: ZERO, minAmount: ONE_ETH, value: ONE_ETH };

describe("VZ-2: the engine reads the order inside LI.FI's MayanFacet", () => {
  it("an order locking the bridged USDC for the amount bridged: offered as before", () => {
    const v = verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET, swiftOrder()) as Hex));
    expect(v.verified).toContain("the order inside locks what the facet hands Mayan");
  });

  it("an order locking WETH (tokenIn 0), or a token the service names: never offered", () => {
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(ZERO, NET, swiftOrder()) as Hex))).toThrow(/the order inside locks 0x0000000000000000000000000000000000000000, not the 0xa0b8/);
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(X_TOKEN, NET, swiftOrder()) as Hex))).toThrow(/the order inside locks 0x00000000000000000000000000000000000bad01/);
  });

  it("an order for less than the facet bridges: never offered, whatever the facet's version checks", () => {
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, 1_000_000n, swiftOrder()) as Hex))).toThrow(/orders 1000000, not the 10000000000 the facet bridges/);
    // ... nor one unit more (YC's critique)
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET + 1n, swiftOrder()) as Hex))).toThrow(/orders 10000000001, not the 10000000000 the facet bridges/);
  });

  it("a Fast-MCTP order: in the USDC handed over, for the amount bridged", () => {
    expect(verifyLifiTransaction(req, quote(fastOrder(USDC, NET), { mayanProtocol: MAYAN_FAST_MCTP })).verified).toContain("the order inside locks what the facet hands Mayan");
    expect(() => verifyLifiTransaction(req, quote(fastOrder(X_TOKEN, NET), { mayanProtocol: MAYAN_FAST_MCTP }))).toThrow(/the Mayan order is not funded in USDC/);
    expect(() => verifyLifiTransaction(req, quote(fastOrder(USDC, NET / 2n), { mayanProtocol: MAYAN_FAST_MCTP }))).toThrow(/not the 10000000000 the facet bridges/);
    expect(() => verifyLifiTransaction(req, quote(fastOrder(USDC, NET + 1n), { mayanProtocol: MAYAN_FAST_MCTP }))).toThrow(/orders 10000000001, not the 10000000000 the facet bridges/);
  });

  it("USDT bridged alone into a Fast-MCTP order, whatever it locks: never offered — the facet hands it USDT, and CCTP burns USDC only (YB)", () => {
    const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
    const usdtReq = { ...req, from: { chain: "ethereum", asset: USDT, decimals: 6, symbol: "USDT" } } as QuoteRequest;
    for (const locks of [USDT, USDC])
      expect(() => verifyLifiTransaction(usdtReq, quote(fastOrder(locks, NET), { mayanProtocol: MAYAN_FAST_MCTP, sendingAssetId: USDT })), locks).toThrow(
        /the facet hands the Fast-MCTP order 0xdac17f958d2ee523a2206206994597c13d831ec7, not USDC/i,
      );
  });

  it("LI.FI's own fee swap of ETH into ETH before the facet, then no leg: never offered — the facet would forward the ETH as value (YB)", () => {
    const viaSwap = { ...ethAlone, swap: { sendingAssetId: ZERO, receivingAssetId: ZERO, fromAmount: ONE_ETH }, mayanAmountIn: ONE_ETH };
    expect(() => verifyLifiTransaction(ethReq, quote(encodeSwiftCreateOrder(ZERO, ONE_ETH, swiftOrder()) as Hex, viaSwap))).toThrow(/ETH bridged into the order without a leg/);
  });

  it("ETH bridged alone into a Fast-MCTP order: never offered — the facet would forward the ETH to an entry that takes none", () => {
    const q = quote(fastOrder(ZERO, ONE_ETH), { mayanProtocol: MAYAN_FAST_MCTP, ...ethAlone });
    expect(() => verifyLifiTransaction(ethReq, q)).toThrow(/ETH bridged into the order without a leg/);
  });

  it("ETH bridged alone into a Swift order: never offered whatever it locks — Swift's entry takes no value, and the call reverts (YA's critique: tokenIn 0 had been offered as Swift's wrap & lock)", () => {
    for (const tokenIn of [ZERO, USDC])
      expect(() => verifyLifiTransaction(ethReq, quote(encodeSwiftCreateOrder(tokenIn, ONE_ETH, swiftOrder()) as Hex, ethAlone)), tokenIn).toThrow(/ETH bridged into the order without a leg/);
  });

  it("with the ETH → USDC leg inside the facet into a Fast-MCTP order in USDC: offered, its amount free (YA)", () => {
    const leg = { middleToken: USDC, minMiddleAmount: 2_940_000_000n };
    withUsdcVault(() =>
      expect(verifyLifiTransaction(ethReq, quote(fastOrder(USDC, 2_940_012_345n), { mayanProtocol: MAYAN_FAST_MCTP, ...ethAlone, leg })).verified).toContain("the order inside locks what the facet hands Mayan"),
    );
  });

  it("a middle token or floor named without a swap protocol, and an order the protocol named does not take: never offered (YA)", () => {
    const named = { middleToken: USDC, minMiddleAmount: 2_940_000_000n };
    withUsdcVault(() =>
      expect(() => verifyLifiTransaction(ethReq, quote(encodeSwiftCreateOrder(USDC, 2_940_000_000n, swiftOrder()) as Hex, { ...ethAlone, leg: named, swapProtocol: ZERO }))).toThrow(
        /a middle token or floor is named for a swap the facet does not run/,
      ),
    );
    const unread = /is not one this adapter reads/;
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET, swiftOrder()) as Hex, { mayanProtocol: "0x0000000000000000000000000000000000000bad" })), "an unpinned protocol").toThrow(unread);
    expect(() => verifyLifiTransaction(req, quote(fastOrder(USDC, NET), { mayanProtocol: MAYAN_SWIFT_V2 })), "Fast-MCTP's order to Swift").toThrow(unread);
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET, swiftOrder()) as Hex, { mayanProtocol: MAYAN_FAST_MCTP })), "Swift's order to Fast-MCTP").toThrow(unread);
  });

  it("with the ETH → USDC leg inside the facet: an order locking the leg's USDC is offered, its amount free (the forwarder rewrites it on chain); one locking WETH is not", () => {
    const leg = { middleToken: USDC, minMiddleAmount: 2_940_000_000n };
    withUsdcVault(() => {
      expect(verifyLifiTransaction(ethReq, quote(encodeSwiftCreateOrder(USDC, 2_940_012_345n, swiftOrder()) as Hex, { ...ethAlone, leg })).verified).toContain("the order inside locks what the facet hands Mayan");
      expect(() => verifyLifiTransaction(ethReq, quote(encodeSwiftCreateOrder(ZERO, 2_940_000_000n, swiftOrder()) as Hex, { ...ethAlone, leg }))).toThrow(
        /the order inside locks 0x0000000000000000000000000000000000000000, not the 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 the facet hands Mayan/,
      );
    });
  });

  it("a leg inside the facet into WETH (LI.FI's live ETH → SOL wrap), its order locking 0: never offered — the wallet bounds only an ETH → USDC leg", () => {
    const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" as Address;
    const leg = { middleToken: WETH, minMiddleAmount: ONE_ETH };
    expect(() => verifyLifiTransaction(ethReq, quote(encodeSwiftCreateOrder(ZERO, ONE_ETH, swiftOrder()) as Hex, { ...ethAlone, leg }))).toThrow(
      /a swap leg inside Mayan into 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2, not USDC/,
    );
  });

  it("a swap leg inside the facet on a token it already bridges: never offered, as the wallet refuses it at signing", () => {
    withUsdcVault(() =>
      expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET, swiftOrder()) as Hex, { leg: { middleToken: USDC, minMiddleAmount: NET } }))).toThrow(
        /a swap leg inside Mayan on 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48, a token the facet already bridges/,
      ),
    );
  });

  it("the swap variant (LI.FI's own ETH → USDC swap before the facet): an order locking the bridged USDC is offered, its amount free (the facet rewrites it on chain); one locking WETH is not", () => {
    const MIN = 2_950_000_000n;
    const variant = { sendingAssetId: USDC, minAmount: MIN, value: ONE_ETH, mayanAmountIn: MIN, swap: { sendingAssetId: ZERO, receivingAssetId: USDC, fromAmount: ONE_ETH } };
    withUsdcVault(() => {
      expect(verifyLifiTransaction(ethReq, quote(encodeSwiftCreateOrder(USDC, MIN + 12_345n, swiftOrder()) as Hex, variant)).verified).toContain("the order inside locks what the facet hands Mayan");
      expect(() => verifyLifiTransaction(ethReq, quote(encodeSwiftCreateOrder(ZERO, MIN, swiftOrder()) as Hex, variant))).toThrow(/the order inside locks 0x0000000000000000000000000000000000000000, not the 0xa0b8/);
    });
  });

  it("an order inside this adapter cannot read (another selector): never offered", () => {
    expect(() => verifyLifiTransaction(req, quote(("0xdeadbeef" + "00".repeat(64)) as Hex))).toThrow(/is not one this adapter reads/);
  });
});

// LI.FI's own referrer, as every live LI.FI → Mayan route named it on 2026-11-09 (USDC, USDT and ETH to SOL: Swift V2 orders, 0 bps)
const LIFI_REFERRER = addressHex32("ethereum", "0xa5aa6e2171b416e1d27ec53ca8c13db3f91a89cd");
const LIFI_NAMED = /names a referrer \(0x000000000000000000000000a5aa6e2171b416e1d27ec53ca8c13db3f91a89cd\) at 0 bps, which the wallet never signs, even at 0 bps/;
const BPS_ALONE = /sets a referrer fee of 5 bps, which the wallet never signs/;

describe("the owner's decision (2026-11-09): an order inside LI.FI's MayanFacet naming a referrer, at any rate, or asking for a gas drop is never offered", () => {
  it("a Swift order naming LI.FI's own referrer at 0 bps, as every live route did: never offered", () => {
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET, { ...swiftOrder(), referrerAddr: LIFI_REFERRER }) as Hex))).toThrow(LIFI_NAMED);
  });

  it("a Swift order with a referrer's bps and no address, or with a gas drop: never offered", () => {
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET, { ...swiftOrder(), referrerBps: 5 }) as Hex))).toThrow(BPS_ALONE);
    expect(() => verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET, { ...swiftOrder(), gasDrop: 1n }) as Hex))).toThrow(/asks for a gas drop \(1\), which the wallet never signs/);
  });

  it("a Fast-MCTP order naming LI.FI's referrer at 0 bps, or a referrer's bps alone, or asking for a gas drop: never offered", () => {
    const fast = { mayanProtocol: MAYAN_FAST_MCTP };
    expect(() => verifyLifiTransaction(req, quote(fastOrder(USDC, NET, { referrerAddr: LIFI_REFERRER }), fast))).toThrow(LIFI_NAMED);
    expect(() => verifyLifiTransaction(req, quote(fastOrder(USDC, NET, { referrerBps: 5 }), fast))).toThrow(BPS_ALONE);
    expect(() => verifyLifiTransaction(req, quote(fastOrder(USDC, NET, { gasDrop: 1n }), fast))).toThrow(/asks for a gas drop \(1\), which the wallet never signs/);
  });

  it("the orders offered above name none and ask for none: offered, the fact recorded", () => {
    const swift = verifyLifiTransaction(req, quote(encodeSwiftCreateOrder(USDC, NET, swiftOrder()) as Hex));
    const fast = verifyLifiTransaction(req, quote(fastOrder(USDC, NET), { mayanProtocol: MAYAN_FAST_MCTP }));
    for (const v of [swift, fast]) expect(v.verified).toContain("the order inside asks for no gas drop and names no referrer");
  });

  it("an order short of its static part — a word cut off, or cut inside: never offered; neither contract decodes it, and a word cut inside would read as a smaller value (ZH's critique)", async () => {
    const cut = (data: Hex, bytes: number) => data.slice(0, 2 + 2 * bytes) as Hex;
    // Swift: two words, OrderParams' fourteen and the custom payload's offset (17) — here the offset cut off, LI.FI's referrer still in it
    const named = encodeSwiftCreateOrder(USDC, NET, { ...swiftOrder(), referrerAddr: LIFI_REFERRER }) as Hex;
    expect(() => verifyLifiTransaction(req, quote(cut(encodeSwiftCreateOrder(USDC, NET, swiftOrder()) as Hex, 4 + 16 * 32)))).toThrow(/is not one this adapter reads/);
    expect(() => verifyLifiTransaction(req, quote(cut(named, 4 + 16 * 32)))).toThrow(/is not one this adapter reads/);
    // Fast-MCTP: fifteen words — here the referrer's bps cut off
    expect(() => verifyLifiTransaction(req, quote(cut(fastOrder(USDC, NET), 4 + 14 * 32), { mayanProtocol: MAYAN_FAST_MCTP }))).toThrow(/is not one this adapter reads/);
    // ... and cut inside the referrer's bps word, a fee of 5 bps in it — its last byte gone, the word would read 0: offered, before (ZH's critique)
    const fastInside = quote(cut(fastOrder(USDC, NET, { referrerBps: 5 }), 4 + 15 * 32 - 1), { mayanProtocol: MAYAN_FAST_MCTP });
    const swiftInside = quote(cut(encodeSwiftCreateOrder(USDC, NET, { ...swiftOrder(), referrerBps: 5 }) as Hex, 4 + 14 * 32 - 1));
    for (const [what, q] of [["Fast-MCTP", fastInside], ["Swift", swiftInside]] as const) {
      expect(() => verifyLifiTransaction(req, q), what).toThrow(/is not one this adapter reads/);
      const a = new LifiAdapter();
      a.rawQuote = async () => q;
      await expect(a.quote(req), `${what}, through the adapter's quote`).rejects.toBeInstanceOf(AdapterRefusal);
    }
  });

  it("through the adapter's quote: refused as its answer to this request (an AdapterRefusal: set aside at the competition, never an outage)", async () => {
    const a = new LifiAdapter();
    a.rawQuote = async () => quote(encodeSwiftCreateOrder(USDC, NET, { ...swiftOrder(), referrerAddr: LIFI_REFERRER }) as Hex);
    const e = await a.quote(req).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(AdapterRefusal);
    expect((e as Error).message).toMatch(LIFI_NAMED);
  });
});
