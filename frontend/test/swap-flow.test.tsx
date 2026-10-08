// @vitest-environment happy-dom
// The Swap screen, clicked through against the swap service's REAL engine (behind a fetch mock that
// stands in for HTTP), a stub THORChain adapter built on the adapter's own encoders, three THORNode
// gateways and a relayer: get a quote → commit (the wallet journals the minimum it showed) → resume
// the funded order → confirm. The wallet reads the provider call before its one-time key signs: a
// call paying someone else is refused with nothing signed; a call guaranteeing less than approved is
// not signed until the user confirms that exact minimum, which is then journaled.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeErrorResult, getAddress, parseAbi, toFunctionSelector, type Hex } from "viem";
import { Swap } from "../src/components/Swap";
import { session } from "../src/wallet/session";
import { PINNED, thorAsset } from "../src/sdk/providerCall";
import type { Deployment } from "../src/sdk/chain";
import { PrivateSwapEngine, type PreparedExecution } from "../../services/private-swap/src/engine";
import { buildMemo, encodeDepositWithExpiry } from "../../services/private-swap/src/adapters/thorchain";
import type { AssetRef, Ingress, Order, OrderParams, ProviderAdapter, Quote, QuoteRequest } from "../../services/private-swap/src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// the refund note recovery itself runs against a mock RPC in test/refunds.test.ts; here only the screen's use of it
const refundHook = vi.hoisted(() => ({ calls: 0, result: [] as unknown[] }));
vi.mock("../src/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sdk/privateTx")>()),
  recoverSwapRefunds: async () => { refundHook.calls++; return refundHook.result; },
}));

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const VAULT = getAddress("0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb");
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const LIMIT = 3_000_000n;
const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY };

// ---- the swap service: the real engine, a THORChain adapter on the real encoders, `bend` = dishonesty
const engine = new PrivateSwapEngine({ adapters: [], factory: FACTORY, escrowCreationCode: read("../../contracts/abi/periphery/SwapOrderEscrow.json").bytecode, chainId: 1n, refundVaults: { native: ETH_VAULT }, tipBps: 25, refundWindowSeconds: 7200 });
let bend: { dest?: string; limit?: bigint } = {};
const now = () => Math.floor(Date.now() / 1000);
const thorQuote = (): Quote => ({ provider: "thorchain", category: "A", toAmount: LIMIT + 30_000n, toAmountMin: LIMIT, fees: [], etaSeconds: 600, expiresAt: now() + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: {}, obtainedAt: Date.now() });
const thorchain: ProviderAdapter = {
  id: "thorchain", implemented: true, capabilities: () => ({ contractSender: true, destinationLinkPublic: true, linkEvidence: "memo" }) as any,
  quote: async () => thorQuote(),
  prepareIngress: async (req: QuoteRequest, q: Quote): Promise<Ingress> => {
    const memo = buildMemo(thorAsset(BTC), bend.dest ?? req.destination, bend.limit ?? LIMIT, req.source);
    return { kind: "contract-call", to: PINNED.thorchainRouter, calldata: encodeDepositWithExpiry(VAULT, "0x0000000000000000000000000000000000000000", req.amount, memo, BigInt(now() + 600)), value: req.amount, memo, expiresAt: q.expiresAt, minOutEncoded: true };
  },
  track: async () => ({ state: "unknown" }), health: async () => ({}) as any,
};
const orders = new Map<string, { order: Order; prepared?: PreparedExecution }>();
const wire = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const json = (x: unknown, status = 200) => new Response(wire(x), { status, headers: { "content-type": "application/json" } });
const request = (b: any): QuoteRequest => ({ from: { ...b.from, decimals: Number(b.from.decimals) }, to: { ...b.to, decimals: Number(b.to.decimals) }, amount: BigInt(b.amount), destination: String(b.destination), slippageBps: Number(b.slippageBps ?? 50) });
const score = { provider: "thorchain", total: 80, components: { price: 80, security: 90, privacy: 70, latency: 60, liquidity: 80, reliability: 90 } };
const calls: string[] = [];
const relayerBodies: any[] = [];
const jobs = new Map<string, string>();
const RELAYER_EOA = getAddress("0x00000000000000000000000000000000000000ee");
// the deployment's RPC endpoint: the pre-trade simulation (whale spec §24) runs deployAndExecute here; `rpcBend` makes it revert
let rpcBend: { revert?: Hex; providerReason?: string } = {};
const rpcSeen: any[] = [];
function rpc(req: any) {
  const { id, method } = req;
  if (method === "eth_call") {
    const tx = req.params[0];
    rpcSeen.push(tx);
    if (rpcBend.revert && String(tx.to).toLowerCase() === FACTORY.toLowerCase()) return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: rpcBend.revert } };
    if (rpcBend.providerReason && String(tx.to).toLowerCase() === PINNED.thorchainRouter.toLowerCase()) return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: encodeErrorResult({ abi: parseAbi(["error Error(string message)"]), errorName: "Error", args: [rpcBend.providerReason] }) } };
    return { jsonrpc: "2.0", id, result: "0x" };
  }
  if (method === "eth_estimateGas") return { jsonrpc: "2.0", id, result: "0x33450" };
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `mock rpc: ${method} unsupported` } };
}

