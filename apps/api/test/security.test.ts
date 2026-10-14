// The HTTP edge (spec v2.0 §15; doc §68): the security headers on every answer (a 404 and an error included), HSTS only when
// the API terminates TLS, CORS only for an allowed origin, no x-powered-by, 413 above 64 KB, 415 for another content type,
// 429 with Retry-After after the burst — keyed by the socket, so a forged X-Forwarded-For buys nothing.
import { afterEach, describe, expect, it } from "vitest";
import { harness, swapRequest, type Harness } from "./helpers";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const SECURITY = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

describe("the HTTP edge", () => {
  it("every answer carries the security headers and no x-powered-by; HSTS only under TLS", async () => {
    h = await harness();
    for (const r of [await h.get("/v1/status"), await h.get("/nowhere"), await h.post("/v1/quotes", { nope: true })]) {
      for (const [k, v] of Object.entries(SECURITY)) expect(r.headers.get(k), k).toBe(v);
      expect(r.headers.get("x-powered-by")).toBeNull();
      expect(r.headers.get("strict-transport-security")).toBeNull();
    }
    await h.close();
    h = await harness({ tls: true });
    expect((await h.get("/v1/status")).headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains");
  });
  it("CORS for an allowed origin only; a preflight is answered with 204", async () => {
    h = await harness({ origins: ["https://wallet.example"] });
    expect((await h.get("/v1/assets", { origin: "https://wallet.example" })).headers.get("access-control-allow-origin")).toBe("https://wallet.example");
    expect((await h.get("/v1/assets", { origin: "https://evil.example" })).headers.get("access-control-allow-origin")).toBeNull();
    const pre = await fetch(h.url + "/v1/quotes", {
      method: "OPTIONS",
      headers: { origin: "https://wallet.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
  });
  it("413 above 64 KB, 415 for another content type, 400 for a body that is not JSON", async () => {
    h = await harness();
    const big = await h.post("/v1/quotes", { ...swapRequest(), padding: "x".repeat(70_000) });
    expect(big.status).toBe(413);
    expect(big.body.code).toBe("too_large");
    const text = await h.post("/v1/quotes", "amount=1", { "content-type": "text/plain" });
    expect(text.status).toBe(415);
    expect(text.body.code).toBe("unsupported_media_type");
    const broken = await h.post("/v1/quotes", "{not json");
    expect(broken.status).toBe(400);
    expect(broken.body.code).toBe("invalid_request");
  });
  it("429 with Retry-After after the burst; a forged X-Forwarded-For shares the socket's bucket", async () => {
    h = await harness({ ratePerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await h.get("/v1/assets", { "x-forwarded-for": `10.0.0.${i}` })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const limited = await h.get("/v1/assets");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.body.code).toBe("rate_limited");
  });
});
