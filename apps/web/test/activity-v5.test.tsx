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
import { buildRows, groupByDay } from "../src/features/activity/rows";
import { newOperation, putOperation, resetOperationsMemory } from "../src/features/operations/store";
import { t } from "../src/app/i18n/messages";
import { recordActivity } from "../src/wallet/activity";
import type { StoredSwap } from "../src/wallet/journal";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";
import { record } from "./helpers/operations";

const trackCalls: string[] = [];
let trackedState = "DESTINATION_SUBMITTED";
vi.mock("../src/sdk/orderTracker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sdk/orderTracker")>()),
  trackOrder: async (s: StoredSwap) => { trackCalls.push(s.orderId); return { tracked: { state: trackedState, label: trackedState === "COMPLETED" ? "Completed" : "Waiting for destination", steps: [true, true, true, trackedState === "COMPLETED"], detail: "x", destinationTxHash: "0x" + "dd".repeat(32) }, job: null }; },
}));
const refundCalls: string[] = [];
vi.mock("../src/sdk/swapExecute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sdk/swapExecute")>()),
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
    putOperation(record({ id: `swap:${ORDER}`, kind: "cross-chain", state: "NETWORK_DELAYED", createdAt: NOW - 3000, updatedAt: NOW - 100, refs: { txHashes: [], orderId: ORDER }, failure: { code: "provider_timeout", class: "still-protected" }, history: [{ state: "NETWORK_DELAYED", at: NOW - 100 }] }));
    putOperation(record({ id: "send:9", kind: "send", state: "SIGNATURE_REJECTED", createdAt: NOW - 4000, updatedAt: NOW - 4000, failure: { code: "user_rejected", class: "not-moved" }, history: [{ state: "SIGNATURE_REJECTED", at: NOW - 4000 }] }));
    const rows = buildRows(session.journal(), [protect, ...[`swap:${ORDER}`, "send:9"].map((id) => session.journal().operations!.find((r) => r.id === id)!)], false, t, NOW);
    expect(rows.map((r) => [r.id, r.title, r.status, r.tone])).toEqual([["shield:" + HASH, "Added funds", "Completed", "ok"], [`swap:${ORDER}`, "Swap", "Taking longer than expected", "warn"], ["send:9", "Sent privately", "Not signed", "danger"]]);
    expect(rows[0].record?.refs.leafIndex).toBe(7);
    expect(rows[1].finished).toBe(false);
    expect(rows[2].ref).toBe("send:9");
  });
});