async function service(path: string, body: any): Promise<Response> {
  switch (path) {
    case "/quote": return json({ quotes: [thorQuote()], scores: [score], errors: {}, chosen: score, links: { thorchain: { public: true, evidence: "memo" } } });
    case "/order": {
      const order = engine.buildOrder(request(body), body.policy, thorQuote(), { orderSigner: body.orderSigner, refundOwnerCommitment: BigInt(body.refundOwnerCommitment), refundNoteSecret: BigInt(body.refundNoteSecret), refundNoteDataHash: body.refundNoteDataHash });
      orders.set(order.orderId, { order });
      return json({ order, scores: [score], status: "Pending" });
    }
    case "/order/resume": {
      const p = body.params;
      const params: OrderParams = { ...p, assetType: Number(p.assetType), amount: BigInt(p.amount), executeDeadline: Number(p.executeDeadline), refundAfter: Number(p.refundAfter), refundOwnerCommitment: BigInt(p.refundOwnerCommitment), refundNoteSecret: BigInt(p.refundNoteSecret), executorTip: BigInt(p.executorTip) };
      const order = engine.restoreOrder(request(body), body.policy, thorQuote(), params);
      orders.set(order.orderId, { order });
      return json({ order, status: "Pending" });
    }
    case "/prepare": {
      const e = orders.get(body.orderId)!;
      e.prepared = await engine.prepareExecution(e.order, thorchain);
      const p = e.prepared;
      return json({ digest: p.digest, provider: p.provider, value: p.value, calldata: p.calldata, deadline: p.deadline, ingress: p.ingress, quote: p.quote });
    }
    case "/finalize": {
      const e = orders.get(body.orderId)!;
      return json({ execution: engine.attachSignature(e.order, e.prepared!, body.signature), order: e.order });
    }
    case "/health": return json({ deployment: { chainId: "1", factory: FACTORY, nativeVault: ETH_VAULT }, providers: {} });
  }
  return json({ error: "no such route" }, 404);
}

const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const u = new URL(url);
  calls.push(`${u.host}${u.pathname}`);
  if (u.pathname.endsWith("/thorchain/inbound_addresses")) return json([{ chain: "ETH", address: VAULT, router: PINNED.thorchainRouter, halted: false }]);
  if (u.host === "127.0.0.1:1") return json(Array.isArray(body) ? body.map(rpc) : rpc(body)); // the deployment's RPC endpoint (viem batches)
  if (u.host === "127.0.0.1:8787") return service(u.pathname, body);
  if (u.host === "127.0.0.1:8790") {
    if (u.pathname === "/info") return json({ chainId: 1, core: deployment.core, feeVault: ETH_VAULT, relayer: RELAYER_EOA, privacyAddress: "", minFeeWei: "0", gasPriceWei: "0", gasEstimate: "0", feeMarginBps: 0, requireReadableFeePayload: false, inflight: 0 });
    if (u.pathname === "/swap/refund") { relayerBodies.push(body); jobs.set(String(body.params.orderId).toLowerCase(), "refund-only"); }
    if (u.pathname === "/swap/execute") jobs.set(String(body.params.orderId).toLowerCase(), "executing");
    const id = String(body?.params?.orderId ?? u.pathname.slice("/swap/".length)).toLowerCase();
    return json({ id, escrow: FACTORY, state: jobs.get(id) ?? "executing", updatedAt: Date.now() });
  }
  return json({ error: `unexpected request ${url}` }, 404);
});

