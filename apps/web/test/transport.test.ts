// The transport policy (spec §7): every request leaves with no credentials, no redirect, no cache and no referrer
// whatever the caller asked; it is announced with its host and purpose; a strict (production) build refuses a host
// outside the allowlist and allows the page's own origin; the fetch-shaped wrapper serves the modules that take one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowHosts, allowedHosts, checkUrl, fetchFor, fetchJson, hostOf, isStrict, onRequest, secureFetch, setStrict, TransportRefusal, viemTransport, type RequestRecord } from "@privacy-wallet/privacy-engine/transport/http";

const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
let records: RequestRecord[] = [];
let off = () => {};

beforeEach(() => { globalThis.fetch = fetchSpy as unknown as typeof fetch; fetchSpy.mockClear(); records = []; off = onRequest((r) => records.push(r)); });
afterEach(() => { off(); setStrict(false); });

describe("the transport policy (spec §7)", () => {
  it("calls the global fetch of the moment with the policy and announces the request", async () => {
    await secureFetch("https://relayer.test/info", { method: "POST", body: "{}" }, "relayer");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://relayer.test/info");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(records).toEqual([expect.objectContaining({ url, host: "relayer.test", method: "POST", purpose: "relayer" })]);
  });
  it("a caller cannot weaken the policy", async () => {
    await secureFetch("/zkapi/pin-check.json", { credentials: "include", redirect: "follow" } as RequestInit, "zkapi");
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(records[0]).toMatchObject({ host: "", purpose: "zkapi" }); // the page's own origin
  });
  it("strict mode refuses a host outside the allowlist, allows the own origin and the allowed hosts", async () => {
    expect(isStrict()).toBe(false);
    allowHosts("https://rpc.example:8545/v1", "beacon.example, https://thornode.example/x");
    expect(allowedHosts()).toEqual(expect.arrayContaining(["rpc.example", "beacon.example", "thornode.example"]));
    setStrict(true);
    expect(() => checkUrl("https://rpc.example/anything")).not.toThrow();
    expect(() => checkUrl("/artifacts/transaction.wasm")).not.toThrow();
    expect(() => checkUrl("https://evil.example/collect")).toThrow(TransportRefusal);
    await expect(secureFetch("https://evil.example/collect")).rejects.toThrow(/not an endpoint of this deployment/);
    expect(fetchSpy, "refused before any network I/O").not.toHaveBeenCalled();
    expect(records).toEqual([]);
    expect(hostOf("https://")).toBeNull(); // an absolute URL that does not parse
    expect(() => checkUrl("https://")).toThrow(TransportRefusal);
    expect(hostOf("zkapi/pin-check.json"), "no scheme: the page's own origin").toBe("");
    // a protocol-relative URL names another host: never the page's own origin (the audit's unverified m66)
    expect(hostOf("//evil.example/collect")).toBe("evil.example");
    expect(hostOf("/\\evil.example/collect"), "a backslash reads as a slash").toBe("evil.example");
    expect(() => checkUrl("//evil.example/collect")).toThrow(TransportRefusal);
    await expect(secureFetch("//evil.example/collect")).rejects.toThrow(/not an endpoint of this deployment/);
    expect(() => checkUrl("//rpc.example/v1"), "an allowed host stays allowed").not.toThrow();
  });
  it("fetchJson parses what parses and keeps the text; fetchFor is fetch-shaped and carries its purpose", async () => {
    const r = await fetchJson<{ ok: number }>("https://relayer.test/info", {}, "relayer");
    expect(r).toMatchObject({ ok: true, status: 200, json: { ok: 1 } });
    expect(r.text).toBe('{"ok":1}');
    const beacon = fetchFor("beacon");
    await beacon(new URL("https://beacon.example/eth/v1/beacon/light_client/bootstrap/0x00"));
    await beacon("https://beacon.example/eth/v1/x", { method: "GET" });
    expect(records.slice(1).map((x) => [x.host, x.purpose, x.method])).toEqual([["beacon.example", "beacon", "GET"], ["beacon.example", "beacon", "GET"]]);
    const posted = await fetchJson("https://relayer.test/submit", { body: { a: 1 } }, "relayer");
    expect(posted.ok).toBe(true);
    const [, init] = fetchSpy.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
  });
  it("the viem transport allowlists its endpoint and exists under the policy", () => {
    const t = viemTransport("https://rpc.deployment.test:8545");
    expect(typeof t).toBe("function");
    expect(allowedHosts()).toContain("rpc.deployment.test");
  });
});
