// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), after the slice's critique: an order the runner stopped unfunded on a refused call (call_refused, D11-7)
// says why on its own Simple view, with "Review again" — it had read as a plain "Cancelled" (the words critic's probe K3).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { getOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { swapRecordId, syncSwapRecord } from "@privacy-wallet/sdk/operations/swapRecords";
import { routeHandle } from "@privacy-wallet/sdk/wallet/routeHandles";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { applyConfig, testConfig } from "../src/config";

const T0 = Date.now();
const ORDER = "0x" + "ab".repeat(32);

afterEach(() => {
  cleanup();
  session.forget();
  resetOperationsMemory();
});

async function stopped(code: string) {
  applyConfig(testConfig());
  await session.create("a strong password");
  session.acknowledgePhrase();
  const s = {
    orderId: ORDER, attemptId: "0x" + "01".repeat(32), refundCounter: 7, provider: "thorchain", policy: "balanced",
    request: { from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: (10n ** 18n).toString(), destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", slippageBps: 50 },
    params: { amount: (10n ** 18n).toString() }, endpoint: "0x00000000000000000000000000000000000000e5",
    quote: { provider: "thorchain", toAmount: "3000000", toAmountMin: "2970000" }, approvedMin: "2970000", createdAt: T0, state: "abandoned", refundNoteData: "0x00",
    runner: { confirmedAt: T0, delayUntil: T0 + 3600_000 },
    paused: { code, detail: "the provider call does not do what this wallet asked for (mayan receiver: x) — not signing it", at: T0 },
  } as unknown as StoredSwap;
  session.update((j) => {
    j.swaps = [s];
  });
  syncSwapRecord(s, null, null, T0);
  const router = createMemoryRouter(
    [
      { path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={null} /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: [`/swap/progress/${routeHandle(swapRecordId(ORDER))}`], future: ROUTER_FUTURE },
  );
  render(
    <Providers deployment={null}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
  return getOperation(swapRecordId(ORDER));
}

describe("a swap stopped unfunded on a refused call (D11-7)", () => {
  it("says why on its own view, in the wallet's words, with Review again — never a plain Cancelled", async () => {
    expect(await stopped("call_refused")).toMatchObject({ state: "CANCELLED", reason: { code: "call_refused", fundsClass: "not-moved" } });
    const card = await screen.findByTestId("operation-progress-error");
    expect(card.textContent).toContain("did not match what you reviewed");
    expect(screen.getByTestId("swap-review-again")).toBeTruthy();
    expect(screen.queryByTestId("swap-done"), "no success card").toBeNull();
  });
});
