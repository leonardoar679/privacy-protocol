// Local PrivateSwap service for the wallet UI (plan §68): a loopback HTTP API over the engine.
// It never holds money keys: the wallet sends the one-time order SIGNER (an address) and the refund
// note commitments, receives the digest to sign, and returns the signature. Quotes are live. No
// order state is persisted here beyond an in-memory map for the session (the wallet owns the journal).
// V2 (whale spec §1, §3, §13, §14, §19): the wallet's tier is a hint that can only raise the tier, the
// policy may be derived from a preference, /prepare keeps the minimum approved at commit and runs the
// price guard, and /track reads a provider's status for an executed order.
//   npx tsx src/server.ts            # http://127.0.0.1:8787
import { createServer } from "http";
import { randomBytes } from "crypto";
import { defaultEngine } from "./config";
import { MinimumMovedError, type QuoteHint } from "./engine";
import { TipError } from "./tips";
import { riskDb } from "./risk/riskDb";
import { securityBreakdown } from "./risk/security";
import { incidents } from "./health";
import { STALL_FACTOR, type ProtectionMode } from "@privacy-wallet/protocol/wallet/campaign";
import { riskModelOf } from "@privacy-wallet/protocol/wallet/riskClasses";
import { userStatus } from "./order";
import { maxGapBpsFor, PriceGuardError } from "./scoring";
import { isPolicy, isPreference, type AssetRef, type Order, type OrderParams, type Policy, type Preference, type ProviderId, type QuoteRequest, type Tier, type TrackStatus, type UserStatus } from "./types";
import type { PreparedExecution } from "./engine";
import { isTier } from "./valuation";
import { gatewayConfigFromEnv, gatewayHealth, gatewayQuote } from "./gateway";
import { atLeast } from "@privacy-wallet/protocol/wallet/valuation";

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

/** The wallet's own tier of the order (whale spec §1): a hint that can only raise the service's tier. */
const tierHint = (b: any): Tier | undefined => (isTier(b?.tier) ? b.tier : undefined);
const preferenceOf = (b: any): Preference | undefined => (isPreference(b?.preference) ? b.preference : undefined);
/** A policy given explicitly (V1.1 wallets) must be one of the five; absent, it is derived from the preference and the tier (whale spec §4). */
function policyOf(b: any): Policy | { preference: Preference } {
  if (b?.policy !== undefined) {
    if (!isPolicy(b.policy)) throw new BadRequest(`unknown policy ${JSON.stringify(b.policy)}`);
    return b.policy;
  }
  return { preference: preferenceOf(b) ?? "balanced" };
}
/** V3 (High-Value Protection spec §3, §14): the protection mode and the per-tranche execution window a wallet may send with a quote or an order. */
const modeOf = (b: any): ProtectionMode | undefined => (b?.mode === "balanced" || b?.mode === "max-privacy" || b?.mode === "max-safety" || b?.mode === "best-execution" ? b.mode : undefined);
const windowOf = (b: any): number | undefined => (b?.executeWindowSeconds !== undefined && Number.isFinite(Number(b.executeWindowSeconds)) && Number(b.executeWindowSeconds) > 0 ? Number(b.executeWindowSeconds) : undefined);
const hintsOf = (b: any): QuoteHint => ({ tier: tierHint(b), preference: preferenceOf(b), mode: modeOf(b), executeWindowSeconds: windowOf(b) });
class BadRequest extends Error {}

const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",");
const engine = defaultEngine();
const orders = new Map<string, { order: Order; prepared?: PreparedExecution }>();
const gatewayCfg = gatewayConfigFromEnv(); // the zkAPI quote gateway (whale spec §22): blocked upstream until ZKAPI_UPSTREAM names a deployment

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const asset = (a: any): AssetRef => ({ chain: a.chain, asset: a.asset, decimals: Number(a.decimals), symbol: a.symbol });
const request = (b: any): QuoteRequest => ({
  from: asset(b.from), to: asset(b.to), amount: BigInt(b.amount), destination: String(b.destination), slippageBps: Number(b.slippageBps ?? 50),
  ...(b.destinationKind === "entered" ? { destinationKind: "entered" as const } : {}), ...(b.preferNative === true ? { preferNative: true } : {}),
});
const assessmentOf = (set: { value?: unknown; tier?: Tier }) => ({ value: (set.value as any) ?? { unavailable: true, reason: "not valued" }, tier: set.tier ?? ("high-value" as Tier), failSafe: !set.value || "unavailable" in (set.value as object) });

