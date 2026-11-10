// @vitest-environment happy-dom
// The twelfth review round, 2026-11-10, 12b2d (ZV's critique): the scheduled spends wait behind the scan the counters wait on through the real
// scheduler (useScheduler), as the app runs them — a funding delayed for privacy whose time passed while the wallet was locked, its tick ahead of
// the scan in the journal, waits at the unlock, the scan runs, frees the counters and wakes it, and it funds; a fund-escrow and a housekeeping
// step waiting so stay pending. The scheduler tells a run that planned its action again by the object it ran: the wait moved that object in
// place, and every wait had been marked done and never run again. And the attempt line of an action waiting so says its next attempt comes
// once the pool is read, with no Try again now. Offline: the scan stubbed, the order runner's world injected, the housekeeping step counted.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  scanNotes: async () => {
    (await import("@privacy-wallet/sdk/wallet/notes")).noteStore.releaseCounters(0); // a complete scan
    return { scanned: 10, found: 0, added: 0, spent: 0, refunds: 0, received: [], pending: [], proven: null };
  },
}));
const housekeeping = vi.hoisted(() => ({ steps: 0 }));
vi.mock("@privacy-wallet/sdk/wallet/housekeeping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/wallet/housekeeping")>()),
  runHousekeepingStep: async () => {
    housekeeping.steps++;
    return { ran: null, waitedForCap: false };
  },
}));

