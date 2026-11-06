// @vitest-environment happy-dom
// The eleventh review round, 2026-11-04, E11-1 and VE-1: a protected execution with a step not delivered as asked — refunded at its
// destination in the provider's own asset, delivered in another token, or failed with nothing back (the engine's `undelivered`,
// exposure().ended) — is said so at every terminal word. The Simple steps page names how much did not arrive and where it went, never
// "complete" nor "Returned to your protected balance."; its pause card never says "Your funds are safe" beside such a step; the running
// page counts it on a line of its own, never as Remaining; the runner's notification keeps its distinction in its own catalog key; the
// campaign's status word is a warning, never ✓; its Activity row reads the campaign.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createCampaign, exposure, withCampaignState, withTrancheState, type Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { putCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { activityId, recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { resetRunnerMemory, runCampaignTick, type CampaignIo } from "@privacy-wallet/sdk/wallet/campaignRunner";
import type { WalletNotification } from "@privacy-wallet/sdk/wallet/notifications";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale, t } from "../src/app/i18n/messages";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { shownWords } from "../src/app/notifications";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { CampaignProgress, campaignStatus } from "../src/features/swap/protected/CampaignProgress";
import { campaignProgressModel } from "../src/features/progress/model";
import { buildRows } from "../src/features/activity/rows";
import { rowView } from "../src/features/activity/model";
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
const ID = "0x" + "e1".repeat(32);

/** An $80,000 ETH → BTC protected execution at the band: four 8 ETH steps of $20,000, one at a time, running. */
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
const settled = (c: Campaign, i: number) =>
  withTrancheState(c, i, "settled", T0 + 3000 + i, { orderId: `0x0${i + 1}`, settledAt: T0 + 3000 + i, outcome: { delivered: eth(8).toString() } });
const undelivered = (c: Campaign, i: number, how: "refunded-at-destination" | "other-token" | "lost") =>
  withTrancheState(c, i, "undelivered", T0 + 2000 + i, { orderId: `0x0${i + 1}`, provider: "thorchain", outcome: { undelivered: how } });
const skipped = (c: Campaign, i: number) => withTrancheState(c, i, "skipped", T0 + 4000 + i);
/** the steps from `from` on skipped (Return the rest) */
const restSkipped = (c: Campaign, from: number) => [0, 1, 2, 3].filter((i) => i >= from).reduce(skipped, c);

