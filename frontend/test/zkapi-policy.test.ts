// Private AI policy (plan §5, spec §3/§5): the transport never proxies, never sends credentials,
// never follows redirects; zkAPI is enabled only by a clean, recent pin check; the provider stream
// is parsed correctly and errors surface. No SDK import (src/zkapi/policy.ts is pure).
import { describe, it, expect, vi } from "vitest";
import { chatStream, newSessionId, parseSseDeltas, privateTransport, zkapiEnabled, type InferenceAccess, type PinCheck } from "../src/zkapi/policy";

describe("transport policy", () => {
  it("refuses the proxy hint (runtime-key mode only)", async () => {
    await expect(privateTransport("https://zkapi-sepolia.openanonymity.ai/v2/x", {}, { preferProxy: true })).rejects.toThrow(/proxy mode is disabled/);
  });
  it("sends without credentials and without following redirects, keeping the SDK's init", async () => {
    const spy = vi.fn(async () => new Response("ok"));
    const orig = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await privateTransport("https://example.invalid/v2/openrouter/leases", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, {});
    } finally {
      globalThis.fetch = orig;
    }
    expect(spy).toHaveBeenCalledTimes(1);
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });
});

describe("pin gate", () => {
  const base: PinCheck = { network: "sepolia", checkedAt: new Date().toISOString(), pass: 12, fail: 0, deploymentId: "d", vault: "0x", circuit: "zkapi-v2-note-bound-v1", protocolServer: "https://s", items: [], lab: { pass: 23, fail: 0 } };
  it("enables only with zero failures (local and lab) and a recent, sane timestamp", () => {
    expect(zkapiEnabled(base)).toBe(true);
    expect(zkapiEnabled({ ...base, fail: 1 })).toBe(false);
    expect(zkapiEnabled({ ...base, lab: { pass: 22, fail: 1 } })).toBe(false);
    expect(zkapiEnabled({ ...base, checkedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() })).toBe(false);
    expect(zkapiEnabled({ ...base, checkedAt: new Date(Date.now() + 3_600_000).toISOString() })).toBe(false);
    expect(zkapiEnabled({ ...base, checkedAt: "garbage" })).toBe(false);
    expect(zkapiEnabled(null)).toBe(false);
  });
});

describe("provider stream", () => {
  const enc = new TextEncoder();
  const stream = (parts: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
  it("yields content deltas across chunk boundaries, ignores keep-alives, stops at [DONE]", async () => {
    const parts = ['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"con', 'tent":"lo"}}]}\n\n: keep-alive\n\ndata: {"choices":[{"delta":{}}]}\n\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"never"}}]}\n'];
    const out: string[] = [];
    for await (const d of parseSseDeltas(stream(parts))) out.push(d);
    expect(out.join("")).toBe("Hello");
  });
  it("chatStream posts to the lease's base URL with its headers, no credentials; non-2xx is an error", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const okFetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(stream(['data: {"choices":[{"delta":{"content":"x"}}]}\n']), { status: 200 }); }) as unknown as typeof fetch;
    const access: InferenceAccess = { mode: "ephemeral-key", apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", spendingLimitUsd: 1, headers: { authorization: "Bearer k", "content-type": "application/json" }, release: () => {} };
    const out: string[] = [];
    for await (const d of chatStream(access, "m", [{ role: "user", content: "hi" }], undefined, okFetch)) out.push(d);
    expect(out).toEqual(["x"]);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[0].init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
    const badFetch = (async () => new Response("insufficient credit", { status: 402 })) as unknown as typeof fetch;
    await expect((async () => { for await (const _ of chatStream(access, "m", [], undefined, badFetch)) { /* drain */ } })()).rejects.toThrow(/HTTP 402/);
  });
  it("session ids are unique", () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });
});
