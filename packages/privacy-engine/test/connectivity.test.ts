// Connectivity (spec v2.0 §7.11, §12.5; doc §75; V6 Stage 15): the browser's offline event, or three requests in a row that
// never reached their host, make the wallet offline; any answer (whatever its status) or the browser's online event ends
// it; a caller's own abort is not a failure; the transport's requests feed it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURES_TO_OFFLINE, connectivity, isNetworkFailure, observed, whenOnline } from "../src/transport/connectivity";
import { secureFetch, viemTransport } from "../src/transport/http";

afterEach(() => {
  connectivity.reset();
  vi.unstubAllGlobals();
});

describe("connectivity", () => {
  it("the browser's offline event, then its online event", () => {
    connectivity.browser(false, 10);
    expect(connectivity.get()).toEqual({ online: false, since: 10, cause: "browser" });
    connectivity.reachable(11);
    expect(connectivity.get().online, "an answer from localhost does not overrule the browser").toBe(false);
    connectivity.browser(true, 12);
    expect(connectivity.get()).toEqual({ online: true, since: 12, cause: null });
  });
  it("three requests in a row that never reached their host; one answer ends it", () => {
    for (let i = 1; i < FAILURES_TO_OFFLINE; i++) connectivity.unreachable();
    expect(connectivity.get().online).toBe(true);
    connectivity.unreachable(20);
    expect(connectivity.get()).toEqual({ online: false, since: 20, cause: "unreachable" });
    connectivity.reachable(21);
    expect(connectivity.get().online).toBe(true);
  });
  it("a network error and a timeout count; a caller's abort and an HTTP error answer do not", async () => {
    expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(true);
    expect(isNetworkFailure(Object.assign(new Error("a"), { name: "AbortError" }))).toBe(false);
    for (let i = 0; i < FAILURES_TO_OFFLINE; i++)
      await expect(observed(Promise.reject(Object.assign(new Error("a"), { name: "AbortError" })))).rejects.toThrow();
    expect(connectivity.get().online).toBe(true);
  });
  it("an RPC endpoint that never answers counts: viem's timeout aborts its fetch without a reason (the audit's unverified m67)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))),
          ),
      ),
    );
    const rpc = viemTransport("http://127.0.0.1:8545")({ retryCount: 0, timeout: 20 });
    for (let i = 0; i < FAILURES_TO_OFFLINE; i++) await expect(rpc.request({ method: "eth_blockNumber" })).rejects.toThrow();
    expect(connectivity.get()).toMatchObject({ online: false, cause: "unreachable" });
  });
  it("whenOnline resolves at once online, and when the connection comes back", async () => {
    await whenOnline();
    connectivity.browser(false);
    let back = false;
    const p = whenOnline().then(() => (back = true));
    await Promise.resolve();
    expect(back).toBe(false);
    connectivity.browser(true);
    await p;
    expect(back).toBe(true);
  });
  it("the transport's requests feed it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    for (let i = 0; i < FAILURES_TO_OFFLINE; i++) await expect(secureFetch("http://127.0.0.1:8787/v1/status", {}, "swap-service")).rejects.toThrow();
    expect(connectivity.get()).toMatchObject({ online: false, cause: "unreachable" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    await secureFetch("http://127.0.0.1:8787/v1/status", {}, "swap-service");
    expect(connectivity.get().online, "an HTTP error is still an answer").toBe(true);
  });
});
