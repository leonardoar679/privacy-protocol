// The twelfth review round, 2026-11-06, C12-2 (MEDIUM): viem's own bound on an RPC answer (10 MiB) was no "refusal for its size" to the
// windowed log reader. An endpoint without a cap of its own below it — a self-hosted node, the local stack's — answered the pool's whole
// history once its events passed some ten thousand, viem refused the answer (ResponseBodyTooLargeError), and logsInWindows rethrew it
// instead of reading in windows: every spend, scan and refund scan failed from then on, each attempt four whole-history downloads (viem
// retried it three times). The transport's bound is explicit now (RPC_ANSWER_MAX_BYTES), a log read goes alone and its refusal is never
// asked again, and the reader reads that endpoint in windows — on the sync's own path (readView: ZI's critique, the log read had shared one
// batch with the leaf count and the root). Offline: a real public client over a fetch serving the logs, the answers' sizes their JSON's.
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, ResponseBodyTooLargeError, toHex, type Hex } from "viem";
import { publicClientFor } from "@privacy-wallet/privacy-engine/transport/chain";
import { ANSWER_TOO_LARGE_CODE, RPC_ANSWER_MAX_BYTES } from "@privacy-wallet/privacy-engine/transport/http";
import { logsInWindows, noteInsertedLogs, readView, type Deployment } from "../src/chain";
import { provenStorage } from "../src/lightclient";

const CORE = "0x00000000000000000000000000000000000000c0";
const noteInserted = parseAbiItem("event NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData)");
const noteData = ("0x01" + "ab".repeat(168)) as Hex;
const HEAD = 20_000n;
const LOGS = 12_000; // ~1 KB of JSON each: the whole history ~12.5 MB, past the bound
const logAt = (i: number, block: number) => ({
  address: CORE,
  blockNumber: toHex(block),
  blockHash: "0x" + "22".repeat(32),
  transactionHash: ("0x" + i.toString(16).padStart(64, "0")) as Hex,
  transactionIndex: "0x0",
  logIndex: toHex(i % 100),
  removed: false,
  topics: encodeEventTopics({ abi: [noteInserted], eventName: "NoteInserted", args: { leafIndex: i } }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [BigInt(i + 1), noteData]),
});
const sparse = () => Array.from({ length: LOGS }, (_, i) => logAt(i, i));
// ten events a block over the first 1,200 blocks: the first window of 10,000 blocks, and every one of more than ~1,000, past the bound
const dense = () => Array.from({ length: LOGS }, (_, i) => logAt(i, Math.floor(i / 10)));
const deploymentAt = (rpc: string) =>
  ({
    chainId: 1,
    core: CORE,
    ethVault: "0x00000000000000000000000000000000000000e7",
    rpcUrl: rpc,
    rpcUrls: [rpc],
    fromBlock: 0n,
    erc20Vaults: [],
  }) as unknown as Deployment;

type Req = { id: number; method: string; params: unknown[] };
/**
 * An endpoint with no cap of its own, serving `logs` (each at its block) and answering every request whole: the leaf count and the root of
 * any `eth_call` one word; `failFirst` answers a method 503 that many times first; `padLogsTo` pads a log read's answer to that many bytes,
 * `padBatchTo` a batch's; `inits` keeps each HTTP request's options.
 */
