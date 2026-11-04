// @vitest-environment happy-dom
// The Swap screen with ONE confirmation (spec v2.0 §7.5–§7.7, §13.4, §14.1; the owner's decision of 2026-10-13), against
// the swap service's REAL engine behind the fetch mock of test/helpers/swapWorld.ts: the quote fetched as the user types
// (no destination sent), the Review, one confirmation — the order committed with the minimum shown —, then the order
// runner (driven tick by tick here, as the App's scheduler would) funds it (the private withdrawal has its own suites:
// stubbed here), prepares the hard quote, checks the provider call, signs, simulates and hands it over: no second tap. A
// call paying someone else is stopped with nothing signed and goes back through its refund-only job; a call the chain
// would revert is not handed over; a lower minimum waits for the user's choice, and accepting it signs the very call it
// was read from even while the market keeps moving (audit gap 43); a reload continues from the journal with
// no second funding; an expired quote says so; right after a protect the protection reads Medium and the funding can be
// delayed — from older notes at once when they cover it (stopped unfunded if they no longer do), else at a random time —;
// nothing secret leaves the wallet.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { orderVouchDigest } from "@privacy-wallet/sdk/swapGuard";
import { patchSwap } from "@privacy-wallet/sdk/swapFunding";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { resetOrderRunnerMemory, runOrderTick } from "@privacy-wallet/sdk/wallet/orderRunner";
import { getOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { swapRecordId, syncSwapRecord } from "@privacy-wallet/sdk/operations/swapRecords";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale } from "../src/app/i18n/messages";
import { prefs } from "../src/storage/prefs";
import { allowedHosts } from "@privacy-wallet/privacy-engine/transport/http";
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { fieldNames, FORBIDDEN_FIELDS, leaks, sessionSecrets } from "./helpers/leakage";
import {
  calls,
  deployment,
  ETH_VAULT,
  FACTORY,
  fetchMock,
  jobs,
  LIMIT,
  relayerBodies,
  ORDER_VOUCH,
  CALL_VOUCH,
  finalizeVouches,
  executeBodies,
  requests,
  resetWorld,
  rpcSeen,
  VAULT,
  VAULT_2,
  world,
} from "./helpers/swapWorld";

// the private withdrawal into the escrow has its own suites (privacy-leakage, the local stack): here it is counted
const funding = vi.hoisted(() => ({ count: 0, runner: undefined as unknown, olderGone: false }));
vi.mock("@privacy-wallet/sdk/swapFunding", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/swapFunding")>();
  return {
    ...orig,
    fundEscrow: async (o: {
      deployment: never;
      stored: { orderId: string; runner?: { maxTiming?: number } };
      onStatus?: (l: string) => void;
      session?: never;
      relayerUrl?: string | null;
    }) => {
      funding.count++;
      funding.runner = o.stored.runner;
      // the funding's first check, as the real one makes it (a V6 follow-up of 2026-10-16): the relayer that will execute it runs it
      await orig.checkFundingReady(o as never);
      if (funding.olderGone) {
        // the withdrawal's own check: the older notes no longer cover the order, and nothing is sent
        const { OlderNotesUnavailable } = await import("@privacy-wallet/sdk/privateTx");
        throw new OlderNotesUnavailable(o.stored.runner?.maxTiming ?? 0);
      }
      o.onStatus?.("Withdrawing privately: handing it to the relayer…");
      orig.patchSwap(o.stored.orderId, { fundedTx: "0x" + "11".repeat(32), state: "funded" }, o.session);
      return { txHash: "0x" + "11".repeat(32) };
    },
  };
});

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  session.forget();
  noteStore.clear();
  resetOperationsMemory();
  resetWorld();
  funding.count = 0;
  funding.runner = undefined;
  funding.olderGone = false;
});

async function wallet(o: { recent?: boolean } = {}) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  // 1 ETH protected; at $2,500 a 0.5 ETH swap is standard (a tap); `recent`: protected a moment ago
  noteStore.add({
    note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n },
    leafIndex: 0,
    noteData: "0x",
    spent: false,
    ...(o.recent ? { addedAt: Date.now() } : {}),
  });
  await priceStore.refresh(deployment);
  expect(priceStore.state().status).toBe("ready");
}
function mount(path = "/swap") {
  const router = createMemoryRouter(
    [
      { path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: [path], future: ROUTER_FUTURE },
  );
  render(
    <Providers deployment={deployment}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
  return router;
}
const QUOTED = { timeout: 15_000 };
/** The page → the Review → one confirmation; returns the order and the router. */
async function confirmed(o: { delay?: boolean } = {}) {
  const router = mount();
  fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
  await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
  if (o.delay) fireEvent.click(screen.getByTestId("swap-delay"));
  fireEvent.click(screen.getByTestId("swap-review"));
  await act(async () => {
    fireEvent.click(await screen.findByTestId("review-confirm"));
  });
  // the progress names the record by its handle, never the order id (the audit round of 2026-10-16, c41)
  await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\/r[0-9a-f]{32}$/));
  const [order] = session.journal().swaps;
  return { router, orderId: order.orderId };
}
/** One tick of the order's runner, as the scheduler would run it. */
async function tick(orderId: string) {
  const a = session.journal().schedule.find((x) => x.id === `order-tick:${orderId}`);
  expect(a, "the order has a tick planned").toBeTruthy();
  let step: string | undefined;
  await act(async () => {
    step = (await runOrderTick(a!, { masterSeed: session.state().seed!, deployment }))?.step;
  });
  return step;
}
const stored = (orderId: string) => session.journal().swaps.find((x) => x.orderId === orderId)!;

