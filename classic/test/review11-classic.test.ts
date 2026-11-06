// The eleventh review round's Classic items (2026-11-04) as regressions: answers read to a bound, and the sync's window halved on one
// (C11-11); a refused, blocked or throwing database falls back to memory for the page, and the jobs say so (C11-5); the record's keyed digest
// of its note, dropped once it ends (C11-1); a submission whose answer was lost reads "Outcome unknown" (VC-N1); the account screened is the
// one that sends (C11-7); a pool check that could not read is asked again, its router fact too (C11-10); an unverified history's statistics
// say so (C11-13). And the round's critique (2026-11-05): the second endpoint's disagreement or silence is the page's, never the copy's, and
// the first is asked alone (C11-12, C11-9); a history across a prover worker a close retired (C11-6, C11-2). The flows' own items — the
// hashes before any record (C11-8), the digest from the submission on, a relayer's FAILED for a note the pool reports spent and wallet mode
// screening first (C11-13), the account switched during the screening (C11-7), the relayer turned offline at the confirmation (C11-3), the
// re-proof's root kept from the second endpoint (C11-9) — are in flows.test.ts; the screens' words in screens.test.tsx and app-live.test.tsx.
import { keccak256 } from "js-sha3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServices, sourceOf } from "../src/app/services/source";
import { closedRecord, newJob, noteDigestOf, toHistoryRow, type JobRecord } from "../src/app/services/operations";
import { PoolHistory } from "../src/app/services/history";
import { WalletSession } from "../src/app/services/wallet";
import { configFromEnv } from "../src/config";
import { MerkleTree } from "../src/crypto/tree";
import { toHex32 } from "../src/crypto/hashes";
import { syncDelta, type Rpc } from "../src/history/sync";
import { SELECTORS } from "../src/history/verify";
import { DEPLOYMENT, poolOf } from "../src/model/pools";
import { AnswerTooLarge, readCapped } from "../src/net/capped";
import { relayerTransport, RELAYER_ANSWER_MAX } from "../src/net/relayer";
import { makeRpc, RPC_ANSWER_MAX } from "../src/net/rpc";
import { ProverClient, type WorkerLike } from "../src/prover/client";
import type { ProverEvent, ProverRequest } from "../src/prover/protocol";
import { BLOCKED_WAIT_MS, historyStore, jobsStore, memoryHistoryStore, memoryJobsStore, openDatabase, type StoredHistory } from "../src/storage/historyDb";
import { depositLog, fakeProver, fakeTrees, fakeWalletProvider, fixtureSnapshot, hex32, POOL_100, scriptedChain, word } from "./helpers/fakes";

const ACCOUNT = "0x75b9758bba5671c1e71c533a3fa5557f85126c3e" as const;
const OTHER = "0x9999999999999999999999999999999999999999" as const;
const snap = fixtureSnapshot();
const sel = (signature: string) => "0x" + keccak256(signature).slice(0, 8);
const PIN = DEPLOYMENT.pools["eth-100"];

/** A body that streams `chunk`-byte pieces without end, counting what was pulled and whether it was cancelled. */
function endless(chunk: number) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      seen.pulled += chunk;
      ctl.enqueue(new Uint8Array(chunk).fill(0x20));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("answers read to a bound (the eleventh review round, C11-11)", () => {
  it("a stream past the bound is cancelled there; a declared length past it is not read at all; a small answer is read whole", async () => {
    const { body, seen } = endless(16 * 1024);
    await expect(readCapped(new Response(body), 64 * 1024)).rejects.toBeInstanceOf(AnswerTooLarge);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled, "nothing read far past the bound").toBeLessThanOrEqual(64 * 1024 + 3 * 16 * 1024);
    const declared = endless(1024);
    await expect(readCapped(new Response(declared.body, { headers: { "content-length": String(64 * 1024 + 1) } }), 64 * 1024)).rejects.toThrow(/too large/);
    expect(declared.seen.cancelled).toBe(true);
    expect(await readCapped(new Response('{"ok":true}'), 64 * 1024)).toBe('{"ok":true}');
  });

  it("a relayer's endless answer is refused at RELAYER_ANSWER_MAX; an endpoint's at RPC_ANSWER_MAX, in words the sync reads as a range refusal", async () => {
    const relayer = endless(32 * 1024);
    const transport = relayerTransport({ fetchImpl: async () => new Response(relayer.body, { status: 200 }) });
    await expect(transport.getJson("https://relayer.example/status")).rejects.toThrow(/too large/);
    expect(relayer.seen.pulled).toBeLessThanOrEqual(RELAYER_ANSWER_MAX + 3 * 32 * 1024);
    const rpc = makeRpc(["https://rpc.example"], {
      fetchImpl: async () => new Response("x", { status: 200, headers: { "content-length": String(RPC_ANSWER_MAX + 1) } }),
    });
    await expect(rpc("eth_getLogs", [])).rejects.toThrow(/answer is too large/);
    // the sync's range-refusal words (history/sync.ts RANGE_REFUSAL) take it: the window is halved, never the history failed
    expect(/range|limit|too (large|many|big)|exceed/i.test(`the answer is too large (more than ${RPC_ANSWER_MAX} bytes)`)).toBe(true);
    const ok = makeRpc(["https://rpc.example"], { fetchImpl: async () => new Response('{"jsonrpc":"2.0","id":1,"result":"0x10"}') });
    expect(await ok("eth_blockNumber", [])).toBe("0x10");
  });

  it("the sync halves its window on an answer past RPC_ANSWER_MAX and finishes (the critique: the words had been tested, never the sync)", async () => {
    const spans: number[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
      if (req.method === "eth_getLogs") {
        const { fromBlock, toBlock } = req.params[0] as { fromBlock: string; toBlock: string };
        const span = Number.parseInt(toBlock, 16) - Number.parseInt(fromBlock, 16) + 1;
        spans.push(span);
        // a window wider than 100 blocks answers more than the bound declares: refused before it is read
        return span > 100 ? new Response("[]", { headers: { "content-length": String(RPC_ANSWER_MAX + 1) } }) : answer([]);
      }
      if (req.method === "eth_getBlockByNumber") return answer({ number: req.params[0], hash: hex32(BigInt(Number.parseInt(req.params[0] as string, 16))) });
      throw new Error(`not scripted: ${req.method}`);
    }) as typeof fetch;
    const r = await syncDelta({
      rpc: makeRpc(["https://rpc.example"], { fetchImpl }),
      address: POOL_100,
      fromBlock: 1_000,
      leaves: 0,
      headBlock: 1_412,
      window: 400,
    });
    expect(r.toBlock, "synced to the head less its confirmations").toBe(1_400);
    expect(spans.slice(0, 3), "400, then 200, then 100").toEqual([400, 200, 100]);
  });
});

