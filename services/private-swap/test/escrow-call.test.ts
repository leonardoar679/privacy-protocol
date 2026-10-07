// The one call the escrow makes for an ingress (src/engine.ts escrowCall, spec §5–§6): ETH orders
// forward value, ERC-20 orders never do; a plain deposit address for a token is paid with the token's
// own transfer(depositAddress, amount − tip), which the order key signs like any provider call (the
// forge test test_ERC20Order_PlainDepositAddress_PaidWithTokenTransfer runs that call on the escrow).
// Offline: stub adapters, no provider.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { PrivateSwapEngine, escrowCall } from "../src/engine";
import { executionDigest, orderSignerAddress, signExecution } from "../src/endpoints";
import { decodeParams, hexBuf, selectorHex } from "../src/abi";
import type { Ingress, OrderParams, ProviderAdapter, Quote, QuoteRequest } from "../src/types";

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DEPOSIT = "0x00000000000000000000000000000000de9051de";
const ROUTER = "0x00000000000000000000000000000000000c0de1";
const engine = new PrivateSwapEngine({
  adapters: [], factory: "0x00000000000000000000000000000000000000f1", escrowCreationCode: read("../../../contracts/abi/periphery/SwapOrderEscrow.json").bytecode, chainId: 1n,
  refundVaults: { native: "0x00000000000000000000000000000000000000e7", [USDC]: "0x00000000000000000000000000000000000ca5de" }, tipBps: 25, refundWindowSeconds: 7200,
});
const ORDER_KEY = new Uint8Array(32).fill(7);
const keys = { orderSigner: orderSignerAddress(ORDER_KEY), refundOwnerCommitment: 7n, refundNoteSecret: 9n, refundNoteDataHash: ("0x" + "ab".repeat(32)) as `0x${string}` };
const now = () => Math.floor(Date.now() / 1000);
const quote = (provider: Quote["provider"]): Quote => ({ provider, category: "A", toAmount: 1n, toAmountMin: 1n, fees: [], etaSeconds: 600, expiresAt: now() + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: {}, obtainedAt: Date.now() });
const usdcReq: QuoteRequest = { from: { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: 1_000_000_000n, destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", slippageBps: 50 };
const ethReq: QuoteRequest = { ...usdcReq, from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, amount: 10n ** 18n };
const ingress = (kind: Ingress["kind"], to: string, value = 0n, calldata: `0x${string}` = "0x"): Ingress => ({ kind, to, calldata, value, expiresAt: now() + 600, minOutEncoded: true });
const stub = (i: Ingress): ProviderAdapter => ({
  id: "near-intents", implemented: true, capabilities: () => ({ contractSender: true }) as any,
  quote: async () => quote("near-intents"), prepareIngress: async () => i, track: async () => ({ state: "unknown" }), health: async () => ({}) as any,
});

describe("escrowCall", () => {
  const p = (assetType: 0 | 1, amount: bigint, tip: bigint): OrderParams => ({ ...engine.buildOrder(assetType ? usdcReq : ethReq, "best-privacy", quote("near-intents"), keys).params, amount, executorTip: tip });

  it("ETH: a deposit address gets the value net of the tip; a contract call forwards at most that", () => {
    expect(escrowCall(p(0, 1000n, 10n), ingress("plain-address", DEPOSIT))).toEqual({ provider: DEPOSIT, value: 990n, calldata: "0x" });
    expect(escrowCall(p(0, 1000n, 10n), ingress("contract-call", ROUTER, 990n, "0x1234"))).toEqual({ provider: ROUTER, value: 990n, calldata: "0x1234" });
    expect(() => escrowCall(p(0, 1000n, 10n), ingress("contract-call", ROUTER, 991n, "0x1234"))).toThrow(/exceeds the escrow's spendable balance/);
  });

  it("ERC-20: a contract-call provider pulls the tokens (no value); a deposit address is paid with transfer(deposit, amount − tip)", () => {
    expect(escrowCall(p(1, 1000n, 10n), ingress("contract-call", ROUTER, 0n, "0xabcd"))).toEqual({ provider: ROUTER, value: 0n, calldata: "0xabcd" });
    expect(() => escrowCall(p(1, 1000n, 10n), ingress("contract-call", ROUTER, 1n, "0xabcd"))).toThrow(/forwards no ETH value/);
    const call = escrowCall(p(1, 1000n, 10n), ingress("plain-address", DEPOSIT));
    expect(call.provider.toLowerCase()).toBe(USDC.toLowerCase());
    expect(call.value).toBe(0n);
    expect(call.calldata.slice(0, 10)).toBe(selectorHex("transfer(address,uint256)"));
    const [to, amount] = decodeParams(hexBuf(call.calldata).subarray(4), ["address", "uint"]);
    expect(String(to).toLowerCase()).toBe(DEPOSIT);
    expect(amount).toBe(990n);
    expect(() => escrowCall(p(1, 1000n, 10n), ingress("plain-address", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"))).toThrow(/EVM deposit address/);
  });

  it("prepareExecution signs exactly that call: the digest names the token as the provider for a token deposit address", async () => {
    const order = engine.buildOrder(usdcReq, "best-privacy", quote("near-intents"), keys);
    const prepared = await engine.prepareExecution(order, stub(ingress("plain-address", DEPOSIT)));
    expect(prepared.provider.toLowerCase()).toBe(USDC.toLowerCase());
    expect(prepared.value).toBe(0n);
    expect(prepared.digest).toBe(executionDigest(1n, order.endpoint, order.orderId, prepared.provider, 0n, prepared.calldata, prepared.deadline));
    const exec = engine.attachSignature(order, prepared, signExecution(ORDER_KEY, prepared.digest));
    expect(exec.provider).toBe(prepared.provider);
    expect(exec.providerCalldata).toBe(prepared.calldata);
    // the ETH order with the same deposit address forwards value instead
    const ethOrder = engine.buildOrder(ethReq, "best-privacy", quote("near-intents"), keys);
    const ethPrepared = await engine.prepareExecution(ethOrder, stub(ingress("plain-address", DEPOSIT)));
    expect(ethPrepared.provider).toBe(DEPOSIT);
    expect(ethPrepared.value).toBe(ethOrder.params.amount - ethOrder.params.executorTip);
    expect(ethPrepared.calldata).toBe("0x");
  });
});
