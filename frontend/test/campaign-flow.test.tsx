// @vitest-environment happy-dom
// A protected execution end to end on the Swap screen (High-Value Protection spec §3, §7, §14, §15, Stage 5) against
// the swap service's REAL engine and risk layer behind a fetch mock, Chainlink served by the mock RPC: at $1M the
// protection line, the wizard (risk → privacy → destination), the Review with the maximum-loss model and the combined
// verdict, the hold, then the journaled campaign with its pieces in band and its first tick; the runner's default I/O
// takes the first step through commit (/order with the mode and the short window) → fund (the private withdrawal
// stands in) → sign (the hard quote, the wallet's own read of the provider call, the simulation) → hand-over (finalize,
// the executor) and tracks it, while the second step waits. At $5M the authenticator is asked after the hold; at $10M
// the separate device and the review hold apply, and the plan exports as JSON.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, getAddress } from "viem";
import { Swap } from "../src/components/Swap";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";
import { noteStore } from "../src/wallet/notes";
import { priceStore } from "../src/sdk/prices";
import { PINNED, thorAsset } from "../src/sdk/providerCall";
import { REVIEW_HOLD_MINUTES } from "../src/sdk/tiers";
import { campaignsOf } from "../src/wallet/campaigns";
import { runCampaignTick, resetRunnerMemory } from "../src/wallet/campaignRunner";
import { pendingActions } from "../src/wallet/schedule";
import type { Deployment } from "../src/sdk/chain";
import { PrivateSwapEngine, type PreparedExecution } from "../../services/private-swap/src/engine";
import { buildMemo, encodeDepositWithExpiry } from "../../services/private-swap/src/adapters/thorchain";
import { recommendProtection } from "../../services/private-swap/src/risk/protection";
import type { AssetRef, Ingress, Order, OrderParams, ProviderAdapter, Quote, QuoteRequest } from "../../services/private-swap/src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// the private withdrawal that funds a step is covered by the funding tests; here it stands in and records the escrow it pays (fundEscrow's own checks — the balance, the recomputed escrow — still run)
const fundHook = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sdk/privateTx")>()),
  recoverSwapRefunds: async () => [],
  privateWithdrawal: async (o: any) => { fundHook.calls.push(String(o.recipient).toLowerCase()); return { txHash: "0x" + "11".repeat(32), proofMs: 1, verifiedLocally: true, spent: [], submittedBy: "relayer" }; },
}));

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const VAULT = getAddress("0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb");
const RELAYER_EOA = getAddress("0x00000000000000000000000000000000000000ee");
const ETH_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY };
const eth = (n: number) => BigInt(n) * 10n ** 18n;
/** 1 ETH = 0.03 BTC; the minimum 0.5 % under; quoted on the net amount as the real engine does (the escrow pays the tip) */
const RATE = 3_000_000n; // sats per ETH
const minFor = (amount: bigint) => { const out = (amount * RATE) / 10n ** 18n; return { toAmount: out, toAmountMin: out - out / 200n }; };
const net = (a: bigint) => a - (a * 25n) / 10000n;

