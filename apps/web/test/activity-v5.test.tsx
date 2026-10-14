// @vitest-environment happy-dom
// Activity and the detail (spec §3.10, §14): groups by day, one row per money movement — the operation record and
// the V2 line merged by id or by the transaction hash, never two rows —, the status word from the record's state,
// an icon per kind, a record without a line shown on its own, Refresh tracking the open swaps, Remove; the detail's
// fields, the advanced list from the record's refs, and the recovery card with the refund through the executor.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Activity } from "../src/features/activity/Activity";
import { Detail } from "../src/features/activity/Detail";
import { Receive } from "../src/features/wallet/Receive";
import { buildRows, groupByDay } from "../src/features/activity/rows";
import { getOperation, newOperation, putOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { t } from "../src/app/i18n/messages";
import { recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { resetDiscoveryMemory } from "@privacy-wallet/sdk/wallet/discovery";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { record } from "./helpers/operations";

const trackCalls: string[] = [];
let trackedState = "DESTINATION_SUBMITTED";
vi.mock("@privacy-wallet/sdk/orderTracker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/orderTracker")>()),
  trackOrder: async (s: StoredSwap) => { trackCalls.push(s.orderId); return { tracked: { state: trackedState, label: trackedState === "COMPLETED" ? "Completed" : "Waiting for destination", steps: [true, true, true, trackedState === "COMPLETED"], detail: "x", destinationTxHash: "0x" + "dd".repeat(32) }, job: null }; },
}));
const refundCalls: string[] = [];
vi.mock("@privacy-wallet/sdk/swapExecute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/swapExecute")>()),
  returnOrderToBalance: async (i: { stored: StoredSwap }) => { refundCalls.push(i.stored.orderId); return { id: "job-r", escrow: "0x" + "0e".repeat(20), state: "refund-only", updatedAt: Date.now() }; },
}));

const HASH = "0x" + "ab".repeat(32);
const ORDER = "0x" + "0a".repeat(32);
const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
// anchored at local noon: the rows sit at ± a few hours around NOW, NOW - DAY and NOW - 9 DAY, and the groups are
// calendar days, so a run in the first hour after midnight must not push "yesterday minus an hour" two days back
const NOW = new Date().setHours(12, 0, 0, 0);
const DAY = 86_400_000;
beforeEach(async () => { await session.create("a strong password"); session.acknowledgePhrase(); });
afterEach(() => { cleanup(); session.forget(); settings.reset(); resetOperationsMemory(); trackCalls.length = 0; refundCalls.length = 0; trackedState = "DESTINATION_SUBMITTED"; });

