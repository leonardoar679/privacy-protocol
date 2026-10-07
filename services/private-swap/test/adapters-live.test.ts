// LIVE adapter tests (user decision: real public quote APIs, read-only, no funds, no keys).
// They depend on the network and on the providers' current API shapes; a failure here is information.
import { describe, it, expect } from "vitest";
import { ThorchainAdapter, buildMemo, encodeDepositWithExpiry, thorAsset } from "../src/adapters/thorchain";
import { LifiAdapter, decodeLifiCall } from "../src/adapters/lifi";
import { escrowCanReshield } from "../src/escrowAssets";
import { ChainflipAdapter, CHAINFLIP_VAULT_ETHEREUM, SEL_X_SWAP_NATIVE, base58Decode, decodeVaultSwapCalldata, minOutFromPrice } from "../src/adapters/chainflip";
import { MayanAdapter, MAYAN_ETH_WRAPPER, MAYAN_FORWARDER, MAYAN_SWIFT_V2, SEL_CREATE_ORDER, SEL_FORWARD_ERC20, SEL_SWAP_AND_FORWARD_ETH, SEL_SWIFT_CREATE_ORDER, WETH_ETHEREUM, addressHex32 } from "../src/adapters/mayan";
import { decodeParams, hexBuf } from "../src/abi";
import { NearIntentsAdapter, oneClickAssetId } from "../src/adapters/nearIntents";
import { AcrossAdapter, SPOKE_POOL, WETH } from "../src/adapters/across";
import { ACROSS_PERIPHERY, decodeSwapAndBridge } from "../src/adapters/acrossSwap";
import type { AssetRef, QuoteRequest } from "../src/types";

