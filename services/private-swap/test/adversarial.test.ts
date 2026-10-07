// Adversarial / provider-failure tests (plan §71 test matrix, §74 provider-compromise, step 18).
// LIVE: real public APIs, read-only, no funds; faults are injected by rewriting what a provider's
// API returns (test/helpers/tamper.ts) and the engine must refuse, filter or recover accordingly.
// The on-chain half of the matrix (timeout → refund, tampered calldata, provider revert, partial
// refund, provider compromise) is in contracts/test/periphery/SwapOrderEscrow.t.sol; the mapping of
// every matrix row to its test is docs/test-matrix.md.
import { describe, it, expect } from "vitest";
import { withTamper, replaceHex, setWord, leHex32, padAddress } from "./helpers/tamper";
import { ThorchainAdapter, THORNODE_URLS, THORNODE_QUORUM, inboundQuorum } from "../src/adapters/thorchain";
import { LifiAdapter, LIFI_DIAMOND, decodeLifiCall, isAcrossV4Call } from "../src/adapters/lifi";
import { ChainflipAdapter } from "../src/adapters/chainflip";
import { MayanAdapter } from "../src/adapters/mayan";
import { NearIntentsAdapter } from "../src/adapters/nearIntents";
import { AcrossAdapter } from "../src/adapters/across";
import { defaultEngine } from "../src/config";
import { priceGuard } from "../src/scoring";
import { nextState, recoverState } from "../src/order";
import { executionDigest, orderSignerAddress } from "../src/endpoints";
import type { AssetRef, Order, OrderState, Quote, QuoteRequest } from "../src/types";

