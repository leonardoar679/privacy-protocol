// @vitest-environment happy-dom
// The eleventh review round (2026-11-04): a swap's page and Activity's recovery card say what happened and lead where the choice is.
// E11-4: "Cancel before it is funded" is not tapped twice at once, and a cancel that did not go through says so — its error had been set and
// never shown, and the delayed swap stayed scheduled to be funded while the page said nothing. E11-14: the recovery card of a funded order
// opens that order's own page, where Accept new minimum, Try again and Return funds are — "Get a new quote" had opened a blank swap while the
// funds waited for the order's choice. E11-10: Activity's Return funds the relayer refused reads in the catalog's words, never the relayer's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { ActivityDetailRoute } from "../src/features/activity/ActivityRoute";
import { en } from "../src/app/i18n/en";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { recordActivity, activityId } from "@privacy-wallet/sdk/wallet/activity";
import { getOperation, putOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { record } from "./helpers/operations";
import { swapRecordId, syncSwapRecord } from "@privacy-wallet/sdk/operations/swapRecords";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { FundingAlreadySent, FundingUnderWay } from "@privacy-wallet/sdk/swapFunding";
import { routeHandle } from "@privacy-wallet/sdk/wallet/routeHandles";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { deployment, ETH_VAULT, fetchMock, resetWorld, world } from "./helpers/swapWorld";

// "Return funds" held until the test lets it go: the button's state while it runs can be read
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, throws: null as unknown }));
vi.mock("@privacy-wallet/sdk/wallet/orderRunner", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/wallet/orderRunner")>();
  return {
    ...orig,
    returnFunds: async (...args: Parameters<typeof orig.returnFunds>) => {
      if (gate.hold) await gate.hold;
      if (gate.throws) throw gate.throws; // what returnFunds throws, when the test chooses it
      return orig.returnFunds(...args);
    },
  };
});
// the private withdrawal into the escrow has its own suites: never sent here
vi.mock("@privacy-wallet/sdk/swapFunding", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/swapFunding")>();
  return {
    ...orig,
    fundEscrow: async () => {
      throw new Error("no funding in this test");
    },
  };
});

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  session.forget();
  noteStore.clear();
  resetOperationsMemory();
  resetWorld();
  gate.hold = null;
  gate.throws = null;
  settings.reset();
});

const QUOTED = { timeout: 15_000 };
function mount(routes: { path: string; element: JSX.Element }[], path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path], future: ROUTER_FUTURE });
  render(
    <Providers deployment={deployment}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
  return router;
}
const swapRoute = () => ({ path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> });

const ORDER = "0x" + "cd".repeat(32);
/** A funded ETH → BTC order the runner paused: the route now guarantees less than the user approved. */
const pausedFunded = (): StoredSwap =>
  ({
    orderId: ORDER,
    attemptId: "0x" + "01".repeat(32),
    refundCounter: 0,
    provider: "thorchain",
    policy: "balanced",
    request: {
      from: { symbol: "ETH", decimals: 18, chain: "ethereum" },
      to: { symbol: "BTC", decimals: 8, chain: "bitcoin" },
      destination: "bc1qexample",
      destinationKind: "fresh",
    },
    params: { amount: (10n ** 18n).toString(), executeDeadline: Math.floor(Date.now() / 1000) + 1500, refundAfter: Math.floor(Date.now() / 1000) + 9000 },
    refundNoteData: "0x" + "ab".repeat(32),
    endpoint: "0x" + "ee".repeat(20),
    createdAt: Date.now() - 120_000,
    state: "funded",
    fundedTx: "0x" + "11".repeat(32),
    fundedAt: Date.now() - 60_000,
    paused: { code: "minimum_moved", detail: "the route now guarantees less", at: Date.now() - 30_000, minOut: "2900000", approved: "3000000" },
  }) as unknown as StoredSwap;