const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const USDC_BASE: AssetRef = { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const ESCROW = "0x2b8Dc27605bF11214247aE11a013fcADf2c1Cb65"; // a predicted escrow (forge vector)

describe("THORChain adapter (live)", () => {
  const a = new ThorchainAdapter();
  it("health: reachable, reports per-chain halts", async () => {
    const h = await a.health();
    expect(h.reachable).toBe(true);
    expect(Array.isArray(h.haltedChains)).toBe(true);
  }, 60_000);
  it("quotes ETH -> BTC with a limit-bearing memo and router ingress calldata", async () => {
    const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", source: ESCROW, slippageBps: 50 };
    const q = await a.quote(req);
    expect(q.provider).toBe("thorchain");
    expect(q.category).toBe("A");
    expect(q.toAmount).toBeGreaterThan(0n);
    expect(q.toAmountMin).toBeLessThanOrEqual(q.toAmount);
    expect(q.toAmountMin * 10000n).toBeGreaterThanOrEqual(q.toAmount * BigInt(10000 - 50) - 10000n);
    expect(q.expiresAt * 1000).toBeGreaterThan(Date.now());
    expect(q.nativeAssets).toBe(true);
    const ing = await a.prepareIngress(req, q);
    expect(ing.kind).toBe("contract-call");
    expect(ing.to.toLowerCase()).toMatch(/^0x[0-9a-f]{40}$/);
    expect(ing.value).toBe(10n ** 18n);
    expect(ing.memo).toMatch(new RegExp(`^=:BTC\\.BTC:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh/${ESCROW}:\\d+$`)); // a refund goes to the escrow, not the relayer
    expect(ing.calldata.startsWith("0x")).toBe(true);
    // the memo (destination + limit) is inside the calldata the order key signs
    expect(Buffer.from(ing.calldata.slice(2), "hex").toString("latin1")).toContain(ing.memo);
  }, 60_000);
  it("asset notation and memo/ABI encoding are deterministic", () => {
    expect(thorAsset(ETH)).toBe("ETH.ETH");
    expect(thorAsset(USDC_BASE)).toBe("BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913");
    expect(buildMemo("BTC.BTC", "bc1qdest", 123n)).toBe("=:BTC.BTC:bc1qdest:123");
    expect(buildMemo("BTC.BTC", "bc1qdest", 123n, ESCROW)).toBe(`=:BTC.BTC:bc1qdest/${ESCROW}:123`); // THORNode's own quote API emits this form for refund_address
    const cd = encodeDepositWithExpiry("0x" + "11".repeat(20), "0x" + "00".repeat(20), 5n, "=:b:x", 99n);
    expect(cd.slice(0, 10)).toBe("0x44bc937b"); // depositWithExpiry selector (cast sig)
  });
});

describe("LI.FI adapter (live)", () => {
  const a = new LifiAdapter();
  it("health: chains list reachable", async () => {
    const h = await a.health();
    expect(h.reachable).toBe(true);
  }, 60_000);
  it("ETH (Ethereum) -> USDC (Base): a route that swaps ETH into USDC before bridging is not offered (PP-S08: an unfilled deposit would refund USDC into the ETH escrow)", async () => {
    const req: QuoteRequest = { from: ETH, to: USDC_BASE, amount: 10n ** 18n, destination: "0x000000000000000000000000000000000000dEaD", source: ESCROW, slippageBps: 50 };
    const r = await a.quote(req).then((q) => q, (e: Error) => e);
    // LI.FI's routing changes by the minute: whatever it returns, a route that is offered bridges something the escrow re-shields
    if (r instanceof Error) expect(r.message).toMatch(/cannot re-shield|cannot verify/);
    else expect(escrowCanReshield(ETH, decodeLifiCall((r.raw as any).transactionRequest.data).bridgeData.sendingAssetId)).toBe(true);
  }, 60_000);
  it("quotes ETH (Ethereum) -> ETH (Base) with toAmountMin and a verified transactionRequest ingress", async () => {
    const req: QuoteRequest = { from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: "0x000000000000000000000000000000000000dEaD", source: ESCROW, slippageBps: 50 };
    const q = await a.quote(req);
    expect(q.provider).toBe("lifi");
    expect(q.category).toBe("C");
    expect(q.toAmountMin).toBeGreaterThan(0n);
    expect(q.toAmountMin).toBeLessThanOrEqual(q.toAmount);
    const ing = await a.prepareIngress(req, q);
    expect(ing.kind).toBe("contract-call");
    expect(ing.value).toBe(10n ** 18n);
    expect(ing.calldata.length).toBeGreaterThan(10);
    expect(ing.verified).toContain("refunds re-shieldable");
  }, 60_000);
  it("status endpoint answers for an unknown tx", async () => {
    const s = await a.track({ sourceTxHash: "0x" + "00".repeat(32) });
    expect(["pending", "unknown", "failed", "executing", "completed", "destination-submitted", "partial", "refunded"]).toContain(s.state);
  }, 60_000);
});

describe("Chainflip adapter (live)", () => {
  const a = new ChainflipAdapter();
  const SOL: AssetRef = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
  it("health: safe-mode statuses reachable on the public RPC", async () => {
    const h = await a.health();
    expect(h.reachable).toBe(true);
    expect(Array.isArray(h.haltedChains)).toBe(true);
  }, 60_000);
  it("quotes ETH -> BTC as a vault swap; min-out follows the quote's price minus our slippage", async () => {
    const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", source: ESCROW, slippageBps: 250 };
    const q = await a.quote(req);
    expect(q.provider).toBe("chainflip");
    expect(q.category).toBe("A");
    expect(q.toAmount).toBeGreaterThan(0n);
    expect(q.toAmountMin).toBeLessThanOrEqual(q.toAmount);
    expect(q.toAmountMin).toBeGreaterThan((q.toAmount * 9500n) / 10000n); // 2.5% below the estimate, not more than ~5%
    expect(q.minOutEncoded).toBe(true);
    expect(q.fees.some((f) => f.kind === "protocol")).toBe(true);
    const ing = await a.prepareIngress(req, q); // POST encodeVaultSwapData + local verification
    expect(ing.kind).toBe("contract-call");
    expect(ing.to.toLowerCase()).toBe(CHAINFLIP_VAULT_ETHEREUM);
    expect(ing.value).toBe(10n ** 18n);
    expect(ing.calldata.startsWith(SEL_X_SWAP_NATIVE)).toBe(true);
    const d = decodeVaultSwapCalldata(ing.calldata);
    expect(d.dstChain).toBe(3);
    expect(d.dstToken).toBe(5);
    expect(d.cf.refundAddress.toLowerCase()).toBe(ESCROW.toLowerCase());
    expect(minOutFromPrice(req.amount, d.cf.minPriceX128)).toBe(q.toAmountMin);
  }, 60_000);
  it("quotes ETH -> SOL and encodes a base58 Solana destination", async () => {
    const req: QuoteRequest = { from: ETH, to: SOL, amount: 5n * 10n ** 17n, destination: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", source: ESCROW, slippageBps: 100 };
    const q = await a.quote(req);
    expect(q.toAmount).toBeGreaterThan(0n);
    const ing = await a.prepareIngress(req, q);
    const d = decodeVaultSwapCalldata(ing.calldata);
    expect(d.dstChain).toBe(5);
    expect(d.dstToken).toBe(9);
    expect(d.dstAddress.length).toBe(32);
  }, 60_000);
  it("status endpoint answers 404 → unknown for an unknown tx", async () => {
    const s = await a.track({ sourceTxHash: "0x" + "11".repeat(32) });
    expect(s.state).toBe("unknown");
  }, 60_000);
});

describe("Mayan adapter (live)", () => {
  const a = new MayanAdapter({ orderTypes: ["FAST_MCTP"] });
  const SOL: AssetRef = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
  it("health: token list reachable", async () => {
    const h = await a.health();
    expect(h.reachable).toBe(true);
  }, 60_000);
  it("quotes ETH -> SOL (Fast MCTP) and builds the forwarder calldata with our order payload", async () => {
    const req: QuoteRequest = { from: ETH, to: SOL, amount: 10n ** 18n, destination: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", source: ESCROW, slippageBps: 100 };
    const q = await a.quote(req);
    expect(q.provider).toBe("mayan");
    expect(q.category).toBe("B");
    expect(q.toAmount).toBeGreaterThan(0n);
    expect(q.toAmountMin).toBeLessThanOrEqual(q.toAmount);
    expect(q.toAmountMin).toBeGreaterThan((q.toAmount * 9700n) / 10000n); // ≤ ~3 % below (1 % slippage + fees)
    expect(q.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(q.minOutEncoded).toBe(true);
    const ing = await a.prepareIngress(req, q); // GET get-swap/evm + local createOrder encoding
    expect(ing.kind).toBe("contract-call");
    expect(ing.to).toBe(MAYAN_FORWARDER);
    expect(ing.value).toBe(10n ** 18n);
    expect(ing.calldata.startsWith(SEL_SWAP_AND_FORWARD_ETH)).toBe(true);
    // decode the outer call and check that the inner createOrder carries OUR destination, min-out and deadline
    const outer = decodeParams(hexBuf(ing.calldata).subarray(4), ["uint", "address", "bytes", "address", "uint", "address", "bytes"]);
    expect(outer[0]).toBe(10n ** 18n);
    expect((outer[5] as string).toLowerCase()).toBe((q.raw as any).fastMctpMayanContract.toLowerCase());
    const inner = outer[6] as Buffer;
    expect("0x" + inner.subarray(0, 4).toString("hex")).toBe(SEL_CREATE_ORDER);
    const fields = decodeParams(inner.subarray(4), ["address", "uint", "uint", "uint", "uint", "uint", "bytes32", "bytes32", "uint", "uint", "uint", "uint", "uint", "bytes32", "uint"]);
    expect(fields[6]).toBe("0x" + base58Decode(req.destination).toString("hex")); // destAddr
    expect(fields[7]).toBe("0x" + "00".repeat(32)); // native SOL = system program
    expect((fields[8] as bigint) * 10n).toBe(q.toAmountMin); // amountOutMin has 8 decimals, SOL has 9
    expect(fields[12]).toBe(BigInt((q.raw as any).deadline64));
    expect(fields[14]).toBe(0n); // no referrer fee
  }, 60_000);
  it("status endpoint answers 404 → unknown for an unknown tx", async () => {
    const s = await a.track({ sourceTxHash: "0x" + "22".repeat(32) });
    expect(s.state).toBe("unknown");
  }, 60_000);
});

describe("NEAR Intents / 1Click adapter (live, dry quotes only)", () => {
  const a = new NearIntentsAdapter();
  it("health: token list reachable and lists ETH + BTC", async () => {
    const h = await a.health();
    expect(h.reachable).toBe(true);
    expect(h.halted).toBe(false);
    expect(await oneClickAssetId(ETH)).toBe("nep141:eth.omft.near");
    expect(await oneClickAssetId(BTC)).toBe("nep141:btc.omft.near");
  }, 60_000);
  it("dry-quotes ETH -> BTC with minAmountOut, refund to the escrow, deadline in the future", async () => {
    const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", source: ESCROW, slippageBps: 100 };
    const q = await a.quote(req);
    expect(q.provider).toBe("near-intents");
    expect(q.toAmount).toBeGreaterThan(0n);
    expect(q.toAmountMin).toBeLessThanOrEqual(q.toAmount);
    expect(q.toAmountMin).toBeGreaterThan((q.toAmount * 9800n) / 10000n); // 1 % slippage
    expect(q.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 600);
    expect((q.raw as any).quoteRequest.refundTo).toBe(ESCROW);
    expect((q.raw as any).signature.startsWith("ed25519:")).toBe(true);
    expect(q.fees.some((f) => f.kind === "affiliate")).toBe(true); // the unauthenticated fee is visible, not hidden
    // from an escrow source the adapter must refuse to produce an ingress until contract deposits are confirmed
    await expect(a.prepareIngress(req, q)).rejects.toThrow(/internal transaction/);
  }, 60_000);
  it("status endpoint → unknown for an unknown deposit address", async () => {
    const s = await a.track({ providerRef: "0x000000000000000000000000000000000000dEaD" });
    expect(["unknown", "pending"]).toContain(s.state);
  }, 60_000);
});

describe("Mayan SWIFT (live): Swift V2 auction orders built here, the escrow as trader", () => {
  const a = new MayanAdapter({ orderTypes: ["SWIFT"] });
  const SOL: AssetRef = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
  const ETH_B: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
  const USDC_E: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
  const DEST_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", DEST_EVM = "0x1111111111111111111111111111111111111111";
  const hex32 = (b: Buffer) => "0x" + b.toString("hex");
  /** createOrderWithToken(tokenIn, amountIn, OrderParams{14 static fields}, customPayload) */
  const swiftFields = (inner: Buffer) => {
    expect("0x" + inner.subarray(0, 4).toString("hex")).toBe(SEL_SWIFT_CREATE_ORDER);
    const f = decodeParams(inner.subarray(4), ["address", "uint", "uint", "bytes32", "bytes32", "uint", "bytes32", "bytes32", "uint", "uint", "uint", "uint", "uint", "uint", "uint", "bytes32", "bytes"]);
    return { tokenIn: f[0], amountIn: f[1], payloadType: f[2], trader: f[3], destAddr: f[4], destChainId: f[5], referrerAddr: f[6], tokenOut: f[7], minAmountOut: f[8] as bigint, gasDrop: f[9], cancelFee: f[10] as bigint, refundFee: f[11] as bigint, deadline: f[12] as bigint, referrerBps: f[13], auctionMode: f[14] as bigint, payload: f[16] as Buffer };
  };
  const common = (o: ReturnType<typeof swiftFields>, amount: bigint) => {
    expect(o.amountIn).toBe(amount);
    expect(o.payloadType).toBe(1n);
    expect(o.trader, "the trader, where an unfilled order is refunded, is the escrow").toBe(hex32(addressHex32("ethereum", ESCROW)));
    expect(o.referrerAddr).toBe("0x" + "00".repeat(32));
    expect(o.referrerBps).toBe(0n);
    expect(o.gasDrop).toBe(0n);
    expect(o.payload.length).toBe(0);
    expect(o.auctionMode > 0n).toBe(true);
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(o.deadline > now + 600n && o.deadline <= now + 6n * 3600n, "an order deadline solvers can meet, refunded inside the watch").toBe(true);
  };
  it("ETH -> SOL: wrap & lock through the pinned wrapper, no router calldata from the API; refunds the escrow in ETH", async () => {
    const req: QuoteRequest = { from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, source: ESCROW, slippageBps: 100 };
    const q = await a.quote(req);
    expect((q.raw as any).type).toBe("SWIFT");
    expect(q.refundTarget).toBe("escrow");
    expect(q.toAmountMin > 0n && q.toAmountMin <= q.toAmount).toBe(true);
    const ing = await a.prepareIngress(req, q);
    expect(ing.to).toBe(MAYAN_FORWARDER);
    expect(ing.value).toBe(10n ** 18n);
    expect(ing.calldata.startsWith(SEL_SWAP_AND_FORWARD_ETH)).toBe(true);
    const outer = decodeParams(hexBuf(ing.calldata).subarray(4), ["uint", "address", "bytes", "address", "uint", "address", "bytes"]);
    expect([outer[0], outer[1], (outer[2] as Buffer).toString("hex"), outer[3], outer[4], outer[5]]).toEqual([10n ** 18n, MAYAN_ETH_WRAPPER, "d46eb119", WETH_ETHEREUM, 10n ** 18n, MAYAN_SWIFT_V2]);
    const o = swiftFields(outer[6] as Buffer);
    expect(o.tokenIn, "wrap & lock: Swift refunds ETH").toBe("0x0000000000000000000000000000000000000000");
    common(o, 10n ** 18n);
    expect(o.destAddr).toBe(hex32(addressHex32("solana", DEST_SOL)));
    expect(o.destChainId).toBe(1n); // Wormhole: Solana
    expect(o.tokenOut).toBe("0x" + "00".repeat(32)); // SOL
    expect(o.minAmountOut * 10n, "8 decimals on chain, 9 for SOL").toBe(q.toAmountMin);
    expect((o.cancelFee + o.refundFee) * 10000n <= (10n ** 8n) * 100n, "cancel + refund fees within 1%").toBe(true);
  }, 60_000);
  it("ETH -> ETH (Base) and USDC (Ethereum) -> SOL: the order pays the fresh address; USDC is locked as is through forwardERC20", async () => {
    const req: QuoteRequest = { from: ETH, to: ETH_B, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 100 };
    const q = await a.quote(req);
    const ing = await a.prepareIngress(req, q);
    const outer = decodeParams(hexBuf(ing.calldata).subarray(4), ["uint", "address", "bytes", "address", "uint", "address", "bytes"]);
    const o = swiftFields(outer[6] as Buffer);
    common(o, 10n ** 18n);
    expect([o.destAddr, o.destChainId, o.tokenOut]).toEqual([hex32(addressHex32("base", DEST_EVM)), 30n, "0x" + "00".repeat(32)]);
    expect(o.minAmountOut * 10n ** 10n).toBe(q.toAmountMin);
    const ru: QuoteRequest = { from: USDC_E, to: SOL, amount: 2_000_000_000n, destination: DEST_SOL, source: ESCROW, slippageBps: 100 };
    const qu = await a.quote(ru);
    const iu = await a.prepareIngress(ru, qu);
    expect(iu.value).toBe(0n);
    expect(iu.calldata.startsWith(SEL_FORWARD_ERC20)).toBe(true);
    const ou = decodeParams(hexBuf(iu.calldata).subarray(4), ["address", "uint", "uint", "uint", "uint", "bytes32", "bytes32", "address", "bytes"]);
    expect([ou[0], ou[1], ou[2], ou[7]]).toEqual([USDC_E.asset.toLowerCase(), 2_000_000_000n, 0n, MAYAN_SWIFT_V2]);
    const u = swiftFields(ou[8] as Buffer);
    expect(u.tokenIn).toBe(USDC_E.asset.toLowerCase());
    common(u, 2_000_000_000n);
  }, 60_000);
});

describe("Across adapter (live)", () => {
  const a = new AcrossAdapter();
  const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
  const USDC_ETH: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
  const swapReq: QuoteRequest = { from: ETH, to: USDC_BASE, amount: 10n ** 18n, destination: "0x1111111111111111111111111111111111111111", source: ESCROW, slippageBps: 50 };
  const withVaults = async <T>(setting: string | undefined, f: () => Promise<T>) => {
    const saved = process.env.ERC20_VAULTS;
    if (setting === undefined) delete process.env.ERC20_VAULTS; else process.env.ERC20_VAULTS = setting;
    try { return await f(); } finally { if (saved === undefined) delete process.env.ERC20_VAULTS; else process.env.ERC20_VAULTS = saved; }
  };
  it("the Uniswap leg: ETH (Ethereum) -> USDC (Base) through Across's Swap API: swapAndBridge on the pinned periphery, decoded and checked in full; USDC is what an unfilled deposit comes back in", async () => {
    await withVaults(`${USDC_ETH.asset}:0x00000000000000000000000000000000000ca5de`, async () => {
      const q = await a.quote(swapReq);
      expect(q.provider).toBe("uniswap-across");
      expect(q.minOutVerified).toBe(true);
      expect(q.toAmountMin > 0n && q.toAmountMin <= q.toAmount).toBe(true);
      const ing = await a.prepareIngress(swapReq, q);
      expect(ing.to).toBe(ACROSS_PERIPHERY.ethereum);
      expect(ing.value).toBe(swapReq.amount);
      expect(ing.verified).toEqual(expect.arrayContaining(["target=periphery", "spokePool pinned", "depositor=escrow", "min-out", "refunds re-shieldable"]));
      expect(ing.refundTokens).toEqual([USDC_ETH.asset.toLowerCase()]);
      expect(decodeSwapAndBridge(ing.calldata).depositData.outputAmount, "the minimum is the deposit's output amount").toBe(q.toAmountMin);
    });
  }, 60_000);
  it("the Uniswap leg to native ETH: USDC (Ethereum) -> ETH (Base): the handler unwraps its WETH and sends the ETH to the fresh address; an unfilled deposit comes back in WETH, which the escrow re-shields as ETH (no WETH vault)", async () => {
    const usdcToEth: QuoteRequest = { from: USDC_ETH, to: ETH_BASE, amount: 2_000_000_000n, destination: "0x1111111111111111111111111111111111111111", source: ESCROW, slippageBps: 50 };
    await withVaults(`${USDC_ETH.asset}:0x00000000000000000000000000000000000ca5de`, async () => {
      const q = await a.quote(usdcToEth);
      const ing = await a.prepareIngress(usdcToEth, q);
      expect(ing.to).toBe(ACROSS_PERIPHERY.ethereum);
      expect(ing.value, "an ERC-20 order forwards no ETH: the periphery pulls the USDC").toBe(0n);
      expect(ing.refundTokens).toEqual([WETH.ethereum.toLowerCase()]);
      expect(decodeSwapAndBridge(ing.calldata).depositData.outputToken.toString("hex").endsWith(WETH.base.slice(2).toLowerCase()), "Across delivers WETH to the handler").toBe(true);
    });
  }, 60_000);
  it("the Uniswap leg is not offered when the pool has no vault for the token it swaps into (PP-S08)", async () => {
    await withVaults(undefined, async () => {
      await expect(a.quote(swapReq)).rejects.toThrow(/cannot re-shield/);
    });
  }, 60_000);
  it("health: native ETH route Ethereum -> Base available", async () => {
    const h = await a.health();
    expect(h.reachable).toBe(true);
    expect(h.halted).toBe(false);
  }, 60_000);
  it("quotes ETH (Ethereum) -> ETH (Base): exact fill amount, depositV3 calldata with the escrow as depositor", async () => {
    const req: QuoteRequest = { from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: "0x000000000000000000000000000000000000dEaD", source: ESCROW, slippageBps: 50 };
    const q = await a.quote(req);
    expect(q.provider).toBe("uniswap-across");
    expect(q.category).toBe("C");
    expect(q.toAmountMin).toBe(q.toAmount); // exact fill
    expect(q.toAmount).toBeGreaterThan((10n ** 18n * 995n) / 1000n); // < 0.5 % fee
    expect(q.refundTarget).toBe("escrow");
    const ing = await a.prepareIngress(req, q);
    expect(ing.to.toLowerCase()).toBe(SPOKE_POOL.ethereum);
    expect(ing.value).toBe(10n ** 18n);
    expect(ing.calldata.startsWith("0x7b939232")).toBe(true); // depositV3
    const f = decodeParams(hexBuf(ing.calldata).subarray(4), ["address", "address", "address", "address", "uint", "uint", "uint", "address", "uint", "uint", "uint", "bytes"]);
    expect((f[0] as string).toLowerCase()).toBe(ESCROW.toLowerCase()); // depositor = refund target
    expect((f[1] as string).toLowerCase()).toBe("0x000000000000000000000000000000000000dead");
    expect((f[2] as string).toLowerCase()).toBe(WETH.ethereum.toLowerCase());
    expect(f[4]).toBe(10n ** 18n);
    expect(f[5]).toBe(q.toAmount);
    expect(f[6]).toBe(8453n);
    expect((f[11] as Buffer).length).toBe(0);
  }, 60_000);
  it("quotes USDC (Ethereum) -> USDC (Base) as an ERC-20 deposit (value 0)", async () => {
    const req: QuoteRequest = { from: USDC_ETH, to: USDC_BASE, amount: 1_000_000_000n, destination: "0x000000000000000000000000000000000000dEaD", source: ESCROW, slippageBps: 50 };
    const q = await a.quote(req);
    expect(q.toAmount).toBeGreaterThan(990_000_000n);
    const ing = await a.prepareIngress(req, q);
    expect(ing.value).toBe(0n);
  }, 60_000);
  it("status endpoint → unknown for an unknown deposit", async () => {
    const s = await a.track({ sourceTxHash: "0x" + "33".repeat(32), providerRef: "1" });
    expect(s.state).toBe("unknown");
  }, 60_000);
});
