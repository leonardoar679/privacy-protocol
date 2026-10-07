// Order recovery (spec §3, plan §30): a wallet that persisted an order can have the service rebuild
// it from the on-chain params alone — same escrow, same budget, same digest to sign — after a restart.
// Offline: a stub quote stands in for the provider.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { PrivateSwapEngine } from "../src/engine";
import { executionDigest } from "../src/endpoints";
import type { Quote, QuoteRequest } from "../src/types";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const escrowArtifact = read("../../../contracts/abi/periphery/SwapOrderEscrow.json");

const engine = new PrivateSwapEngine({
  adapters: [], factory: "0x00000000000000000000000000000000000000f1", escrowCreationCode: escrowArtifact.bytecode, chainId: 1n,
  refundVaults: { native: "0x00000000000000000000000000000000000000e7" }, tipBps: 25, refundWindowSeconds: 7200,
});
const req: QuoteRequest = { from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: 5n * 10n ** 17n, destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", slippageBps: 50 };
const quote: Quote = { provider: "thorchain", category: "A", toAmount: 1_500_000n, toAmountMin: 1_490_000n, fees: [], etaSeconds: 600, expiresAt: Math.floor(Date.now() / 1000) + 600, nativeAssets: true, minOutEncoded: true, hops: [], raw: {}, obtainedAt: Date.now() };
const keys = { orderSigner: "0x000000000000000000000000000000000000a11c", refundOwnerCommitment: 7n, refundNoteSecret: 9n, refundNoteDataHash: ("0x" + "ab".repeat(32)) as `0x${string}` };

describe("restoreOrder", () => {
  it("rebuilds the same endpoint, budget and execution digest from the persisted params", () => {
    const built = engine.buildOrder(req, "best-privacy", quote, keys);
    const later = { ...quote, toAmount: 1_400_000n, expiresAt: quote.expiresAt + 3600 }; // a fresh quote at resume time
    const restored = engine.restoreOrder(req, "best-privacy", later, built.params);
    expect(restored.orderId).toBe(built.orderId);
    expect(restored.endpoint).toBe(built.endpoint);
    expect(restored.params).toEqual(built.params);
    expect(restored.privacy.delaySeconds).toEqual(built.privacy.delaySeconds);
    expect(restored.privacy.score).toBe(built.privacy.score);
    expect(restored.state).toBe("COMMITTED");
    const calldata = "0x1234";
    const d1 = executionDigest(1n, built.endpoint, built.orderId, "0x00000000000000000000000000000000000000aa", 1n, calldata, built.params.executeDeadline);
    const d2 = executionDigest(1n, restored.endpoint, restored.orderId, "0x00000000000000000000000000000000000000aa", 1n, calldata, restored.params.executeDeadline);
    expect(d2).toBe(d1);
  });
  it("refuses inconsistent params", () => {
    const built = engine.buildOrder(req, "best-price", quote, keys);
    expect(() => engine.restoreOrder(req, "best-price", quote, { ...built.params, orderSigner: "nope" })).toThrow(/orderSigner/);
    expect(() => engine.restoreOrder(req, "best-price", quote, { ...built.params, refundAfter: built.params.executeDeadline })).toThrow(/executeDeadline/);
    // a different signer is a different escrow: tampering with the params moves the money elsewhere, which the wallet would notice
    expect(engine.restoreOrder(req, "best-price", quote, { ...built.params, orderSigner: "0x000000000000000000000000000000000000b0b0" }).endpoint).not.toBe(built.endpoint);
  });
});
