// The wallet's checks on the swap service (packages/sdk/src/swapGuard.ts): the escrow address is recomputed
// with the wallet's own factory exactly as SwapOrderFactory.predict (forge vector) and as the engine
// does; an honest order built by the real engine passes; every way a dishonest service could bend an
// order — another endpoint, another signer, a refund that does not come back, another amount / asset /
// refund vault, a fat tip, a locked refund — is refused before any withdrawal; and the order key signs
// only the digest of the call it is shown, within the order's limits. Offline: the engine with a stub
// adapter, no provider, no chain.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { utf8ToBytes } from "@noble/hashes/utils";
import { checkOrder, checkPrepared, executionDigestFromHash, OrderMismatch, predictEscrow, ESCROW_CREATION_CODE } from "@privacy-wallet/sdk/swapGuard";
import { deriveOrderKey, deriveRefundNote } from "@privacy-wallet/sdk/keys/swapKeys";
import type { ServiceOrder, Prepared } from "@privacy-wallet/sdk/swapService";
import type { Asset } from "@privacy-wallet/sdk/assets";
import { PrivateSwapEngine } from "@privacy-wallet/swap-engine/engine";
import { predictEscrow as enginePredict } from "@privacy-wallet/swap-engine/endpoints";
import type { Ingress, ProviderAdapter, Quote, QuoteRequest } from "@privacy-wallet/swap-engine/types";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const vec = read("../../../contracts/test/periphery/vectors/endpoint.json");
const FACTORY = "0x00000000000000000000000000000000000000f1" as const;
const ETH_VAULT = "0x00000000000000000000000000000000000000e7" as const;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const USDC_VAULT = "0x00000000000000000000000000000000000ca5de" as const;
const ETH: Asset = { symbol: "ETH", decimals: 18, vault: ETH_VAULT, token: null };
const USDC_ASSET: Asset = { symbol: "USDC", decimals: 6, vault: USDC_VAULT, token: USDC };
const engine = new PrivateSwapEngine({
  adapters: [], factory: FACTORY, escrowCreationCode: read("../../../contracts/abi/periphery/SwapOrderEscrow.json").bytecode, chainId: 1n,
  refundVaults: { native: ETH_VAULT, [USDC]: USDC_VAULT }, tipBps: 25, refundWindowSeconds: 7200,
});
const seed = utf8ToBytes("swap-guard-test-seed");
const now = () => Math.floor(Date.now() / 1000);
const quote = (): Quote => ({ provider: "thorchain", category: "A", toAmount: 1n, toAmountMin: 1n, fees: [], etaSeconds: 600, expiresAt: now() + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: {}, obtainedAt: Date.now() });
const wire = <T>(x: T): any => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v))); // what crosses HTTP

