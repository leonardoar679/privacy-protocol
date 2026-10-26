// Adversarial / provider-failure tests (plan §71 test matrix, §74 provider-compromise, step 18).
// LIVE: real public APIs, read-only, no funds; faults are injected by rewriting what a provider's
// API returns (test/helpers/tamper.ts) and the engine must refuse, filter or recover accordingly.
// The on-chain half of the matrix (timeout → refund, tampered calldata, provider revert, partial
// refund, provider compromise) is in contracts/test/periphery/SwapOrderEscrow.t.sol; the mapping of
// every matrix row to its test is docs/test-matrix.md.
import { describe, it, expect } from "vitest";
import { withTamper, replaceHex, setWord, leHex32, padAddress } from "./helpers/tamper";
import { ThorchainAdapter, THORNODE_URLS, THORNODE_QUORUM, inboundQuorum } from "../src/adapters/thorchain";
import { LifiAdapter, LIFI_DIAMOND, decodeLifiCall, isAcrossV4Call, verifyLifiTransaction } from "../src/adapters/lifi";
import { escrowCanReshield } from "../src/escrowAssets";
import { ChainflipAdapter } from "../src/adapters/chainflip";
import { MayanAdapter, MAYAN_ETH_WRAPPER } from "../src/adapters/mayan";
import { decodeParams, hexBuf } from "../src/abi";
import { NearIntentsAdapter } from "../src/adapters/nearIntents";
import { AcrossAdapter } from "../src/adapters/across";
import { ACROSS_EVENT_EMITTER } from "../src/adapters/acrossSwap";
import { defaultEngine } from "../src/config";
import { shareTips } from "./helpers/tips";
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
const ALL_HOSTS = [
  "gateway.liquify.com",
  "rest.cosmos.directory",
  "thorwallet.org",
  "li.quest",
  "chainflip.io",
  "mayan.finance",
  "chaindefuser.com",
  "across.to",
];
const KEYS = {
  orderSigner: orderSignerAddress(new Uint8Array(32).fill(7)),
  refundOwnerCommitment: 1n,
  refundNoteSecret: 2n,
  refundNoteDataHash: ("0x" + "00".repeat(32)) as `0x${string}`,
};

