// @vitest-environment happy-dom
// The twelfth review round, 2026-11-06, C12-4 and C12-7: a protected execution's step that came back to the protected balance in another
// token than the one it swapped (a swap-first route refunded in its intermediate token) is said so — never "did not come back", never
// "complete", never ✓ —: the Simple steps page names how much came back that way apart from what did not come back at all, the running
// page counts it as part of the "Not delivered as asked" line (never on top of it), the Advanced page and its pause card name the way, and
// the Activity row reads "another token". A step refunded at its destination with part of it back in the protected balance books only what
// did not come back, and its pause card says that the rest came back.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createCampaign, exposure, nextAction, notAsAsked, withCampaignState, withTrancheState, REPLAN_PAUSE, type Campaign, type Tranche } from "@privacy-wallet/protocol/wallet/campaign";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { campaignById, putCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { activityId, recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { resetRunnerMemory, runCampaignTick, type CampaignIo } from "@privacy-wallet/sdk/wallet/campaignRunner";
import type { WalletNotification } from "@privacy-wallet/sdk/wallet/notifications";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { shownWords } from "../src/app/notifications";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale, t } from "../src/app/i18n/messages";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { CampaignProgress, campaignStatus } from "../src/features/swap/protected/CampaignProgress";
import { notDeliveredWords } from "../src/features/swap/protected/words";
import { campaignProgressModel } from "../src/features/progress/model";
import { ProgressView } from "../src/features/progress/View";
import { activityStatus } from "../src/features/amounts";
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
const ID = "0x" + "c4".repeat(32);
const USDC_VAULT = "0x" + "5c".repeat(20);

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
  return withCampaignState({ ...c, provider: "lifi", value: { usd: 80_000, at: T0 } } as Campaign, "running", T0 + 1000);
}
const settled = (c: Campaign, i: number) =>
  withTrancheState(c, i, "settled", T0 + 3000 + i, { orderId: `0x0${i + 1}`, settledAt: T0 + 3000 + i, outcome: { delivered: eth(8).toString() } });
/** step `i` came back to the protected balance in USDC, nothing of it in ETH (the runner's C12-4 rule) */
const backInUsdc = (c: Campaign, i: number) =>
  withTrancheState(c, i, "undelivered", T0 + 2000 + i, {
    orderId: `0x0${i + 1}`,
    provider: "lifi",
    outcome: { undelivered: "refunded-other-token", returnedOther: [{ vault: USDC_VAULT, amount: "19800000000" }] },
  });
const undelivered = (c: Campaign, i: number, how: "refunded-at-destination" | "other-token" | "lost", outcome: Tranche["outcome"] = {}) =>
  withTrancheState(c, i, "undelivered", T0 + 2000 + i, { orderId: `0x0${i + 1}`, provider: "lifi", outcome: { ...outcome, undelivered: how } });
const skipped = (c: Campaign, i: number) => withTrancheState(c, i, "skipped", T0 + 4000 + i);
/** the steps from `from` on skipped (Return the rest) */
const restSkipped = (c: Campaign, from: number) => [0, 1, 2, 3].filter((i) => i >= from).reduce(skipped, c);