describe("Swap with one confirmation (spec v2.0 §7.5–§7.7)", () => {
  it("the quote as the user types, the Review, one confirmation; then funded, checked, signed, simulated and handed over without a second tap", async () => {
    await wallet();
    const quoteCalls = () => calls.filter((c) => c.endsWith("/v1/quotes")).length;
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    expect(quoteCalls(), "one quote for what was typed (debounced)").toBe(1);
    const quoteBody = JSON.parse(requests.find((r) => r.url.endsWith("/v1/quotes"))!.body!);
    expect(quoteBody.destination, "the quote carries no destination: the engine quotes a placeholder").toBe("");
    expect(screen.getByTestId("swap-to").textContent).toContain("0.03");
    expect(screen.getByTestId("swap-destination").textContent).toContain("A fresh address of this wallet, used once.");
    expect(screen.getByTestId("destination-checks").querySelectorAll('[data-state="ok"]')).toHaveLength(3);
    expect(screen.getByTestId("swap-expires").textContent).toMatch(/valid for (59\d|600) s/);
    expect(screen.getByTestId("swap-provider-fee")).toBeTruthy();
    expect(screen.queryByTestId("swap-recent"), "funds protected long ago (or found by a scan): no delay advice").toBeNull();
    // the Review: the minimum, the fees, the destination; a tap below $50K; the non-atomic sentence once
    fireEvent.click(screen.getByTestId("swap-review"));
    expect(screen.getByTestId("review-minimum").textContent).toContain("0.03");
    expect(screen.getByTestId("review-not-atomic")).toBeTruthy();
    expect(screen.queryByTestId("hold-to-confirm")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await waitFor(() => expect(session.journal().swaps).toHaveLength(1));
    const [order] = session.journal().swaps;
    expect(order).toMatchObject({ approvedMin: LIMIT.toString(), state: "committed", runner: { confirmedAt: expect.any(Number) } });
    expect(order.runner?.delayUntil).toBeUndefined();
    expect(order.reviewedFee, "the relayer's fee the Review showed is journaled: the funding never pays more (audit c46)").toMatch(/^[0-9]+$/);
    expect(
      session.journal().schedule.some((a) => a.id === `fund-escrow:${order.orderId}`),
      "no 1–24 h funding by default",
    ).toBe(false);
    expect(getOperation(swapRecordId(order.orderId))).toMatchObject({ kind: "cross-chain", state: "AWAITING_AUTHORIZATION" });
    expect(await screen.findByTestId("swap-progress")).toBeTruthy();
    // the runner: funded, then signed and handed over in one tick
    expect(await tick(order.orderId)).toBe("funded");
    expect(funding.count).toBe(1);
    expect(await tick(order.orderId)).toBe("handed-over");
    expect(calls.filter((c) => c.endsWith("/v1/operations/:id/finalize"))).toHaveLength(1);
    expect(calls.filter((c) => c === "127.0.0.1:8790/swap/execute")).toHaveLength(1);
    const sim = rpcSeen.find((tx) => String(tx.to).toLowerCase() === FACTORY.toLowerCase());
    expect(sim, "deployAndExecute simulated before the hand-over").toBeTruthy();
    expect(calls.indexOf("127.0.0.1:1/")).toBeLessThan(calls.indexOf("127.0.0.1:8787/v1/operations/:id/finalize"));
    expect(stored(order.orderId)).toMatchObject({ jobId: order.orderId.toLowerCase(), state: "executing", simulation: { ok: true } });
    // the API's vouches (2026-10-16, audit gap 47): the commit's journaled and shown at the finalize; the call's handed to the relayer
    expect(stored(order.orderId).orderVouch).toBe(ORDER_VOUCH);
    expect(finalizeVouches).toEqual([ORDER_VOUCH]);
    expect(executeBodies.map((b) => b.vouch)).toEqual([{ execution: CALL_VOUCH }]);
    expect(await tick(order.orderId)).toBe("track");
    expect(funding.count, "funded once").toBe(1);
    expect(
      calls.filter((c) => c === "127.0.0.1:8790/swap/execute"),
      "handed over once",
    ).toHaveLength(1);
    await waitFor(() => expect(getOperation(swapRecordId(order.orderId))!.state).toBe("PROVIDER_EXECUTING"));
  }, 60_000);

  it("a quote the user typed past is cancelled: its request is aborted, never counted toward offline, and the newer quote is the one shown (V6 Stage 16)", async () => {
    await wallet();
    const quoteSignals: AbortSignal[] = [];
    let held = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/quotes")) {
        quoteSignals.push(init!.signal!);
        // the first quote hangs until it is cancelled
        if (held) {
          held = false;
          return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        }
      }
      return fetchMock(input, init);
    }) as typeof fetch;
    try {
      mount();
      fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
      await waitFor(() => expect(quoteSignals).toHaveLength(1), QUOTED);
      expect(quoteSignals[0].aborted).toBe(false);
      fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.6" } });
      expect(quoteSignals[0].aborted, "typing past a quote cancels its request").toBe(true);
      await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
      expect(quoteSignals).toHaveLength(2);
      expect(quoteSignals[1].aborted).toBe(false);
      expect(connectivity.get().online, "a cancelled request is not a network failure").toBe(true);
      expect(screen.queryByTestId("swap-no-route")).toBeNull();
    } finally {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    }
  });
  it("a reload continues from the journal: the progress route reads the operation, the next tick does not fund again", async () => {
    await wallet();
    const { orderId } = await confirmed();
    expect(await tick(orderId)).toBe("funded");
    cleanup(); // the tab is reloaded: the screen comes back on its progress route; the order's tick is still planned
    resetOrderRunnerMemory(); // and the runner's memory is gone (the API keeps the operation: its restarts are Stage 9's suites)
    mount(`/swap/progress/${swapRecordId(orderId)}`);
    expect(await screen.findByTestId("swap-progress")).toBeTruthy();
    expect(await tick(orderId)).toBe("handed-over");
    expect(funding.count, "never funded twice").toBe(1);
    expect(calls.filter((c) => c === "127.0.0.1:8790/swap/execute")).toHaveLength(1);
  }, 60_000);

  it("a completed swap whose provider reports no amount says so, never its minimum as delivered (audit round 2, r54)", async () => {
    await wallet();
    const { orderId } = await confirmed();
    const stored = session.journal().swaps.find((x) => x.orderId === orderId)!;
    // the executor's job ended and the provider (Across, Mayan) reported completion without an amount
    syncSwapRecord(
      stored,
      { state: "COMPLETED", label: "Completed", steps: [true, true, true, true], detail: "Delivered at your fresh address." } as never,
      { id: orderId, escrow: stored.endpoint, state: "completed", updatedAt: Date.now() } as never,
    );
    cleanup();
    mount(`/swap/progress/${swapRecordId(orderId)}`);
    const done = await screen.findByTestId("swap-done");
    expect(done.textContent).toContain("Swap complete.");
    expect(done.textContent, "the minimum is not what arrived").not.toMatch(/delivered/);
  }, 60_000);

  it("a refunded swap names what came back and that the privacy fee did not (the seventh review round)", async () => {
    await wallet();
    const { orderId } = await confirmed();
    const stored = session.journal().swaps.find((x) => x.orderId === orderId)!;
    const vault = String((stored.params as { refundVault: string }).refundVault);
    session.update((j) => {
      j.swaps.find((x) => x.orderId === orderId)!.refunds = [{ leafIndex: 7, vault, amount: (49n * 10n ** 16n).toString() }];
    });
    syncSwapRecord(
      session.journal().swaps.find((x) => x.orderId === orderId)!,
      { state: "REFUNDED", label: "Refunded", steps: [true, true, false, false], detail: "The escrow was re-shielded into your private balance." } as never,
      { id: orderId, escrow: stored.endpoint, state: "refunded", updatedAt: Date.now() } as never,
    );
    cleanup();
    mount(`/swap/progress/${swapRecordId(orderId)}`);
    const done = await screen.findByTestId("swap-done");
    expect(done.textContent).toContain("0.49 ETH returned to your protected balance");
    expect(done.textContent).toMatch(/privacy fee was earned at funding and does not come back/);
  }, 60_000);

  it("a refund that came back to a handed-over order's escrow offers Return funds on the Swap screen; the runner sends it (the ninth review round, 2026-11-04, C-05)", async () => {
    await wallet();
    const { orderId } = await confirmed();
    expect(await tick(orderId)).toBe("funded");
    expect(await tick(orderId)).toBe("handed-over");
    // the executor's watch ended and the provider paid the escrow back afterwards: no pause — the order is handed over
    const st = session.journal().swaps.find((x) => x.orderId === orderId)!;
    expect(st.paused).toBeUndefined();
    syncSwapRecord(
      st,
      {
        state: "LATE_REFUND",
        label: "Needs attention",
        steps: [true, true, false, false],
        detail: "The provider paid 0.49 ETH back to the one-time escrow.",
        settlement: "REFUND_AVAILABLE",
      } as never,
      { id: orderId, escrow: st.endpoint, state: "completed", updatedAt: Date.now() } as never,
    );
    cleanup();
    mount(`/swap/progress/${swapRecordId(orderId)}`);
    expect(screen.getByTestId("operation-progress").getAttribute("data-code")).toBe("late_refund");
    const before = relayerBodies.length;
    await act(async () => {
      fireEvent.click(await screen.findByTestId("swap-return-funds"));
    });
    await waitFor(() => expect(relayerBodies).toHaveLength(before + 1));
    expect(relayerBodies.at(-1).execution, "a refund-only request: nothing signed").toBeUndefined();
    expect(stored(orderId)).toMatchObject({ state: "refund-only" });
    expect(
      session.journal().schedule.some((a) => a.id === `order-tick:${orderId}`),
      "the runner tracks the refund",
    ).toBe(true);
  }, 60_000);

  it("the order is built on the tip the Review showed; one the service prices higher at the commit is refused, nothing journaled (the seventh review round)", async () => {
    await wallet();
    world.quoteTip = 10n ** 15n;
    await confirmed();
    const body = JSON.parse(requests.filter((r) => r.url.endsWith("/v1/operations")).at(-1)!.body!);
    expect(body.executorTip, "the commit names the tip the Review showed").toBe((10n ** 15n).toString());
    expect((session.journal().swaps[0].params as { executorTip: string }).executorTip, "and the order carries it").toBe((10n ** 15n).toString());
    world.orderTip = 11n * 10n ** 14n; // a service that prices it again, higher (still under three times the wallet's own estimate)
    cleanup();
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    fireEvent.click(screen.getByTestId("swap-review"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("review-confirm"));
    });
    await waitFor(() => expect(document.body.textContent).toMatch(/1100000000000000 is more than the 1000000000000000 the Review showed/));
    expect(session.journal().swaps, "the refused order is never journaled").toHaveLength(1);
  }, 60_000);

  it("the tracker's settlement label reads in the reader's language (audit round 2, n86)", async () => {
    await wallet();
    const { orderId } = await confirmed();
    const stored = session.journal().swaps.find((x) => x.orderId === orderId)!;
    syncSwapRecord(
      stored,
      {
        state: "DESTINATION_SUBMITTED",
        label: "Waiting for destination",
        steps: [true, true, true, false],
        detail: "The provider sent the destination transaction.",
      } as never,
      { id: orderId, escrow: stored.endpoint, state: "executed", updatedAt: Date.now() } as never,
    );
    // the track as the tracker journals it: its label is the tracker's English code
    patchSwap(orderId, { track: { state: "DESTINATION_SUBMITTED", label: "Waiting for destination", at: Date.now() } } as never);
    cleanup();
    await loadCatalog("ko");
    prefs().update({ locale: "ko", localeChosen: true }); // what the app applies on mount
    setLocale("ko");
    try {
      mount(`/swap/progress/${swapRecordId(orderId)}`);
      const line = await screen.findByTestId("swap-settlement");
      expect(line.textContent).toBe("목적지 도착 대기 중");
    } finally {
      prefs().reset();
      setLocale("en");
    }
    cleanup();
    mount(`/swap/progress/${swapRecordId(orderId)}`);
    expect((await screen.findByTestId("swap-settlement")).textContent, "in English, the tracker's own words").toBe("Waiting for destination");
  }, 60_000);

  it("a call paying someone else is stopped with nothing signed; Return funds sends the refund-only job", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.bend = { dest: "bc1qattacker" };
    expect(await tick(orderId)).toBe("paused");
    expect(stored(orderId).paused?.code).toBe("unsafe_contract_call");
    expect(
      calls.some((c) => c.endsWith("/finalize")),
      "nothing signed is handed over",
    ).toBe(false);
    expect(getOperation(swapRecordId(orderId))).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: { code: "unsafe_contract_call", fundsClass: "still-protected" },
    });
    expect((await screen.findByTestId("operation-progress-error")).textContent).toContain("We stopped this transaction");
    expect(screen.getByTestId("operation-progress").getAttribute("data-code"), "the code the local stack's run reads").toBe("unsafe_contract_call");
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-return-funds"));
    });
    await waitFor(() => expect(relayerBodies).toHaveLength(1));
    expect(relayerBodies[0].execution, "a refund-only job: no signature").toBeUndefined();
    expect(relayerBodies[0].vouch, "with the API's vouch for the order, from its commit (2026-10-16)").toEqual({ order: ORDER_VOUCH });
    expect(relayerBodies[0].params).toEqual(stored(orderId).params);
    expect(stored(orderId)).toMatchObject({ state: "refund-only" });
    expect(jobs.get(orderId.toLowerCase())).toBe("refund-only");
  }, 60_000);

  it("a call the chain would revert is not handed over: the order waits, Try again prepares a fresh quote", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.rpcBend = { revert: toFunctionSelector("ProviderCallFailed()") as Hex, providerReason: "THORChain: trading halted" };
    expect(await tick(orderId)).toBe("paused");
    expect(stored(orderId).paused?.code).toBe("execution_unavailable");
    expect(calls.some((c) => c.endsWith("/finalize"))).toBe(false);
    expect((await screen.findByTestId("operation-progress-error")).textContent).toContain("The route cannot execute right now");
    expect(screen.getByTestId("operation-progress").getAttribute("data-code")).toBe("execution_unavailable");
    world.rpcBend = {};
    fireEvent.click(screen.getByTestId("swap-try-again"));
    expect(await tick(orderId)).toBe("handed-over");
    expect(calls.filter((c) => c === "127.0.0.1:8790/swap/execute")).toHaveLength(1);
  }, 60_000);

  it("a lower minimum waits for the user — nothing signed —; accepting it signs once at that minimum, which is journaled, on the very call it was read from", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.bend = { limit: LIMIT - 60_000n };
    expect(await tick(orderId)).toBe("paused");
    expect(getOperation(swapRecordId(orderId))).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "minimum_moved" } });
    const card = await screen.findByTestId("swap-minimum-moved");
    expect(card.textContent).toContain("0.0294");
    expect(card.textContent).toContain("0.03");
    expect(calls.some((c) => c.endsWith("/finalize"))).toBe(false);
    const prepares = () => calls.filter((c) => c.endsWith("/prepare")).length;
    const quoted = prepares();
    world.bend = { limit: LIMIT - 90_000n }; // the market keeps moving: a fresh quote would be lower again (audit gap 43)
    fireEvent.click(screen.getByTestId("swap-accept-minimum"));
    expect(stored(orderId).approvedMin).toBe((LIMIT - 60_000n).toString());
    expect(await tick(orderId)).toBe("handed-over");
    expect(prepares(), "the accepted call was checked and signed: no fresh quote").toBe(quoted);
    expect(calls.filter((c) => c.endsWith("/finalize"))).toHaveLength(1);
  }, 60_000);

  // 2026-10-14: the local stack's run stopped a funded swap here as an unsafe call — the call named the vault THORChain had
  // suggested a few seconds before, and the gateways now suggested another of its active vaults
  it("THORChain suggests another of its active vaults by the time the call is checked: it is signed and handed over, never stopped", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.gateways = { inbound: VAULT_2, active: [VAULT_2, VAULT], down: 0 }; // the service's call still names VAULT
    expect(await tick(orderId)).toBe("handed-over");
    expect(stored(orderId).paused).toBeUndefined();
    expect(
      calls.some((c) => c.endsWith("/thorchain/vaults/asgard")),
      "the gateways' lists of active vaults were read",
    ).toBe(true);
    expect(calls.filter((c) => c === "127.0.0.1:8790/swap/execute")).toHaveLength(1);
  }, 60_000);

  it("a vault the gateways do not list as active is still stopped with nothing signed", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.gateways = { inbound: VAULT_2, active: [VAULT_2], down: 0 };
    expect(await tick(orderId)).toBe("paused");
    expect(stored(orderId).paused).toMatchObject({ code: "unsafe_contract_call" });
    expect(stored(orderId).paused?.detail).toMatch(/vault/);
    expect(calls.some((c) => c.endsWith("/finalize"))).toBe(false);
  }, 60_000);

  it("THORNode gateways that do not answer at signing: nothing signed, the order is not stopped, and it is signed once they answer", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.gateways.down = 2;
    const a = session.journal().schedule.find((x) => x.id === `order-tick:${orderId}`)!;
    let thrown: unknown;
    await act(async () => {
      thrown = await runOrderTick(a, { masterSeed: session.state().seed!, deployment }).then(
        () => null,
        (e) => e,
      );
    });
    // an outage: tried again within the minute, inside the order's window — never thrown to the scheduler's backoff of 10
    // minutes, then 20, which outran the window (the audit's unverified m40)
    expect(thrown, "an outage, tried again within the minute").toBeNull();
    expect(
      session.journal().schedule.some((x) => x.id === `order-tick:${orderId}`),
      "its next tick is due",
    ).toBe(true);
    expect(stored(orderId).paused).toBeUndefined();
    expect(calls.some((c) => c.endsWith("/finalize"))).toBe(false);
    world.gateways.down = 0;
    expect(await tick(orderId)).toBe("handed-over");
    expect(calls.filter((c) => c.endsWith("/finalize"))).toHaveLength(1);
  }, 60_000);

  it("THORChain halts its inbound before an accepted call is signed: nothing signed, not stopped as unsafe; signed once it resumes", async () => {
    // 2026-10-14: the API's prepare reads a halt as an outage, but the wallet's check of a call accepted before had stopped
    // the funded swap as an unsafe call
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.bend = { limit: LIMIT - 60_000n };
    expect(await tick(orderId)).toBe("paused");
    world.gateways.halted = true;
    fireEvent.click(await screen.findByTestId("swap-accept-minimum"));
    const a = session.journal().schedule.find((x) => x.id === `order-tick:${orderId}`)!;
    let thrown: unknown;
    await act(async () => {
      thrown = await runOrderTick(a, { masterSeed: session.state().seed!, deployment }).then(
        () => null,
        (e) => e,
      );
    });
    // an outage: tried again within the minute, inside the order's window — never thrown to the scheduler's backoff of 10
    // minutes, then 20, which outran the window (the audit's unverified m40)
    expect(thrown, "an outage, tried again within the minute").toBeNull();
    expect(
      session.journal().schedule.some((x) => x.id === `order-tick:${orderId}`),
      "its next tick is due",
    ).toBe(true);
    expect(stored(orderId).paused).toBeUndefined();
    expect(calls.some((c) => c.endsWith("/finalize"))).toBe(false);
    world.gateways.halted = false;
    expect(await tick(orderId)).toBe("handed-over");
    expect(calls.filter((c) => c.endsWith("/finalize"))).toHaveLength(1);
  }, 60_000);

  it("the call whose lower minimum was accepted names a vault THORChain has retired since: a fresh call is prepared, checked and signed", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.bend = { limit: LIMIT - 60_000n };
    expect(await tick(orderId)).toBe("paused");
    await screen.findByTestId("swap-minimum-moved");
    const prepares = () => calls.filter((c) => c.endsWith("/prepare")).length;
    const quoted = prepares();
    // a churn: VAULT retires, VAULT_2 is suggested, and the service's next call names it
    world.gateways = { inbound: VAULT_2, active: [VAULT_2], down: 0 };
    world.callVault = VAULT_2;
    fireEvent.click(screen.getByTestId("swap-accept-minimum"));
    expect(await tick(orderId)).toBe("handed-over");
    expect(prepares(), "the accepted call was outdated: one fresh quote").toBe(quoted + 1);
    expect(stored(orderId).paused).toBeUndefined();
    expect(calls.filter((c) => c.endsWith("/finalize"))).toHaveLength(1);
    const execute = requests.filter((r) => r.url.endsWith("/swap/execute")).at(-1); // the scenario's requests accumulate across tests
    expect(execute?.body?.toLowerCase(), "the signed call deposits into the vault THORChain lists now").toContain(VAULT_2.slice(2).toLowerCase());
  }, 60_000);

  // 2026-10-14: an order whose execution window closed had been funded anyway, or retried its signature for good with no way
  // back on its screen
  const windowEnd = (orderId: string) => Number((stored(orderId).params as { executeDeadline: number }).executeDeadline) * 1000;
  async function tickAt(orderId: string, now: number) {
    const a = session.journal().schedule.find((x) => x.id === `order-tick:${orderId}`)!;
    let step: string | undefined;
    await act(async () => {
      step = (await runOrderTick(a, { masterSeed: session.state().seed!, deployment, now: () => now }))?.step;
    });
    return step;
  }

  it("an order whose window is about to close before its funding is stopped with nothing sent: the card says why, Review again", async () => {
    await wallet();
    const { router, orderId } = await confirmed();
    expect(await tickAt(orderId, windowEnd(orderId) - 60_000)).toBe("stopped");
    expect(funding.count, "nothing sent").toBe(0);
    expect(getOperation(swapRecordId(orderId))).toMatchObject({ state: "CANCELLED", reason: { code: "order_expired", fundsClass: "not-moved" } });
    const card = await screen.findByTestId("operation-progress-error");
    expect(card.textContent).toContain("The order expired before it was funded");
    fireEvent.click(screen.getByTestId("swap-review-again"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/swap"));
  }, 60_000);

  it("a funded swap left past its execution window says it ran out of time and offers Return funds; nothing is signed", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    // "nothing was swapped" is read from the escrow, which still holds the order (the ninth review round, C-09)
    world.escrowBalance = BigInt((stored(orderId).params as { amount: string }).amount);
    expect(await tickAt(orderId, windowEnd(orderId) + 60_000)).toBe("paused");
    expect(
      calls.some((c) => c.endsWith("/prepare")),
      "no quote prepared, nothing signed",
    ).toBe(false);
    expect(getOperation(swapRecordId(orderId))).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: { code: "execution_window_closed", fundsClass: "still-protected" },
    });
    expect((await screen.findByTestId("operation-progress-error")).textContent).toContain("The swap ran out of time");
    expect(screen.getByTestId("operation-progress").getAttribute("data-code")).toBe("execution_window_closed");
    expect(screen.queryByTestId("swap-try-again"), "trying again cannot work").toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-return-funds"));
    });
    await waitFor(() => expect(relayerBodies).toHaveLength(1));
    expect(relayerBodies[0].execution, "a refund-only job: no signature").toBeUndefined();
    expect(relayerBodies[0].vouch, "with the API's vouch for the order, from its commit (2026-10-16)").toEqual({ order: ORDER_VOUCH });
    expect(stored(orderId)).toMatchObject({ state: "refund-only" });
  }, 60_000);

  it("a tip the wallet cannot check is never accepted: without the fee history no swap is set up, nothing is sent, and it says so (audit round 2, critic gap 4)", async () => {
    await wallet();
    world.feesDown = true;
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    fireEvent.click(screen.getByTestId("swap-review"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    expect((await screen.findByTestId("swap-status")).textContent).toContain("could not read the network fees");
    expect(session.journal().swaps, "nothing was committed").toHaveLength(0);
    expect(
      calls.filter((c) => c.endsWith("/v1/operations")),
      "the swap service was not even asked",
    ).toHaveLength(0);
    expect(funding.count, "nothing funded").toBe(0);
  }, 60_000);

  it("an expired quote says so and that nothing moved; a new quote brings the Review back", async () => {
    await wallet();
    world.ttlSeconds = 0;
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    const expired = await screen.findByTestId("swap-expired", {}, QUOTED);
    expect(expired.textContent).toContain("This quote is no longer available.");
    expect(expired.textContent).toContain("Your funds were not moved.");
    world.ttlSeconds = 600;
    fireEvent.click(screen.getByTestId("swap-new-quote"));
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    expect(session.journal().swaps, "nothing was committed").toHaveLength(0);
  }, 60_000);

  it("right after a protect the protection reads Medium with the delay offered; delayed, the funding waits for its drawn time (1–24 h)", async () => {
    await wallet({ recent: true });
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    expect(screen.getByTestId("swap-quote").textContent).toContain("Medium protection");
    expect(screen.getByTestId("swap-recent").textContent).toContain("You protected these funds recently; waiting makes this swap harder to link.");
    // no older notes: the funding waits a random 1–24 h; the card stays while the choice is on, and it can be turned off
    fireEvent.click(screen.getByTestId("swap-delay"));
    expect(screen.getByTestId("swap-delay-note").textContent).toBe("The swap is funded at a random time within 1–24 hours.");
    fireEvent.click(screen.getByTestId("swap-delay"));
    expect(screen.queryByTestId("swap-delay-note")).toBeNull();
    cleanup();
    const { orderId } = await confirmed({ delay: true });
    const until = stored(orderId).runner!.delayUntil!;
    expect(until - Date.now()).toBeGreaterThan(3600_000 - 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(await tick(orderId)).toBe("delayed");
    expect(funding.count).toBe(0);
    expect((await screen.findByTestId("swap-funding-at")).textContent).toMatch(/Funded at/);
  }, 60_000);

  it("under 'Fastest' no delay is offered: its order's window is minutes, and a delayed funding could only miss it (the audit round of 2026-10-16, c39)", async () => {
    await wallet({ recent: true });
    settings.set({ preference: "fastest" });
    try {
      mount();
      fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
      await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
      expect(screen.getByTestId("swap-recent"), "the recent-protect notice stays").toBeTruthy();
      expect(screen.queryByTestId("swap-delay"), "no delay to choose").toBeNull();
    } finally {
      settings.set({ preference: "balanced" });
    }
  }, 60_000);

  /** 1 ETH protected a moment ago (the smallest note a 0.5 ETH swap spends) and 2 ETH protected three days ago. */
  async function olderWallet() {
    await wallet({ recent: true });
    noteStore.add({
      note: { vaultId: BigInt(ETH_VAULT), amount: 2n * 10n ** 18n, ownerCommitment: 1n, noteSecret: 3n },
      leafIndex: 1,
      noteData: "0x",
      spent: false,
      addedAt: Date.now() - 3 * 86400_000,
    });
  }

  it("'Delay for more privacy' spends older notes first: funded at once from them, at the level they give", async () => {
    await olderWallet();
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
    expect(screen.getByTestId("swap-quote").textContent).toContain("Medium protection");
    fireEvent.click(screen.getByTestId("swap-delay"));
    expect(screen.getByTestId("swap-delay-note").textContent).toBe("The swap is funded now from funds you protected earlier.");
    expect(screen.getByTestId("swap-quote").textContent).toContain("High protection");
    fireEvent.click(screen.getByTestId("swap-review"));
    expect(screen.getByTestId("swap-review-delay").textContent).toBe("The swap is funded now from funds you protected earlier.");
    await act(async () => {
      fireEvent.click(await screen.findByTestId("review-confirm"));
    });
    await waitFor(() => expect(session.journal().swaps).toHaveLength(1));
    const [order] = session.journal().swaps;
    expect(order.runner).toEqual({ confirmedAt: expect.any(Number), maxTiming: 0 });
    expect(await tick(order.orderId), "no delay: funded at the first tick").toBe("funded");
    expect(funding.count).toBe(1);
    expect(funding.runner, "the funding is held to the older notes").toMatchObject({ maxTiming: 0 });
  }, 60_000);

  it("an order to be funded from older notes that no longer cover it is stopped unfunded: the card says so, Review again", async () => {
    await olderWallet();
    funding.olderGone = true;
    const { router, orderId } = await confirmed({ delay: true });
    expect(stored(orderId).runner).toMatchObject({ maxTiming: 0 });
    expect(await tick(orderId)).toBe("stopped");
    expect(stored(orderId)).toMatchObject({ state: "abandoned", paused: { code: "older_notes_unavailable" } });
    expect(
      session.journal().schedule.filter((a) => !a.done && a.orderId === orderId),
      "nothing retries it with other notes",
    ).toEqual([]);
    expect(getOperation(swapRecordId(orderId))).toMatchObject({ state: "CANCELLED", reason: { code: "older_notes_unavailable", fundsClass: "not-moved" } });
    const card = await screen.findByTestId("operation-progress-error");
    expect(card.textContent).toContain("Your older funds no longer cover this swap");
    expect(card.textContent).toContain("Your funds were not moved.");
    fireEvent.click(screen.getByTestId("swap-review-again"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/swap"));
  }, 60_000);

  it("a relayer that does not run the swap service's orders: the swap stops before funding and the card says so (a V6 follow-up of 2026-10-16)", async () => {
    await wallet();
    world.relayerInfo = { swapFactory: FACTORY, vouchers: ["0x" + "ab".repeat(20)] }; // a relayer still on another key
    const { orderId } = await confirmed();
    expect(await tick(orderId)).toBe("stopped");
    expect(funding.count, "asked once").toBe(1);
    expect(stored(orderId).fundedTx, "nothing was sent").toBeUndefined();
    expect(stored(orderId)).toMatchObject({ state: "abandoned", paused: { code: "relayer_not_ready" } });
    expect(
      session.journal().schedule.filter((a) => !a.done && a.orderId === orderId),
      "nothing retries it",
    ).toEqual([]);
    expect(getOperation(swapRecordId(orderId))).toMatchObject({ state: "CANCELLED", reason: { code: "relayer_not_ready", fundsClass: "not-moved" } });
    const card = await screen.findByTestId("operation-progress-error");
    expect(card.textContent).toContain("The relayer is not set up for this swap");
    expect(card.textContent).toContain("Your funds were not moved.");
  }, 60_000);

  it("a key the swap service no longer takes: a swap confirmed under it stops before funding and the card says so (a V6 follow-up of 2026-10-16)", async () => {
    await wallet();
    const { orderId } = await confirmed();
    // what the service's former key gave this order at its commit, and a service that now signs with another key and honors no former one
    const vouch = await sign({ hash: orderVouchDigest(1n, stored(orderId).endpoint as Address), privateKey: ("0x" + "5a".repeat(32)) as Hex, to: "hex" });
    patchSwap(orderId, { orderVouch: vouch }, session);
    world.serviceDeployment = { voucher: privateKeyToAccount(("0x" + "5c".repeat(32)) as Hex).address };
    expect(await tick(orderId)).toBe("stopped");
    expect(stored(orderId).fundedTx, "nothing was sent").toBeUndefined();
    expect(stored(orderId)).toMatchObject({ state: "abandoned", paused: { code: "service_key_changed" } });
    expect(getOperation(swapRecordId(orderId))).toMatchObject({ state: "CANCELLED", reason: { code: "service_key_changed", fundsClass: "not-moved" } });
    const card = await screen.findByTestId("operation-progress-error");
    expect(card.textContent).toContain("The swap service changed its key since you confirmed this swap");
    expect(card.textContent).toContain("Your funds were not moved.");
  }, 60_000);

  it("the leakage gate: no request of quote → confirm → fund → sign → hand-over carries a secret or a forbidden field; every host is allow-listed", async () => {
    await wallet();
    requests.length = 0;
    const { orderId } = await confirmed();
    await tick(orderId);
    await tick(orderId);
    const { secrets } = sessionSecrets({ password: "a strong password" });
    expect(secrets.find((x) => x.name.startsWith("the phrase"))!.values.length, "the phrase's words are searched for (audit round 2, n74)").toBeGreaterThan(20);
    expect(requests.length).toBeGreaterThan(5);
    const hosts = [...new Set(requests.map((r) => new URL(r.url).hostname))];
    expect(hosts.filter((h) => !allowedHosts().includes(h))).toEqual([]);
    for (const r of requests) {
      expect(leaks(`${r.url}\n${r.body ?? ""}`, secrets), r.url).toEqual([]);
      if (r.body)
        expect(
          [...fieldNames(JSON.parse(r.body))].filter((n) => FORBIDDEN_FIELDS.test(n)),
          `${r.url}: field names`,
        ).toEqual([]);
    }
  }, 60_000);
});
