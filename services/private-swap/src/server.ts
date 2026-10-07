// Local PrivateSwap service for the wallet UI (plan §68): a loopback HTTP API over the engine.
// It never holds money keys: the wallet sends the one-time order SIGNER (an address) and the refund
// note commitments, receives the digest to sign, and returns the signature. Quotes are live. No
// order state is persisted here beyond an in-memory map for the session (the wallet owns the journal).
//   npx tsx src/server.ts            # http://127.0.0.1:8787
import { createServer } from "http";
import { randomBytes } from "crypto";
import { defaultEngine } from "./config";
import { userStatus } from "./order";
import type { AssetRef, Order, Policy, ProviderId, QuoteRequest } from "./types";
import type { PreparedExecution } from "./engine";

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
    const set = await engine.quoteAll(request(body), body.policy as Policy);
    return { status: 200, body: set };
  }
  if (method === "POST" && path === "/order") {
    // the wallet chose a route; it supplies the one-time signer and the pre-generated refund note
    const req = request(body), policy = body.policy as Policy;
    const set = await engine.quoteAll(req, policy);
    const provider = (body.provider ?? set.chosen?.provider) as ProviderId | undefined;
    const quote = set.quotes.find((q) => q.provider === provider);
    if (!quote) return { status: 400, body: { error: `no quote from ${provider ?? "any provider"}`, errors: set.errors } };
    if (set.scores.find((s) => s.provider === provider)?.filtered) return { status: 400, body: { error: `route filtered: ${set.scores.find((s) => s.provider === provider)!.filtered}` } };
    const order = engine.buildOrder(req, policy, quote, {
      orderSigner: String(body.orderSigner), refundOwnerCommitment: BigInt(body.refundOwnerCommitment), refundNoteSecret: BigInt(body.refundNoteSecret), refundNoteDataHash: body.refundNoteDataHash,
    });
    orders.set(order.orderId, { order });
    return { status: 200, body: { order, scores: set.scores, status: userStatus(order.state) } };
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
