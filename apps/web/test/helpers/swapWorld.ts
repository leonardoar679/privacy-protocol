// The swap service's world for the Swap flow tests (happy-dom): the REAL engine behind a fetch mock that stands in for
// HTTP — the API's /v1 routes in front of the V5-shaped service, a THORChain adapter built on the adapter's own
// encoders (`world.bend` makes it dishonest: another receiver, a lower limit), three THORNode gateways, the relayer's
// /info and swap jobs, the deployment's RPC endpoint (the Chainlink feed, the pre-trade simulation; `world.rpcBend` makes
// it revert). Every request is kept for the leakage gate. Shared by swap-flow.test.tsx (the protected-execution screen)
// and swap-one-confirm.test.tsx (V6 Stage 11).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { encodeAbiParameters, encodeErrorResult, getAddress, parseAbi, type Hex } from "viem";
import { PINNED, thorAsset, thornodeGateways } from "@privacy-wallet/sdk/providerCall";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { PrivateSwapEngine, type PreparedExecution } from "@privacy-wallet/swap-engine/engine";
import { buildMemo, encodeDepositWithExpiry } from "@privacy-wallet/swap-engine/adapters/thorchain";
import type { AssetRef, Ingress, Order, OrderParams, ProviderAdapter, Quote, QuoteRequest } from "@privacy-wallet/swap-engine/types";
import { privacyAddress } from "@privacy-wallet/sdk/privateTx";
import { v1Adapter } from "./apiV1";

// (a plain concatenation: Vite rewrites `new URL(<template>, import.meta.url)` into an asset lookup)
const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL("../" + rel, import.meta.url)), "utf8"));
export const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
export const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
export const VAULT = getAddress("0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb");
export const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
export const LIMIT = 3_000_000n;
export const deployment: Deployment = {
  chainId: 1,
  core: getAddress("0x00000000000000000000000000000000000000c0"),
  ethVault: ETH_VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
  swapFactory: FACTORY,
};

