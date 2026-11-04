// @vitest-environment happy-dom
// The high-value Review (whale spec §24; plan V2 §11–§13, §46–§47, §66): a $3.4M swap against the swap
// service's real engine behind a fetch mock, Chainlink served by the mock RPC. At commit the Review shows
// the USD numeral, the five lines of plan §4 (the single quote must be acknowledged), the lint, and takes a
// hold, not a tap; at execute it shows the simulation result and takes a hold before anything is finalized.
// Above the second-confirmation threshold the authenticator is asked first, with the password as the
// fallback; at institutional the funding waits for the review hold and the order can be exported.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, getAddress } from "viem";
import { Swap } from "../src/features/swap/Swap";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { PINNED, thorAsset } from "@privacy-wallet/sdk/providerCall";
import { reviewHoldMinutes } from "@privacy-wallet/sdk/tiers";
const REVIEW_HOLD_MINUTES = reviewHoldMinutes();
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { PrivateSwapEngine, type PreparedExecution } from "@privacy-wallet/swap-engine/engine";
import { buildMemo, encodeDepositWithExpiry } from "@privacy-wallet/swap-engine/adapters/thorchain";
import type { AssetRef, Ingress, Order, OrderParams, ProviderAdapter, Quote, QuoteRequest } from "@privacy-wallet/swap-engine/types";
import { privacyAddress } from "@privacy-wallet/sdk/privateTx";
import { v1Adapter } from "./helpers/apiV1";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({ ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()), recoverSwapRefunds: async () => [] }));

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const VAULT = getAddress("0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb");
const RELAYER_EOA = getAddress("0x00000000000000000000000000000000000000ee");
const ETH_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const AMOUNT = 1360n * 10n ** 18n; // 1,360 ETH at $2,500 = $3.4M
const LIMIT = 40_00000000n; // 40 BTC
const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY };

