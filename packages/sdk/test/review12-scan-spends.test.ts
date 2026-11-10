// The twelfth review round, 2026-11-10, 12b2d (W6 §5.3 completed; ZR's critique of 12b2c): the scheduler runs one action at a time, and a
// scheduled spend that takes a note's counter — the order runner's funding (a funding delayed for privacy runs at the next unlock), a
// fund-escrow action, a housekeeping step — awaited the scan the counters wait on inside its spend: up to two minutes under every opening's
// hold, the scan queued behind it in the same scheduler, then refused into the scheduler's backoff (ten minutes, doubling). Now each starts
// nothing while the counters are held, after the checks that stop or settle it: it waits a second past the scan's next attempt, marked
// `waitsOnScan`, its last failure kept on record, holding nothing; a scan that frees the counters wakes it — and nothing that did not wait on
// it (ZU's critique for the hold, the record and the placement). Offline: the scan stubbed, the order runner's world injected, the
// housekeeping step counted.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const scan = vi.hoisted(() => ({ fails: false, releases: false }));
vi.mock("../src/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/privateTx")>()),
  scanNotes: async () => {
    if (scan.fails) throw new TypeError("fetch failed");
    if (scan.releases) (await import("../src/wallet/notes")).noteStore.releaseCounters(0);
    return { scanned: 10, found: 0, added: 0, spent: 0, refunds: 0, received: [], pending: [], proven: null };
  },
}));
const housekeeping = vi.hoisted(() => ({ steps: 0 }));
vi.mock("../src/wallet/housekeeping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/wallet/housekeeping")>()),
  runHousekeepingStep: async () => {
    housekeeping.steps++; // a merge or a split planned and asked
    return { ran: null, waitedForCap: false };
  },
}));

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { activityId, recordActivity } from "../src/wallet/activity";
import { noteStore } from "../src/wallet/notes";
import { completeAction, failedAttempt, scheduleAction, waitBehindScan } from "../src/wallet/schedule";
import type { ScheduledAction, StoredSwap } from "../src/wallet/journal";
import type { Deployment } from "../src/chain";
import type { SwapJob } from "../src/relayer";
import { FUNDING_MARGIN_MS, patchSwap, runScheduledAction } from "../src/swapFunding";
import { resetOperationsMemory } from "../src/operations/store";
import { resetOrderRunnerMemory, runOrderTick, type OrderIo } from "../src/wallet/orderRunner";
import { DISCOVERY_ID, afterScanAt, resetDiscoveryMemory, runDiscovery, scheduleDiscovery } from "../src/wallet/discovery";

const store = memoryStorage();
const T0 = Date.parse("2026-11-10T12:00:00Z");
const MIN = 60_000;
const ORDER = "0x" + "ab".repeat(32);
const AMOUNT = 10n ** 18n;
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: "0x00000000000000000000000000000000000000e7",
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as unknown as Deployment;
/** both holds: a restore's (journaled), and every opening's alone (the common one: "a funding delayed for privacy runs at the next unlock") */
const HOLDS = [
  ["a restore's hold", () => noteStore.holdCounters()],
  ["an opening's hold", () => noteStore.holdUntilScanned()],
] as const;

beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
  // the wallet holds something: its scans are wanted (a first launch stays request-free, spec v2.0 §10)
  recordActivity({ id: activityId("receive", "1"), kind: "receive", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x01" } as never);
});
afterEach(() => {
  session.update((j) => {
    j.swaps = [];
    j.schedule = [];
    j.operations = [];
  });
  scan.fails = false;
  scan.releases = false;
  housekeeping.steps = 0;
  noteStore.releaseCounters(0);
  resetDiscoveryMemory();
  resetOperationsMemory();
  resetOrderRunnerMemory();
});

