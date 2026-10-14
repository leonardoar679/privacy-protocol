// The HTTP edge the API and the relayer share (doc §68; spec v2.0 §15): the security headers on every answer, HSTS when
// the service itself terminates TLS, the CORS allowlist, the 64 KB body limit, and the caller's key for the rate limiter —
// the socket's address only (no proxy is trusted, so X-Forwarded-For is never read), kept in memory and never logged.

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

/** The rate limiter's key: the socket's own address. */
export const callerKey = (socket: { remoteAddress?: string | undefined }): string => socket.remoteAddress ?? "unknown";