async function wallet() {
  await session.create("a strong password");
  session.acknowledgePhrase();
}
function mount() {
  const router = createMemoryRouter(
    [
      { path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: [`/swap/steps/${ID}`], future: ROUTER_FUTURE },
  );
  render(
    <Providers deployment={deployment}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
}

describe("E11-1: the Simple steps page once a protected execution has ended", () => {
  it("completed with a step refunded at its destination: never 'complete' — how much did not arrive as asked and where it went, in Korean too", async () => {
    await wallet();
    const c = withCampaignState([1, 2, 3].reduce(settled, undelivered(band(), 0, "refunded-at-destination")), "completed", T0 + 9000, "every step finished");
    expect(exposure(c).ended, "the engine counts the step as not delivered as asked").toBe(eth(8));
    putCampaign(c, session);
    mount();
    const card = await screen.findByTestId("swap-steps-not-all");
    expect(screen.queryByTestId("swap-steps-done"), "never the success card").toBeNull();
    expect(card.textContent).not.toContain("is complete");
    expect(card.textContent).toContain("Your $80,000 ETH → BTC swap finished, but part of it did not arrive as you asked.");
    expect(screen.getByTestId("swap-steps-ended").textContent).toBe("$20,000.00 did not arrive as you asked and did not come back to your protected balance.");
    expect(card.textContent).toContain("The provider could not deliver a step and refunded it at the step's destination address, in its own refund asset.");
    // in Korean: the catalog's sentences, none of the English ones
    await loadCatalog("ko");
    act(() => setLocale("ko"));
    await waitFor(() =>
      expect(screen.getByTestId("swap-steps-not-all").textContent).toContain(t("screen.swap.stepsNotAll", { usd: "$80,000", pair: "ETH → BTC" }, "ko")),
    );
    expect(screen.getByTestId("swap-steps-ended").textContent).toBe(t("screen.swap.stepsEnded", { amount: "$20,000.00" }, "ko"));
    expect(screen.getByTestId("swap-steps-not-all").textContent).toContain(t("screen.swap.stepsWhere.refundedAtDestination", undefined, "ko"));
    expect(screen.getByTestId("swap-steps-not-all").textContent).not.toMatch(/did not arrive|refund asset|protected balance/);
  });

  it("returned after a step failed with nothing back: never 'Returned to your protected balance.'; one delivered and one in another token: part complete, part not as asked", async () => {
    await wallet();
    putCampaign(withCampaignState(restSkipped(undelivered(band(), 0, "lost"), 1), "cancelled", T0 + 9000, "every step finished or returned"), session);
    mount();
    const card = await screen.findByTestId("swap-steps-not-all");
    expect(card.textContent).not.toContain("Returned to your protected balance.");
    expect(card.textContent).toContain("Part of your ETH → BTC swap did not arrive as you asked. The rest is in your protected balance.");
    expect(card.textContent).toContain("The provider failed a step, and nothing has come back from it.");
    expect(screen.getByTestId("swap-steps-ended").textContent).toContain("$20,000.00");
    cleanup();
    putCampaign(withCampaignState(restSkipped(undelivered(settled(band(), 0), 1, "other-token"), 2), "cancelled", T0 + 9000), session);
    mount();
    const partly = await screen.findByTestId("swap-steps-not-all");
    expect(partly.textContent).toContain(
      "Part of your ETH → BTC swap is complete and part did not arrive as you asked. The rest is in your protected balance.",
    );
    expect(partly.textContent).toContain("A step was delivered at its destination address in another token than BTC.");
  });

  it("completed with a last remainder kept in the balance: complete, and the page says that the remainder stays", async () => {
    await wallet();
    const c = withTrancheState([0, 1, 2].reduce(settled, band()), 3, "skipped", T0 + 6000, { outcome: { kept: true } });
    expect(exposure(c)).toMatchObject({ kept: eth(8), ended: 0n });
    putCampaign(withCampaignState(c, "completed", T0 + 9000), session);
    mount();
    const done = await screen.findByTestId("swap-steps-done");
    expect(done.textContent).toContain("Your $80,000 ETH → BTC swap is complete.");
    expect(done.textContent).toContain("A remainder too small to swap on its own stays in your protected balance.");
  });
});

describe("E11-1 and VE-1: the Simple steps page while it runs", () => {
  it("paused on a step lost at its provider, as the runner leaves it (no step index): how much and where — never 'Your funds are safe' beside it", async () => {
    await wallet();
    const detail =
      "Step 1 failed at its provider, and nothing came back while it was watched (anything that arrives later is returned from the order's own page). Resume to carry on with the rest, or return the rest.";
    putCampaign(
      withCampaignState(undelivered(band(), 0, "lost"), "paused", T0 + 2500, detail, { pause: { reason: "provider-error", detail, at: T0 + 2500 } }),
      session,
    );
    mount();
    const card = await screen.findByTestId("swap-steps-paused");
    const block = screen.getByTestId("swap-steps-not-delivered");
    expect(block.textContent).toContain("$20,000.00 did not arrive as you asked and did not come back to your protected balance.");
    expect(block.textContent).toContain("The provider failed a step, and nothing has come back from it.");
    expect(screen.getByTestId("swap-steps-safe").textContent).toBe("What has not been handed over stays in your protected balance.");
    expect(card.textContent).not.toContain("Your funds are safe");
    // a pause with no such step still says the funds are safe
    cleanup();
    putCampaign(
      withCampaignState(band(), "paused", T0 + 2500, "paused", { pause: { reason: "price-deviation", detail: "The market moved.", at: T0 + 2500 } }),
      session,
    );
    mount();
    expect((await screen.findByTestId("swap-steps-safe")).textContent).toBe(
      "Your funds are safe: what has not been handed over stays in your protected balance.",
    );
    expect(screen.queryByTestId("swap-steps-not-delivered")).toBeNull();
  });

  it("running on after it, step 2 settled (VE-1): Remaining is what is still to swap — the step's value is a line of its own, and the lines add up", async () => {
    await wallet();
    const c = settled(undelivered(band(), 0, "lost"), 1);
    expect(exposure(c)).toMatchObject({ completed: eth(8), ended: eth(8), remaining: eth(16) });
    putCampaign(c, session);
    mount();
    const large = await screen.findByTestId("progress-large");
    expect(large.textContent).toContain("Completed$20,000.00");
    expect(large.textContent).toContain("Executing$0.00");
    expect(large.textContent).toContain("Remaining$40,000.00");
    expect(screen.getByTestId("progress-not-delivered").textContent).toBe("Not delivered as asked$20,000.00");
    const m = campaignProgressModel(c).large!;
    expect(m).toMatchObject({
      totalUsdCents: 8_000_000n,
      completedUsdCents: 2_000_000n,
      executingUsdCents: 0n,
      remainingUsdCents: 4_000_000n,
      notDeliveredUsdCents: 2_000_000n,
    });
    expect(m.completedUsdCents + m.executingUsdCents + m.remainingUsdCents + m.notDeliveredUsdCents!, "the lines add up to the total").toBe(m.totalUsdCents);
    expect(campaignProgressModel(settled(band(), 0)).large!.notDeliveredUsdCents, "nothing to say: no fourth line").toBe(0n);
  });
});

/** The runner's I/O for a campaign whose steps have all ended: nothing is asked of a provider, an executor or the chain. */
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
    throw new Error("a finished campaign's tick called freshDestination");
  },
};
/** One tick of the runner on `c`: the campaign completes, and the one notification it sends. */
async function finish(c: Campaign): Promise<WalletNotification> {
  putCampaign(c, session);
  const sent: WalletNotification[] = [];
  const notify = (n: Omit<WalletNotification, "id" | "at">) => {
    const full = { id: String(sent.length), at: Date.now(), ...n };
    sent.push(full);
    return full;
  };
  const r = await runCampaignTick(
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
  expect(r?.action.kind).toBe("complete");
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("E11-1: the runner names a finished protected execution's outcome, and the toast keeps it", () => {
  it("finished with a step not delivered as asked — completed or returned: its own key, a warning, and the catalog's words for it; a remainder kept and every step settled keep theirs", async () => {
    await wallet();
    // every other step settled after the user's Resume past a step lost at its provider
    const finished = await finish([1, 2, 3].reduce(settled, undelivered(band(), 0, "lost")));
    expect(finished).toMatchObject({ kind: "completed", title: "Protected swap finished", words: { key: "completed-not-all" }, tone: "warn" });
    expect(finished.body).toMatch(/part of the amount did not arrive as you asked/);
    expect(shownWords(finished)).toEqual({
      title: "Protected swap finished",
      body: "Every step finished, but part of the amount did not arrive as you asked.",
    });
    // returned (Return the rest) after a step refunded at its destination: the rest came back, the step did not
    const returned = await finish(withCampaignState(restSkipped(undelivered(band(), 0, "refunded-at-destination"), 1), "winding-down", T0 + 5000));
    expect(returned).toMatchObject({ kind: "cancelled", title: "Protected swap cancelled", words: { key: "cancelled-not-all" }, tone: "warn" });
    expect(returned.body).toBe("The rest returned to your private balance; part of the amount did not arrive as you asked (see the steps).");
    expect(shownWords(returned).body).toBe("The rest returned to your private balance, but part of the amount did not arrive as you asked.");
    // a last remainder too small to swap, kept in the balance; and every step settled
    const kept = await finish(withTrancheState([0, 1, 2].reduce(settled, band()), 3, "skipped", T0 + 6000, { outcome: { kept: true } }));
    expect(kept).toMatchObject({ kind: "completed", title: "Protected swap completed", words: { key: "completed-kept" } });
    expect(kept.tone).toBeUndefined();
    expect(shownWords(kept).body).toBe("Every step settled; a remainder too small to swap on its own stays in your private balance.");
    const plain = await finish([0, 1, 2, 3].reduce(settled, band()));
    expect(plain).toMatchObject({ kind: "completed", title: "Protected swap completed", words: { key: "completed" } });
    expect(shownWords(plain)).toEqual({ title: "Protected swap completed", body: "Every step settled." });
    // in Korean
    await loadCatalog("ko");
    setLocale("ko");
    expect(shownWords(finished)).toEqual({ title: "보호된 스왑이 끝났습니다", body: "모든 단계가 끝났지만, 금액 일부는 요청한 대로 도착하지 않았습니다." });
    expect(shownWords(returned).body).toBe("나머지는 비공개 잔액으로 돌아갔지만, 금액 일부는 요청한 대로 도착하지 않았습니다.");
    expect(shownWords(kept).body).toBe("모든 단계가 정산되었습니다. 따로 스왑하기에는 너무 적은 나머지 금액은 비공개 잔액에 남아 있습니다.");
  });
});

describe("E11-1: the campaign's status word and its Activity row", () => {
  it("a finished one with part of its amount not delivered as asked is a warning — never ✓ Completed nor ✓ Returned —, and the Advanced page's last sentence says so when returned", () => {
    expect(campaignStatus(withCampaignState([1, 2, 3].reduce(settled, undelivered(band(), 0, "refunded-at-destination")), "completed", T0 + 9000))).toEqual({
      mark: "⚠",
      word: "PartNotDelivered",
    });
    const returned = withCampaignState(restSkipped(undelivered(band(), 0, "lost"), 1), "cancelled", T0 + 9000);
    expect(campaignStatus(returned)).toEqual({ mark: "⚠", word: "PartNotDelivered" });
    render(<CampaignProgress campaign={returned} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("campaign-status").textContent).toBe("⚠ Part not delivered as asked");
    expect(screen.getByTestId("campaign-progress").textContent).toContain(
      "The rest returned to your private balance; part of the amount did not arrive as you asked (see Not delivered as asked).",
    );
    // without such a step: the words of before
    expect(campaignStatus(withCampaignState([0, 1, 2, 3].reduce(settled, band()), "completed", T0 + 9000))).toEqual({ mark: "✓", word: "Completed" });
    expect(campaignStatus(withCampaignState(restSkipped(band(), 0), "cancelled", T0 + 9000))).toEqual({ mark: "✓", word: "Returned" });
  });

  it("its Activity row reads the campaign once it has ended — delivered in part, refunded at the destination, another token, not completed — never Completed or Cancelled for them", async () => {
    await wallet();
    recordActivity(
      { id: activityId("campaign", ID), kind: "campaign", asset: "ETH", decimals: 18, amount: eth(32).toString(), status: "running", ref: ID, note: "→ BTC" },
      session,
    );
    const chip = (c: Campaign) => {
      putCampaign(c, session); // the line's status follows the campaign's state
      const row = buildRows(session.journal(), [], false, t).find((x) => x.kind === "campaign")!;
      expect(row.activity?.status).toBe(c.state);
      return rowView(row, t).status;
    };
    const done = [1, 2, 3].reduce(settled, undelivered(band(), 0, "refunded-at-destination"));
    expect(chip(withCampaignState(done, "completed", T0 + 9000)), "three steps delivered, one refunded at its destination").toBe("partial");
    expect(chip(withCampaignState(restSkipped(settled(band(), 0), 1), "cancelled", T0 + 9000)), "one step delivered, the rest returned").toBe("partial");
    expect(chip(withCampaignState(restSkipped(undelivered(band(), 0, "refunded-at-destination"), 1), "cancelled", T0 + 9000))).toBe("refunded-at-destination");
    expect(chip(withCampaignState(restSkipped(undelivered(band(), 0, "other-token"), 1), "cancelled", T0 + 9000))).toBe("other-token");
    expect(chip(withCampaignState(restSkipped(undelivered(band(), 0, "lost"), 1), "cancelled", T0 + 9000))).toBe("failed");
    // the words of before for the others
    expect(chip(withCampaignState([0, 1, 2, 3].reduce(settled, band()), "completed", T0 + 9000))).toBe("completed");
    expect(chip(withCampaignState(restSkipped(band(), 0), "cancelled", T0 + 9000))).toBe("cancelled");
    expect(chip(undelivered(band(), 0, "lost")), "still running: the line's own word").toBe("executing");
  });
});