/** The order journaled with its Activity line and its record; the record's route to its Activity detail. */
async function journaled(): Promise<{ id: string; path: string }> {
  await session.create("a strong password");
  session.acknowledgePhrase();
  session.update((j) => {
    j.swaps = [...j.swaps, pausedFunded()];
  });
  recordActivity(
    { id: activityId("swap", ORDER), kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "funded", ref: ORDER, note: "→ BTC" },
    session,
  );
  syncSwapRecord(session.journal().swaps[0], null, null, Date.now(), session);
  const rec = getOperation(swapRecordId(ORDER), session)!;
  return { id: rec.id, path: `/activity/${encodeURIComponent(routeHandle(rec.id))}` };
}

/** A delayed 0.5 ETH → BTC swap confirmed and scheduled: its page, the Cancel before it is funded shown. */
async function delayedSwapPage() {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({
    note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n },
    leafIndex: 0,
    noteData: "0x",
    spent: false,
    addedAt: Date.now(),
  });
  await priceStore.refresh(deployment);
  const router = mount([swapRoute()], "/swap");
  fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
  await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
  fireEvent.click(screen.getByTestId("swap-delay"));
  fireEvent.click(screen.getByTestId("swap-review"));
  await act(async () => {
    fireEvent.click(await screen.findByTestId("review-confirm"));
  });
  await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\//));
  await screen.findByTestId("swap-cancel");
  return router;
}
/** The order journaled anew (the runner's own write, as a test makes it) and its record synced: the page draws the card it reads. */
const journalOrder = (change: (x: StoredSwap) => object, job: unknown = null) =>
  act(async () => {
    session.update((j) => {
      j.swaps = j.swaps.map((x) => ({ ...x, ...change(x) }) as unknown as StoredSwap);
    });
    syncSwapRecord(session.journal().swaps[0], null, job as never, Date.now(), session);
  });
const MOVED = () => ({ code: "minimum_moved", detail: "the route now guarantees less", at: Date.now(), minOut: "2900000", approved: "3000000" });
/** The drawn time comes: the waiting block, and the Cancel with it, goes. */
const drawnTimePasses = () =>
  act(async () => {
    session.update((j) => {
      j.swaps = j.swaps.map((x) => ({ ...x, runner: { ...x.runner, delayUntil: Date.now() - 1000 } }) as StoredSwap);
    });
  });

