// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), the Swap screen's part of review E's flows: the $80,000 Review's Protected execution card
// against the Review's own facts (E11-12) — a typed-in Bitcoin address reads "not re-confirmed yet" until the re-confirmation, a route
// whose health did not pass is never "Route health checked" —, and the Swap's error lines read out as alerts (E11-6): the Review's failed
// confirmation, the progress page's failed Return funds.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { Protection } from "@privacy-wallet/sdk/swapService";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { swapRecordId, syncSwapRecord } from "@privacy-wallet/sdk/operations/swapRecords";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { routeHandle } from "@privacy-wallet/sdk/wallet/routeHandles";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { en } from "../src/app/i18n/en";
import { Providers } from "../src/app/Providers";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { prefs } from "../src/storage/prefs";
import { deployment, ETH_VAULT, fetchMock, resetWorld, world } from "./helpers/swapWorld";

// the route's health as the Review reads it, failing on demand (E11-12); the rest of the module as it is
const health = vi.hoisted(() => ({ bad: false }));
vi.mock("../src/features/swap/protectedChecks", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/features/swap/protectedChecks")>();
  return {
    ...orig,
    providerHealthy: (...args: Parameters<typeof orig.providerHealthy>) =>
      health.bad ? { ok: false as const, code: "provider_unhealthy", detail: "a security incident within the last day" } : orig.providerHealthy(...args),
  };
});
// a Return funds that fails (E11-6): the relayer does not answer; nothing else of the runner changes
const ret = vi.hoisted(() => ({ fail: false }));
vi.mock("@privacy-wallet/sdk/wallet/orderRunner", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/wallet/orderRunner")>();
  return {
    ...orig,
    returnFunds: async (...args: Parameters<typeof orig.returnFunds>) => {
      if (ret.fail) throw new Error("the relayer did not answer; nothing was changed");
      return orig.returnFunds(...args);
    },
  };
});
// nothing here is funded for real: the private withdrawal into the escrow has its own suites
vi.mock("@privacy-wallet/sdk/swapFunding", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/swapFunding")>();
  return {
    ...orig,
    fundEscrow: async () => {
      throw new Error("not funded in this suite");
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
  settings.reset();
  prefs().reset();
  health.bad = false;
  ret.fail = false;
});

const ETH = 10n ** 18n;
/** The engine's recommendation at the $50K band (swap-protected-steps.test.tsx's): one order by default. */
const bandPlan: Protection = {
  provider: "thorchain",
  riskClass: "R3",
  flags: [],
  custody: "tss-vaults",
  bandBps: [1250, 2500],
  capBps: 2500,
  sizing: "varied",
  concurrency: "sequential",
  maxParallel: 1,
  gate: "destination-final",
  cadenceSeconds: [60, 300],
  providerShareCapBps: 10000,
  executeWindowSeconds: 1800,
  estimatedTranches: 5,
  estimatedSeconds: 3600,
  trancheUsd: [10_000, 20_000],
  capUsd: 20_000,
  trancheImpactBps: 1,
  thinMarket: false,
  maxPieceUnits: null,
  concentration: { providers: [{ id: "thorchain", shareBps: 10000 }], singleVenue: true, capBps: 10000 },
  elpf: { prior: 0.02, pFailure: 0.02, perTrancheUsd: 400, perCampaignUsd: 400 },
  staged: false,
  reasons: [],
  exposureTier: "R3",
};

async function wallet(ethNotes: bigint) {
  const chosen = settings.get();
  await session.create("a strong password");
  session.acknowledgePhrase();
  settings.set(chosen);
  noteStore.add({
    note: { vaultId: BigInt(ETH_VAULT), amount: ethNotes * ETH, ownerCommitment: 1n, noteSecret: 2n },
    leafIndex: 0,
    noteData: "0x",
    spent: false,
  });
  await priceStore.refresh(deployment); // ETH at $2,500: 32 ETH is $80,000 — the $50K band
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
async function review(amount: string) {
  fireEvent.input(screen.getByTestId("amount-input"), { target: { value: amount } });
  await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
  fireEvent.click(screen.getByTestId("swap-review"));
  return screen.findByTestId("review-view");
}
const checks = () =>
  within(screen.getByTestId("review-protected-execution"))
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");

describe("E11-12: the $80,000 Review's Protected execution card against the Review's own facts", () => {
  it("a route whose health did not pass: never 'Route health checked' — the card says so beside the route's warning, the hold disabled", async () => {
    world.protection = bandPlan;
    health.bad = true;
    await wallet(40n);
    mount();
    await review("32");
    expect(screen.getByTestId("swap-route-health"), "the Review's own warning").toBeTruthy();
    expect(checks(), "the probe's tick over the warning").not.toContain(`✓ ${en["screen.review.large.route"]}`);
    expect(checks()).toContain(`⚠ ${en["screen.review.large.routeOpen"]}`);
    expect(checks(), "the destination is this wallet's fresh address").toContain(`✓ ${en["screen.review.large.destination"]}`);
    expect(screen.getByTestId("hold-to-confirm")).toBeDisabled();
  });

  it("a typed-in Bitcoin address: 'not re-confirmed yet' until the re-confirmation, then 'Destination verified'", async () => {
    world.protection = bandPlan;
    await wallet(40n);
    mount();
    fireEvent.input(screen.getByTestId("destination-input"), { target: { value: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu" } });
    await review("32");
    expect(checks(), "the probe's tick before the re-confirmation").not.toContain(`✓ ${en["screen.review.large.destination"]}`);
    expect(checks()).toContain(`○ ${en["screen.review.large.destinationOpen"]}`);
    expect(checks(), "the route is healthy here").toContain(`✓ ${en["screen.review.large.route"]}`);
    expect(screen.getByTestId("hold-to-confirm")).toBeDisabled();
    // the check's own card is titled for its action until then (the third critique: "Destination verified" had sat beside "not re-confirmed")
    const title = () => screen.getByTestId("swap-destination-ack").querySelector(".ds-card-title")?.textContent;
    expect(title()).toBe(en["screen.swap.destinationCheck"]);
    fireEvent.click(screen.getByTestId("swap-destination-ack-button"));
    await waitFor(() => expect(checks()).toContain(`✓ ${en["screen.review.large.destination"]}`));
    expect(checks()).not.toContain(`○ ${en["screen.review.large.destinationOpen"]}`);
    expect(title()).toBe(en["screen.swap.destinationVerified"]);
  });
});

describe("E11-6: the Swap's error lines are read out as alerts", () => {
  it("the Review's confirmation that fails says so in an alert", async () => {
    world.feesDown = true; // the wallet cannot read the network fees it checks the execution's tip against: nothing is set up
    await wallet(1n);
    mount();
    await review("0.5");
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    const line = await screen.findByTestId("swap-status");
    expect(line).toHaveAttribute("role", "alert");
    expect(session.journal().swaps, "nothing was committed").toHaveLength(0);
  });

  /** A funded order paused by the runner, journaled with its record, its progress page open. */
  async function paused(p: NonNullable<StoredSwap["paused"]>) {
    await wallet(1n);
    const orderId = "0x" + "ab".repeat(32);
    const s = {
      orderId,
      attemptId: "0x" + "01".repeat(32),
      refundCounter: 7,
      provider: "thorchain",
      policy: "balanced",
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
        amount: ETH.toString(),
        destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
        slippageBps: 50,
      },
      params: { amount: ETH.toString() },
      endpoint: "0x00000000000000000000000000000000000000e5",
      quote: { provider: "thorchain", toAmount: "3000000", toAmountMin: "2970000" },
      approvedMin: "2970000",
      createdAt: Date.now() - 60_000,
      state: "funded",
      fundedTx: "0x" + "11".repeat(32),
      refundNoteData: "0x00",
      runner: { confirmedAt: Date.now() - 60_000 },
      paused: p,
    } as unknown as StoredSwap;
    session.update((j) => {
      j.swaps = [s];
    });
    syncSwapRecord(s, null, null, Date.now());
    ret.fail = true;
    mount(`/swap/progress/${routeHandle(swapRecordId(orderId))}`);
  }

  it("a Return funds that fails on the new minimum's choice is an alert", async () => {
    await paused({ code: "minimum_moved", minOut: "2900000", approved: "2970000", at: Date.now() });
    const card = await screen.findByTestId("swap-minimum-moved");
    await act(async () => {
      fireEvent.click(within(card).getByTestId("swap-return-funds"));
    });
    // the line the failure writes (whatever its words): an alert
    const line = await waitFor(() => within(card).getByText((_, el) => el?.tagName === "P" && el.classList.contains("ds-note-warn")));
    expect(line).toHaveAttribute("role", "alert");
    expect(line).toHaveAttribute("data-testid", "swap-progress-error");
    // Return funds' own words for a failure the catalog has no code for, never the runner's English (E11-10; the critique)
    expect(line.textContent).toBe(en["screen.swap.returnFailed"]);
  });

  it("a Return funds that fails beside the verdict is an alert, and so is the verdict", async () => {
    await paused({ code: "execution_unavailable", at: Date.now() });
    expect(await screen.findByTestId("operation-progress-error")).toHaveAttribute("role", "alert");
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-return-funds"));
    });
    const line = await waitFor(() =>
      within(screen.getByTestId("swap-view")).getByText((_, el) => el?.tagName === "P" && el.classList.contains("ds-note-warn")),
    );
    expect(line).toHaveAttribute("role", "alert");
  });
});
