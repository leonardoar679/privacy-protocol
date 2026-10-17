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
  const own = bucketOf(socket.remoteAddress ?? "unknown");
  if (!forwarded || forwarded.hops < 1) return own;
  const entries = [forwarded.header ?? []]
    .flat()
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.length >= forwarded.hops ? bucketOf(entries[entries.length - forwarded.hops]) : own;
}

/**
 * The bucket an address belongs to (2026-10-17, the audit's unverified m19): an IPv4 address itself, an IPv4-mapped IPv6
 * one too, and an IPv6 address its /64 — one subscriber's allocation, so the whole of it no longer gets a fresh burst per
 * address. Anything that is no address is its own bucket.
 */
export function bucketOf(ip: string): string {
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4) return v4[1];
  if (!ip.includes(":")) return ip;
  const bare = ip.split("%")[0];
  const halves = bare.split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** TRUST_PROXY_HOPS: how many proxies in front of the service append to X-Forwarded-For (unset: none; at most 10). */
export function proxyHopsFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(`TRUST_PROXY_HOPS must be an integer from 0 to 10, not ${JSON.stringify(raw)}`);
  return n;
}
