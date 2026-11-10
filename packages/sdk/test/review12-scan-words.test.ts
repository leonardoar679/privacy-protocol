// The twelfth review round, 2026-11-09, W6 §5.4: while the counters wait on a scan the screens say which hold — a restore's or this unlock's
// —, whether an attempt is reading the pool, and once an attempt under the hold failed, when the wallet tries again. The failing scan had said
// nothing anywhere: its one line was the scheduler's status, cleared in the same call, and a flow learned of it only by its refusal.
// `scanHold` keeps the failure apart from the count of failures in a row, which a demand starts again (from the count alone the words had
// gone the moment Try again now was tapped, before anything was read). Offline: the scan stubbed.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { activityId, recordActivity } from "../src/wallet/activity";
import { noteStore } from "../src/wallet/notes";
import { completeAction, schedulerStatus } from "../src/wallet/schedule";
import { applyEvent, newOperation, resetOperationsMemory } from "../src/operations/store";
import { RpcDisagreement, type Deployment } from "../src/chain";

const scan = vi.hoisted(() => ({ fails: false, error: null as unknown, releases: false, gate: null as Promise<void> | null }));
vi.mock("../src/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/privateTx")>()),
  scanNotes: async () => {
    if (scan.gate) await scan.gate;
    if (scan.fails) throw scan.error ?? new TypeError("fetch failed");
    if (scan.releases) (await import("../src/wallet/notes")).noteStore.releaseCounters(0);
    return { scanned: 10, found: 0, added: 0, spent: 0, refunds: 0, received: [], pending: [], proven: null };
  },
}));

import {
  DISCOVERY_ID,
  demandScan,
  discoverAtUnlock,
  discoverSoon,
  resetDiscoveryMemory,
  runDiscovery,
  scanHold,
  scheduleDiscovery,
  subscribeScanHold,
  type ScanHold,
} from "../src/wallet/discovery";

const store = memoryStorage();
const PASSWORD = "a strong password";
const T0 = Date.parse("2026-11-09T12:00:00Z");
const MIN = 60_000;
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: "0x00000000000000000000000000000000000000e7",
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as unknown as Deployment;
const action = () => session.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done);
const run = (at: number) => runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => at });

beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create(PASSWORD);
  session.acknowledgePhrase();
  // the wallet holds something: its scans are wanted (a first launch stays request-free, spec v2.0 §10)
  recordActivity({ id: activityId("receive", "1"), kind: "receive", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x01" } as never);
});
afterEach(() => {
  session.update((j) => {
    j.schedule = [];
    j.operations = [];
  });
  scan.fails = false;
  scan.releases = false;
  scan.gate = null;
  scan.error = null;
  noteStore.releaseCounters(0);
  schedulerStatus.reset();
  resetDiscoveryMemory();
  resetOperationsMemory();
});

/** the counters held after a restore, and the scan failing at `at`: its next attempt a minute on */
async function failHeld(at = T0): Promise<void> {
  noteStore.holdCounters();
  scan.fails = true;
  scheduleDiscovery(at);
  await run(at);
}

