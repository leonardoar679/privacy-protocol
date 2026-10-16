// The API's reads end (a V6 follow-up of 2026-10-14): one read of the relayer or of an RPC endpoint gets READ_TIMEOUT_MS.
// A relayer that never answers no longer holds every quote (its terms) and every reconcile, and a hung RPC endpoint no
// longer keeps the next one from being asked.
import { describe, expect, it } from "vitest";
import { READ_TIMEOUT_MS, makeReads } from "../src/reads";

/** A server that never answers: the request ends only when aborted, with the signal's reason. */
const neverAnswers = (_input: unknown, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const engine = { cfg: { adapters: [] } } as never;

describe("the API's reads end", () => {
  it("a relayer that never answers: the job and the terms give up after the limit, and the terms' miss is kept 30 s", async () => {
    expect(READ_TIMEOUT_MS).toBe(10_000);
    const asked: string[] = [];
    let clock = 1_000_000;
    const reads = makeReads({
      relayerUrl: "http://relayer.test",
      rpcUrls: [],
      engine,
      timeoutMs: 30,
      now: () => clock,
      fetch: ((input: unknown, init?: RequestInit) => {
        asked.push(String(input));
        return neverAnswers(input, init);
      }) as typeof fetch,
    });
    const t0 = Date.now();
    expect(await reads.job("0x" + "ab".repeat(32))).toBeNull(); // unreachable, so reconcile says so
    expect(await reads.relayerTerms()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
    clock += 29_000;
    expect(await reads.relayerTerms()).toBeNull();
    expect(asked.filter((u) => u.endsWith("/info"))).toHaveLength(1); // the miss is cached: quotes do not wait again
    clock += 2_000;
    await reads.relayerTerms();
    expect(asked.filter((u) => u.endsWith("/info"))).toHaveLength(2);
  });

  it("the relayer's terms carry the addresses it runs for when it names them, each one an address (a V6 follow-up of 2026-10-16)", async () => {
    const terms = (info: unknown) =>
      makeReads({
        relayerUrl: "http://relayer.test",
        rpcUrls: [],
        engine,
        fetch: (async () => new Response(JSON.stringify(info))) as typeof fetch,
      }).relayerTerms();
    const a = "0x" + "AB".repeat(20);
    expect(await terms({ minFeeWei: "5", vouchers: [a] })).toEqual({ minFeeWei: "5", vouchers: [a.toLowerCase()] });
    expect(await terms({ minFeeWei: "5" }), "a relayer that names none").toEqual({ minFeeWei: "5" });
    expect(await terms({ minFeeWei: "5", vouchers: [a, "nope"] }), "not a list of addresses: none taken").toEqual({ minFeeWei: "5" });
    expect(await terms({ minFeeWei: "5", vouchers: a }), "not a list").toEqual({ minFeeWei: "5" });
  });

  it("a hung RPC endpoint: the next endpoint is asked after the limit", async () => {
    const reads = makeReads({
      relayerUrl: null,
      rpcUrls: ["http://hung.test", "http://ok.test"],
      engine,
      timeoutMs: 30,
      fetch: ((input: unknown, init?: RequestInit) =>
        String(input).startsWith("http://hung.test")
          ? neverAnswers(input, init)
          : Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" })))) as typeof fetch,
    });
    expect(await reads.blockNumber()).toBe(16);
    expect(await reads.escrowBalance("0x00000000000000000000000000000000000000e5", "native")).toBe(16n);
  });
});
