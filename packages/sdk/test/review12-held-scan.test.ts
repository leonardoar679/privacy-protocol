// The twelfth review round, 2026-11-06, W6 §5 (C12-2 against the held-counter rule): a scan that failed while the counters were held (after an
// unlock or a restore), or while a deposit waited on it, was tried again every minute for good — each attempt the pool's whole history from
// every endpoint, sixty an hour for as long as the wallet stayed unlocked, its failures never counted (each retry replaced the action). It
// backs off now — 1, 2, 4, 8 minutes, then the interval a working wallet scans at —, its failures in a row counted on the action's own
// `heldFailures`, never the scheduler's `attempts` (ZK's critique: one count for both had carried each backoff's failures into the other);
// an unlock and a flow's demand start the count again, even during a running attempt; a runner seeing a refund keeps it; Activity's opening
// brings a held scan forward, its count kept, and leaves the scheduler's own backoff alone. Offline: the scan stubbed.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { activityId, recordActivity } from "../src/wallet/activity";
import { noteStore } from "../src/wallet/notes";
import { backoffMs, completeAction, isDue } from "../src/wallet/schedule";
import { applyEvent, newOperation, resetOperationsMemory } from "../src/operations/store";
import { DEPOSIT_RESCAN_WINDOW_MS } from "../src/operations/stale";
import type { Deployment } from "../src/chain";

const scan = vi.hoisted(() => ({ calls: 0, fails: false, releases: false, gate: null as Promise<void> | null }));
vi.mock("../src/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/privateTx")>()),
  scanNotes: async () => {
    scan.calls++;
    if (scan.gate) await scan.gate;
    if (scan.fails) throw new TypeError("fetch failed");
    // a complete scan releases the counters, as the real one does once it has seen them (`releases`)
    if (scan.releases) (await import("../src/wallet/notes")).noteStore.releaseCounters(0);
    return { scanned: 10, found: 0, added: 0, spent: 0, refunds: 0, received: [], pending: [], proven: null };
  },
}));

import {
  DEPOSIT_SCAN_DELAY_MS,
  DISCOVERY_ID,
  DISCOVERY_INTERVAL_MS,
  demandScan,
  discoverAtUnlock,
  discoverSoon,
  heldRetryMs,
  nextScanAt,
  resetDiscoveryMemory,
  runDiscovery,
  scanForDeposit,
  scheduleDiscovery,
} from "../src/wallet/discovery";

const store = memoryStorage();
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
const action = () => session.journal().schedule.find((a) => a.id === DISCOVERY_ID);
const run = (at: number) => runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => at });
/** the scheduler's own handling of a run that throws (apps/web hooks useScheduler): its backoff, counted on `attempts` */
const runAsScheduled = async (at: number) => {
  try {
    await run(at);
  } catch (e) {
    completeAction(DISCOVERY_ID, (e as Error).message, session, at);
  }
};

beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
  // the wallet holds something: its scans are wanted (a first launch stays request-free, spec v2.0 §10)
  recordActivity({ id: activityId("receive", "1"), kind: "receive", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x01" } as never);
});
afterEach(() => {
  session.update((j) => {
    j.schedule = [];
    j.operations = [];
  });
  scan.calls = 0;
  scan.fails = false;
  scan.releases = false;
  scan.gate = null;
  noteStore.releaseCounters(0);
  resetDiscoveryMemory();
  resetOperationsMemory();
});

/** `n` scans failing in a row while the counters are held, the first at `at`: the time of the last attempt */
async function failHeld(n: number, at = T0): Promise<number> {
  noteStore.holdCounters();
  scan.fails = true;
  scheduleDiscovery(at);
  let t = at;
  for (let i = 0; i < n; i++) {
    if (i > 0) t = action()!.dueAt;
    await run(t);
  }
  return t;
}

/** a Protect its wallet reported nothing for, awaited by the live flow, read so at `at` (operations/stale.ts depositAwaited) */
function awaitedDeposit(at: number): void {
  const r = newOperation(
    {
      kind: "protect",
      amounts: { asset: "ETH", decimals: 18, input: (10n ** 17n).toString() },
      destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
      tier: "standard",
    } as never,
    at,
  );
  const tx = ("0x" + "11".repeat(32)) as `0x${string}`;
  applyEvent(r.id, { type: "review" }, session, at);
  applyEvent(r.id, { type: "confirm" }, session, at);
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
    at,
  );
  applyEvent(r.id, { type: "submitted", by: "wallet", txHash: tx } as never, session, at);
  applyEvent(r.id, { type: "confirming", txHash: tx } as never, session, at);
  applyEvent(r.id, { type: "recovery-required", code: "deposit_unconfirmed", detail: "no receipt (timeout)", noteAwaited: true } as never, session, at);
}

