// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), the screens' flows (review E: E11-5, E11-6, E11-7, E11-12, E11-13): Activity's warning over a
// failed scheduled action says what failed and where its funds are — never "Your funds have not moved." for a funded order —; a Send, a
// Protect or a Swap that stopped or finished is announced (the verdict card an alert, the result a status, the progress page's live
// line naming the step in hand, the detail's error line an alert); a timeline ends where its record did, and a record that needs recovery
// has no busy "Confirming on the network…" bar; the Review's Protected execution card ticks a check only while its fact holds; Protect's
// Max of ETH leaves the deposit's network fee, and an amount that leaves less is refused in words before the Review.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { getAddress } from "viem";
import { SuccessCard } from "@privacy-wallet/ui";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { reasonOf, recoveryFor } from "@privacy-wallet/sdk/operations/reducer";
import { putOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import type { ScheduledAction, StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import { en } from "../src/app/i18n/en";
import { t } from "../src/app/i18n/messages";
import { Activity, failureWarning } from "../src/features/activity/Activity";
import { Detail } from "../src/features/activity/Detail";
import { stepsOf } from "../src/features/activity/model";
import { REVIEW_FIXTURES } from "../src/features/flowFixtures";
import { OperationProgress } from "../src/features/operations/OperationProgress";
import { furthestLine, progressModelOf } from "../src/features/progress/model";
import { ProgressView } from "../src/features/progress/View";
import { ProtectScreen } from "../src/features/protect/ProtectScreen";
import { maxProtect, protectModel } from "../src/features/protect/model";
import { ReviewView, type ReviewModel } from "../src/features/review/View";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { prefs } from "../src/storage/prefs";
import { record } from "./helpers/operations";

// the order tracker of the detail's Refresh, failing on demand (E11-6)
const tracker = vi.hoisted(() => ({ fail: false }));
vi.mock("@privacy-wallet/sdk/orderTracker", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/orderTracker")>();
  return {
    ...orig,
    trackOrder: async (...args: Parameters<typeof orig.trackOrder>) => {
      if (tracker.fail) throw new Error("the provider's status did not answer");
      return orig.trackOrder(...args);
    },
  };
});

beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  session.forget();
  settings.reset();
  prefs().reset();
  resetOperationsMemory();
  setActiveProvider(null);
  tracker.fail = false;
});

