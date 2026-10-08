// Local PrivateSwap service for the wallet UI (plan §68): a loopback HTTP API over the engine.
// It never holds money keys: the wallet sends the one-time order SIGNER (an address) and the refund
// note commitments, receives the digest to sign, and returns the signature. Quotes are live. No
// order state is persisted here beyond an in-memory map for the session (the wallet owns the journal).
//   npx tsx src/server.ts            # http://127.0.0.1:8787
import { createServer } from "http";
import { randomBytes } from "crypto";
import { defaultEngine } from "./config";
import { userStatus } from "./order";
import type { TrackStatus, UserStatus } from "./types";

/** What a guest sees for a provider's tracking state (plan §33: never "atomic", always one of these). */
export function guestStatus(s: TrackStatus["state"]): UserStatus {
  switch (s) {
    case "completed": return "Completed";
    case "partial": return "Partial";
    case "refunded": return "Refunded";
    case "failed": return "Failed";
    case "executing": case "destination-submitted": case "destination-final": return "Executing";
    default: return "Pending";
  }
}
import { isPreference, type AssetRef, type Order, type OrderParams, type Policy, type ProviderId, type QuoteRequest, type Tier } from "./types";
import type { PreparedExecution } from "./engine";
import { isTier } from "./valuation";

/** The wallet's own tier of the order (whale spec §1): a hint that can only raise the service's tier. */
const tierHint = (b: any): Tier | undefined => (isTier(b?.tier) ? b.tier : undefined);

const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",");
const engine = defaultEngine();
const orders = new Map<string, { order: Order; prepared?: PreparedExecution }>();

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const asset = (a: any): AssetRef => ({ chain: a.chain, asset: a.asset, decimals: Number(a.decimals), symbol: a.symbol });
const request = (b: any): QuoteRequest => ({ from: asset(b.from), to: asset(b.to), amount: BigInt(b.amount), destination: String(b.destination), slippageBps: Number(b.slippageBps ?? 50) });