describe("a refused or blocked database (the eleventh review round, C11-5)", () => {
  const stored = {
    manifest: snap.manifest,
    state: { pool: "eth-100", address: POOL_100, toBlock: 1, blockHash: null, leaves: 0, checkpoints: [] },
    deposits: [],
    withdrawals: [],
    layers: [],
  } as unknown as StoredHistory;
  /** A factory whose every opening fails, or is blocked and never opens. */
  const factory = (outcome: "error" | "blocked") => {
    const opened: string[] = [];
    const f = {
      open() {
        const req: Record<string, unknown> = { error: outcome === "error" ? new Error("The user denied permission to access the database.") : null };
        opened.push(outcome);
        setTimeout(() => (outcome === "error" ? (req.onerror as () => void)?.() : (req.onblocked as () => void)?.()), 0);
        return req;
      },
    };
    return { f: f as unknown as IDBFactory, opened };
  };

  it("an opening the platform refuses: the history and the jobs fall back to memory for the page — before, no history and no withdrawal", async () => {
    const { f, opened } = factory("error");
    vi.stubGlobal("indexedDB", f);
    const history = historyStore();
    await history.write("eth-100", stored);
    expect(await history.read("eth-100")).toEqual(stored);
    const jobs = jobsStore();
    const job = newJob("j1", "withdrawal", "eth-100", 1, { via: "wallet" });
    await jobs.put(job);
    expect(await jobs.list()).toEqual([job]);
    expect(opened.length, "asked once per store, then memory").toBe(2);
  });

  it("an opening blocked by a tab that never closes is waited for BLOCKED_WAIT_MS, then memory", async () => {
    vi.useFakeTimers();
    const { f } = factory("blocked");
    vi.stubGlobal("indexedDB", f);
    const history = historyStore();
    const writing = history.write("eth-100", stored);
    let settled = false;
    void writing.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(BLOCKED_WAIT_MS - 100);
    expect(settled, "the other tab is waited for, not given up on at once (the critique)").toBe(false);
    await vi.advanceTimersByTimeAsync(110);
    await writing;
    expect(await history.read("eth-100")).toEqual(stored);
  });

  it("an opening that throws at once — blocked site data, an opaque origin — is a refusal too: memory for the page, and the jobs say so (the critique of C11-5)", async () => {
    vi.stubGlobal("indexedDB", {
      open() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    } as unknown as IDBFactory);
    const history = historyStore();
    await history.write("eth-100", stored);
    expect(await history.read("eth-100")).toEqual(stored);
    const jobs = jobsStore();
    expect(jobs.pageOnly, "the device's, until an opening is refused").toBe(false);
    const job = newJob("j1", "withdrawal", "eth-100", 1, { via: "wallet" });
    await jobs.put(job);
    expect(await jobs.list()).toEqual([job]);
    expect(jobs.pageOnly, "the records live in this page only: History says so").toBe(true);
  });

  it("a connection that opens after the wait gave up is closed at once: it would block the next upgrade or delete (the critique of C11-5)", async () => {
    vi.useFakeTimers();
    const closed: number[] = [];
    const req: Record<string, unknown> = { error: null };
    const opening = openDatabase({ open: () => req } as unknown as IDBFactory).catch((e: unknown) => e);
    (req.onblocked as () => void)();
    await vi.advanceTimersByTimeAsync(BLOCKED_WAIT_MS + 10);
    expect(String(await opening)).toMatch(/blocked by another tab/);
    req.result = { close: () => closed.push(1), objectStoreNames: { contains: () => true } };
    (req.onsuccess as () => void)();
    expect(closed).toHaveLength(1);
  });
});