describe("W6 §5.4: what the screens say while the counters wait on a scan", () => {
  it("nothing while the counters are free, nor while the wallet is locked; this unlock's own hold after an unlock", async () => {
    expect(scanHold()).toBeNull();
    noteStore.holdCounters();
    session.lock();
    expect(scanHold(), "locked").toBeNull();
    expect(await session.unlock(PASSWORD)).toBe(true);
    // the restore's hold is the journal's (kept by the lock): an unlock adds its own
    expect(scanHold()).toMatchObject({ hold: "restore", running: false, failed: false });
    noteStore.releaseCounters(0);
    expect(scanHold(), "the scan went through").toBeNull();
    session.lock();
    expect(await session.unlock(PASSWORD)).toBe(true);
    expect(scanHold(), "every unlock holds until its scan").toMatchObject({ hold: "unlock", running: false, failed: false, nextAt: null });
  });

  it("which hold: a restore's (a start without the whole journal) or this unlock's alone", () => {
    noteStore.holdUntilScanned();
    expect(scanHold()!.hold).toBe("unlock");
    noteStore.holdCounters();
    expect(scanHold()!.hold, "a restore's hold beside an unlock's is the restore's").toBe("restore");
    noteStore.releaseCounters(0);
    noteStore.holdCounters();
    expect(scanHold()!.hold).toBe("restore");
  });

  it("an attempt reading the pool: running while the scan runs, never for another action's run", async () => {
    noteStore.holdCounters();
    scheduleDiscovery(T0);
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    const attempt = run(T0);
    await Promise.resolve();
    expect(scanHold()).toMatchObject({ running: true, failed: false });
    scan.fails = true;
    open();
    await attempt;
    expect(scanHold()).toMatchObject({ running: false, failed: true });
    schedulerStatus.start("campaign-tick:0xe", "Protected swap: checking every open step…");
    expect(scanHold()!.running, "a campaign's tick is not the scan").toBe(false);
  });

  it("a failed attempt under the hold: failed, with the backoff's next attempt — kept by a demand that starts the count again, and by an opening", async () => {
    await failHeld();
    expect(scanHold()).toMatchObject({ hold: "restore", running: false, failed: true, nextAt: T0 + MIN, retryFrom: T0 + MIN });
    expect(action()!.heldFailures).toBe(1);
    expect(demandScan(T0 + 30_000)).toBe(true);
    expect(action()!.heldFailures ?? 0, "the demand starts the count again").toBe(0);
    expect(scanHold()!.failed, "the last attempt still failed: Try again now keeps the words").toBe(true);
    await run(T0 + MIN); // the demanded attempt fails too
    expect(scanHold()).toMatchObject({ failed: true, nextAt: T0 + 2 * MIN, retryFrom: T0 + 2 * MIN });
    await run(T0 + 2 * MIN);
    expect(scanHold()).toMatchObject({ failed: true, nextAt: T0 + 4 * MIN });
    expect(discoverSoon(T0 + 3 * MIN), "Activity's opening brings it forward").toBe(true);
    expect(scanHold()).toMatchObject({ failed: true, nextAt: T0 + 3 * MIN });
  });

  it("a demand reads at once from a minute after the last attempt's start, not its end — as demandScan spaces it (ZO's critique)", async () => {
    let clock = T0;
    noteStore.holdCounters();
    scan.fails = true;
    scheduleDiscovery(T0);
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    const attempt = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => clock });
    await Promise.resolve();
    clock = T0 + 80_000; // a long attempt: it ends eighty seconds after it began
    open();
    await attempt;
    expect(scanHold()).toMatchObject({ failed: true, nextAt: T0 + 80_000 + MIN, retryFrom: T0 + MIN });
    expect(demandScan(T0 + 85_000)).toBe(true);
    expect(action()!.dueAt, "the demand at once, past retryFrom").toBe(T0 + 85_000);
  });

  it("the last opening's failure is not this one's: after a lock and an unlock nothing has failed yet, before the unlock's scan is planned (ZP's critique)", async () => {
    await failHeld();
    expect(scanHold()!.failed).toBe(true);
    session.lock();
    expect(await session.unlock(PASSWORD)).toBe(true);
    expect(scanHold(), "held again — the restore's hold journaled, the unlock's added —, nothing failed in this opening").toMatchObject({
      hold: "restore",
      failed: false,
    });
    await run(T0 + MIN); // this opening's own attempt fails: its words again
    expect(scanHold()!.failed).toBe(true);
  });

  it("an earlier opening's attempt, still reading after a lock and an unlock, is this one's neither while it reads nor when it fails (ZQ's critique)", async () => {
    noteStore.holdCounters();
    scheduleDiscovery(T0);
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    const attempt = run(T0);
    await Promise.resolve();
    expect(scanHold()!.running).toBe(true);
    session.lock();
    expect(await session.unlock(PASSWORD)).toBe(true);
    expect(scanHold(), "this opening's scan is still to come").toMatchObject({ hold: "restore", running: false, failed: false });
    scan.fails = true;
    open();
    await attempt.catch(() => undefined);
    expect(scanHold()!.failed, "the earlier opening's failure").toBe(false);
  });

  it("this opening's attempt reading beside an earlier opening's, on pinned sessions as the scheduler runs them: the earlier one's end ends none of this one's reading (ZR's critique)", async () => {
    noteStore.holdCounters();
    scheduleDiscovery(T0);
    let openA!: () => void;
    scan.gate = new Promise<void>((r) => (openA = r));
    const a = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, session: session.pinned(), now: () => T0 });
    await Promise.resolve();
    session.lock();
    expect(await session.unlock(PASSWORD)).toBe(true);
    let openB!: () => void;
    scan.gate = new Promise<void>((r) => (openB = r));
    const b = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, session: session.pinned(), now: () => T0 + MIN });
    await Promise.resolve();
    expect(scanHold()!.running, "this opening's attempt reads").toBe(true);
    scan.fails = true;
    scan.error = new Error("the wallet locked during the scan");
    openA(); // the earlier opening's attempt ends, refused: its journal is not this opening's
    await a.catch(() => undefined);
    expect(schedulerStatus.get().running, "the scheduler's one status slot emptied by it").toBeNull();
    expect(scanHold()!.running, "this opening's attempt still reads").toBe(true);
    expect(scanHold()!.failed, "and nothing of this opening failed").toBe(false);
    scan.error = null;
    openB();
    await b;
    expect(scanHold()).toMatchObject({ running: false, failed: true, cause: null });
  });

  it("why the pool could not be read, named only when the failure tells it for certain: the RPC endpoints disagree — wrapped too —; a fetch that failed, a timeout, a refusal, the light client, none (ZS's critique)", async () => {
    const failWith = async (error: unknown, at: number) => {
      scan.error = error;
      await run(at);
      return scanHold()!.cause;
    };
    await failHeld();
    expect(scanHold()!.cause, "a fetch that failed: an RPC endpoint's or the light client's beacon servers'").toBeNull();
    let t = action()!.dueAt;
    expect(await failWith(new RpcDisagreement("the tree", ["0x01", "0x02"]), t)).toBe("disagree");
    t = action()!.dueAt;
    const verification = Object.assign(new Error("the pool could not be verified"), {
      name: "VerificationUnavailable",
      cause: new RpcDisagreement("the vault deposits", ["0x01", "0x02"]),
    });
    expect(await failWith(verification, t), "a disagreement under another failure is still the endpoints'").toBe("disagree");
    t = action()!.dueAt;
    const wrapped = Object.assign(new Error("HTTP request failed."), { name: "HttpRequestError", cause: new TypeError("fetch failed") });
    expect(await failWith(wrapped, t), "viem's HttpRequestError around the fetch's TypeError").toBeNull();
    t = action()!.dueAt;
    expect(await failWith(Object.assign(new Error("The request took too long to respond."), { name: "TimeoutError" }), t)).toBeNull();
    t = action()!.dueAt;
    expect(
      await failWith(Object.assign(new Error("HTTP request failed. Status: 429"), { name: "HttpRequestError" }), t),
      "an endpoint that answered with a refusal",
    ).toBeNull();
    t = action()!.dueAt;
    expect(
      await failWith(Object.assign(new Error("the light client failed"), { name: "VerificationUnavailable", cause: new TypeError("Failed to fetch") }), t),
    ).toBeNull();
  });

  it("cleared by a scan that goes through: the counters freed, and held again later nothing failed", async () => {
    scan.error = new RpcDisagreement("the tree", ["0x01", "0x02"]); // a failure with a cause: none is left once a scan goes through
    await failHeld();
    expect(scanHold()!.cause).toBe("disagree");
    scan.fails = false;
    scan.releases = true;
    await run(T0 + MIN);
    expect(scanHold()).toBeNull();
    noteStore.holdCounters();
    expect(scanHold(), "no cause without a failure").toMatchObject({ failed: false, cause: null });
  });

  it("cleared by an unlock's scan, planned at once", async () => {
    await failHeld();
    // planned at the failure's own next attempt: the words alone change
    expect(discoverAtUnlock(T0 + MIN)).toBe(true);
    expect(scanHold()).toMatchObject({ failed: false, nextAt: T0 + MIN });
  });

  it("cleared by a failure handed to the scheduler's backoff with the counters free; a failure while a deposit waits on the scan, the counters free, is none under the hold", async () => {
    await failHeld();
    noteStore.releaseCounters(0);
    try {
      await run(T0 + MIN);
    } catch (e) {
      completeAction(DISCOVERY_ID, (e as Error).message, session, T0 + MIN);
    }
    noteStore.holdCounters();
    expect(scanHold()!.failed, "the scheduler's failure is not the hold's").toBe(false);
    noteStore.releaseCounters(0);
    // a Protect its wallet reported nothing for: the scan's retry is the held branch's, the counters free
    const r = newOperation(
      {
        kind: "protect",
        amounts: { asset: "ETH", decimals: 18, input: (10n ** 17n).toString() },
        destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
        tier: "standard",
      } as never,
      T0,
    );
    const tx = ("0x" + "11".repeat(32)) as `0x${string}`;
    applyEvent(r.id, { type: "review" }, session, T0);
    applyEvent(r.id, { type: "confirm" }, session, T0);
    applyEvent(
      r.id,
      {
        type: "progress",
        step: "submitting",
        i: 1,
        n: 1,
        noteCounter: 0,
        sender: "0x00000000000000000000000000000000000000a1",
        noteBody: { vault: deployment.ethVault, amount: "1" },
      } as never,
      session,
      T0,
    );
    applyEvent(r.id, { type: "submitted", by: "wallet", txHash: tx } as never, session, T0);
    applyEvent(r.id, { type: "confirming", txHash: tx } as never, session, T0);
    applyEvent(r.id, { type: "recovery-required", code: "deposit_unconfirmed", detail: "no receipt (timeout)", noteAwaited: true } as never, session, T0);
    scan.fails = true;
    session.update((j) => {
      j.schedule = [];
    });
    scheduleDiscovery(T0 + 2 * MIN);
    await run(T0 + 2 * MIN);
    expect(action()!.heldFailures, "the deposit's own retry").toBe(1);
    noteStore.holdCounters();
    expect(scanHold()!.failed).toBe(false);
  });

  it("the same object while nothing in it changes, a new one when any of it does (a useSyncExternalStore snapshot)", async () => {
    noteStore.holdUntilScanned();
    const a = scanHold();
    expect(scanHold()).toBe(a);
    noteStore.holdCounters(); // the hold alone changes
    const b = scanHold();
    expect(b, "the hold").not.toBe(a);
    expect(b).toMatchObject({ hold: "restore", nextAt: null });
    scheduleDiscovery(T0); // the next attempt alone
    const b2 = scanHold();
    expect(b2, "the next attempt").not.toBe(b);
    expect(b2).toMatchObject({ running: false, nextAt: T0 });
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    const attempt = run(T0); // the run alone
    await Promise.resolve();
    const c = scanHold();
    expect(c, "running").not.toBe(b2);
    expect(c).toMatchObject({ running: true, nextAt: T0 });
    scan.fails = true;
    open();
    await attempt;
    const d = scanHold();
    expect(d).toMatchObject({ failed: true, nextAt: T0 + MIN });
    expect(scanHold()).toBe(d);
    discoverAtUnlock(T0 + MIN); // the failure alone changes
    const e = scanHold();
    expect(e, "failed").not.toBe(d);
    expect(e).toMatchObject({ failed: false, nextAt: T0 + MIN });
    await run(T0 + MIN);
    await run(T0 + 2 * MIN);
    expect(scanHold()).toMatchObject({ failed: true, nextAt: T0 + 4 * MIN });
    const f = scanHold();
    expect(discoverSoon(T0 + 3 * MIN)).toBe(true); // the next attempt alone changes
    const g = scanHold();
    expect(g, "the next attempt").not.toBe(f);
    expect(g).toMatchObject({ failed: true, nextAt: T0 + 3 * MIN });
  });

  it("its subscribers hear each change, and the last they hear is the state: the hold, the attempt's run, its failure, a demand, a success", async () => {
    const seen: (ScanHold | null)[] = [];
    const off = subscribeScanHold(() => seen.push(scanHold()));
    try {
      noteStore.holdUntilScanned(); // the unlock's hold is not journaled: the note store alone tells it
      expect(seen.at(-1)).toMatchObject({ hold: "unlock", failed: false });
      noteStore.holdCounters();
      expect(seen.at(-1)).toMatchObject({ hold: "restore", failed: false });
      scan.fails = true;
      scheduleDiscovery(T0);
      let open!: () => void;
      scan.gate = new Promise<void>((r) => (open = r));
      const attempt = run(T0);
      await Promise.resolve();
      expect(seen.at(-1)).toMatchObject({ running: true });
      open();
      await attempt;
      expect(seen.at(-1), "after the failed attempt").toMatchObject({ running: false, failed: true, nextAt: T0 + MIN });
      scan.gate = null;
      await run(T0 + MIN); // a second failure: its next attempt two minutes on
      expect(seen.at(-1)).toMatchObject({ failed: true, nextAt: T0 + 3 * MIN });
      demandScan(T0 + 2 * MIN); // the session alone tells the demand
      expect(seen.at(-1), "after a demand").toMatchObject({ failed: true, nextAt: T0 + 2 * MIN });
      scan.fails = false;
      scan.releases = true;
      await run(T0 + 2 * MIN);
      expect(seen.at(-1), "after the scan went through").toBeNull();
    } finally {
      off();
    }
    const heard = seen.length;
    noteStore.holdCounters();
    expect(seen.length, "no longer told").toBe(heard);
  });
});