function storedSwap(): StoredSwap {
  return { orderId: ORDER, attemptId: "0x" + "0b".repeat(32), refundCounter: 1, provider: "thorchain", policy: "balanced", request: { from: ETH, to: BTC, amount: (10n ** 18n).toString(), destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", destinationKind: "fresh" }, params: { amount: (10n ** 18n).toString() }, endpoint: "0x" + "0c".repeat(20), createdAt: NOW - 3 * DAY, fundedTx: "0x" + "11".repeat(32), state: "funded", tier: "large", approvedMin: "2985000", value: { usd: 2_500, at: NOW } };
}

describe("the rows (spec §14)", () => {
  it("groups by day in order — Today, Yesterday, then dates — newest first", () => {
    recordActivity({ id: "shield:0x1", kind: "shield", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "completed", ref: "0x1", at: NOW - 60_000 });
    recordActivity({ id: "transfer:0x2", kind: "transfer", asset: "ETH", decimals: 18, amount: (5n * 10n ** 17n).toString(), status: "completed", ref: "0x2", at: NOW - DAY - 3600_000 });
    recordActivity({ id: "withdraw:0x3", kind: "withdraw", asset: "ETH", decimals: 18, amount: (2n * 10n ** 17n).toString(), status: "completed", ref: "0x3", at: NOW - 9 * DAY });
    const groups = groupByDay(buildRows(session.journal(), [], false, t, NOW), t, NOW, "en-US");
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([["Today", ["shield:0x1"]], ["Yesterday", ["transfer:0x2"]], [new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(new Date(NOW - 9 * DAY)), ["withdraw:0x3"]]]);
    expect(groups[0].rows[0]).toMatchObject({ title: "Added funds", amount: "1 ETH", status: "Completed", tone: "ok", icon: "shield", finished: true });
    expect(groups[1].rows[0]).toMatchObject({ title: "Sent privately", icon: "send" });
    expect(groups[2].rows[0]).toMatchObject({ title: "Withdrawn", icon: "upload" });
  });
  it("one row per movement: a record and its line merge by the transaction hash or by the order id; the status word is the record's; a record without a line stands on its own", () => {
    recordActivity({ id: "shield:" + HASH, kind: "shield", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "completed", ref: HASH, at: NOW - 1000 });
    const protect = record({ id: "protect:1", kind: "protect", state: "COMPLETED", createdAt: NOW - 2000, updatedAt: NOW - 500, refs: { txHashes: [HASH], leafIndex: 7 }, history: [{ state: "COMPLETED", at: NOW - 500 }] });
    putOperation(protect);
    recordActivity({ id: `swap:${ORDER}`, kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "executing", ref: ORDER, note: "→ BTC", at: NOW - 3000 });
    putOperation(record({ id: `swap:${ORDER}`, kind: "cross-chain", state: "EXECUTING", createdAt: NOW - 3000, updatedAt: NOW - 100, refs: { txHashes: [], orderId: ORDER }, delayed: { since: NOW - 100, code: "provider_timeout" }, history: [{ state: "EXECUTING", at: NOW - 100 }] }));
    putOperation(record({ id: "send:9", kind: "send", state: "CANCELLED", createdAt: NOW - 4000, updatedAt: NOW - 4000, reason: { code: "user_rejected", fundsClass: "not-moved" }, declined: { at: NOW - 4000, code: "user_rejected" }, history: [{ state: "CANCELLED", at: NOW - 4000 }] }));
    newOperation({ kind: "send", amounts: { asset: "ETH", decimals: 18, input: "1" }, destination: { kind: "entered", display: "0x12…", chain: "ethereum" }, tier: "standard", id: "send:draft" }, NOW - 50);
    const rows = buildRows(session.journal(), [protect, ...[`swap:${ORDER}`, "send:9"].map((id) => session.journal().operations!.find((r) => r.id === id)!), getOperation("send:draft")!], false, t, NOW);
    expect(rows.map((r) => [r.id, r.title, r.status, r.tone]), "V6: a delay is the phase taking longer; a declined send stored as cancelled; a draft is no row").toEqual([["shield:" + HASH, "Added funds", "Completed", "ok"], [`swap:${ORDER}`, "Swap", "Taking longer than expected", "warn"], ["send:9", "Sent privately", "Cancelled", "neutral"]]);
    expect(rows[0].record?.refs.leafIndex).toBe(7);
    expect(rows[1].finished).toBe(false);
    expect(rows[2].ref).toBe("send:9");
  });
});

describe("the screens (spec §3.10)", () => {
  it("a V6 follow-up: Receive looks for a transfer at once — except on a first launch, which stays request-free (spec v2.0 §10)", async () => {
    resetDiscoveryMemory();
    render(<Receive masterSeed={session.state().seed!} />);
    expect(session.journal().schedule.some((a) => a.kind === "discovery"), "the session that created the wallet asks for nothing").toBe(false);
    cleanup();
    session.lock();
    expect(await session.unlock("a strong password")).toBe(true);
    render(<Receive masterSeed={session.state().seed!} />);
    expect(session.journal().schedule.find((a) => a.kind === "discovery")!.dueAt).toBeLessThanOrEqual(Date.now());
  });
  it("a V6 follow-up: opening Activity looks for notes (at most once a minute); a transfer received has its row; a scan that failed raises no funding warning", () => {
    resetDiscoveryMemory();
    recordActivity({ id: "receive:41", kind: "receive", asset: "ETH", decimals: 18, amount: (25n * 10n ** 16n).toString(), status: "completed", ref: HASH, at: NOW - 1000 });
    session.update((j) => {
      j.schedule = [{ id: "discovery:pool", kind: "discovery", orderId: "pool", dueAt: NOW + 600_000, error: "fetch failed", attempts: 1, nextAttemptAt: NOW + 60_000 }];
    });
    render(<Activity onOpen={vi.fn()} />);
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Private Receive");
    expect(rows[0].textContent).toContain("0.25 ETH");
    expect(screen.queryByTestId("activity-funding-warning"), "a note scan that failed retries by itself and moves nothing").toBeNull();
    expect(session.journal().schedule.find((a) => a.id === "discovery:pool")!.dueAt, "the scan is now, not in ten minutes").toBeLessThanOrEqual(Date.now());
    cleanup();
    session.update((j) => {
      j.schedule = [...j.schedule, { id: `fund-escrow:${ORDER}`, kind: "fund-escrow", orderId: ORDER, dueAt: NOW, error: "fetch failed", attempts: 1 }];
    });
    render(<Activity onOpen={vi.fn()} />);
    expect(screen.getByTestId("activity-funding-warning")).toBeTruthy();
  });
  it("the list (spec v2.0 §7.8): day headings, an icon, the title and one status word per row, a row opens its detail; Refresh tracks the open swaps; no Remove in the list", async () => {
    session.update((j) => { j.swaps = [storedSwap()]; });
    recordActivity({ id: `swap:${ORDER}`, kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "funded", ref: ORDER, note: "→ BTC", at: NOW - 1000 });
    recordActivity({ id: "shield:0x1", kind: "shield", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "completed", ref: "0x1", at: NOW - DAY - 1000 });
    const onOpen = vi.fn();
    render(<Activity onOpen={onOpen} />);
    expect(screen.getAllByTestId("activity-day").map((h) => h.textContent)).toEqual(["Today", "Yesterday"]);
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-status")).toBe("executing");
    expect(rows[0].textContent).toContain("ETH → BTC");
    expect(rows[0].textContent, "the USD value the order recorded at its quote").toContain("$2,500.00");
    expect(rows[0].textContent).toContain("Executing");
    expect(rows[1].textContent).toContain("Protected ETH");
    expect(rows[0].querySelector("svg")).toBeTruthy();
    expect(screen.queryByText("Remove"), "Remove lives in the detail's Advanced").toBeNull();
    fireEvent.click(within(rows[0]).getByRole("button", { name: /ETH → BTC/ }));
    expect(onOpen).toHaveBeenCalledWith(`swap:${ORDER}`);
    fireEvent.click(screen.getByTestId("activity-refresh"));
    await waitFor(() => expect(trackCalls).toEqual([ORDER]));
  });
  it("the detail: the pair and the value, the status, the source, the verified destination, the transaction, the advanced list from the refs; Refresh tracks the order and the record follows", async () => {
    const stored = storedSwap();
    session.update((j) => { j.swaps = [stored]; });
    recordActivity({ id: `swap:${ORDER}`, kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "funded", ref: ORDER, note: "→ BTC", at: NOW - 1000 });
    putOperation(record({ id: `swap:${ORDER}`, kind: "cross-chain", state: "EXECUTING", createdAt: NOW - 1000, updatedAt: NOW - 1000, refs: { txHashes: [stored.fundedTx!], orderId: ORDER, quoteId: "q-7", executionRef: "thor-123", provider: "thorchain" }, fees: [{ label: "Privacy fee (0.25 %)", value: "0.0025 ETH" }, { label: "Relayer / network", value: "0.001 ETH" }], destination: { kind: "fresh", display: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", chain: "bitcoin" }, history: [{ state: "EXECUTING", at: NOW - 1000 }] }));
    settings.set({ advanced: true });
    render(<Detail id={`swap:${ORDER}`} onBack={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("ETH → BTC");
    expect(screen.getByTestId("detail-value").textContent).toBe("$2,500.00");
    expect(screen.getByTestId("detail-status").textContent).toContain("Executing");
    expect(screen.getByTestId("detail-destination").textContent).toContain("Verified");
    expect(document.body.textContent).toContain("Privacy fee");
    expect(document.body.textContent).toContain("0.0025 ETH");
    expect(screen.getByTestId("detail-timeline")).toBeInTheDocument();
    expect(document.body.textContent, "Simple: the transaction lives in Advanced").not.toContain(stored.fundedTx!);
    fireEvent.click(screen.getByTestId("detail-advanced-toggle"));
    const list = screen.getByTestId("detail-advanced-list").textContent ?? "";
    for (const word of ["Operation ID", "Provider", "thorchain", "Execution ID", ORDER, "Quote ID", "q-7", "Transaction", stored.fundedTx!, "Nullifier status", "Provider execution ID", "thor-123", "Confirmation state", "Recovery state"]) expect(list).toContain(word);
    trackedState = "COMPLETED";
    fireEvent.click(screen.getByTestId("detail-refresh"));
    await waitFor(() => expect(trackCalls).toEqual([ORDER]));
    await waitFor(() => expect(screen.getByTestId("detail-status").textContent).toContain("Completed"));
    expect(session.journal().operations!.find((r) => r.id === `swap:${ORDER}`)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [stored.fundedTx, "0x" + "dd".repeat(32)] } });
  });
  it("a swap needing attention shows the recovery card in its detail: the refund hands a refund-only job to the executor, never a retry", async () => {
    const stored = storedSwap();
    session.update((j) => { j.swaps = [stored]; });
    recordActivity({ id: `swap:${ORDER}`, kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "execute-failed", ref: ORDER, note: "→ BTC", at: NOW - 1000 });
    putOperation(record({ id: `swap:${ORDER}`, kind: "cross-chain", state: "RECOVERY_REQUIRED", createdAt: NOW - 1000, updatedAt: NOW - 100, refs: { txHashes: [stored.fundedTx!], orderId: ORDER }, reason: { code: "execute_failed", fundsClass: "still-protected" }, recovery: { state: "refund-offered", since: NOW - 100 }, history: [{ state: "RECOVERY_REQUIRED", at: NOW - 100 }] }));
    render(<Detail id={`swap:${ORDER}`} onBack={() => {}} />);
    const card = await screen.findByTestId("recovery");
    expect(card.textContent).toContain("Something needs attention");
    expect(card.textContent).toContain("Your protected funds are safe.");
    expect(card.textContent).toContain("The execution failed");
    expect(within(card).queryByRole("button", { name: /retry/i }), "never a blind Retry").toBeNull();
    fireEvent.click(within(card).getByTestId("recovery-refund"));
    await waitFor(() => expect(refundCalls).toEqual([ORDER]));
    expect(trackCalls, "the refund tracks the order again").toEqual([ORDER]);
  });
  it("the detail of a record without a line (a declined protect, stored as cancelled) and an unknown id", () => {
    const rec = newOperation({ kind: "protect", amounts: { asset: "ETH", decimals: 18, input: (10n ** 18n).toString() }, destination: { kind: "privacy-address", display: "Your protected balance", chain: "ethereum" }, tier: "standard" }, NOW - 500);
    putOperation({ ...rec, state: "CANCELLED", reason: { code: "user_rejected", fundsClass: "not-moved" }, declined: { at: NOW - 400, code: "user_rejected" }, history: [...rec.history, { state: "CANCELLED", at: NOW - 400 }] });
    render(<Detail id={rec.id} onBack={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Protected ETH");
    expect(screen.getByTestId("detail-status").textContent).toContain("Cancelled");
    expect(screen.queryByTestId("detail-refresh")).toBeNull();
    cleanup();
    render(<Detail id="nothing:here" onBack={() => {}} />);
    expect(screen.getByTestId("detail-missing")).toBeInTheDocument();
  });
});