describe("the record's digest of its note (the eleventh review round, C11-1, VC-N1)", () => {
  it("is keccak256(the record's id ‖ the 32-byte nullifier hash), keyed by the record; an ended record drops it; a lost answer reads Outcome unknown", () => {
    const nh = hex32(4242n);
    const id = new TextEncoder().encode("j1");
    const bytes = new Uint8Array(id.length + 32);
    bytes.set(id, 0);
    bytes.set(Uint8Array.from(Buffer.from(nh.slice(2), "hex")), id.length);
    expect(noteDigestOf("j1", nh)).toBe(keccak256(bytes));
    expect(noteDigestOf("j1", nh.toUpperCase().replace("0X", "0x"))).toBe(noteDigestOf("j1", nh));
    expect(noteDigestOf("j2", nh)).not.toBe(noteDigestOf("j1", nh));
    const open: JobRecord = { ...newJob("j1", "withdrawal", "eth-100", 1, { via: "relayer" }), state: "SOURCE_CONFIRMING", noteDigest: noteDigestOf("j1", nh) };
    expect(closedRecord(open).noteDigest, "kept while open").toBe(open.noteDigest);
    expect(closedRecord({ ...open, state: "COMPLETED" }).noteDigest).toBeUndefined();
    expect(closedRecord({ ...open, state: "FAILED" }).noteDigest).toBeUndefined();
    expect(JSON.stringify(closedRecord({ ...open, state: "CANCELLED" }))).not.toContain("noteDigest");
    expect(toHistoryRow({ ...open, state: "RECOVERY_REQUIRED" }).status).toBe("unknown");
  });
});

describe("the wallet that sends (the eleventh review round, C11-7)", () => {
  it("a send from an account other than the one screened is refused before the wallet is asked", async () => {
    const provider = fakeWalletProvider(ACCOUNT);
    const wallet = new WalletSession({
      router: "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
      discover: async () => [{ info: { id: "fake", name: "Fake Wallet" }, provider }],
    });
    await wallet.discover();
    await wallet.connect("fake");
    const pool = poolOf("eth-100");
    await expect(wallet.sendDeposit(pool, hex32(5n), { account: OTHER })).rejects.toThrow(/account changed since it was screened/);
    expect(provider.sent).toEqual([]);
    await expect(wallet.sendDeposit(pool, hex32(5n), { account: ACCOUNT.toUpperCase().replace("0X", "0x") as `0x${string}` })).resolves.toMatch(/^0x/);
    expect(provider.sent).toHaveLength(1);
    await expect(wallet.sendDeposit(pool, hex32(5n)), "no screening: no account to hold to").resolves.toMatch(/^0x/);
  });
});

describe("the pool check (the eleventh review round, C11-10)", () => {
  it("a check whose reads failed is asked again after CHECK_RETRY_MS; a definite one is kept", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let codeReads = 0;
    const chain = scriptedChain({
      head: 100,
      logs: [[]],
      code: "0x6001",
      calls: {
        [sel("verifier()")]: `0x${PIN.verifier.slice(2).padStart(64, "0")}`,
        [sel("levels()")]: `0x${word(PIN.levels)}`,
        [sel("denomination()")]: `0x${word(BigInt(PIN.denominationWei))}`,
        [sel("instances(address)")]: `0x${word(0)}${word(0)}${word(1)}${word(0)}${word(30)}`,
      },
    });
    const rpc = async (method: string, params: unknown[]) => {
      if (method === "eth_getCode" && codeReads++ === 0) throw new Error("upstream connect error");
      return chain.rpc(method, params);
    };
    const services = createServices({
      config: configFromEnv({ VITE_CLASSIC_RPC_URLS: "https://rpc.example" }),
      rpc,
      prover: async () => {
        throw new Error("no prover here");
      },
      historyStore: memoryHistoryStore(),
      jobs: memoryJobsStore(),
      fetchSnapshot: async () => null,
      curated: [],
    });
    await services.checkPool("eth-100");
    expect(services.facts.get("eth-100")!.contract).toBe("unknown");
    await services.checkPool("eth-100");
    expect(codeReads, "within the pause: the same check").toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await services.checkPool("eth-100");
    expect(codeReads, "asked again").toBe(2);
    expect(services.facts.get("eth-100")!.contract, "the code read this time: a definite answer (not the pinned code)").toBe("differs");
    await vi.advanceTimersByTimeAsync(60_000);
    await services.checkPool("eth-100");
    expect(codeReads, "a definite answer is kept for the page").toBe(2);
  });

  it("a router read that failed is asked again too (the critique of C11-10)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let routerReads = 0;
    const { readFileSync } = await import("node:fs");
    const code = (
      JSON.parse(readFileSync(new URL("../contracts/verified/pool-eth-1.json", import.meta.url), "utf8")) as { runtimeBytecode: { onchainBytecode: string } }
    ).runtimeBytecode.onchainBytecode;
    const chain = scriptedChain({
      head: 100,
      logs: [[]],
      code,
      calls: {
        [sel("verifier()")]: `0x${PIN.verifier.slice(2).padStart(64, "0")}`,
        [sel("levels()")]: `0x${word(PIN.levels)}`,
        [sel("denomination()")]: `0x${word(BigInt(PIN.denominationWei))}`,
        [sel("instances(address)")]: `0x${word(0)}${word(0)}${word(1)}${word(0)}${word(30)}`,
      },
    });
    const rpc = async (method: string, params: unknown[]) => {
      if (method === "eth_call" && (params[0] as { data: string }).data.startsWith(sel("instances(address)")) && routerReads++ === 0)
        throw new Error("HTTP 429");
      return chain.rpc(method, params);
    };
    const services = createServices({
      config: configFromEnv({ VITE_CLASSIC_RPC_URLS: "https://rpc.example" }),
      rpc,
      prover: async () => {
        throw new Error("no prover here");
      },
      historyStore: memoryHistoryStore(),
      jobs: memoryJobsStore(),
      fetchSnapshot: async () => null,
      curated: [],
    });
    await services.checkPool("eth-100");
    expect(services.facts.get("eth-100")).toMatchObject({ contract: "verified", router: "unknown" });
    await vi.advanceTimersByTimeAsync(5_000);
    await services.checkPool("eth-100");
    expect(services.facts.get("eth-100")!.router, "asked again").toBe("enabled");
  });
});

