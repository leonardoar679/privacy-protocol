// @vitest-environment happy-dom
// The eleventh review round's critique of E11-1 (2026-11-05): what a returned step did not bring back — its executor's tip, its provider's
// refund fee — is a cost of that step, never "did not arrive as you asked". The "not delivered as asked" words, the ⚠ status, the Activity
// chip, the warning tone and the running page's line follow exposure().notDelivered (the undelivered steps and a partial fill's rest that
// never came back); the fees are said as fees. "Return the rest" with a funded step returned less its tip had read "Part of your ETH → BTC
// swap did not arrive as you asked." in a warning card, and a completed execution whose one step was refunded and planned again "finished,
// but part of it did not arrive as you asked".
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createCampaign, replan, withCampaignState, withTrancheState, type Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { campaignById, putCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { withAlert } from "@privacy-wallet/sdk/wallet/alerts";
import { ApiError } from "@privacy-wallet/sdk/api/client";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { resetRunnerMemory, runCampaignTick, type CampaignIo } from "@privacy-wallet/sdk/wallet/campaignRunner";
import type { WalletNotification } from "@privacy-wallet/sdk/wallet/notifications";
import { setLocale, t } from "../src/app/i18n/messages";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { CampaignProgress, campaignStatus } from "../src/features/swap/protected/CampaignProgress";
import { ExposureDashboard } from "../src/features/swap/protected/ExposureDashboard";
import { ProgressView } from "../src/features/progress/View";
import { shownWords } from "../src/app/notifications";
import { activityStatus } from "../src/features/amounts";
import { campaignProgressModel } from "../src/features/progress/model";
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
  resetRunnerMemory();
  resetWorld();
  settings.reset();
  prefs().reset();
});

