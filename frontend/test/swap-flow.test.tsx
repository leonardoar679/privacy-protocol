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
import { getAddress } from "viem";
import { Swap } from "../src/components/Swap";
import { session } from "../src/wallet/session";
import { PINNED, thorAsset } from "../src/sdk/providerCall";
import type { Deployment } from "../src/sdk/chain";
import { PrivateSwapEngine, type PreparedExecution } from "../../services/private-swap/src/engine";
import { buildMemo, encodeDepositWithExpiry } from "../../services/private-swap/src/adapters/thorchain";
import type { AssetRef, Ingress, Order, OrderParams, ProviderAdapter, Quote, QuoteRequest } from "../../services/private-swap/src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
  if (u.host === "127.0.0.1:8787") return service(u.pathname, body);
  if (u.host === "127.0.0.1:8790") {
    if (u.pathname === "/swap/refund") { relayerBodies.push(body); jobs.set(String(body.params.orderId).toLowerCase(), "refund-only"); }
    if (u.pathname === "/swap/execute") jobs.set(String(body.params.orderId).toLowerCase(), "executing");
    const id = String(body?.params?.orderId ?? u.pathname.slice("/swap/".length)).toLowerCase();
    return json({ id, escrow: FACTORY, state: jobs.get(id) ?? "executing", updatedAt: Date.now() });
  }
  return json({ error: `unexpected request ${url}` }, 404);
});

beforeAll(() => { globalThis.fetch = fetchMock as unknown as typeof fetch; });
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); bend = {}; calls.length = 0; orders.clear(); relayerBodies.length = 0; jobs.clear(); });

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