describe("an unverified history's statistics (the eleventh review round, C11-13)", () => {
  it("stats() says whether the history they come from is verified", async () => {
    const trees = fakeTrees();
    const h = new PoolHistory({
      pool: "eth-100",
      address: POOL_100,
      deployedBlock: 9_161_895,
      tree: trees.client,
      store: memoryHistoryStore(),
      fetchSnapshot: async () => snap,
      rpc: null,
      now: () => 1_700_000_000_000,
    });
    await h.ensure();
    expect(h.stats()).toMatchObject({ deposits: 1024, verified: false });
    const checked = new PoolHistory({ ...base, rpc: honestChain().rpc, tree: fakeTrees().client, store: memoryHistoryStore() });
    await checked.ensure();
    expect(checked.stats(), "a verified history's statistics say so (the critique)").toMatchObject({ deposits: 1024, verified: true });
  });
});

const realHash = { [snap.manifest.toBlock]: snap.manifest.blockHash! };
const TO = snap.manifest.toBlock;
const base = { pool: "eth-100" as const, address: POOL_100, deployedBlock: 9_161_895, fetchSnapshot: async () => snap, now: () => 1_700_000_000_000 };
const honestChain = (o: { logs?: Parameters<typeof scriptedChain>[0]["logs"]; nextIndex?: number; head?: number } = {}) =>
  scriptedChain({ head: o.head ?? TO + 112, logs: o.logs ?? [[]], nextIndex: o.nextIndex ?? 1024, knownRoot: true, blockHashes: realHash });
const rootReads = (seen: { method: string; params: unknown[] }[]) =>
  seen.filter(
    (c) =>
      c.method === "eth_call" && ([SELECTORS.getLastRoot, SELECTORS.isKnownRoot] as string[]).includes((c.params[0] as { data: string }).data.slice(0, 10)),
  );