// ---------------------------------------------------------------------------------------------------
describe("§71 provider outage — the engine degrades, never fails (live)", () => {
  const engine = defaultEngine({ tips: shareTips(25n) });
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
    // a fresh engine: the previous case left reachable health in the 30-second cache (whale spec §16), and this one is about the outage itself
    const set = await withTamper(
      ALL_HOSTS.map((h) => ({ match: h, fail: true })),
      () => defaultEngine({ tips: shareTips(25n) }).quoteAll(req, "best-privacy"),
    );
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
    await expect(
      withTamper([{ offline: true, match: "/thorchain/quote/swap", json: () => ({ error: "not enough liquidity in pool" }) }], () =>
        a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 50 }),
      ),
    ).rejects.toThrow(/liquidity/);
  }, 60_000);
  it("THORChain refusal (HTTP 400 with THORNode's reason) is reported as THORChain's reason, not as an unreachable gateway", async () => {
    const a = new ThorchainAdapter();
    const halted = {
      code: 3,
      message: "failed to simulate swap: failed to simulate handler: trading is halted, can't process swap: invalid request",
      details: [],
    };
    await expect(
      withTamper([{ offline: true, match: "/thorchain/quote/swap", status: 400, json: () => halted }], () =>
        a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 50 }),
      ),
    ).rejects.toThrow(/^THORChain refused: trading is halted, can't process swap$/);
  }, 60_000);
  it("Chainflip HTTP 400", async () => {
    const a = new ChainflipAdapter();
    await expect(
      withTamper([{ offline: true, match: "/v2/quote", status: 400, json: () => ({ message: "Insufficient liquidity" }) }], () =>
        a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 100 }),
      ),
    ).rejects.toThrow(/HTTP 400.*Insufficient/);
  }, 60_000);
  it("Across amount too low", async () => {
    const a = new AcrossAdapter();
    await expect(
      withTamper([{ match: "suggested-fees", json: (b) => ({ ...b, isAmountTooLow: true }) }], () =>
        a.quote({ from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 }),
      ),
    ).rejects.toThrow(/minimum deposit/);
  }, 60_000);
  it("Mayan HTTP 400", async () => {
    const a = new MayanAdapter();
    await expect(
      withTamper([{ offline: true, match: "mayan.finance/v3/quote", status: 400, json: () => ({ code: "AMOUNT_TOO_SMALL", msg: "amount too small" }) }], () =>
        a.quote({ from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, slippageBps: 100 }),
      ),
    ).rejects.toThrow(/HTTP 400/);
  }, 60_000);
  it("1Click HTTP 400", async () => {
    const a = new NearIntentsAdapter();
    await expect(
      withTamper([{ offline: true, match: "/v0/quote", status: 400, json: () => ({ message: "Insufficient liquidity" }) }], () =>
        a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 100 }),
      ),
    ).rejects.toThrow(/HTTP 400/);
  }, 60_000);
  it("LI.FI HTTP 404 (no route)", async () => {
    const a = new LifiAdapter();
    await expect(
      withTamper(
        [{ offline: true, match: "li.quest/v1/quote", status: 404, json: () => ({ message: "No available quotes for the requested transfer" }) }],
        () => a.quote({ from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 }),
      ),
    ).rejects.toThrow(/HTTP 404/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 LI.FI API malicious — everything the order key would sign is checked locally (live, tampered)", () => {
  const a = new LifiAdapter();
  // LI.FI's routing changes by the minute; routes with a destination call are refused by design, so the
  // tamper tests start from whichever of these pairs verifies untampered right now
  const PAIRS: QuoteRequest[] = [ETH_BASE, USDC_BASE, ETH_ARB, USDC_ARB].map((to) => ({
    from: ETH,
    to,
    amount: 10n ** 18n,
    destination: DEST_EVM,
    source: ESCROW,
    slippageBps: 50,
  }));
  const EVM_CHAIN_ID: Record<string, bigint> = { base: 8453n, arbitrum: 42161n };
  let verifiable: { req: QuoteRequest; q: Quote } | undefined;
  let verifiableErr: Error | undefined; // remembered so a rate-limited run does not hammer the API once per test
  const refusals: string[] = [];
  async function verifiablePair() {
    if (verifiable) return verifiable;
    if (verifiableErr) throw verifiableErr;
    for (const req of PAIRS) {
      try {
        const q = await a.quote(req);
        await a.prepareIngress(req, q);
        verifiable = { req, q };
        return verifiable;
      } catch (e) {
        refusals.push(`${req.to.symbol}@${req.to.chain}: ${(e as Error).message}`);
      }
    }
    verifiableErr = new Error(`no LI.FI route verifiable right now (information, not a bug): ${refusals.join(" | ")}`);
    throw verifiableErr;
  }
  const bdOff = (data: string) => Number(BigInt("0x" + data.slice(10, 74)));
  const facetOff = (data: string) => {
    const hasSwaps = BigInt("0x" + data.slice(10 + 2 * (bdOff(data) + 8 * 32), 10 + 2 * (bdOff(data) + 9 * 32))) === 1n;
    const idx = hasSwaps ? 2 : 1;
    return Number(BigInt("0x" + data.slice(10 + 64 * idx, 10 + 64 * (idx + 1))));
  };
  const tampered = async (mut: (q: any) => any) => {
    const { req, q } = await verifiablePair();
    return withTamper([{ match: "li.quest/v1/quote", offline: true, json: () => mut(structuredClone(q.raw)) }], async () => {
      const q2 = await a.quote(req);
      return a.prepareIngress(req, q2);
    });
  };
  const mutData = (f: (data: string) => string) =>
    tampered((q) => {
      q.transactionRequest.data = f(q.transactionRequest.data);
      return q;
    });

  it("untampered: diamond pinned, BridgeData decoded (receiver, chain, no destination call), facts listed", async () => {
    const { req, q } = await verifiablePair();
    const ing = await a.prepareIngress(req, q);
    expect(ing.to).toBe(LIFI_DIAMOND.ethereum);
    const d = decodeLifiCall(ing.calldata);
    expect(d.bridgeData.receiver).toBe(DEST_EVM);
    expect(d.bridgeData.destinationChainId).toBe(EVM_CHAIN_ID[req.to.chain]);
    expect(d.bridgeData.hasDestinationCall).toBe(false);
    expect(ing.verified).toEqual(
      expect.arrayContaining(["target=diamond", "value", "quote from/to", "destination chain", "no destination call", "spent asset/amount", "receiver"]),
    );
    if (isAcrossV4Call((q.raw as any).transactionRequest.data)) {
      expect(q.minOutVerified).toBe(true);
      expect(ing.verified).toContain("min-out");
    } else {
      expect(q.minOutVerified).toBe(false);
    }
  }, 60_000);
  it("transactionRequest.to redirected → refused", async () => {
    await expect(
      tampered((q) => {
        q.transactionRequest.to = ATTACKER;
        return q;
      }),
    ).rejects.toThrow(/pinned diamond/);
  }, 60_000);
  it("value inflated → refused", async () => {
    await expect(
      tampered((q) => {
        q.transactionRequest.value = "0x" + (2n * 10n ** 18n).toString(16);
        return q;
      }),
    ).rejects.toThrow(/transaction value/);
  }, 60_000);
  it("quote toAddress changed → refused", async () => {
    await expect(
      tampered((q) => {
        q.action.toAddress = ATTACKER;
        return q;
      }),
    ).rejects.toThrow(/fresh destination/);
  }, 60_000);
  it("BridgeData.receiver rewritten in the calldata → refused", async () => {
    await expect(mutData((d) => setWord(d, 4 + bdOff(d) + 5 * 32, padAddress(ATTACKER)))).rejects.toThrow(/receiver .* not the fresh destination/);
  }, 60_000);
  it("BridgeData.destinationChainId rewritten → refused", async () => {
    // a chain other than the pair's (whichever pair verifies right now: a Base pair is bent to Arbitrum, an Arbitrum pair to Base)
    const { req } = await verifiablePair();
    const other = EVM_CHAIN_ID[req.to.chain] === 42161n ? 8453n : 42161n;
    await expect(mutData((d) => setWord(d, 4 + bdOff(d) + 7 * 32, other))).rejects.toThrow(/destinationChainId/);
  }, 60_000);
  it("BridgeData.hasDestinationCall set → refused", async () => {
    await expect(mutData((d) => setWord(d, 4 + bdOff(d) + 9 * 32, 1n))).rejects.toThrow(/destination call/);
  }, 60_000);
  it("toAmountMin lowered (changed quote) → refused at quote time", async () => {
    await expect(
      tampered((q) => {
        q.estimate.toAmountMin = (BigInt(q.estimate.toAmountMin) / 2n).toString();
        return q;
      }),
    ).rejects.toThrow(/bps below/);
  }, 60_000);
  it("Across facet: outputAmount lowered, outputAmountMultiplier lowered or refundAddress changed → refused", async () => {
    const { q } = await verifiablePair();
    if (!isAcrossV4Call((q.raw as any).transactionRequest.data)) return; // LI.FI chose another bridge for this pair right now; the facet checks above still apply
    await expect(mutData((d) => setWord(d, 4 + facetOff(d) + 4 * 32, BigInt(q.toAmountMin) / 2n))).rejects.toThrow(/outputAmount/);
    // the swap variant hands Across (swap result) × multiplier / 1e18 on chain: a multiplier of 1 under an untouched
    // outputAmount word would deliver ~0 and let a relayer keep the rest — the word alone proves nothing
    if (decodeLifiCall((q.raw as any).transactionRequest.data).bridgeData.hasSourceSwaps) {
      await expect(mutData((d) => setWord(d, 4 + facetOff(d) + 5 * 32, 1n))).rejects.toThrow(/outputAmountMultiplier/);
      // one unit of minAmount under a multiplier raised so that minAmount × multiplier / 1e18 stays the quoted floor: the minimum would
      // rest on nothing the source swap guarantees (its own floor on chain is minAmount) → refused (audit 2026-10-16)
      const word = (d: string, at: number) => BigInt("0x" + d.slice(2 + 2 * at, 2 + 2 * at + 64));
      await expect(
        mutData((d) => {
          const floor = (word(d, 4 + bdOff(d) + 6 * 32) * word(d, 4 + facetOff(d) + 5 * 32)) / 10n ** 18n;
          return setWord(setWord(d, 4 + bdOff(d) + 6 * 32, 1n), 4 + facetOff(d) + 5 * 32, floor * 10n ** 18n);
        }),
      ).rejects.toThrow(/asks Across for more than the swap bridges/);
    }
    await expect(mutData((d) => setWord(d, 4 + facetOff(d) + 3 * 32, padAddress(ATTACKER)))).rejects.toThrow(/receivingAssetId/);
    await expect(mutData((d) => setWord(d, 4 + facetOff(d) + 1 * 32, padAddress(ATTACKER)))).rejects.toThrow(/refundAddress/);
  }, 90_000);
  // one live ETH → SOL quote for both Mayan facet tests, read as LI.FI answered it (quote() may refuse it: PP-S08)
  const reqSol: QuoteRequest = { from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, source: ESCROW, slippageBps: 50 };
  let solRaw: Promise<any> | undefined;
  const rawSol = () => (solRaw ??= a.rawQuote(reqSol));
  const mayanWord = (raw: any, word: number, v: bigint | string) => {
    const b = structuredClone(raw);
    b.transactionRequest.data = setWord(b.transactionRequest.data, 4 + facetOff(b.transactionRequest.data) + word * 32, v);
    return b;
  };
  it("Mayan facet (ETH → SOL): nonEVMReceiver rewritten → refused; a swap into a token the escrow cannot re-shield → not offered; unverifiable min-out → refused by the engine under best-privacy", async () => {
    const raw = await rawSol();
    if (raw.tool !== "mayan") {
      console.info(`LI.FI routed ETH -> SOL via ${raw.tool}, not the Mayan facet: nothing to check here`);
      return;
    }
    expect(() => verifyLifiTransaction(reqSol, mayanWord(raw, 0, "ab".repeat(32)))).toThrow(/nonEVMReceiver/);
    const bd = decodeLifiCall(raw.transactionRequest.data).bridgeData;
    const asQuoted = () => withTamper([{ match: "li.quest/v1/quote", offline: true, json: () => structuredClone(raw) }], () => a.quote(reqSol));
    if (bd.hasSourceSwaps && !escrowCanReshield(ETH, bd.sendingAssetId)) {
      // LI.FI swaps ETH into another token before Mayan: the facet sweeps the surplus to the escrow in it (PP-S08)
      console.info(`LI.FI's ETH -> SOL Mayan route swaps into ${bd.sendingAssetId} first: not offered (PP-S08)`);
      expect(() => verifyLifiTransaction(reqSol, raw)).toThrow(/cannot re-shield/);
      await expect(asQuoted()).rejects.toThrow(/cannot re-shield/);
      return;
    }
    let verified: string[];
    try {
      verified = verifyLifiTransaction(reqSol, raw).verified;
    } catch (e) {
      if (/destination call/.test(String(e))) return;
      throw e;
    }
    expect(verified).toContain("receiver (mayan nonEVMReceiver)");
    const q = await asQuoted();
    expect(q.minOutVerified).toBe(false);
    const engine = defaultEngine({ tips: shareTips(25n) });
    const order = engine.buildOrder(reqSol, "best-privacy", { ...q, executorTip: (reqSol.amount * 25n) / 10_000n }, KEYS); // V6: an adapter's own quote names no tip (quoteAll stamps it)
    // prepareExecution quotes LI.FI again, live: by then its route may swap ETH into a token the escrow cannot re-shield —
    // refused for that reason (PP-S08) before the minimum is weighed; either refusal is the engine's, never an execution.
    // A rate-limited second quote (HTTP 429) leaves the minimum check unreached this run: said, not counted as a defect.
    const refusal = await engine.prepareExecution(order, a).then(
      () => null,
      (e: Error) => e,
    );
    expect(refusal, "an execution was prepared on a minimum nobody verified").not.toBeNull();
    if (/HTTP 429/.test(refusal!.message)) {
      console.info("LI.FI rate-limited the second quote: the unverifiable-minimum refusal could not be reached this run");
      return;
    }
    expect(refusal!.message).toMatch(/cannot be verified locally|through a swap into/);
  }, 90_000);
  it("Mayan facet: refundRecipient swapped or mayanAmountIn lowered (the facet sweeps the rest there) → refused", async () => {
    const raw = await rawSol();
    if (raw.tool !== "mayan") return;
    expect(() => verifyLifiTransaction(reqSol, mayanWord(raw, 7, padAddress(ATTACKER)))).toThrow(/refundRecipient/);
    expect(() => verifyLifiTransaction(reqSol, mayanWord(raw, 8, 1n))).toThrow(/mayanAmountIn/);
  }, 90_000);
  it("a source swap into a token the escrow cannot re-shield (here USDT) → not offered: an unfilled deposit would refund it into the ETH escrow (PP-S08)", async () => {
    const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"; // what LI.FI swapped ETH into for ETH → USDC (Base) on 2026-10-07
    await expect(mutData((d) => setWord(setWord(d, 4 + bdOff(d) + 4 * 32, padAddress(USDT)), 4 + facetOff(d) + 2 * 32, padAddress(USDT)))).rejects.toThrow(
      /cannot re-shield/,
    );
  }, 60_000);
  it("a facet this adapter cannot read is not offered, under any policy", async () => {
    const { req, q } = await verifiablePair();
    await expect(
      withTamper(
        [
          {
            match: "li.quest/v1/quote",
            offline: true,
            json: () => {
              const b = structuredClone(q.raw) as any;
              b.transactionRequest.data = "0xdeadbeef" + b.transactionRequest.data.slice(10);
              return b;
            },
          },
        ],
        () => a.quote(req),
      ),
    ).rejects.toThrow(/cannot verify/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 THORChain gateway malicious — inbound vault/router need a gateway quorum (live, tampered)", () => {
  const a = new ThorchainAdapter();
  const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, source: ESCROW, slippageBps: 50 };
  // when too few public gateways answer, the quorum cannot be reached untampered and the product correctly
  // fails closed — those tests are skipped with the reason
  const quorumUp = async (ctx: { skip: () => void }) => {
    try {
      return await inboundQuorum("ETH");
    } catch (e) {
      console.warn(`skipping: ${(e as Error).message}`);
      ctx.skip();
      throw e;
    }
  };
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
    await expect(
      withTamper(
        [{ match: THORNODE_URLS[0] + "/thorchain/inbound_addresses", json: (b) => b.map((c: any) => (c.chain === "ETH" ? { ...c, router: ATTACKER } : c)) }],
        () => inboundQuorum("ETH"),
      ),
    ).rejects.toThrow(/disagree/);
  }, 60_000);
  it("all gateways agree on another router → refused: the Ethereum router is pinned", async (ctx) => {
    await quorumUp(ctx);
    await expect(
      withTamper([{ match: "/thorchain/inbound_addresses", json: (b) => b.map((c: any) => (c.chain === "ETH" ? { ...c, router: ATTACKER } : c)) }], async () =>
        a.prepareIngress(req, await a.quote(req)),
      ),
    ).rejects.toThrow(/pinned Ethereum router/);
  }, 90_000);
  it("an escrow-sourced memo without the escrow as refund address is never produced", async () => {
    // a router deposit refunds to the transaction sender (the relayer) unless the memo names a refund address
    const q = { raw: { inbound_address: "0x0", memo: "", min1e8: "1" } } as any;
    await expect(a.prepareIngress({ ...req, source: undefined }, q)).rejects.toThrow(/refund address/);
  });
  it("only one gateway reachable → quorum not reached → refused", async () => {
    await expect(
      withTamper(
        THORNODE_URLS.slice(1).map((u) => ({ match: u, fail: true })),
        () => inboundQuorum("ETH"),
      ),
    ).rejects.toThrow(/quorum not reached/);
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
      // a streamed plan (whale spec §12) adds its explicit interval and quantity; everything else comes from the request
      expect(ing.memo).toMatch(new RegExp(`^=:BTC\\.BTC:${DEST_BTC}/${ESCROW}:${(q.raw as any).min1e8}(/1/\\d+)?$`));
      expect(Buffer.from(ing.calldata.slice(2), "hex").toString("latin1")).not.toContain("bc1qattacker");
    });
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 Chainflip backend malicious — vault pinned, calldata decoded and compared (live, tampered)", () => {
  const a = new ChainflipAdapter();
  const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, source: ESCROW, slippageBps: 250 };
  const tamperEncode = (mut: (b: any) => any) =>
    withTamper([{ match: "encodeVaultSwapData", json: mut }], async () => a.prepareIngress(req, await a.quote(req)));
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
    await expect(tamperEncode((b) => ({ ...b, calldata: replaceHex(b.calldata, Buffer.from(DEST_BTC, "utf8").toString("hex"), other) }))).rejects.toThrow(
      /destination address mismatch/,
    );
  }, 60_000);
  it("minimum price zeroed → refused", async () => {
    const q = await a.quote(req);
    const le = leHex32(BigInt((q.raw as any).minPriceX128));
    await expect(
      withTamper([{ match: "encodeVaultSwapData", json: (b) => ({ ...b, calldata: replaceHex(b.calldata, le, "00".repeat(32)) }) }], () =>
        a.prepareIngress(req, q),
      ),
    ).rejects.toThrow(/min price mismatch/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 Mayan API malicious — payload built locally, contracts pinned, claimed minimum checked (live, tampered)", () => {
  const a = new MayanAdapter({ orderTypes: ["FAST_MCTP"] });
  const req: QuoteRequest = { from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, source: ESCROW, slippageBps: 100 };
  const tamperQuote = (mut: (q: any) => any) =>
    withTamper([{ match: "mayan.finance/v3/quote", json: (b) => ({ ...b, quotes: (b.quotes ?? []).map(mut) }) }], () => a.quote(req));
  it("minAmountOut lowered → refused", async () => {
    await expect(tamperQuote((q) => ({ ...q, minAmountOut: q.minAmountOut * 0.5, minAmountOutBaseUnits: undefined }))).rejects.toThrow(/bps below/);
  }, 60_000);
  it("Fast-MCTP contract swapped → refused", async () => {
    await expect(tamperQuote((q) => ({ ...q, fastMctpMayanContract: ATTACKER }))).rejects.toThrow(/pinned/);
  }, 60_000);
  it("amountIn changed → refused", async () => {
    await expect(tamperQuote((q) => ({ ...q, effectiveAmountIn64: "1" }))).rejects.toThrow(/differs from the requested amount/);
  }, 60_000);
  // bounded as SWIFT is (audit 2026-10-16): Mayan's FastMCTP pays refundFee to whoever calls refund, and holds the USDC until the deadline
  const now = () => Math.floor(Date.now() / 1000);
  const bounded: [string, (q: any) => any, RegExp][] = [
    ["the refund fee raised to the order", (q) => ({ ...q, refundRelayerFee64: String(2_000_000_000n) }), /fees/],
    ["the deadline a year ahead", (q) => ({ ...q, deadline64: String(now() + 365 * 86400) }), /deadline/],
    ["a gas drop", (q) => ({ ...q, gasDrop: 0.1 }), /gas drop/],
    ["another token out", (q) => ({ ...q, toToken: { ...q.toToken, contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } }), /delivers/],
  ];
  for (const [name, mut, why] of bounded)
    it(`${name} → refused`, async () => {
      await expect(tamperQuote(mut)).rejects.toThrow(why);
    }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 Mayan SWIFT API malicious — the order built locally, Swift V2 and the wrapper pinned, fees and deadline bounded (live, tampered)", () => {
  const a = new MayanAdapter({ orderTypes: ["SWIFT"] });
  const req: QuoteRequest = { from: ETH, to: SOL, amount: 10n ** 18n, destination: DEST_SOL, source: ESCROW, slippageBps: 100 };
  const tamperQuote = (mut: (q: any) => any) =>
    withTamper(
      [{ match: "mayan.finance/v3/quote", json: (b) => ({ ...b, quotes: (b.quotes ?? []).map((q: any) => (q.type === "SWIFT" ? mut(q) : q)) }) }],
      () => a.quote(req),
    );
  const now = () => Math.floor(Date.now() / 1000);
  const cases: [string, (q: any) => any, RegExp][] = [
    ["the Swift contract swapped", (q) => ({ ...q, swiftMayanContract: ATTACKER }), /pinned/],
    ["Swift V1 (no wrap & lock, another contract)", (q) => ({ ...q, swiftVersion: "V1" }), /V2 only/],
    ["an ETH order through a swap into USDC", (q) => ({ ...q, swiftInputContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }), /wrap & lock/],
    ["an ETH order locked as WETH (refunded as WETH)", (q) => ({ ...q, swiftWrapAndLock: false }), /wrap & lock/],
    ["the refund fee raised above 1%", (q) => ({ ...q, refundRelayerFee64: String(10n ** 8n / 100n + 1n) }), /fees/],
    ["the deadline 7 h ahead", (q) => ({ ...q, deadline64: String(now() + 7 * 3600) }), /deadline/],
    ["the deadline too close to fill", (q) => ({ ...q, deadline64: String(now() + 300) }), /deadline/],
    ["minAmountOut halved", (q) => ({ ...q, minAmountOut: q.minAmountOut * 0.5, minAmountOutBaseUnits: undefined }), /bps below/],
    ["another token out", (q) => ({ ...q, toToken: { ...q.toToken, contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } }), /delivers/],
    ["a gas drop", (q) => ({ ...q, gasDrop: 0.1 }), /gas drop/],
    ["amountIn changed", (q) => ({ ...q, effectiveAmountIn64: "1" }), /differs from the requested amount/],
  ];
  for (const [name, mut, why] of cases)
    it(`${name} → refused`, async () => {
      await expect(tamperQuote(mut)).rejects.toThrow(why);
    }, 60_000);
  it("the API's router calldata is not used: a tampered get-swap answer changes nothing (the pinned wrapper's wrap())", async () => {
    const q = await a.quote(req);
    const ing = await withTamper(
      [{ match: "get-swap/evm", offline: true, status: 200, json: () => ({ swapRouterAddress: ATTACKER, swapRouterCalldata: "0xdeadbeef" }) }],
      () => a.prepareIngress(req, q),
    );
    const outer = decodeParams(hexBuf(ing.calldata).subarray(4), ["uint", "address", "bytes", "address", "uint", "address", "bytes"]);
    expect([outer[1], (outer[2] as Buffer).toString("hex"), outer[4]]).toEqual([MAYAN_ETH_WRAPPER, "d46eb119", 10n ** 18n]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 Across / 1Click API malicious (live, tampered)", () => {
  it("Across SpokePool swapped → refused", async () => {
    const a = new AcrossAdapter();
    await expect(
      withTamper([{ match: "suggested-fees", json: (b) => ({ ...b, spokePoolAddress: ATTACKER }) }], () =>
        a.quote({ from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 }),
      ),
    ).rejects.toThrow(/unexpected SpokePool/);
  }, 60_000);
  it("Across outputAmount lowered → the exact-fill quote is worse and the price guard refuses it against a live alternative", async () => {
    const a = new AcrossAdapter();
    const req: QuoteRequest = { from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 };
    const honest = await a.quote(req);
    const worse = await withTamper([{ match: "suggested-fees", json: (b) => ({ ...b, outputAmount: ((BigInt(b.outputAmount) * 7n) / 10n).toString() }) }], () =>
      a.quote(req),
    );
    expect(worse.toAmountMin).toBeLessThan(honest.toAmountMin);
    const alt: Quote = { ...honest, provider: "lifi" };
    expect(() => priceGuard(worse, [alt], 300)).toThrow(/bps below the best alternative/);
    expect(() => priceGuard(honest, [alt], 300)).not.toThrow();
  }, 60_000);
  it("1Click minAmountOut lowered → refused", async () => {
    const a = new NearIntentsAdapter();
    await expect(
      withTamper([{ match: "/v0/quote", json: (b) => ({ ...b, quote: { ...b.quote, minAmountOut: (BigInt(b.quote.minAmountOut) / 2n).toString() } }) }], () =>
        a.quote({ from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, source: ESCROW, slippageBps: 100 }),
      ),
    ).rejects.toThrow(/bps below/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
describe("§74 Across Swap API malicious — the periphery call and the handler message are read (live, tampered)", () => {
  const a = new AcrossAdapter();
  const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const req: QuoteRequest = { from: ETH, to: USDC_BASE, amount: 10n ** 18n, destination: DEST_EVM, source: ESCROW, slippageBps: 50 };
  const withPool = async <T>(f: () => Promise<T>) => {
    const saved = process.env.ERC20_VAULTS;
    process.env.ERC20_VAULTS = `${USDC_ETH}:0x00000000000000000000000000000000000ca5de`;
    try {
      return await f();
    } finally {
      if (saved === undefined) delete process.env.ERC20_VAULTS;
      else process.env.ERC20_VAULTS = saved;
    }
  };
  let live: Promise<any> | undefined; // one live Swap API answer for the whole group
  const raw = () => (live ??= withPool(() => a.quote(req)).then((q) => q.raw));
  // byte offsets inside swapAndBridge calldata: the tuple, its BaseDepositData, the handler message's Instructions
  const w = (d: string, at: number) => BigInt("0x" + d.slice(2 + 2 * at, 2 + 2 * at + 64));
  const layout = (d: string) => {
    const t = 4 + Number(w(d, 4));
    const dd = t + Number(w(d, t + 64));
    const msg = dd + Number(w(d, dd + 320));
    return { t, dd, ins: msg + 32 + Number(w(d, msg + 32)) };
  };
  const bent = (mut: (b: any) => any, prepare = true) =>
    withPool(async () => {
      const b = mut(structuredClone(await raw()));
      return withTamper([{ match: "/swap/approval", offline: true, json: () => b }], async () => {
        const q = await a.quote(req);
        return prepare ? a.prepareIngress(req, q) : q;
      });
    });
  const data = (f: (d: string) => string) => (b: any) => {
    b.swapTx.data = f(b.swapTx.data);
    return b;
  };

  it("untampered: the swap leg verifies (the pinned handler drains to the fresh address)", async () => {
    const ing: any = await bent((b) => b);
    expect(ing.verified).toEqual(
      expect.arrayContaining(["spokePool pinned", "depositor=escrow", "receiver (pinned handler drains to it)", "swap floor covers the output"]),
    );
  }, 60_000);
  it("SpokePool swapped (the periphery would approve it for the swapped tokens) → refused", async () => {
    await expect(bent(data((d) => setWord(d, layout(d).t + 10 * 32, padAddress(ATTACKER))))).rejects.toThrow(/pinned SpokePool/);
  }, 60_000);
  it("depositor rewritten (an unfilled deposit is refunded to it) → refused", async () => {
    await expect(bent(data((d) => setWord(d, layout(d).dd + 3 * 32, padAddress(ATTACKER))))).rejects.toThrow(/depositor is not the escrow/);
  }, 60_000);
  it("the handler drains to another address → refused", async () => {
    await expect(bent(data((d) => replaceHex(d, padAddress(DEST_EVM), padAddress(ATTACKER))))).rejects.toThrow(/drain/);
  }, 60_000);
  it("another contract called on the destination (the emitter swapped) → refused", async () => {
    await expect(bent(data((d) => replaceHex(d, padAddress(ACROSS_EVENT_EMITTER.base), padAddress(ATTACKER))))).rejects.toThrow(/does not accept/);
  }, 60_000);
  it("a fallback recipient that is not the fresh address → refused", async () => {
    await expect(bent(data((d) => setWord(d, layout(d).ins + 32, padAddress(ATTACKER))))).rejects.toThrow(/fallback recipient/);
  }, 60_000);
  it("outputAmount lowered → refused at quote time (a changed quote)", async () => {
    await expect(
      bent(
        data((d) => setWord(d, layout(d).dd + 2 * 32, w(d, layout(d).dd + 2 * 32) / 2n)),
        false,
      ),
    ).rejects.toThrow(/bps below/);
  }, 60_000);
  it("the swap's own floor lowered to one unit (an exchange of the API's choosing could keep the order and return one unit) → refused at quote time (audit 2026-10-16)", async () => {
    await expect(
      bent(
        data((d) => setWord(d, layout(d).t + 7 * 32, 1n)),
        false,
      ),
    ).rejects.toThrow(/does not cover the deposit's output/);
  }, 60_000);
  it("a destination-swap route (bridgeableToAny) or another target than the periphery → not offered", async () => {
    await expect(bent((b) => ({ ...b, crossSwapType: "bridgeableToAny" }), false)).rejects.toThrow(/bridgeableToAny/);
    await expect(
      bent((b) => {
        b.swapTx.to = ATTACKER;
        return b;
      }, false),
    ).rejects.toThrow(/pinned SpokePoolPeriphery/);
  }, 60_000);
});

describe("§71 timeout / partial / refund / reorg / destination congestion — status mapping (live, tampered) + state machine", () => {
  const chain = (from: OrderState, evs: Parameters<typeof nextState>[1][]) => evs.reduce((s, e) => nextState(s, e), from);
  const order = {
    orderId: "0x01",
    state: "PROVIDER_EXECUTING",
    history: [],
    params: { amount: 100n, executeDeadline: 1000, refundAfter: 2000 },
    quote: { expiresAt: 900 },
  } as unknown as Order;

  it("LI.FI DONE/PARTIAL → partial → PARTIAL → refund of the remainder", async () => {
    const a = new LifiAdapter();
    const s = await withTamper(
      [
        {
          match: "/status",
          offline: true,
          json: () => ({ status: "DONE", substatus: "PARTIAL", receiving: { amount: "1", txHash: "0x01", token: { symbol: "USDC.e" } } }),
        },
      ],
      () => a.track({ sourceTxHash: "0x" + "00".repeat(32) }),
    );
    expect(s.state).toBe("partial");
    // another token at the destination: its amount is never the output's units (the audit's unverified m60)
    expect(s.deliveredAmount).toBeUndefined();
    expect(s.deliveredAsset).toBe("USDC.e");
    expect(chain("PROVIDER_EXECUTING", ["partial", "refund-window", "refunded"])).toBe("REFUNDED");
    expect(recoverState(order, { now: 2500, escrowBalance: 3n, executed: true, refunded: false, track: { state: "partial" } })).toBe("PARTIAL");
  }, 60_000);
  it("LI.FI DONE/REFUNDED and FAILED map to refunded / failed → REFUND_PENDING after the window", async () => {
    const a = new LifiAdapter();
    const r = await withTamper([{ match: "/status", offline: true, json: () => ({ status: "DONE", substatus: "REFUNDED" }) }], () =>
      a.track({ sourceTxHash: "0x" + "00".repeat(32) }),
    );
    expect(r.state).toBe("refunded");
    const f = await withTamper([{ match: "/status", offline: true, json: () => ({ status: "FAILED" }) }], () =>
      a.track({ sourceTxHash: "0x" + "00".repeat(32) }),
    );
    expect(f.state).toBe("failed");
    expect(recoverState(order, { now: 2500, escrowBalance: 100n, executed: true, refunded: false, track: { state: "failed" } })).toBe("REFUND_PENDING");
    expect(recoverState(order, { now: 1500, escrowBalance: 100n, executed: true, refunded: false, track: { state: "failed" } })).toBe("DESTINATION_FAILED");
  }, 60_000);
  it("Chainflip FAILED + refundEgress → refunded; SENDING → destination-submitted (congestion: never refunded while in flight)", async () => {
    const a = new ChainflipAdapter();
    const r = await withTamper([{ match: "/v2/swaps/", offline: true, status: 200, json: () => ({ state: "FAILED", refundEgress: { amount: "1" } }) }], () =>
      a.track({ sourceTxHash: "0x" + "11".repeat(32) }),
    );
    expect(r.state).toBe("refunded");
    const s = await withTamper([{ match: "/v2/swaps/", offline: true, status: 200, json: () => ({ state: "SENDING", swapEgress: { txRef: "abc" } }) }], () =>
      a.track({ sourceTxHash: "0x" + "11".repeat(32) }),
    );
    expect(s.state).toBe("destination-submitted");
    expect(recoverState(order, { now: 99_999, escrowBalance: 0n, executed: true, refunded: false, track: { state: "destination-submitted" } })).toBe(
      "DESTINATION_SUBMITTED",
    );
    expect(chain("PROVIDER_EXECUTING", ["provider-timeout", "destination-submitted", "destination-final", "completed"])).toBe("COMPLETED"); // a late delivery still completes
  }, 60_000);
  it("Across expired → refunded; filled → completed", async () => {
    const a = new AcrossAdapter();
    const r = await withTamper([{ match: "deposit/status", offline: true, status: 200, json: () => ({ status: "expired" }) }], () =>
      a.track({ sourceTxHash: "0x" + "33".repeat(32), providerRef: "1" }),
    );
    expect(r.state).toBe("refunded");
    const f = await withTamper([{ match: "deposit/status", offline: true, status: 200, json: () => ({ status: "filled", fillTx: "0xf" }) }], () =>
      a.track({ sourceTxHash: "0x" + "33".repeat(32), providerRef: "1" }),
    );
    expect(f.state).toBe("completed");
    expect(f.destinationTxHash).toBe("0xf");
  }, 60_000);
  it("Mayan REFUNDED → refunded; 1Click REFUNDED / PROCESSING → refunded / executing; THORChain stages → executing / destination-final", async () => {
    const m = await withTamper([{ match: "/swap/trx/", offline: true, status: 200, json: () => ({ clientStatus: "REFUNDED" }) }], () =>
      new MayanAdapter().track({ sourceTxHash: "0x" + "22".repeat(32) }),
    );
    expect(m.state).toBe("refunded");
    const n1 = await withTamper([{ match: "/v0/status", offline: true, status: 200, json: () => ({ status: "REFUNDED" }) }], () =>
      new NearIntentsAdapter().track({ providerRef: "0xdead" }),
    );
    expect(n1.state).toBe("refunded");
    const n2 = await withTamper([{ match: "/v0/status", offline: true, status: 200, json: () => ({ status: "PROCESSING" }) }], () =>
      new NearIntentsAdapter().track({ providerRef: "0xdead" }),
    );
    expect(n2.state).toBe("executing");
    const t1 = await withTamper(
      [{ match: "/thorchain/tx/status/", offline: true, status: 200, json: () => ({ stages: { inbound_observed: { started: true } } }) }],
      () => new ThorchainAdapter().track({ sourceTxHash: "0x" + "44".repeat(32) }),
    );
    expect(t1.state).toBe("executing");
    const t2 = await withTamper(
      [
        {
          match: "/thorchain/tx/status/",
          offline: true,
          status: 200,
          json: () => ({ stages: { outbound_signed: { completed: true } }, out_txs: [{ id: "ABC", coins: [{ amount: "12345", asset: "BTC.BTC" }] }] }),
        },
      ],
      () => new ThorchainAdapter().track({ sourceTxHash: "0x" + "44".repeat(32) }),
    );
    expect(t2.state).toBe("destination-final");
    expect(t2.deliveredAmount).toBe(12345n);
    // THORNode's amounts are 1e8 units: an ETH delivery and a USDC refund in their own base units (the audit round of 2026-10-16, c25)
    const status = () => ({
      stages: { outbound_signed: { completed: true } },
      out_txs: [
        { id: "OUT", memo: "OUT:X", coins: [{ amount: "250000000", asset: "ETH.ETH" }] },
        { id: "BACK", memo: "REFUND:X", coins: [{ amount: "1000000000", asset: "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48" }] },
      ],
    });
    const t3 = await withTamper([{ match: "/thorchain/tx/status/", offline: true, status: 200, json: status }], () =>
      new ThorchainAdapter().track({ sourceTxHash: "0x" + "44".repeat(32), decimals: { out: 18, in: 6 } }),
    );
    expect(t3).toMatchObject({ state: "partial", deliveredAmount: 25n * 10n ** 17n, refundedAmount: 10n * 10n ** 6n });
    const t4 = await withTamper([{ match: "/thorchain/tx/status/", offline: true, status: 200, json: status }], () =>
      new ThorchainAdapter().track({ sourceTxHash: "0x" + "44".repeat(32) }),
    );
    expect(t4.deliveredAmount, "a native asset: its own decimals").toBe(25n * 10n ** 17n);
    expect(t4.refundedAmount, "a token whose decimals are not given: no amount rather than a wrong one").toBeUndefined();
  }, 90_000);
  it("provider timeout: funded, executed, nothing delivered → REFUND_PENDING once the window opens, not before", () => {
    expect(recoverState(order, { now: 1500, escrowBalance: 100n, executed: true, refunded: false, track: { state: "pending" } })).toBe("PROVIDER_EXECUTING");
    expect(recoverState(order, { now: 2500, escrowBalance: 100n, executed: true, refunded: false, track: { state: "pending" } })).toBe("REFUND_PENDING");
    expect(chain("SOURCE_FINAL", ["provider-timeout", "refund-window", "refunded"])).toBe("REFUNDED");
    // never executed at all (provider down for the whole window): the escrow itself is refundable
    expect(recoverState({ ...order, state: "SOURCE_FINAL" } as Order, { now: 2500, escrowBalance: 100n, executed: false, refunded: false })).toBe(
      "REFUND_PENDING",
    );
  });
  it("chain reorg: the source transaction disappears → SOURCE_FAILED → resubmitted; recovery sees an unfunded escrow as still submitted", () => {
    expect(chain("SOURCE_SUBMITTED", ["source-failed", "submit-source", "source-final"])).toBe("SOURCE_FINAL");
    expect(recoverState({ ...order, state: "SOURCE_SUBMITTED" } as Order, { now: 500, escrowBalance: 0n, executed: false, refunded: false })).toBe(
      "SOURCE_SUBMITTED",
    );
    expect(recoverState({ ...order, state: "SOURCE_SUBMITTED" } as Order, { now: 500, escrowBalance: 100n, executed: false, refunded: false })).toBe(
      "SOURCE_FINAL",
    );
  });
  it("wrong destination / token / chain after signing = different calldata = different digest = different signature (forge: TamperedCalldata_Rejected)", () => {
    const d1 = executionDigest(1n, ESCROW, "0x" + "01".repeat(32), ATTACKER, 1n, "0x1234", 100);
    const d2 = executionDigest(1n, ESCROW, "0x" + "01".repeat(32), ATTACKER, 1n, "0x1235", 100);
    expect(d1).not.toBe(d2);
  });
});