const engine = new PrivateSwapEngine({ adapters: [], factory: FACTORY, escrowCreationCode: read("../../../contracts/abi/periphery/SwapOrderEscrow.json").bytecode, chainId: 1n, refundVaults: { native: ETH_VAULT }, tips: { tipFor: async (_from, amount) => amount / 400n } /* a fixed 0.25 %: the service prices the gas (swap-engine tips.ts) */, refundWindowSeconds: 7200 });
const now = () => Math.floor(Date.now() / 1000);
const thorQuote = (): Quote => ({ provider: "thorchain", category: "A", toAmount: LIMIT + 10_000_000n, toAmountMin: LIMIT, fees: [], etaSeconds: 3600, expiresAt: now() + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: {}, obtainedAt: Date.now(), plan: { mode: "streaming", parts: 300, intervalBlocks: 1, expectedSeconds: 1800 }, impactBps: 12 } as Quote);
const thorchain: ProviderAdapter = {
  id: "thorchain", implemented: true, capabilities: () => ({ contractSender: true, destinationLinkPublic: true, linkEvidence: "memo" }) as any,
  quote: async () => thorQuote(),
  prepareIngress: async (req: QuoteRequest, q: Quote): Promise<Ingress> => {
    const memo = buildMemo(thorAsset(BTC), req.destination, LIMIT, req.source, { interval: 1, quantity: 300 });
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
const jobs = new Map<string, string>();

async function service(path: string, body: any): Promise<Response> {
  switch (path) {
    case "/quote": return json({ quotes: [thorQuote()], scores: [score], errors: {}, chosen: score, links: { thorchain: { public: true, evidence: "memo" } }, policy: "privacy-execution", tier: "high-value", competition: [{ provider: "thorchain", outcome: "quoted", ms: 900 }, { provider: "chainflip", outcome: "refused", reason: "insufficient liquidity", ms: 1200 }] });
    case "/order": {
      const order = engine.buildOrder(request(body), body.policy, { ...thorQuote(), executorTip: BigInt(request(body).amount) / 400n }, { orderSigner: body.orderSigner, refundOwnerCommitment: BigInt(body.refundOwnerCommitment), refundNoteSecret: BigInt(body.refundNoteSecret), refundNoteDataHash: body.refundNoteDataHash });
      orders.set(order.orderId, { order });
      return json({ order: { ...order, tier: "high-value", value: { usd: 3_400_000, at: Date.now(), source: "chainlink" } }, scores: [score], status: "Pending" });
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
      return json({ digest: p.digest, provider: p.provider, value: p.value, calldata: p.calldata, deadline: p.deadline, ingress: p.ingress, quote: p.quote, plan: thorQuote().plan });
    }
    case "/finalize": {
      const e = orders.get(body.orderId)!;
      return json({ execution: engine.attachSignature(e.order, e.prepared!, body.signature), order: e.order });
    }
    case "/health": return json({ deployment: { chainId: "1", factory: FACTORY, nativeVault: ETH_VAULT }, providers: {} });
  }
  return json({ error: "no such route" }, 404);
}
function rpc(req: any) {
  const { id, method } = req;
  if (method === "eth_call") {
    const tx = req.params[0];
    if (String(tx.to).toLowerCase() === ETH_FEED) {
      if (String(tx.data).startsWith("0x7284e416")) return { jsonrpc: "2.0", id, result: encodeAbiParameters([{ type: "string" }], ["ETH / USD"]) };
      const t = BigInt(now() - 60);
      return { jsonrpc: "2.0", id, result: encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [7n, 2_500_00000000n, t, t, 7n]) };
    }
    if (String(tx.to).toLowerCase() === FACTORY.toLowerCase()) return { jsonrpc: "2.0", id, result: "0x" };
    return { jsonrpc: "2.0", id, error: { code: -32000, message: "mock: no contract" } };
  }
  if (method === "eth_estimateGas") return { jsonrpc: "2.0", id, result: "0x33450" };
  // the fee history the wallet's tip ceiling reads (audit round 2, critic gap 4): 1,000 gwei base, 2 gwei priority — this
  // world's tip is 0.25 % of the amount, not the gas, so the fees are set high enough that three times the execution's
  // gas covers it for every amount here
  if (method === "eth_feeHistory")
    return { jsonrpc: "2.0", id, result: { oldestBlock: "0x1", baseFeePerGas: Array(6).fill("0xe8d4a51000"), gasUsedRatio: Array(5).fill(0.5), reward: Array(5).fill(["0x77359400"]) } };
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `mock rpc: ${method} unsupported` } };
}
const api = v1Adapter(service);
const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const u = new URL(url);
  calls.push(`${u.host}${u.pathname.replace(/\/op_[a-z0-9]+\//, "/:id/")}`); // an operation's opaque id as :id
  if (u.pathname.endsWith("/thorchain/inbound_addresses"))
    return json([
      { chain: "ETH", address: VAULT, router: PINNED.thorchainRouter, halted: false },
      { chain: "BTC", address: "bc1qthorvault0000000000000000000000000000", halted: false },
    ]);
  if (u.host === "127.0.0.1:1") return json(Array.isArray(body) ? body.map(rpc) : rpc(body));
  if (u.host === "127.0.0.1:8787") return api(u.pathname, body); // V6: the API's /v1 routes in front of the V5-shaped mock
  if (u.host === "127.0.0.1:8790") {
    if (u.pathname === "/info") return json({ chainId: 1, core: deployment.core, feeVault: ETH_VAULT, relayer: RELAYER_EOA, privacyAddress: privacyAddress(new Uint8Array(32).fill(0x5e)) /* the relayer's, for its fee note (V6: the escrow funding pays the percentage) */, minFeeWei: "0", gasPriceWei: "0", gasEstimate: "0", feeMarginBps: 0, requireReadableFeePayload: false, inflight: 0 });
    if (u.pathname === "/swap/execute") jobs.set(String(body.params.orderId).toLowerCase(), "executing");
    const id = String(body?.params?.orderId ?? u.pathname.slice("/swap/".length)).toLowerCase();
    return json({ id, escrow: FACTORY, state: jobs.get(id) ?? "executing", updatedAt: Date.now() });
  }
  return json({ error: `unexpected request ${url}` }, 404);
});

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  (URL as any).createObjectURL = () => "blob:review";
  (URL as any).revokeObjectURL = () => {};
});
let root: Root | null = null;
afterEach(() => {
  if (root) { act(() => root!.unmount()); root = null; }
  session.forget(); settings.reset(); calls.length = 0; orders.clear(); jobs.clear();
  delete (navigator as any).credentials; delete (globalThis as any).PublicKeyCredential;
});