describe("a pool's history and its second endpoint (the eleventh review round's critique of C11-12 and C11-9)", () => {
  it("a second endpoint that does not answer leaves the history unverified for the page: the device's copy is kept unmarked and read at the next start — never dropped, fetched or hashed again", async () => {
    const store = memoryHistoryStore();
    const mute: Rpc = async () => {
      throw new Error("HTTP 429");
    };
    const start = async () => {
      const trees = fakeTrees();
      let fetched = 0;
      const h = new PoolHistory({
        ...base,
        rpc: honestChain().rpc,
        secondOpinion: mute,
        tree: trees.client,
        store,
        fetchSnapshot: async () => {
          fetched++;
          return snap;
        },
      });
      return { s: await h.ensure(), fetched, calls: trees.calls };
    };
    const first = await start();
    expect(first.s).toMatchObject({
      kind: "ready",
      verified: false,
      reason: "the second RPC endpoint did not answer: the history is checked again at the next sync",
    });
    expect((await store.read("eth-100"))!.state.verified, "never stored as a copy the chain refused").toBeUndefined();
    for (const next of [await start(), await start()]) {
      expect(next.fetched, "the copy read, nothing fetched").toBe(0);
      expect(next.calls, "nor hashed again").toEqual(["load"]);
      expect(next.s).toMatchObject({ kind: "ready", verified: false });
    }
  });

  it("a second endpoint that disagrees: unverified for the page, saying so; the copy kept unmarked, and its agreement at a later sync verifies it", async () => {
    const store = memoryHistoryStore();
    const trees = fakeTrees();
    const lying = scriptedChain({ head: TO + 112, logs: [[]], nextIndex: 1024, knownRoot: false, blockHashes: realHash });
    const h = new PoolHistory({ ...base, rpc: honestChain().rpc, secondOpinion: lying.rpc, tree: trees.client, store });
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: false, reason: "the second RPC endpoint does not agree with this history at its block" });
    expect((await store.read("eth-100"))!.state.verified).toBeUndefined();
    lying.options.knownRoot = true;
    expect(await h.refresh()).toMatchObject({ kind: "ready", verified: true });
    expect((await store.read("eth-100"))!.state.verified).toBe(true);
    expect(trees.calls, "never dropped and hashed again").toEqual(["build"]);
  });

  it("with a second endpoint the root and the count are asked of the first alone — the failover had let the second answer for it; the first's silence is the page's; with one endpoint it fails the run, as before", async () => {
    const failover = honestChain();
    const first = honestChain();
    const second = honestChain();
    const both = new PoolHistory({
      ...base,
      rpc: failover.rpc,
      firstOpinion: first.rpc,
      secondOpinion: second.rpc,
      tree: fakeTrees().client,
      store: memoryHistoryStore(),
    });
    expect(await both.ensure()).toMatchObject({ kind: "ready", verified: true });
    expect(rootReads(failover.seen), "the failing-over endpoint is never asked the root").toEqual([]);
    expect(rootReads(first.seen).length).toBeGreaterThan(0);
    expect(rootReads(second.seen).length).toBeGreaterThan(0);
    const silent: Rpc = async (method, params) => {
      if (method === "eth_call") throw new Error("HTTP 503");
      return first.rpc(method, params);
    };
    const store = memoryHistoryStore();
    const quiet = new PoolHistory({ ...base, rpc: failover.rpc, firstOpinion: silent, secondOpinion: second.rpc, tree: fakeTrees().client, store });
    expect(await quiet.ensure()).toMatchObject({
      kind: "ready",
      verified: false,
      reason: "the first RPC endpoint did not answer: the history is checked again at the next sync",
    });
    expect((await store.read("eth-100"))!.state.verified).toBeUndefined();
    const one = honestChain();
    const alone = new PoolHistory({
      ...base,
      rpc: async (method, params) => {
        if (method === "eth_call" && (params[0] as { data: string }).data.startsWith(SELECTORS.getLastRoot)) throw new Error("HTTP 503");
        return one.rpc(method, params);
      },
      tree: fakeTrees().client,
      store: memoryHistoryStore(),
    });
    expect(await alone.ensure()).toMatchObject({ kind: "failed", reason: expect.stringMatching(/HTTP 503/) });
  });

  it("the services pin the first endpoint for the reads a second opinion checks: it never fails over to the second; with one endpoint it is that one", async () => {
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      hits.push(new URL(url).host);
      return url.includes("a.example") ? new Response("down", { status: 503 }) : new Response('{"jsonrpc":"2.0","id":1,"result":"0x10"}');
    });
    const make = (urls: string) =>
      createServices({
        config: configFromEnv({ VITE_CLASSIC_RPC_URLS: urls }),
        prover: async () => {
          throw new Error("no prover here");
        },
        historyStore: memoryHistoryStore(),
        jobs: memoryJobsStore(),
        fetchSnapshot: async () => null,
        curated: [],
      });
    const two = make("https://a.example,https://b.example");
    expect(await two.rpc!("eth_blockNumber", []), "the failover").toBe("0x10");
    expect(hits).toEqual(["a.example", "b.example"]);
    hits.length = 0;
    await expect(two.firstOpinion!("eth_blockNumber", [])).rejects.toThrow(/HTTP 503/);
    expect(hits, "the first alone").toEqual(["a.example"]);
    hits.length = 0;
    expect(await two.secondOpinion!("eth_blockNumber", [])).toBe("0x10");
    expect(hits).toEqual(["b.example"]);
    const one = make("https://b.example");
    expect(one.firstOpinion).toBe(one.rpc);
    expect(one.secondOpinion).toBeNull();
  });

  it("a history held for a time stays held until it is over, whatever holds are released meanwhile (the critique: a relayer may still publish an unsettled withdrawal)", async () => {
    const first = honestChain();
    const second = honestChain();
    let t = 1_700_000_000_000;
    const h = new PoolHistory({ ...base, now: () => t, rpc: first.rpc, secondOpinion: second.rpc, tree: fakeTrees().client, store: memoryHistoryStore() });
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    const release = h.hold();
    h.holdFor(900_000);
    release();
    const asked = second.seen.length;
    first.options.head += 20;
    t += 899_000;
    await h.refresh();
    expect(second.seen.length, "within the time: no sync").toBe(asked);
    t += 2_000;
    await h.refresh();
    expect(second.seen.length, "past it: synced, both asked").toBeGreaterThan(asked);
  });

  it("a held history starts no sync — ensure() and refresh() answer the status as it is — until released, twice harmlessly; one marked stale needs a sync until one runs (the critique of C11-9)", async () => {
    const first = honestChain();
    const second = honestChain();
    const h = new PoolHistory({ ...base, rpc: first.rpc, secondOpinion: second.rpc, tree: fakeTrees().client, store: memoryHistoryStore() });
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    const release = h.hold();
    h.markStale();
    expect(h.needsSync()).toBe(true);
    const asked = { first: first.seen.length, second: second.seen.length };
    first.options.head += 20;
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    expect(await h.refresh()).toMatchObject({ kind: "ready", verified: true });
    expect(first.seen.length, "held: neither endpoint asked").toBe(asked.first);
    expect(second.seen.length).toBe(asked.second);
    release();
    release();
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    expect(second.seen.length, "released: synced, both asked").toBeGreaterThan(asked.second);
    expect(h.needsSync()).toBe(false);
    const again = h.hold(); // the double release left no negative count: this hold holds
    const n = second.seen.length;
    first.options.head += 20;
    await h.refresh();
    expect(second.seen.length).toBe(n);
    again();
  });

  it("which relayed records hold their pool: one running, its page closed during it, its answer lost, its job no longer followed — never one ended, mined, failed or confirmed, nor wallet mode (the critique)", async () => {
    const { inFlight } = await import("../src/app/services/operations");
    const open = { ...newJob("j", "withdrawal", "eth-100", 1, { via: "relayer" }), state: "RECOVERY_REQUIRED" as const };
    expect(inFlight(open), "its answer lost").toBe(true);
    for (const s of ["QUEUED", "ACCEPTED", "SENT", "RESUBMITTED"] as const)
      expect(inFlight({ ...open, relayerState: s }), `followed no further at ${s}`).toBe(true);
    for (const s of ["FAILED", "MINED", "CONFIRMED"] as const) expect(inFlight({ ...open, relayerState: s }), `${s}: nothing more to publish`).toBe(false);
    for (const state of ["READY_TO_REVIEW", "PREPARING_PROOF", "AWAITING_AUTHORIZATION", "SUBMITTING"] as const)
      expect(inFlight({ ...open, state }), `running, or its page closed, at ${state}`).toBe(true);
    for (const state of ["COMPLETED", "FAILED", "CANCELLED"] as const) expect(inFlight({ ...open, state }), `ended ${state}`).toBe(false);
    expect(inFlight({ ...open, state: "SOURCE_CONFIRMING", relayerState: "MINED" })).toBe(false);
    expect(inFlight({ ...open, via: "wallet" })).toBe(false);
    expect(inFlight({ ...open, kind: "deposit" })).toBe(false);
  });

  it("the device's records are read again at every run: a hold they start holds a history already synced, and ends with them (the critique)", async () => {
    let t = 1_700_000_000_000;
    let until = 0;
    const first = honestChain();
    const second = honestChain();
    const h = new PoolHistory({
      ...base,
      now: () => t,
      rpc: first.rpc,
      secondOpinion: second.rpc,
      heldFrom: async () => until,
      tree: fakeTrees().client,
      store: memoryHistoryStore(),
    });
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    until = t + 600_000; // another page's relayed withdrawal
    t += 61_000;
    const asked = second.seen.length;
    expect(await h.ensure(), "as it is").toMatchObject({ kind: "ready", verified: true });
    expect(second.seen.length, "nothing asked").toBe(asked);
    expect(h.isHeld()).toBe(true);
    until = 0; // that withdrawal settled
    expect(await h.refresh()).toMatchObject({ kind: "ready", verified: true });
    expect(second.seen.length, "synced, both asked").toBeGreaterThan(asked);
    expect(h.isHeld()).toBe(false);
  });

  it("a page reloaded during an unsettled withdrawal's hold loads the device's copy with its own verdict and asks no endpoint; past the hold it syncs (the critique)", async () => {
    const store = memoryHistoryStore();
    const first = honestChain();
    const second = honestChain();
    expect(await new PoolHistory({ ...base, rpc: first.rpc, secondOpinion: second.rpc, tree: fakeTrees().client, store }).ensure()).toMatchObject({
      kind: "ready",
      verified: true,
    });
    let t = 1_700_000_000_000;
    const reloaded = new PoolHistory({
      ...base,
      now: () => t,
      rpc: first.rpc,
      secondOpinion: second.rpc,
      heldFrom: async () => 1_700_000_600_000, // the record written at the start: its hold ends 10 minutes on
      tree: fakeTrees().client,
      store,
    });
    const asked = { first: first.seen.length, second: second.seen.length };
    expect(await reloaded.ensure(), "the device's copy, as it was verified").toMatchObject({ kind: "ready", verified: true });
    expect(first.seen.length, "no endpoint asked").toBe(asked.first);
    expect(second.seen.length).toBe(asked.second);
    expect(reloaded.isHeld()).toBe(true);
    t += 601_000;
    expect(await reloaded.ensure()).toMatchObject({ kind: "ready", verified: true });
    expect(second.seen.length, "past the hold: synced, both asked").toBeGreaterThan(asked.second);
  });

  it("a held history that failed loads what it holds and asks no endpoint, until it is released (the critique of C11-9)", async () => {
    const chain = honestChain();
    let down = true;
    const seen: string[] = [];
    const rpc: Rpc = async (method, params) => {
      seen.push(method);
      if (down) throw new Error("HTTP 503");
      return chain.rpc(method, params);
    };
    const h = new PoolHistory({ ...base, rpc, secondOpinion: honestChain().rpc, tree: fakeTrees().client, store: memoryHistoryStore() });
    expect(await h.ensure()).toMatchObject({ kind: "failed" });
    down = false;
    const release = h.hold();
    const before = seen.length;
    expect(await h.ensure(), "held: what it holds, unverified").toMatchObject({ kind: "ready", verified: false });
    expect(seen.length, "held: no endpoint asked").toBe(before);
    release();
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    // refresh() alike
    down = true;
    const r = new PoolHistory({ ...base, rpc, secondOpinion: honestChain().rpc, tree: fakeTrees().client, store: memoryHistoryStore() });
    expect(await r.ensure()).toMatchObject({ kind: "failed" });
    down = false;
    const releaseR = r.hold();
    const atR = seen.length;
    expect(await r.refresh(), "held: refresh() loads what it holds too").toMatchObject({ kind: "ready", verified: false });
    expect(seen.length, "held: no endpoint asked").toBe(atR);
    releaseR();
    expect(await r.refresh()).toMatchObject({ kind: "ready", verified: true });
  });

  it("a record's match reads only the Withdrawal events from its own block on, newest first (the critique of C11-1: every event's digest had been computed at every read)", async () => {
    const h = new PoolHistory({ ...base, rpc: honestChain().rpc, tree: fakeTrees().client, store: memoryHistoryStore() });
    await h.ensure();
    const all = h.withdrawals.length;
    expect(all).toBeGreaterThan(100);
    const from = h.withdrawals[all - 10].blockNumber;
    const after = h.withdrawals.filter((w) => w.blockNumber >= from).length;
    let asked = 0;
    expect(h.findWithdrawal(() => (asked++, false), undefined, from)).toBeNull();
    expect(asked).toBe(after);
    asked = 0;
    h.findWithdrawal(() => (asked++, false));
    expect(asked).toBe(all);
    const target = h.withdrawals[all - 3];
    expect(h.findWithdrawal((nh) => nh === target.nullifierHash, undefined, from)).toBe(target);
  });

  it("every sync asks both endpoints, a refresh too — a history is never verified on the first endpoint's word alone; one marked stale syncs again at the next ensure (the critique of C11-9)", async () => {
    const first = honestChain();
    const second = honestChain();
    const h = new PoolHistory({ ...base, rpc: first.rpc, secondOpinion: second.rpc, tree: fakeTrees().client, store: memoryHistoryStore() });
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    let asked = rootReads(second.seen).length;
    first.options.head += 20;
    expect(await h.refresh()).toMatchObject({ kind: "ready", verified: true });
    expect(rootReads(second.seen).length).toBeGreaterThan(asked);
    asked = rootReads(second.seen).length;
    await h.ensure();
    expect(rootReads(second.seen).length, "fresh: answered at once").toBe(asked);
    h.markStale();
    await h.ensure();
    expect(rootReads(second.seen).length, "marked stale: synced again, both asked").toBeGreaterThan(asked);
  });

  it("with a second endpoint too, a stored copy the first endpoint refuses is dropped once for what is served, and the history ends verified (the fourth round's rule)", async () => {
    const store = memoryHistoryStore();
    const s1 = await new PoolHistory({ ...base, rpc: honestChain().rpc, secondOpinion: honestChain().rpc, tree: fakeTrees().client, store }).ensure();
    expect(s1).toMatchObject({ kind: "ready", verified: true });
    const realRoot = String((s1 as { root: string }).root).toLowerCase();
    const good = (await store.read("eth-100"))!;
    const layers = good.layers.map((l) => [...l]);
    layers[layers.length - 1][0] = hex32(424_242n); // the copy's root: no chain knows it
    await store.write("eth-100", { ...good, layers });
    const knowing = () =>
      scriptedChain({
        head: TO + 112,
        logs: [[]],
        nextIndex: 1024,
        knownRoot: true,
        knownRoots: (root) => root.toLowerCase() === realRoot,
        blockHashes: realHash,
      });
    let fetched = 0;
    const again = new PoolHistory({
      ...base,
      rpc: knowing().rpc,
      secondOpinion: knowing().rpc,
      tree: fakeTrees().client,
      store,
      fetchSnapshot: async () => {
        fetched++;
        return snap;
      },
    });
    expect(await again.ensure()).toMatchObject({ kind: "ready", verified: true, leaves: 1024 });
    expect(fetched, "dropped once for what is served").toBe(1);
    expect((await store.read("eth-100"))!.state.verified).toBe(true);
  });

  it("a build with no endpoint says its history is not synced, never 'synced, not verified' (the critique of C11-12)", async () => {
    const { prover } = fakeProver();
    const services = createServices({
      config: configFromEnv({}),
      prover: async () => prover,
      historyStore: memoryHistoryStore(),
      jobs: memoryJobsStore(),
      fetchSnapshot: async () => snap,
      curated: [],
    });
    expect(await services.histories.get("eth-100")!.ensure()).toMatchObject({ kind: "ready", verified: false, reason: "no RPC endpoint is configured" });
    expect((await sourceOf(services).availability("eth-100")).history).toEqual({ state: "warn", text: "availability.historyUnverified" });
  });
});

