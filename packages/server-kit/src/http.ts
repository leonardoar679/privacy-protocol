// The HTTP edge the API and the relayer share (doc §68; spec v2.0 §15): the security headers on every answer, HSTS when
// the service itself terminates TLS, the CORS allowlist, the 64 KB body limit, and the caller's key for the rate limiter —
// the socket's address, or behind the proxies the operator names (TRUST_PROXY_HOPS) the address the outermost of them
// saw; kept in memory and never logged.

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

/** HSTS: only from a service that terminates TLS itself (behind a TLS proxy the proxy sends it). */
export const HSTS_HEADER = { "strict-transport-security": "max-age=63072000; includeSubDomains" } as const;

export const securityHeaders = (o: { tls: boolean }): Record<string, string> => ({ ...SECURITY_HEADERS, ...(o.tls ? HSTS_HEADER : {}) });

/** The CORS headers for an allowed origin; none for any other (the browser then refuses the answer). */
export function corsHeaders(origin: string | undefined, allowed: ReadonlySet<string>): Record<string, string> {
  if (!origin || !allowed.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "origin",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-max-age": "600",
  };
}

/** ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173" → the set. */
export const originsFrom = (raw: string | undefined, fallback: string[]): ReadonlySet<string> =>
  new Set(
    (raw ?? fallback.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** The body limit of every JSON request. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The rate limiter's key. By default the socket's own address, and no header is read. Behind a TLS proxy, as
 * docs/deployment.md has it, that address is the proxy's, and every caller shared one bucket: anyone could use it up for
 * everyone (a V6 follow-up of 2026-10-15). With `hops` proxies the operator trusts (TRUST_PROXY_HOPS), the key is the
 * X-Forwarded-For entry `hops` from the right: each proxy appends the address it received the request from, so the
 * entries a caller writes itself stay on the left and buy nothing. A request with fewer entries did not come through
 * those proxies and keeps the socket's address.
 */
export function callerKey(socket: { remoteAddress?: string | undefined }, forwarded?: { header: string | string[] | undefined; hops: number }): string {
  const own = socket.remoteAddress ?? "unknown";
  if (!forwarded || forwarded.hops < 1) return own;
  const entries = [forwarded.header ?? []]
    .flat()
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.length >= forwarded.hops ? entries[entries.length - forwarded.hops] : own;
}

/** TRUST_PROXY_HOPS: how many proxies in front of the service append to X-Forwarded-For (unset: none; at most 10). */
export function proxyHopsFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(`TRUST_PROXY_HOPS must be an integer from 0 to 10, not ${JSON.stringify(raw)}`);
  return n;
}