import type { Deployment } from "@privacy-wallet/sdk/chain";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { activityId, recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { scheduleAction, schedulerStatus } from "@privacy-wallet/sdk/wallet/schedule";
import { patchSwap, runScheduledAction } from "@privacy-wallet/sdk/swapFunding";
import { resetOrderRunnerMemory, runOrderTick, type OrderIo } from "@privacy-wallet/sdk/wallet/orderRunner";
import { resetDiscoveryMemory, runDiscovery } from "@privacy-wallet/sdk/wallet/discovery";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import type { ScheduledAction, StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { useScheduler } from "../src/hooks";
import { AttemptLine } from "../src/features/operations/AttemptLine";
import { en } from "../src/app/i18n/en";

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
const find = (id: string) => session.journal().schedule.find((a) => a.id === id);
const settle = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(async () => {
  await session.create("a strong password");
  session.acknowledgePhrase();
  // the wallet holds something: its scans are wanted (a first launch stays request-free, spec v2.0 §10)
  recordActivity({ id: activityId("receive", "1"), kind: "receive", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x01" } as never);
});
afterEach(() => {
  noteStore.releaseCounters(0);
  housekeeping.steps = 0;
  schedulerStatus.reset();
  resetOrderRunnerMemory();
  resetDiscoveryMemory();
  resetOperationsMemory();
  session.forget();
});

/** a one-confirmation order delayed for privacy, its drawn time passed while the wallet was locked */
function delayedOrder(): void {
  const now = Date.now();
  const st = {
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
    createdAt: now,
    state: "committed",
    refundNoteData: "0x00",
    runner: { confirmedAt: now, delayUntil: now - 1 },
  } as unknown as StoredSwap;
  session.update((j) => {
    j.swaps = [st];
  });
}
/** the scheduler as Background runs it: one action at a time, a short poll; `run` dispatches as Background does */
function Runner({ run }: { run: (a: ScheduledAction) => Promise<void> }) {
  useScheduler(run, 20, session);
  return null;
}

describe("12b2d through the real scheduler (ZV's critique)", () => {
  it("a funding delayed for privacy, due at an unlock, its tick ahead of the scan: it waits, the scan runs and frees the counters, and the woken tick funds — never marked done while it waits", async () => {
    delayedOrder();
    scheduleAction({ kind: "order-tick", orderId: ORDER, dueAt: Date.now() - 10 }, session); // ahead of the scan in the journal
    scheduleAction({ kind: "discovery", orderId: "pool", dueAt: Date.now() }, session); // the unlock's scan
    noteStore.holdUntilScanned(); // every opening's hold
    let funds = 0;
    const io = {
      fund: async (st: StoredSwap) => {
        funds++;
        patchSwap(st.orderId, { fundedTx: "0xf00d", state: "funded" }, session);
        return { txHash: "0xf00d" };
      },
      escrowBalance: async () => 0n,
      job: async () => null,
      precheck: async () => null,
      track: async () => ({ tracked: { state: "PENDING", label: "Pending" }, job: null }),
    } as unknown as OrderIo;
    const log: string[] = [];
    let waiting: ScheduledAction | undefined;
    const run = async (a: ScheduledAction) => {
      if (a.kind === "order-tick") {
        const r = await runOrderTick(a, { masterSeed: new Uint8Array(32), deployment: null, io, session });
        log.push(`order:${r?.step}`);
      } else if (a.kind === "discovery") {
        // the scheduler has handled the order tick's run by now (one action at a time): its journal state as the scheduler left it (ZW's critique)
        waiting ??= { ...find(`order-tick:${ORDER}`)! };
        await runDiscovery(a, { masterSeed: new Uint8Array(32), deployment, session });
        log.push("scan");
      }
    };
    render(<Runner run={run} />);
    await settle(2_500); // the wait, the scan, the wake a second after it, a few polls
    expect(log[0], "the tick ran first and waited").toBe("order:delayed");
    expect(waiting, "behind the scan, marked, never done").toMatchObject({ waitsOnScan: true });
    expect(waiting!.done).toBeFalsy();
    expect(log).toContain("scan");
    expect(noteStore.countersHeld()).toBe(false);
    expect(funds, "funded once the scan freed the counters").toBe(1);
    expect(log.indexOf("order:funded")).toBeGreaterThan(log.indexOf("scan"));
  });

  it("a fund-escrow and a housekeeping step waiting behind the scan stay pending in the scheduler — the scan not yet run", async () => {
    delayedOrder();
    session.update((j) => {
      j.swaps[0] = { ...j.swaps[0], runner: undefined };
    });
    scheduleAction({ kind: "fund-escrow", orderId: ORDER, dueAt: Date.now() - 10 }, session);
    scheduleAction({ kind: "housekeeping", orderId: "balance:1", dueAt: Date.now() - 10 }, session);
    scheduleAction({ kind: "discovery", orderId: "pool", dueAt: Date.now() + 4 * 60_000 }, session); // the scan, backed off
    noteStore.holdCounters();
    const ran: string[] = [];
    const run = async (a: ScheduledAction) => {
      ran.push(a.id);
      if (a.kind === "fund-escrow" || a.kind === "housekeeping") await runScheduledAction(a, { masterSeed: new Uint8Array(32), deployment, session, escrowBalance: async () => 0n });
    };
    render(<Runner run={run} />);
    await settle(300);
    expect(ran).toContain(`fund-escrow:${ORDER}`);
    expect(ran).toContain("housekeeping:balance:1");
    for (const id of [`fund-escrow:${ORDER}`, "housekeeping:balance:1"]) {
      expect(find(id), id).toMatchObject({ waitsOnScan: true });
      expect(find(id)!.done, `${id}: pending behind the scan`).toBeFalsy();
    }
    expect(housekeeping.steps, "no merge or split asked").toBe(0);
  });
});

describe("12b2d: the attempt line of an action waiting behind the scan (ZV's critique)", () => {
  it("its last failure kept, its next attempt once the pool is read, no Try again now — a tap would only wait again", () => {
    scheduleAction({ kind: "order-tick", orderId: ORDER, dueAt: Date.now() + 60_000 }, session);
    session.update((j) => {
      Object.assign(j.schedule.find((a) => a.id === `order-tick:${ORDER}`)!, { error: "fetch failed", errorCode: "relayer_unreachable", attempts: 2, waitsOnScan: true });
    });
    render(<AttemptLine orderId={ORDER} />);
    expect(screen.getByTestId("operation-attempt").textContent).toContain(en["progress.attemptFailed"].split("{reason}")[0]);
    expect(screen.getByTestId("operation-attempt-after-scan").textContent).toBe(en["progress.attemptAfterScan"]);
    expect(screen.queryByTestId("operation-attempt-retry")).toBeNull();
  });

  it("an attempt that failed and is not waiting keeps its time and its Try again now", () => {
    scheduleAction({ kind: "order-tick", orderId: ORDER, dueAt: Date.now() }, session);
    session.update((j) => {
      Object.assign(j.schedule.find((a) => a.id === `order-tick:${ORDER}`)!, { error: "fetch failed", errorCode: "relayer_unreachable", attempts: 2, nextAttemptAt: Date.now() + 20 * 60_000 });
    });
    render(<AttemptLine orderId={ORDER} />);
    expect(screen.queryByTestId("operation-attempt-after-scan")).toBeNull();
    expect(screen.getByTestId("operation-attempt-retry")).toBeTruthy();
  });
});