function honest(asset: Asset = ETH, amount = 10n ** 18n) {
  const key = deriveOrderKey(seed, ("0x" + "ab".repeat(32)) as `0x${string}`);
  const refund = deriveRefundNote(seed, 7);
  const req: QuoteRequest = { from: { chain: "ethereum", asset: asset.token ?? "native", decimals: asset.decimals, symbol: asset.symbol }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount, destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", slippageBps: 50 };
  const order = engine.buildOrder(req, "best-privacy", quote(), { orderSigner: key.address, refundOwnerCommitment: refund.ownerCommitment, refundNoteSecret: refund.noteSecret, refundNoteDataHash: refund.noteDataHash });
  const expectation = { factory: FACTORY as `0x${string}`, orderSigner: key.address, refund, amount, asset };
  return { order, svc: wire(order) as ServiceOrder, expectation, key, req };
}

describe("the escrow address and the execution digest, computed by the wallet", () => {
  it("equal SwapOrderFactory.predict / SwapOrderEscrow.executionDigest on the forge vector", () => {
    expect(predictEscrow(vec.factory, vec.params)).toBe(vec.predicted);
    const x = vec.execution;
    expect(executionDigestFromHash(BigInt(vec.chainId), vec.predicted, vec.params.orderId, x.provider, BigInt(x.value), x.calldataHash, x.deadline)).toBe(x.digest);
    expect(ESCROW_CREATION_CODE.length).toBeGreaterThan(1000);
  });
  it("equal the engine's prediction for any params", () => {
    for (let i = 0; i < 5; i++) {
      const { order } = honest(i % 2 ? USDC_ASSET : ETH, BigInt(1 + i) * 10n ** 17n);
      expect(predictEscrow(FACTORY, wire(order.params)).toLowerCase()).toBe(enginePredict(FACTORY, read("../../../contracts/abi/periphery/SwapOrderEscrow.json").bytecode, order.params).toLowerCase());
    }
  });
});

describe("checkOrder: what a dishonest swap service cannot slip past the wallet", () => {
  it("an honest order passes, in ETH and in an ERC-20", () => {
    for (const asset of [ETH, USDC_ASSET]) {
      const { svc, expectation } = honest(asset, asset.token ? 1_000_000_000n : 10n ** 18n);
      expect(() => checkOrder(svc, expectation)).not.toThrow();
    }
  });
  const cases: [string, (o: any) => void, RegExp][] = [
    ["its own address as the endpoint", (o) => { o.endpoint = "0x000000000000000000000000000000000000bad1"; }, /endpoint/],
    ["another order signer (and a consistent escrow for it)", (o) => { o.params.orderSigner = "0x000000000000000000000000000000000000bad2"; o.endpoint = predictEscrow(FACTORY, o.params); }, /orderSigner/],
    ["a refund note that is not ours", (o) => { o.params.refundOwnerCommitment = "12345"; o.endpoint = predictEscrow(FACTORY, o.params); }, /refund note/],
    ["another amount", (o) => { o.params.amount = (BigInt(o.params.amount) * 2n).toString(); o.endpoint = predictEscrow(FACTORY, o.params); }, /amount/],
    ["another asset", (o) => { o.params.assetType = 1; o.params.asset = USDC; o.endpoint = predictEscrow(FACTORY, o.params); }, /asset/],
    ["refunds into another vault", (o) => { o.params.refundVault = "0x000000000000000000000000000000000000bad3"; o.endpoint = predictEscrow(FACTORY, o.params); }, /refundVault/],
    ["a tip above 1 %", (o) => { o.params.executorTip = (BigInt(o.params.amount) / 50n).toString(); o.endpoint = predictEscrow(FACTORY, o.params); }, /executorTip/],
    ["an expired order", (o) => { o.params.executeDeadline = now() - 1; o.endpoint = predictEscrow(FACTORY, o.params); }, /executeDeadline/],
    ["a refund locked for a month", (o) => { o.params.refundAfter = now() + 30 * 86400; o.endpoint = predictEscrow(FACTORY, o.params); }, /refundAfter/],
    ["an escrow under another factory", (o) => { o.endpoint = predictEscrow("0x000000000000000000000000000000000000bad4", o.params); }, /endpoint/],
  ];
  for (const [what, tamper, field] of cases) {
    it(`refuses ${what}`, () => {
      const { svc, expectation } = honest();
      tamper(svc);
      expect(() => checkOrder(svc, expectation)).toThrow(OrderMismatch);
      expect(() => checkOrder(svc, expectation)).toThrow(field);
    });
  }
});

describe("checkPrepared: the order key signs only what it is shown", () => {
  const stub = (i: Ingress): ProviderAdapter => ({
    id: "thorchain", implemented: true, capabilities: () => ({ contractSender: true, destinationLinkPublic: true, linkEvidence: "test stub: memo names the destination" }) as any,
    quote: async () => quote(), prepareIngress: async () => i, track: async () => ({ state: "unknown" }), health: async () => ({}) as any,
  });
  const ROUTER = "0x00000000000000000000000000000000000c0de1";
  async function prepared(asset: Asset = ETH) {
    const h = honest(asset, asset.token ? 1_000_000_000n : 10n ** 18n);
    const value = asset.token ? 0n : BigInt(h.order.params.amount) - BigInt(h.order.params.executorTip);
    const p = await engine.prepareExecution(h.order, stub({ kind: "contract-call", to: ROUTER, calldata: "0x1234abcd", value, expiresAt: now() + 600, minOutEncoded: true }));
    return { ...h, prep: wire({ digest: p.digest, provider: p.provider, value: p.value, calldata: p.calldata, deadline: p.deadline }) as Prepared };
  }
  it("the engine's honest preparation passes, in ETH and in an ERC-20", async () => {
    for (const asset of [ETH, USDC_ASSET]) {
      const { prep, svc } = await prepared(asset);
      expect(() => checkPrepared(prep, svc, 1n)).not.toThrow();
    }
  });
  it("refuses a digest of another call, a call outside the window, too much value, the escrow as provider", async () => {
    const { prep, svc } = await prepared();
    expect(() => checkPrepared({ ...prep, calldata: "0xdeadbeef" }, svc, 1n)).toThrow(/digest/);
    expect(() => checkPrepared({ ...prep, provider: "0x000000000000000000000000000000000000bad5" }, svc, 1n)).toThrow(/digest/);
    expect(() => checkPrepared(prep, svc, 31337n)).toThrow(/digest/); // another chain
    expect(() => checkPrepared({ ...prep, deadline: svc.params.executeDeadline + 1 }, svc, 1n)).toThrow(/deadline/);
    expect(() => checkPrepared({ ...prep, value: svc.params.amount }, svc, 1n)).toThrow(/value/);
    expect(() => checkPrepared({ ...prep, provider: svc.endpoint }, svc, 1n)).toThrow(/provider/);
    const erc20 = await prepared(USDC_ASSET);
    expect(() => checkPrepared({ ...erc20.prep, value: "1" }, erc20.svc, 1n)).toThrow(/value/);
  });
});
