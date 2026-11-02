// @vitest-environment happy-dom
// The scheduler's last failure on the operation's detail (a V7 follow-up; audit gap 59): the catalog's words for the
// failure, the next attempt's time and number, the message itself under Advanced only, "Try again now" pulling the attempt
// to now and waking the scheduler; nothing while nothing failed; the progress component carries it for a swap's record.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { completeAction, isDue, onSchedulerKick, scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";
import { newOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { AttemptLine, attemptIdOf } from "../src/features/operations/AttemptLine";
import { OperationProgress } from "../src/features/operations/OperationProgress";

const NOW = 1_800_000_000_000;
beforeEach(async () => {
  await session.create("pw");
  session.acknowledgePhrase();
});
afterEach(() => {
  cleanup();
  session.forget();
  settings.reset();
  resetOperationsMemory();
});

describe("the attempt line", () => {
  it("names the failure in the catalog's words with the next attempt, keeps the message for Advanced, and offers the attempt now", () => {
    scheduleAction({ kind: "order-tick", orderId: "0xabc", dueAt: NOW - 10 });
    const { rerender } = render(<AttemptLine orderId="0xabc" />);
    expect(screen.queryByTestId("operation-attempt"), "nothing failed yet").toBeNull();
    act(() => {
      completeAction("order-tick:0xabc", "relayer unreachable: fetch failed", session, NOW, "relayer_unreachable");
    });
    const line = screen.getByTestId("operation-attempt");
    expect(line.getAttribute("data-code")).toBe("relayer_unreachable");
    expect(line.textContent).toContain("The last attempt did not go through");
    expect(line.textContent).toContain("Next attempt at");
    expect(line.textContent).toContain("(attempt 2)");
    expect(line.textContent, "the relayer's words, never the message itself on a Simple screen").not.toContain("fetch failed");
    expect(screen.queryByTestId("operation-attempt-detail")).toBeNull();
    act(() => {
      settings.set({ advanced: true });
    });
    rerender(<AttemptLine orderId="0xabc" />);
    expect(screen.getByTestId("operation-attempt-detail").textContent).toBe("relayer unreachable: fetch failed");
    let kicks = 0;
    const off = onSchedulerKick(() => kicks++);
    try {
      act(() => {
        fireEvent.click(screen.getByTestId("operation-attempt-retry"));
      });
    } finally {
      off();
    }
    const a = session.journal().schedule.find((x) => x.id === "order-tick:0xabc")!;
    expect(isDue(a, Date.now()), "due now").toBe(true);
    expect(kicks).toBe(1);
  });

  it("an unknown failure reads as the catalog's unknown; a done action shows nothing", () => {
    scheduleAction({ kind: "campaign-tick", orderId: "0xca", dueAt: NOW - 10 });
    completeAction("campaign-tick:0xca", "the pool moved during both attempts", session, NOW);
    render(<AttemptLine orderId="0xca" testId="campaign-attempt" />);
    expect(screen.getByTestId("campaign-attempt").getAttribute("data-code")).toBe("unknown");
    act(() => {
      completeAction("campaign-tick:0xca", undefined, session, NOW + 1);
    });
    expect(screen.queryByTestId("campaign-attempt")).toBeNull();
  });

  it("the progress of a swap's record carries the line, keyed by its campaign first, else its order", () => {
    const rec = newOperation({
      kind: "swap",
      amounts: { asset: "ETH", decimals: 18, input: "1000000000000000000" },
      destination: { kind: "privacy-address", display: "pp1…", chain: "ethereum" },
      tier: "standard",
    });
    expect(attemptIdOf({ id: "swap:0xdef", refs: { txHashes: [] } })).toBe("0xdef");
    expect(attemptIdOf({ id: "swap:0xdef", refs: { txHashes: [], orderId: "0xdef", campaignId: "0xca" } })).toBe("0xca");
    expect(attemptIdOf({ id: "protect:1", refs: { txHashes: [] } })).toBeNull();
    scheduleAction({ kind: "order-tick", orderId: "0xdef", dueAt: NOW - 10 });
    completeAction("order-tick:0xdef", "the escrow could not be read", session, NOW, "rpc_disagreement");
    render(<OperationProgress record={{ ...rec, id: "swap:0xdef", refs: { ...rec.refs, orderId: "0xdef" } }} testId="swap-progress" />);
    expect(screen.getByTestId("swap-progress-attempt").getAttribute("data-code")).toBe("rpc_disagreement");
  });
});