const E = 10n ** 18n;
const NOW = Date.now();
const ORDER = "0x" + "0a".repeat(32);
const STEP = "0x" + "5e".repeat(32);
const ETH_REF = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC_REF = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
async function unlocked() {
  await session.create("a strong password");
  session.acknowledgePhrase();
}
const order = (over: Partial<StoredSwap> = {}): StoredSwap =>
  ({
    orderId: ORDER,
    attemptId: "0x" + "0b".repeat(32),
    refundCounter: 1,
    provider: "thorchain",
    policy: "balanced",
    request: { from: ETH_REF, to: BTC_REF, amount: E.toString(), destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", destinationKind: "fresh" },
    params: { amount: E.toString() },
    endpoint: "0x" + "0c".repeat(20),
    createdAt: NOW - 60_000,
    state: "committed",
    ...over,
  }) as StoredSwap;
const FUNDED = { state: "funded", fundedTx: "0x" + "11".repeat(32) } as const;
/** A swap's record, as the runners keep it. */
const swapRecord = (orderId: string, over: Partial<OperationRecord> = {}): OperationRecord =>
  record({
    id: `swap:${orderId}`,
    kind: "cross-chain",
    state: "PROVIDER_EXECUTING",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1000,
    destination: { kind: "fresh", display: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", chain: "bitcoin" },
    refs: { txHashes: ["0x" + "11".repeat(32)], orderId },
    history: [
      { state: "SOURCE_CONFIRMING", at: NOW - 50_000 },
      { state: "PROVIDER_EXECUTING", at: NOW - 40_000 },
    ],
    ...over,
  });
const failing = (kind: ScheduledAction["kind"], orderId: string, error = "fetch failed"): ScheduledAction => ({
  id: `${kind}:${orderId}`,
  kind,
  orderId,
  dueAt: NOW - 1000,
  error,
  attempts: 1,
  nextAttemptAt: NOW + 600_000,
});

describe("E11-5: Activity's warning over a failed scheduled action says what failed and where its funds are", () => {
  async function activity(swaps: StoredSwap[], schedule: ScheduledAction[], records: OperationRecord[] = []) {
    await unlocked();
    session.update((j) => {
      j.swaps = swaps;
      j.schedule = schedule;
    });
    for (const r of records) putOperation(r);
    render(<Activity onOpen={vi.fn()} />);
  }
  const card = () => screen.getByTestId("activity-funding-warning").textContent ?? "";
  const NOT_MOVED = /not moved/i;

  // the probe's words (review11/E's funding-warning probe): "A scheduled funding did not go through … Your funds have not moved."
  const PROBE = en["activity.fundingFailedTitle"];

  it("a funded order's tick that failed: an automatic step, its funds as its record has them — 'checking' while it runs, never 'not moved'", async () => {
    await activity([order(FUNDED)], [failing("order-tick", ORDER, "the escrow could not be read")], [swapRecord(ORDER)]);
    expect(card(), "nothing was being funded").not.toContain(PROBE);
    expect(card(), "the order was funded").not.toMatch(NOT_MOVED);
    expect(card()).toBe(en["activity.stepFailedTitle"] + t("activity.stepFailedBody", { funds: en["op.funds.unknown"] }));
  });

  it("a funded order whose escrow holds the funds reads 'still protected' — its record's class", async () => {
    const paused = swapRecord(ORDER, { state: "RECOVERY_REQUIRED", reason: reasonOf("execution_window_closed", "unknown") });
    await activity([order(FUNDED)], [failing("order-tick", ORDER)], [paused]);
    expect(card()).not.toMatch(NOT_MOVED);
    expect(card()).toContain(en["op.funds.stillProtected"]);
  });

  it("a protected swap's refund of a funded step that failed (the wind-down) reads its open step's class, never a funding", async () => {
    const step = order({ ...FUNDED, orderId: STEP, campaign: { id: "campaign-1", index: 1 } });
    const stepRecord = swapRecord(STEP, { refs: { txHashes: ["0x" + "11".repeat(32)], orderId: STEP, campaignId: "campaign-1" } });
    await activity([step], [failing("campaign-tick", "campaign-1", "returning step 2 failed: relayer unreachable")], [stepRecord]);
    expect(card()).not.toContain(PROBE);
    expect(card()).not.toMatch(NOT_MOVED);
    expect(card()).toContain(en["op.funds.unknown"]);
  });

  it("a funding that failed keeps its own words while nothing was sent — and once its transaction is on its way it is never 'not moved'", async () => {
    await activity([order()], [failing("fund-escrow", ORDER)]);
    expect(card(), "nothing sent: the funding's own words, as before").toBe(en["activity.fundingFailedTitle"] + en["activity.fundingFailedBody"]);
    cleanup();
    session.forget();
    resetOperationsMemory();
    const sent = order({ fundingAttempt: { nullifiers: ["1", "2"], by: "relayer", at: NOW - 5000 } });
    await activity(
      [sent],
      [failing("fund-escrow", ORDER, "the funding's fate is not known yet")],
      [swapRecord(ORDER, { state: "AWAITING_AUTHORIZATION", history: [] })],
    );
    expect(card()).not.toMatch(NOT_MOVED);
    expect(card()).toContain(en["op.funds.unknown"]);
  });

  it("an order's tick that failed before its funding: an automatic step whose funds were not moved", async () => {
    await activity([order()], [failing("order-tick", ORDER)], [swapRecord(ORDER, { state: "AWAITING_AUTHORIZATION", history: [] })]);
    expect(card(), "a tick is no funding").not.toContain(PROBE);
    expect(card()).toBe(en["activity.stepFailedTitle"] + t("activity.stepFailedBody", { funds: en["op.funds.notMoved"] }));
  });

  it("a maintenance run and a finished order's leftover raise no card; Advanced names each in its own words", async () => {
    await activity([order({ state: "abandoned" })], [failing("housekeeping", "balance:1"), failing("order-tick", ORDER)]);
    expect(screen.queryByTestId("activity-funding-warning"), "nothing waits on them: no card").toBeNull();
    cleanup();
    settings.set({ advanced: true });
    render(<Activity onOpen={vi.fn()} />);
    fireEvent.click(screen.getByTestId("activity-advanced-toggle"));
    const lines = screen.getAllByTestId("activity-failed-action").map((p) => p.textContent ?? "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(t("activity.actionFailed", { ref: "balance:1", error: "fetch failed", next: "" }).trim());
    for (const l of lines) expect(l, "never a funding's words for another action").not.toContain(en["activity.fundingFailed"].split(" {ref}")[0]);
  });

  it("the rule: the gravest class of what failed decides; a scan and maintenance never count", () => {
    const j = { swaps: [order(FUNDED), order({ orderId: STEP })], campaigns: [] };
    const recs = [swapRecord(ORDER, { state: "RECOVERY_REQUIRED", reason: reasonOf("execution_window_closed", "unknown") })];
    expect(failureWarning([failing("discovery", "pool"), failing("housekeeping", "balance:1")], j, recs)).toBeNull();
    expect(failureWarning([failing("fund-escrow", STEP)], j, recs)).toEqual({ kind: "funding" });
    expect(failureWarning([failing("fund-escrow", STEP), failing("order-tick", ORDER)], j, recs)).toEqual({ kind: "step", funds: "still-protected" });
    // a funded order's record that says "not moved" is read "we are checking": a funded order is never "not moved"
    const odd = [swapRecord(ORDER, { state: "RECOVERY_REQUIRED", reason: reasonOf("fee_moved", "unknown") })];
    expect(failureWarning([failing("order-tick", ORDER)], j, odd)).toEqual({ kind: "step", funds: "unknown" });
    // a protected swap whose funded step finished as asked reads "still protected" (the rest never left); one whose step was not delivered
    // as asked (E11-1: refunded at the destination in another asset) never does; a protected swap that ended raises nothing
    const done = order({ orderId: STEP, state: "completed", fundedTx: "0x" + "11".repeat(32), campaign: { id: "c-2", index: 0 } });
    const settled = swapRecord(STEP, { state: "COMPLETED", refs: { txHashes: [], orderId: STEP, campaignId: "c-2" } });
    expect(failureWarning([failing("campaign-tick", "c-2")], { swaps: [done], campaigns: [] }, [settled])).toEqual({ kind: "step", funds: "still-protected" });
    expect(failureWarning([failing("campaign-tick", "c-2")], { swaps: [done], campaigns: [] }, [{ ...settled, outcome: "refunded-at-destination" }])).toEqual({
      kind: "step",
      funds: "unknown",
    });
    expect(failureWarning([failing("campaign-tick", "c-2")], { swaps: [done], campaigns: [] }, []), "a funded step without its record").toEqual({
      kind: "step",
      funds: "unknown",
    });
    expect(failureWarning([failing("campaign-tick", "c-2")], { swaps: [done], campaigns: [{ id: "c-2", state: "completed" }] as never }, [settled])).toBeNull();
    // two failures whose classes differ: the graver decides, in either order (the third critique: `graver` had never been asked to choose) —
    // a paused one-order swap is still protected, a protected swap's step with its provider is not known
    const step = order({ orderId: STEP, state: "funded", fundedTx: "0x" + "11".repeat(32), campaign: { id: "c-3", index: 0 } });
    const two = { swaps: [order(FUNDED), step], campaigns: [] };
    const recs2 = [
      swapRecord(ORDER, { state: "RECOVERY_REQUIRED", reason: reasonOf("execution_window_closed", "unknown") }),
      swapRecord(STEP, { refs: { txHashes: [], orderId: STEP, campaignId: "c-3" } }),
    ];
    expect(failureWarning([failing("order-tick", ORDER)], two, recs2)).toEqual({ kind: "step", funds: "still-protected" });
    expect(failureWarning([failing("order-tick", ORDER), failing("campaign-tick", "c-3")], two, recs2)).toEqual({ kind: "step", funds: "unknown" });
    expect(failureWarning([failing("campaign-tick", "c-3"), failing("order-tick", ORDER)], two, recs2)).toEqual({ kind: "step", funds: "unknown" });
    // one protected swap, two funded steps: one finished, one with its provider — the graver of the two
    const STEP2 = "0x" + "5f".repeat(32);
    const steps = {
      swaps: [
        order({ orderId: STEP, state: "completed", fundedTx: "0x" + "11".repeat(32), campaign: { id: "c-4", index: 0 } }),
        order({ orderId: STEP2, state: "funded", fundedTx: "0x" + "12".repeat(32), campaign: { id: "c-4", index: 1 } }),
      ],
      campaigns: [],
    };
    const recs3 = [
      swapRecord(STEP, { state: "COMPLETED", refs: { txHashes: [], orderId: STEP, campaignId: "c-4" } }),
      swapRecord(STEP2, { refs: { txHashes: [], orderId: STEP2, campaignId: "c-4" } }),
    ];
    expect(failureWarning([failing("campaign-tick", "c-4")], steps, recs3)).toEqual({ kind: "step", funds: "unknown" });
  });
});

describe("E11-6: a Send, a Protect or a Swap that stopped or finished is announced", () => {
  it("the verdict card is an alert, read out the moment it appears; the result card a status", () => {
    const stopped = record({ kind: "withdraw", state: "FAILED", reason: reasonOf("fee_moved", "unknown"), history: [{ state: "FAILED", at: NOW }] });
    render(<OperationProgress record={stopped} />);
    const card = screen.getByTestId("operation-progress-error");
    expect(card).toHaveAttribute("role", "alert");
    expect(screen.getByRole("alert")).toBe(card);
    expect(card.textContent).toContain(t("op.error.fee_moved.title"));
    cleanup();
    render(<SuccessCard title="Sent 1 ETH privately." testId="send-done" />);
    expect(screen.getByRole("status")).toBe(screen.getByTestId("send-done"));
  });

  it("the progress page's live line names the step in hand, and the same region changes with it", () => {
    const at = (step: "merging" | "fee-terms" | "proof") => {
      const r = record({ kind: "withdraw", state: "PREPARING_PROOF", progress: { step } });
      return progressModelOf(r, furthestLine(0, r));
    };
    const { rerender } = render(<ProgressView model={at("merging")} />);
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live.textContent).toContain(en["screen.progress.balance"]);
    rerender(<ProgressView model={at("fee-terms")} />);
    expect(screen.getByRole("status"), "one region whose words change: a reader hears the change").toBe(live);
    expect(live.textContent).toContain(en["screen.progress.fees"]);
    rerender(<ProgressView model={at("proof")} />);
    expect(live.textContent).toContain(en["screen.progress.securing"]);
    expect(live.textContent, "the Simple words").not.toMatch(/\bproofs?\b/i);
  });

  it("a Refresh that fails on the Activity detail is an alert", async () => {
    await unlocked();
    tracker.fail = true;
    session.update((j) => {
      j.swaps = [order(FUNDED)];
    });
    recordActivity({
      id: `swap:${ORDER}`,
      kind: "swap",
      asset: "ETH",
      decimals: 18,
      amount: E.toString(),
      status: "funded",
      ref: ORDER,
      note: "→ BTC",
      at: NOW - 1000,
    });
    putOperation(swapRecord(ORDER));
    render(<Detail id={`swap:${ORDER}`} onBack={() => {}} />);
    fireEvent.click(screen.getByTestId("detail-refresh"));
    const line = await screen.findByTestId("detail-error");
    expect(line).toHaveAttribute("role", "alert");
    // in the detail's own words, never the tracker's English (E11-10; the critique: only the role had been pinned)
    expect(line.textContent).toBe(en["activity.refreshFailed"]);
    expect(line.textContent).not.toContain("the provider's status did not answer");
    act(() => settings.set({ advanced: true }));
    fireEvent.click(screen.getByTestId("detail-refresh"));
    await waitFor(() =>
      expect(screen.getByTestId("detail-error").textContent, "under Advanced, the thrown text after them").toBe(
        `${en["activity.refreshFailed"]} (the provider's status did not answer)`,
      ),
    );
  });
});

describe("E11-7: the timelines say what the record knows", () => {
  const returned = (over: Partial<OperationRecord> = {}) =>
    swapRecord(ORDER, {
      state: "REFUNDED",
      history: [
        { state: "SOURCE_CONFIRMING", at: NOW - 8000 },
        { state: "PROVIDER_EXECUTING", at: NOW - 7000 },
        { state: "REFUNDING", at: NOW - 6000 },
        { state: "REFUNDED", at: NOW },
      ],
      ...over,
    });
  // a swap below the $50K band is "Submitted", never "Protected execution submitted" (the critique of E11-7: a $200 swap's had read so)
  const SWAP_DONE = [en["activity.step.quote"], en["activity.step.authorized"], en["progress.stepSubmitted"]];

  it("a swap's submission is 'Submitted' below the band and 'Protected execution submitted' at it (the critique of E11-7)", () => {
    expect(stepsOf(returned(), t).map((s) => s.label)).toContain(en["progress.stepSubmitted"]);
    expect(stepsOf(returned(), t).map((s) => s.label)).not.toContain(en["activity.step.submitted"]);
    for (const tier of ["large-protected", "high-value", "institutional"] as const)
      expect(stepsOf(returned({ tier }), t).map((s) => s.label), tier).toContain(en["activity.step.submitted"]);
  });

  it("a swap that came back ends with 'Returned to your balance' — 'Returning to your balance' while it returns —, never 'Destination settlement' and 'Complete' waiting for good", () => {
    expect(stepsOf(returned(), t)).toEqual([...SWAP_DONE.map((label) => ({ label, state: "done" })), { label: en["progress.stepRefunded"], state: "done" }]);
    const returning = stepsOf(
      returned({
        state: "REFUNDING",
        history: [
          { state: "SOURCE_CONFIRMING", at: NOW - 8000 },
          { state: "REFUNDING", at: NOW },
        ],
      }),
      t,
    );
    expect(returning.at(-1), "the present tense while the funds are on their way (the critique of E11-7)").toEqual({ label: en["op.state.REFUNDING"], state: "active" });
    expect(returning.some((s) => s.state === "waiting")).toBe(false);
    // a refund reconciled with nothing earlier in its history: its funding was sent all the same
    expect(stepsOf(returned({ history: [{ state: "REFUNDED", at: NOW }] }), t).map((s) => s.label)).toEqual([...SWAP_DONE, en["progress.stepRefunded"]]);
  });

  it("a refund after a failed delivery ends at its funding's submission: the settlement that failed is never ✓ (the third critique)", () => {
    for (const state of ["REFUNDING", "REFUNDED"] as const) {
      const labels = stepsOf(
        returned({
          state,
          history: [
            { state: "SOURCE_CONFIRMING", at: NOW - 9000 },
            { state: "PROVIDER_EXECUTING", at: NOW - 8000 },
            { state: "DESTINATION_CONFIRMING", at: NOW - 7000 },
            { state: "REFUNDING", at: NOW - 6000 },
            ...(state === "REFUNDED" ? [{ state: "REFUNDED" as const, at: NOW }] : []),
          ],
        }),
        t,
      ).map((s) => s.label);
      expect(labels, state).not.toContain(en["activity.step.settlement"]);
      expect(labels.slice(0, 3), state).toEqual(SWAP_DONE);
    }
  });

  it("a cancellation and a final failure end where they stopped: nothing after them is still to come", () => {
    const cancelled = stepsOf(
      swapRecord(ORDER, {
        state: "CANCELLED",
        history: [
          { state: "READY_TO_REVIEW", at: NOW - 3000 },
          { state: "AWAITING_AUTHORIZATION", at: NOW - 2000 },
          { state: "CANCELLED", at: NOW },
        ],
      }),
      t,
    );
    expect(cancelled).toEqual([
      { label: en["activity.step.quote"], state: "done" },
      { label: en["op.state.CANCELLED"], state: "failed" },
    ]);
    const failedSend = stepsOf(
      record({
        kind: "send",
        state: "FAILED",
        history: [
          { state: "READY_TO_REVIEW", at: 1 },
          { state: "AWAITING_AUTHORIZATION", at: 2 },
          { state: "PREPARING_PROOF", at: 3 },
          { state: "FAILED", at: 4 },
        ],
      }),
      t,
    );
    expect(failedSend.map((s) => s.state)).toEqual(["done", "done", "failed"]);
    // a record that needs recovery may still go on: the steps after it wait
    const recovering = stepsOf(swapRecord(ORDER, { state: "RECOVERY_REQUIRED", reason: reasonOf("execution_window_closed", "unknown") }), t);
    expect(recovering.map((s) => s.state)).toEqual(["done", "done", "done", "failed", "waiting"]);
  });

  it("a Protect's and a Send's submission is 'Submitted', never the band's 'Protected execution submitted'; a swap at the band keeps it (the critique of E11-7: below the band, 'Submitted')", () => {
    const history = [
      { state: "AWAITING_AUTHORIZATION" as const, at: 1 },
      { state: "SOURCE_CONFIRMING" as const, at: 2 },
      { state: "COMPLETED" as const, at: 3 },
    ];
    for (const kind of ["protect", "send", "withdraw"] as const) {
      const labels = stepsOf(record({ kind, state: "COMPLETED", history }), t).map((s) => s.label);
      expect(labels, kind).not.toContain(en["activity.step.submitted"]);
      expect(labels, kind).toContain(en["progress.stepSubmitted"]);
    }
    expect(stepsOf(swapRecord(ORDER, { state: "COMPLETED", tier: "large-protected" }), t).map((s) => s.label)).toContain(en["activity.step.submitted"]);
    expect(stepsOf(swapRecord(ORDER, { state: "COMPLETED" }), t).map((s) => s.label)).toContain(en["progress.stepSubmitted"]);
  });

  it("a record that needs recovery has its card and no busy 'Confirming on the network…' bar; one under way keeps the bar", () => {
    for (const code of ["execution_window_closed", "provider_failed"]) {
      const r0 = swapRecord(ORDER, { state: "RECOVERY_REQUIRED", reason: reasonOf(code, "unknown") });
      render(<OperationProgress record={{ ...r0, recovery: recoveryFor(r0, code, NOW) }} />);
      expect(screen.getByTestId("operation-progress-error"), code).toBeTruthy();
      expect(screen.queryByRole("progressbar"), `${code}: the card asks the user to act, nothing is confirming`).toBeNull();
      cleanup();
    }
    render(<OperationProgress record={swapRecord(ORDER)} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-label", en["progress.confirming"]);
  });
});

describe("E11-12: the Review's Protected execution card ticks a check only while its fact holds", () => {
  const large = (over: Partial<ReviewModel>): ReviewModel => ({ ...REVIEW_FIXTURES.large, ...over });
  const checks = () =>
    within(screen.getByTestId("review-protected-execution"))
      .getAllByRole("listitem")
      .map((li) => [li.getAttribute("data-state"), li.textContent]);
  const actions = { onConfirm: () => {}, onEdit: () => {} };

  it("a typed-in destination not yet re-confirmed and a route not healthy: neither is ticked (the probe's four green ticks); both done, all four", () => {
    render(
      <ReviewView model={large({ destination: { label: "bc1qxy…0wlh", verified: false }, routeHealthy: false, confirmDisabled: true })} actions={actions} />,
    );
    expect(checks().map(([state]) => state)).toEqual(["open", "ok", "fail", "ok", "ok"]);
    expect(checks()).toEqual([
      ["open", `○ ${en["screen.review.large.destinationOpen"]}`],
      ["ok", `✓ ${en["screen.review.large.quote"]}`],
      ["fail", `⚠ ${en["screen.review.large.routeOpen"]}`],
      ["ok", `✓ ${en["screen.review.large.limits"]}`],
      ["ok", `✓ ${en["screen.review.large.oneOrder"]}`],
    ]);
    expect(screen.getByTestId("hold-to-confirm")).toBeDisabled();
    cleanup();
    // re-confirmed and healthy: the four ticks of doc §87, as its fixture shows them (tests/visual/run.mjs reads them)
    render(<ReviewView model={REVIEW_FIXTURES.large} actions={actions} />);
    expect(checks().map(([state]) => state)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    const card = screen.getByTestId("review-protected-execution").textContent;
    for (const k of ["screen.review.large.destination", "screen.review.large.quote", "screen.review.large.route", "screen.review.large.limits"] as const)
      expect(card).toContain(`✓ ${en[k]}`);
  });

  it("a route whose health was not read is not ticked either", () => {
    render(<ReviewView model={large({ routeHealthy: undefined })} actions={actions} />);
    expect(checks()[2][0]).toBe("fail");
    expect(checks()[2]).toEqual(["fail", `⚠ ${en["screen.review.large.routeOpen"]}`]);
  });
});

describe("E11-13: Protect's Max of ETH leaves the deposit's network fee", () => {
  const OWNER = getAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  const deployment: Deployment = {
    chainId: 31337,
    core: getAddress("0x00000000000000000000000000000000000000c0"),
    ethVault: getAddress("0x00000000000000000000000000000000000000e7"),
    rpcUrl: "http://127.0.0.1:1",
    rpcUrls: ["http://127.0.0.1:1"],
    fromBlock: 0n,
    erc20Vaults: [],
    protectRouter: getAddress("0x00000000000000000000000000000000000000a1"),
  };
  /** The connected wallet's provider (protect.test.tsx's): 2 ETH, a 120,000-gas estimate at 20 gwei of its own. */
  const provider = () => ({
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [OWNER];
      if (method === "eth_getBalance") return "0x" + (2n * E).toString(16);
      if (method === "eth_estimateGas") return "0x" + 120_000n.toString(16);
      if (method === "eth_gasPrice") return "0x" + (20n * 10n ** 9n).toString(16);
      throw new Error(`unsupported ${method}`);
    },
  });
  const type = (v: string) => fireEvent.input(screen.getByTestId("amount-input"), { target: { value: v } });
  const amount = () => (screen.getByTestId("amount-input") as HTMLInputElement).value;

  it("the page's check counts the reserve for ETH, from the live estimate; Max is its boundary; a token's is its balance", () => {
    const wei = 300_000n * 20_000_000_000n; // the probe's 0.006 ETH
    const base = {
      asset: { symbol: "ETH", decimals: 18 },
      account: OWNER,
      balance: 2n * E,
      amount: "2",
      units: 2n * E,
      split: { fee: (2n * E) / 100n, net: 2n * E - (2n * E) / 100n },
      networkWei: wei,
      ethUsd1e8: 250_000_000_000n,
    };
    expect(protectModel({ ...base, native: true }).error, "the whole balance: the probe's Max had passed").toBe("insufficient-fee");
    expect(protectModel({ ...base, native: false }).error, "a token: its network fee is paid in ETH").toBeNull();
    expect(protectModel({ ...base, native: true, networkWei: null }).error, "no estimate: no figure to refuse with").toBeNull();
    const max = maxProtect(2n * E, true, wei);
    expect(max, "2 ETH less 3 × 0.006").toBe(2n * E - 3n * wei);
    expect(protectModel({ ...base, native: true, units: max }).error, "Max is accepted").toBeNull();
    expect(protectModel({ ...base, native: true, units: max + 1n }).error, "one wei more is refused").toBe("insufficient-fee");
    expect(protectModel({ ...base, native: true, units: 3n * E }).error, "more than the balance keeps its own words").toBe("insufficient");
    expect(maxProtect(2n * E, false, wei)).toBe(2n * E);
    expect(maxProtect(2n * E, true, null), "no estimate: the wallet's prompt judges").toBe(2n * E);
    expect(maxProtect(2n * wei, true, wei), "a balance the reserve takes whole is filled as it is: the page then says why").toBe(2n * wei);
  });

  it("on the page: Max fills the balance less the reserve; an amount that leaves less is refused in words and the Review stays closed", async () => {
    await unlocked();
    setActiveProvider(provider());
    const router = createMemoryRouter(
      [{ path: "/protect/*", element: <ProtectScreen masterSeed={session.state().seed!} deployment={deployment} account={OWNER} /> }],
      {
        initialEntries: ["/protect"],
        future: ROUTER_FUTURE,
      },
    );
    render(<RouterProvider router={router} future={PROVIDER_FUTURE} />);
    await waitFor(() => expect(screen.getByTestId("protect-from").textContent).toContain("2 ETH"));
    fireEvent.click(screen.getByTestId("protect-max"));
    // 2 ETH less 3 × (120,000 gas × 20 gwei = 0.0024 ETH)
    await waitFor(() => expect(amount()).toBe("1.9928"));
    await new Promise((r) => setTimeout(r, 400)); // the page's own estimate of the amount (250 ms after it changes)
    expect(screen.queryByTestId("protect-error")).toBeNull();
    expect(screen.getByTestId("protect-review")).toBeEnabled();
    type("1.995"); // leaves 0.005 ETH: less than the reserve
    await waitFor(() => expect(screen.getByTestId("protect-error").textContent).toBe(t("screen.protect.insufficientFee", { symbol: "ETH" })));
    expect(screen.getByTestId("protect-review")).toBeDisabled();
    type("1.99"); // leaves 0.01 ETH
    await waitFor(() => expect(screen.queryByTestId("protect-error")).toBeNull());
    expect(screen.getByTestId("protect-review")).toBeEnabled();
  });
});
