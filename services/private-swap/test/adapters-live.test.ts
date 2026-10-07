// LIVE adapter tests (user decision: real public quote APIs, read-only, no funds, no keys).
// They depend on the network and on the providers' current API shapes; a failure here is information.
import { describe, it, expect } from "vitest";
import { ThorchainAdapter, buildMemo, encodeDepositWithExpiry, thorAsset } from "../src/adapters/thorchain";
import { LifiAdapter } from "../src/adapters/lifi";
import { ChainflipAdapter, CHAINFLIP_VAULT_ETHEREUM, SEL_X_SWAP_NATIVE, base58Decode, decodeVaultSwapCalldata, minOutFromPrice } from "../src/adapters/chainflip";
import { MayanAdapter, MAYAN_FORWARDER, SEL_CREATE_ORDER, SEL_SWAP_AND_FORWARD_ETH } from "../src/adapters/mayan";
import { decodeParams, hexBuf } from "../src/abi";
import { NearIntentsAdapter, oneClickAssetId } from "../src/adapters/nearIntents";
import { AcrossAdapter, SPOKE_POOL, WETH } from "../src/adapters/across";
import type { AssetRef, QuoteRequest } from "../src/types";

const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const USDC_BASE: AssetRef = { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
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
  it("quotes ETH (Ethereum) -> USDC (Base) with toAmountMin and a transactionRequest ingress", async () => {
    const req: QuoteRequest = { from: ETH, to: USDC_BASE, amount: 10n ** 18n, destination: "0x000000000000000000000000000000000000dEaD", source: ESCROW, slippageBps: 50 };
    const q = await a.quote(req);
    expect(q.provider).toBe("lifi");
    expect(q.category).toBe("C");
    expect(q.toAmountMin).toBeGreaterThan(0n);
    expect(q.toAmountMin).toBeLessThanOrEqual(q.toAmount);
    const ing = await a.prepareIngress(req, q);
    expect(ing.kind).toBe("contract-call");
    expect(ing.value).toBe(10n ** 18n);
    expect(ing.calldata.length).toBeGreaterThan(10);
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
  const a = new MayanAdapter();
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

describe("Across adapter (live)", () => {
  const a = new AcrossAdapter();
  const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
  const USDC_ETH: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
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
