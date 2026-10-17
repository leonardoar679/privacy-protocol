// @vitest-environment happy-dom
// Offline (spec v2.0 §7.11, §12.5; doc §75; V6 Stage 15): the banner's three lines while the connection is interrupted;
// the scheduler runs nothing while offline (the action stays due) and runs it once the browser is back online.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { act, render, screen, waitFor } from "@testing-library/react";
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { pendingActions, scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";
import type { ScheduledAction } from "@privacy-wallet/sdk/wallet/journal";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { useConnectivity, useScheduler } from "../src/hooks";
import { PROBE_MS, probe, startConnectivity } from "../src/platform/connectivity";
import { FAILURES_TO_OFFLINE } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { en } from "../src/app/i18n/en";

let stop: (() => void) | null = null;
beforeEach(async () => {
  await session.create("pw");
  session.acknowledgePhrase();
  stop = startConnectivity();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  stop?.();
  connectivity.reset();
  session.forget();
});

function Runner({ ran }: { ran: (a: ScheduledAction) => void }) {
  useScheduler(async (a) => ran(a), 60_000);
  const net = useConnectivity();
  return <span data-testid="net">{net.online ? "online" : "offline"}</span>;
}

describe("offline (doc §75)", () => {
  it("the banner's words are the document's", () => {
    expect([en["offline.title"], en["offline.preserved"], en["offline.noSubmit"]]).toEqual([
      "Connection interrupted",
      "Your transaction state is being preserved.",
      "We will not submit another transaction until the current state is verified.",
    ]);
  });

  it("offline for want of answers: the probe asks the relayer, and an answer brings the wallet back", async () => {
    for (let i = 0; i < FAILURES_TO_OFFLINE; i++) connectivity.unreachable();
    expect(connectivity.get()).toMatchObject({ online: false, cause: "unreachable" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await probe();
    expect(fetchSpy.mock.calls[0]?.[0]).toMatch(/\/info$/);
    expect(connectivity.get().online).toBe(true);
    fetchSpy.mockClear();
    await probe();
    expect(fetchSpy, "online: no probe").not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("the probe asks the services the wallet uses: the relayer down, the swap service's answer brings it back; the user's own relayer, never the build's default (the audit round of 2026-10-16, c60)", async () => {
    for (let i = 0; i < FAILURES_TO_OFFLINE; i++) connectivity.unreachable();
    const asked: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      asked.push(url);
      if (url.endsWith("/info")) throw new TypeError("Failed to fetch"); // the relayer is down
      return new Response("{}", { status: 200 });
    });
    try {
      await probe();
      expect(
        asked.some((u) => u.endsWith("/info")),
        "the relayer is asked",
      ).toBe(true);
      expect(
        asked.some((u) => u.endsWith("/v1/status")),
        "and the swap service",
      ).toBe(true);
      expect(connectivity.get().online, "an answer from any of them is the network back").toBe(true);
      const own = "http://127.0.0.1:18790";
      settings.set({ submission: { kind: "relayer", url: own } });
      for (let i = 0; i < FAILURES_TO_OFFLINE; i++) connectivity.unreachable();
      asked.length = 0;
      await probe();
      expect(
        asked.filter((u) => u.endsWith("/info")),
        "the user's relayer, not the build's",
      ).toEqual([`${own}/info`]);
      settings.set({ submission: { kind: "wallet" } });
      for (let i = 0; i < FAILURES_TO_OFFLINE; i++) connectivity.unreachable();
      asked.length = 0;
      await probe();
      expect(
        asked.some((u) => u.endsWith("/info")),
        "the connected wallet submits: no relayer is told",
      ).toBe(false);
    } finally {
      settings.reset();
      fetchSpy.mockRestore();
    }
  });

  it("a probe the relayer never answers ends when the next one starts: probes never pile up", async () => {
    for (let i = 0; i < FAILURES_TO_OFFLINE; i++) connectivity.unreachable();
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    let done = false;
    void probe().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(PROBE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(connectivity.get().online, "no answer: still offline").toBe(false);
    expect(vi.getTimerCount() <= 1, "only the probe interval is left").toBe(true);
    fetchSpy.mockRestore();
  });

  it("nothing runs while offline; back online the due action runs", async () => {
    act(() => void window.dispatchEvent(new Event("offline")));
    scheduleAction({ kind: "order-tick", orderId: "0xabc", dueAt: Date.now() - 1 });
    const ran = vi.fn();
    render(<Runner ran={ran} />);
    expect(screen.getByTestId("net").textContent).toBe("offline");
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).not.toHaveBeenCalled();
    expect(
      pendingActions().filter((a) => !a.done),
      "the action stays due",
    ).toHaveLength(1);
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(ran).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("net").textContent).toBe("online");
  });
});
