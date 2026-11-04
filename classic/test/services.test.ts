// The app's services over scripted pieces (spec v3.0 §7.4–§7.7; V7 Stage 9): a pool's history from the served snapshot,
// the chain's delta and the one check, persisted and reloaded from the device, built from the deployed block when nothing
// is served, refused when the snapshot does not hold or its block is not the chain's, rolled back when a checkpoint
// fell; the relayer directory's statuses and rules; the operation adapter's machines; the availability rows and what they
// allow; the contract and router facts; the gas price; the compliance switches' pieces.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "js-sha3";
import { describe, expect, it } from "vitest";
import { checkPoolContract, routerInstanceState } from "../src/app/services/contract";
import { gasPriceWei } from "../src/app/services/gas";
import { geofenceAnswer, isSanctioned, SANCTIONS_ORACLE } from "../src/app/services/compliance";
import { PoolHistory } from "../src/app/services/history";
import { canMove, fromRelayerState, move, newJob, OPERATION_STATES, toHistoryRow } from "../src/app/services/operations";
import { RelayerDirectory } from "../src/app/services/relayers";
import { configuredRelayers } from "../src/app/services/source";
import { configFromEnv } from "../src/config";
import { DEPLOYMENT, poolOf } from "../src/model/pools";
import { sha256Hex } from "../src/crypto/digest";
import type { DepositEvent } from "../src/history/events";
import { SELECTORS } from "../src/history/verify";
import { availabilityOf, canDeposit, canWithdraw, type AvailabilityFacts } from "../src/model/availability";
import type { RelayerAnswer, RelayerTransport } from "../src/relayer/client";
import { memoryHistoryStore } from "../src/storage/historyDb";
import { depositLog, fakeTrees, fixtureSnapshot, hex32, POOL_100, scriptedChain, word } from "./helpers/fakes";
import status from "./fixtures/relayers/status.json";

const DEPLOYED = 9_161_895;
const sel = (signature: string) => "0x" + keccak256(signature).slice(0, 8);
const snap = fixtureSnapshot();
const deposits = JSON.parse(snap.texts["deposits.json"]) as DepositEvent[];
const TO_BLOCK = snap.manifest.toBlock;
const realHash = { [TO_BLOCK]: snap.manifest.blockHash! };

const history = (over: Partial<ConstructorParameters<typeof PoolHistory>[0]> & { rpc: ConstructorParameters<typeof PoolHistory>[0]["rpc"] }) => {
  const trees = fakeTrees();
  const store = over.store ?? memoryHistoryStore();
  const statuses: string[] = [];
  const h = new PoolHistory({
    pool: "eth-100",
    address: POOL_100,
    deployedBlock: DEPLOYED,
    tree: trees.client,
    store,
    fetchSnapshot: async () => snap,
    now: () => 1_700_000_000_000,
    onStatus: (s) => statuses.push(s.kind === "loading" ? `loading:${s.step}` : s.kind),
    ...over,
  });
  return { h, trees, store, statuses };
};