async function route(method: string, path: string, query: URLSearchParams, body: any, headers: Record<string, string | string[] | undefined> = {}): Promise<{ status: number; body: unknown }> {
  // the metered zkAPI gateway (whale spec §22): runtime-key auth, a fresh request id, 503 with the reason while no upstream exists
  if (method === "GET" && path === "/gateway/health") return { status: 200, body: gatewayHealth(gatewayCfg) };
  if (method === "POST" && path === "/gateway/quote") return gatewayQuote(gatewayCfg, headers, body, async (b: any) => engine.quoteAll(request(b), policyOf(b), hintsOf(b)));
  if (method === "GET" && path === "/health") {
    const providers = Object.fromEntries(await Promise.all(engine.cfg.adapters.map(async (a) => [a.id, await a.health()])));
    // the deployment every order is built for: the wallet hands (factory, params, execution) to a relayer's swap executor
    // V3 (High-Value Protection spec §10): what the risk database holds and the incidents feeding the scores right now
    const db = riskDb(), inc = incidents();
    const byProvider: Record<string, number> = {};
    for (const i of inc) byProvider[i.provider] = (byProvider[i.provider] ?? 0) + 1;
    return { status: 200, body: { deployment: { chainId: engine.cfg.chainId, factory: engine.cfg.factory, nativeVault: engine.cfg.refundVaults.native }, providers, incidents: { total: inc.length, byProvider }, riskDb: { providers: db.providers.size, assets: db.assets.size, routes: db.routes.size, problems: db.problems } } };
  }
  // ---- the risk view of a provider (High-Value Protection spec §10): its database record, the security breakdown, the breaker's state, its routes — stateless, nothing per user
  if (method === "GET" && (path === "/risk" || path.startsWith("/risk/"))) {
    const db = riskDb(), now = Date.now();
    const view = (id: ProviderId) => {
      const record = db.providerRisk(id);
      const { securityEvents: _e, ...fields } = record ?? { provider: id };
      return { provider: id, model: riskModelOf(id, {}, { symbol: "" }, { symbol: "" }, "balanced", db.override(id)), security: securityBreakdown(id, now, db), breaker: engine.tracker.state(id, now), record: record ? fields : null, routes: [...db.routes.values()].filter((r) => r.provider === id).map((r) => ({ pair: r.pair, class: r.class, measuredAt: r.measuredAt, servedUpToUsd: r.servedUpToUsd, gate: r.gate, maxTrancheBps: r.maxTrancheBps, providerShareCapBps: r.providerShareCapBps, minTrancheUsd: r.minTrancheUsd })) };
    };
    if (path === "/risk") return { status: 200, body: { providers: engine.cfg.adapters.map((a) => view(a.id)), problems: db.problems } };
    const id = path.slice("/risk/".length) as ProviderId;
    if (!engine.cfg.adapters.some((a) => a.id === id)) return { status: 404, body: { error: "unknown provider" } };
    return { status: 200, body: view(id) };
  }
  if (method === "POST" && path === "/quote") {
    const set = await engine.quoteAll(request(body), policyOf(body), hintsOf(body));
    return { status: 200, body: set };
  }
  if (method === "POST" && path === "/order") {
    // the wallet chose a route; it supplies the one-time signer and the pre-generated refund note
    const req = request(body);
    const set = await engine.quoteAll(req, policyOf(body), hintsOf(body));
    const provider = (body.provider ?? set.chosen?.provider) as ProviderId | undefined;
    const quote = set.quotes.find((q) => q.provider === provider);
    if (!quote) return { status: 400, body: { error: `no quote from ${provider ?? "any provider"}`, errors: set.errors, competition: set.competition } };
    if (set.scores.find((s) => s.provider === provider)?.filtered) return { status: 400, body: { error: `route filtered: ${set.scores.find((s) => s.provider === provider)!.filtered}`, competition: set.competition } };
    const order = engine.buildOrder(req, set.policy, quote, {
      orderSigner: String(body.orderSigner), refundOwnerCommitment: BigInt(body.refundOwnerCommitment), refundNoteSecret: BigInt(body.refundNoteSecret), refundNoteDataHash: body.refundNoteDataHash,
    }, assessmentOf(set), preferenceOf(body), { executeWindowSeconds: windowOf(body) });
    orders.set(order.orderId, { order });
    return { status: 200, body: { order, scores: set.scores, status: userStatus(order.state), tier: order.tier, value: order.value, policy: set.policy, competition: set.competition, ...(set.protection ? { protection: set.protection } : {}), ...(set.risk ? { risk: set.risk } : {}) } };
  }
  if (method === "POST" && path === "/order/resume") {
    // the wallet persisted the order (encrypted journal) and the service forgot it (restart): rebuild it from the on-chain params
    const req = request(body), provider = body.provider as ProviderId;
    const p = body.params;
    const params: OrderParams = {
      orderId: p.orderId, assetType: Number(p.assetType) as 0 | 1, asset: p.asset, amount: BigInt(p.amount), orderSigner: p.orderSigner, executeDeadline: Number(p.executeDeadline), refundAfter: Number(p.refundAfter),
      refundVault: p.refundVault, refundOwnerCommitment: BigInt(p.refundOwnerCommitment), refundNoteSecret: BigInt(p.refundNoteSecret), refundNoteDataHash: p.refundNoteDataHash, executorTip: BigInt(p.executorTip),
    };
    const set = await engine.quoteAll(req, policyOf(body), hintsOf(body));
    const quote = set.quotes.find((q) => q.provider === provider);
    if (!quote) return { status: 400, body: { error: `no quote from ${provider} right now; retry later`, errors: set.errors, competition: set.competition } };
    const order = engine.restoreOrder(req, set.policy, quote, params, assessmentOf(set), preferenceOf(body));
    orders.set(order.orderId, { order });
    return { status: 200, body: { order, status: userStatus(order.state), tier: order.tier, value: order.value, policy: set.policy, competition: set.competition } };
  }
  if (method === "POST" && path === "/prepare") {
    const entry = orders.get(body.orderId);
    if (!entry) return { status: 404, body: { error: "unknown order" } };
    const adapter = engine.cfg.adapters.find((a) => a.id === entry.order.quote.provider)!;
    const approvedMin = body.approvedMin !== undefined && /^\d+$/.test(String(body.approvedMin)) ? BigInt(body.approvedMin) : undefined;
    // the price guard (whale spec §14): from the enhanced tier a fresh competition stands against the hard quote
    const tier = entry.order.tier;
    const guard = tier && atLeast(tier, "enhanced")
      ? { alternatives: (await engine.quoteAll(entry.order.request, entry.order.policy, { tier }).catch(() => ({ quotes: [] as any[] }))).quotes, maxGapBps: maxGapBpsFor(tier) }
      : undefined;
    try {
      const prepared = await engine.prepareExecution(entry.order, adapter, guard, approvedMin);
      entry.prepared = prepared;
      return { status: 200, body: { digest: prepared.digest, provider: prepared.provider, value: prepared.value, calldata: prepared.calldata, deadline: prepared.deadline, ingress: prepared.ingress, quote: prepared.quote, plan: prepared.quote.plan } };
    } catch (e) {
      if (e instanceof MinimumMovedError) return { status: 409, body: { error: e.message, code: "minimum_moved", approvedMin: e.approvedMin, newMin: e.newMin } };
      // the price guard's refusal (whale spec §14) is an expected answer, not a server fault: the wallet shows the gap and signs nothing
      if (e instanceof PriceGuardError) {
        engine.tracker.recordQuoteDivergence(e.provider as ProviderId, e.gapBps); // V3 §10: repeated divergence opens the breaker
        return { status: 409, body: { error: e.message, code: "price_guard", provider: e.provider, best: e.best, gapBps: e.gapBps, maxGapBps: e.maxGapBps } };
      }
      throw e;
    }
  }
  if (method === "POST" && path === "/finalize") {
    const entry = orders.get(body.orderId);
    if (!entry?.prepared) return { status: 404, body: { error: "order not prepared" } };
    const execution = engine.attachSignature(entry.order, entry.prepared, body.signature);
    return { status: 200, body: { execution, order: entry.order } };
  }
  // ---- destination-side tracking of an executed order (whale spec §19): stateless, from the execution tx hash (NEAR: the deposit address as ref)
  if (method === "GET" && path.startsWith("/track/")) {
    const provider = path.slice("/track/".length) as ProviderId;
    const adapter = engine.cfg.adapters.find((a) => a.id === provider);
    if (!adapter) return { status: 404, body: { error: "unknown provider" } };
    const tx = query.get("tx") ?? undefined, ref = query.get("ref") ?? undefined;
    if (!tx && !ref) return { status: 400, body: { error: "tx (the execution transaction) or ref (the provider's reference) is required" } };
    const t = await adapter.track({ sourceTxHash: tx, providerRef: ref });
    // V3 §10: `since` (unix s, the hand-over) and `expected` (the plan's seconds) let the service count a settlement stall — an unfinished execution older than STALL_FACTOR × its plan
    const since = Number(query.get("since")), expected = Number(query.get("expected"));
    const open = !["completed", "refunded", "failed"].includes(t.state);
    const stalled = open && Number.isFinite(since) && since > 0 && Number.isFinite(expected) && expected > 0 && Date.now() / 1000 - since > STALL_FACTOR * expected;
    if (stalled) engine.tracker.recordSettlementStall(provider, `${provider}:${tx ?? ref}`);
    return { status: 200, body: { track: t, status: guestStatus(t.state), ...(stalled ? { stalled: true } : {}) } };
  }
  // ---- walletless / guest mode (plan §49): no pool, no escrow, no keys — a quote and a one-time deposit instruction
  if (method === "POST" && path === "/guest/quote") {
    const set = await engine.quoteAll(request(body), body.policy === undefined ? "best-price" : policyOf(body), { tier: tierHint(body), mode: modeOf(body) });
    return { status: 200, body: set };
  }
  if (method === "POST" && path === "/guest/ingress") {
    // only providers whose deposit address + memo we verify locally against an independent gateway quorum (THORChain);
    // deposit-address providers that create an order at the provider (1Click, LI.FI smart deposit) are quoted, not instructed
    const req = { ...request(body), plan: "single" as const }; // a UTXO deposit carries one memo of at most 80 bytes: never streamed
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
  const cors: Record<string, string> = origin && ALLOWED_ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" } : {};
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url ?? "/", "http://service");
    const out = await route(req.method ?? "GET", url.pathname, url.searchParams, body, req.headers as Record<string, string | string[] | undefined>);
    res.writeHead(out.status, { ...cors, "content-type": "application/json" });
    res.end(json(out.body));
  } catch (e) {
    // V6 (spec v2.0 §3): an order its escrow could not pay the execution's gas from, or a tip that cannot be priced, is the
    // caller's answer (400); a fee history the service cannot read is its own outage (503)
    if (e instanceof TipError) {
      res.writeHead(e.code === "fee_history_unavailable" ? 503 : 400, { ...cors, "content-type": "application/json" });
      res.end(json({ error: e.message, code: e.code }));
      return;
    }
    const bad = e instanceof BadRequest;
    res.writeHead(bad ? 400 : 500, { ...cors, "content-type": "application/json" });
    res.end(json({ error: String((e as Error).message ?? e) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`private-swap service on http://127.0.0.1:${PORT} (session id ${randomBytes(4).toString("hex")}); origins: ${ALLOWED_ORIGINS.join(", ")}`));
