// Cross-chain privacy tests (plan §72, step 17), LIVE: for every route the engine can execute, the
// permanent wallet MUST NOT appear anywhere in the provider flow — not in a request URL, body or
// header, not in the calldata / memo the order key signs, not in the order object. What the
// provider sees is the one-time escrow (source endpoint) and the fresh destination address. The
// observer-side analysis of amount and timing is the cross-chain lab (src/sim/crossChainLab.ts).
import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { recordFetch, type RecordedCall } from "./helpers/tamper";
import { defaultEngine } from "../src/config";
import { orderSignerAddress } from "../src/endpoints";
import { cfAsset, decodeVaultSwapCalldata, encodeDestination } from "../src/adapters/chainflip";
import { decodeLifiCall } from "../src/adapters/lifi";
import { decodeParams, hexBuf } from "../src/abi";
import type { AssetRef, Order, Quote, QuoteRequest } from "../src/types";

const PERMANENT_KEY = sha256(new TextEncoder().encode("the user's permanent wallet key: never handed to the engine"));
const PERMANENT = orderSignerAddress(PERMANENT_KEY); // the address an observer would try to find
const ORDER_KEY = sha256(new TextEncoder().encode("one-time order key"));
const ORDER_SIGNER = orderSignerAddress(ORDER_KEY);
const KEYS = { orderSigner: ORDER_SIGNER, refundOwnerCommitment: 0x1234n, refundNoteSecret: 0x5678n, refundNoteDataHash: ("0x" + "ab".repeat(32)) as `0x${string}` };
const ALLOWED_HEADERS = new Set(["accept", "content-type", "x-lifi-api-key"]);
const FORBIDDEN = [PERMANENT.toLowerCase(), PERMANENT.toLowerCase().slice(2), Buffer.from(ORDER_KEY).toString("hex"), Buffer.from(PERMANENT_KEY).toString("hex")];