// ---- the swap service: the real engine, a THORChain adapter on the real encoders, `bend` = dishonesty
export const engine = new PrivateSwapEngine({
  adapters: [],
  factory: FACTORY,
  escrowCreationCode: read("../../../contracts/abi/periphery/SwapOrderEscrow.json").bytecode,
  chainId: 1n,
  refundVaults: { native: ETH_VAULT },
  tips: { tipFor: async (_from, amount) => amount / 400n } /* a fixed 0.25 %: the service prices the gas (swap-engine tips.ts) */,
  refundWindowSeconds: 7200,
});
/** another of THORChain's active ETH vaults (THORChain moves its suggestion between them) */
export const VAULT_2 = getAddress("0x46f3fb8c14006268d153b18000495c8ee858e94b");
export const world: {
  bend: { dest?: string; limit?: bigint };
  rpcBend: { revert?: Hex; providerReason?: string };
  ttlSeconds: number;
  /** V6 Stage 13: the service's protection plan for the $50K band (the engine's recommendation), when set */
  protection?: unknown;
  /** the THORNode gateways (2026-10-14): the vault they suggest, the active vaults they list, how many (the first) do not answer, a halt */
  gateways: { inbound: string; active: string[]; down: number; halted?: boolean };
  /** the vault the service's THORChain deposit names */
  callVault: string;
  /** a V6 follow-up of 2026-10-16: what else the relayer's /info names (its swapFactory, its vouchers), when set */
  relayerInfo?: Record<string, unknown>;
  /** the same follow-up: what else the service's status names of its deployment (its voucher, its previousVouchers), when set */
  serviceDeployment?: Record<string, unknown>;
  /** 2026-10-17 (the audit's unverified m57): the ETH / USD feed does not answer — the wallet's band is the fail-safe one */
  feedDown?: boolean;
  /** audit round 2, critic gap 4: the fee history does not answer — the wallet cannot check the executor's tip */
  feesDown?: boolean;
  /** V7 Stage 13: the §46 quote's risk assessment the service answers with (its blockers: the route's qualification) */
  quoteRisk?: { score: number; level: "low" | "medium" | "high"; blockers: string[]; warnings: string[]; wholeOrderQualified?: boolean };
  /** the seventh review round: the quote set's executor tip (the Review shows it), and a tip the service prices again at the commit */
  quoteTip?: bigint;
  orderTip?: bigint;
  /** the ninth review round: the escrow's balance the RPC answers (eth_getBalance), when set; unset, the read fails as before */
  escrowBalance?: bigint;
  /** the eleventh review round (E11-9): the commit's execute window built from the wallet's request, as the swap API builds it (routes/swap.ts
   *  windowOf → the engine's executeWindowFor) — a delayed order's is the delay plus 30 minutes; unset, the policy's whole budget as before */
  windowAsAsked?: boolean;
} = {
  bend: {},
  rpcBend: {},
  ttlSeconds: 600,
  gateways: { inbound: VAULT, active: [VAULT, VAULT_2], down: 0 },
  callVault: VAULT,
};
const now = () => Math.floor(Date.now() / 1000);
export const thorQuote = (): Quote => ({
  provider: "thorchain",
  category: "A",
  toAmount: LIMIT + 30_000n,
  toAmountMin: LIMIT,
  fees: [],
  etaSeconds: 600,
  expiresAt: now() + world.ttlSeconds,
  nativeAssets: true,
  minOutEncoded: true,
  minOutVerified: true,
  hops: [],
  raw: {},
  obtainedAt: Date.now(),
});
export const thorchain: ProviderAdapter = {
  id: "thorchain",
  implemented: true,
  capabilities: () => ({ contractSender: true, destinationLinkPublic: true, linkEvidence: "memo" }) as any,
  quote: async () => thorQuote(),
  prepareIngress: async (req: QuoteRequest, q: Quote): Promise<Ingress> => {
    const memo = buildMemo(thorAsset(BTC), world.bend.dest ?? req.destination, world.bend.limit ?? LIMIT, req.source);
    return {
      kind: "contract-call",
      to: PINNED.thorchainRouter,
      calldata: encodeDepositWithExpiry(world.callVault, "0x0000000000000000000000000000000000000000", req.amount, memo, BigInt(now() + 600)),
      value: req.amount,
      memo,
      expiresAt: q.expiresAt,
      minOutEncoded: true,
    };
  },
  track: async () => ({ state: "unknown" }),
  health: async () => ({}) as any,
};
export const orders = new Map<string, { order: Order; prepared?: PreparedExecution }>();
const wire = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const json = (x: unknown, status = 200) => new Response(wire(x), { status, headers: { "content-type": "application/json" } });
const request = (b: any): QuoteRequest => ({
  from: { ...b.from, decimals: Number(b.from.decimals) },
  to: { ...b.to, decimals: Number(b.to.decimals) },
  amount: BigInt(b.amount),
  destination: String(b.destination),
  slippageBps: Number(b.slippageBps ?? 50),
});
const score = { provider: "thorchain", total: 80, components: { price: 80, security: 90, privacy: 70, latency: 60, liquidity: 80, reliability: 90 } };
export const calls: string[] = [];
export const relayerBodies: any[] = [];
/** V6 follow-up (2026-10-16, audit gap 47): the mock API's vouches, what the wallet showed at each finalize, the executions it handed over */
export const ORDER_VOUCH = ("0x" + "a1".repeat(65)) as Hex;
export const CALL_VOUCH = ("0x" + "c2".repeat(65)) as Hex;
export const finalizeVouches: unknown[] = [];
export const executeBodies: any[] = [];
export const jobs = new Map<string, string>();
export const RELAYER_EOA = getAddress("0x00000000000000000000000000000000000000ee");
// the deployment's RPC endpoint: the pre-trade simulation (whale spec §24) runs deployAndExecute here; `rpcBend` makes it revert
export const rpcSeen: any[] = [];
// Chainlink's ETH / USD proxy on mainnet (the deployment is chain 1): $2,500, so 0.5 ETH is a standard-tier swap (one tap, no Review)
const ETH_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
function rpc(req: any) {
  const { id, method } = req;
  if (method === "eth_call") {
    const tx = req.params[0];
    if (String(tx.to).toLowerCase() === ETH_FEED) {
      if (world.feedDown) return { jsonrpc: "2.0", id, error: { code: -32000, message: "mock: the feed does not answer" } };
      if (String(tx.data).startsWith("0x7284e416")) return { jsonrpc: "2.0", id, result: encodeAbiParameters([{ type: "string" }], ["ETH / USD"]) };
      const t = BigInt(Math.floor(Date.now() / 1000) - 60);
      return {
        jsonrpc: "2.0",
        id,
        result: encodeAbiParameters(
          [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
          [7n, 2_500_00000000n, t, t, 7n],
        ),
      };
    }
    if (String(tx.to).toLowerCase() !== FACTORY.toLowerCase() && String(tx.to).toLowerCase() !== PINNED.thorchainRouter.toLowerCase())
      return { jsonrpc: "2.0", id, error: { code: -32000, message: "mock: no contract" } }; // the other feeds, the registry
    rpcSeen.push(tx);
    if (world.rpcBend.revert && String(tx.to).toLowerCase() === FACTORY.toLowerCase())
      return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: world.rpcBend.revert } };
    if (world.rpcBend.providerReason && String(tx.to).toLowerCase() === PINNED.thorchainRouter.toLowerCase())
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: 3,
          message: "execution reverted",
          data: encodeErrorResult({ abi: parseAbi(["error Error(string message)"]), errorName: "Error", args: [world.rpcBend.providerReason] }),
        },
      };
    return { jsonrpc: "2.0", id, result: "0x" };
  }
  if (method === "eth_estimateGas") return { jsonrpc: "2.0", id, result: "0x33450" };
  if (method === "eth_getBalance" && world.escrowBalance !== undefined) return { jsonrpc: "2.0", id, result: "0x" + world.escrowBalance.toString(16) };
  // the fee history the wallet's tip ceiling reads (audit round 2, critic gap 4): 20 gwei base, 2 gwei priority — three
  // times the execution's gas at these fees is far above the service's 0.25 % tip of what these tests swap
  if (method === "eth_feeHistory") {
    if (world.feesDown) return { jsonrpc: "2.0", id, error: { code: -32000, message: "mock: the fee history does not answer" } };
    return {
      jsonrpc: "2.0",
      id,
      result: { oldestBlock: "0x1", baseFeePerGas: Array(6).fill("0x4a817c800"), gasUsedRatio: Array(5).fill(0.5), reward: Array(5).fill(["0x77359400"]) },
    };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `mock rpc: ${method} unsupported` } };
}