const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const SOL: AssetRef = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
const USDC_BASE: AssetRef = { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
const ETH_ARB: AssetRef = { chain: "arbitrum", asset: "native", decimals: 18, symbol: "ETH" };
const USDC_ARB: AssetRef = { chain: "arbitrum", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, symbol: "USDC" };
const ESCROW = "0x2b8Dc27605bF11214247aE11a013fcADf2c1Cb65";
const DEST_EVM = "0x1111111111111111111111111111111111111111";
const DEST_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const DEST_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ATTACKER = "0xbad0000000000000000000000000000000000bad";
const ALL_HOSTS = ["gateway.liquify.com", "rest.cosmos.directory", "thorwallet.org", "li.quest", "chainflip.io", "mayan.finance", "chaindefuser.com", "across.to"];
const KEYS = { orderSigner: orderSignerAddress(new Uint8Array(32).fill(7)), refundOwnerCommitment: 1n, refundNoteSecret: 2n, refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}` };

// ---------------------------------------------------------------------------------------------------
describe("§71 provider outage — the engine degrades, never fails (live)", () => {
  const engine = defaultEngine();
  const req: QuoteRequest = { from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, slippageBps: 50 };
  it("LI.FI unreachable: it is reported unreachable, the others still quote and a route is chosen", async () => {
    const set = await withTamper([{ match: "li.quest", fail: true }], () => engine.quoteAll(req, "best-price"));
    expect(set.health.lifi.reachable).toBe(false);
    expect(set.quotes.some((q) => q.provider === "lifi")).toBe(false);
    expect(set.errors.lifi).toMatch(/simulated outage/);
    expect(set.quotes.length).toBeGreaterThan(0);
    expect(set.chosen).toBeDefined();
    expect(set.chosen!.provider).not.toBe("lifi");
  }, 90_000);
  it("every provider down: no quotes, every error listed, no route chosen, nothing thrown", async () => {
    const set = await withTamper(ALL_HOSTS.map((h) => ({ match: h, fail: true })), () => engine.quoteAll(req, "best-privacy"));
    expect(set.quotes).toEqual([]);
    expect(set.chosen).toBeUndefined();
    expect(Object.keys(set.errors).length).toBeGreaterThanOrEqual(4);
    for (const h of Object.values(set.health)) if (h.provider !== "near-intents") expect(h.reachable).toBe(false); // 1Click's token list is cached in-process; its quote still fails
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§71 insufficient liquidity / quote refused — surfaced as a per-provider error (live, tampered)", () => {
  it("THORChain quote error", async () => {
    const a = new ThorchainAdapter();
    await expect(withTamper([{ offline: true, match: "/thorchain/quote/swap", json: () => ({ error: "not enough liquidity in pool" }) }], () => a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 50 }))).rejects.toThrow(/liquidity/);
  }, 60_000);
  it("THORChain refusal (HTTP 400 with THORNode's reason) is reported as THORChain's reason, not as an unreachable gateway", async () => {
    const a = new ThorchainAdapter();
    const halted = { code: 3, message: "failed to simulate swap: failed to simulate handler: trading is halted, can't process swap: invalid request", details: [] };
    await expect(withTamper([{ offline: true, match: "/thorchain/quote/swap", status: 400, json: () => halted }], () => a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 50 }))).rejects.toThrow(/^THORChain refused: trading is halted, can't process swap$/);
  }, 60_000);
  it("Chainflip HTTP 400", async () => {
    const a = new ChainflipAdapter();
    await expect(withTamper([{ offline: true, match: "/v2/quote", status: 400, json: () => ({ message: "Insufficient liquidity" }) }], () => a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 100 }))).rejects.toThrow(/HTTP 400.*Insufficient/);
  }, 60_000);
  it("Across amount too low", async () => {
    const a = new AcrossAdapter();
    await expect(withTamper([{ match: "suggested-fees", json: (b) => ({ ...b, isAmountTooLow: true }) }], () => a.quote({ from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 }))).rejects.toThrow(/minimum deposit/);
  }, 60_000);
  it("Mayan HTTP 400", async () => {
    const a = new MayanAdapter();
    await expect(withTamper([{ offline: true, match: "mayan.finance/v3/quote", status: 400, json: () => ({ code: "AMOUNT_TOO_SMALL", msg: "amount too small" }) }], () => a.quote({ from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, slippageBps: 100 }))).rejects.toThrow(/HTTP 400/);
  }, 60_000);
  it("1Click HTTP 400", async () => {
    const a = new NearIntentsAdapter();
    await expect(withTamper([{ offline: true, match: "/v0/quote", status: 400, json: () => ({ message: "Insufficient liquidity" }) }], () => a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 100 }))).rejects.toThrow(/HTTP 400/);
  }, 60_000);
  it("LI.FI HTTP 404 (no route)", async () => {
    const a = new LifiAdapter();
    await expect(withTamper([{ offline: true, match: "li.quest/v1/quote", status: 404, json: () => ({ message: "No available quotes for the requested transfer" }) }], () => a.quote({ from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 }))).rejects.toThrow(/HTTP 404/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 LI.FI API malicious — everything the order key would sign is checked locally (live, tampered)", () => {
  const a = new LifiAdapter();
  // LI.FI's routing changes by the minute; routes with a destination call are refused by design, so the
  // tamper tests start from whichever of these pairs verifies untampered right now
  const PAIRS: QuoteRequest[] = [ETH_BASE, USDC_BASE, ETH_ARB, USDC_ARB].map((to) => ({ from: ETH, to, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 }));
  const EVM_CHAIN_ID: Record<string, bigint> = { base: 8453n, arbitrum: 42161n };
  let verifiable: { req: QuoteRequest; q: Quote } | undefined;
  let verifiableErr: Error | undefined; // remembered so a rate-limited run does not hammer the API once per test
  const refusals: string[] = [];
  async function verifiablePair() {
    if (verifiable) return verifiable;
    if (verifiableErr) throw verifiableErr;
    for (const req of PAIRS) {
      try { const q = await a.quote(req); await a.prepareIngress(req, q); verifiable = { req, q }; return verifiable; }
      catch (e) { refusals.push(`${req.to.symbol}@${req.to.chain}: ${(e as Error).message}`); }
    }
    verifiableErr = new Error(`no LI.FI route verifiable right now (information, not a bug): ${refusals.join(" | ")}`);
    throw verifiableErr;
  }
  const bdOff = (data: string) => Number(BigInt("0x" + data.slice(10, 74)));
  const facetOff = (data: string) => { const hasSwaps = BigInt("0x" + data.slice(10 + 2 * (bdOff(data) + 8 * 32), 10 + 2 * (bdOff(data) + 9 * 32))) === 1n; const idx = hasSwaps ? 2 : 1; return Number(BigInt("0x" + data.slice(10 + 64 * idx, 10 + 64 * (idx + 1)))); };
  const tampered = async (mut: (q: any) => any) => { const { req, q } = await verifiablePair(); return withTamper([{ match: "li.quest/v1/quote", offline: true, json: () => mut(structuredClone(q.raw)) }], async () => { const q2 = await a.quote(req); return a.prepareIngress(req, q2); }); };
  const mutData = (f: (data: string) => string) => tampered((q) => { q.transactionRequest.data = f(q.transactionRequest.data); return q; });

  it("untampered: diamond pinned, BridgeData decoded (receiver, chain, no destination call), facts listed", async () => {
    const { req, q } = await verifiablePair();
    const ing = await a.prepareIngress(req, q);
    expect(ing.to).toBe(LIFI_DIAMOND.ethereum);
    const d = decodeLifiCall(ing.calldata);
    expect(d.bridgeData.receiver).toBe(DEST_EVM);
    expect(d.bridgeData.destinationChainId).toBe(EVM_CHAIN_ID[req.to.chain]);
    expect(d.bridgeData.hasDestinationCall).toBe(false);
    expect(ing.verified).toEqual(expect.arrayContaining(["target=diamond", "value", "quote from/to", "destination chain", "no destination call", "spent asset/amount", "receiver"]));
    if (isAcrossV4Call((q.raw as any).transactionRequest.data)) {
      expect(q.minOutVerified).toBe(true);
      expect(ing.verified).toContain("min-out");
    } else {
      expect(q.minOutVerified).toBe(false);
    }
  }, 60_000);
  it("transactionRequest.to redirected → refused", async () => {
    await expect(tampered((q) => { q.transactionRequest.to = ATTACKER; return q; })).rejects.toThrow(/pinned diamond/);
  }, 60_000);
  it("value inflated → refused", async () => {
    await expect(tampered((q) => { q.transactionRequest.value = "0x" + (2n * 10n ** 18n).toString(16); return q; })).rejects.toThrow(/transaction value/);
  }, 60_000);
  it("quote toAddress changed → refused", async () => {
    await expect(tampered((q) => { q.action.toAddress = ATTACKER; return q; })).rejects.toThrow(/fresh destination/);
  }, 60_000);
  it("BridgeData.receiver rewritten in the calldata → refused", async () => {
    await expect(mutData((d) => setWord(d, 4 + bdOff(d) + 5 * 32, padAddress(ATTACKER)))).rejects.toThrow(/receiver .* not the fresh destination/);
  }, 60_000);
  it("BridgeData.destinationChainId rewritten → refused", async () => {
    await expect(mutData((d) => setWord(d, 4 + bdOff(d) + 7 * 32, 42161n))).rejects.toThrow(/destinationChainId/);
  }, 60_000);
  it("BridgeData.hasDestinationCall set → refused", async () => {
    await expect(mutData((d) => setWord(d, 4 + bdOff(d) + 9 * 32, 1n))).rejects.toThrow(/destination call/);
  }, 60_000);
  it("toAmountMin lowered (changed quote) → refused at quote time", async () => {
    await expect(tampered((q) => { q.estimate.toAmountMin = (BigInt(q.estimate.toAmountMin) / 2n).toString(); return q; })).rejects.toThrow(/bps below/);
  }, 60_000);
  it("Across facet: outputAmount lowered, outputAmountMultiplier lowered or refundAddress changed → refused", async () => {
    const { q } = await verifiablePair();
    if (!isAcrossV4Call((q.raw as any).transactionRequest.data)) return; // LI.FI chose another bridge for this pair right now; the facet checks above still apply
    await expect(mutData((d) => setWord(d, 4 + facetOff(d) + 4 * 32, BigInt(q.toAmountMin) / 2n))).rejects.toThrow(/outputAmount/);
    // the swap variant hands Across (swap result) × multiplier / 1e18 on chain: a multiplier of 1 under an untouched
    // outputAmount word would deliver ~0 and let a relayer keep the rest — the word alone proves nothing
    if (decodeLifiCall((q.raw as any).transactionRequest.data).bridgeData.hasSourceSwaps) {
      await expect(mutData((d) => setWord(d, 4 + facetOff(d) + 5 * 32, 1n))).rejects.toThrow(/outputAmountMultiplier/);
    }
    await expect(mutData((d) => setWord(d, 4 + facetOff(d) + 3 * 32, padAddress(ATTACKER)))).rejects.toThrow(/receivingAssetId/);
    await expect(mutData((d) => setWord(d, 4 + facetOff(d) + 1 * 32, padAddress(ATTACKER)))).rejects.toThrow(/refundAddress/);
  }, 90_000);
  it("Mayan facet (ETH → SOL): nonEVMReceiver rewritten → refused; unverifiable min-out → refused by the engine under best-privacy", async () => {
    const reqSol: QuoteRequest = { from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, source: ESCROW, slippageBps: 50 };
    const q = await a.quote(reqSol);
    if ((q.raw as any).tool !== "mayan") return;
    let ing;
    try { ing = await a.prepareIngress(reqSol, q); } catch (e) { if (/destination call/.test(String(e))) return; throw e; }
    expect(ing.verified).toContain("receiver (mayan nonEVMReceiver)");
    await expect(withTamper([{ match: "li.quest/v1/quote", offline: true, json: () => { const b = structuredClone(q.raw) as any; b.transactionRequest.data = setWord(b.transactionRequest.data, 4 + facetOff(b.transactionRequest.data), "ab".repeat(32)); return b; } }], async () => a.prepareIngress(reqSol, await a.quote(reqSol)))).rejects.toThrow(/nonEVMReceiver/);
    expect(q.minOutVerified).toBe(false);
    const engine = defaultEngine();
    const order = engine.buildOrder(reqSol, "best-privacy", q, KEYS);
    await expect(engine.prepareExecution(order, a)).rejects.toThrow(/cannot be verified locally/);
  }, 90_000);
  it("Mayan facet: refundRecipient swapped or mayanAmountIn lowered (the facet sweeps the rest there) → refused", async () => {
    const reqSol: QuoteRequest = { from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, source: ESCROW, slippageBps: 50 };
    const q = await a.quote(reqSol);
    if ((q.raw as any).tool !== "mayan") return;
    const mut = (word: number, v: bigint | string) => withTamper([{ match: "li.quest/v1/quote", offline: true, json: () => { const b = structuredClone(q.raw) as any; b.transactionRequest.data = setWord(b.transactionRequest.data, 4 + facetOff(b.transactionRequest.data) + word * 32, v); return b; } }], async () => a.prepareIngress(reqSol, await a.quote(reqSol)));
    await expect(mut(7, padAddress(ATTACKER))).rejects.toThrow(/refundRecipient/);
    await expect(mut(8, 1n)).rejects.toThrow(/mayanAmountIn/);
  }, 90_000);
  it("a facet this adapter cannot read is not offered, under any policy", async () => {
    const { req, q } = await verifiablePair();
    await expect(withTamper([{ match: "li.quest/v1/quote", offline: true, json: () => { const b = structuredClone(q.raw) as any; b.transactionRequest.data = "0xdeadbeef" + b.transactionRequest.data.slice(10); return b; } }], () => a.quote(req))).rejects.toThrow(/cannot verify/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 THORChain gateway malicious — inbound vault/router need a gateway quorum (live, tampered)", () => {
  const a = new ThorchainAdapter();
  const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, source: ESCROW, slippageBps: 50 };
  // when too few public gateways answer, the quorum cannot be reached untampered and the product correctly
  // fails closed — those tests are skipped with the reason
  const quorumUp = async (ctx: { skip: () => void }) => { try { return await inboundQuorum("ETH"); } catch (e) { console.warn(`skipping: ${(e as Error).message}`); ctx.skip(); throw e; } };
  it("untampered: at least the quorum agrees and the ingress targets the quorum's router", async (ctx) => {
    const inb = await quorumUp(ctx);
    expect(inb.agreeing.length).toBeGreaterThanOrEqual(THORNODE_QUORUM);
    const q = await a.quote(req);
    const ing = await a.prepareIngress(req, q);
    expect(ing.to.toLowerCase()).toBe(inb.router);
    expect(ing.verified?.[0]).toMatch(/gateways agree/);
  }, 90_000);
  it("one gateway lies about the router → gateways disagree → refused", async (ctx) => {
    await quorumUp(ctx);
    await expect(withTamper([{ match: THORNODE_URLS[0] + "/thorchain/inbound_addresses", json: (b) => b.map((c: any) => (c.chain === "ETH" ? { ...c, router: ATTACKER } : c)) }], () => inboundQuorum("ETH"))).rejects.toThrow(/disagree/);
  }, 60_000);
  it("all gateways agree on another router → refused: the Ethereum router is pinned", async (ctx) => {
    await quorumUp(ctx);
    await expect(withTamper([{ match: "/thorchain/inbound_addresses", json: (b) => b.map((c: any) => (c.chain === "ETH" ? { ...c, router: ATTACKER } : c)) }], async () => a.prepareIngress(req, await a.quote(req)))).rejects.toThrow(/pinned Ethereum router/);
  }, 90_000);
  it("an escrow-sourced memo without the escrow as refund address is never produced", async () => {
    // a router deposit refunds to the transaction sender (the relayer) unless the memo names a refund address
    const q = { raw: { inbound_address: "0x0", memo: "", min1e8: "1" } } as any;
    await expect(a.prepareIngress({ ...req, source: undefined }, q)).rejects.toThrow(/refund address/);
  });
  it("only one gateway reachable → quorum not reached → refused", async () => {
    await expect(withTamper(THORNODE_URLS.slice(1).map((u) => ({ match: u, fail: true })), () => inboundQuorum("ETH"))).rejects.toThrow(/quorum not reached/);
  }, 60_000);
  it("the quote's inbound address differs from the quorum's → refused", async (ctx) => {
    await quorumUp(ctx);
    await withTamper([{ match: "/thorchain/quote/swap", json: (b) => ({ ...b, inbound_address: ATTACKER }) }], async () => {
      const q = await a.quote(req);
      await expect(a.prepareIngress(req, q)).rejects.toThrow(/not confirmed by the gateway quorum/);
    });
  }, 90_000);
  it("the memo from the API is never used: destination, refund address and limit come from the request", async (ctx) => {
    await quorumUp(ctx);
    await withTamper([{ match: "/thorchain/quote/swap", json: (b) => ({ ...b, memo: "=:BTC.BTC:bc1qattacker:1" }) }], async () => {
      const q = await a.quote(req);
      const ing = await a.prepareIngress(req, q);
      expect(ing.memo).toBe(`=:BTC.BTC:${DEST_BTC}/${ESCROW}:${(q.raw as any).min1e8}`);
      expect(Buffer.from(ing.calldata.slice(2), "hex").toString("latin1")).not.toContain("bc1qattacker");
    });
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 Chainflip backend malicious — vault pinned, calldata decoded and compared (live, tampered)", () => {
  const a = new ChainflipAdapter();
  const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, source: ESCROW, slippageBps: 250 };
  const tamperEncode = (mut: (b: any) => any) => withTamper([{ match: "encodeVaultSwapData", json: mut }], async () => a.prepareIngress(req, await a.quote(req)));
  it("vault address swapped → refused", async () => {
    await expect(tamperEncode((b) => ({ ...b, to: ATTACKER }))).rejects.toThrow(/unexpected vault/);
  }, 60_000);
  it("refund address inside cfParameters swapped → refused", async () => {
    await expect(tamperEncode((b) => ({ ...b, calldata: replaceHex(b.calldata, ESCROW, ATTACKER) }))).rejects.toThrow(/refund address is not the escrow/);
  }, 60_000);
  it("destination chain rewritten → refused", async () => {
    await expect(tamperEncode((b) => ({ ...b, calldata: setWord(b.calldata, 4, 4n) }))).rejects.toThrow(/dstChain/);
  }, 60_000);
  it("destination address rewritten → refused", async () => {
    const other = Buffer.from(DEST_BTC.replace(/.$/, "x"), "utf8").toString("hex");
    await expect(tamperEncode((b) => ({ ...b, calldata: replaceHex(b.calldata, Buffer.from(DEST_BTC, "utf8").toString("hex"), other) }))).rejects.toThrow(/destination address mismatch/);
  }, 60_000);
  it("minimum price zeroed → refused", async () => {
    const q = await a.quote(req);
    const le = leHex32(BigInt((q.raw as any).minPriceX128));
    await expect(withTamper([{ match: "encodeVaultSwapData", json: (b) => ({ ...b, calldata: replaceHex(b.calldata, le, "00".repeat(32)) }) }], () => a.prepareIngress(req, q))).rejects.toThrow(/min price mismatch/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 Mayan API malicious — payload built locally, contracts pinned, claimed minimum checked (live, tampered)", () => {
  const a = new MayanAdapter();
  const req: QuoteRequest = { from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, source: ESCROW, slippageBps: 100 };
  const tamperQuote = (mut: (q: any) => any) => withTamper([{ match: "mayan.finance/v3/quote", json: (b) => ({ ...b, quotes: (b.quotes ?? []).map(mut) }) }], () => a.quote(req));
  it("minAmountOut lowered → refused", async () => {
    await expect(tamperQuote((q) => ({ ...q, minAmountOut: q.minAmountOut * 0.5, minAmountOutBaseUnits: undefined }))).rejects.toThrow(/bps below/);
  }, 60_000);
  it("Fast-MCTP contract swapped → refused", async () => {
    await expect(tamperQuote((q) => ({ ...q, fastMctpMayanContract: ATTACKER }))).rejects.toThrow(/pinned/);
  }, 60_000);
  it("amountIn changed → refused", async () => {
    await expect(tamperQuote((q) => ({ ...q, effectiveAmountIn64: "1" }))).rejects.toThrow(/differs from the requested amount/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 Across / 1Click API malicious (live, tampered)", () => {
  it("Across SpokePool swapped → refused", async () => {
    const a = new AcrossAdapter();
    await expect(withTamper([{ match: "suggested-fees", json: (b) => ({ ...b, spokePoolAddress: ATTACKER }) }], () => a.quote({ from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 }))).rejects.toThrow(/unexpected SpokePool/);
  }, 60_000);
  it("Across outputAmount lowered → the exact-fill quote is worse and the price guard refuses it against a live alternative", async () => {
    const a = new AcrossAdapter();
    const req: QuoteRequest = { from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 };
    const honest = await a.quote(req);
    const worse = await withTamper([{ match: "suggested-fees", json: (b) => ({ ...b, outputAmount: (BigInt(b.outputAmount) * 7n / 10n).toString() }) }], () => a.quote(req));
    expect(worse.toAmountMin).toBeLessThan(honest.toAmountMin);
    const alt: Quote = { ...honest, provider: "lifi" };
    expect(() => priceGuard(worse, [alt], 300)).toThrow(/bps below the best alternative/);
    expect(() => priceGuard(honest, [alt], 300)).not.toThrow();
  }, 60_000);
  it("1Click minAmountOut lowered → refused", async () => {
    const a = new NearIntentsAdapter();
    await expect(withTamper([{ match: "/v0/quote", json: (b) => ({ ...b, quote: { ...b.quote, minAmountOut: (BigInt(b.quote.minAmountOut) / 2n).toString() } }) }], () => a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, source: ESCROW, slippageBps: 100 }))).rejects.toThrow(/bps below/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§71 timeout / partial / refund / reorg / destination congestion — status mapping (live, tampered) + state machine", () => {
  const chain = (from: OrderState, evs: Parameters<typeof nextState>[1][]) => evs.reduce((s, e) => nextState(s, e), from);
  const order = { orderId: "0x01", state: "PROVIDER_EXECUTING", history: [], params: { amount: 100n, executeDeadline: 1000, refundAfter: 2000 }, quote: { expiresAt: 900 } } as unknown as Order;

  it("LI.FI DONE/PARTIAL → partial → PARTIAL → refund of the remainder", async () => {
    const a = new LifiAdapter();
    const s = await withTamper([{ match: "/status", offline: true, json: () => ({ status: "DONE", substatus: "PARTIAL", receiving: { amount: "1", txHash: "0x01" } }) }], () => a.track({ sourceTxHash: "0x" + "00".repeat(32) }));
    expect(s.state).toBe("partial");
    expect(s.deliveredAmount).toBe(1n);
    expect(chain("PROVIDER_EXECUTING", ["partial", "refund-window", "refunded"])).toBe("REFUNDED");
    expect(recoverState(order, { now: 2500, escrowBalance: 3n, executed: true, refunded: false, track: { state: "partial" } })).toBe("PARTIAL");
  }, 60_000);
  it("LI.FI DONE/REFUNDED and FAILED map to refunded / failed → REFUND_PENDING after the window", async () => {
    const a = new LifiAdapter();
    const r = await withTamper([{ match: "/status", offline: true, json: () => ({ status: "DONE", substatus: "REFUNDED" }) }], () => a.track({ sourceTxHash: "0x" + "00".repeat(32) }));
    expect(r.state).toBe("refunded");
    const f = await withTamper([{ match: "/status", offline: true, json: () => ({ status: "FAILED" }) }], () => a.track({ sourceTxHash: "0x" + "00".repeat(32) }));
    expect(f.state).toBe("failed");
    expect(recoverState(order, { now: 2500, escrowBalance: 100n, executed: true, refunded: false, track: { state: "failed" } })).toBe("REFUND_PENDING");
    expect(recoverState(order, { now: 1500, escrowBalance: 100n, executed: true, refunded: false, track: { state: "failed" } })).toBe("DESTINATION_FAILED");
  }, 60_000);
  it("Chainflip FAILED + refundEgress → refunded; SENDING → destination-submitted (congestion: never refunded while in flight)", async () => {
    const a = new ChainflipAdapter();
    const r = await withTamper([{ match: "/v2/swaps/", offline: true, status: 200, json: () => ({ state: "FAILED", refundEgress: { amount: "1" } }) }], () => a.track({ sourceTxHash: "0x" + "11".repeat(32) }));
    expect(r.state).toBe("refunded");
    const s = await withTamper([{ match: "/v2/swaps/", offline: true, status: 200, json: () => ({ state: "SENDING", swapEgress: { txRef: "abc" } }) }], () => a.track({ sourceTxHash: "0x" + "11".repeat(32) }));
    expect(s.state).toBe("destination-submitted");
    expect(recoverState(order, { now: 99_999, escrowBalance: 0n, executed: true, refunded: false, track: { state: "destination-submitted" } })).toBe("DESTINATION_SUBMITTED");
    expect(chain("PROVIDER_EXECUTING", ["provider-timeout", "destination-submitted", "destination-final", "completed"])).toBe("COMPLETED"); // a late delivery still completes
  }, 60_000);
  it("Across expired → refunded; filled → completed", async () => {
    const a = new AcrossAdapter();
    const r = await withTamper([{ match: "deposit/status", offline: true, status: 200, json: () => ({ status: "expired" }) }], () => a.track({ sourceTxHash: "0x" + "33".repeat(32), providerRef: "1" }));
    expect(r.state).toBe("refunded");
    const f = await withTamper([{ match: "deposit/status", offline: true, status: 200, json: () => ({ status: "filled", fillTx: "0xf" }) }], () => a.track({ sourceTxHash: "0x" + "33".repeat(32), providerRef: "1" }));
    expect(f.state).toBe("completed");
    expect(f.destinationTxHash).toBe("0xf");
  }, 60_000);
  it("Mayan REFUNDED → refunded; 1Click REFUNDED / PROCESSING → refunded / executing; THORChain stages → executing / destination-final", async () => {
    const m = await withTamper([{ match: "/swap/trx/", offline: true, status: 200, json: () => ({ clientStatus: "REFUNDED" }) }], () => new MayanAdapter().track({ sourceTxHash: "0x" + "22".repeat(32) }));
    expect(m.state).toBe("refunded");
    const n1 = await withTamper([{ match: "/v0/status", offline: true, status: 200, json: () => ({ status: "REFUNDED" }) }], () => new NearIntentsAdapter().track({ providerRef: "0xdead" }));
    expect(n1.state).toBe("refunded");
    const n2 = await withTamper([{ match: "/v0/status", offline: true, status: 200, json: () => ({ status: "PROCESSING" }) }], () => new NearIntentsAdapter().track({ providerRef: "0xdead" }));
    expect(n2.state).toBe("executing");
    const t1 = await withTamper([{ match: "/thorchain/tx/status/", offline: true, status: 200, json: () => ({ stages: { inbound_observed: { started: true } } }) }], () => new ThorchainAdapter().track({ sourceTxHash: "0x" + "44".repeat(32) }));
    expect(t1.state).toBe("executing");
    const t2 = await withTamper([{ match: "/thorchain/tx/status/", offline: true, status: 200, json: () => ({ stages: { outbound_signed: { completed: true } }, out_txs: [{ id: "ABC", coins: [{ amount: "12345", asset: "BTC.BTC" }] }] }) }], () => new ThorchainAdapter().track({ sourceTxHash: "0x" + "44".repeat(32) }));
    expect(t2.state).toBe("destination-final");
    expect(t2.deliveredAmount).toBe(12345n);
  }, 90_000);
  it("provider timeout: funded, executed, nothing delivered → REFUND_PENDING once the window opens, not before", () => {
    expect(recoverState(order, { now: 1500, escrowBalance: 100n, executed: true, refunded: false, track: { state: "pending" } })).toBe("PROVIDER_EXECUTING");
    expect(recoverState(order, { now: 2500, escrowBalance: 100n, executed: true, refunded: false, track: { state: "pending" } })).toBe("REFUND_PENDING");
    expect(chain("SOURCE_FINAL", ["provider-timeout", "refund-window", "refunded"])).toBe("REFUNDED");
    // never executed at all (provider down for the whole window): the escrow itself is refundable
    expect(recoverState({ ...order, state: "SOURCE_FINAL" } as Order, { now: 2500, escrowBalance: 100n, executed: false, refunded: false })).toBe("REFUND_PENDING");
  });
  it("chain reorg: the source transaction disappears → SOURCE_FAILED → resubmitted; recovery sees an unfunded escrow as still submitted", () => {
    expect(chain("SOURCE_SUBMITTED", ["source-failed", "submit-source", "source-final"])).toBe("SOURCE_FINAL");
    expect(recoverState({ ...order, state: "SOURCE_SUBMITTED" } as Order, { now: 500, escrowBalance: 0n, executed: false, refunded: false })).toBe("SOURCE_SUBMITTED");
    expect(recoverState({ ...order, state: "SOURCE_SUBMITTED" } as Order, { now: 500, escrowBalance: 100n, executed: false, refunded: false })).toBe("SOURCE_FINAL");
  });
  it("wrong destination / token / chain after signing = different calldata = different digest = different signature (forge: TamperedCalldata_Rejected)", () => {
    const d1 = executionDigest(1n, ESCROW, "0x" + "01".repeat(32), ATTACKER, 1n, "0x1234", 100);
    const d2 = executionDigest(1n, ESCROW, "0x" + "01".repeat(32), ATTACKER, 1n, "0x1235", 100);
    expect(d1).not.toBe(d2);
  });
});