const engine = new PrivateSwapEngine({ adapters: [], factory: FACTORY, escrowCreationCode: read("../../contracts/abi/periphery/SwapOrderEscrow.json").bytecode, chainId: 1n, refundVaults: { native: ETH_VAULT }, tipBps: 25, refundWindowSeconds: 7200 });
const now = () => Math.floor(Date.now() / 1000);
const thorQuote = (amount: bigint): Quote => ({ provider: "thorchain", category: "A", ...minFor(amount), fees: [], etaSeconds: 1400, expiresAt: now() + 600, nativeAssets: true, minOutEncoded: true, minOutVerified: true, hops: [], raw: {}, obtainedAt: Date.now(), plan: { mode: "streaming", parts: 205, intervalBlocks: 1, expectedSeconds: 1400 }, impactBps: 9, limits: {} } as Quote);
const thorchain: ProviderAdapter = {
  id: "thorchain", implemented: true, capabilities: () => ({ contractSender: true, destinationLinkPublic: true, linkEvidence: "memo" }) as any,
  quote: async (req: QuoteRequest) => thorQuote(req.amount),
  prepareIngress: async (req: QuoteRequest, q: Quote): Promise<Ingress> => {
    const memo = buildMemo(thorAsset(BTC), req.destination, q.toAmountMin, req.source, { interval: 1, quantity: 205 });
    return { kind: "contract-call", to: PINNED.thorchainRouter, calldata: encodeDepositWithExpiry(VAULT, "0x0000000000000000000000000000000000000000", req.amount, memo, BigInt(now() + 600)), value: req.amount, memo, expiresAt: q.expiresAt, minOutEncoded: true };
  },
  track: async () => ({ state: "unknown" }), health: async () => ({}) as any,
};
const orders = new Map<string, { order: Order; prepared?: PreparedExecution }>();
const wire = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const json = (x: unknown, status = 200) => new Response(wire(x), { status, headers: { "content-type": "application/json" } });
const request = (b: any): QuoteRequest => ({ from: { ...b.from, decimals: Number(b.from.decimals) }, to: { ...b.to, decimals: Number(b.to.decimals) }, amount: BigInt(b.amount), destination: String(b.destination), slippageBps: Number(b.slippageBps ?? 50) });
const score = { provider: "thorchain", total: 80, components: { price: 80, security: 69, privacy: 72, latency: 60, liquidity: 80, reliability: 100 } };
const calls: string[] = [];
const bodies: Record<string, any[]> = {};
const jobs = new Map<string, string>();
const tierOf = (usd: number) => (usd >= 10_000_000 ? "institutional" : usd >= 5_000_000 ? "high-value-secondary" : usd >= 1_000_000 ? "high-value" : usd >= 100_000 ? "enhanced" : "standard");

