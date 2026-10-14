// @vitest-environment happy-dom
// The Swap screen with ONE confirmation (spec v2.0 §7.5–§7.7, §13.4, §14.1; the owner's decision of 2026-10-13), against
// the swap service's REAL engine behind the fetch mock of test/helpers/swapWorld.ts: the quote fetched as the user types
// (no destination sent), the Review, one confirmation — the order committed with the minimum shown —, then the order
// runner (driven tick by tick here, as the App's scheduler would) funds it (the private withdrawal has its own suites:
// stubbed here), prepares the hard quote, checks the provider call, signs, simulates and hands it over: no second tap. A
// call paying someone else is stopped with nothing signed and goes back through its refund-only job; a call the chain
// would revert is not handed over; a lower minimum waits for the user's choice; a reload continues from the journal with
// no second funding; an expired quote says so; right after a protect the protection reads Medium and the funding can be
// delayed; nothing secret leaves the wallet.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { toFunctionSelector, type Hex } from "viem";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { resetOrderRunnerMemory, runOrderTick } from "@privacy-wallet/sdk/wallet/orderRunner";
import { getOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { swapRecordId } from "@privacy-wallet/sdk/operations/swapRecords";
import { allowedHosts } from "@privacy-wallet/privacy-engine/transport/http";
import { fieldNames, FORBIDDEN_FIELDS, leaks, sessionSecrets } from "./helpers/leakage";
import { calls, deployment, ETH_VAULT, FACTORY, fetchMock, jobs, LIMIT, relayerBodies, requests, resetWorld, rpcSeen, world } from "./helpers/swapWorld";

// the private withdrawal into the escrow has its own suites (privacy-leakage, the local stack): here it is counted
const funding = vi.hoisted(() => ({ count: 0 }));
vi.mock("@privacy-wallet/sdk/swapFunding", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/swapFunding")>();
  return {
    ...orig,
    fundEscrow: async (o: { stored: { orderId: string }; onStatus?: (l: string) => void; session?: never }) => {
      funding.count++;
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
  await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\/swap:0x[0-9a-f]{64}$/));
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
    expect(
      session.journal().schedule.some((a) => a.id === `fund-escrow:${order.orderId}`),
      "no 1–24 h funding by default",
    ).toBe(false);
    expect(getOperation(swapRecordId(order.orderId))).toMatchObject({ kind: "cross-chain", state: "AWAITING_SIGNATURE" });
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
    expect(await tick(order.orderId)).toBe("track");
    expect(funding.count, "funded once").toBe(1);
    expect(
      calls.filter((c) => c === "127.0.0.1:8790/swap/execute"),
      "handed over once",
    ).toHaveLength(1);
    await waitFor(() => expect(getOperation(swapRecordId(order.orderId))!.state).toBe("EXECUTING"));
  }, 60_000);

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
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-return-funds"));
    });
    await waitFor(() => expect(relayerBodies).toHaveLength(1));
    expect(relayerBodies[0].execution, "a refund-only job: no signature").toBeUndefined();
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
    world.rpcBend = {};
    fireEvent.click(screen.getByTestId("swap-try-again"));
    expect(await tick(orderId)).toBe("handed-over");
    expect(calls.filter((c) => c === "127.0.0.1:8790/swap/execute")).toHaveLength(1);
  }, 60_000);

  it("a lower minimum waits for the user — nothing signed —; accepting it signs once at that minimum, which is journaled", async () => {
    await wallet();
    const { orderId } = await confirmed();
    await tick(orderId);
    world.bend = { limit: LIMIT - 60_000n };
    expect(await tick(orderId)).toBe("paused");
    expect(getOperation(swapRecordId(orderId))).toMatchObject({ state: "QUOTE_EXPIRED", reason: { code: "minimum_moved" } });
    const card = await screen.findByTestId("swap-minimum-moved");
    expect(card.textContent).toContain("0.0294");
    expect(card.textContent).toContain("0.03");
    expect(calls.some((c) => c.endsWith("/finalize"))).toBe(false);
    fireEvent.click(screen.getByTestId("swap-accept-minimum"));
    expect(stored(orderId).approvedMin).toBe((LIMIT - 60_000n).toString());
    expect(await tick(orderId)).toBe("handed-over");
    expect(calls.filter((c) => c.endsWith("/finalize"))).toHaveLength(1);
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
    cleanup();
    const { orderId } = await confirmed({ delay: true });
    const until = stored(orderId).runner!.delayUntil!;
    expect(until - Date.now()).toBeGreaterThan(3600_000 - 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(await tick(orderId)).toBe("delayed");
    expect(funding.count).toBe(0);
    expect((await screen.findByTestId("swap-funding-at")).textContent).toMatch(/Funded at/);
  }, 60_000);

  it("the leakage gate: no request of quote → confirm → fund → sign → hand-over carries a secret or a forbidden field; every host is allow-listed", async () => {
    await wallet();
    requests.length = 0;
    const { orderId } = await confirmed();
    await tick(orderId);
    await tick(orderId);
    const { secrets } = sessionSecrets({ password: "a strong password", phrase: session.state().pendingPhrase ?? "" });
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