beforeAll(() => { globalThis.fetch = fetchMock as unknown as typeof fetch; });
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); bend = {}; rpcBend = {}; rpcSeen.length = 0; calls.length = 0; orders.clear(); relayerBodies.length = 0; jobs.clear(); });

const button = (c: HTMLElement, text: string | RegExp) => [...c.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
async function mount(container: HTMLElement) {
  if (root) act(() => root!.unmount());
  await act(async () => { root = createRoot(container); root.render(<Swap masterSeed={session.state().seed!} deployment={deployment} />); });
}

/** Quote → commit → (funding happens elsewhere) → reopen the funded order from the journal. */
async function committedAndFunded(container: HTMLElement) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  await mount(container);
  await act(async () => { button(container, "Get a quote")!.click(); });
  await vi.waitFor(() => expect(button(container, "Swap")).toBeTruthy());
  await act(async () => { button(container, "Swap")!.click(); });
  await vi.waitFor(() => expect(session.journal().swaps).toHaveLength(1));
  const s = session.journal().swaps[0];
  expect(s.approvedMin, "the minimum the user saw is journaled at commit").toBe(LIMIT.toString());
  session.update((j) => { j.swaps[0].fundedTx = "0x" + "11".repeat(32); j.swaps[0].state = "funded"; }); // the private withdrawal itself is covered elsewhere
  await mount(container); // a reload: the order comes back from the journal
  await act(async () => { button(container, "Open")!.click(); });
  await vi.waitFor(() => expect(button(container, "2 · Confirm the swap")?.disabled).toBe(false));
  return s.orderId;
}

