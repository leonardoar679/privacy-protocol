// The wallet's API calls end (a V6 follow-up of 2026-10-14). A request the API never answers fails with ApiTimeout
// after the timeout instead of spinning; in the local stack's quick pass a commit had stalled over two minutes. A body
// cut off by the timeout is never read as an empty success. The caller's own cancel stays a cancel, and a timeout counts
// toward offline like any other.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { API_TIMEOUT_MS, ApiError, ApiMinimumMoved, ApiTimeout, apiCall } from "../src/api/client";
import { configure, defaultConfig } from "../src/config";

const realFetch = globalThis.fetch;
beforeEach(() => configure(defaultConfig()));
afterEach(() => {
  globalThis.fetch = realFetch;
  connectivity.reset();
  vi.useRealTimers();
});

/** A request that never gets an answer: it ends only when aborted, with the signal's reason, as the browser's does. */
const neverAnswers: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const answers =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the wallet's API calls end", () => {
  it("a request the API never answers fails with ApiTimeout, and three count toward offline", async () => {
    expect(API_TIMEOUT_MS).toBe(90_000);
    globalThis.fetch = neverAnswers;
    const p = apiCall("/v1/operations", { amount: "1" }, "swap-service", undefined, 30);
    await expect(p).rejects.toBeInstanceOf(ApiTimeout);
    await expect(p).rejects.toMatchObject({ status: 0, code: "service_timeout", message: "The swap service did not answer within 0 s." });
    expect(connectivity.get().online).toBe(true); // one is not offline
    for (let i = 0; i < 2; i++) await apiCall("/v1/status", undefined, "swap-service", undefined, 30).catch(() => undefined);
    expect(connectivity.get()).toMatchObject({ online: false, cause: "unreachable" });
  });

  it("a body cut off by the timeout is an ApiTimeout, never an empty answer read as a success", async () => {
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"operationId":'));
          signal?.addEventListener("abort", () => c.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    await expect(apiCall("/v1/operations", {}, "swap-service", undefined, 30)).rejects.toBeInstanceOf(ApiTimeout);
  });

  it("the caller's own cancel stays a cancel: no ApiTimeout, and not a step toward offline", async () => {
    globalThis.fetch = neverAnswers;
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      const p = apiCall("/v1/quotes", {}, "swap-service", ac.signal, 10_000);
      ac.abort();
      const e = await p.catch((x: unknown) => x);
      expect(e).not.toBeInstanceOf(ApiTimeout);
      expect((e as Error).name).toBe("AbortError");
    }
    const done = new AbortController();
    done.abort();
    await expect(apiCall("/v1/quotes", {}, "swap-service", done.signal, 10_000)).rejects.toMatchObject({ name: "AbortError" });
    expect(connectivity.get().online).toBe(true);
  });

  it("an answer in time is read as before, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    globalThis.fetch = answers(200, { operationId: "op_x" });
    await expect(apiCall("/v1/operations", {})).resolves.toEqual({ operationId: "op_x" });
    globalThis.fetch = answers(409, { code: "minimum_moved", approvedMin: "10", newMin: "9" });
    await expect(apiCall("/v1/operations/op_x/prepare", {})).rejects.toBeInstanceOf(ApiMinimumMoved);
    globalThis.fetch = answers(400, { error: "no quote from thorchain", code: "no_quote" });
    const e = await apiCall("/v1/operations", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).not.toBeInstanceOf(ApiTimeout);
    expect(e).toMatchObject({ status: 400, code: "no_quote", message: "no quote from thorchain" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