/** a one-confirmation order committed and not yet funded (order-runner.test.ts's) */
function order(extra: Partial<StoredSwap> = {}): StoredSwap {
  const s = {
    orderId: ORDER,
    attemptId: "0x" + "01".repeat(32),
    refundCounter: 7,
    provider: "thorchain",
    policy: "balanced",
    request: {
      from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
      amount: AMOUNT.toString(),
      destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      slippageBps: 50,
    },
    params: { amount: AMOUNT.toString() },
    endpoint: "0x00000000000000000000000000000000000000e5",
    quote: { provider: "thorchain", toAmount: "3000000", toAmountMin: "2970000" },
    approvedMin: "2970000",
    createdAt: T0,
    state: "committed",
    refundNoteData: "0x00",
    runner: { confirmedAt: T0 },
    ...extra,
  } as StoredSwap;
  session.update((j) => {
    j.swaps = [...j.swaps.filter((x) => x.orderId !== s.orderId), s];
  });
  return s;
}
/** the runner's world up to the funding: the escrow empty, no executor job, the funding and the fresh quote counted */
function world() {
  const w = { funds: 0, prechecks: 0, job: null as SwapJob | null };
  const io = {
    fund: async (st: StoredSwap) => {
      w.funds++;
      patchSwap(st.orderId, { fundedTx: "0xf00d", state: "funded" });
      return { txHash: "0xf00d" };
    },
    escrowBalance: async () => 0n,
    job: async () => w.job,
    precheck: async () => {
      w.prechecks++;
      return null;
    },
  } as unknown as OrderIo;
  return { w, io };
}
const deps = (io: OrderIo, now: number) => ({ masterSeed: new Uint8Array(32).fill(1), deployment: null, io, now: () => now });
const find = (id: string) => session.journal().schedule.find((a) => a.id === id && !a.done);
const tickAction = (): ScheduledAction => {
  if (!find(`order-tick:${ORDER}`)) scheduleAction({ kind: "order-tick", orderId: ORDER, dueAt: T0 }, session);
  return find(`order-tick:${ORDER}`)!;
};
/** the scan's attempt at `at`: it frees the counters (a complete scan), or fails */
const scanAt = (at: number) => runDiscovery(find(DISCOVERY_ID)!, { masterSeed: new Uint8Array(32), deployment, now: () => at });
/** the hand-over holds the session keeps (a funded order keeps its own until it is handed over: counted, never assumed none) */
const handOvers = () => session.holds().filter((h) => h.reason === "hand-over").length;