async function service(path: string, body: any): Promise<Response> {
  switch (path) {
    case "/quote":
      return json({
        quotes: [thorQuote()],
        scores: [score],
        errors: {},
        chosen: score,
        links: { thorchain: { public: true, evidence: "memo" } },
        ...(world.protection ? { protection: world.protection, tier: "large-protected" } : {}),
        ...(world.quoteRisk ? { quote: { risk: world.quoteRisk } } : {}),
        ...(world.quoteTip !== undefined ? { executorTip: world.quoteTip.toString() } : {}),
      });
    case "/order": {
      const order = engine.buildOrder(
        request(body),
        body.policy,
        // the tip the wallet's Review showed when it names one, as the API builds on it (the seventh review round), unless the test prices it again
        { ...thorQuote(), executorTip: world.orderTip ?? (body.executorTip !== undefined ? BigInt(body.executorTip) : BigInt(request(body).amount) / 400n) },
        {
          orderSigner: body.orderSigner,
          refundOwnerCommitment: BigInt(body.refundOwnerCommitment),
          refundNoteSecret: BigInt(body.refundNoteSecret),
          refundNoteDataHash: body.refundNoteDataHash,
        },
        undefined,
        undefined,
        world.windowAsAsked && Number(body.executeWindowSeconds) > 0 ? { executeWindowSeconds: Number(body.executeWindowSeconds) } : {},
      );
      orders.set(order.orderId, { order });
      return json({ order, scores: [score], status: "Pending", vouch: { order: ORDER_VOUCH } });
    }
    case "/order/resume": {
      const p = body.params;
      const params: OrderParams = {
        ...p,
        assetType: Number(p.assetType),
        amount: BigInt(p.amount),
        executeDeadline: Number(p.executeDeadline),
        refundAfter: Number(p.refundAfter),
        refundOwnerCommitment: BigInt(p.refundOwnerCommitment),
        refundNoteSecret: BigInt(p.refundNoteSecret),
        executorTip: BigInt(p.executorTip),
      };
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
      finalizeVouches.push(body.vouch);
      return json({
        execution: engine.attachSignature(e.order, e.prepared!, body.signature),
        order: e.order,
        ...(body.vouch === ORDER_VOUCH ? { vouch: { execution: CALL_VOUCH } } : {}),
      });
    }
    case "/health":
      return json({ deployment: { chainId: "1", factory: FACTORY, nativeVault: ETH_VAULT, ...(world.serviceDeployment ?? {}) }, providers: {} });
  }
  return json({ error: "no such route" }, 404);
}