async function route(method: string, path: string, body: any): Promise<{ status: number; body: unknown }> {
  if (method === "GET" && path === "/health") {
    const providers = Object.fromEntries(await Promise.all(engine.cfg.adapters.map(async (a) => [a.id, await a.health()])));
    // the deployment every order is built for: the wallet hands (factory, params, execution) to a relayer's swap executor
    return { status: 200, body: { deployment: { chainId: engine.cfg.chainId, factory: engine.cfg.factory, nativeVault: engine.cfg.refundVaults.native }, providers } };
  }
  if (method === "POST" && path === "/quote") {
    const set = await engine.quoteAll(request(body), body.policy as Policy, { tier: tierHint(body) });
    return { status: 200, body: set };
  }
  if (method === "POST" && path === "/order") {
    // the wallet chose a route; it supplies the one-time signer and the pre-generated refund note
    const req = request(body), policy = body.policy as Policy;
    const set = await engine.quoteAll(req, policy, { tier: tierHint(body) });
    const provider = (body.provider ?? set.chosen?.provider) as ProviderId | undefined;
    const quote = set.quotes.find((q) => q.provider === provider);
    if (!quote) return { status: 400, body: { error: `no quote from ${provider ?? "any provider"}`, errors: set.errors } };
    if (set.scores.find((s) => s.provider === provider)?.filtered) return { status: 400, body: { error: `route filtered: ${set.scores.find((s) => s.provider === provider)!.filtered}` } };
    const order = engine.buildOrder(req, policy, quote, {
      orderSigner: String(body.orderSigner), refundOwnerCommitment: BigInt(body.refundOwnerCommitment), refundNoteSecret: BigInt(body.refundNoteSecret), refundNoteDataHash: body.refundNoteDataHash,
    }, { value: set.value ?? { unavailable: true, reason: "not valued" }, tier: set.tier ?? "high-value", failSafe: !set.value || "unavailable" in set.value }, isPreference(body.preference) ? body.preference : undefined);
    orders.set(order.orderId, { order });
    return { status: 200, body: { order, scores: set.scores, status: userStatus(order.state), tier: order.tier, value: order.value } };
  }
  if (method === "POST" && path === "/order/resume") {
    // the wallet persisted the order (encrypted journal) and the service forgot it (restart): rebuild it from the on-chain params
    const req = request(body), policy = body.policy as Policy, provider = body.provider as ProviderId;
    const p = body.params;
    const params: OrderParams = {
      orderId: p.orderId, assetType: Number(p.assetType) as 0 | 1, asset: p.asset, amount: BigInt(p.amount), orderSigner: p.orderSigner, executeDeadline: Number(p.executeDeadline), refundAfter: Number(p.refundAfter),
      refundVault: p.refundVault, refundOwnerCommitment: BigInt(p.refundOwnerCommitment), refundNoteSecret: BigInt(p.refundNoteSecret), refundNoteDataHash: p.refundNoteDataHash, executorTip: BigInt(p.executorTip),
    };
    const set = await engine.quoteAll(req, policy, { tier: tierHint(body) });
    const quote = set.quotes.find((q) => q.provider === provider);
    if (!quote) return { status: 400, body: { error: `no quote from ${provider} right now; retry later`, errors: set.errors } };
    const order = engine.restoreOrder(req, policy, quote, params, { value: set.value ?? { unavailable: true, reason: "not valued" }, tier: set.tier ?? "high-value", failSafe: !set.value || "unavailable" in set.value }, isPreference(body.preference) ? body.preference : undefined);
    orders.set(order.orderId, { order });
    return { status: 200, body: { order, status: userStatus(order.state), tier: order.tier, value: order.value } };
  }
  if (method === "POST" && path === "/prepare") {
    const entry = orders.get(body.orderId);
    if (!entry) return { status: 404, body: { error: "unknown order" } };
    const adapter = engine.cfg.adapters.find((a) => a.id === entry.order.quote.provider)!;
    const prepared = await engine.prepareExecution(entry.order, adapter);
    entry.prepared = prepared;
    return { status: 200, body: { digest: prepared.digest, provider: prepared.provider, value: prepared.value, calldata: prepared.calldata, deadline: prepared.deadline, ingress: prepared.ingress, quote: prepared.quote } };
  }
  if (method === "POST" && path === "/finalize") {
    const entry = orders.get(body.orderId);
    if (!entry?.prepared) return { status: 404, body: { error: "order not prepared" } };
    const execution = engine.attachSignature(entry.order, entry.prepared, body.signature);
    return { status: 200, body: { execution, order: entry.order } };
  }
  // ---- walletless / guest mode (plan §49): no pool, no escrow, no keys — a quote and a one-time deposit instruction
  if (method === "POST" && path === "/guest/quote") {
    const set = await engine.quoteAll(request(body), (body.policy as Policy) ?? "best-price");
    return { status: 200, body: set };
  }
  if (method === "POST" && path === "/guest/ingress") {
    // only providers whose deposit address + memo we verify locally against an independent gateway quorum (THORChain);
    // deposit-address providers that create an order at the provider (1Click, LI.FI smart deposit) are quoted, not instructed
    const req = request(body);
    const adapter = engine.cfg.adapters.find((a) => a.id === "thorchain");
    if (!adapter) return { status: 503, body: { error: "THORChain adapter unavailable" } };
    if (!["bitcoin", "litecoin", "doge"].includes(req.from.chain)) return { status: 400, body: { error: "guest deposits are for native-chain sources (BTC, LTC, DOGE); use the wallet for EVM sources" } };
    const quote = await adapter.quote(req);
    const ingress = await adapter.prepareIngress(req, quote);
    if (ingress.kind !== "plain-address") return { status: 400, body: { error: "no plain deposit address for this route" } };
    return { status: 200, body: { provider: adapter.id, quote, ingress: { to: ingress.to, memo: ingress.memo, amount: req.amount, expiresAt: ingress.expiresAt, verified: ingress.verified ?? [] }, status: "Pending" } };
  }
  if (method === "GET" && path.startsWith("/guest/track/")) {
    const [provider, txid] = path.slice("/guest/track/".length).split("/");
    const adapter = engine.cfg.adapters.find((a) => a.id === provider);
    if (!adapter || !txid) return { status: 404, body: { error: "unknown provider or missing txid" } };
    const t = await adapter.track({ sourceTxHash: txid });
    return { status: 200, body: { track: t, status: guestStatus(t.state) } };
  }
  if (method === "GET" && path.startsWith("/order/")) {
    const entry = orders.get(path.slice("/order/".length));
    return entry ? { status: 200, body: { order: entry.order, status: userStatus(entry.order.state) } } : { status: 404, body: { error: "unknown order" } };
  }
  return { status: 404, body: { error: "no such route" } };
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors: Record<string, string> = origin && ALLOWED_ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" } : {};
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const body = raw ? JSON.parse(raw) : {};
    const out = await route(req.method ?? "GET", (req.url ?? "/").split("?")[0], body);
    res.writeHead(out.status, { ...cors, "content-type": "application/json" });
    res.end(json(out.body));
  } catch (e) {
    res.writeHead(500, { ...cors, "content-type": "application/json" });
    res.end(json({ error: String((e as Error).message ?? e) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`private-swap service on http://127.0.0.1:${PORT} (session id ${randomBytes(4).toString("hex")}); origins: ${ALLOWED_ORIGINS.join(", ")}`));
