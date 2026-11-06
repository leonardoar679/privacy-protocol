// The eleventh review round's critique of its own C11-9 and C11-12 fixes (2026-11-05), over a build's real services: VITE_CLASSIC_RPC_URLS
// names two endpoints, createServices makes the failing-over transport, the first endpoint alone and the second itself, and fetch is
// stubbed per URL. With a second endpoint, a withdrawal's reads that name the note or the proof's root go to the first endpoint alone — one
// that does not answer refuses, nothing is sent, the second hears nothing; a relayed withdrawal whose root aged out is refused, never proved
// again on a refresh it made itself; in wallet mode a lying first endpoint cannot have a root of its own sent: the refresh asks both.
import { readFileSync } from "node:fs";
import { keccak256 } from "js-sha3";
import { afterEach, describe, expect, it } from "vitest";
import { withdrawalFlow } from "../src/app/services/flows";
import { STALE_MS } from "../src/app/services/history";
import { createServices, sourceOf } from "../src/app/services/source";
import { WalletSession } from "../src/app/services/wallet";
import { configFromEnv } from "../src/config";
import type { DepositEvent } from "../src/history/events";
import { SELECTORS as VIEW } from "../src/history/verify";
import { feeLines } from "../src/model/fees";
import { generateNote } from "../src/model/notes";
import { DEPLOYMENT, poolOf } from "../src/model/pools";
import { memoryHistoryStore, memoryJobsStore } from "../src/storage/historyDb";
import { depositLog, fakeProver, fakeRelayerTransport, fakeWalletProvider, fixtureSnapshot, POOL_100, scriptedChain, word } from "./helpers/fakes";
import status from "./fixtures/relayers/status.json";

const ROUTER = "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b" as const;
const ACCOUNT = "0x75b9758bba5671c1e71c533a3fa5557f85126c3e" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const snap = fixtureSnapshot();
const deposits = JSON.parse(snap.texts["deposits.json"]) as DepositEvent[];
const seeded = (seed: number) => {
  let x = seed >>> 0;
  return (n: number) =>
    Uint8Array.from({ length: n }, () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x >>> 24;
    });
};
/** a note of the 100 ETH pool whose commitment the fake prover maps to the fixture's sixth deposit */
const NOTE = generateNote("eth", "100", 1, seeded(99));
const FEE = feeLines(poolOf("eth-100"), { feePercentE4: 4000 }, 12_000_000_000n).totalFeeWei;
const POOL_CODE = (
  JSON.parse(readFileSync(new URL("../contracts/verified/pool-eth-1.json", import.meta.url), "utf8")) as { runtimeBytecode: { onchainBytecode: string } }
).runtimeBytecode.onchainBytecode;
const sel = (signature: string) => "0x" + keccak256(signature).slice(0, 8);
const PIN = DEPLOYMENT.pools["eth-100"];
const PIN_CALLS: Record<string, string> = {
  [sel("verifier()")]: `0x${PIN.verifier.slice(2).padStart(64, "0")}`,
  [sel("levels()")]: `0x${word(PIN.levels)}`,
  [sel("denomination()")]: `0x${word(BigInt(PIN.denominationWei))}`,
  [sel("instances(address)")]: `0x${word(0)}${word(0)}${word(1)}${word(0)}${word(30)}`,
};
const chainOf = () =>
  scriptedChain({
    head: snap.manifest.toBlock + 200,
    logs: [[]],
    nextIndex: 1024,
    knownRoot: true,
    code: POOL_CODE,
    calls: PIN_CALLS,
    blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
  });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  ROUTES.clear();
});

type Fail = (method: string, data: string | undefined, params: unknown[]) => boolean;

/** Each page's endpoints by host: two pages built side by side answer from their own chains (the critique: another tab). */
const ROUTES = new Map<string, { chain: ReturnType<typeof chainOf>; fail?: Fail }>();
const route = (async (url: string, init: { body: string }) => {
  const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
  const { chain, fail } = ROUTES.get(new URL(String(url)).host)!;
  const data = req.method === "eth_call" ? (req.params[0] as { data: string }).data : undefined;
  try {
    // the scripted chain answers first (its getLastRoot follows the last isKnownRoot asked), then a 429 replaces the first endpoint's answer
    // when asked to
    const result = await chain.rpc(req.method, req.params);
    if (fail?.(req.method, data, req.params)) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: String(e) } }), { status: 200 });
  }
}) as unknown as typeof fetch;