describe("E11-4: Cancel before it is funded", () => {
  it("is not tapped twice while it runs, and one that did not go through says so: the swap is still scheduled", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    // protected a moment ago: "Delay for more privacy" is offered, and with no older notes the funding waits its drawn time
    noteStore.add({
      note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n },
      leafIndex: 0,
      noteData: "0x",
      spent: false,
      addedAt: Date.now(),
    });
    await priceStore.refresh(deployment);
    const router = mount([swapRoute()], "/swap");
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    fireEvent.click(screen.getByTestId("swap-delay"));
    fireEvent.click(screen.getByTestId("swap-review"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("review-confirm"));
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\//));
    const [order] = session.journal().swaps;
    // the escrow cannot be read in this world (no RPC answer for its balance): Return funds throws "could not be read; nothing was changed"
    expect(world.escrowBalance).toBeUndefined();
    let release = () => {};
    gate.hold = new Promise<void>((r) => (release = r));
    fireEvent.click(await screen.findByTestId("swap-cancel"));
    expect(screen.getByTestId("swap-cancel"), "not twice at once").toBeDisabled();
    await act(async () => {
      gate.hold = null;
      release();
    });
    const said = await screen.findByTestId("swap-cancel-error");
    expect(said.getAttribute("role")).toBe("alert");
    expect(said.textContent).toBe(en["screen.swap.cancelFailed"]);
    expect(screen.getByTestId("swap-cancel")).toBeEnabled();
    const stored = session.journal().swaps.find((x) => x.orderId === order.orderId)!;
    expect(stored.state, "not abandoned").not.toBe("abandoned");
    expect(stored.runner?.delayUntil, "still scheduled").toBeGreaterThan(Date.now());
    expect(document.body.textContent).not.toMatch(/could not be read/);
  }, 60_000);

  it("a funding already on its way or being prepared, and a cancel that could not be made, are said as such on the cancel's line (the second to fifth critiques of E11-10)", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    noteStore.add({
      note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n },
      leafIndex: 0,
      noteData: "0x",
      spent: false,
      addedAt: Date.now(),
    });
    await priceStore.refresh(deployment);
    const router = mount([swapRoute()], "/swap");
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    fireEvent.click(screen.getByTestId("swap-delay"));
    fireEvent.click(screen.getByTestId("swap-review"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("review-confirm"));
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\//));
    // the drawn time's tick sends the funding as Cancel is tapped: the swap goes ahead, never "try again" (the third critique)
    gate.throws = new FundingAlreadySent("pending");
    await act(async () => {
      fireEvent.click(await screen.findByTestId("swap-cancel"));
    });
    expect((await screen.findByTestId("swap-cancel-error")).textContent).toBe(en["screen.swap.cancelTooLate"]);
    // what can fail a scheduled order's cancel fails before anything is sent — its escrow not read: the cancel's own words, still scheduled
    // (the fifth critique: a relayer is asked only once the funding is on its way, the drawn time passed — pinned below)
    gate.throws = new Error("The order's escrow could not be read");
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-cancel"));
    });
    await waitFor(() => expect(screen.getByTestId("swap-cancel-error").textContent).toBe(en["screen.swap.cancelFailed"]));
    expect(document.body.textContent).not.toMatch(/never landed|still in your protected balance|secured/);
    // under Advanced the thrown text follows, in parentheses (the third critique: only the helper had been tested so)
    act(() => settings.set({ advanced: true }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-cancel"));
    });
    await waitFor(() => expect(screen.getByTestId("swap-cancel-error").textContent).toBe(`${en["screen.swap.cancelFailed"]} (The order's escrow could not be read)`));
    // a funding being prepared right now goes ahead too, never "try again once it has finished" (the mutation check of the third pass:
    // only a funding already sent had been tried) — under Advanced with the thrown text after it
    gate.throws = new FundingUnderWay();
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-cancel"));
    });
    await waitFor(() => expect(screen.getByTestId("swap-cancel-error").textContent).toBe(`${en["screen.swap.cancelTooLate"]} (${new FundingUnderWay().message})`));
  }, 60_000);

  it("the drawn time passing while the cancel runs: its result stays on the page, the swap going ahead — never later under another card (the third critique)", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    noteStore.add({
      note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n },
      leafIndex: 0,
      noteData: "0x",
      spent: false,
      addedAt: Date.now(),
    });
    await priceStore.refresh(deployment);
    const router = mount([swapRoute()], "/swap");
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    fireEvent.click(screen.getByTestId("swap-delay"));
    fireEvent.click(screen.getByTestId("swap-review"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("review-confirm"));
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\//));
    let release = () => {};
    gate.hold = new Promise<void>((r) => (release = r));
    gate.throws = new FundingAlreadySent("pending");
    fireEvent.click(await screen.findByTestId("swap-cancel"));
    // the drawn time comes while the cancel runs: the waiting block goes
    await act(async () => {
      session.update((j) => {
        j.swaps = j.swaps.map((x) => ({ ...x, runner: { ...x.runner, delayUntil: Date.now() - 1000 } }) as StoredSwap);
      });
    });
    await act(async () => {
      gate.hold = null;
      release();
    });
    expect((await screen.findByTestId("swap-cancel-error")).textContent).toBe(en["screen.swap.cancelTooLate"]);
    expect(screen.queryByTestId("swap-cancel"), "the waiting block is gone").toBeNull();
    expect(screen.queryByTestId("swap-progress-error"), "never under another card").toBeNull();
    // the funding lands and its signing finds the minimum moved: the paused card, no word of the cancel under it — then the return starts
    // and the running page is drawn again, the cancel's line not with it (the fourth critique: a line mounted again is read out again)
    await act(async () => {
      session.update((j) => {
        j.swaps = j.swaps.map(
          (x) =>
            ({
              ...x,
              state: "funded",
              fundedTx: "0x" + "11".repeat(32),
              fundedAt: Date.now(),
              paused: { code: "minimum_moved", detail: "the route now guarantees less", at: Date.now(), minOut: "2900000", approved: "3000000" },
            }) as unknown as StoredSwap,
        );
      });
      syncSwapRecord(session.journal().swaps[0], null, null, Date.now(), session);
    });
    const card = await screen.findByTestId("swap-minimum-moved");
    expect(screen.queryByTestId("swap-progress-error"), "the cancel's words never under the paused card").toBeNull();
    expect(card.textContent).not.toContain(en["screen.swap.cancelTooLate"]);
    await act(async () => {
      session.update((j) => {
        j.swaps = j.swaps.map((x) => ({ ...x, paused: undefined, jobId: "0x" + "ab".repeat(32), state: "refunding" }) as unknown as StoredSwap);
      });
      syncSwapRecord(session.journal().swaps[0], null, { id: "0x" + "ab".repeat(32), state: "refunding" } as never, Date.now(), session);
    });
    await screen.findByTestId("swap-progress");
    expect(screen.queryByTestId("swap-cancel-error"), "the cancel's line is not drawn again").toBeNull();
  }, 60_000);

  it("a cancel that failed while the swap was scheduled says so; once the drawn time passes the same line says the swap goes ahead — never 'still scheduled; try again' with no Cancel (the fourth critique)", async () => {
    await delayedSwapPage();
    gate.throws = new Error("The order's escrow could not be read");
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-cancel"));
    });
    expect((await screen.findByTestId("swap-cancel-error")).textContent).toBe(en["screen.swap.cancelFailed"]);
    await drawnTimePasses();
    await waitFor(() => expect(screen.getByTestId("swap-cancel-error").textContent).toBe(en["screen.swap.cancelPassed"]));
    expect(screen.queryByTestId("swap-cancel")).toBeNull();
    expect(screen.getByTestId("swap-cancel-error").textContent).not.toMatch(/still scheduled|try again/);
  }, 60_000);

  it("a relayer that did not answer the cancel once the drawn time had come: the swap goes ahead, never 'try again in a moment' (the fourth critique)", async () => {
    await delayedSwapPage();
    let release = () => {};
    gate.hold = new Promise<void>((r) => (release = r));
    gate.throws = new TypeError("Failed to fetch");
    fireEvent.click(screen.getByTestId("swap-cancel"));
    await drawnTimePasses();
    await act(async () => {
      gate.hold = null;
      release();
    });
    expect((await screen.findByTestId("swap-cancel-error")).textContent).toBe(en["screen.swap.cancelPassed"]);
    // under Advanced the thrown text follows
    act(() => settings.set({ advanced: true }));
    await waitFor(() => expect(screen.getByTestId("swap-cancel-error").textContent).toBe(`${en["screen.swap.cancelPassed"]} (Failed to fetch)`));
  }, 60_000);

  it("an order paused before its funding — a delayed one whose fresh minimum moved — says nothing was sent, never 'held for this swap' (the fourth critique)", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    session.update((j) => {
      j.swaps = [...j.swaps, { ...pausedFunded(), state: "committed", fundedTx: undefined, fundedAt: undefined } as unknown as StoredSwap];
    });
    syncSwapRecord(session.journal().swaps[0], null, null, Date.now(), session);
    const rec = getOperation(swapRecordId(ORDER), session)!;
    mount([swapRoute()], `/swap/progress/${routeHandle(rec.id)}`);
    const card = await screen.findByTestId("swap-minimum-moved");
    expect(card.textContent).toContain(en["screen.swap.minimumMovedUnfunded"]);
    expect(card.textContent).not.toContain(en["screen.swap.minimumMovedSafe"]);
    // its other choice is the cancel it is, nothing to return; one that could not be made says nothing was sent — never "sent back" (the
    // fifth critique)
    expect(screen.getByTestId("swap-return-funds").textContent).toBe(en["screen.swap.cancelBeforeFunding"]);
    gate.throws = new Error("The order's escrow could not be read");
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-return-funds"));
    });
    await waitFor(() => expect(screen.getByTestId("swap-progress-error").textContent).toBe(en["screen.swap.stopFailed"]));
  }, 60_000);

  it("a cancel that fails once the page shows another card is dropped: never drawn when the running page comes back (the fifth critique)", async () => {
    await delayedSwapPage();
    let release = () => {};
    gate.hold = new Promise<void>((r) => (release = r));
    gate.throws = new Error("The order's escrow could not be read");
    fireEvent.click(screen.getByTestId("swap-cancel"));
    // the drawn time's check finds the minimum moved: the order pauses unfunded, its card drawn while the cancel still runs
    await journalOrder((x) => ({ runner: { ...x.runner, delayUntil: Date.now() - 1000 }, paused: MOVED() }));
    await screen.findByTestId("swap-minimum-moved");
    await act(async () => {
      gate.hold = null;
      release();
    });
    expect(screen.queryByTestId("swap-progress-error"), "the cancel's failure is not the paused card's").toBeNull();
    // the new minimum accepted: the running page, without the cancel's line
    await journalOrder(() => ({ paused: undefined }));
    await screen.findByTestId("swap-progress");
    expect(screen.queryByTestId("swap-cancel-error")).toBeNull();
  }, 60_000);

  it("a cancel that fails while the funded order is paused is dropped: the return started, the running page reads no cancel (the fifth critique)", async () => {
    await delayedSwapPage();
    let release = () => {};
    gate.hold = new Promise<void>((r) => (release = r));
    gate.throws = new TypeError("Failed to fetch");
    fireEvent.click(screen.getByTestId("swap-cancel"));
    await journalOrder((x) => ({ runner: { ...x.runner, delayUntil: Date.now() - 1000 }, state: "funded", fundedTx: "0x" + "11".repeat(32), fundedAt: Date.now(), paused: MOVED() }));
    await screen.findByTestId("swap-minimum-moved");
    await act(async () => {
      gate.hold = null;
      release();
    });
    expect(screen.queryByTestId("swap-progress-error")).toBeNull();
    await journalOrder(() => ({ paused: undefined, jobId: "0x" + "ab".repeat(32), state: "refunding" }), { id: "0x" + "ab".repeat(32), state: "refunding" });
    await screen.findByTestId("swap-progress");
    expect(screen.queryByTestId("swap-cancel-error"), "the funds on their way back: no 'goes ahead'").toBeNull();
  }, 60_000);

  it("a Return funds that failed on one card is not read out again under a later one (the fifth critique)", async () => {
    const rec = await journaled();
    mount([swapRoute()], `/swap/progress/${routeHandle(rec.id)}`);
    await screen.findByTestId("swap-minimum-moved");
    gate.throws = new TypeError("Failed to fetch");
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-return-funds"));
    });
    await waitFor(() => expect(screen.getByTestId("swap-progress-error").textContent).toBe(en["screen.swap.returnNoAnswer"]));
    // the new minimum accepted, the running page; then its signing pauses at execution_unavailable
    await journalOrder(() => ({ paused: undefined }));
    await screen.findByTestId("swap-progress");
    await journalOrder(() => ({ paused: { code: "execution_unavailable", detail: "the executor is not answering", at: Date.now() } }));
    await screen.findByTestId("swap-try-again");
    expect(screen.queryByTestId("swap-progress-error"), "nothing was asked on this card").toBeNull();
  }, 60_000);

  it("a Return funds whose answer comes once another card is drawn is dropped: the later card was asked nothing (the fifth critique)", async () => {
    const rec = await journaled();
    mount([swapRoute()], `/swap/progress/${routeHandle(rec.id)}`);
    await screen.findByTestId("swap-minimum-moved");
    let release = () => {};
    gate.hold = new Promise<void>((r) => (release = r));
    gate.throws = new TypeError("Failed to fetch");
    fireEvent.click(screen.getByTestId("swap-return-funds"));
    // while the return runs, the order's pause becomes execution_unavailable: another card
    await journalOrder(() => ({ paused: { code: "execution_unavailable", detail: "the executor is not answering", at: Date.now() } }));
    await screen.findByTestId("swap-try-again");
    await act(async () => {
      gate.hold = null;
      release();
    });
    expect(screen.queryByTestId("swap-progress-error"), "the minimum card's answer is not this card's").toBeNull();
  }, 60_000);
});