async function wallet() {
  await session.create("a strong password");
  session.acknowledgePhrase();
}
function mount(d: Deployment = deployment) {
  const router = createMemoryRouter(
    [
      { path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={d} /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: [`/swap/steps/${ID}`], future: ROUTER_FUTURE },
  );
  render(
    <Providers deployment={d}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
}
/** a step delivered in part (4 of its 8 ETH) whose rest came back in USDC, settled for what it delivered (the runner's pass-2 rule) */
const settledBackInUsdc = (c: Campaign, i: number) =>
  withTrancheState(c, i, "settled", T0 + 3000 + i, {
    orderId: `0x0${i + 1}`,
    amount: eth(4).toString(),
    funded: eth(8).toString(),
    settledAt: T0 + 3000 + i,
    outcome: { delivered: eth(4).toString(), refunded: "0", returnedOther: [{ vault: USDC_VAULT, amount: "9900000000" }] },
  } as never);
/** The runner's I/O for a campaign whose steps have all ended: nothing is asked of anyone. */
const unexpected = (name: string) => async (): Promise<never> => {
  throw new Error(`a finished campaign's tick called ${name}`);
};
const finishedIo: CampaignIo = {
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
/** One tick of the runner on `c`: the campaign ends, and the one notification it sends. */
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
    { masterSeed: session.state().seed!, deployment, session, io: finishedIo, now: () => Date.now(), settings: () => settings.get(), notify: notify as never, rng: () => 0.5 },
  );
  expect(r?.action.kind).toBe("complete");
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("C12-4: the engine's books for a step that came back in another token", () => {
  it("not delivered as asked, and never counted as gone: exposure().returnedOther, not notDelivered; a destination refund with its rest back books only what did not come back (C12-7)", () => {
    const e = exposure([1, 2, 3].reduce(settled, backInUsdc(band(), 0)));
    expect(e).toMatchObject({ completed: eth(24), ended: eth(8), notDelivered: 0n, returnedOther: eth(8), remaining: 0n });
    expect(notAsAsked(e)).toBe(eth(8));
    const part = exposure(undelivered(band(), 0, "refunded-at-destination", { refunded: eth(3).toString() }));
    expect(part).toMatchObject({ ended: eth(5), notDelivered: eth(5), returnedOther: 0n });
    // never more back than the step's own amount
    expect(exposure(undelivered(band(), 0, "refunded-at-destination", { refunded: eth(9).toString() }))).toMatchObject({ ended: 0n, notDelivered: 0n });
  });
});

describe("C12-4: the Simple steps page once a step came back in another token", () => {
  it("completed with a step back in USDC: never complete, never 'did not come back' — how much came back in another token and what happens to it, in Korean too", async () => {
    await wallet();
    putCampaign(withCampaignState([1, 2, 3].reduce(settled, backInUsdc(band(), 0)), "completed", T0 + 9000, "every step finished"), session);
    mount();
    const card = await screen.findByTestId("swap-steps-not-all");
    expect(screen.queryByTestId("swap-steps-done"), "never the success card").toBeNull();
    expect(card.textContent).toContain("Your $80,000 ETH → BTC swap finished, but part of it did not arrive as you asked.");
    expect(screen.queryByTestId("swap-steps-ended"), "nothing is said gone").toBeNull();
    expect(card.textContent).not.toContain("did not come back");
    expect(screen.getByTestId("swap-steps-returned-other").textContent).toBe("$20,000.00 of the swap came back to your protected balance in another token than ETH.");
    expect(card.textContent).toContain(
      "A step's provider returned it in another token than ETH. That token stays in your protected balance and is not swapped again on its own.",
    );
    await loadCatalog("ko");
    act(() => setLocale("ko"));
    await waitFor(() =>
      expect(screen.getByTestId("swap-steps-returned-other").textContent).toBe(t("screen.swap.stepsReturnedOtherUnknown", { amount: "$20,000.00", from: "ETH" }, "ko")),
    );
    expect(screen.getByTestId("swap-steps-not-all").textContent).toContain(t("screen.swap.stepsWhere.refundedOtherToken", { from: "ETH" }, "ko"));
    expect(screen.getByTestId("swap-steps-not-all").textContent).not.toMatch(/another token|protected balance|came back/);
  });

  it("returned after one step failed with nothing back and one came back in USDC: the two sentences split the line and add up to it, each way named once", async () => {
    await wallet();
    const c = withCampaignState(restSkipped(backInUsdc(undelivered(band(), 0, "lost"), 1), 2), "cancelled", T0 + 9000);
    const m = campaignProgressModel(c).large!;
    expect(m.notDeliveredUsdCents, "the line: both steps").toBe(4_000_000n);
    expect(m.returnedOtherUsdCents, "of which, in another token").toBe(2_000_000n);
    putCampaign(c, session);
    mount();
    const card = await screen.findByTestId("swap-steps-not-all");
    expect(card.textContent).toContain("Part of your ETH → BTC swap did not arrive as you asked. The rest is in your protected balance.");
    expect(screen.getByTestId("swap-steps-ended").textContent).toBe("$20,000.00 did not arrive as you asked and did not come back to your protected balance.");
    expect(screen.getByTestId("swap-steps-returned-other").textContent).toBe("$20,000.00 of the swap came back to your protected balance in another token than ETH.");
    expect(card.textContent).toContain("The provider failed a step, and nothing has come back from it.");
    expect(card.textContent).toContain("A step's provider returned it in another token than ETH.");
    expect(notDeliveredWords(t, c), "one sentence per way, in the order of the steps").toEqual([
      "The provider failed a step, and nothing has come back from it.",
      "A step's provider returned it in another token than ETH. That token stays in your protected balance and is not swapped again on its own.",
    ]);
  });

  it("a step delivered in part whose rest came back in USDC, how much of each untold: said so — never 'came back' nor 'did not come back' for its whole value", async () => {
    await wallet();
    const partly = (c: Campaign, i: number) =>
      withTrancheState(c, i, "undelivered", T0 + 2000 + i, {
        orderId: `0x0${i + 1}`,
        provider: "lifi",
        outcome: { undelivered: "refunded-other-token", deliveredInPart: true, returnedOther: [{ vault: USDC_VAULT, amount: "9000000000" }] },
      });
    const c = withCampaignState([1, 2, 3].reduce(settled, partly(band(), 0)), "completed", T0 + 9000);
    expect(exposure(c)).toMatchObject({ partlyBack: eth(8), returnedOther: 0n, notDelivered: 0n });
    expect(campaignProgressModel(c).large).toMatchObject({ notDeliveredUsdCents: 2_000_000n, returnedOtherUsdCents: 0n, partlyBackUsdCents: 2_000_000n });
    putCampaign(c, session);
    mount();
    const card = await screen.findByTestId("swap-steps-not-all");
    expect(screen.queryByTestId("swap-steps-ended")).toBeNull();
    expect(screen.queryByTestId("swap-steps-returned-other")).toBeNull();
    expect(screen.getByTestId("swap-steps-partly-back").textContent).toBe(
      "$20,000.00 of the swap was delivered only in part; the rest came back to your protected balance in another token than ETH.",
    );
    expect(card.textContent).toContain("A step's provider delivered part of it and returned the rest in another token than ETH, without saying how much of each.");
    await loadCatalog("ko");
    act(() => setLocale("ko"));
    await waitFor(() =>
      expect(screen.getByTestId("swap-steps-partly-back").textContent).toBe(t("screen.swap.stepsPartlyBackUnknown", { amount: "$20,000.00", from: "ETH" }, "ko")),
    );
    expect(screen.getByTestId("swap-steps-not-all").textContent).toContain(t("screen.swap.stepsWhere.partialOtherToken", { from: "ETH" }, "ko"));
    act(() => setLocale("en"));
    cleanup();
    // beside a step lost at its provider: each sentence its own part of the line
    putCampaign(withCampaignState(restSkipped(partly(undelivered(band(), 0, "lost"), 1), 2), "cancelled", T0 + 9000), session);
    mount();
    await screen.findByTestId("swap-steps-not-all");
    expect(screen.getByTestId("swap-steps-ended").textContent).toBe("$20,000.00 did not arrive as you asked and did not come back to your protected balance.");
    expect(screen.getByTestId("swap-steps-partly-back").textContent).toContain("$20,000.00 of the swap was delivered only in part");
    cleanup();
    // the running page: in the "Not delivered as asked" line, with no "came back" line of its own
    render(<ProgressView model={campaignProgressModel(settled(partly(band(), 0), 1))} />);
    expect(screen.getByTestId("progress-not-delivered").textContent).toBe("Not delivered as asked$20,000.00");
    expect(screen.queryByTestId("progress-returned-other")).toBeNull();
    cleanup();
    // the Advanced pause card names it
    const paused = withCampaignState(partly(band(), 0), "paused", T0 + 2500, "paused", { pause: { reason: "provider-error", detail: "detail", at: T0 + 2500 } });
    render(<CampaignProgress campaign={paused} advanced onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByTestId("campaign-pause-undelivered").map((x) => x.textContent)).toEqual([
      "A step was delivered in part, and the rest came back to your private balance in another token than the one it was swapping. It is not swapped again on its own.",
    ]);
  });

  it("paused on it, as the runner leaves it: the way is named, and never 'Your funds are safe' beside it", async () => {
    await wallet();
    const detail = "Step 1 came back to your private balance in another token than the order's: it is not swapped again on its own. Resume to carry on with the rest, or return the rest.";
    putCampaign(withCampaignState(backInUsdc(band(), 0), "paused", T0 + 2500, detail, { pause: { reason: "provider-error", detail, at: T0 + 2500 } }), session);
    mount();
    const card = await screen.findByTestId("swap-steps-paused");
    const block = screen.getByTestId("swap-steps-not-delivered");
    expect(block.textContent).toContain("$20,000.00 of the swap came back to your protected balance in another token than ETH.");
    expect(block.textContent).not.toContain("did not come back");
    expect(screen.getByTestId("swap-steps-safe").textContent).toBe("What has not been handed over stays in your protected balance.");
    expect(card.textContent).not.toContain("Your funds are safe");
  });
});

describe("C12-4: the running page, the Advanced page and the status word", () => {
  it("the running page: the step's value is part of 'Not delivered as asked', said of which came back in another token — the lines add up to the total without it", () => {
    const c = settled(backInUsdc(band(), 0), 1);
    const m = campaignProgressModel(c).large!;
    expect(m).toMatchObject({ completedUsdCents: 2_000_000n, executingUsdCents: 0n, remainingUsdCents: 4_000_000n, notDeliveredUsdCents: 2_000_000n, returnedOtherUsdCents: 2_000_000n });
    expect(m.completedUsdCents + m.executingUsdCents + m.remainingUsdCents + m.notDeliveredUsdCents!, "the lines add up to the total").toBe(m.totalUsdCents);
    render(<ProgressView model={campaignProgressModel(c)} />);
    expect(screen.getByTestId("progress-not-delivered").textContent).toBe("Not delivered as asked$20,000.00");
    expect(screen.getByTestId("progress-returned-other").textContent).toBe("Of which: steps returned in another token$20,000.00");
    cleanup();
    // without such a step: no line for it
    render(<ProgressView model={campaignProgressModel(settled(undelivered(band(), 0, "lost"), 1))} />);
    expect(screen.queryByTestId("progress-returned-other")).toBeNull();
    expect(screen.getByTestId("progress-not-delivered").textContent).toBe("Not delivered as asked$20,000.00");
  });

  it("finished with it, the status is a warning; the Advanced page counts it under Not delivered as asked and names it, and its last sentence says so", () => {
    const done = withCampaignState([1, 2, 3].reduce(settled, backInUsdc(band(), 0)), "completed", T0 + 9000);
    expect(campaignStatus(done)).toEqual({ mark: "⚠", word: "PartNotDelivered" });
    render(<CampaignProgress campaign={done} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    const page = screen.getByTestId("campaign-progress");
    expect(screen.getByTestId("campaign-status").textContent).toBe("⚠ Part not delivered as asked");
    expect(page.querySelector('[data-amount="ended"]')?.textContent).toBe("8 ETH (≈ $20K)");
    expect(page.querySelector('[data-amount="returned-other"]')?.textContent).toBe("8 ETH (≈ $20K)");
    expect(page.textContent).toContain("Of which: steps returned in another token");
    expect(page.textContent).toContain("Every step finished; part of the amount did not arrive as you asked (see Not delivered as asked).");
  });

  it("the Advanced pause card names the way: back in another token; refunded at the destination with the rest back, or with nothing back (C12-7)", () => {
    const paused = (c: Campaign) => withCampaignState(c, "paused", T0 + 2500, "paused", { pause: { reason: "provider-error", detail: "detail", at: T0 + 2500 } });
    const words = (c: Campaign) => {
      render(<CampaignProgress campaign={paused(c)} advanced onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
      const out = screen.getAllByTestId("campaign-pause-undelivered").map((x) => x.textContent);
      cleanup();
      return out;
    };
    expect(words(backInUsdc(band(), 0))).toEqual([
      "A step came back to your private balance in another token than the one it was swapping. It is not swapped again on its own.",
    ]);
    expect(words(undelivered(band(), 0, "refunded-at-destination", { refunded: eth(3).toString() }))).toEqual([
      "A step was not delivered: its provider refunded it at that step's destination address, in its own refund asset. What else came back returned to your private balance.",
    ]);
    expect(words(undelivered(band(), 0, "refunded-at-destination"))).toEqual([
      "A step was not delivered: its provider refunded it at that step's destination address, in its own refund asset. Nothing came back to your private balance.",
    ]);
  });
});

describe("C12-4: the Activity row", () => {
  it("a campaign whose only undelivered steps came back in another token, or were delivered in one, reads 'other-token'; beside a settled step 'partial'; beside a lost one 'failed'", async () => {
    await wallet();
    recordActivity(
      { id: activityId("campaign", ID), kind: "campaign", asset: "ETH", decimals: 18, amount: eth(32).toString(), status: "running", ref: ID, note: "→ BTC" },
      session,
    );
    const chip = (c: Campaign) => {
      putCampaign(c, session);
      const row = buildRows(session.journal(), [], false, t).find((x) => x.kind === "campaign")!;
      expect(row.activity?.status).toBe(c.state);
      return rowView(row, t).status;
    };
    expect(chip(withCampaignState(restSkipped(backInUsdc(band(), 0), 1), "cancelled", T0 + 9000))).toBe("other-token");
    expect(chip(withCampaignState(restSkipped(backInUsdc(undelivered(band(), 0, "other-token"), 1), 2), "cancelled", T0 + 9000)), "both ways another token").toBe("other-token");
    expect(chip(withCampaignState([1, 2, 3].reduce(settled, backInUsdc(band(), 0)), "completed", T0 + 9000)), "three delivered, one back in USDC").toBe("partial");
    expect(chip(withCampaignState(restSkipped(backInUsdc(undelivered(band(), 0, "lost"), 1), 2), "cancelled", T0 + 9000)), "one lost beside it").toBe("failed");
    expect(activityStatus("campaign", "cancelled", withCampaignState(restSkipped(backInUsdc(band(), 0), 1), "cancelled", T0 + 9000))).toBe("other-token");
  });
});

describe("the second critique (XB): the last words, a settled partial, a failed step with part back, what came back named", () => {
  it("the runner's last words with a step back in another token, or delivered in part with its rest so: finished, part not as asked, a warning — returned after it, the same", async () => {
    await wallet();
    const partly = withTrancheState(band(), 0, "undelivered", T0 + 2000, {
      orderId: "0x01",
      provider: "lifi",
      outcome: { undelivered: "refunded-other-token", deliveredInPart: true, returnedOther: [{ vault: USDC_VAULT, amount: "9000000000" }] },
    });
    for (const c of [[1, 2, 3].reduce(settled, backInUsdc(band(), 0)), [1, 2, 3].reduce(settled, partly)]) {
      const n = await finish(c);
      expect(n).toMatchObject({ kind: "completed", title: "Protected swap finished", words: { key: "completed-not-all" }, tone: "warn" });
      expect(shownWords(n).body).toBe("Every step finished, but part of the amount did not arrive as you asked.");
      // the runner's own words: the notification's body, the alert it journals (the Advanced page's last alert) and its state's note
      expect(n.body).toBe("Every step finished; part of the amount did not arrive as you asked (see the steps).");
      const after = campaignById(ID, session)!;
      expect(after.alerts?.at(-1)?.text).toBe("Every step finished; part of the amount did not arrive as you asked (see the steps).");
      expect(after.history.at(-1)).toMatchObject({ state: "completed", note: "every step finished" });
    }
    const returned = await finish(withCampaignState(restSkipped(backInUsdc(band(), 0), 1), "winding-down", T0 + 5000));
    expect(returned).toMatchObject({ kind: "cancelled", words: { key: "cancelled-not-all" }, tone: "warn" });
    expect(returned.body).toBe("The rest returned to your private balance; part of the amount did not arrive as you asked (see the steps).");
    expect(campaignById(ID, session)!.alerts?.at(-1)?.text).toBe("The rest returned to your private balance; part of the amount did not arrive as you asked (see the steps).");
  });

  it("a settled partial whose rest came back in USDC: its own where-words — never 'the rest did not come back', in Korean neither", async () => {
    await wallet();
    const c = withCampaignState([1, 2, 3].reduce(settled, settledBackInUsdc(band(), 0)), "completed", T0 + 9000);
    expect(exposure(c)).toMatchObject({ completed: eth(28), notDelivered: 0n, returnedOther: eth(4) });
    putCampaign(c, session);
    mount();
    const card = await screen.findByTestId("swap-steps-not-all");
    expect(screen.getByTestId("swap-steps-returned-other").textContent).toBe("$10,000.00 of the swap came back to your protected balance in another token than ETH.");
    expect(card.textContent).toContain("A step was delivered in part, and the rest came back to your protected balance in another token than ETH.");
    expect(card.textContent).not.toContain("did not come back");
    await loadCatalog("ko");
    act(() => setLocale("ko"));
    await waitFor(() => expect(screen.getByTestId("swap-steps-not-all").textContent).toContain(t("screen.swap.stepsWhere.partialReturnedOther", { from: "ETH" }, "ko")));
    expect(screen.getByTestId("swap-steps-not-all").textContent).not.toContain(t("screen.swap.stepsWhere.partialUnreturned", undefined, "ko"));
  });

  it("a step that failed at its provider with part of it back: what came back is said — on the steps page and the Advanced pause card", async () => {
    await wallet();
    const lostRest = undelivered(band(), 0, "lost", { refunded: eth(2).toString() });
    expect(exposure(lostRest)).toMatchObject({ notDelivered: eth(6) });
    putCampaign(withCampaignState(restSkipped(lostRest, 1), "cancelled", T0 + 9000), session);
    mount();
    const card = await screen.findByTestId("swap-steps-not-all");
    expect(screen.getByTestId("swap-steps-ended").textContent).toBe("$15,000.00 did not arrive as you asked and did not come back to your protected balance.");
    expect(card.textContent).toContain("The provider failed a step; what came back of it returned to your protected balance.");
    expect(card.textContent).not.toContain("nothing has come back");
    cleanup();
    const paused = withCampaignState(lostRest, "paused", T0 + 2500, "paused", { pause: { reason: "provider-error", detail: "detail", at: T0 + 2500 } });
    render(<CampaignProgress campaign={paused} advanced onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    expect(screen.getAllByTestId("campaign-pause-undelivered").map((x) => x.textContent)).toEqual([
      "A step failed at its provider; what came back of it returned to your private balance.",
    ]);
  });

  it("what came back is named in its own token when the vault is one of the deployment's: '… came back to your protected balance as 19,800 USDC.'", async () => {
    await wallet();
    const withUsdc = { ...deployment, erc20Vaults: [{ symbol: "USDC", decimals: 6, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", vault: USDC_VAULT }] } as Deployment;
    putCampaign(withCampaignState([1, 2, 3].reduce(settled, backInUsdc(band(), 0)), "completed", T0 + 9000), session);
    mount(withUsdc);
    expect((await screen.findByTestId("swap-steps-returned-other")).textContent).toBe("$20,000.00 of the swap came back to your protected balance as 19,800 USDC.");
    cleanup();
    // beside a step delivered in part, each sentence names its own steps' tokens
    const partly = withTrancheState(band(), 1, "undelivered", T0 + 2001, {
      orderId: "0x02",
      provider: "lifi",
      outcome: { undelivered: "refunded-other-token", deliveredInPart: true, returnedOther: [{ vault: USDC_VAULT, amount: "9000000000" }] },
    });
    putCampaign(withCampaignState([2, 3].reduce(settled, backInUsdc(partly, 0)), "completed", T0 + 9000), session);
    mount(withUsdc);
    expect((await screen.findByTestId("swap-steps-returned-other")).textContent).toBe("$20,000.00 of the swap came back to your protected balance as 19,800 USDC.");
    expect(screen.getByTestId("swap-steps-partly-back").textContent).toBe("$20,000.00 of the swap was delivered only in part; the rest came back to your protected balance as 9,000 USDC.");
    cleanup();
    // a vault this deployment does not know among them: the sentence names none of them, never a part of what came back as the whole
    const unknown = withTrancheState(band(), 0, "undelivered", T0 + 2000, {
      orderId: "0x01",
      provider: "lifi",
      outcome: { undelivered: "refunded-other-token", returnedOther: [{ vault: USDC_VAULT, amount: "9900000000" }, { vault: "0x" + "d1".repeat(20), amount: "5" }] },
    });
    putCampaign(withCampaignState([1, 2, 3].reduce(settled, unknown), "completed", T0 + 9000), session);
    mount(withUsdc);
    expect((await screen.findByTestId("swap-steps-returned-other")).textContent).toBe("$20,000.00 of the swap came back to your protected balance in another token than ETH.");
    cleanup();
    // a settled partial's rest and a step back in the same token: summed, never the one without the other
    putCampaign(withCampaignState([2, 3].reduce(settled, settledBackInUsdc(backInUsdc(band(), 0), 1)), "completed", T0 + 9000), session);
    mount(withUsdc);
    expect((await screen.findByTestId("swap-steps-returned-other")).textContent).toBe("$30,000.00 of the swap came back to your protected balance as 29,700 USDC.");
    cleanup();
    // back in two tokens: each named
    const USDT_VAULT = "0x" + "7d".repeat(20);
    const withTwo = { ...withUsdc, erc20Vaults: [...withUsdc.erc20Vaults, { symbol: "USDT", decimals: 6, token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", vault: USDT_VAULT }] } as Deployment;
    const backInUsdt = withTrancheState(backInUsdc(band(), 0), 1, "undelivered", T0 + 2001, {
      orderId: "0x02",
      provider: "lifi",
      outcome: { undelivered: "refunded-other-token", returnedOther: [{ vault: USDT_VAULT, amount: "19700000000" }] },
    });
    putCampaign(withCampaignState([2, 3].reduce(settled, backInUsdt), "completed", T0 + 9000), session);
    mount(withTwo);
    expect((await screen.findByTestId("swap-steps-returned-other")).textContent).toBe("$40,000.00 of the swap came back to your protected balance as 19,800 USDC, 19,700 USDT.");
  });

  it("returned after a step back in USDC: the Advanced page's last sentence says part did not arrive as asked", () => {
    const returned = withCampaignState(restSkipped(backInUsdc(band(), 0), 1), "cancelled", T0 + 9000);
    render(<CampaignProgress campaign={returned} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("campaign-progress").textContent).toContain(
      "The rest returned to your private balance; part of the amount did not arrive as you asked (see Not delivered as asked).",
    );
  });

  it("what came back of a step not delivered as asked is planned again only with the user's word: the replan asks first, its fees said", () => {
    const c = withCampaignState([1, 2, 3].reduce(settled, undelivered(band(), 0, "lost", { refunded: eth(2).toString() })), "running", T0 + 8000);
    expect(exposure(c).remaining, "the part that came back").toBe(eth(2));
    const a = nextAction(c, { now: T0 + 9000, pause: null, notesShaped: true });
    expect(a).toMatchObject({ kind: "pause", reason: "bounds", replan: true });
    expect((a as { detail: string }).detail).toContain(REPLAN_PAUSE);
  });

  it("dust of a step not delivered as asked — a 1-wei note anyone can make — is kept in the balance: never planned again, nor asked about", () => {
    const c = withCampaignState([1, 2, 3].reduce(settled, undelivered(band(), 0, "lost", { refunded: "1" })), "running", T0 + 8000);
    expect(exposure(c)).toMatchObject({ remaining: 0n, kept: 1n });
    expect(nextAction(c, { now: T0 + 9000, pause: null, notesShaped: true })).toEqual({ kind: "complete" });
  });

  it("dust that came back after a replan the user approved never makes the campaign ask again", () => {
    // step 1 came back (7 ETH of its 8), the user was asked and resumed; then step 2 failed with 1 wei back; steps 3 and 4 settled
    const asked = withCampaignState(
      withCampaignState(withCampaignState(withTrancheState(band(), 0, "refunded", T0 + 2000, { orderId: "0x01", outcome: { refunded: eth(7).toString() } }), "paused", T0 + 5000, "the replan"), "reassessing", T0 + 6000),
      "running",
      T0 + 6500,
    );
    const later = [2, 3].reduce(settled, withTrancheState(asked, 1, "undelivered", T0 + 7000, { orderId: "0x02", provider: "lifi", outcome: { undelivered: "lost", refunded: "1" } }));
    const c = { ...later, replanAskedAt: T0 + 5000 } as Campaign;
    expect(exposure(c).remaining).toBe(eth(7));
    expect(nextAction(c, { now: T0 + 9000, pause: null, notesShaped: true })).toEqual({ kind: "replan" });
  });

  it("a campaign with no valuation names the steps' value in its asset beside what came back", async () => {
    await wallet();
    const withUsdc = { ...deployment, erc20Vaults: [{ symbol: "USDC", decimals: 6, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", vault: USDC_VAULT }] } as Deployment;
    const partly = withTrancheState(backInUsdc(band(), 0), 1, "undelivered", T0 + 2001, {
      orderId: "0x02",
      provider: "lifi",
      outcome: { undelivered: "refunded-other-token", deliveredInPart: true, returnedOther: [{ vault: USDC_VAULT, amount: "9000000000" }] },
    });
    const c = { ...withCampaignState([2, 3].reduce(settled, partly), "completed", T0 + 9000), value: undefined } as Campaign;
    expect(campaignProgressModel(c).large, "no valuation").toBeNull();
    putCampaign(c, session);
    mount(withUsdc);
    expect((await screen.findByTestId("swap-steps-returned-other")).textContent).toBe("8 ETH of the swap came back to your protected balance as 19,800 USDC.");
    expect(screen.getByTestId("swap-steps-partly-back").textContent).toBe("8 ETH of the swap was delivered only in part; the rest came back to your protected balance as 9,000 USDC.");
  });
});

describe("the ninth critique of slice 12a (XI): a dropped step's card, a refused return while the rest returns", () => {
  const failed = (c: Campaign, i: number, patch: Partial<Tranche> = {}) => withTrancheState(c, i, "failed", T0 + 2000 + i, { orderId: `0x0${i + 1}`, ...patch });
  const pausedOn = (c: Campaign, code: string) =>
    withCampaignState(c, "paused", T0 + 2500, "detail", { pause: { reason: code === "step_dropped" ? "provider-error" : "anomaly", detail: "detail", at: T0 + 2500, trancheIndex: 0, code } });

  it("paused on a dropped step, or on its refused return: the step's own words, and a step held until it is returned — never 'after its refund time'; in Korean too", async () => {
    await wallet();
    putCampaign(pausedOn(failed(settled(band(), 1), 0), "step_dropped"), session);
    mount();
    const card = await screen.findByTestId("swap-steps-paused");
    expect(card.textContent).toContain(t("op.error.step_dropped.title"));
    expect(screen.getByTestId("swap-steps-reason").textContent).toBe(t("op.error.step_dropped.reason"));
    expect(screen.getByTestId("swap-steps-safe").textContent).toBe(t("screen.swap.stepsSafeKept"));
    expect(card.textContent).not.toContain("after its refund time");
    expect(card.textContent, "never the single swap's").not.toContain(t("op.error.execution_window_closed.reason"));
    await loadCatalog("ko");
    act(() => setLocale("ko"));
    await waitFor(() => expect(screen.getByTestId("swap-steps-reason").textContent).toBe(t("op.error.step_dropped.reason", undefined, "ko")));
    expect(screen.getByTestId("swap-steps-safe").textContent).toBe(t("screen.swap.stepsSafeKept", undefined, "ko"));
    cleanup();
    act(() => setLocale("en"));
    putCampaign(pausedOn(failed(band(), 0, { refundRefusedAt: T0 + 2500 }), "step_refund_not_watched"), session);
    mount();
    await screen.findByTestId("swap-steps-paused");
    expect(screen.getByTestId("swap-steps-reason").textContent).toBe(t("op.error.step_refund_not_watched.reason"));
    expect(screen.getByTestId("swap-steps-safe").textContent).toBe(t("screen.swap.stepsSafeKept"));
  });

  it("while the rest returns, a held step whose return a relayer refused is said on the steps page and on the progress page — never 'Returning the rest' alone; none without one", async () => {
    await wallet();
    const winding = (c: Campaign) => withCampaignState(c, "winding-down", T0 + 3000, "the rest returns");
    putCampaign(winding(failed(band(), 0, { refundRefusedAt: T0 + 3000 })), session);
    mount();
    expect((await screen.findByTestId("swap-steps-return-refused")).textContent).toBe(t("campaign.returnRefused"));
    expect(screen.getByTestId("swap-steps-note").textContent).toBe(t("screen.swap.stepsReturning"));
    cleanup();
    render(<CampaignProgress campaign={winding(failed(band(), 0, { refundRefusedAt: T0 + 3000 }))} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("campaign-return-refused").textContent).toBe(t("campaign.returnRefused"));
    cleanup();
    render(<CampaignProgress campaign={winding(failed(band(), 0))} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
    expect(screen.queryByTestId("campaign-return-refused"), "no refusal: nothing said").toBeNull();
    cleanup();
    putCampaign(winding(failed(band(), 0)), session);
    mount();
    await screen.findByTestId("swap-steps-note");
    expect(screen.queryByTestId("swap-steps-return-refused")).toBeNull();
  });

  it("paused on a dropped step beside a step not delivered as asked: the rest's words, never 'after its refund time' (XJ)", async () => {
    await wallet();
    putCampaign(pausedOn(failed(undelivered(band(), 1, "refunded-at-destination"), 0), "step_dropped"), session);
    mount();
    const card = await screen.findByTestId("swap-steps-paused");
    expect(screen.getByTestId("swap-steps-safe").textContent).toBe(t("screen.swap.stepsRestKept"));
    expect(card.textContent).not.toContain("after its refund time");
  });

  it("under any pause, a held step its relayer refused to return, or whose order reads dropped, is held until it is returned — a plain failed one still at its refund time (XJ)", async () => {
    await wallet();
    const userPaused = (c: Campaign) => withCampaignState(c, "paused", T0 + 2500, "paused", { pause: { reason: "user", detail: "paused", at: T0 + 2500 } });
    putCampaign(userPaused(failed(band(), 0, { refundRefusedAt: T0 + 2400 })), session);
    mount();
    await screen.findByTestId("swap-steps-paused");
    expect(screen.getByTestId("swap-steps-safe").textContent, "a refused step").toBe(t("screen.swap.stepsSafeKept"));
    cleanup();
    session.update((j) => {
      j.swaps = [
        {
          orderId: "0x01",
          attemptId: "0x" + "01".repeat(32),
          refundCounter: 1,
          provider: "lifi",
          policy: "balanced",
          request: { from: ETH, to: BTC, amount: eth(8).toString(), destination: "bc1q", slippageBps: 50 },
          params: { amount: eth(8).toString(), executeDeadline: Math.floor(T0 / 1000) + 1800, refundAfter: Math.floor(T0 / 1000) + 9000 },
          endpoint: "0x00000000000000000000000000000000000000e5",
          createdAt: T0,
          state: "executing",
          campaign: { id: ID, index: 0 },
          track: { state: "DROPPED", label: "Needs attention", at: T0 + 2400 },
        } as never,
      ];
    });
    putCampaign(userPaused(failed(band(), 0)), session);
    mount();
    await screen.findByTestId("swap-steps-paused");
    expect(screen.getByTestId("swap-steps-safe").textContent, "a dropped step").toBe(t("screen.swap.stepsSafeKept"));
    cleanup();
    session.update((j) => {
      j.swaps = [];
    });
    putCampaign(userPaused(failed(band(), 0)), session);
    mount();
    await screen.findByTestId("swap-steps-paused");
    expect(screen.getByTestId("swap-steps-safe").textContent, "a plain failed step: its refund time").toBe(t("screen.swap.stepsSafeHeld"));
    cleanup();
    // ... and a step that came back with its refusal's mark still set is no held step: a plain failed one beside it still returns at its refund time
    // (XK's critique)
    putCampaign(userPaused(failed(withTrancheState(band(), 0, "refunded", T0 + 2300, { orderId: "0x01", refundRefusedAt: T0 + 2200 }), 1)), session);
    mount();
    await screen.findByTestId("swap-steps-paused");
    expect(screen.getByTestId("swap-steps-safe").textContent, "a step back since").toBe(t("screen.swap.stepsSafeHeld"));
  });

  it("the refusal's banner only while the rest returns and the refused step is still held: never beside a pause, never once the step came back (XJ)", async () => {
    await wallet();
    render(
      <CampaignProgress campaign={pausedOn(failed(band(), 0, { refundRefusedAt: T0 + 2500 }), "step_refund_not_watched")} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByTestId("campaign-return-refused"), "paused: no 'asks again every ten minutes'").toBeNull();
    cleanup();
    const winding = (c: Campaign) => withCampaignState(c, "winding-down", T0 + 3000, "the rest returns");
    for (const state of ["refunded", "refunding"] as const) {
      const back = winding(withTrancheState(failed(band(), 0, { refundRefusedAt: T0 + 2500 }), 0, state, T0 + 2900));
      render(<CampaignProgress campaign={back} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />);
      expect(screen.queryByTestId("campaign-return-refused"), state).toBeNull();
      cleanup();
      putCampaign(back, session);
      mount();
      await screen.findByTestId("swap-steps-note");
      expect(screen.queryByTestId("swap-steps-return-refused"), state).toBeNull();
      cleanup();
    }
  });
});
