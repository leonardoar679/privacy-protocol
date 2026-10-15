// The API's HTTP edge (spec v2.0 §15; doc §68): Express 5 (async handlers, path-to-regexp 8) over the swap routes and the
// registries. Every answer carries the security headers (HSTS when the API terminates TLS itself) and CORS only for an
// allowed origin; no `x-powered-by`; no proxy is trusted (X-Forwarded-For is never read); a token bucket per socket
// address (429 with Retry-After); JSON only (415 otherwise), 64 KB bodies (413); errors as { error, code }. The routes:
//   GET  /v1/assets  /v1/networks  /v1/providers/health  /v1/status
//   POST /v1/quotes
//   POST /v1/operations            GET /v1/operations/:id
//   POST /v1/operations/:id/{reconcile, prepare, finalize, resume}
//   GET  /v1/track/:provider  /v1/risk  /v1/risk/:provider
//   POST /v1/guest/quote  /v1/guest/ingress     GET /v1/guest/track/:provider/:txid
//   GET  /v1/gateway/health        POST /v1/gateway/quote
// There is no listing of operations, and an order id never appears in a URL.
import express, { type NextFunction, type Request, type Response } from "express";
import { CHAINS } from "@privacy-wallet/config";
import { MAX_BODY_BYTES, RateLimiter, callerKey, corsHeaders, redactUrls, securityHeaders, type Logger } from "@privacy-wallet/server-kit";
import { TipError } from "@privacy-wallet/swap-engine/tips";
import { ProtectedDestinationError, ProviderFailure } from "@privacy-wallet/swap-engine/engine";
import { BadRequest, SwapApi, type Answer, type SwapApiDeps } from "./routes/swap";

export interface AppOptions {
  origins: ReadonlySet<string>;
  /** the API terminates TLS itself (HSTS) */
  tls: boolean;
  /** requests per minute per caller (burst 20) */
  ratePerMinute: number;
  /** TRUST_PROXY_HOPS: the proxies in front of the API whose X-Forwarded-For entries name the caller (default 0: none) */
  trustProxyHops?: number;
  log: Logger;
}