function quoteSetFor(body: any) {
  const req = request(body);
  const q = thorQuote(net(req.amount));
  const usd = (Number(req.amount) / 1e18) * 2500;
  const tier = tierOf(usd);
  const set = { quotes: [q], scores: [score], errors: {}, chosen: score, links: { thorchain: { public: true, evidence: "memo" } }, policy: "privacy-execution", tier, value: { usd, at: Date.now(), source: "chainlink" }, competition: [{ provider: "thorchain", outcome: "quoted", ms: 900 }, { provider: "chainflip", outcome: "refused", reason: "insufficient liquidity", ms: 1200 }], health: {} };
  // the real risk layer (services/private-swap/src/risk/protection.ts) on the mock's competition: the recommendation the wallet turns into its own bounds
  const protection = recommendProtection({ set: set as any, req, amount: req.amount, tier: tier as any, mode: body.mode ?? "balanced", usdPerUnit: 2500, rng: () => 0.5 });
  return { ...set, ...(protection ? { protection } : {}) };
}
async function service(path: string, body: any): Promise<Response> {
  (bodies[path] ??= []).push(body);
  switch (path) {
    case "/quote": return json(quoteSetFor(body));
    case "/order": {
      const req = request(body);
      const order = engine.buildOrder(req, body.policy, thorQuote(net(req.amount)), { orderSigner: body.orderSigner, refundOwnerCommitment: BigInt(body.refundOwnerCommitment), refundNoteSecret: BigInt(body.refundNoteSecret), refundNoteDataHash: body.refundNoteDataHash }, undefined, undefined, { executeWindowSeconds: body.executeWindowSeconds });
      orders.set(order.orderId, { order });
      const set = quoteSetFor(body);
      return json({ order: { ...order, tier: set.tier, value: set.value }, scores: [score], status: "Pending", competition: set.competition, protection: (set as any).protection });
    }
    case "/order/resume": {
      const p = body.params;
      const params: OrderParams = { ...p, assetType: Number(p.assetType), amount: BigInt(p.amount), executeDeadline: Number(p.executeDeadline), refundAfter: Number(p.refundAfter), refundOwnerCommitment: BigInt(p.refundOwnerCommitment), refundNoteSecret: BigInt(p.refundNoteSecret), executorTip: BigInt(p.executorTip) };
      const req = request(body);
      const order = engine.restoreOrder(req, body.policy, thorQuote(net(req.amount)), params);
      orders.set(order.orderId, { order });
      return json({ order, status: "Pending" });
    }
    case "/prepare": {
      const e = orders.get(body.orderId)!;
      e.prepared = await engine.prepareExecution(e.order, thorchain);
      const p = e.prepared;
      return json({ digest: p.digest, provider: p.provider, value: p.value, calldata: p.calldata, deadline: p.deadline, ingress: p.ingress, quote: p.quote, plan: p.quote.plan });
    }
    case "/finalize": {
      const e = orders.get(body.orderId)!;
      return json({ execution: engine.attachSignature(e.order, e.prepared!, body.signature), order: e.order });
    }
    case "/health": return json({ deployment: { chainId: "1", factory: FACTORY, nativeVault: ETH_VAULT }, providers: {} });
  }
  if (path.startsWith("/risk/")) return json({ provider: "thorchain", model: { class: "R5", flags: [], custody: "tss-vaults", gate: "destination-final", pFailPrior: 0.02, bandBps: [100, 250] }, security: { total: 69, baseline: 84, incidents: -15, incidentList: [] }, breaker: { open: null, failures: { consecutive: 0, windowCount: 0 }, stalls: 0, divergences: 0, probe: false, lastIncidentAt: null }, record: null, routes: [] });
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
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `mock rpc: ${method} unsupported` } };
}
const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const u = new URL(url);
  calls.push(`${u.host}${u.pathname}`);
  if (u.pathname.endsWith("/thorchain/inbound_addresses")) return json([{ chain: "ETH", address: VAULT, router: PINNED.thorchainRouter, halted: false }]);
  if (u.host === "127.0.0.1:1") return json(Array.isArray(body) ? body.map(rpc) : rpc(body));
  if (u.host === "127.0.0.1:8787") return service(u.pathname, body);
  if (u.host === "127.0.0.1:8790") {
    if (u.pathname === "/info") return json({ chainId: 1, core: deployment.core, feeVault: ETH_VAULT, relayer: RELAYER_EOA, privacyAddress: "", minFeeWei: "1000000000000000", gasPriceWei: "20000000000", gasEstimate: "0", feeMarginBps: 0, requireReadableFeePayload: false, inflight: 0 });
    if (u.pathname === "/swap/execute") jobs.set(String(body.params.orderId).toLowerCase(), "executing");
    const id = String(body?.params?.orderId ?? u.pathname.slice("/swap/".length)).toLowerCase();
    if (!jobs.has(id)) return json({ error: "unknown swap job" }, 404);
    return json({ id, escrow: FACTORY, state: jobs.get(id), updatedAt: Date.now() });
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
  session.forget(); settings.reset(); noteStore.clear(); calls.length = 0; orders.clear(); jobs.clear(); fundHook.calls.length = 0; resetRunnerMemory();
  for (const k of Object.keys(bodies)) delete bodies[k];
  delete (navigator as any).credentials; delete (globalThis as any).PublicKeyCredential;
});