const button = (c: HTMLElement, text: string | RegExp) => [...c.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
const line = (c: HTMLElement, id: string) => c.querySelector(`[data-line="${id}"]`)!;
/** Press and hold the confirmation (the hold is 40 ms under test: test/setup.ts). */
async function hold(c: HTMLElement) {
  const b = c.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement;
  expect(b, "a hold, never a tap").toBeTruthy();
  expect(b.disabled).toBe(false);
  await act(async () => { b.dispatchEvent(new Event("pointerdown", { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
}
async function mount(container: HTMLElement) {
  if (root) act(() => root!.unmount());
  await act(async () => { root = createRoot(container); root.render(<Swap masterSeed={session.state().seed!} deployment={deployment} />); });
}
async function quotedLarge(container: HTMLElement) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 2000n * 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
  await priceStore.refresh(deployment, { force: true });
  expect(priceStore.state().status).toBe("ready");
  await mount(container);
  await act(async () => { setValue(container.querySelector('input[inputmode="decimal"]') as HTMLInputElement, "1360"); });
  expect(container.textContent).toContain("≈ $3,400,000");
  await act(async () => { button(container, "Get a quote")!.click(); });
  await vi.waitFor(() => expect(button(container, "Review Swap")).toBeTruthy());
}

describe("the high-value Review (happy-dom, real engine)", () => {
  it("commit: the USD numeral, the five lines (the single quote acknowledged), the lint and a hold; execute: the simulation line, a hold, then the hand-over", async () => {
    const container = document.createElement("div");
    await quotedLarge(container);
    await act(async () => { button(container, "Review Swap")!.click(); });
    const review = container.querySelector('[data-testid="review"]')!;
    expect(review.getAttribute("data-moment")).toBe("commit");
    expect(container.querySelector('[data-testid="review-usd"]')!.textContent).toContain("$3,400,000");
    expect(container.textContent).toContain("1360 ETH");
    expect(container.textContent).toContain("Private streaming route");
    expect(container.textContent).toContain("Receive at least");
    expect(container.textContent).toContain("Native-to-native");
    expect(container.textContent).toContain("only one provider answered");
    expect(container.querySelector('[data-testid="privacy-lint"]')).toBeTruthy();
    for (const id of ["price", "destination", "slippage", "privacy"]) expect(line(container, id).getAttribute("data-ok"), id).toBe("1");
    expect(line(container, "route").getAttribute("data-ok")).toBe("0");
    expect((container.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement).disabled, "not before the acknowledgement").toBe(true);
    expect(container.querySelector('[data-testid="confirm-tap"]'), "no plain tap at high-value").toBeNull();
    await act(async () => { button(container, "I accept the single quote")!.click(); });
    expect(line(container, "route").getAttribute("data-ok")).toBe("1");
    await act(async () => { button(container, "Advanced details")!.click(); });
    expect(container.querySelector('[data-testid="route-details"]')!.textContent).toContain("chainflip — refused (insufficient liquidity)");
    expect(container.querySelector('[data-testid="route-details"]')!.textContent).toContain("300 parts");
    await hold(container);
    await vi.waitFor(() => expect(session.journal().swaps, container.textContent?.slice(-1200)).toHaveLength(1));
    const s = session.journal().swaps[0];
    expect(s.tier).toBe("high-value");
    expect(s.reviewHoldUntil).toBeUndefined();
    expect(s.competition).toHaveLength(2);
    expect(s.lint?.items.length).toBeGreaterThan(5);
    expect(container.querySelector('[data-testid="review"]')).toBeNull();

    // execute: the funded order, re-quoted, checked, signed and simulated → the Review → a hold → finalize + hand-over
    session.update((j) => { j.swaps[0].fundedTx = "0x" + "11".repeat(32); j.swaps[0].state = "funded"; });
    await mount(container);
    await act(async () => { button(container, "Open")!.click(); });
    await vi.waitFor(() => expect(button(container, "2 · Confirm the swap")?.disabled).toBe(false));
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="review"]')?.getAttribute("data-moment")).toBe("execute"), { timeout: 20_000 });
    expect(calls, "nothing finalized before the confirmation").not.toContain("127.0.0.1:8787/v1/operations/:id/finalize");
    expect(line(container, "route").textContent).toMatch(/simulated on 1 RPC endpoint: it executes, about 210,000 gas/);
    expect(line(container, "price").textContent).toContain("guarantees at least 40.000000 BTC");
    expect(line(container, "route").getAttribute("data-ok")).toBe("1");
    await hold(container);
    await vi.waitFor(() => expect(calls).toContain("127.0.0.1:8790/swap/execute"), { timeout: 20_000 });
    expect(calls.indexOf("127.0.0.1:8787/v1/operations/:id/finalize")).toBeGreaterThan(-1);
    expect(container.querySelector('[data-testid="review"]')).toBeNull();
    expect(container.textContent).toContain("Checked by this wallet before signing");
  });

  it("above the second-confirmation threshold the authenticator is asked after the hold; when it declines, the password is the fallback", async () => {
    settings.set({ tiers: { enhanced: 100_000, highValue: 1_000_000, highValueSecondary: 2_000_000, institutional: 10_000_000 }, secondFactor: { enabled: true, credentialId: "AQID" } });
    const get = vi.fn(async () => ({ rawId: new Uint8Array([1, 2, 3]).buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get, create: vi.fn() }, configurable: true });
    (globalThis as any).PublicKeyCredential = class {};
    const container = document.createElement("div");
    await quotedLarge(container);
    await act(async () => { button(container, "Review Swap")!.click(); });
    expect(container.textContent).toContain("second confirmation next");
    await act(async () => { button(container, "I accept the single quote")!.click(); });
    await hold(container);
    await vi.waitFor(() => expect(session.journal().swaps).toHaveLength(1));
    expect(get).toHaveBeenCalledTimes(1);
    const opts = (get.mock.calls[0] as any[])[0].publicKey;
    expect(opts.userVerification).toBe("required");
    expect(opts.allowCredentials[0].id).toEqual(new Uint8Array([1, 2, 3]));

    // the authenticator declines → the password box; a wrong password is refused, the right one confirms
    session.forget(); settings.set({ tiers: { enhanced: 100_000, highValue: 1_000_000, highValueSecondary: 2_000_000, institutional: 10_000_000 }, secondFactor: { enabled: true, credentialId: "AQID" } });
    get.mockImplementation(async () => { throw new Error("NotAllowedError"); });
    const c2 = document.createElement("div");
    await quotedLarge(c2);
    await act(async () => { button(c2, "Review Swap")!.click(); });
    await act(async () => { button(c2, "I accept the single quote")!.click(); });
    await hold(c2);
    await vi.waitFor(() => expect(c2.querySelector('[data-testid="second-factor-password"]')).toBeTruthy());
    expect(session.journal().swaps).toHaveLength(0);
    const pw = c2.querySelector('[data-testid="second-factor-password"] input') as HTMLInputElement;
    await act(async () => { setValue(pw, "wrong"); });
    await act(async () => { button(c2, "Confirm with the password")!.click(); });
    await vi.waitFor(() => expect(c2.textContent).toContain("Wrong password."), { timeout: 20_000 });
    expect(session.journal().swaps).toHaveLength(0);
    await act(async () => { setValue(pw, "a strong password"); });
    await act(async () => { button(c2, "Confirm with the password")!.click(); });
    await vi.waitFor(() => expect(session.journal().swaps).toHaveLength(1), { timeout: 20_000 });
  });

  it("institutional: the review hold schedules the funding no earlier than the cancel window, Fund now waits, and the order exports as JSON", async () => {
    // the separate device registered and asked after the password (audit round 2, r28: this Review had never asked it)
    settings.set({ tiers: { enhanced: 100_000, highValue: 1_000_000, highValueSecondary: 2_000_000, institutional: 3_000_000 }, protection: { ...settings.get().protection, secondDevice: { enabled: true, credentialId: "BAUG" } } });
    const get = vi.fn(async (o: any) => ({ rawId: o.publicKey.allowCredentials[0].id.buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get, create: vi.fn() }, configurable: true });
    (globalThis as any).PublicKeyCredential = class {};
    const container = document.createElement("div");
    await quotedLarge(container);
    await act(async () => { button(container, "Review Swap")!.click(); });
    expect(container.textContent).toContain(`Review hold: after you confirm, the funding waits at least ${REVIEW_HOLD_MINUTES} minutes`);
    expect(button(container, "Export for review (JSON)")).toBeTruthy();
    await act(async () => { button(container, "I accept the single quote")!.click(); });
    const before = Date.now();
    await hold(container);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="second-factor-password"]')).toBeTruthy()); // no authenticator registered: the password
    await act(async () => { setValue(container.querySelector('[data-testid="second-factor-password"] input') as HTMLInputElement, "a strong password"); });
    await act(async () => { button(container, "Confirm with the password")!.click(); });
    await vi.waitFor(() => expect(session.journal().swaps).toHaveLength(1), { timeout: 20_000 });
    expect(get, "the separate device, after the password").toHaveBeenCalledTimes(1);
    expect(Array.from((get.mock.calls[0] as any[])[0].publicKey.allowCredentials[0].id)).toEqual([4, 5, 6]);
    const s = session.journal().swaps[0];
    expect(s.tier).toBe("institutional");
    expect(s.reviewHoldUntil).toBeGreaterThanOrEqual(before + REVIEW_HOLD_MINUTES * 60_000);
    expect(s.dueAt).toBeGreaterThanOrEqual(s.reviewHoldUntil!);
    expect(session.journal().schedule.find((a) => a.orderId === s.orderId)?.dueAt).toBe(s.dueAt);
    expect(container.querySelector('[data-testid="review-hold"]')).toBeTruthy();
    expect(button(container, /Fund now/)!.disabled).toBe(true);
    const exportButton = button(container, "Export for review (JSON)");
    expect(exportButton, "the export stays available on the order").toBeTruthy();
    const clicked: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { clicked.push((this as HTMLAnchorElement).download); };
    try { await act(async () => { exportButton!.click(); }); } finally { HTMLAnchorElement.prototype.click = origClick; }
    expect(clicked[0]).toMatch(/^privacy-wallet-order-[0-9a-f]{8}\.json$/);
  });
});