describe("12b2d: the order runner's funding follows the scan the counters wait on", () => {
  it("afterScanAt: a second after the scan's next attempt, a minute on when none is planned, never sooner than a second", () => {
    expect(afterScanAt(T0), "no scan planned").toBe(T0 + MIN + 1000);
    scheduleDiscovery(T0 + 4 * MIN);
    expect(afterScanAt(T0)).toBe(T0 + 4 * MIN + 1000);
    expect(afterScanAt(T0 + 10 * MIN), "a scan already due").toBe(T0 + 10 * MIN + 1000);
  });

  for (const [hold, take] of HOLDS) {
    it(`a funding delayed for privacy, due, under ${hold}: nothing funded, no fresh quote asked, nothing held — its tick a second after the scan's next attempt, marked; the scan that frees the counters wakes it, and it funds`, async () => {
      order({ runner: { confirmedAt: T0, delayUntil: T0 - 1 } });
      const { w, io } = world();
      scheduleDiscovery(T0 + 4 * MIN); // the scan, backed off
      take();
      const held = handOvers();
      const r = await runOrderTick(tickAction(), deps(io, T0));
      expect(r?.step).toBe("delayed");
      expect(w.funds, "no funding started").toBe(0);
      expect(w.prechecks, "no fresh quote asked").toBe(0);
      expect(handOvers(), "nothing signed or sent: no hold kept for it, the lock not kept off (ZU's critique)").toBe(held);
      expect(find(`order-tick:${ORDER}`)).toMatchObject({ dueAt: T0 + 4 * MIN + 1000, waitsOnScan: true });
      session.update((j) => {
        j.schedule.find((a) => a.id === DISCOVERY_ID)!.dueAt = T0 + MIN; // a demand: the scan brought to now
      });
      scan.releases = true;
      await scanAt(T0 + MIN);
      expect(find(`order-tick:${ORDER}`)!.dueAt, "woken a second after").toBe(T0 + MIN + 1000);
      const again = await runOrderTick(tickAction(), deps(io, T0 + MIN + 1000));
      expect(again?.step).toBe("funded");
      expect(w.funds).toBe(1);
      expect(w.prechecks, "its fresh quote asked once, at the funding").toBe(1);
    });
  }

  it("the wait keeps the tick's last failure on record — what the screens show — and its count; an attempt that answers drops the mark (ZU's critique)", async () => {
    order();
    const { io } = world();
    scheduleAction({ kind: "order-tick", orderId: ORDER, dueAt: T0 }, session);
    session.update((j) => {
      Object.assign(
        j.schedule.find((a) => a.id === `order-tick:${ORDER}`)!,
        { error: "fetch failed", errorCode: "relayer_unreachable", attempts: 3 },
      );
    });
    noteStore.holdUntilScanned();
    await runOrderTick(tickAction(), deps(io, T0));
    expect(find(`order-tick:${ORDER}`)).toMatchObject({ error: "fetch failed", errorCode: "relayer_unreachable", attempts: 3, waitsOnScan: true });
    expect(find(`order-tick:${ORDER}`)!.nextAttemptAt, "no next attempt of its backoff: its time the scan's next attempt and a second").toBeUndefined();
    expect(failedAttempt(ORDER, session), "still the operation's failed attempt").not.toBeNull();
    completeAction(`order-tick:${ORDER}`, "fetch failed", session, T0 + 2 * MIN, "relayer_unreachable");
    expect(find(`order-tick:${ORDER}`)).toMatchObject({ attempts: 4 });
    expect(find(`order-tick:${ORDER}`)!.waitsOnScan, "an attempt answered: its backoff, not the scan").toBeUndefined();
  });

  it("the checks that stop or settle an order come first, under the hold too: a window closing stops it unfunded, an executor that has it is tracked (ZU's critique)", async () => {
    noteStore.holdCounters();
    order({ params: { amount: AMOUNT.toString(), executeDeadline: Math.floor((T0 + FUNDING_MARGIN_MS - 1000) / 1000) } as never });
    const a = world();
    const stopped = await runOrderTick(tickAction(), deps(a.io, T0));
    expect(stopped?.step).toBe("stopped");
    expect(session.journal().swaps.find((x) => x.orderId === ORDER)!.paused?.code).toBe("order_expired");
    session.update((j) => {
      j.swaps = [];
      j.schedule = [];
    });
    order();
    const b = world();
    b.w.job = { id: "job-9", escrow: "0x00000000000000000000000000000000000000e5", state: "executing", updatedAt: T0 } as SwapJob;
    const tracked = await runOrderTick(tickAction(), deps(b.io, T0));
    expect(tracked?.step, "another copy funded and handed it over").toBe("track");
    expect(session.journal().swaps.find((x) => x.orderId === ORDER)!.jobId).toBe("job-9");
    expect(b.w.funds).toBe(0);
  });

  it("an order with between one and two of the funding's margins left waits behind the scan as any other — a funding is never left to wait in the scheduler for the scan (ZW's critique)", async () => {
    noteStore.holdUntilScanned();
    order({ params: { amount: AMOUNT.toString(), executeDeadline: Math.floor((T0 + FUNDING_MARGIN_MS + 2 * MIN) / 1000) } as never });
    const { w, io } = world();
    const r = await runOrderTick(tickAction(), deps(io, T0));
    expect(r?.step).toBe("delayed");
    expect(w.funds, "no funding started").toBe(0);
    expect(find(`order-tick:${ORDER}`)).toMatchObject({ waitsOnScan: true });
  });

  it("with the counters free the funding runs as before, its tick not marked", async () => {
    order();
    const { w, io } = world();
    const r = await runOrderTick(tickAction(), deps(io, T0));
    expect(r?.step).toBe("funded");
    expect(w.funds).toBe(1);
    expect(find(`order-tick:${ORDER}`)?.waitsOnScan).toBeUndefined();
  });
});

