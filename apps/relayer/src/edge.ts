// The relayer's HTTP edge (doc §68; spec v2.0 §15, §17; V6 Stage 15): every answer carries the server kit's security
// headers — no-store, nosniff, no referrer, a content security policy that loads nothing, HSTS when the relayer
// terminates TLS itself —, the CORS headers for an allowed origin only (ALLOWED_ORIGINS, as the API), and the rate
// limiter by the socket's address (no proxy is trusted; the address is never logged). A preflight, a rate limit and a
// POST that is not JSON end here.
import type { IncomingMessage, ServerResponse } from "node:http";
import { callerKey, corsHeaders, securityHeaders } from "@privacy-wallet/server-kit/http";
import type { RateLimiter } from "@privacy-wallet/server-kit/rateLimit";

export interface EdgeOptions {
  origins: ReadonlySet<string>;
  limiter: RateLimiter;
  /** the relayer terminates TLS itself (TLS=1, as the API): HSTS too */
  tls: boolean;
}

type Req = Pick<IncomingMessage, "method" | "headers"> & { socket: { remoteAddress?: string } };
type Res = Pick<ServerResponse, "setHeader" | "end"> & { statusCode: number };

/** Applies the edge to one request; true when it already answered. */
export function edge(req: Req, res: Res, o: EdgeOptions): boolean {
  for (const [k, v] of Object.entries({ ...securityHeaders({ tls: o.tls }), ...corsHeaders(req.headers.origin, o.origins) })) res.setHeader(k, v);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  res.setHeader("content-type", "application/json");
  const caller = callerKey(req.socket);
  if (!o.limiter.allow(caller)) {
    res.setHeader("retry-after", String(o.limiter.retryAfterSeconds(caller)));
    res.statusCode = 429;
    res.end(JSON.stringify({ error: "too many requests", code: "rate_limited" }));
    return true;
  }
  if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    res.statusCode = 415;
    res.end(JSON.stringify({ error: "send application/json", code: "unsupported_media_type" }));
    return true;
  }
  return false;
}
