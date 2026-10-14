// The relayer's HTTP edge (doc §68; spec v2.0 §15, §17; V6 Stage 15): every answer carries the security headers (HSTS
// only when the relayer terminates TLS); CORS for an allowed origin only; a preflight answers 204; the rate limit by the
// socket's address answers 429 with retry-after; a POST that is not JSON answers 415; X-Forwarded-For is never read.
import { describe, expect, it } from "vitest";
import { RateLimiter } from "@privacy-wallet/server-kit/rateLimit";
import { edge } from "../src/edge";

const origins = new Set(["http://localhost:5173"]);
function call(req: { method: string; headers?: Record<string, string>; ip?: string }, o: { tls?: boolean; limiter?: RateLimiter } = {}) {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: "",
    setHeader: (k: string, v: string | number) => void (headers[k.toLowerCase()] = String(v)),
    end: (b?: string) => void (res.body = b ?? ""),
  };
  const handled = edge({ method: req.method, headers: req.headers ?? {}, socket: { remoteAddress: req.ip ?? "127.0.0.1" } } as never, res as never, {
    origins,
    limiter: o.limiter ?? new RateLimiter({ perMinute: 60, burst: 20 }),
    tls: o.tls ?? false,
  });
  return { handled, headers, status: res.statusCode, body: res.body };
}

describe("the relayer's edge (doc §68)", () => {
  it("every answer: no-store, nosniff, no referrer, a policy that loads nothing; HSTS only with its own TLS", () => {
    const r = call({ method: "GET" });
    expect(r.handled).toBe(false);
    expect(r.headers).toMatchObject({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "content-type": "application/json",
    });
    expect(r.headers["strict-transport-security"]).toBeUndefined();
    expect(call({ method: "GET" }, { tls: true }).headers["strict-transport-security"]).toMatch(/max-age=63072000/);
  });
  it("CORS for an allowed origin only; a preflight ends at the edge", () => {
    expect(call({ method: "GET", headers: { origin: "http://localhost:5173" } }).headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(call({ method: "GET", headers: { origin: "https://evil.example" } }).headers["access-control-allow-origin"]).toBeUndefined();
    const pre = call({ method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
    expect([pre.handled, pre.status]).toEqual([true, 204]);
  });
  it("the rate limit by the socket's address (X-Forwarded-For ignored); a POST that is not JSON", () => {
    const limiter = new RateLimiter({ perMinute: 1, burst: 1 });
    expect(call({ method: "GET", ip: "10.0.0.1" }, { limiter }).handled).toBe(false);
    const limited = call({ method: "GET", ip: "10.0.0.1", headers: { "x-forwarded-for": "10.9.9.9" } }, { limiter });
    expect([limited.handled, limited.status, JSON.parse(limited.body).code]).toEqual([true, 429, "rate_limited"]);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(call({ method: "GET", ip: "10.0.0.2" }, { limiter }).handled, "another socket has its own bucket").toBe(false);
    const form = call({ method: "POST", headers: { "content-type": "text/plain" } });
    expect([form.handled, form.status]).toEqual([true, 415]);
    expect(call({ method: "POST", headers: { "content-type": "application/json; charset=utf-8" } }).handled).toBe(false);
  });
});