/** A build with VITE_CLASSIC_RPC_URLS=A,B: createServices makes its transport, its first endpoint alone and its second (makeRpc over fetch). */
async function build(
  o: {
    failA?: Fail;
    urls?: string;
    jobStates?: string[];
    /** another page over the same device: its stores */
    stores?: { history: ReturnType<typeof memoryHistoryStore>; jobs: ReturnType<typeof memoryJobsStore> };
    now?: () => number;
    /** the relayer takes the job, its answer lost on the way back */
    postLost?: boolean;
    /** the hosts of its two endpoints: another page beside this one has its own */
    hosts?: [string, string];
  } = {},
) {
  const A = chainOf();
  const B = chainOf();
  const [hostA, hostB] = o.hosts ?? ["a.example", "b.example"];
  ROUTES.set(hostA, { chain: A, fail: o.failA });
  ROUTES.set(hostB, { chain: B });
  globalThis.fetch = route;
  const config = configFromEnv({
    VITE_CLASSIC_LIVE: JSON.stringify({ "eth-100": ["withdraw"] }),
    VITE_CLASSIC_RPC_URLS: o.urls ?? `https://${hostA},https://${hostB}`,
  });
  const transport = fakeRelayerTransport(status.v4.body, o.jobStates);
  if (o.postLost) {
    const post = transport.postJson.bind(transport);
    transport.postJson = async (url, body) => {
      await post(url, body);
      throw new Error("The operation was aborted");
    };
  }
  const stores = o.stores ?? { history: memoryHistoryStore(), jobs: memoryJobsStore() };
  // the pool reports the note spent once the relayer has the job (the tenth review round, C10-3)
  A.options.spent = B.options.spent = () => transport.posted.length > 0;
  const { prover } = fakeProver({ commitmentFor: () => deposits[5].commitment });
  const provider = fakeWalletProvider(ACCOUNT, 1);
  const wallet = new WalletSession({ router: ROUTER, discover: async () => [{ info: { id: "fake", name: "Fake Wallet" }, provider }] });
  await wallet.discover();
  await wallet.connect("fake");
  const curated = [
    {
      ensName: "to-relayer.eth",
      relayerAddress: status.v4.body.rewardAccount.toLowerCase(),
      url: "https://eth.to-relayer.com",
      rewardAccount: status.v4.body.rewardAccount,
      stakeTorn: "4821",
      feePercent: 0.4,
      version: "4.1.6",
      currentQueue: 0,
    },
  ];
  const services = createServices({
    config,
    prover: async () => prover,
    historyStore: stores.history,
    jobs: stores.jobs,
    fetchSnapshot: async () => snap,
    relayerTransport: transport,
    curated,
    wallet,
    now: o.now ?? (() => 1_700_000_000_000),
    followOptions: { intervalMs: 1, sleep: async () => undefined },
    receiptOptions: { pollMs: 1, maxMs: 20, sleep: async () => undefined },
  });
  await services.relayers.refresh();
  expect(await services.histories.get("eth-100")!.ensure()).toMatchObject({ kind: "ready", verified: true });
  const lookup = await sourceOf(services).lookup(NOTE);
  if (lookup.kind !== "found") throw new Error(`the note was not found: ${lookup.kind}`);
  return { A, B, services, transport, provider, prover, stores, facts: lookup.facts };
}

const calls = (seen: { method: string; params: unknown[] }[], selector: string) =>
  seen.filter((c) => c.method === "eth_call" && (c.params[0] as { data: string }).data.startsWith(selector));