describe("a pool's history", () => {
  it("a ready history answers at once; older than staleMs it syncs again when asked, and settled() waits for a run (Stage 10)", async () => {
    let t = 1_700_000_000_000;
    const chain = scriptedChain({ head: TO_BLOCK + 12 + 100, logs: [[]], nextIndex: 1024, knownRoot: true, blockHashes: realHash });
    const { h, statuses } = history({ rpc: chain.rpc, now: () => t, staleMs: 30_000 });
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    const logCalls = () => chain.seen.filter((c) => c.method === "eth_getLogs").length;
    const after = logCalls();
    await h.ensure();
    expect(logCalls()).toBe(after); // fresh: no sync
    t += 31_000;
    chain.options.head += 100; // the chain moved on meanwhile
    const pending = h.ensure(); // stale: syncs again, one more window
    await h.settled();
    expect(await pending).toMatchObject({ kind: "ready", verified: true });
    expect(logCalls()).toBe(after + 1);
    expect(statuses.filter((s) => s === "loading:sync").length).toBeGreaterThanOrEqual(2); // the first run and the stale one (each window reports too)
    await h.settled(); // nothing running: resolves at once
  });

  it("loads the served snapshot, appends the chain's delta, is verified by the chain, is persisted; a second history reads the device's copy without a fetch", async () => {
    const head = TO_BLOCK + 12 + 100;
    const chain = scriptedChain({
      head,
      logs: [[depositLog(POOL_100, 1024, 555n, TO_BLOCK + 30), depositLog(POOL_100, 1025, 556n, TO_BLOCK + 40)]],
      nextIndex: 1026,
      knownRoot: true,
      blockHashes: realHash,
    });
    const { h, trees, store, statuses } = history({ rpc: chain.rpc });
    const s = await h.ensure();
    expect(s).toMatchObject({ kind: "ready", verified: true, leaves: 1026, toBlock: head - 12 });
    expect(statuses).toEqual(["loading:stored", "loading:snapshot", "loading:tree", "loading:sync", "loading:sync", "loading:verify", "ready"]);
    expect(trees.calls).toEqual(["load", "append"]);
    expect(h.stats().deposits).toBe(1026);
    expect(h.stats().latest[0]).toEqual({ leafIndex: 1025, timestamp: 1_700_001_025 });
    expect(h.lookup(deposits[5].commitment, hex32(1n))).toMatchObject({ leafIndex: 5, depositsSince: 1020, spent: false });
    expect(h.lookup(hex32(555n), hex32(1n))?.leafIndex).toBe(1024);
    expect(h.verified).toBe(true);
    const stored = await store.read("eth-100");
    expect(stored?.state.leaves).toBe(1026);
    expect(stored?.layers.length).toBe(21);
    expect(stored?.state.checkpoints.map((c) => c.blockNumber)).toEqual([TO_BLOCK, head - 12]);
    // the second: from the device, no snapshot asked for
    const chain2 = scriptedChain({ head: head + 5, logs: [[]], nextIndex: 1026, knownRoot: true, blockHashes: realHash });
    const second = history({
      rpc: chain2.rpc,
      store,
      fetchSnapshot: async () => {
        throw new Error("the snapshot must not be fetched");
      },
    });
    const s2 = await second.h.ensure();
    expect(s2).toMatchObject({ kind: "ready", verified: true, leaves: 1026 });
    expect(second.trees.calls[0]).toBe("load");
    expect(second.statuses[0]).toBe("loading:stored");
    expect(second.statuses).not.toContain("loading:snapshot");
  });

  it("a device copy the chain refused last time is dropped at the start, and a stored copy the chain does not know now is rebuilt from what is served, once (the fourth review round, 2026-11-03)", async () => {
    const head = TO_BLOCK + 12 + 100;
    const chainFor = (knownRoots?: (root: string) => boolean) =>
      scriptedChain({ head, logs: [[]], nextIndex: 1024, knownRoot: true, ...(knownRoots ? { knownRoots } : {}), blockHashes: realHash });
    const first = history({ rpc: chainFor().rpc });
    const s1 = await first.h.ensure();
    expect(s1).toMatchObject({ kind: "ready", verified: true, leaves: 1024 });
    const store = first.store;
    const stored = (await store.read("eth-100"))!;
    // (a) refused last time: before, the copy was reloaded as it was at every start, and the device stayed refused until its site data was cleared
    await store.write("eth-100", { ...stored, state: { ...stored.state, verified: false } });
    const second = history({ rpc: chainFor().rpc, store });
    expect(await second.h.ensure()).toMatchObject({ kind: "ready", verified: true, leaves: 1024 });
    expect(second.statuses, "the snapshot was fetched: the copy was not read").toContain("loading:snapshot");
    expect((await store.read("eth-100"))?.state.verified).toBe(true);
    // (b) a copy the chain does not know now (one leaf of it is wrong): dropped during the run for the served snapshot, one rebuild
    const good = (await store.read("eth-100"))!;
    const layers = good.layers.map((l) => [...l]);
    layers[layers.length - 1][0] = hex32(424_242n); // the root itself: the device's copy is loaded from its layers, the chain knows no such root
    await store.write("eth-100", { ...good, layers });
    const realRoot = String((s1 as { root: string }).root).toLowerCase();
    let fetched = 0;
    const third = history({
      rpc: chainFor((root) => root.toLowerCase() === realRoot).rpc,
      store,
      fetchSnapshot: async () => {
        fetched++;
        return snap;
      },
    });
    expect(await third.h.ensure()).toMatchObject({ kind: "ready", verified: true, leaves: 1024 });
    expect(fetched).toBe(1);
    expect(
      third.statuses.filter((s) => s === "loading:stored"),
      "the copy read once, then the rebuild starts over",
    ).toHaveLength(2);
    expect(third.statuses.filter((s) => s === "loading:snapshot")).toHaveLength(1);
    expect((await store.read("eth-100"))?.state.verified).toBe(true);
    expect((await store.read("eth-100"))?.layers.at(-1)?.[0].toLowerCase()).toBe(realRoot);
  });

  it("a stored copy whose inner layers do not hash to its root is rebuilt from the deposits at the first path asked (the fifth review round, 2026-11-03)", async () => {
    const head = TO_BLOCK + 12 + 100;
    const first = history({ rpc: scriptedChain({ head, logs: [[]], nextIndex: 1024, knownRoot: true, blockHashes: realHash }).rpc });
    expect(await first.h.ensure()).toMatchObject({ kind: "ready", verified: true, leaves: 1024 });
    const good = (await first.store.read("eth-100"))!;
    const layers = good.layers.map((l) => [...l]);
    layers[3][1] = hex32(777_777n); // an inner node on leaf 5's path wrong under the right root word: every check passed, every proof would have failed with the note blamed
    await first.store.write("eth-100", { ...good, layers });
    const second = history({
      rpc: scriptedChain({ head: head + 5, logs: [[]], nextIndex: 1024, knownRoot: true, blockHashes: realHash }).rpc,
      store: first.store,
      fetchSnapshot: async () => {
        throw new Error("the snapshot must not be fetched");
      },
    });
    expect(await second.h.ensure(), "the copy's root is the chain's: verified").toMatchObject({ kind: "ready", verified: true });
    const path = await second.h.pathFor(5);
    expect(path.pathElements).toHaveLength(20);
    expect(second.trees.calls, "the inconsistent tree was rebuilt from the deposits").toContain("build");
    expect((await first.store.read("eth-100"))!.layers[3][1], "the stored copy is consistent again").toBe(good.layers[3][1]);
    expect(await second.h.pathFor(5), "the second ask needs no rebuild").toEqual(path);
    expect(second.trees.calls.filter((c) => c === "build")).toHaveLength(1);
  });

  it("without an endpoint: ready but unverified, saying why; the path of a leaf still answers", async () => {
    const { h } = history({ rpc: null });
    const s = await h.ensure();
    expect(s).toMatchObject({ kind: "ready", verified: false, leaves: 1024, reason: expect.stringMatching(/no RPC/) });
    expect(h.verified).toBe(false);
    const path = await h.pathFor(1023);
    expect(path.pathElements.length).toBe(20);
    expect(path.root).toBe(snap.manifest.root);
  });

  it("nothing served: the whole history from the deployed block, built and appended", async () => {
    const head = DEPLOYED + 100;
    const chain = scriptedChain({
      head,
      logs: [[depositLog(POOL_100, 0, 11n, DEPLOYED + 1), depositLog(POOL_100, 1, 12n, DEPLOYED + 2)]],
      nextIndex: 2,
      knownRoot: true,
    });
    const { h, trees } = history({ rpc: chain.rpc, fetchSnapshot: async () => null });
    const s = await h.ensure();
    expect(s).toMatchObject({ kind: "ready", verified: true, leaves: 2 });
    expect(trees.calls).toEqual(["build", "append"]);
    expect(h.stats().latest.map((l) => l.leafIndex)).toEqual([1, 0]);
  });

  it("a snapshot that does not hold, or whose block the chain does not confirm, fails; a chain that disagrees leaves the history unverified with the reason", async () => {
    const tampered = { ...snap, texts: { ...snap.texts, "deposits.json": snap.texts["deposits.json"].replace("9162622", "9162623") } };
    const bad = history({ rpc: scriptedChain({ head: TO_BLOCK + 100, nextIndex: 1024 }).rpc, fetchSnapshot: async () => tampered });
    expect(await bad.h.ensure()).toMatchObject({ kind: "failed", reason: expect.stringMatching(/does not hold/) });
    // the chain's hash of the snapshot's block is another one
    const other = history({ rpc: scriptedChain({ head: TO_BLOCK + 100, nextIndex: 1024 }).rpc });
    expect(await other.h.ensure()).toMatchObject({ kind: "failed", reason: expect.stringMatching(/not on this chain/) });
    // the review round of 2026-11-02: a chain that counts fewer deposits at the delta's block than this history holds is not
    // this history's chain — the sync fails with both counts, nothing persisted
    const fewer = history({ rpc: scriptedChain({ head: TO_BLOCK + 100, logs: [[]], nextIndex: 999, knownRoot: false, blockHashes: realHash }).rpc });
    expect(await fewer.h.ensure()).toMatchObject({
      kind: "failed",
      reason: expect.stringMatching(/counts 999 deposits at block \d+, the endpoint's logs make 1024: this history is not the chain's/),
    });
    // an endpoint whose logs come short (a capped answer with no error): asked again with halved windows, then failed — the
    // history stays at its block, nothing persisted at an advanced one
    const shortStore = memoryHistoryStore();
    const short = history({
      rpc: scriptedChain({ head: TO_BLOCK + 100, logs: [[]], nextIndex: 1030, knownRoot: true, blockHashes: realHash }).rpc,
      store: shortStore,
    });
    const chainShort = short.h;
    expect(await chainShort.ensure()).toMatchObject({
      kind: "failed",
      reason: expect.stringMatching(/the endpoint's logs make 1024: the endpoint's logs come short/),
    });
    expect(await shortStore.read("eth-100"), "nothing persisted").toBeNull();
    expect(chainShort.state?.toBlock, "the history stays at its block").toBe(TO_BLOCK);
    // the count agreeing and the root unknown to the pool: ready, unverified, with the reason
    const disagree = history({ rpc: scriptedChain({ head: TO_BLOCK + 100, logs: [[]], nextIndex: 1024, knownRoot: false, blockHashes: realHash }).rpc });
    const s = await disagree.h.ensure();
    expect(s).toMatchObject({ kind: "ready", verified: false, reason: expect.stringMatching(/does not know this history's root/) });
    expect(disagree.h.verified).toBe(false);
  });

  it("the history's own check takes the pool's last root at its block (the tenth review round, C10-5): a root of the window at the same count — a tail of ZERO_VALUE leaves hashes to the root of fewer leaves — is not this history's", async () => {
    const stale = history({
      rpc: scriptedChain({ head: TO_BLOCK + 100, logs: [[]], nextIndex: 1024, knownRoot: true, lastRoot: hex32(5n), blockHashes: realHash }).rpc,
    });
    expect(await stale.h.ensure()).toMatchObject({ kind: "ready", verified: false, reason: "the pool's root at this history's block is another one" });
    const honest = history({ rpc: scriptedChain({ head: TO_BLOCK + 100, logs: [[]], nextIndex: 1024, knownRoot: true, blockHashes: realHash }).rpc });
    expect(await honest.h.ensure()).toMatchObject({ kind: "ready", verified: true });
  });

  it("a path asked of a worker that lost its trees loads the tree again from the device's copy and answers (the review round of 2026-11-03, C2-9)", async () => {
    const head = TO_BLOCK + 12 + 100;
    const chain = scriptedChain({ head, logs: [[]], nextIndex: 1024, knownRoot: true, blockHashes: realHash });
    const trees = fakeTrees();
    let lost = true;
    const client = {
      ...trees.client,
      pathOf: async (pool: string, leaf: number) => {
        if (lost) {
          lost = false;
          throw new Error(`no tree for ${pool} is loaded`);
        }
        return trees.client.pathOf(pool, leaf);
      },
    };
    const { h, store } = history({ rpc: chain.rpc, tree: client });
    expect(await h.ensure()).toMatchObject({ kind: "ready", verified: true });
    expect(await store.read("eth-100"), "the layers are on the device").not.toBeNull();
    const path = await h.pathFor(5);
    expect(path.pathElements).toHaveLength(20);
    expect(
      trees.calls.filter((c) => c === "load"),
      "loaded once at the start, once again after the loss",
    ).toHaveLength(2);
  });
  it("a checkpoint that fell rolls the history back to the newest that stands, then syncs again", async () => {
    const head = TO_BLOCK + 12 + 100;
    const store = memoryHistoryStore();
    const first = history({
      rpc: scriptedChain({ head, logs: [[depositLog(POOL_100, 1024, 555n, TO_BLOCK + 30)]], nextIndex: 1025, knownRoot: true, blockHashes: realHash }).rpc,
      store,
    });
    expect(await first.h.ensure()).toMatchObject({ kind: "ready", leaves: 1025 });
    // the block the first sync ended at now has another hash: its deposit is gone, another took its place later
    const changed = { ...realHash, [head - 12]: hex32(424242n) };
    const chain = scriptedChain({
      head: head + 50,
      logs: [[depositLog(POOL_100, 1024, 777n, TO_BLOCK + 60)]],
      nextIndex: 1025,
      knownRoot: true,
      blockHashes: changed,
    });
    const second = history({ rpc: chain.rpc, store });
    const s = await second.h.ensure();
    expect(s).toMatchObject({ kind: "ready", verified: true, leaves: 1025 });
    expect(second.trees.calls).toEqual(["load", "truncate", "append"]);
    expect(second.h.lookup(hex32(555n), hex32(1n))).toBeNull();
    expect(second.h.lookup(hex32(777n), hex32(1n))?.leafIndex).toBe(1024);
    expect(second.h.state?.checkpoints.map((c) => c.blockNumber)).toEqual([TO_BLOCK, head + 50 - 12]);
  });
});

describe("the relayer directory", () => {
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
    {
      ensName: "gone.eth",
      relayerAddress: `0x${"22".repeat(20)}`,
      url: "https://gone.example",
      rewardAccount: `0x${"22".repeat(20)}`,
      stakeTorn: "100",
      feePercent: 0.3,
      version: "4.1.6",
      currentQueue: 0,
    },
    {
      ensName: "other-account.eth",
      relayerAddress: `0x${"33".repeat(20)}`,
      url: "https://other.example",
      rewardAccount: `0x${"33".repeat(20)}`,
      stakeTorn: "100",
      feePercent: 0.35,
      version: "4.1.6",
      currentQueue: 0,
    },
  ];
  const transport: RelayerTransport = {
    async getJson(url): Promise<RelayerAnswer> {
      if (url.startsWith("https://gone.example")) throw new Error("ECONNREFUSED");
      return { status: 200, body: status.v4.body };
    },
    async postJson() {
      return { status: 500, body: null };
    },
  };
  const pools = [
    { address: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc", amount: "0.1" },
    { address: "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936", amount: "1" },
    { address: "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf", amount: "10" },
    { address: "0xa160cdab225685da1d56aa342ad8841c3b53f291", amount: "100" },
  ];

  it("unknown until asked; then online when the status passes the rules for every pool, offline when unreachable or paying elsewhere", async () => {
    const changes: number[] = [];
    const dir = new RelayerDirectory({
      curated,
      transport,
      netId: 1,
      pools,
      onChange: (l) => changes.push(l.filter((r) => r.status !== "unknown").length),
      concurrency: 1,
    });
    expect(dir.onlineCount()).toBeNull();
    expect(dir.list().every((r) => r.status === "unknown")).toBe(true);
    expect(dir.cheapestOnline()).toBeNull();
    const list = await dir.refresh();
    expect(list.map((r) => [r.id, r.status])).toEqual([
      ["to-relayer.eth", "online"],
      ["gone.eth", "offline"],
      ["other-account.eth", "offline"],
    ]);
    expect(dir.entry("other-account.eth")?.problems).toEqual(["reward account differs"]);
    expect(dir.entry("gone.eth")?.problems).toBeNull();
    expect(dir.entry("to-relayer.eth")?.facts?.rewardAccount).toBe(status.v4.body.rewardAccount.toLowerCase());
    expect(dir.onlineCount()).toBe(1);
    expect(dir.cheapestOnline()?.id).toBe("to-relayer.eth");
    expect(changes).toEqual([1, 2, 3]);
    expect(dir.list()[0].feePercentE4).toBe(Math.round(status.v4.body.tornadoServiceFee * 10_000));
  });
});

describe("the operation adapter", () => {
  it("fifteen names; a deposit and a withdrawal move only along their machines; the relayer's states map", () => {
    expect(OPERATION_STATES.length).toBe(15);
    expect(canMove("deposit", "DRAFT", "READY_TO_REVIEW")).toBe(true);
    expect(canMove("deposit", "DRAFT", "SUBMITTING")).toBe(false);
    expect(canMove("withdrawal", "READY_TO_REVIEW", "PREPARING_PROOF")).toBe(true);
    expect(canMove("deposit", "READY_TO_REVIEW", "PREPARING_PROOF")).toBe(false);
    expect(canMove("withdrawal", "SUBMITTING", "RECOVERY_REQUIRED")).toBe(true);
    const job = newJob("j", "deposit", "eth-1", 1000);
    const moved = move(job, "READY_TO_REVIEW", 2000);
    expect(moved).toMatchObject({ state: "READY_TO_REVIEW", updatedAt: 2000, createdAt: 1000 });
    expect(() => move(job, "COMPLETED", 3000)).toThrow(/does not go/);
    expect(["QUEUED", "ACCEPTED", "SENT"].map((s) => fromRelayerState(s as "QUEUED"))).toEqual(["SUBMITTING", "SUBMITTING", "SUBMITTING"]);
    expect(fromRelayerState("MINED")).toBe("SOURCE_CONFIRMING");
    expect(fromRelayerState("CONFIRMED")).toBe("COMPLETED");
    expect(fromRelayerState("FAILED")).toBe("FAILED");
    expect(fromRelayerState("RESUBMITTED")).toBe("RECOVERY_REQUIRED");
  });

  it("a record becomes the history screen's row in the original's words, or the relayer's state", () => {
    const now = 1_700_000_000_000;
    expect(toHistoryRow({ ...newJob("d", "deposit", "eth-1", now), state: "SOURCE_CONFIRMING", txHash: hex32(1n) })).toMatchObject({
      kind: "deposit",
      status: "waiting",
      txHash: hex32(1n),
      timestamp: 1_700_000_000,
    });
    expect(toHistoryRow({ ...newJob("d", "deposit", "eth-1", now), state: "COMPLETED" }).status).toBe("deposited");
    expect(toHistoryRow({ ...newJob("d", "deposit", "eth-1", now), state: "FAILED" }).status).toBe("failed");
    expect(toHistoryRow({ ...newJob("w", "withdrawal", "eth-10", now), state: "SUBMITTING", relayerState: "SENT" }).status).toBe("SENT");
    expect(toHistoryRow({ ...newJob("w", "withdrawal", "eth-10", now), state: "COMPLETED", via: "wallet" }).status).toBe("withdrawn");
    expect(toHistoryRow({ ...newJob("w", "withdrawal", "eth-10", now), state: "CANCELLED" }).status).toBe("failed");
  });
});

describe("the availability rows and what they allow", () => {
  const all: AvailabilityFacts = {
    rpcConfigured: true,
    contract: "verified",
    router: "enabled",
    relayersOnline: 3,
    history: { kind: "ready", toBlock: 100, verified: true },
    prover: "ready",
    wallet: { status: "connected", account: "0x1", chainId: 1 },
  };

  it("every fact its own row with the catalog's key and parameters", () => {
    const a = availabilityOf("eth-1", all);
    expect(a.contract).toEqual({ state: "ok", text: "availability.contractVerified" });
    expect(a.router).toEqual({ state: "ok", text: "availability.routerEnabled" });
    expect(a.relayers).toEqual({ state: "ok", text: "availability.relayersOnline", params: { n: 3 } });
    expect(a.history).toEqual({ state: "ok", text: "availability.historySynced", params: { block: 100 } });
    expect(a.prover).toEqual({ state: "ok", text: "availability.proverReady" });
    expect(a.wallet).toEqual({ state: "ok", text: "availability.walletConnected" });
    const none = availabilityOf("eth-1", {
      rpcConfigured: false,
      contract: "unknown",
      router: "unknown",
      relayersOnline: null,
      history: { kind: "idle" },
      prover: "idle",
      wallet: null,
    });
    expect(none.contract.text).toBe("availability.noRpc");
    expect(none.relayers.text).toBe("availability.relayersUnknown");
    expect(none.history.text).toBe("availability.historyUnverified");
    expect(none.wallet).toEqual({ state: "off", text: "availability.walletNotConnected" });
    expect(availabilityOf("eth-1", { ...all, contract: "differs" }).contract).toEqual({ state: "off", text: "availability.contractDiffers" });
    expect(availabilityOf("eth-1", { ...all, router: "disabled" }).router.state).toBe("warn");
    expect(availabilityOf("eth-1", { ...all, history: { kind: "ready", toBlock: 5, verified: false } }).history).toEqual({
      state: "warn",
      text: "availability.historyUnverified",
    });
    expect(availabilityOf("eth-1", { ...all, wallet: { status: "wrong-network", account: "0x1", chainId: 5 } }).wallet.text).toBe(
      "availability.walletWrongNetwork",
    );
  });

  it("a deposit needs the chain, the verified contract and the wallet; a withdrawal the verified history and prover too, plus a relayer or the wallet", () => {
    expect(canDeposit(all)).toBe(true);
    expect(canDeposit({ ...all, contract: "unknown" })).toBe(false);
    expect(canDeposit({ ...all, wallet: { status: "wrong-network", account: "0x1", chainId: 5 } })).toBe(false);
    expect(canDeposit({ ...all, rpcConfigured: false })).toBe(false);
    expect(canWithdraw(all, "relayer")).toBe(true);
    expect(canWithdraw({ ...all, relayersOnline: 0 }, "relayer")).toBe(false);
    expect(canWithdraw({ ...all, relayersOnline: 0 }, "wallet")).toBe(true);
    expect(canWithdraw({ ...all, history: { kind: "ready", toBlock: 1, verified: false } }, "wallet")).toBe(false);
    expect(canWithdraw({ ...all, prover: "loading" }, "wallet")).toBe(false);
  });
});

describe("the relayers a build names (VITE_CLASSIC_RELAYER_URLS)", () => {
  it("are offered beside the curated list without a registry record; a curated host is not listed twice; garbage is skipped", () => {
    const config = configFromEnv({ VITE_CLASSIC_RELAYER_URLS: "http://127.0.0.1:8791/, https://eth.to-relayer.com, not a url, http://127.0.0.1:8791" });
    const curated = [
      {
        ensName: "to-relayer.eth",
        relayerAddress: "0x1",
        url: "https://eth.to-relayer.com",
        rewardAccount: "0x1",
        stakeTorn: "40",
        feePercent: 0.3,
        version: "4.1.4",
        currentQueue: 0,
      },
    ];
    expect(configuredRelayers(config, curated)).toEqual([
      {
        ensName: "127.0.0.1:8791",
        relayerAddress: "",
        url: "http://127.0.0.1:8791",
        rewardAccount: "",
        stakeTorn: "0",
        feePercent: 0,
        version: "",
        currentQueue: 0,
      },
    ]);
    expect(configuredRelayers(configFromEnv({}), curated)).toEqual([]);
  });
});

describe("the contract and router facts, the gas price, the compliance pieces", () => {
  it("the committed pin of a pool matches the Sourcify record's on-chain code through the app's own check (the bytes hashed, not the hex text — Stage 10)", async () => {
    const record = JSON.parse(readFileSync(join(__dirname, "..", "contracts", "verified", "pool-eth-1.json"), "utf8")) as {
      runtimeBytecode: { onchainBytecode: string };
    };
    const pin = DEPLOYMENT.pools["eth-1"];
    const calls = {
      [sel("verifier()")]: `0x${pin.verifier.slice(2).padStart(64, "0")}`,
      [sel("levels()")]: `0x${word(pin.levels)}`,
      [sel("denomination()")]: `0x${word(BigInt(pin.denominationWei))}`,
    };
    const chain = scriptedChain({ head: 1, code: record.runtimeBytecode.onchainBytecode, calls });
    expect(
      await checkPoolContract(chain.rpc, poolOf("eth-1"), {
        runtimeSha256: pin.runtime.sha256,
        verifier: pin.verifier,
        levels: pin.levels,
        denominationWei: pin.denominationWei,
      }),
    ).toEqual({ ok: true });
    const upper = scriptedChain({ head: 1, code: record.runtimeBytecode.onchainBytecode.toUpperCase().replace(/^0X/, "0x"), calls });
    expect(
      await checkPoolContract(upper.rpc, poolOf("eth-1"), {
        runtimeSha256: pin.runtime.sha256,
        verifier: pin.verifier,
        levels: pin.levels,
        denominationWei: pin.denominationWei,
      }),
    ).toEqual({ ok: true });
  });

  it("the pool's code hashed as the verification did, its verifier, levels and denomination; the registry's instance state", async () => {
    const code = "0x6080604052deadbeef";
    const pins = {
      runtimeSha256: await sha256Hex(Uint8Array.from(Buffer.from(code.slice(2), "hex"))), // the pins hash the code bytes (scripts/deployment.mjs)
      verifier: "0xce172ce1f20ec0b3728c9965470eaf994a03557a",
      levels: 20,
      denominationWei: "100000000000000000000",
    };
    const pool = {
      id: "eth-100" as const,
      currency: "eth" as const,
      amount: "100" as const,
      denominationWei: 10n ** 20n,
      address: POOL_100,
      deployedBlock: DEPLOYED,
    };
    const calls = {
      [sel("verifier()")]: `0x${"ce172ce1f20ec0b3728c9965470eaf994a03557a".padStart(64, "0")}`,
      [sel("levels()")]: `0x${word(20)}`,
      [sel("denomination()")]: `0x${word(10n ** 20n)}`,
    };
    const ok = await checkPoolContract(scriptedChain({ head: 1, code, calls }).rpc, pool, pins);
    expect(ok).toEqual({ ok: true });
    const bad = await checkPoolContract(
      scriptedChain({ head: 1, code: "0x60016002", calls: { ...calls, [sel("levels()")]: `0x${word(16)}` } }).rpc,
      pool,
      pins,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems).toEqual(["the pool's code is not the pinned one", "the pool has 16 levels, not 20"]);
    const registry = "0xb20c66c4de72433f3ce747b58b86830c459ca911" as const;
    const instances = (state: number) => ({ [sel("instances(address)")]: `0x${word(0)}${word(0)}${word(state)}${word(0)}${word(30)}` });
    expect(await routerInstanceState(scriptedChain({ head: 1, calls: instances(1) }).rpc, registry, POOL_100)).toBe("enabled");
    expect(await routerInstanceState(scriptedChain({ head: 1, calls: instances(2) }).rpc, registry, POOL_100)).toBe("enabled");
    expect(await routerInstanceState(scriptedChain({ head: 1, calls: instances(0) }).rpc, registry, POOL_100)).toBe("disabled");
  });

  it("the gas price is read live and refused when absurd; the sanctions call names the oracle and the address; 451 is a block", async () => {
    expect(await gasPriceWei(scriptedChain({ head: 1, gasPrice: "0x2cb417800" }).rpc)).toBe(12_000_000_000n);
    await expect(gasPriceWei(scriptedChain({ head: 1, gasPrice: "0x0" }).rpc)).rejects.toThrow(/not credible/);
    await expect(gasPriceWei(scriptedChain({ head: 1, gasPrice: `0x${(20_000n * 10n ** 9n).toString(16)}` }).rpc)).rejects.toThrow(/not credible/);
    const chain = scriptedChain({ head: 1, calls: { [sel("isSanctioned(address)")]: `0x${word(1)}` } });
    expect(await isSanctioned(chain.rpc, `0x${"ab".repeat(20)}`)).toBe(true);
    const call = chain.seen.find((c) => c.method === "eth_call")!.params[0] as { to: string; data: string };
    expect(call.to).toBe(SANCTIONS_ORACLE);
    expect(call.data).toBe(`${sel("isSanctioned(address)")}${"ab".repeat(20).padStart(64, "0")}`);
    expect(geofenceAnswer(451)).toBe("blocked");
    expect(geofenceAnswer(200)).toBe("allowed");
    expect(geofenceAnswer(null)).toBe("unknown");
    expect(SELECTORS.isSpent).toBe("0xe5285dcc");
  });
});
