// The HTTP edge (doc §68; spec v2.0 §15): the four security headers on every answer and HSTS only under TLS, CORS only
// for an allowed origin, the allowlist from the environment, the limiter's key from the socket alone.
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, callerKey, corsHeaders, originsFrom, securityHeaders } from "../src/http";

describe("the HTTP edge", () => {
  it("the security headers; HSTS only when the service terminates TLS", () => {
    expect(securityHeaders({ tls: false })).toEqual({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    expect(securityHeaders({ tls: true })["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
  });
  it("CORS for an allowed origin only; the allowlist from the environment or its default", () => {
    const allowed = originsFrom("http://localhost:5173, https://wallet.example", []);
    expect(corsHeaders("https://wallet.example", allowed)["access-control-allow-origin"]).toBe("https://wallet.example");
    expect(corsHeaders("https://evil.example", allowed)).toEqual({});
    expect(corsHeaders(undefined, allowed)).toEqual({});
    expect([...originsFrom(undefined, ["http://127.0.0.1:5173"])]).toEqual(["http://127.0.0.1:5173"]);
  });
  it("the body limit is 64 KB; the limiter's key is the socket's address, never a forwarded header", () => {
    expect(MAX_BODY_BYTES).toBe(65_536);
    expect(callerKey({ remoteAddress: "10.0.0.7" })).toBe("10.0.0.7");
    expect(callerKey({})).toBe("unknown");
  });
});