describe("E11-14: the recovery card of a funded order", () => {
  it("an order paused for the user's choice before its funding opens its own page too; its card offers no refund and says its funds were not moved (the fifth critique)", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    session.update((j) => {
      j.swaps = [...j.swaps, { ...pausedFunded(), state: "committed", fundedTx: undefined, fundedAt: undefined } as unknown as StoredSwap];
    });
    recordActivity(
      { id: activityId("swap", ORDER), kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "pending", ref: ORDER, note: "→ BTC" } as never,
      session,
    );
    syncSwapRecord(session.journal().swaps[0], null, null, Date.now(), session);
    const rec = getOperation(swapRecordId(ORDER), session)!;
    expect(rec.reason).toMatchObject({ code: "minimum_moved", fundsClass: "not-moved" });
    expect(rec.recovery, "no refund offered or watched: nothing is in an escrow").toBeUndefined();
    const router = mount([{ path: "/activity/:id", element: <ActivityDetailRoute /> }, swapRoute()], `/activity/${encodeURIComponent(routeHandle(rec.id))}`);
    const recovery = await screen.findByTestId("recovery");
    expect(recovery.textContent).toContain(en["op.funds.notMoved"]);
    expect(recovery.textContent).not.toContain(en["op.recovery.refundOffered"]);
    expect(screen.queryByTestId("recovery-refund")).toBeNull();
    expect(screen.queryByTestId("recovery-new-quote"), "never a blank swap while this order stays paused").toBeNull();
    fireEvent.click(screen.getByTestId("recovery-open-swap"));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/swap/progress/${routeHandle(rec.id)}`));
    expect((await screen.findByTestId("swap-minimum-moved")).textContent).toContain(en["screen.swap.minimumMovedUnfunded"]);
  }, 60_000);

  it("opens the order's own page, where Accept new minimum and Return funds are — never a blank swap", async () => {
    const rec = await journaled();
    const router = mount([{ path: "/activity/:id", element: <ActivityDetailRoute /> }, swapRoute()], rec.path);
    await screen.findByTestId("recovery");
    expect(screen.queryByTestId("recovery-new-quote"), "no new quote for an order whose funds wait in its escrow").toBeNull();
    fireEvent.click(screen.getByTestId("recovery-open-swap"));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/swap/progress/${routeHandle(rec.id)}`));
    expect(await screen.findByTestId("swap-accept-minimum")).toBeTruthy();
    expect(screen.getByTestId("swap-return-funds")).toBeTruthy();
    expect(screen.getByTestId("swap-minimum-moved").textContent, "a funded order's funds are held for it").toContain(en["screen.swap.minimumMovedSafe"]);
    expect(session.journal().swaps[0].paused?.code, "the order's own choice waits for it").toBe("minimum_moved");
    // its Return funds that could not reach the relayer: the catalog's words, and under Advanced the thrown text after them (the mutation
    // check of the third pass: only the cancel's line and Activity's had been tried under Advanced)
    gate.throws = new TypeError("Failed to fetch");
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-return-funds"));
    });
    await waitFor(() => expect(screen.getByTestId("swap-progress-error").textContent).toBe(en["screen.swap.returnNoAnswer"]));
    act(() => settings.set({ advanced: true }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-return-funds"));
    });
    await waitFor(() => expect(screen.getByTestId("swap-progress-error").textContent).toBe(`${en["screen.swap.returnNoAnswer"]} (Failed to fetch)`));
  }, 60_000);
});