const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const USDC_ETH: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
const USDC_BASE: AssetRef = { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
const USDC_VAULT = "0x00000000000000000000000000000000000ca5de"; // the canonical USDC vault a failed order re-shields into (plan §36)
process.env.ERC20_VAULTS = `${USDC_ETH.asset}:${USDC_VAULT}`;
const DEST_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const DEST_EVM = "0x1111111111111111111111111111111111111111";
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function scanCalls(calls: RecordedCall[], label: string) {
  expect(calls.length, `${label}: no requests recorded`).toBeGreaterThan(0);
  for (const c of calls) {
    const hay = (c.url + " " + (c.body ?? "")).toLowerCase();
    for (const f of FORBIDDEN) expect(hay, `${label}: ${c.url} carries forbidden material`).not.toContain(f);
    for (const k of Object.keys(c.headers)) expect(ALLOWED_HEADERS.has(k.toLowerCase()), `${label}: unexpected header ${k} on ${c.url}`).toBe(true);
  }
}

async function runRoute(req: QuoteRequest) {
  const engine = defaultEngine();
  const prepared: { order: Order; provider: string; calldata: string; memo?: string; to: string; digest: string }[] = [];
  const skipped: Record<string, string> = {};
  const calls = await recordFetch(async (calls) => {
    const set = await engine.quoteAll(req, "fastest"); // no policy refusals: the point here is the flow, not route choice
    expect(set.quotes.length).toBeGreaterThan(0);
    for (const q of set.quotes) {
      const adapter = engine.cfg.adapters.find((a) => a.id === q.provider)!;
      if (adapter.capabilities().contractSender === false) { skipped[q.provider] = "ingress withheld (contract-sender deposits unconfirmed)"; continue; }
      const order = engine.buildOrder(req, "fastest", q, KEYS);
      try {
        const p = await engine.prepareExecution(order, adapter);
        prepared.push({ order, provider: q.provider, calldata: p.calldata, memo: p.ingress.memo, to: p.ingress.to, digest: p.digest });
      } catch (e) {
        skipped[q.provider] = String((e as Error).message);
      }
    }
    return calls;
  });
  return { calls, prepared, skipped, net: engine.net(req).amount };
}

describe("§72 — the permanent wallet never appears in any provider flow (live)", () => {
  it("ETH → BTC: THORChain / Chainflip (NEAR Intents quoted only): requests, signed calldata and orders are clean; endpoints are the escrow and the fresh address", async () => {
    const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 100 };
    const { calls, prepared, skipped, net } = await runRoute(req);
    scanCalls(calls, "ETH->BTC");
    expect(prepared.map((p) => p.provider).sort()).toEqual(expect.arrayContaining(["chainflip", "thorchain"]));
    expect(skipped["near-intents"]).toMatch(/withheld/);
    for (const p of prepared) {
      const hay = (p.calldata + " " + (p.memo ?? "") + " " + json(p.order) + " " + p.digest).toLowerCase();
      for (const f of FORBIDDEN) expect(hay, `${p.provider}: signed material carries forbidden content`).not.toContain(f);
      expect(json(p.order)).toContain(ORDER_SIGNER); // the one-time signer is the only key material in the order
      const escrow = p.order.endpoint.toLowerCase().slice(2);
      if (p.provider === "chainflip") {
        const d = decodeVaultSwapCalldata(p.calldata);
        expect(d.cf.refundAddress.toLowerCase().slice(2)).toBe(escrow); // refunds land at the one-time escrow
        expect(d.dstAddress.equals(encodeDestination(cfAsset(BTC).chain, DEST_BTC))).toBe(true);
        expect(calls.some((c) => (c.body ?? "").toLowerCase().includes(escrow))).toBe(true); // the escrow is the only sender the provider ever sees
      }
      if (p.provider === "thorchain") {
        expect(p.memo).toBe(`=:BTC.BTC:${DEST_BTC}/${p.order.endpoint}:${(p.order.quote.raw as any).min1e8}`); // a THORChain refund lands in the escrow
        const [vault, asset, amount] = decodeParams(hexBuf(p.calldata).subarray(4), ["address", "address", "uint"]);
        expect(amount).toBe(net);
        expect(String(asset)).toBe("0x" + "00".repeat(20));
        expect(String(vault)).toMatch(/^0x[0-9a-f]{40}$/);
      }
    }
  }, 240_000);

  it("ETH → ETH (Base): Across / LI.FI / Mayan: the escrow is the depositor / sender / refund target, the fresh address the receiver", async () => {
    const req: QuoteRequest = { from: ETH, to: ETH_BASE, amount: 10n ** 18n, destination: DEST_EVM, slippageBps: 50 };
    const { calls, prepared, skipped } = await runRoute(req);
    scanCalls(calls, "ETH->ETH(Base)");
    expect(prepared.length, `prepared none; skipped: ${json(skipped)}`).toBeGreaterThan(0);
    expect(prepared.map((p) => p.provider)).toContain("uniswap-across");
    for (const p of prepared) {
      const hay = (p.calldata + " " + json(p.order) + " " + p.digest).toLowerCase();
      for (const f of FORBIDDEN) expect(hay, `${p.provider}: signed material carries forbidden content`).not.toContain(f);
      const escrow = p.order.endpoint.toLowerCase();
      if (p.provider === "uniswap-across") {
        const f = decodeParams(hexBuf(p.calldata).subarray(4), ["address", "address"]);
        expect(String(f[0])).toBe(escrow); // depositor (refund target) = escrow
        expect(String(f[1])).toBe(DEST_EVM);
        expect(calls.some((c) => c.url.toLowerCase().includes(`depositor=${escrow}`))).toBe(true);
      }
      if (p.provider === "lifi") {
        const d = decodeLifiCall(p.calldata);
        expect(d.bridgeData.receiver).toBe(DEST_EVM);
        expect(calls.some((c) => c.url.toLowerCase().includes(`fromaddress=${escrow}`))).toBe(true);
      }
    }
  }, 240_000);

  it("USDC (Ethereum) → BTC and → USDC (Base): an ERC-20 order forwards no value, the provider pulls the tokens from the escrow, the refund re-shields into the USDC vault", async () => {
    for (const [label, req] of [
      ["USDC->BTC", { from: USDC_ETH, to: BTC, amount: 1_000_000_000n, destination: DEST_BTC, slippageBps: 100 } as QuoteRequest],
      ["USDC->USDC(Base)", { from: USDC_ETH, to: USDC_BASE, amount: 1_000_000_000n, destination: DEST_EVM, slippageBps: 50 } as QuoteRequest],
    ] as const) {
      const { calls, prepared, skipped } = await runRoute(req);
      scanCalls(calls, label);
      expect(prepared.length, `${label}: prepared none; skipped: ${json(skipped)}`).toBeGreaterThan(0);
      for (const p of prepared) {
        const escrow = p.order.endpoint.toLowerCase();
        expect(p.order.params.assetType, `${label}/${p.provider}`).toBe(1);
        expect(p.order.params.asset.toLowerCase()).toBe(USDC_ETH.asset.toLowerCase());
        expect(p.order.params.refundVault.toLowerCase()).toBe(USDC_VAULT);
        expect(p.order.ingress.value, `${label}/${p.provider}: an ERC-20 order forwards no ETH`).toBe(0n);
        const hay = (p.calldata + " " + json(p.order) + " " + p.digest).toLowerCase();
        for (const f of FORBIDDEN) expect(hay, `${label}/${p.provider}: signed material carries forbidden content`).not.toContain(f);
        // the token the provider pulls (approved by the escrow inside execute) is named in the calldata or the memo-less transfer,
        // never a wrapped stand-in; the escrow is the sender the provider was quoted for
        if (p.order.ingress.kind === "contract-call") expect(hay, `${label}/${p.provider}: calldata does not name USDC`).toContain(USDC_ETH.asset.toLowerCase().slice(2));
        // providers that quote per sender were quoted for the escrow (THORChain / Chainflip quotes carry no sender)
        if (p.provider === "lifi") {
          expect(decodeLifiCall(p.calldata).bridgeData.receiver).toBe(DEST_EVM);
          expect(calls.some((c) => c.url.toLowerCase().includes(`fromaddress=${escrow}`)), `${label}/lifi: not quoted for the escrow`).toBe(true);
        }
        if (p.provider === "uniswap-across") expect(calls.some((c) => c.url.toLowerCase().includes(`depositor=${escrow}`)), `${label}/across: not quoted for the escrow`).toBe(true);
      }
      console.log(`${label}: prepared ${prepared.map((p) => p.provider).join(", ")}; skipped ${json(skipped)}`);
    }
  }, 300_000);

  it("one-time endpoints: the same quote committed twice gives two different escrows, and the order holds no private key", async () => {
    const engine = defaultEngine();
    const q: Quote = { provider: "thorchain", category: "A", toAmount: 1n, toAmountMin: 1n, fees: [], etaSeconds: 1, expiresAt: Math.floor(Date.now() / 1000) + 600, nativeAssets: true, minOutEncoded: true, hops: [], raw: null, obtainedAt: Date.now() };
    const req: QuoteRequest = { from: ETH, to: BTC, amount: 10n ** 18n, destination: DEST_BTC, slippageBps: 100 };
    const o1 = engine.buildOrder(req, "best-privacy", q, KEYS);
    const o2 = engine.buildOrder(req, "best-privacy", q, KEYS);
    expect(o1.endpoint).not.toBe(o2.endpoint);
    expect(o1.orderId).not.toBe(o2.orderId);
    const s = json(o1).toLowerCase();
    for (const f of FORBIDDEN) expect(s).not.toContain(f);
    expect(s).toContain(ORDER_SIGNER.toLowerCase());
  });
});
