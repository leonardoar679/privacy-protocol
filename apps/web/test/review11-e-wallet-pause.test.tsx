// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), E11-2: a protected execution paused by the user's own "Pause large operations" switch (the
// engine's one source of a `wallet-pause`, packages/protocol/src/wallet/campaign.ts detectPause, fed by the setting in campaignRunner.ts)
// read "Paused: the wallet was locked — The protected execution waits for the wallet to be unlocked." on the Simple steps page of an
// unlocked wallet, and its Resume moved the campaign to reassessing only for the next tick's detectPause to meet the same switch and pause
// it again. The page now names the setting in English and Korean, offers the switch itself while it is on, and Resume once it is off — a
// Resume the next tick no longer pauses.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createCampaign, detectPause, withCampaignState, type Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { campaignById, putCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale, t } from "../src/app/i18n/messages";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { prefs } from "../src/storage/prefs";
import { deployment, fetchMock, resetWorld } from "./helpers/swapWorld";

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  setLocale("en");
  session.forget();
  noteStore.clear();
  resetOperationsMemory();
  resetWorld();
  settings.reset();
  prefs().reset();
});

const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const eth = (n: number) => BigInt(n) * 10n ** 18n;
const ID = "0x" + "d7".repeat(32);

/** An $80,000 ETH → BTC protected execution (the band's four steps), running — as the runner leaves it before a pause. */
function running(t0: number): Campaign {
  const c = createCampaign({
    id: ID,
    now: t0,
    mode: "balanced",
    tier: "large-protected",
    request: { from: ETH, to: BTC, amount: eth(32).toString(), preference: "balanced" },
    bounds: {
      orderId: ID,
      assetIn: ETH,
      chainIn: "ethereum",
      amountInLimit: eth(32).toString(),
      assetOut: BTC,
      chainOut: "bitcoin",
      destination: { kind: "fresh-per-tranche" },
      minimumOutput: "2985000000000000",
      expiry: Math.floor(t0 / 1000) + 600_000,
      maxFeeBps: 100,
      privacyMode: "balanced",
      maxExternalExposure: eth(8).toString(),
      executeWindowSeconds: 1800,
    },
    plan: {
      riskClass: "R3",
      bandBps: [1250, 2500],
      capBps: 2500,
      sizing: "varied",
      concurrency: "sequential",
      maxParallel: 1,
      gate: "destination-final",
      cadenceSeconds: [60, 300],
      providerShareCapBps: 10000,
      executeWindowSeconds: 1800,
      estimatedTranches: 4,
      estimatedSeconds: 3600,
      shapeNotes: false,
      elpfUsd: 400,
    },
    pieces: [eth(8), eth(8), eth(8), eth(8)],
    referenceRateE18: 3_000_000_000_000_000n,
  } as never);
  return withCampaignState({ ...c, provider: "thorchain", value: { usd: 80_000, at: t0 } } as Campaign, "running", t0 + 1000);
}
/** The runner's facts for the next tick, the switch as the settings hold it now (campaignRunner.ts: walletPaused from the setting). */
const facts = () => ({ now: Date.now(), walletPaused: settings.get().protection.pauseLargeOperations }) as Parameters<typeof detectPause>[1];

async function pausedBySwitch(on: boolean) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  settings.set({ protection: { ...settings.get().protection, pauseLargeOperations: true } });
  const t0 = Date.now() - 600_000;
  const pause = detectPause(running(t0), facts());
  expect(pause?.reason, "the engine's pause is the switch").toBe("wallet-pause");
  putCampaign(withCampaignState(running(t0), "paused", Date.now(), "paused", { pause: { ...pause!, at: Date.now() } } as never), session);
  // turned off elsewhere (Settings, the Activity detail) after the pause: the campaign stays paused until resumed
  if (!on) settings.set({ protection: { ...settings.get().protection, pauseLargeOperations: false } });
  const router = createMemoryRouter([{ path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> }], {
    initialEntries: [`/swap/steps/${ID}`],
    future: ROUTER_FUTURE,
  });
  render(
    <Providers deployment={deployment}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
  return screen.findByTestId("swap-steps-paused");
}

describe("E11-2: a pause by the user's own switch", () => {
  it("names the setting, offers the switch while it is on, and Resume once it is off — a Resume the next tick no longer pauses", async () => {
    const card = await pausedBySwitch(true);
    expect(card.querySelector("h2")?.textContent).toBe("Paused by your setting");
    expect(screen.getByTestId("swap-steps-reason").textContent).toBe(t("op.error.wallet_pause.reason"));
    expect(card.textContent).toContain("Pause large operations");
    expect(card.textContent, "the wallet is unlocked: no lock is named").not.toMatch(/locked|unlock/i);
    const toggle = screen.getByTestId("swap-steps-pause-switch") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.queryByTestId("swap-steps-resume"), "a Resume would pause again at the next tick").toBeNull();
    expect(screen.getByTestId("swap-steps-return"), "Return the rest stays offered").toBeInTheDocument();
    // the switch itself: off in the settings, and Resume appears
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(settings.get().protection.pauseLargeOperations).toBe(false);
    expect((screen.getByTestId("swap-steps-pause-switch") as HTMLInputElement).checked).toBe(false);
    const resume = await screen.findByTestId("swap-steps-resume");
    await act(async () => {
      fireEvent.click(resume);
    });
    const c = campaignById(ID, session)!;
    expect(c.state).toBe("reassessing");
    expect(detectPause(c, facts()), "the next tick meets no switch").toBeNull();
    await waitFor(() => expect(screen.queryByTestId("swap-steps-paused")).toBeNull());
  });

  it("switched off elsewhere after the pause: the switch reads off and Resume is offered", async () => {
    await pausedBySwitch(false);
    expect((screen.getByTestId("swap-steps-pause-switch") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("swap-steps-resume")).toBeInTheDocument();
  });

  it("in Korean: the setting's own name, no lock", async () => {
    await loadCatalog("ko");
    const card = await pausedBySwitch(true);
    act(() => setLocale("ko"));
    await waitFor(() => expect(card.querySelector("h2")?.textContent).toBe(t("op.error.wallet_pause.title", undefined, "ko")));
    expect(t("op.error.wallet_pause.title", undefined, "ko")).toBe("설정에 따라 일시 중지됨");
    const reason = screen.getByTestId("swap-steps-reason").textContent ?? "";
    expect(reason).toBe(t("op.error.wallet_pause.reason", undefined, "ko"));
    expect(reason).toContain(t("home.pauseLarge", undefined, "ko"));
    expect(card.textContent, "no lock is named").not.toMatch(/잠김|잠금 해제|잠겨/);
    expect(card.textContent).toContain(t("home.pauseLarge", undefined, "ko"));
  });
});