describe("W6 §5: a scan the counters wait on backs off, and only an unlock or a demand starts its count again", () => {
  it("six scans failing in a row while the counters are held: tried again after 1, 2, 4, 8, 10, 10 minutes, each failure counted on the action", async () => {
    noteStore.holdCounters();
    scan.fails = true;
    scheduleDiscovery(T0);
    let t = T0;
    const waits: number[] = [];
    const counts: (number | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      await run(t);
      const a = action()!;
      expect(a.done, "kept pending under the same id").toBeFalsy();
      expect(a.attempts ?? 0, "never the scheduler's count").toBe(0);
      waits.push((a.dueAt - t) / MIN);
      counts.push(a.heldFailures);
      t = a.dueAt;
    }
    expect(waits).toEqual([1, 2, 4, 8, 10, 10]);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scan.calls).toBe(6);
    expect(heldRetryMs(1)).toBe(MIN);
    expect(heldRetryMs(40), "capped at the interval, never past it").toBe(DISCOVERY_INTERVAL_MS);
  });

  it("a success ends the count: the next scan at the interval, no failure kept", async () => {
    await failHeld(3);
    scan.fails = false;
    const at = action()!.dueAt;
    await run(at);
    expect(action()!.dueAt).toBe(at + DISCOVERY_INTERVAL_MS);
    expect(action()!.heldFailures ?? 0).toBe(0);
  });

  it("an unlock during the backoff scans at once and starts the count again: its first failure is tried again a minute on", async () => {
    const t = await failHeld(3);
    const unlockAt = t + 30_000;
    expect(discoverAtUnlock(unlockAt)).toBe(true);
    expect(action()!.dueAt).toBe(unlockAt);
    expect(action()!.heldFailures ?? 0).toBe(0);
    await run(unlockAt);
    expect(action()!.dueAt - unlockAt).toBe(MIN);
  });

  it("a flow's demand during the backoff scans at once, the count started again; within the minute of an attempt, at that minute's end (ZL's critique); none while the counters are free", async () => {
    const t = await failHeld(3); // the fourth attempt due four minutes on
    expect(demandScan(t + 30_000), "an attempt half a minute ago: planned at the minute's end, never refused").toBe(true);
    expect(action()!.dueAt).toBe(t + MIN);
    expect(action()!.heldFailures ?? 0).toBe(0);
    await run(t + MIN);
    expect(action()!.dueAt - (t + MIN), "its failure tried again a minute on").toBe(MIN);
    expect(demandScan(t + 2 * MIN), "a minute after that attempt: at once").toBe(true);
    expect(action()!.dueAt).toBe(t + 2 * MIN);
    noteStore.releaseCounters(0);
    expect(demandScan(t + 5 * MIN), "the counters free: nothing waits on the scan").toBe(false);
  });

  it("a demand never plans the scan later than it already was: a deposit's scan half a minute on stays (ZL's critique)", async () => {
    const t = await failHeld(1); // the second attempt due a minute on
    awaitedDeposit(t + 5_000);
    expect(scanForDeposit(t + 5_000)).toBe(true);
    expect(action()!.dueAt).toBe(t + 5_000 + DEPOSIT_SCAN_DELAY_MS);
    expect(demandScan(t + 10_000)).toBe(true);
    expect(action()!.dueAt, "kept at the deposit's, before the minute's end").toBe(t + 5_000 + DEPOSIT_SCAN_DELAY_MS);
  });

  it("a scan that releases the counters wakes the campaign steps waiting on it, a second after; one that leaves them held wakes none (ZL's critique)", async () => {
    const tickAt = T0 + 60 * MIN;
    const tick = () => session.journal().schedule.find((a) => a.id === "campaign-tick:0xc")!;
    await failHeld(3);
    // beside it, a funding and a housekeeping run drawn at random times of their windows: never moved (ZM's critique — their timing is privacy)
    session.update((j) => {
      j.schedule.push({ id: "campaign-tick:0xc", kind: "campaign-tick", orderId: "0xc", dueAt: tickAt });
      j.schedule.push({ id: "fund-escrow:0xd", kind: "fund-escrow", orderId: "0xd", dueAt: T0 + 180 * MIN });
      j.schedule.push({ id: "housekeeping:pool", kind: "housekeeping", orderId: "pool", dueAt: T0 + 240 * MIN });
    });
    scan.fails = false;
    const first = action()!.dueAt;
    await run(first); // a complete scan that has not released them (its stub keeps the hold)
    expect(tick().dueAt, "still held: the step's tick where it was").toBe(tickAt);
    scan.releases = true;
    const second = action()!.dueAt;
    await run(second);
    expect(noteStore.countersHeld()).toBe(false);
    expect(tick().dueAt, "released: a second after the scan").toBe(second + 1000);
    const at = (id: string) => session.journal().schedule.find((a) => a.id === id)!.dueAt;
    expect(at("fund-escrow:0xd"), "a funding's drawn time kept").toBe(T0 + 180 * MIN);
    expect(at("housekeeping:pool"), "a housekeeping run's drawn time kept").toBe(T0 + 240 * MIN);
  });

  it("Activity's opening waits a minute after a scan ends, not only after it starts: a scan longer than the minute is never read again at once (ZM's critique)", async () => {
    let clock = T0;
    scheduleDiscovery(T0);
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    const attempt = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => clock });
    await Promise.resolve();
    clock = T0 + 80_000; // a light client's scan, eighty seconds
    open();
    await attempt;
    expect(action()!.dueAt, "the next pass at the interval").toBe(T0 + 80_000 + DISCOVERY_INTERVAL_MS);
    expect(discoverSoon(T0 + 85_000), "five seconds after it ended").toBe(false);
    expect(action()!.dueAt).toBe(T0 + 80_000 + DISCOVERY_INTERVAL_MS);
    expect(discoverSoon(T0 + 80_000 + MIN), "a minute after it ended").toBe(true);
  });

  it("... and after one that fails, the counters held: no second read five seconds on, the held scan brought forward a minute after, its count kept (ZN's critique)", async () => {
    let clock = T0;
    noteStore.holdCounters();
    scan.fails = true;
    scheduleDiscovery(T0);
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    const attempt = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => clock });
    await Promise.resolve();
    clock = T0 + 80_000;
    open();
    await attempt; // and it fails
    const end = T0 + 80_000;
    expect(action()).toMatchObject({ dueAt: end + MIN, heldFailures: 1 });
    expect(discoverSoon(end + 5_000), "five seconds after the failed attempt ended").toBe(false);
    expect(action()!.dueAt).toBe(end + MIN);
    // two failures more, then an opening a minute after the last one ended: brought forward, its count kept
    scan.gate = null;
    await run(end + MIN);
    await run(end + 3 * MIN);
    expect(action()).toMatchObject({ dueAt: end + 7 * MIN, heldFailures: 3 });
    expect(discoverSoon(end + 4 * MIN)).toBe(true);
    expect(action()).toMatchObject({ dueAt: end + 4 * MIN, heldFailures: 3 });
  });

  it("a scan with the counters free all along wakes no campaign step (ZN's critique: a step waiting on its cadence or its cost)", async () => {
    const tickAt = T0 + 60 * MIN;
    session.update((j) => {
      j.schedule.push({ id: "campaign-tick:0xe", kind: "campaign-tick", orderId: "0xe", dueAt: tickAt });
    });
    expect(noteStore.countersHeld()).toBe(false);
    scheduleDiscovery(T0);
    await run(T0);
    expect(session.journal().schedule.find((a) => a.id === "campaign-tick:0xe")!.dueAt, "nothing waited on this scan").toBe(tickAt);
  });

  it("a demand, or an unlock, during a running attempt that then fails: the count starts again all the same (ZK's critique)", async () => {
    for (const reset of [(at: number) => demandScan(at), (at: number) => discoverAtUnlock(at)]) {
      await failHeld(3); // the fourth attempt due four minutes on
      const start = action()!.dueAt;
      let open!: () => void;
      scan.gate = new Promise<void>((r) => (open = r));
      const attempt = run(start); // reading the pool, for a minute and more
      await Promise.resolve();
      expect(reset(start + 70_000), "asked while the attempt runs").toBe(true);
      open();
      await attempt; // and it fails
      expect(action()!.heldFailures, "its failure the first of a new count").toBe(1);
      expect(action()!.dueAt - start).toBe(MIN);
      scan.gate = null;
      session.update((j) => {
        j.schedule = [];
      });
      resetDiscoveryMemory();
    }
  });

  it("a runner seeing a refund keeps a failing scan's backoff; Activity's opening brings it forward once a minute has passed, its count kept", async () => {
    const t = await failHeld(3);
    const due = action()!.dueAt;
    expect(scheduleDiscovery(t + 10_000), "a runner's ask").toBe(false);
    expect(action()!.dueAt).toBe(due);
    expect(discoverSoon(t + 30_000), "an attempt half a minute ago").toBe(false);
    expect(discoverSoon(t + MIN)).toBe(true);
    expect(action()).toMatchObject({ dueAt: t + MIN, heldFailures: 3 });
    await run(t + MIN);
    expect(action()!.dueAt - (t + MIN), "one more failure: the fourth's wait").toBe(8 * MIN);
  });

  it("the scheduler's own backoff (the counters free): Activity's opening leaves it be, an unlock scans at once (ZK's critique)", async () => {
    scan.fails = true;
    scheduleDiscovery(T0);
    await runAsScheduled(T0);
    await runAsScheduled(T0 + backoffMs(1)); // two failures: the third attempt twenty minutes after the second
    const second = T0 + backoffMs(1);
    expect(action()).toMatchObject({ attempts: 2, nextAttemptAt: second + backoffMs(2) });
    expect(discoverSoon(second + 5 * MIN), "an opening during the scheduler's backoff").toBe(false);
    expect(isDue(action()!, second + 5 * MIN), "still in its backoff").toBe(false);
    // an unlock: at once, past the backoff (before, the unlock's ask had planned nothing while it held the counters)
    expect(discoverAtUnlock(second + 6 * MIN)).toBe(true);
    expect(isDue(action()!, second + 6 * MIN)).toBe(true);
    expect(action()!.nextAttemptAt).toBeUndefined();
  });

  it("a deposit its wallet did not report, awaited by the live flow: its scan's failures back off the same way, the counters free", async () => {
    awaitedDeposit(T0 - MIN);
    expect(noteStore.countersHeld()).toBe(false);
    scan.fails = true;
    scheduleDiscovery(T0);
    await run(T0);
    expect(action()!.dueAt - T0).toBe(MIN);
    await run(T0 + MIN);
    expect(action()!.dueAt - (T0 + MIN)).toBe(2 * MIN);
  });

  it("the awaited deposit's window ending while the scan still fails: the scheduler's backoff starts at its first ten minutes, never at the held count (ZK's critique)", async () => {
    awaitedDeposit(T0);
    scan.fails = true;
    scheduleDiscovery(T0);
    let t = T0;
    while (t - T0 < DEPOSIT_RESCAN_WINDOW_MS) {
      await runAsScheduled(t);
      t = Math.max(action()!.dueAt, action()!.nextAttemptAt ?? 0);
    }
    // past the window: the failure is the scheduler's
    await runAsScheduled(t);
    expect(action()).toMatchObject({ attempts: 1, nextAttemptAt: t + backoffMs(1) });
    expect(action()!.heldFailures ?? 0, "the held count gone").toBe(0);
  });

  it("a deposit awaited after the scheduler's failures: its first retry a minute on, never the scheduler's count (ZK's critique)", async () => {
    scan.fails = true;
    scheduleDiscovery(T0);
    await runAsScheduled(T0);
    await runAsScheduled(T0 + backoffMs(1));
    await runAsScheduled(T0 + backoffMs(1) + backoffMs(2)); // three failures of the scheduler's
    const at = T0 + backoffMs(1) + backoffMs(2) + MIN;
    awaitedDeposit(at);
    expect(scanForDeposit(at)).toBe(true);
    // past the scheduler's backoff, by the deposit's delay at the latest
    const due = at + DEPOSIT_SCAN_DELAY_MS;
    expect(isDue(action()!, due)).toBe(true);
    await run(due);
    expect(action()!.dueAt - due, "the deposit's first retry").toBe(MIN);
    await run(due + MIN);
    expect(action()!.dueAt - (due + MIN)).toBe(2 * MIN);
  });

  it("a deposit awaited during a held scan's backoff: its own retries start at a minute, the held count started again (ZK's critique)", async () => {
    const t = await failHeld(3); // the fourth attempt due four minutes on
    const at = t + MIN;
    awaitedDeposit(at);
    expect(scanForDeposit(at)).toBe(true);
    expect(action()!.heldFailures ?? 0).toBe(0);
    const due = at + DEPOSIT_SCAN_DELAY_MS;
    expect(isDue(action()!, due)).toBe(true);
    await run(due);
    expect(action()!.dueAt - due, "the deposit's first retry").toBe(MIN);
  });

  it("the scan's next attempt, for the runners: its due time, past a scheduler's backoff; none planned, none", () => {
    expect(nextScanAt()).toBeNull();
    scheduleDiscovery(T0 + 5 * MIN);
    expect(nextScanAt()).toBe(T0 + 5 * MIN);
    session.update((j) => {
      j.schedule.find((a) => a.id === DISCOVERY_ID)!.nextAttemptAt = T0 + 9 * MIN;
    });
    expect(nextScanAt()).toBe(T0 + 9 * MIN);
  });
});