/** A prover worker that keeps its trees as the real one does: per worker — a fresh one has none — and cleared by its close. */
class TreeWorker implements WorkerLike {
  trees = new Map<string, MerkleTree>();
  sent: string[] = [];
  held: ProverRequest[] = [];
  onmessage: ((e: { data: ProverEvent }) => void) | null = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  constructor(private readonly holdBuilds: boolean) {}
  postMessage(m: ProverRequest) {
    this.sent.push(m.kind);
    if (m.kind === "tree:build" && this.holdBuilds) return void this.held.push(m);
    setTimeout(() => this.answer(m), 0);
  }
  release() {
    for (const m of this.held.splice(0)) this.answer(m);
  }
  private answer(m: ProverRequest) {
    const result = (t: MerkleTree, pool: string) => ({ pool, leaves: t.size, root: toHex32(t.root) });
    const done = (r: unknown) => this.onmessage?.({ data: { id: m.id, kind: "done", result: r } as ProverEvent });
    const fail = (message: string) => this.onmessage?.({ data: { id: m.id, kind: "error", message } });
    if (m.kind === "close") {
      this.trees.clear();
      return done({ closed: true });
    }
    if (m.kind === "tree:build" || m.kind === "tree:load") {
      const t =
        m.kind === "tree:build" ? MerkleTree.fromLeaves(m.leaves.map((h) => BigInt(h))) : MerkleTree.fromLayers(m.layers.map((l) => l.map((h) => BigInt(h))));
      this.trees.set(m.pool, t);
      return done(result(t, m.pool));
    }
    if (m.kind === "tree:append" || m.kind === "tree:layers") {
      const t = this.trees.get(m.pool);
      if (!t) return fail(`no tree for ${m.pool} is loaded`);
      if (m.kind === "tree:layers") return done({ pool: m.pool, layers: t.toLayers().map((l) => l.map(toHex32)) });
      for (const l of m.leaves) t.insert(BigInt(l));
      return done(result(t, m.pool));
    }
    return fail(`not scripted: ${m.kind}`);
  }
  terminate() {}
}