const button = (c: HTMLElement, text: string | RegExp) => [...c.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
const line = (c: HTMLElement, id: string) => c.querySelector(`[data-line="${id}"]`)!;
async function hold(c: HTMLElement) {
  const b = c.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement;
  expect(b, "a hold, never a tap").toBeTruthy();
  expect(b.disabled, c.textContent?.slice(-600)).toBe(false);
  await act(async () => { b.dispatchEvent(new Event("pointerdown", { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
}
async function mount(container: HTMLElement) {
  if (root) act(() => root!.unmount());
  await act(async () => { root = createRoot(container); root.render(<Swap masterSeed={session.state().seed!} deployment={deployment} />); });
}
/** A wallet with a 5,000 ETH note, the price read, the amount typed and quoted. */
async function quoted(container: HTMLElement, amountEth: string) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: eth(5000), ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
  await priceStore.refresh(deployment, { force: true });
  expect(priceStore.state().status).toBe("ready");
  await mount(container);
  await act(async () => { setValue(container.querySelector('input[inputmode="decimal"]') as HTMLInputElement, amountEth); });
  await act(async () => { button(container, "Get a quote")!.click(); });
  await vi.waitFor(() => expect(button(container, "Review")).toBeTruthy());
}
/** The wizard's three steps, then the Review. */
async function throughWizard(container: HTMLElement) {
  await act(async () => { button(container, "Review")!.click(); });
  const wizard = () => container.querySelector('[data-testid="campaign-wizard"]');
  expect(wizard()!.getAttribute("data-step")).toBe("0");
  expect(container.querySelector('[data-testid="wizard-risk"]')!.textContent).toContain("class R5");
  await act(async () => { button(container, "Continue")!.click(); });
  expect(wizard()!.getAttribute("data-step")).toBe("1");
  expect(container.querySelector('[data-testid="wizard-privacy"]')!.textContent).toContain("What a protected execution reveals");
  expect(container.querySelector('[data-testid="privacy-lint"]')).toBeTruthy();
  await act(async () => { button(container, "Continue")!.click(); });
  expect(wizard()!.getAttribute("data-step")).toBe("2");
  expect(container.querySelector('[data-testid="wizard-destination"]')!.textContent).toContain("its own fresh address");
  await act(async () => { button(container, "Continue to the review")!.click(); });
  await vi.waitFor(() => expect(container.querySelector('[data-testid="review"]')?.getAttribute("data-moment")).toBe("campaign"));
}
const tick = () => runCampaignTick(pendingActions().find((a) => a.kind === "campaign-tick")!, { masterSeed: session.state().seed!, deployment });

describe("a protected execution on the Swap screen (happy-dom, real engine and risk layer)", () => {
  it("$1M: the protection line, the wizard, the Review with the maximum-loss model and the verdict, the hold; the campaign is journaled and its first step runs while the second waits", async () => {
    const container = document.createElement("div");
    await quoted(container, "400"); // $1,000,000 at $2,500: high-value
    expect(container.textContent).toContain("≈ $1,000,000");
    const lineEl = container.querySelector('[data-testid="protection-line"]')!;
    expect(lineEl.textContent).toMatch(/Protected execution: about \d+ steps of ≈ \$[\d.,]+K? · one at a time · at most \$[\d.,]+K? at risk · about /);
    expect(bodies["/quote"][0].mode, "the quote asks for the protection mode").toBe("balanced");
    await throughWizard(container);
    expect(container.querySelector('[data-testid="maximum-loss"]')!.textContent).toContain("In-flight cap");
    expect(container.querySelector('[data-testid="maximum-loss"]')!.textContent).toMatch(/Preparation cost.*private withdrawals/);
    const verdict = container.querySelector('[data-testid="verdict"]')!;
    expect(verdict.querySelector('[data-testid="verdict-security"]')!.textContent).toMatch(/Safe to execute|Review/);
    expect(verdict.querySelector('[data-testid="verdict-privacy"]')!.textContent).toMatch(/Excellent|Good|Reduced/);
    expect(line(container, "exposure").getAttribute("data-ok")).toBe("1");
    expect(line(container, "security").getAttribute("data-ok")).toBe("1");
    expect(line(container, "route").getAttribute("data-ok"), "a single quote must be acknowledged").toBe("0");
    await act(async () => { button(container, "I accept the single quote")!.click(); });
    await act(async () => { button(container, "Advanced details")!.click(); });
    expect(container.querySelector('[data-testid="protection-details"]')!.textContent).toContain("Settlement gate");
    await hold(container);
    await vi.waitFor(() => expect(campaignsOf(session.journal())).toHaveLength(1), { timeout: 20_000 });
    const c = campaignsOf(session.journal())[0];
    expect(c.state).toBe("user-confirmed");
    expect(c).toMatchObject({ provider: "thorchain", tier: "high-value", mode: "balanced", policy: "privacy-execution", gasPriceAtConfirmationWei: "20000000000" });
    expect(c.bounds).toMatchObject({ amountInLimit: eth(400).toString(), executeWindowSeconds: 7200, destination: { kind: "fresh-per-tranche" } });
    expect(BigInt(c.bounds.maxExternalExposure)).toBe(eth(10)); // 2.5 % of 400 ETH
    expect(c.plan).toMatchObject({ riskClass: "R5", capBps: 250, concurrency: "sequential", gate: "destination-final" });
    // the band comes from the risk engine: THORChain's security score (69, the incident still decaying) narrows it to its lower edge (1 %), the cap stays 2.5 %
    expect(c.plan.bandBps).toEqual([100, 100]);
    const [lo, hi] = [(eth(400) * BigInt(c.plan.bandBps[0])) / 10000n, (eth(400) * BigInt(c.plan.bandBps[1])) / 10000n];
    for (const t of c.tranches.slice(0, -1)) { expect(BigInt(t.amount)).toBeLessThanOrEqual(hi); expect(BigInt(t.amount)).toBeGreaterThanOrEqual(lo); }
    expect(BigInt(c.tranches.at(-1)!.amount)).toBeLessThanOrEqual(hi);
    expect(c.tranches.length).toBe(100);
    expect(c.tranches.reduce((s, t) => s + BigInt(t.amount), 0n)).toBe(eth(400));
    expect(BigInt(c.referenceRateE18)).toBeGreaterThan(0n);
    expect(c.lint).toBeTruthy();
    expect((c.riskSnapshot as any).privacyScore).toBe(72);
    expect(pendingActions().map((a) => a.kind)).toEqual(["campaign-tick"]);
    expect(container.querySelector('[data-testid="campaign-progress"]')!.getAttribute("data-state")).toBe("user-confirmed");
    expect(container.querySelector('[data-testid="campaign-step"]')!.textContent).toBe(`Step 1 of ~${c.tranches.length}`);
    // the runner: one action per tick with the wallet's own modules against the real engine
    let r = await tick();
    expect(r?.action).toMatchObject({ kind: "commit", index: 0 });
    const child = session.journal().swaps.find((s) => s.campaign?.id === c.id)!;
    expect(child.campaign).toEqual({ id: c.id, index: 0 });
    expect(BigInt((child.params as any).amount)).toBe(BigInt(c.tranches[0].amount));
    expect(bodies["/order"].at(-1).executeWindowSeconds, "the short window travels with the order").toBe(7200);
    expect(Number((child.params as any).executeDeadline) - Number((child.quote as any).expiresAt)).toBe(7200);
    expect(bodies["/order"].at(-1).mode).toBe("balanced");
    expect(bodies["/order"].at(-1).provider, "the service chooses the route at the step's size; a change goes through the reroute Review").toBeUndefined();
    expect(child.provider).toBe("thorchain");
    expect(pendingActions().filter((a) => a.kind === "fund-escrow"), "a step is funded by its campaign").toHaveLength(0);
    r = await tick();
    expect(r?.action.kind).toBe("fund");
    expect(fundHook.calls).toEqual([child.endpoint.toLowerCase()]);
    r = await tick();
    expect(r?.action.kind).toBe("sign");
    expect(campaignsOf(session.journal())[0].tranches[0].state).toBe("signed");
    expect(calls.filter((x) => x.endsWith("/thorchain/inbound_addresses")).length, "the wallet asked the three gateways itself before signing").toBe(3);
    expect(session.journal().swaps[0].simulation).toMatchObject({ ok: true });
    expect(calls).not.toContain("127.0.0.1:8787/finalize");
    r = await tick();
    expect(r?.action.kind).toBe("hand-over");
    expect(calls).toContain("127.0.0.1:8787/finalize");
    expect(calls).toContain("127.0.0.1:8790/swap/execute");
    let cur = campaignsOf(session.journal())[0];
    expect(cur.tranches[0]).toMatchObject({ state: "executing", jobId: expect.any(String) });
    r = await tick();
    expect(r?.action.kind).toBe("track");
    cur = campaignsOf(session.journal())[0];
    expect(cur.tranches[0].state).toBe("source-confirmed");
    expect(cur.tranches[1].state, "sequential: the second step waits").toBe("planned");
    expect(fundHook.calls).toHaveLength(1);
    await mount(container); // a reload: the campaign comes back from the journal
    await act(async () => { button(container, "Open")!.click(); });
    expect(container.querySelector('[data-testid="campaign-status"]')!.textContent).toBe("● Processing");
    expect(container.querySelector('[data-testid="campaign-amounts"]')!.textContent).toContain("In progress");
  }, 60_000);

  it("$5M: the authenticator is asked after the hold and the confirmation is journaled with the campaign", async () => {
    settings.set({ secondFactor: { enabled: true, credentialId: "AQID" } });
    const get = vi.fn(async (o: any) => ({ rawId: o.publicKey.allowCredentials[0].id.buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get, create: vi.fn() }, configurable: true });
    (globalThis as any).PublicKeyCredential = class {};
    const container = document.createElement("div");
    await quoted(container, "2000"); // $5,000,000: high-value-secondary
    await throughWizard(container);
    expect(container.textContent).toContain("second confirmation next");
    await act(async () => { button(container, "I accept the single quote")!.click(); });
    await hold(container);
    await vi.waitFor(() => expect(campaignsOf(session.journal())).toHaveLength(1), { timeout: 20_000 });
    expect(get).toHaveBeenCalledTimes(1);
    const c = campaignsOf(session.journal())[0];
    expect(c.tier).toBe("high-value-secondary");
    expect(c.confirmations.secondFactor).toBeGreaterThan(0);
    expect(c.confirmations.secondDevice).toBeUndefined();
    expect(c.plan.capBps, "2 % from the second-confirmation tier").toBe(200);
  }, 60_000);

  it("$10M: the separate device after the second factor, the review hold before the first step, the export", async () => {
    settings.set({ secondFactor: { enabled: true, credentialId: "AQID" }, protection: { ...settings.get().protection, secondDevice: { enabled: true, credentialId: "BAUG" } } });
    const get = vi.fn(async (o: any) => ({ rawId: o.publicKey.allowCredentials[0].id.buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get, create: vi.fn() }, configurable: true });
    (globalThis as any).PublicKeyCredential = class {};
    const container = document.createElement("div");
    await quoted(container, "4000"); // $10,000,000: institutional
    await throughWizard(container);
    expect(container.textContent).toContain(`Review hold: after you confirm, the funding waits at least ${REVIEW_HOLD_MINUTES} minutes`);
    expect(button(container, "Export for review (JSON)")).toBeTruthy();
    await act(async () => { button(container, "I accept the single quote")!.click(); });
    const before = Date.now();
    await hold(container);
    await vi.waitFor(() => expect(campaignsOf(session.journal())).toHaveLength(1), { timeout: 20_000 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(Array.from((get.mock.calls[1] as any[])[0].publicKey.allowCredentials[0].id)).toEqual([4, 5, 6]);
    const c = campaignsOf(session.journal())[0];
    expect(c.tier).toBe("institutional");
    expect(c.confirmations.secondDevice).toBeGreaterThanOrEqual(before);
    expect(c.plan).toMatchObject({ capBps: 200, concurrency: "sequential" });
    expect(c.tranches[0].notBefore!, "the review hold before the first step").toBeGreaterThanOrEqual(before + REVIEW_HOLD_MINUTES * 60_000 - 1000);
    const r = await tick();
    expect(r?.action.kind, "nothing starts before the hold").toBe("wait");
    expect(session.journal().swaps).toHaveLength(0);
    // without a registered device the same confirmation is refused
    session.forget(); settings.reset(); noteStore.clear(); resetRunnerMemory();
    settings.set({ secondFactor: { enabled: true, credentialId: "AQID" } });
    const c2 = document.createElement("div");
    await quoted(c2, "4000");
    await throughWizard(c2);
    await act(async () => { button(c2, "I accept the single quote")!.click(); });
    await hold(c2);
    await vi.waitFor(() => expect(c2.querySelector('[data-testid="second-device-error"]')).toBeTruthy(), { timeout: 20_000 });
    expect(campaignsOf(session.journal())).toHaveLength(0);
  }, 90_000);
});