const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const eth = (n: number) => BigInt(n) * 10n ** 18n;
const T0 = Date.now() - 3_600_000;
const ID = "0x" + "e2".repeat(32);
/** a $80,000 (32 ETH) protected execution at the band, four 8 ETH steps, one at a time */
function band(): Campaign {
  const c = createCampaign({
    id: ID,
    now: T0,
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
      expiry: Math.floor(T0 / 1000) + 600_000,
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
  return withCampaignState({ ...c, provider: "thorchain", value: { usd: 80_000, at: T0 } } as Campaign, "running", T0 + 1000);
}
const TIP = 2n * 10n ** 15n; // 0.002 ETH: $5.00 at the confirmation's $2,500
/** step 1 funded, never handed over, returned by its refund-only job: the refund note is the escrow less the executor's tip */
const returnedLessTip = (c: Campaign) =>
  withTrancheState(c, 0, "refunded", T0 + 2000, { orderId: "0x01", outcome: { refunded: (eth(8) - TIP).toString() } }, "the escrow returned to the private balance");
const skipped = (c: Campaign, i: number) => withTrancheState(c, i, "skipped", T0 + 4000 + i);
const unexpected = (name: string) => async (): Promise<never> => {
  throw new Error(`a finished campaign's tick called ${name}`);
};
const io: CampaignIo = {
  commit: unexpected("commit"),
  fund: unexpected("fund"),
  escrowBalance: unexpected("escrowBalance"),
  sign: unexpected("sign"),
  handOver: unexpected("handOver"),
  job: unexpected("job"),
  track: unexpected("track"),
  refund: unexpected("refund"),
  quote: unexpected("quote"),
  shape: unexpected("shape"),
  risk: async () => null,
  gasPriceWei: async () => null,
  crossRateE18: () => null,
  notesShaped: () => true,
  freshDestination: () => {
    throw new Error("freshDestination");
  },
};
/** the tick that ends a campaign whose steps have all ended: the runner's notification */
async function finish(c: Campaign): Promise<WalletNotification> {
  putCampaign(c, session);
  const sent: WalletNotification[] = [];
  const notify = (n: Omit<WalletNotification, "id" | "at">) => {
    const full = { id: String(sent.length), at: Date.now(), ...n };
    sent.push(full);
    return full;
  };
  await runCampaignTick(
    { id: `campaign-tick:${c.id}`, kind: "campaign-tick", orderId: c.id, dueAt: Date.now() },
    {
      masterSeed: session.state().seed!,
      deployment,
      session,
      io,
      now: () => Date.now(),
      settings: () => settings.get(),
      notify: notify as never,
      rng: () => 0.5,
    },
  );
  return sent[0];
}
async function stepsPage(c: Campaign): Promise<HTMLElement> {
  putCampaign(c, session);
  const router = createMemoryRouter(
    [
      { path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> },
      { path: "/", element: <div /> },
    ],
    { initialEntries: [`/swap/steps/${ID}`], future: ROUTER_FUTURE },
  );
  render(
    <Providers deployment={deployment}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
  return screen.findByTestId("swap-view");
}
/** the Advanced campaign page (reached from the steps page's "Review the new route") */
function campaignPage(c: Campaign) {
  cleanup();
  render(
    <Providers deployment={deployment}>
      <CampaignProgress campaign={c} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />
    </Providers>,
  );
  const amounts = screen.getByTestId("campaign-amounts");
  return {
    notDelivered: amounts.querySelector('[data-amount="ended"]'),
    costs: amounts.querySelector('[data-amount="return-costs"]'),
    text: document.body.textContent ?? "",
  };
}
const sumLines = (c: Campaign) => {
  const l = campaignProgressModel(c).large!;
  return l.completedUsdCents + l.executingUsdCents + l.remainingUsdCents + (l.notDeliveredUsdCents ?? 0n) + (l.returnCostsUsdCents ?? 0n);
};

describe("a returned step's fees are its cost, never 'did not arrive as you asked' (the eleventh review round's critique of E11-1)", () => {
  it("Return the rest with a funded step returned less its tip: Returned, its fees said as fees — no warning, no ⚠, no warn tone", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    const n = await finish(withCampaignState([1, 2, 3].reduce(skipped, returnedLessTip(band())), "winding-down", T0 + 5000));
    expect(n.words?.key, "the runner's own key").toBe("cancelled");
    expect(n.tone, "no warning tone").toBeUndefined();
    expect(n.body).not.toContain("did not arrive");
    const c = withCampaignState([1, 2, 3].reduce(skipped, returnedLessTip(band())), "cancelled", T0 + 9000);
    expect(campaignStatus(c)).toEqual({ mark: "✓", word: "Returned" });
    expect(activityStatus("campaign", "cancelled", c)).toBe("cancelled");
    const m = campaignProgressModel(c).large!;
    expect(m.notDeliveredUsdCents, "nothing not delivered").toBe(0n);
    expect(m.returnCostsUsdCents, "the tip, $5.00").toBe(500n);
    expect(sumLines(c), "the lines add up to the total").toBe(m.totalUsdCents);
    const page = await stepsPage(c);
    expect(screen.queryByTestId("swap-steps-not-all")).toBeNull();
    expect(screen.getByTestId("swap-steps-done").textContent).toContain(t("screen.swap.returned"));
    expect(screen.getByTestId("swap-steps-return-costs").textContent).toBe("Fees of steps that came back: $5.00.");
    expect(page.textContent).not.toContain("did not arrive as you asked");
    // the Advanced campaign page alike (the second critique: its rows and sentence had been left unpinned)
    const adv = campaignPage(c);
    expect(adv.notDelivered, "no 'Not delivered as asked' row").toBeNull();
    expect(adv.costs?.textContent).toContain("0.002");
    expect(adv.text).toContain(t("campaign.restReturned"));
    expect(adv.text).not.toContain("did not arrive");
  });

  it("a step the provider refunded less its fee, planned again, every step then delivered: complete, its fees said — never 'finished, but part of it did not arrive'", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    let c = returnedLessTip(band());
    c = replan(c, [eth(8), eth(8), eth(8), eth(8) - TIP], T0 + 2500);
    for (const i of [1, 2, 3, 4]) {
      const amt = c.tranches.find((x) => x.index === i)!.amount;
      c = withTrancheState(c, i, "settled", T0 + 3000 + i, { orderId: `0x1${i}`, settledAt: T0 + 3000 + i, outcome: { delivered: amt } });
    }
    // while it runs: the running page's own line for the fees, the lines adding up (the second critique: VE-1's sum, unpinned on screen)
    render(<ProgressView model={campaignProgressModel(withCampaignState(c, "running", T0 + 4500))} />);
    expect(screen.getByTestId("progress-return-costs").textContent).toContain("$5.00");
    expect(screen.queryByTestId("progress-not-delivered")).toBeNull();
    cleanup();
    const n = await finish(withCampaignState(c, "running", T0 + 5000));
    expect(n.words?.key).toBe("completed");
    expect(n.tone).toBeUndefined();
    expect(n.body, "the runner's own words: every step settled").toBe("Every step settled.");
    const done = withCampaignState(c, "completed", T0 + 9000);
    expect(campaignStatus(done)).toEqual({ mark: "✓", word: "Completed" });
    expect(activityStatus("campaign", "completed", done)).not.toBe("partial");
    expect(sumLines(done)).toBe(campaignProgressModel(done).large!.totalUsdCents);
    await stepsPage(done);
    expect(screen.queryByTestId("swap-steps-not-all")).toBeNull();
    expect(screen.getByTestId("swap-steps-done").textContent).toContain(t("screen.swap.stepsDone", { usd: "$80,000", pair: "ETH → BTC" }));
    expect(screen.getByTestId("swap-steps-return-costs").textContent).toBe("Fees of steps that came back: $5.00.");
    const adv = campaignPage(done);
    expect(adv.notDelivered).toBeNull();
    expect(adv.costs?.textContent).toContain("0.002");
    expect(adv.text).toContain(t("campaign.everySettled"));
  });

  it("a cancel that returned nothing — every step already handed over and settled — reads complete everywhere, never 'Delivered in part' or '✓ Returned' (the third critique)", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    let c = band();
    for (const i of [0, 1, 2, 3]) c = withTrancheState(c, i, "settled", T0 + 3000 + i, { orderId: `0x2${i}`, settledAt: T0 + 3000 + i, outcome: { delivered: eth(8).toString() } });
    // the runner ends such a cancel as completed
    const n = await finish(withCampaignState(c, "winding-down", T0 + 5000));
    expect(n.words?.key).toBe("completed");
    // and one stored as cancelled before this rule reads complete too
    const cancelled = withCampaignState(c, "cancelled", T0 + 9000);
    expect(activityStatus("campaign", "cancelled", cancelled)).toBe("completed");
    expect(campaignStatus(cancelled)).toEqual({ mark: "✓", word: "Completed" });
    await stepsPage(cancelled);
    expect(screen.getByTestId("swap-steps-done").textContent).toContain(t("screen.swap.stepsDone", { usd: "$80,000", pair: "ETH → BTC" }));
    expect(campaignPage(cancelled).text).toContain(t("campaign.everySettled"));
  });

  it("a pause the runner knows the cause of reads by that cause — a step the relayer cannot fund: never 'the provider reported an error', nor 'Provider degraded' among its alerts (the third and fourth critiques)", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    let c = withTrancheState(band(), 0, "committed", T0 + 2000, { orderId: "0x01", provider: "thorchain" });
    const detail = "Step 1 cannot be funded: the relayer runs no swap executor";
    // as the runner's pauseWith leaves it: the pause and its alert, both with the code
    c = withCampaignState(c, "paused", T0 + 3500, detail, {
      pause: { reason: "provider-error", detail, at: T0 + 3500, trancheIndex: 0, code: "step_relayer_not_ready" },
    } as never);
    c = withAlert(c, "provider-degraded", detail, T0 + 3500, 0, "step_relayer_not_ready");
    const adv = campaignPage(c);
    expect(adv.text).toContain(t("campaign.pausedTitle", { title: t("op.error.step_relayer_not_ready.title") }));
    expect(screen.getByTestId("campaign-pause-reason").textContent).toContain(t("op.error.step_relayer_not_ready.reason"));
    expect(screen.getByTestId("campaign-alerts").textContent).toContain(t("op.error.step_relayer_not_ready.title"));
    expect(adv.text).not.toContain(t("op.error.provider_error.reason"));
    expect(adv.text, "the alert by its code, never the coarse reason's kind").not.toContain(t("campaign.alert.provider-degraded"));
    cleanup();
    // the Advanced dashboard's pause history reads the alert the same way
    render(
      <Providers deployment={deployment}>
        <ExposureDashboard campaign={c} now={T0 + 4000} />
      </Providers>,
    );
    expect(document.body.textContent).toContain(t("op.error.step_relayer_not_ready.title"));
    expect(document.body.textContent).not.toContain(t("campaign.alert.provider-degraded"));
    cleanup();
    await stepsPage(c);
    expect(screen.getByTestId("swap-steps-paused").textContent).toContain(t("op.error.step_relayer_not_ready.reason"));
    expect(
      shownWords({ id: "x", at: 0, kind: "provider-degraded", title: "Protected swap paused", body: detail, words: { key: "paused", vars: { code: "step_relayer_not_ready" } } }).body,
    ).toBe(t("op.error.step_relayer_not_ready.reason"));
  });

  it("a step whose commit failed, whatever the service answered, pauses as commit_failed through the runner: nothing was sent and the funds are safe — never 'tries again on its own' or 'checking where your funds are', in English and Korean (the fourth critique)", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    await loadCatalog("ko");
    for (const thrown of [new ApiError(502, "provider_unavailable", "thorchain: upstream 502"), new ApiError(500, "internal", "internal error"), new ApiError(400, "no_quote", "no quote for this pair")]) {
      putCampaign(band(), session);
      const sent: WalletNotification[] = [];
      const notify = (n: Omit<WalletNotification, "id" | "at">) => {
        const full = { id: String(sent.length), at: Date.now(), ...n };
        sent.push(full);
        return full;
      };
      await runCampaignTick(
        { id: `campaign-tick:${ID}`, kind: "campaign-tick", orderId: ID, dueAt: Date.now() },
        {
          masterSeed: session.state().seed!,
          deployment,
          session,
          io: {
            ...io,
            commit: async () => {
              throw thrown;
            },
            freshDestination: () => ({ address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", index: 0 }),
          },
          now: () => Date.now(),
          settings: () => settings.get(),
          notify: notify as never,
          rng: () => 0.5,
        },
      );
      const c = campaignById(ID, session)!;
      expect(c.pause, thrown.code).toMatchObject({ code: "commit_failed", trancheIndex: 0 });
      await stepsPage(c);
      expect(screen.getByTestId("swap-steps-reason").textContent).toBe(t("op.error.commit_failed.reason"));
      expect(screen.getByTestId("swap-steps-safe").textContent).toBe(t("screen.swap.stepsSafe"));
      expect(document.body.textContent).not.toMatch(/tries again on its own|where your funds are|try a larger amount|confirm again/);
      const paused = sent.find((n) => n.words?.key === "paused")!;
      expect(shownWords(paused).body).toBe(t("op.error.commit_failed.reason"));
      act(() => setLocale("ko"));
      expect(shownWords(paused).body).toBe(t("op.error.commit_failed.reason", undefined, "ko"));
      act(() => setLocale("en"));
      cleanup();
    }
  });

  it("every reason a paused execution shows says that Resume carries it on — a pause never goes on by itself, in English and Korean (the fifth critique)", async () => {
    await loadCatalog("ko");
    for (const code of ["chain_congestion", "route_degraded", "price_deviation", "unexpected_destination", "provider_error", "commit_failed", "step_relayer_not_ready"]) {
      expect(t(`op.error.${code}.reason` as never), code).toMatch(/\bResume\b|\bresume\b/);
      expect(t(`op.error.${code}.reason` as never, undefined, "ko"), code).toContain("재개");
      expect(t(`op.error.${code}.reason` as never), code).not.toMatch(/calmer conditions|waits for a reassessment|until the wallet reconciles|while the wallet reassesses/);
    }
    // a step the relayer cannot fund names every cause, never "runs no swaps" alone
    expect(t("op.error.step_relayer_not_ready.reason")).toContain("does not run this swap service's orders, or this wallet sends its own transactions");
  });

  it("a cancel after a step came back less its tip and was planned again, the last step settling: everything swapped, read complete — the tip a cost, never 'Returned' (the fourth critique)", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    let c = returnedLessTip(band());
    c = replan(c, [eth(8), eth(8), eth(8), eth(8) - TIP], T0 + 2500);
    for (const i of [1, 2, 3, 4]) {
      const amt = c.tranches.find((x) => x.index === i)!.amount;
      c = withTrancheState(c, i, "settled", T0 + 3000 + i, { orderId: `0x3${i}`, settledAt: T0 + 3000 + i, outcome: { delivered: amt } });
    }
    // "Return the rest" was tapped while the last step was on its way: nothing was left to return
    const n = await finish(withCampaignState(c, "winding-down", T0 + 5000));
    expect(n.words?.key).toBe("completed");
    const cancelled = withCampaignState(c, "cancelled", T0 + 9000);
    expect(activityStatus("campaign", "cancelled", cancelled)).toBe("completed");
    expect(campaignStatus(cancelled)).toEqual({ mark: "✓", word: "Completed" });
    await stepsPage(cancelled);
    expect(screen.getByTestId("swap-steps-done").textContent).toContain(t("screen.swap.stepsDone", { usd: "$80,000", pair: "ETH → BTC" }));
    expect(campaignPage(cancelled).text).toContain(t("campaign.everySettled"));
  });

  it("the pause card beside a step lost at its provider and a later step held (failed, its funds coming back): never 'Your funds are safe', the not-delivered block shown", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    let c = withTrancheState(band(), 0, "undelivered", T0 + 2000, { orderId: "0x01", provider: "thorchain", outcome: { undelivered: "lost" } });
    c = withTrancheState(c, 1, "failed", T0 + 3000, { orderId: "0x02", provider: "thorchain" });
    c = withCampaignState(c, "paused", T0 + 3500, "paused", { pause: { reason: "provider-error", detail: "step 2 failed", at: T0 + 3500 } } as never);
    await stepsPage(c);
    expect(screen.getByTestId("swap-steps-safe").textContent).toBe(t("screen.swap.stepsRestHeld"));
    expect(screen.getByTestId("swap-steps-paused").textContent).not.toContain("Your funds are safe");
    expect(screen.getByTestId("swap-steps-not-delivered").textContent).toContain(t("screen.swap.stepsWhere.lost"));
  });

  it("a partial fill whose rest never came back is not delivered as asked: the warning, its amount and where it went — the fees of a returned step beside it, apart", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    let c = returnedLessTip(band());
    c = replan(c, [eth(8), eth(8), eth(8), eth(8) - TIP], T0 + 2500);
    // step 2 delivered 4 of its 8 ETH and the executor's watch ended with nothing back
    c = withTrancheState(c, 1, "settled", T0 + 3001, { orderId: "0x11", settledAt: T0 + 3001, amount: eth(4).toString(), funded: eth(8).toString(), outcome: { refunded: "0" } });
    for (const i of [2, 3, 4]) {
      const amt = c.tranches.find((x) => x.index === i)!.amount;
      c = withTrancheState(c, i, "settled", T0 + 3000 + i, { orderId: `0x1${i}`, settledAt: T0 + 3000 + i, outcome: { delivered: amt } });
    }
    const done = withCampaignState(c, "completed", T0 + 9000);
    expect(campaignStatus(done)).toEqual({ mark: "⚠", word: "PartNotDelivered" });
    expect(activityStatus("campaign", "completed", done)).toBe("partial");
    const m = campaignProgressModel(done).large!;
    expect(m.notDeliveredUsdCents, "the 4 ETH that never came back: $10,000").toBe(1_000_000n);
    expect(m.returnCostsUsdCents).toBe(500n);
    expect(sumLines(done)).toBe(m.totalUsdCents);
    await stepsPage(done);
    const card = screen.getByTestId("swap-steps-not-all");
    expect(card, "a result read out as a status (the critique of E11-6)").toHaveAttribute("role", "status");
    expect(screen.getByTestId("swap-steps-ended").textContent).toBe(t("screen.swap.stepsEnded", { amount: "$10,000.00" }));
    expect(card.textContent).toContain(t("screen.swap.stepsWhere.partialUnreturned"));
    expect(screen.getByTestId("swap-steps-return-costs").textContent).toBe("Fees of steps that came back: $5.00.");
    const adv = campaignPage(done);
    // the row's own figure: 4 ETH, never the 4.002 that counts the returned step's tip (the third critique: toContain("4") passed both)
    expect(adv.notDelivered?.textContent, "the 4 ETH not delivered as asked").toMatch(/^4 ETH\b/);
    expect(adv.costs?.textContent).toContain("0.002");
    expect(adv.text).toContain(t("campaign.finishedNotAll"));
  });
});