describe("12b2d: a scheduled fund-escrow and a housekeeping step follow the scan", () => {
  for (const [hold, take] of HOLDS) {
    it(`a fund-escrow under ${hold} starts no funding: it waits a second past the scan's next attempt, marked, its failure kept`, async () => {
      order({ runner: undefined });
      const a = scheduleAction({ kind: "fund-escrow", orderId: ORDER, dueAt: T0 }, session);
      session.update((j) => {
        Object.assign(
          j.schedule.find((x) => x.id === a.id)!,
          { error: "fetch failed", attempts: 2 },
        );
      });
      const at = Date.now() + 4 * MIN; // the scheduled actions read the device's clock
      scheduleDiscovery(at);
      take();
      await runScheduledAction(find(a.id)!, { masterSeed: new Uint8Array(32), deployment, escrowBalance: async () => 0n });
      expect(find(a.id)).toMatchObject({ dueAt: at + 1000, waitsOnScan: true, error: "fetch failed", attempts: 2 });
      expect(session.journal().swaps.find((x) => x.orderId === ORDER)!.paused, "nothing refused: nothing asked").toBeUndefined();
    });

    it(`a housekeeping step under ${hold} plans no merge or split: it waits behind the scan, marked; once the counters are free it runs`, async () => {
      const a = scheduleAction({ kind: "housekeeping", orderId: `balance:${T0}`, dueAt: T0 }, session);
      const at = Date.now() + 4 * MIN;
      scheduleDiscovery(at);
      take();
      await runScheduledAction(a, { masterSeed: new Uint8Array(32), deployment });
      expect(housekeeping.steps, "no merge or split asked").toBe(0);
      expect(find(a.id)).toMatchObject({ dueAt: at + 1000, waitsOnScan: true });
      noteStore.releaseCounters(0);
      await runScheduledAction(find(a.id)!, { masterSeed: new Uint8Array(32), deployment });
      expect(housekeeping.steps, "run once the counters are free").toBe(1);
    });
  }

  it("a fund-escrow whose funding is already funded, already sent, or whose window closes is settled or stopped as before, under the hold too — never kept behind the scan (ZU's critique)", async () => {
    noteStore.holdCounters();
    // the escrow already holds it: funded, the action cancelled
    order({ runner: undefined });
    const a = scheduleAction({ kind: "fund-escrow", orderId: ORDER, dueAt: T0 }, session);
    await runScheduledAction(a, { masterSeed: new Uint8Array(32), deployment, escrowBalance: async () => AMOUNT });
    expect(session.journal().swaps.find((x) => x.orderId === ORDER)!.state).toBe("funded");
    expect(find(a.id), "cancelled").toBeUndefined();
    // a funding already journaled as sent: its fate read by the funding, never a wait
    session.update((j) => {
      j.swaps = [];
      j.schedule = [];
    });
    order({ runner: undefined, fundingAttempt: { nullifiers: ["0x01"], by: "relayer", at: T0 } } as never);
    const b = scheduleAction({ kind: "fund-escrow", orderId: ORDER, dueAt: T0 }, session);
    await runScheduledAction(b, { masterSeed: new Uint8Array(32), deployment, escrowBalance: async () => 0n }).catch(() => undefined);
    expect(find(b.id)?.waitsOnScan, "not behind the scan").toBeUndefined();
    // its window closing: stopped by the funding's own check, never a wait
    session.update((j) => {
      j.swaps = [];
      j.schedule = [];
    });
    order({
      runner: undefined,
      params: { amount: AMOUNT.toString(), executeDeadline: Math.floor((Date.now() + FUNDING_MARGIN_MS - 1000) / 1000) } as never,
    });
    const c = scheduleAction({ kind: "fund-escrow", orderId: ORDER, dueAt: T0 }, session);
    const tried = await runScheduledAction(c, { masterSeed: new Uint8Array(32), deployment, escrowBalance: async () => 0n }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(find(c.id)?.waitsOnScan, "not behind the scan").toBeUndefined();
    expect(tried, "the funding's own checks ran (this world refuses it for its balance before its window)").toBeTruthy();
    // a window with between one and two margins left: behind the scan as any other (ZW's critique)
    session.update((j) => {
      j.swaps = [];
      j.schedule = [];
    });
    order({
      runner: undefined,
      params: { amount: AMOUNT.toString(), executeDeadline: Math.floor((Date.now() + FUNDING_MARGIN_MS + 2 * MIN) / 1000) } as never,
    });
    const d = scheduleAction({ kind: "fund-escrow", orderId: ORDER, dueAt: T0 }, session);
    await runScheduledAction(d, { masterSeed: new Uint8Array(32), deployment, escrowBalance: async () => 0n });
    expect(find(d.id)).toMatchObject({ waitsOnScan: true });
  });

  it("waitBehindScan puts a new object in the action's place — never the one the scheduler ran (ZV's critique) —, its failure kept; a missing one is planned", () => {
    scheduleAction({ kind: "fund-escrow", orderId: "0xa", dueAt: T0 }, session);
    session.update((j) => {
      Object.assign(
        j.schedule.find((x) => x.id === "fund-escrow:0xa")!,
        { error: "boom", errorCode: "internal", attempts: 5, nextAttemptAt: T0 + 9 * MIN },
      );
    });
    const ran = find("fund-escrow:0xa")!; // the object the scheduler ran
    const at = session.journal().schedule.indexOf(ran);
    waitBehindScan(ran, T0 + MIN, session);
    expect(find("fund-escrow:0xa"), "a new object").not.toBe(ran);
    expect(session.journal().schedule.indexOf(find("fund-escrow:0xa")!), "in the same place").toBe(at);
    expect(ran.dueAt, "the scheduler's copy keeps its time: planned again").toBe(T0);
    expect(find("fund-escrow:0xa")).toMatchObject({ dueAt: T0 + MIN, waitsOnScan: true, error: "boom", errorCode: "internal", attempts: 5 });
    expect(find("fund-escrow:0xa")!.nextAttemptAt).toBeUndefined();
    waitBehindScan({ id: "housekeeping:balance:2", kind: "housekeeping", orderId: "balance:2" }, T0 + MIN, session);
    expect(find("housekeeping:balance:2")).toMatchObject({ kind: "housekeeping", dueAt: T0 + MIN, waitsOnScan: true });
  });
});

describe("12b2d: the scan that frees the counters wakes what waited on it", () => {
  it("the marked actions and the campaign ticks, and nothing else: a funding's time drawn for privacy is kept", async () => {
    scheduleDiscovery(T0);
    noteStore.holdCounters();
    session.update((j) => {
      j.schedule.push(
        { id: "fund-escrow:0xa", kind: "fund-escrow", orderId: "0xa", dueAt: T0 + 9 * MIN, waitsOnScan: true },
        { id: "fund-escrow:0xb", kind: "fund-escrow", orderId: "0xb", dueAt: T0 + 9 * MIN }, // drawn for privacy
        { id: "housekeeping:balance:1", kind: "housekeeping", orderId: "balance:1", dueAt: T0 + 9 * MIN, waitsOnScan: true },
        { id: "campaign-tick:0xc", kind: "campaign-tick", orderId: "0xc", dueAt: T0 + 9 * MIN },
        { id: "order-tick:0xd", kind: "order-tick", orderId: "0xd", dueAt: T0 + 9 * MIN, waitsOnScan: true, done: true },
      );
    });
    scan.releases = true;
    await scanAt(T0);
    const due = (id: string) => session.journal().schedule.find((a) => a.id === id)!.dueAt;
    expect(due("fund-escrow:0xa"), "marked: woken").toBe(T0 + 1000);
    expect(due("housekeeping:balance:1"), "marked: woken").toBe(T0 + 1000);
    expect(due("campaign-tick:0xc"), "a campaign tick: woken").toBe(T0 + 1000);
    expect(due("fund-escrow:0xb"), "not marked: its drawn time kept").toBe(T0 + 9 * MIN);
    expect(due("order-tick:0xd"), "done: left alone").toBe(T0 + 9 * MIN);
  });

  it("a scan that fails, the counters still held, wakes nothing", async () => {
    scheduleDiscovery(T0);
    noteStore.holdCounters();
    session.update((j) => {
      j.schedule.push({ id: "fund-escrow:0xa", kind: "fund-escrow", orderId: "0xa", dueAt: T0 + 9 * MIN, waitsOnScan: true });
    });
    scan.fails = true;
    await scanAt(T0);
    expect(session.journal().schedule.find((a) => a.id === "fund-escrow:0xa")!.dueAt).toBe(T0 + 9 * MIN);
  });
});