function endpoint(logs: ReturnType<typeof logAt>[], o: { failFirst?: Record<string, number>; padLogsTo?: number; padBatchTo?: number } = {}) {
  const asked: { method: string; range?: string }[] = [];
  const requests: string[][] = []; // each HTTP request's methods
  const inits: { methods: string[]; credentials?: string; redirect?: string; referrerPolicy?: string }[] = [];
  const failFirst = { ...(o.failFirst ?? {}) };
  const serve = (req: Req) => {
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    if (req.method === "eth_blockNumber") return ok(toHex(HEAD));
    if (req.method === "eth_chainId") return ok("0x1");
    if (req.method === "eth_call") return ok("0x" + LOGS.toString(16).padStart(64, "0"));
    if (req.method === "eth_getLogs") {
      const f = req.params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(f.fromBlock),
        to = f.toBlock === "latest" ? HEAD : BigInt(f.toBlock);
      return ok(logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to));
    }
    return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no ${req.method}` } };
  };
  const fetchFn: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Req | Req[];
    const all = Array.isArray(body) ? body : [body];
    requests.push(all.map((r) => r.method));
    inits.push({ methods: all.map((r) => r.method), credentials: init?.credentials, redirect: init?.redirect, referrerPolicy: init?.referrerPolicy });
    for (const r of all) {
      const f = r.method === "eth_getLogs" ? (r.params[0] as { fromBlock: string; toBlock: string }) : undefined;
      asked.push({ method: r.method, ...(f ? { range: `${BigInt(f.fromBlock)}-${f.toBlock === "latest" ? HEAD : BigInt(f.toBlock)}` } : {}) });
    }
    if ((failFirst[all[0].method] ?? 0) > 0) {
      failFirst[all[0].method]--;
      return new Response("busy", { status: 503 });
    }
    let text = JSON.stringify(Array.isArray(body) ? body.map(serve) : serve(body));
    if (o.padLogsTo !== undefined && !Array.isArray(body) && body.method === "eth_getLogs")
      text = text.slice(0, -1) + " ".repeat(o.padLogsTo - text.length) + "}";
    if (o.padBatchTo !== undefined && Array.isArray(body)) text = text.slice(0, -1) + " ".repeat(o.padBatchTo - text.length) + "]";
    return new Response(text, { headers: { "content-type": "application/json" } });
  };
  return { asked, requests, inits, fetchFn };
}
/** An error and its causes, outermost first. */
const chainOf = (e: unknown): unknown[] => {
  const out: unknown[] = [];
  for (let x = e, i = 0; x && i < 8; x = (x as { cause?: unknown }).cause, i++) out.push(x);
  return out;
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("C12-2: an answer past the transport's bound is a refusal for its size, asked once", () => {
  it("the bound is explicit — 10 MiB, viem's own default made the transport's: an answer of exactly the bound is read, one byte more refused (ZI's critique)", async () => {
    expect(RPC_ANSWER_MAX_BYTES).toBe(10_485_760);
    const getLogs = { method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest" }] } as never;
    const at = endpoint([], { padLogsTo: RPC_ANSWER_MAX_BYTES });
    globalThis.fetch = at.fetchFn;
    expect(await publicClientFor("http://rpc-e.body-cap.invalid:8545").request(getLogs)).toEqual([]);
    const past = endpoint([], { padLogsTo: RPC_ANSWER_MAX_BYTES + 1 });
    globalThis.fetch = past.fetchFn;
    const err = await publicClientFor("http://rpc-f.body-cap.invalid:8545")
      .request(getLogs)
      .then(
        () => null,
        (x: unknown) => x as Error & { code?: number },
      );
    expect(err).toBeInstanceOf(ResponseBodyTooLargeError);
    expect(err?.code).toBe(ANSWER_TOO_LARGE_CODE);
    expect(past.asked).toHaveLength(1);
  });

  it("an endpoint answering the whole history at once past the bound: read in windows, every event read, the whole history asked once", async () => {
    const e = endpoint(sparse());
    globalThis.fetch = e.fetchFn;
    const rpc = "http://rpc-a.body-cap.invalid:8545";
    const logs = await noteInsertedLogs(publicClientFor(rpc), deploymentAt(rpc));
    expect(logs).toHaveLength(LOGS);
    expect(logs.map((l) => l.leafIndex)).toEqual(Array.from({ length: LOGS }, (_, i) => i));
    const ranges = e.asked.filter((x) => x.method === "eth_getLogs").map((x) => x.range);
    expect(
      ranges.filter((r) => r === `0-${HEAD}`),
      "the whole history asked once: never again by viem's retry",
    ).toHaveLength(1);
    expect(ranges.length, "then in windows").toBeGreaterThan(1);
    // ... and from then on in windows at once: a second read never asks this endpoint the whole history again
    e.asked.length = 0;
    expect(await noteInsertedLogs(publicClientFor(rpc), deploymentAt(rpc))).toHaveLength(LOGS);
    expect(e.asked.filter((x) => x.range === `0-${HEAD}`)).toHaveLength(0);
  });

  it("a dense window past the bound: halved until it fits, every event read, no window asked twice running", async () => {
    const e = endpoint(dense());
    globalThis.fetch = e.fetchFn;
    const rpc = "http://rpc-b.body-cap.invalid:8545";
    const logs = await noteInsertedLogs(publicClientFor(rpc), deploymentAt(rpc));
    expect(logs).toHaveLength(LOGS);
    const ranges = e.asked.filter((x) => x.method === "eth_getLogs").map((x) => x.range!);
    expect(ranges).toContain("0-9999");
    expect(ranges).toContain("0-4999");
    for (let i = 1; i < ranges.length; i++) expect(ranges[i], `request ${i} repeats ${ranges[i - 1]}`).not.toBe(ranges[i - 1]);
  });

  it("the sync's own read (readView), the whole history past the bound: its first read succeeds, the leaf count and the root asked once each, never in the log read's batch (ZI's critique)", async () => {
    const e = endpoint(sparse());
    globalThis.fetch = e.fetchFn;
    const rpc = "http://rpc-h.body-cap.invalid:8545";
    const view = await readView(publicClientFor(rpc), deploymentAt(rpc));
    expect(view.logs).toHaveLength(LOGS);
    expect(view.nextLeafIndex).toBe(LOGS);
    expect(e.asked.filter((x) => x.method === "eth_call")).toHaveLength(2);
    for (const r of e.requests) if (r.includes("eth_getLogs")) expect(r, "a log read goes alone").toEqual(["eth_getLogs"]);
  });

  it("the sync's own read, a dense first window past the bound: every sync succeeds — three running —, the leaf count and the root asked once each per sync (ZI's critique)", async () => {
    const e = endpoint(dense());
    globalThis.fetch = e.fetchFn;
    const rpc = "http://rpc-i.body-cap.invalid:8545";
    for (let sync = 1; sync <= 3; sync++) {
      e.asked.length = 0;
      const view = await readView(publicClientFor(rpc), deploymentAt(rpc));
      expect(view.logs, `sync ${sync}`).toHaveLength(LOGS);
      expect(
        e.asked.filter((x) => x.method === "eth_call"),
        `sync ${sync}`,
      ).toHaveLength(2);
    }
  });

  it("any other failure is still viem's to retry, batched or a log read: an endpoint answering 503 twice is asked a third time", async () => {
    const e = endpoint([], { failFirst: { eth_blockNumber: 2 } });
    globalThis.fetch = e.fetchFn;
    expect(await publicClientFor("http://rpc-d.body-cap.invalid:8545").getBlockNumber()).toBe(HEAD);
    expect(e.asked.filter((x) => x.method === "eth_blockNumber")).toHaveLength(3);
    // the log read goes alone, its failures but the size refusal viem's to retry as before
    const logs = endpoint([], { failFirst: { eth_getLogs: 2 } });
    globalThis.fetch = logs.fetchFn;
    const getLogs = { method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest" }] } as never;
    expect(await publicClientFor("http://rpc-j.body-cap.invalid:8545").request(getLogs)).toEqual([]);
    expect(logs.asked.filter((x) => x.method === "eth_getLogs")).toHaveLength(3);
  });

  it("the caller's signal reaches the request, batched or alone: an aborted read ends at once (ZI's critique)", async () => {
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const body = JSON.parse(String(init?.body)) as Req | Req[];
        const answer = (r: Req) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_getLogs" ? [] : "0x1" });
        const t = setTimeout(() => resolve(new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)))), 2_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    const client = publicClientFor("http://rpc-g.body-cap.invalid:8545");
    for (const args of [{ method: "eth_blockNumber" }, { method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest" }] }]) {
      const c = new AbortController();
      const t0 = Date.now();
      setTimeout(() => c.abort(), 50);
      await expect(client.request(args as never, { signal: c.signal } as never), args.method).rejects.toThrow();
      expect(Date.now() - t0, `${args.method} ended at the abort`).toBeLessThan(1_000);
    }
  });

  it("the windowed reader reads viem's own refusal as one for size, bare or as another error's cause: it windows", async () => {
    for (const wrapped of [false, true]) {
      let whole = 0;
      const read = async (from: bigint, to: bigint | "latest") => {
        if (to === "latest") {
          whole++;
          const refused = new ResponseBodyTooLargeError({ maxSize: RPC_ANSWER_MAX_BYTES, size: 12_000_000 });
          // as viem's readContract hands it over: wrapped (ZI's critique)
          throw wrapped
            ? Object.assign(new Error("The contract function failed"), { cause: Object.assign(new Error("Execution failed"), { cause: refused }) })
            : refused;
        }
        const out: bigint[] = [];
        for (let b = from; b <= to; b++) out.push(b);
        return out;
      };
      const logs = await logsInWindows({ getBlockNumber: async () => 25_000n }, 0n, read);
      expect(whole, `wrapped: ${wrapped}`).toBe(1);
      expect(logs).toHaveLength(25_001);
    }
  });

  it("the light client's own RPC reads are bounded too: an endless answer is read to the bound and no further (ZI's and ZJ's critiques)", async () => {
    const lc = { finalizedExecutionBlockHash: () => ("0x" + "33".repeat(32)) as Hex } as never;
    const chunk = new Uint8Array(1 << 20).fill(32); // a MiB of spaces at a time, for ever
    let pulled = 0;
    const endless: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulled += chunk.byteLength;
            c.enqueue(chunk);
          },
        }),
      );
    await expect(provenStorage(lc, ["http://lc-a.body-cap.invalid"], CORE, [], endless)).rejects.toThrow(
      /no RPC answered eth_getBlockByHash: the answer is larger than 10485760 bytes/,
    );
    expect(pulled, "never the whole answer: read to the bound, then cancelled").toBeLessThanOrEqual(RPC_ANSWER_MAX_BYTES + 3 * chunk.byteLength);
  });

  it("the light client's honest answer of exactly the bound is read: its header checked, not refused (ZJ's critique)", async () => {
    const lc = { finalizedExecutionBlockHash: () => ("0x" + "33".repeat(32)) as Hex } as never;
    const honest: typeof fetch = async () => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
      return new Response(text.slice(0, -1) + " ".repeat(RPC_ANSWER_MAX_BYTES - text.length) + "}");
    };
    const err = await provenStorage(lc, ["http://lc-b.body-cap.invalid"], CORE, [], honest).then(
      () => null,
      (x: Error) => x,
    );
    expect(err?.message, "the answer read, its header refused for what it holds").not.toMatch(/no RPC answered|no result/);
    expect(err?.message).toMatch(/header/i);
  });

  it("a batch of the other reads is bounded as a whole: an answer of exactly the bound is read; one byte more refused, unmarked, and retried as viem retries (ZJ's critique)", async () => {
    const at = endpoint([], { padBatchTo: RPC_ANSWER_MAX_BYTES });
    globalThis.fetch = at.fetchFn;
    expect(await publicClientFor("http://rpc-k.body-cap.invalid:8545").getBlockNumber()).toBe(HEAD);
    const past = endpoint([], { padBatchTo: RPC_ANSWER_MAX_BYTES + 1 });
    globalThis.fetch = past.fetchFn;
    const err = await publicClientFor("http://rpc-l.body-cap.invalid:8545")
      .getBlockNumber()
      .then(
        () => null,
        (x: unknown) => x,
      );
    const refused = chainOf(err).find((x) => x instanceof ResponseBodyTooLargeError) as (Error & { code?: number }) | undefined;
    expect(refused, "viem's own refusal").toBeDefined();
    expect(refused?.code, "never marked: the batch's refusal is viem's to retry").toBeUndefined();
    expect(
      past.asked.filter((x) => x.method === "eth_blockNumber"),
      "asked as viem retries: four times",
    ).toHaveLength(4);
  });

  it("the log read's transport is under the wallet's policy as the batched one is: no credentials, no redirect followed, no referrer (ZJ's critique)", async () => {
    const e = endpoint([]);
    globalThis.fetch = e.fetchFn;
    const client = publicClientFor("http://rpc-m.body-cap.invalid:8545");
    await client.getBlockNumber();
    await client.request({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest" }] } as never);
    expect(e.inits.map((i) => i.methods)).toEqual([["eth_blockNumber"], ["eth_getLogs"]]);
    for (const i of e.inits) expect(i, i.methods.join()).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  });
});
