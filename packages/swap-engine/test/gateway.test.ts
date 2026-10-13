// The zkAPI quote gateway (whale spec §22): the interface is real and honest about its status — a fresh
// request id per call, runtime-key authorization only, 503 "not available upstream" until a zkAPI
// deployment registers an upstream, 200 with the engine's answer once one does; the key is never echoed.
import { describe, it, expect } from "vitest";
import { gatewayConfigFromEnv, gatewayHealth, gatewayQuote, newRequestId, NOT_AVAILABLE, parseRuntimeKey } from "../src/gateway";

describe("gateway", () => {
  it("health states the capability, the auth mode and the upstream status", () => {
    expect(gatewayHealth({ upstream: null })).toEqual({ capability: "zkapi", auth: "runtime-key", available: false, upstream: null, reason: NOT_AVAILABLE });
    expect(gatewayHealth({ upstream: "zkapi-sepolia:private-swap", requestChargeCap: 0.01 })).toMatchObject({ available: true, upstream: "zkapi-sepolia:private-swap", requestChargeCap: 0.01 });
    expect(gatewayConfigFromEnv({})).toEqual({ upstream: null });
    expect(gatewayConfigFromEnv({ ZKAPI_UPSTREAM: " zkapi-sepolia:private-swap ", ZKAPI_REQUEST_CHARGE_CAP: "0.02" })).toEqual({ upstream: "zkapi-sepolia:private-swap", requestChargeCap: 0.02 });
  });

  it("request ids are 16 random bytes and never repeat; the runtime key is parsed strictly", () => {
    const ids = new Set(Array.from({ length: 50 }, newRequestId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(parseRuntimeKey(undefined)).toEqual({ error: expect.stringMatching(/missing Authorization/) });
    expect(parseRuntimeKey("Bearer abcdefghijklmnop")).toEqual({ error: expect.stringMatching(/scheme must be zkapi/) });
    expect(parseRuntimeKey("zkapi short")).toEqual({ error: expect.stringMatching(/too short/) });
    expect(parseRuntimeKey("zkapi rk_0123456789abcdef")).toEqual({ key: "rk_0123456789abcdef" });
    expect(parseRuntimeKey("ZKAPI   rk_0123456789abcdef ")).toEqual({ key: "rk_0123456789abcdef" });
  });

  it("quotes: 401 without a key, 503 with the reason while no upstream exists, 200 with the answer and a request id once one does; errors never echo the key", async () => {
    const calls: unknown[] = [];
    const quote = async (body: unknown, requestId: string) => { calls.push({ body, requestId }); return { quotes: [] }; };
    const noKey = await gatewayQuote({ upstream: null }, {}, { from: "ETH" }, quote);
    expect(noKey.status).toBe(401);
    expect((noKey.body as { requestId: string }).requestId).toMatch(/^[0-9a-f]{32}$/);
    const blocked = await gatewayQuote({ upstream: null }, { authorization: "zkapi rk_0123456789abcdef" }, { from: "ETH" }, quote);
    expect(blocked.status).toBe(503);
    expect(blocked.body).toMatchObject({ error: NOT_AVAILABLE, capability: "zkapi" });
    expect(calls).toEqual([]);
    const ok = await gatewayQuote({ upstream: "zkapi-sepolia:private-swap" }, { Authorization: ["zkapi rk_0123456789abcdef"] }, { from: "ETH" }, quote);
    expect(ok.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { requestId: string }).requestId).toBe((ok.body as { requestId: string }).requestId);
    const failing = await gatewayQuote({ upstream: "x" }, { authorization: "zkapi rk_0123456789abcdef" }, {}, async () => { throw new Error("upstream said: rk_0123456789abcdef rejected"); });
    expect(failing.status).toBe(502);
    expect(JSON.stringify(failing.body)).not.toContain("rk_0123456789abcdef");
    expect((failing.body as { error: string }).error).toContain("[key] rejected");
  });
});