export function createApp(deps: SwapApiDeps, o: AppOptions): express.Express {
  const api = new SwapApi(deps);
  const limiter = new RateLimiter({ perMinute: o.ratePerMinute, burst: Math.min(20, o.ratePerMinute) });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.set("etag", false);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.set({ ...securityHeaders({ tls: o.tls }), ...corsHeaders(req.headers.origin, o.origins) });
    if (req.method === "OPTIONS") return void res.status(204).end();
    const caller = callerKey(req.socket, { header: req.headers["x-forwarded-for"], hops: o.trustProxyHops ?? 0 });
    if (!limiter.allow(caller)) {
      deps.store.event({ event: "rate.limited", errorClass: "rate_limited" });
      return void res
        .status(429)
        .set("retry-after", String(limiter.retryAfterSeconds(caller)))
        .json({ error: "too many requests", code: "rate_limited" });
    }
    if (req.method === "POST" && !req.is("application/json"))
      return void res.status(415).json({ error: "send application/json", code: "unsupported_media_type" });
    next();
  });
  app.use(express.json({ limit: MAX_BODY_BYTES, strict: true }));

  const send = (res: Response, a: Answer) => void res.status(a.status).json(a.body);
  const p = (req: Request, name: string): string => String(req.params[name] ?? "");

  app.get("/v1/assets", (_req, res) => send(res, { status: 200, body: { assets: deps.store.assets() } }));
  app.get("/v1/networks", (_req, res) => {
    const seen = new Map(deps.store.chains().map((c) => [c.chain, c]));
    const networks = Object.values(CHAINS).map((c) => {
      const s = seen.get(c.id);
      return {
        id: c.id,
        name: c.name,
        family: c.family,
        ...(c.chainId !== undefined ? { chainId: c.chainId } : {}),
        confirmations: c.confirmations,
        ...(s ? { block: s.block, observedAt: s.at } : {}),
      };
    });
    send(res, { status: 200, body: { networks } });
  });
  app.get("/v1/providers/health", (_req, res) => send(res, api.providersHealth()));
  app.get("/v1/status", async (_req, res) => send(res, await api.status()));
  app.post("/v1/quotes", async (req, res) => send(res, await api.quotes(req.body)));
  app.post("/v1/operations", async (req, res) => send(res, await api.createOperation(req.body)));
  app.get("/v1/operations/:id", (req, res) => send(res, api.getOperation(p(req, "id"))));
  app.post("/v1/operations/:id/reconcile", async (req, res) => send(res, await api.reconcile(p(req, "id"))));
  app.post("/v1/operations/:id/prepare", async (req, res) => send(res, await api.prepare(p(req, "id"), req.body)));
  app.post("/v1/operations/:id/finalize", (req, res) => send(res, api.finalize(p(req, "id"), req.body)));
  app.post("/v1/operations/:id/resume", async (req, res) => send(res, await api.resume(p(req, "id"), req.body)));
  app.get("/v1/track/:provider", async (req, res) => send(res, await api.track(p(req, "provider"), new URL(req.originalUrl, "http://api").searchParams)));
  app.get("/v1/risk", (_req, res) => send(res, api.risk()));
  app.get("/v1/risk/:provider", (req, res) => send(res, api.risk(p(req, "provider"))));
  app.post("/v1/guest/quote", async (req, res) => send(res, await api.guestQuote(req.body)));
  app.post("/v1/guest/ingress", async (req, res) => send(res, await api.guestIngress(req.body)));
  app.get("/v1/guest/track/:provider/:txid", async (req, res) => send(res, await api.guestTrack(p(req, "provider"), p(req, "txid"))));
  app.get("/v1/gateway/health", (_req, res) => send(res, api.gatewayHealth()));
  app.post("/v1/gateway/quote", async (req, res) => send(res, await api.gatewayQuote(req.headers, req.body)));

  app.use((_req: Request, res: Response) => void res.status(404).json({ error: "no such route", code: "invalid_request" }));
  // the error answer: the caller's mistakes are 4xx with a catalog code; the message is the caller's, never logged
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const err = e as { type?: string; status?: number; message?: string };
    if (err?.type === "entity.too.large") return void res.status(413).json({ error: "request too large", code: "too_large" });
    if (err?.type === "entity.parse.failed" || e instanceof BadRequest)
      return void res.status(400).json({ error: e instanceof BadRequest ? e.message : "the body is not JSON", code: "invalid_request" });
    // V6 (spec v2.0 §3): an escrow that cannot pay the execution's gas, or a tip that cannot be priced, is the caller's answer; a fee history the API cannot read is its own outage
    if (e instanceof TipError) return void res.status(e.code === "fee_history_unavailable" ? 503 : 400).json({ error: redactUrls(e.message), code: e.code });
    if (e instanceof ProtectedDestinationError) return void res.status(400).json({ error: e.message, code: e.code });
    // a provider that failed, or answered what the engine will not build on (whale spec §16): a gateway's error, logged
    // with the provider. Before, a provider's outage and its unknown transactions were logged as the API's own errors.
    if (e instanceof ProviderFailure) {
      deps.store.event({ event: "provider.failed", level: "warn", provider: e.provider, state: "502", errorClass: "provider" });
      return void res.status(502).json({ error: redactUrls(e.message), code: "provider_unavailable" });
    }
    // the API's own error says nothing of itself (a V6 follow-up of 2026-10-15): its message could carry an RPC's URL and
    // its key, as a viem error does; a provider's or the gas price's words above keep only their URLs' hosts
    deps.store.event({ event: "http.error", level: "error", state: "500", errorClass: "internal" });
    res.status(500).json({ error: "internal error", code: "internal" });
  });
  return app;
}