describe("the Swap screen reads the provider call before signing (happy-dom, real engine)", () => {
  it("an honest call: checked, signed, handed to the relayer; the check is shown in plain words", async () => {
    const container = document.createElement("div");
    await committedAndFunded(container);
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Checked by this wallet before signing"), { timeout: 20_000 });
    expect(container.textContent).toContain("pays your fresh address, at least 0.030000 BTC");
    expect(container.textContent).toContain("a provider refund returns to your private balance");
    expect(calls).toContain("127.0.0.1:8787/finalize");
    expect(calls).toContain("127.0.0.1:8790/swap/execute");
    expect(calls.filter((c) => c.endsWith("/thorchain/inbound_addresses")).length, "the wallet asked the gateways itself").toBe(3);
    // the signed execution was simulated on the deployment's endpoint before it left the wallet, with the relayer as the tip recipient
    const sim = rpcSeen.find((tx) => String(tx.to).toLowerCase() === FACTORY.toLowerCase());
    expect(sim, "deployAndExecute simulated").toBeTruthy();
    expect(String(sim.from).toLowerCase()).toBe(RELAYER_EOA.toLowerCase());
    expect(calls.indexOf("127.0.0.1:1/"), "simulated before finalize").toBeLessThan(calls.indexOf("127.0.0.1:8787/finalize"));
    expect(session.journal().swaps[0].simulation).toMatchObject({ ok: true, gas: "210000" });
    expect(container.textContent).toContain("Simulated on your RPC endpoints before hand-over");
    expect(container.querySelector('[data-testid="privacy-lint"]')).toBeTruthy();
  });

  it("a call the chain would revert is not handed over: the escrow's error and the provider's reason are shown, nothing is finalized, the signature stays here", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    rpcBend = { revert: toFunctionSelector("ProviderCallFailed()") as Hex, providerReason: "THORChain: trading halted" };
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Not handed over: the execution would revert (ProviderCallFailed: the provider rejected the call); the provider says: THORChain: trading halted"), { timeout: 20_000 });
    expect(calls).not.toContain("127.0.0.1:8787/finalize");
    expect(calls).not.toContain("127.0.0.1:8790/swap/execute");
    expect(session.journal().swaps.find((s) => s.orderId === orderId)!.simulation).toMatchObject({ ok: false, error: "ProviderCallFailed" });
    expect(button(container, "2 · Confirm the swap")!.disabled, "confirm again later against a fresh quote").toBe(false);
  });

  it("a call paying another address is refused and nothing is signed", async () => {
    const container = document.createElement("div");
    await committedAndFunded(container);
    bend = { dest: "bc1qattacker" };
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toMatch(/does not do what this wallet asked for \(thorchain receiver/), { timeout: 20_000 });
    expect(calls).not.toContain("127.0.0.1:8787/finalize");
    expect(calls).not.toContain("127.0.0.1:8790/swap/execute");
  });

  it("a refused call can be returned to the private balance: a refund-only job with the journaled params, no signature", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    bend = { dest: "bc1qattacker" };
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toMatch(/does not do what this wallet asked for/), { timeout: 20_000 });
    await act(async () => { button(container, "Return to my private balance")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Returning to your private balance"), { timeout: 20_000 });
    expect(relayerBodies).toHaveLength(1);
    const sent = relayerBodies[0];
    expect(sent.execution, "nothing signed is handed over").toBeUndefined();
    expect(sent.params).toEqual(session.journal().swaps.find((s) => s.orderId === orderId)!.params);
    expect(sent.factory.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(sent.refundNoteData).toMatch(/^0x[0-9a-f]{338}$/);
    expect(calls).not.toContain("127.0.0.1:8787/finalize");
    expect(session.journal().swaps.find((s) => s.orderId === orderId)?.state).toBe("refund-only");
  });
  it("when the executor reports the refund, the refund note is recorded at once and its amount shown (PP-S09)", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    await act(async () => { button(container, "Return to my private balance")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Returning to your private balance"), { timeout: 20_000 });
    refundHook.result = [{ orderId, leafIndex: 4, note: { vaultId: BigInt(ETH_VAULT), amount: 99n * 10n ** 16n, ownerCommitment: 1n, noteSecret: 2n }, counter: 0, commitment: 0n, noteData: "0x", txHash: "0x" }];
    jobs.set(orderId.toLowerCase(), "refunded"); // the escrow re-shielded once the window opened
    await mount(container); // a reload: the order comes back from the journal, its job from the relayer
    await act(async () => { button(container, "Open")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Refunded: 0.99 ETH back in your private balance."), { timeout: 20_000 });
    expect(refundHook.calls).toBe(1);
    refundHook.result = [];
    refundHook.calls = 0;
  });

  it("after execution the screen says where a provider refund would land and that the executor watches for it (PP-S11, PP-S12)", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(calls).toContain("127.0.0.1:8790/swap/execute"), { timeout: 20_000 });
    jobs.set(orderId.toLowerCase(), "executed"); // the provider call went through
    await mount(container); // a reload: the order from the journal, its job from the relayer
    await act(async () => { button(container, "Open")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("If it cannot deliver, it refunds the escrow, and the executor re-shields that into your private balance"), { timeout: 20_000 });
    expect(container.textContent).toContain("An amount too small to be worth a re-shield is left in the escrow, where anyone can re-shield it.");
  });

  it("a lower minimum is not signed until the user confirms exactly it; the consent is journaled", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    bend = { limit: LIMIT - 60_000n };
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("The price moved"), { timeout: 20_000 });
    expect(container.textContent).toContain("at least 0.029400 BTC");
    expect(container.textContent).toContain("−2 %");
    expect(calls, "nothing signed yet").not.toContain("127.0.0.1:8787/finalize");
    await act(async () => { button(container, "Confirm at the new minimum")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Checked by this wallet before signing"), { timeout: 20_000 });
    expect(calls).toContain("127.0.0.1:8787/finalize");
    expect(session.journal().swaps.find((s) => s.orderId === orderId)?.approvedMin).toBe((LIMIT - 60_000n).toString());
    expect(container.textContent).not.toContain("The price moved");
  });
});
