// @vitest-environment happy-dom
// The App-level scheduler (V2 Stage 4): due actions run one at a time (two due fundings could otherwise
// spend the same notes), a failed action is retried with backoff instead of every poll, a cancelled
// action never runs, and the runner's status is visible to the screens.
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { session } from "../src/wallet/session";
import { backoffMs, BACKOFF_BASE_MS, BACKOFF_MAX_MS, cancelAction, completeAction, isDue, pendingActions, scheduleAction, schedulerStatus, useScheduler } from "../src/wallet/schedule";
import type { ScheduledAction } from "../src/wallet/journal";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); schedulerStatus.reset(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the scheduler runner", () => {
  it("backoff: 10 min, doubling, capped at 6 h; a failed action is not due again before it", () => {
    expect(backoffMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffMs(3)).toBe(4 * BACKOFF_BASE_MS);
    expect(backoffMs(20)).toBe(BACKOFF_MAX_MS);
    const now = 1_700_000_000_000;
    const a: ScheduledAction = { id: "fund-escrow:0x1", kind: "fund-escrow", orderId: "0x1", dueAt: now - 1, attempts: 2, nextAttemptAt: now + 60_000 };
    expect(isDue(a, now)).toBe(false);
    expect(isDue(a, now + 60_000)).toBe(true);
  });

  it("runs due actions serially, records a failure with backoff, skips it until then, and never runs a cancelled one", async () => {
    await session.create("pw");
    session.acknowledgePhrase();
    const now = Date.now();
    scheduleAction({ kind: "fund-escrow", orderId: "0xaaa", dueAt: now - 10 });
    scheduleAction({ kind: "fund-escrow", orderId: "0xbad", dueAt: now - 10 });
    scheduleAction({ kind: "fund-escrow", orderId: "0xccc", dueAt: now - 10 });
    scheduleAction({ kind: "fund-escrow", orderId: "0xgone", dueAt: now - 10 });
    cancelAction("fund-escrow:0xgone");
    const ran: string[] = [];
    let concurrent = 0, maxConcurrent = 0;
    const run = async (a: ScheduledAction) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      ran.push(a.orderId);
      await sleep(25);
      concurrent--;
      if (a.orderId === "0xbad") throw new Error("relayer unreachable");
    };
    function Runner() { useScheduler(run, 15); return null; }
    const container = document.createElement("div");
    await act(async () => { root = createRoot(container); root.render(<Runner />); });
    await vi.waitFor(() => expect(ran).toEqual(["0xaaa", "0xbad", "0xccc"]), { timeout: 5_000 });
    await act(async () => { await sleep(80); }); // a few more polls
    expect(ran, "the failed action waits for its backoff; the cancelled one never ran").toEqual(["0xaaa", "0xbad", "0xccc"]);
    expect(maxConcurrent).toBe(1);
    const bad = session.journal().schedule.find((a) => a.orderId === "0xbad")!;
    expect(bad.done).toBe(false);
    expect(bad.error).toBe("relayer unreachable");
    expect(bad.attempts).toBe(1);
    expect(bad.nextAttemptAt).toBeGreaterThan(Date.now() + BACKOFF_BASE_MS - 5_000);
    expect(pendingActions().map((a) => a.orderId)).toEqual(["0xbad"]);
    expect(schedulerStatus.get().lastError?.message).toBe("relayer unreachable");
    // the backoff elapsed (the journal is the clock): it runs again
    await act(async () => { completeAction("fund-escrow:0xbad", "relayer unreachable", session, Date.now() - 2 * BACKOFF_MAX_MS); });
    await vi.waitFor(() => expect(ran.filter((x) => x === "0xbad")).toHaveLength(2), { timeout: 5_000 });
    expect(session.journal().schedule.find((a) => a.orderId === "0xbad")!.attempts).toBe(3);
  });
});