describe("E11-10 (1): Activity's Return funds", () => {
  it("refused by the relayer, reads in the catalog's words — never the relayer's text in their place", async () => {
    const rec = await journaled();
    let asked = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/swap/refund") {
        asked++;
        return new Response(JSON.stringify({ error: "refund refused, in this relayer's own words", code: "bad_refund_payload" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return fetchMock(input as never, init);
    }) as unknown as typeof fetch;
    mount([{ path: "/activity/:id", element: <ActivityDetailRoute /> }], rec.path);
    await act(async () => {
      fireEvent.click(await screen.findByTestId("recovery-refund"));
    });
    const said = await screen.findByTestId("detail-error");
    expect(asked, "the relayer was asked").toBe(1);
    // the return's own words for a relayer's refusal (the second critique of E11-10: the catalog's row had said "confirm again or return
    // them" — the very action that failed, a retry resending the same payload)
    expect(said.textContent).toBe(en["screen.swap.returnRefused"]);
    expect(said.textContent).not.toMatch(/confirm again|return them|Nothing left your protected balance/);
    expect(document.body.textContent).not.toContain("this relayer's own words");
    // under Advanced the relayer's own text follows the words, in parentheses (the third critique)
    act(() => settings.set({ advanced: true }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("recovery-refund"));
    });
    await waitFor(() => expect(screen.getByTestId("detail-error").textContent).toMatch(/^The relayer refused to return this swap's funds.*\(.*this relayer's own words.*\)$/));
  }, 60_000);

  it("a relayer that cannot be reached, or answers 5xx: nothing returned yet, try again — never the catalog's secured transaction or its funds check", async () => {
    const rec = await journaled();
    let answer: "unreachable" | "502" = "unreachable";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/swap/refund") {
        if (answer === "unreachable") throw new TypeError("Failed to fetch");
        return new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
      }
      return fetchMock(input as never, init);
    }) as unknown as typeof fetch;
    mount([{ path: "/activity/:id", element: <ActivityDetailRoute /> }], rec.path);
    await act(async () => {
      fireEvent.click(await screen.findByTestId("recovery-refund"));
    });
    expect((await screen.findByTestId("detail-error")).textContent).toBe(en["screen.swap.returnNoAnswer"]);
    answer = "502";
    await act(async () => {
      fireEvent.click(screen.getByTestId("recovery-refund"));
    });
    await waitFor(() => expect(screen.getByTestId("detail-error").textContent).toBe(en["screen.swap.returnNoAnswer"]));
    expect(document.body.textContent).not.toMatch(/secured|checks where your funds are|operation's history/);
  }, 60_000);
});