describe("a history across a prover worker a close retired (the eleventh review round's critique of C11-6 and C11-2)", () => {
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  const withWorkers = () => {
    const workers: TreeWorker[] = [];
    const client = new ProverClient({
      artifactBase: "/classic/artifacts",
      createWorker: () => {
        const w = new TreeWorker(workers.length === 0); // the first worker's builds wait to be released
        workers.push(w);
        return w;
      },
    });
    return { workers, client };
  };

  it("a close while a first load's build is pending: the build is answered, the worker ends, and the history builds its tree again in the fresh worker — ready, never 'no tree loaded'", async () => {
    const { workers, client } = withWorkers();
    const h = new PoolHistory({
      ...base,
      rpc: honestChain({ logs: [[depositLog(POOL_100, 1024, 555n, TO + 30)]], nextIndex: 1025 }).rpc,
      tree: client,
      store: memoryHistoryStore(),
    });
    const running = h.ensure();
    await until(() => workers[0]?.held.length === 1);
    client.close(); // a withdrawal's flow ends meanwhile
    workers[0].release();
    expect(await running).toMatchObject({ kind: "ready", verified: true, leaves: 1025 });
    expect(workers[0].sent).toEqual(["tree:build", "close"]);
    expect(workers[1].sent, "the delta's append, the tree built again from the deposits held, the append, the layers persisted").toEqual([
      "tree:append",
      "tree:build",
      "tree:append",
      "tree:layers",
    ]);
  }, 60_000);

  it("a ready history synced again after the worker was retired, with nothing new on chain, loads its device copy into the fresh worker and persists — it had failed at persist", async () => {
    const { workers, client } = withWorkers();
    const chain = honestChain();
    const h = new PoolHistory({ ...base, rpc: chain.rpc, tree: client, store: memoryHistoryStore() });
    const running = h.ensure();
    await until(() => workers[0]?.held.length === 1);
    workers[0].release();
    expect(await running).toMatchObject({ kind: "ready", verified: true });
    client.close(); // a withdrawal ends: nothing pending, the worker ends at once
    chain.options.head += 20;
    expect(await h.refresh()).toMatchObject({ kind: "ready", verified: true, leaves: 1024 });
    expect(workers[1].sent, "the copy loaded, never built again").toEqual(["tree:layers", "tree:load", "tree:layers"]);
  }, 60_000);

  it("a device copy with the same count but other leaves is not this history's: a tree lost at persist is built from the deposits held", async () => {
    const head = TO + 112;
    const store = memoryHistoryStore();
    const first = new PoolHistory({
      ...base,
      rpc: honestChain({ head, logs: [[depositLog(POOL_100, 1024, 555n, TO + 30)]], nextIndex: 1025 }).rpc,
      tree: fakeTrees().client,
      store,
    });
    expect(await first.ensure()).toMatchObject({ kind: "ready", leaves: 1025 });
    // the block the first sync ended at has another hash now: its deposit is gone, another took its place later
    const changed = scriptedChain({
      head: head + 50,
      logs: [[depositLog(POOL_100, 1024, 777n, TO + 60)]],
      nextIndex: 1025,
      knownRoot: true,
      blockHashes: { ...realHash, [head - 12]: hex32(424242n) },
    });
    const trees = fakeTrees();
    let lost = true;
    const client = {
      ...trees.client,
      layersOf: async (pool: string) => {
        if (lost) {
          lost = false;
          throw new Error(`no tree for ${pool} is loaded`);
        }
        return trees.client.layersOf(pool);
      },
    };
    const again = new PoolHistory({ ...base, rpc: changed.rpc, tree: client, store });
    expect(await again.ensure()).toMatchObject({ kind: "ready", verified: true, leaves: 1025 });
    expect((await store.read("eth-100"))!.layers[0].at(-1), "the layers persisted are the deposits held").toBe(hex32(777n));
    expect(trees.calls.slice(-2), "the stale copy loaded, refused for its root, the tree built").toEqual(["load", "build"]);
  });

  it("a copy from before C11-2 whose tree the worker lost mid-run is built from its leaves, never loaded from its own layers", async () => {
    const store = memoryHistoryStore();
    await new PoolHistory({ ...base, rpc: honestChain().rpc, tree: fakeTrees().client, store }).ensure();
    const stored = (await store.read("eth-100"))!;
    const unmarked = { ...stored.state };
    delete unmarked.hashed;
    await store.write("eth-100", { ...stored, state: unmarked });
    const trees = fakeTrees();
    let lost = true;
    const client = {
      ...trees.client,
      appendLeaves: async (pool: string, leaves: string[]) => {
        if (lost) {
          lost = false;
          throw new Error(`no tree for ${pool} is loaded`);
        }
        return trees.client.appendLeaves(pool, leaves);
      },
    };
    const again = new PoolHistory({
      ...base,
      rpc: honestChain({ head: TO + 162, logs: [[depositLog(POOL_100, 1024, 555n, TO + 130)]], nextIndex: 1025 }).rpc,
      tree: client,
      store,
    });
    expect(await again.ensure()).toMatchObject({ kind: "ready", verified: true, leaves: 1025 });
    expect(trees.calls, "built from its leaves at the start and again after the loss").toEqual(["build", "build", "append"]);
  });
});
