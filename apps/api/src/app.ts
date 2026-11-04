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
import { MAX_BODY_BYTES, RateLimiter, callerKey, corsHeaders, redactUrls, securityHeaders, type LogFields, type Logger } from "@privacy-wallet/server-kit";
import { TipError } from "@privacy-wallet/swap-engine/tips";
import { AssetMismatchError, ProtectedDestinationError, ProviderFailure } from "@privacy-wallet/swap-engine/engine";
import { TooManyTranches } from "@privacy-wallet/protocol/wallet/campaign";
import { BadRequest, SwapApi, type Answer, type SwapApiDeps } from "./routes/swap";

export interface AppOptions {
  origins: ReadonlySet<string>;
  /** the API terminates TLS itself (HSTS) */
  tls: boolean;
  /** requests per minute per caller (burst 20) */
  ratePerMinute: number;
  /** TRUST_PROXY_HOPS: the proxies in front of the API whose X-Forwarded-For entries name the caller (default 0: none) */
  trustProxyHops?: number;
  /** COMMITS_PER_MINUTE: the operations a caller may create (commits and restores) per minute, burst COMMIT_BURST (default 4) */
  commitsPerMinute?: number;
  /** the commits a caller may make at once (default COMMIT_BURST) */
  commitBurst?: number;
  log: Logger;
}

/** At most one rate.limited event this often, however many requests the limiter refuses. */
export const RATE_EVENT_EVERY_MS = 60_000;
/**
 * The operations a caller may create (the eighth review round, 2026-11-03, A-M2): every POST /v1/operations stores an order, and the
 * request limit alone had let one caller keep ~13 GiB of free commits for days. A wallet commits a few an hour; a campaign one a step.
 */
export const COMMITS_PER_MINUTE = 4;
export const COMMIT_BURST = 30;

export function createApp(deps: SwapApiDeps, o: AppOptions): express.Express {
  const api = new SwapApi(deps);
  const limiter = new RateLimiter({ perMinute: o.ratePerMinute, burst: Math.min(20, o.ratePerMinute) });
  // a flood is one event a minute, not a row per refused request (the audit round of 2026-10-16, c19): every one had been
  // kept in system_events for 7 days, so one client's flood grew the disk
  let lastLimitedEvent = -Infinity;
  const commits = new RateLimiter({ perMinute: o.commitsPerMinute ?? COMMITS_PER_MINUTE, burst: o.commitBurst ?? COMMIT_BURST });
  const callerOf = (req: Request) => callerKey(req.socket, { header: req.headers["x-forwarded-for"], hops: o.trustProxyHops ?? 0 });
  // an error a caller can provoke is one row a minute per kind (the eighth review round, A-M2, as c19 did for rate.limited): each 500 and
  // 502 had kept a row for 7 days; the log line is written every time
  const lastRow = new Map<string, number>();
  const eventEveryMinute = (f: LogFields) => {
    const key = `${f.event}|${f.provider ?? ""}`;
    const now = Date.now();
    if (now - (lastRow.get(key) ?? -Infinity) < RATE_EVENT_EVERY_MS) return void o.log.log(f);
    lastRow.set(key, now);
    deps.store.event(f);
  };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.set("etag", false);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.set({ ...securityHeaders({ tls: o.tls }), ...corsHeaders(req.headers.origin, o.origins) });
    if (req.method === "OPTIONS") return void res.status(204).end();
    const caller = callerKey(req.socket, { header: req.headers["x-forwarded-for"], hops: o.trustProxyHops ?? 0 });
    if (!limiter.allow(caller)) {
      const now = Date.now();
      if (now - lastLimitedEvent >= RATE_EVENT_EVERY_MS) {
        lastLimitedEvent = now;
        deps.store.event({ event: "rate.limited", errorClass: "rate_limited" });
      }
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
  app.post("/v1/operations", async (req, res) => {
    const caller = callerOf(req);
    if (!commits.allow(caller))
      return void res
        .status(429)
        .set("retry-after", String(commits.retryAfterSeconds(caller)))
        .json({ error: "too many orders from this caller; try again shortly", code: "rate_limited" });
    send(res, await api.createOperation(req.body));
  });
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
    // the tip a Review showed and today's price parted (the eighth review round, H1): a conflict the wallet answers with a new quote
    if (e instanceof TipError)
      return void res
        .status(e.code === "fee_history_unavailable" ? 503 : e.code === "tip_moved" ? 409 : 400)
        .json({ error: redactUrls(e.message), code: e.code });
    if (e instanceof ProtectedDestinationError || e instanceof AssetMismatchError) return void res.status(400).json({ error: e.message, code: e.code });
    // a plan of more steps than any campaign runs (the eighth review round, A-M3): the caller's order or the route's figures, never a 500
    if (e instanceof TooManyTranches) return void res.status(400).json({ error: e.message, code: e.code });
    // a provider that failed, or answered what the engine will not build on (whale spec §16): a gateway's error, logged
    // with the provider. Before, a provider's outage and its unknown transactions were logged as the API's own errors.
    if (e instanceof ProviderFailure) {
      eventEveryMinute({ event: "provider.failed", level: "warn", provider: e.provider, state: "502", errorClass: "provider" });
      return void res.status(502).json({ error: redactUrls(e.message), code: "provider_unavailable" });
    }
    // the API's own error says nothing of itself (a V6 follow-up of 2026-10-15): its message could carry an RPC's URL and
    // its key, as a viem error does; a provider's or the gas price's words above keep only their URLs' hosts
    eventEveryMinute({ event: "http.error", level: "error", state: "500", errorClass: "internal" });
    res.status(500).json({ error: "internal error", code: "internal" });
  });
  return app;
}