describe("the screens (spec §3.10)", () => {
  it("the list: day headings, the icon and the status per row, a row opens its detail; Refresh tracks the open swaps; Remove drops a finished line", async () => {
    session.update((j) => { j.swaps = [storedSwap()]; });
    recordActivity({ id: `swap:${ORDER}`, kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "funded", ref: ORDER, note: "→ BTC", at: NOW - 1000 });
    recordActivity({ id: "shield:0x1", kind: "shield", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "completed", ref: "0x1", at: NOW - DAY - 1000 });
    const onOpen = vi.fn();
    render(<Activity onOpen={onOpen} />);
    expect(screen.getAllByTestId("activity-day").map((h) => h.textContent)).toEqual(["Today", "Yesterday"]);
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-label")).toBe("Funded");
    expect(rows[0].textContent).toContain("Swap");
    expect(rows[0].textContent).toContain("1 ETH");
    expect(within(rows[0]).queryByTestId("activity-remove")).toBeNull();
    expect(rows[0].querySelector("svg")).toBeTruthy();
    fireEvent.click(within(rows[0]).getByRole("button", { name: /Swap/ }));
    expect(onOpen).toHaveBeenCalledWith(`swap:${ORDER}`);
    fireEvent.click(screen.getByTestId("activity-refresh"));
    await waitFor(() => expect(trackCalls).toEqual([ORDER]));
    fireEvent.click(within(rows[1]).getByTestId("activity-remove"));
    await waitFor(() => expect(screen.getAllByTestId("activity-row")).toHaveLength(1));
    expect(session.journal().activity!.map((r) => r.id)).toEqual([`swap:${ORDER}`]);
  });
  it("the detail: the pair and the value, the status, the source, the verified destination, the transaction, the advanced list from the refs; Refresh tracks the order and the record follows", async () => {
    const stored = storedSwap();
    session.update((j) => { j.swaps = [stored]; });
    recordActivity({ id: `swap:${ORDER}`, kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "funded", ref: ORDER, note: "→ BTC", at: NOW - 1000 });
    putOperation(record({ id: `swap:${ORDER}`, kind: "cross-chain", state: "NETWORK_CONFIRMING", createdAt: NOW - 1000, updatedAt: NOW - 1000, refs: { txHashes: [stored.fundedTx!], orderId: ORDER, quoteId: "q-7", executionRef: "thor-123", provider: "thorchain" }, fees: [{ label: "Privacy fee (0.25 %)", value: "0.0025 ETH" }, { label: "Relayer / network", value: "0.001 ETH" }], destination: { kind: "fresh", display: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", chain: "bitcoin" }, history: [{ state: "NETWORK_CONFIRMING", at: NOW - 1000 }] }));
    settings.set({ advanced: true });
    render(<Detail id={`swap:${ORDER}`} onBack={() => {}} />);
    expect(screen.getByTestId("detail-pair").textContent).toBe("ETH → BTC");
    expect(screen.getByTestId("detail-value").textContent).toBe("$2,500");
    expect(screen.getByTestId("detail-status").textContent).toContain("Confirming on the network");
    expect(document.body.textContent).toContain("Protected ETH");
    expect(screen.getByTestId("detail-destination").textContent).toContain("✓ Verified");
    expect(document.body.textContent).toContain("Privacy fee");
    expect(document.body.textContent).toContain("0.0025 ETH");
    expect(screen.getByTestId("detail-provider").textContent).toContain("thorchain");
    expect(screen.getByTestId("detail-tx").textContent).toContain(stored.fundedTx);
    fireEvent.click(screen.getByTestId("detail-advanced-toggle"));
    const list = screen.getByTestId("detail-advanced-list").textContent ?? "";
    for (const word of ["Execution ID", ORDER, "Quote ID", "q-7", "Nullifier status", "Provider execution ID", "thor-123", "Confirmation state", "Recovery state"]) expect(list).toContain(word);
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
    putOperation(record({ id: `swap:${ORDER}`, kind: "cross-chain", state: "PROVIDER_FAILED", createdAt: NOW - 1000, updatedAt: NOW - 100, refs: { txHashes: [stored.fundedTx!], orderId: ORDER }, failure: { code: "execute_failed", class: "still-protected" }, recovery: { state: "refund-offered", since: NOW - 100 }, history: [{ state: "PROVIDER_FAILED", at: NOW - 100 }] }));
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
  it("the detail of a record without a line (a declined protect) and an unknown id", () => {
    const rec = newOperation({ kind: "protect", amounts: { asset: "ETH", decimals: 18, input: (10n ** 18n).toString() }, destination: { kind: "privacy-address", display: "Your protected balance", chain: "ethereum" }, tier: "standard" }, NOW - 500);
    putOperation({ ...rec, state: "SIGNATURE_REJECTED", failure: { code: "user_rejected", class: "not-moved" }, history: [...rec.history, { state: "SIGNATURE_REJECTED", at: NOW - 400 }] });
    render(<Detail id={rec.id} onBack={() => {}} />);
    expect(screen.getByTestId("detail-pair").textContent).toBe("Protect");
    expect(screen.getByTestId("detail-status").textContent).toContain("Not signed");
    expect(screen.queryByTestId("detail-refresh")).toBeNull();
    cleanup();
    render(<Detail id="nothing:here" onBack={() => {}} />);
    expect(screen.getByTestId("detail-missing")).toBeInTheDocument();
  });
});
