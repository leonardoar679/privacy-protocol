// @vitest-environment happy-dom
// The twelfth review round, 2026-11-09, W6 §5.4 (ZQ's critique): the Simple swap's line of where the scan stands follows the one order's
// refusal because the counters wait on the scan, and no later refusal — the status is one state, `setStatus(text)` clearing the mark. A
// refusal of the band's protected steps (their confirmation takes no counter: startCampaign) after the one order's had kept the line under it.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { Protection } from "@privacy-wallet/sdk/swapService";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { CountersHeld, noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { en } from "../src/app/i18n/en";
import { prefs } from "../src/storage/prefs";
import { deployment, ETH_VAULT, fetchMock, resetWorld, world } from "./helpers/swapWorld";

// the one order's commit refused with `commit.error`
const commit = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("@privacy-wallet/sdk/swapProvider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/swapProvider")>();
  return {
    ...orig,
    walletSwapProvider: () => ({
      prepare: async () => {
        throw commit.error;
      },
    }),
  };
});
// the protected steps' confirmation refused with `staged.error`
const staged = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("@privacy-wallet/sdk/wallet/campaigns", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/wallet/campaigns")>();
  return {
    ...orig,
    startCampaign: (...a: Parameters<typeof orig.startCampaign>) => {
      if (staged.error) throw staged.error;
      return orig.startCampaign(...a);
    },
  };
});

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  noteStore.releaseCounters(0);
  session.forget();
  noteStore.clear();
  resetOperationsMemory();
  resetWorld();
  settings.reset();
  prefs().reset();
  staged.error = null;
  commit.error = null;
});

const ETH = 10n ** 18n;
/** the band's staged plan: protected steps below $1M (review11-s4-staged-confirm's) */
const stagedPlan: Protection = {
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
  staged: true,
  reasons: ["staged below $1M: the only venue quotes with high impact or low reliability"],
  exposureTier: "R3",
};

describe("W6 §5.4 (ZQ's critique): the scan's line follows its own refusal only", () => {
  it("the one order refused while the counters wait on the scan shows the line; the band's protected steps refused next do not", async () => {
    const chosen = settings.get();
    await session.create("a strong password");
    session.acknowledgePhrase();
    settings.set(chosen);
    noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 40n * ETH, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    await priceStore.refresh(deployment);
    noteStore.holdCounters();
    const router = createMemoryRouter([{ path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> }], {
      initialEntries: ["/swap"],
      future: ROUTER_FUTURE,
    });
    render(
      <Providers deployment={deployment}>
        <RouterProvider router={router} future={PROVIDER_FUTURE} />
      </Providers>,
    );
    // the one order, refused because the counters wait on the scan
    commit.error = new CountersHeld();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
    fireEvent.click(screen.getByTestId("swap-review"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("review-confirm"));
    });
    expect((await screen.findByTestId("swap-status")).textContent).toBe(en["op.error.notes_loading.reason"]);
    expect(screen.getByTestId("swap-status-scan")).toBeTruthy();
    // back to the form, the band's amount: the staged Review, its confirmation refused otherwise
    fireEvent.click(screen.getByTestId("review-edit"));
    world.protection = stagedPlan;
    staged.error = new TypeError("Failed to fetch");
    fireEvent.input(await screen.findByTestId("amount-input"), { target: { value: "32" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
    fireEvent.click(screen.getByTestId("swap-review"));
    await screen.findByTestId("review-view");
    expect(screen.getByTestId("review-large-order").textContent, "the staged Review").toMatch(/Protected steps: \d+ pieces/);
    const hold = screen.getByTestId("hold-to-confirm") as HTMLButtonElement;
    await act(async () => {
      hold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    });
    expect((await screen.findByTestId("swap-status")).textContent).toBe(en["screen.swap.notConfirmed"]);
    expect(screen.queryByTestId("swap-status-scan"), "the protected steps' refusal is not the scan's").toBeNull();
  }, 90_000);
});