describe("E11-14: an order that was never funded, and a protected execution's step (the second critique)", () => {
  it("a swap stopped before its funding keeps 'Get a new quote' — there is no order page to open", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    const unfunded = { ...pausedFunded(), state: "committed", fundedTx: undefined, fundedAt: undefined, paused: undefined } as unknown as StoredSwap;
    session.update((j) => {
      j.swaps = [unfunded];
    });
    recordActivity(
      { id: activityId("swap", ORDER), kind: "swap", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "failed", ref: ORDER, note: "→ BTC" },
      session,
    );
    // stopped before anything moved, its executor tip stale: its catalog row offers a new quote
    putOperation(
      record({
        id: swapRecordId(ORDER),
        kind: "swap",
        state: "RECOVERY_REQUIRED",
        reason: { code: "tip_stale", fundsClass: "not-moved", detail: "the executor tip no longer covers the gas" },
        refs: { orderId: ORDER, txHashes: [] },
      }),
      session,
    );
    const rec = getOperation(swapRecordId(ORDER), session)!;
    mount([{ path: "/activity/:id", element: <ActivityDetailRoute /> }], `/activity/${encodeURIComponent(routeHandle(rec.id))}`);
    await screen.findByTestId("recovery");
    expect(screen.getByTestId("recovery-new-quote")).toBeTruthy();
    expect(screen.queryByTestId("recovery-open-swap")).toBeNull();
  }, 60_000);

  it("a funded step of a protected execution never opens the one-order page", async () => {
    const rec = await journaled();
    session.update((j) => {
      j.swaps = j.swaps.map((x) => ({ ...x, campaign: "0x" + "c7".repeat(32) }));
    });
    syncSwapRecord(session.journal().swaps[0], null, null, Date.now(), session);
    settings.set({ advanced: true }); // a step's row shows under Advanced
    mount([{ path: "/activity/:id", element: <ActivityDetailRoute /> }], rec.path);
    await screen.findByTestId("recovery");
    expect(screen.queryByTestId("recovery-open-swap")).toBeNull();
  }, 60_000);
});
