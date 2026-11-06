// @vitest-environment happy-dom
// The eleventh review round's critique of E11-10 (2026-11-05): the band's staged Review — a confirmation that starts the protected steps —
// says a failure in the swap's own words before anything is committed, never a later step's ("The wallet tries again on its own…", "The
// transaction was secured…"), and under Advanced the thrown text after them. No test had made that confirmation fail.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { Protection } from "@privacy-wallet/sdk/swapService";
import { ApiError } from "@privacy-wallet/sdk/api/client";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { campaignsOf } from "@privacy-wallet/sdk/wallet/campaigns";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { en } from "../src/app/i18n/en";
import { prefs } from "../src/storage/prefs";
import { deployment, ETH_VAULT, fetchMock, resetWorld, world } from "./helpers/swapWorld";

// the steps' start: a failure of the caller's choosing
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
  session.forget();
  noteStore.clear();
  resetOperationsMemory();
  resetWorld();
  settings.reset();
  prefs().reset();
  staged.error = null;
});

const ETH = 10n ** 18n;
/** the service stages the band's route (a thin route): the steps run without asking (spec v3.0 §4) */
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

async function wallet() {
  const chosen = settings.get();
  await session.create("a strong password");
  session.acknowledgePhrase();
  settings.set(chosen);
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 40n * ETH, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
  await priceStore.refresh(deployment); // ETH at $2,500: 32 ETH is $80,000, the band
}
/** the page → the staged Review → its hold; the status line it shows */
async function confirmStaged(): Promise<string> {
  const router = createMemoryRouter([{ path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> }], {
    initialEntries: ["/swap"],
    future: ROUTER_FUTURE,
  });
  render(
    <Providers deployment={deployment}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
  fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
  await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
  fireEvent.click(screen.getByTestId("swap-review"));
  await screen.findByTestId("review-view");
  expect(screen.getByTestId("review-large-order").textContent, "the staged Review").toMatch(/Protected steps: \d+ pieces/);
  const hold = screen.getByTestId("hold-to-confirm") as HTMLButtonElement;
  await act(async () => {
    hold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
  });
  return (await screen.findByTestId("swap-status")).textContent ?? "";
}

describe("the staged Review's confirmation that fails (the critique of E11-10)", () => {
  it("a start no service answered: 'The swap was not confirmed', no campaign — under Advanced the thrown text after it", async () => {
    world.protection = stagedPlan;
    await wallet();
    for (const e of [new TypeError("Failed to fetch"), new ApiError(502, "provider_unavailable", "thorchain: upstream 502"), new ApiError(500, "internal", "internal error")]) {
      staged.error = e;
      expect(await confirmStaged()).toBe(en["screen.swap.notConfirmed"]);
      expect(campaignsOf(session.journal()), "nothing started").toHaveLength(0);
      cleanup();
    }
    settings.set({ advanced: true });
    staged.error = new TypeError("Failed to fetch");
    expect(await confirmStaged()).toBe(`${en["screen.swap.notConfirmed"]} (Failed to fetch)`);
  }, 90_000);
});