// V5 Stage 11 (spec §20–§21): every request of the scenario is kept and read for secrets at the end (the leakage gate)
export const requests: { url: string; body: string | null }[] = [];
const api = v1Adapter(service);
export const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ url, body: init?.body ? String(init.body) : null });
  const u = new URL(url);
  calls.push(`${u.host}${u.pathname.replace(/\/op_[a-z0-9]+\//, "/:id/")}`); // an operation's opaque id as :id
  if (u.pathname.endsWith("/thorchain/inbound_addresses") || u.pathname.endsWith("/thorchain/vaults/asgard")) {
    if (
      thornodeGateways()
        .slice(0, world.gateways.down)
        .some((g) => url.startsWith(g + "/"))
    )
      throw new TypeError("fetch failed");
    if (u.pathname.endsWith("/inbound_addresses"))
      // every chain, as THORNode lists them: the wallet reads the destination's halt too (the eleventh review round, D11-9)
      return json([
        { chain: "ETH", address: world.gateways.inbound, router: PINNED.thorchainRouter, halted: !!world.gateways.halted },
        { chain: "BTC", address: "bc1qthorvault0000000000000000000000000000", halted: false },
      ]);
    return json(world.gateways.active.map((address) => ({ status: "ActiveVault", addresses: [{ chain: "ETH", address }] })));
  }
  if (u.host === "127.0.0.1:1") return json(Array.isArray(body) ? body.map(rpc) : rpc(body)); // the deployment's RPC endpoint (viem batches)
  if (u.host === "127.0.0.1:8787") return api(u.pathname, body); // V6: the API's /v1 routes in front of the V5-shaped mock
  if (u.host === "127.0.0.1:8790") {
    if (u.pathname === "/info")
      return json({
        chainId: 1,
        core: deployment.core,
        feeVault: ETH_VAULT,
        relayer: RELAYER_EOA,
        privacyAddress: privacyAddress(new Uint8Array(32).fill(0x5e)) /* the relayer's, for its fee note (V6: the escrow funding pays the percentage) */,
        minFeeWei: "0",
        gasPriceWei: "0",
        gasEstimate: "0",
        feeMarginBps: 0,
        requireReadableFeePayload: false,
        inflight: 0,
        ...(world.relayerInfo ?? {}),
      });
    if (u.pathname === "/swap/refund") {
      relayerBodies.push(body);
      jobs.set(String(body.params.orderId).toLowerCase(), "refund-only");
    }
    if (u.pathname === "/swap/execute") {
      executeBodies.push(body);
      jobs.set(String(body.params.orderId).toLowerCase(), "executing");
    }
    const id = String(body?.params?.orderId ?? u.pathname.slice("/swap/".length)).toLowerCase();
    if (!jobs.has(id)) return json({ error: "unknown job" }, 404); // V6 Stage 11: the order runner asks by orderId before it hands over
    return json({ id, escrow: FACTORY, state: jobs.get(id), updatedAt: Date.now() });
  }
  return json({ error: `unexpected request ${url}` }, 404);
});

/** Forget what a test changed in the world. */
export function resetWorld(): void {
  world.bend = {};
  world.escrowBalance = undefined;
  world.gateways = { inbound: VAULT, active: [VAULT, VAULT_2], down: 0 };
  world.callVault = VAULT;
  world.protection = undefined;
  world.relayerInfo = undefined;
  world.serviceDeployment = undefined;
  world.feedDown = undefined;
  world.feesDown = undefined;
  world.quoteRisk = undefined;
  world.quoteTip = undefined;
  world.orderTip = undefined;
  world.windowAsAsked = undefined;
  world.rpcBend = {};
  world.ttlSeconds = 600;
  rpcSeen.length = 0;
  calls.length = 0;
  orders.clear();
  relayerBodies.length = 0;
  finalizeVouches.length = 0;
  executeBodies.length = 0;
  jobs.clear();
}