const relayed = (s: Awaited<ReturnType<typeof build>>, confirm: () => Promise<boolean>) =>
  withdrawalFlow(s.services, {
    pool: "eth-100",
    note: NOTE,
    facts: s.facts,
    recipient: RECIPIENT,
    via: "relayer",
    relayerId: "to-relayer.eth",
    feeWei: FEE,
    confirm,
  });

describe("a withdrawal's reads with two endpoints configured (the eleventh review round's critique of C11-9 and C11-12)", () => {
  it("both answering: the relayed withdrawal completes, and the second endpoint hears nothing between the confirmation and the submission", async () => {
    const s = await build();
    let mark = -1;
    const job = await relayed(s, async () => {
      mark = s.B.seen.length;
      return true;
    });
    expect(job.state, job.failedReason ?? "").toBe("COMPLETED");
    expect(s.B.seen.slice(mark)).toEqual([]);
    expect(calls(s.A.seen, VIEW.isSpent).length, "the first endpoint alone was asked the spent bit").toBeGreaterThan(0);
  });

  it("a first endpoint that does not answer the root read after the confirmation refuses — nothing is sent, and the failover never names the proof's root to the second", async () => {
    let afterConfirm = false;
    const s = await build({ failA: (m, data) => afterConfirm && m === "eth_call" && !!data?.startsWith(VIEW.isKnownRoot) });
    let mark = -1;
    const job = await relayed(s, async () => {
      afterConfirm = true;
      mark = s.B.seen.length;
      return true;
    });
    expect(job).toMatchObject({
      state: "FAILED",
      failedReason: "the first RPC endpoint did not answer whether the proof's root is known: nothing is sent; try again later",
      failedKey: "refusal.firstSilentRoot",
    });
    expect(s.transport.posted).toEqual([]);
    expect(s.B.seen.slice(mark), "the second endpoint asked nothing").toEqual([]);
  });

  it("a first endpoint that does not answer the spent read refuses — nothing is sent, and the second is never told the nullifier hash", async () => {
    let afterConfirm = false;
    const s = await build({ failA: (m, data) => afterConfirm && m === "eth_call" && !!data?.startsWith(VIEW.isSpent) });
    const job = await relayed(s, async () => {
      afterConfirm = true;
      return true;
    });
    expect(job).toMatchObject({
      state: "FAILED",
      failedReason: "the first RPC endpoint did not answer whether this note is spent: nothing is sent; try again later",
      failedKey: "refusal.firstSilentSpent",
    });
    expect(s.transport.posted).toEqual([]);
    expect(calls(s.B.seen, VIEW.isSpent)).toEqual([]);
  });

  it("a root aged out during the confirmation refuses a relayed withdrawal — the second endpoint hears nothing, not even through the failover", async () => {
    let afterConfirm = false;
    const s = await build({ failA: (m, data, params) => afterConfirm && m === "eth_call" && !!data?.startsWith(VIEW.isKnownRoot) && params[1] !== "latest" });
    const oldRoot = s.services.histories.get("eth-100")!.currentRoot()!.toLowerCase();
    let mark = -1;
    const job = await relayed(s, async () => {
      for (const c of [s.A, s.B]) {
        c.options.head = snap.manifest.toBlock + 300;
        c.options.logs = [[depositLog(POOL_100, 1024, 777_777n, snap.manifest.toBlock + 250)]];
        c.options.nextIndex = 1025;
        c.options.knownRoots = (root) => root.toLowerCase() !== oldRoot;
      }
      afterConfirm = true;
      mark = s.B.seen.length;
      return true;
    });
    expect(job).toMatchObject({
      state: "FAILED",
      failedReason: "the pool's last hundred roots moved on during the withdrawal: nothing is sent; start the withdrawal again",
    });
    expect(s.transport.posted).toEqual([]);
    expect(s.B.seen.slice(mark)).toEqual([]);
  });

  it("wallet mode: a lying first endpoint that calls the proof's root unknown and serves a deposit of its own cannot have the wallet send — the refresh asks the second, which does not agree", async () => {
    const s = await build();
    const h = s.services.histories.get("eth-100")!;
    const R0 = h.currentRoot()!.toLowerCase();
    s.A.options.knownRoots = (root) => root.toLowerCase() !== R0;
    s.A.options.head = snap.manifest.toBlock + 300;
    s.A.options.logs = [[depositLog(POOL_100, 1024, 123_456_789n, snap.manifest.toBlock + 250)]];
    s.A.options.nextIndex = 1025;
    s.B.options.knownRoots = (root) => root.toLowerCase() === R0;
    s.B.options.head = snap.manifest.toBlock + 300;
    const job = await withdrawalFlow(s.services, {
      pool: "eth-100",
      note: NOTE,
      facts: s.facts,
      recipient: RECIPIENT,
      via: "wallet",
      confirm: async () => true,
    });
    expect(job).toMatchObject({ state: "FAILED", failedReason: "the history is not verified" });
    expect(s.provider.sent, "the wallet was asked to send nothing").toEqual([]);
    expect(h.status).toMatchObject({ kind: "ready", verified: false });
    expect(h.state?.verified, "never stored as verified").toBeUndefined();
  });

  it("the reads after the relayer's answer go to the first endpoint alone too: its silence after a CONFIRMED keeps the record confirming, after a FAILED keeps it open — the second is never told the nullifier hash (the critique)", async () => {
    let posted = () => false;
    const failSpentAfterPost: Fail = (m, data) => posted() && m === "eth_call" && !!data?.startsWith(VIEW.isSpent);
    const confirmed = await build({ failA: (m, data, p) => failSpentAfterPost(m, data, p) });
    posted = () => confirmed.transport.posted.length > 0;
    const a = await relayed(confirmed, async () => true);
    expect(a.state, "the relayer's CONFIRMED is its report until the pool says the note is spent").toBe("SOURCE_CONFIRMING");
    expect(a.spentUnread, "the pool not asked: the words say so").toBe(true);
    expect(calls(confirmed.B.seen, VIEW.isSpent)).toEqual([]);
    const failed = await build({ failA: (m, data, p) => failSpentAfterPost(m, data, p), jobStates: ["QUEUED", "FAILED"] });
    posted = () => failed.transport.posted.length > 0;
    const b = await relayed(failed, async () => true);
    expect(b).toMatchObject({ state: "RECOVERY_REQUIRED", relayerState: "FAILED", spentUnread: true });
    expect(b.noteDigest, "kept: the note's event can still settle it").toBeDefined();
    expect(calls(failed.B.seen, VIEW.isSpent)).toEqual([]);
  });

  it("a relayer's FAILED for a note the pool reports unspent ends the record FAILED, its digest dropped (the critique: the ordinary case)", async () => {
    const s = await build({ jobStates: ["QUEUED", "FAILED"] });
    s.A.options.spent = s.B.options.spent = false;
    const job = await relayed(s, async () => true);
    expect(job).toMatchObject({ state: "FAILED", relayerState: "FAILED" });
    expect(job.noteDigest).toBeUndefined();
    expect(job.spentUnread).toBeUndefined();
    expect((await sourceOf(s.services).history())[0].status).toBe("FAILED");
  });

  it("a relayed withdrawal that throws releases its pool's history: the next refresh asks both endpoints (the critique)", async () => {
    const s = await build();
    await expect(
      withdrawalFlow(s.services, {
        pool: "eth-100",
        note: NOTE,
        facts: s.facts,
        recipient: RECIPIENT,
        via: "relayer",
        relayerId: "to-relayer.eth",
        feeWei: 1n,
        confirm: async () => true,
      }),
    ).rejects.toThrow(/below the relayer's minimum/);
    const asked = s.B.seen.length;
    s.A.options.head += 20;
    s.B.options.head += 20;
    await s.services.histories.get("eth-100")!.refresh();
    expect(s.B.seen.length).toBeGreaterThan(asked);
  });

  it("the history's root is checked before a proof is made on it: one the pool no longer knows refuses a relayed withdrawal at once, nothing proved (the critique)", async () => {
    const s = await build();
    const R0 = s.services.histories.get("eth-100")!.currentRoot()!.toLowerCase();
    // the page stayed open for hours: the pool's last hundred roots moved on, both endpoints say so
    s.A.options.knownRoots = s.B.options.knownRoots = (root) => root.toLowerCase() !== R0;
    const bAsked = s.B.seen.length;
    const job = await relayed(s, async () => true);
    expect(job).toMatchObject({
      state: "FAILED",
      failedReason: "the pool's last hundred roots moved on since the history was last synced: nothing is sent; start the withdrawal again",
      failedKey: "refusal.rootsMovedSince",
    });
    expect(s.prover.proofs, "no proof made").toEqual([]);
    expect(s.B.seen.length, "the second endpoint asked nothing").toBe(bAsked);
    expect(s.services.histories.get("eth-100")!.needsSync()).toBe(true);
  });

  it("an unsettled withdrawal's hold carries over a reload: the new page asks the second endpoint nothing until it ends, then syncs (the critique)", async () => {
    let t = 1_700_000_000_000;
    const now = () => t;
    const s = await build({ postLost: true, now });
    expect((await relayed(s, async () => true)).state).toBe("RECOVERY_REQUIRED");
    t += 60_000;
    const page = await build({ stores: s.stores, now }); // a reload: new services over the device's stores
    expect(calls(page.B.seen, VIEW.isKnownRoot), "the reloaded page asked the second endpoint nothing").toEqual([]);
    expect(page.services.histories.get("eth-100")!.isHeld()).toBe(true);
    t += 15 * 60_000;
    await page.services.histories.get("eth-100")!.ensure();
    expect(calls(page.B.seen, VIEW.isKnownRoot).length, "past the hold: synced, both asked").toBeGreaterThan(0);
  });

  it("a settled relayed withdrawal holds nothing on the next page: it syncs at once, both endpoints asked (the critique)", async () => {
    const s = await build();
    expect((await relayed(s, async () => true)).state).toBe("COMPLETED");
    const page = await build({ stores: s.stores });
    expect(page.services.histories.get("eth-100")!.isHeld()).toBe(false);
    expect(calls(page.B.seen, VIEW.isKnownRoot).length, "synced at once, the second endpoint asked").toBeGreaterThan(0);
  });

  it("a page already open when another starts a relayed withdrawal asks the second endpoint nothing while it runs, and syncs once it has settled (the critique)", async () => {
    let t = 1_700_000_000_000;
    const now = () => t;
    const s = await build({ now });
    const open = await build({ stores: s.stores, now, hosts: ["a2.example", "b2.example"] }); // another tab, open before the withdrawal
    const history = open.services.histories.get("eth-100")!;
    let during = -1;
    const job = await relayed(s, async () => {
      t += STALE_MS + 1_000;
      const mark = open.B.seen.length;
      await history.ensure();
      during = calls(open.B.seen.slice(mark), VIEW.isKnownRoot).length;
      return true;
    });
    expect(job.state).toBe("COMPLETED");
    expect(during, "the open page asked the second endpoint nothing while the withdrawal ran").toBe(0);
    t += STALE_MS + 1_000;
    const mark = open.B.seen.length;
    await history.ensure();
    expect(calls(open.B.seen.slice(mark), VIEW.isKnownRoot).length, "settled: synced, both asked").toBeGreaterThan(0);
  });

  it("a relayed withdrawal whose page closed during its submission holds the page opened after it (the critique)", async () => {
    const s = await build();
    const now = s.services.now();
    await s.stores.jobs.put({
      id: "jz",
      kind: "withdrawal",
      pool: "eth-100",
      state: "SUBMITTING",
      createdAt: now,
      updatedAt: now,
      via: "relayer",
      relayerUrl: "https://eth.to-relayer.com",
    });
    const page = await build({ stores: s.stores });
    expect(calls(page.B.seen, VIEW.isKnownRoot), "the second endpoint asked nothing").toEqual([]);
    expect(page.services.histories.get("eth-100")!.isHeld()).toBe(true);
  });

  it("before the proof, an endpoint that does not answer whether the history's root is still known refuses in its own words, nothing proved (the critique)", async () => {
    let armed = false;
    const fail: Fail = (m, data) => armed && m === "eth_call" && !!data?.startsWith(VIEW.isKnownRoot);
    for (const [urls, key, words] of [
      [undefined, "refusal.firstSilentHistoryRoot", "the first RPC endpoint did not answer whether the history's root is still known"],
      ["https://a.example", "refusal.rpcSilentHistoryRoot", "the RPC endpoint did not answer whether the history's root is still known"],
    ] as const) {
      armed = false;
      const s = await build({ failA: fail, ...(urls ? { urls } : {}) });
      armed = true;
      const job = await relayed(s, async () => true);
      expect(job).toMatchObject({ state: "FAILED", failedKey: key });
      expect(job.failedReason).toContain(words);
      expect(s.prover.proofs, "nothing proved").toEqual([]);
      expect(s.transport.posted, "nothing sent").toEqual([]);
    }
  });

  it("a relayed job no longer followed keeps its pool held too; one whose relayer ended FAILED does not (the critique)", async () => {
    const stalled = await build({ jobStates: ["QUEUED"] });
    const get = stalled.transport.getJson.bind(stalled.transport);
    let polls = 0;
    stalled.transport.getJson = async (url: string) => (url.includes("/v1/jobs/") && ++polls > 1 ? { status: 502, body: null } : get(url));
    expect(await relayed(stalled, async () => true)).toMatchObject({ state: "RECOVERY_REQUIRED", relayerState: "QUEUED" });
    expect(stalled.services.histories.get("eth-100")!.isHeld()).toBe(true);
    const failed = await build({ jobStates: ["QUEUED", "FAILED"] });
    failed.A.options.spent = failed.B.options.spent = false;
    expect((await relayed(failed, async () => true)).state).toBe("FAILED");
    expect(failed.services.histories.get("eth-100")!.isHeld()).toBe(false);
  });

  it("during a hold, a wallet-mode withdrawal whose history's root aged out is refused before any proof, never proved twice on the same root (the critique)", async () => {
    const s = await build({ postLost: true });
    expect((await relayed(s, async () => true)).state).toBe("RECOVERY_REQUIRED");
    const R0 = s.services.histories.get("eth-100")!.currentRoot()!.toLowerCase();
    s.A.options.knownRoots = s.B.options.knownRoots = (root) => root.toLowerCase() !== R0;
    const proofs = s.prover.proofs.length;
    const job = await withdrawalFlow(s.services, {
      pool: "eth-100",
      note: NOTE,
      facts: s.facts,
      recipient: RECIPIENT,
      via: "wallet",
      confirm: async () => true,
    });
    expect(job).toMatchObject({ state: "FAILED", failedKey: "refusal.historyHeld" });
    expect(s.prover.proofs.length, "no proof made").toBe(proofs);
    expect(s.provider.sent).toEqual([]);
  });

  it("with one endpoint, its silence is said as the endpoint's, not 'the first' one's (the critique)", async () => {
    let afterConfirm = false;
    const spent = await build({ urls: "https://a.example", failA: (m, data) => afterConfirm && m === "eth_call" && !!data?.startsWith(VIEW.isSpent) });
    expect(spent.services.secondOpinion).toBeNull();
    expect(
      await relayed(spent, async () => {
        afterConfirm = true;
        return true;
      }),
    ).toMatchObject({
      state: "FAILED",
      failedReason: "the RPC endpoint did not answer whether this note is spent: nothing is sent; try again later",
      failedKey: "refusal.rpcSilentSpent",
    });
    afterConfirm = false;
    const root = await build({ urls: "https://a.example", failA: (m, data) => afterConfirm && m === "eth_call" && !!data?.startsWith(VIEW.isKnownRoot) });
    expect(
      await relayed(root, async () => {
        afterConfirm = true;
        return true;
      }),
    ).toMatchObject({
      state: "FAILED",
      failedReason: "the RPC endpoint did not answer whether the proof's root is known: nothing is sent; try again later",
      failedKey: "refusal.rpcSilentRoot",
    });
    expect(spent.transport.posted).toEqual([]);
    expect(root.transport.posted).toEqual([]);
  });
});
