// @vitest-environment happy-dom
// The eleventh review round (2026-11-04): what the screens say about when a swap runs. "Delay for more privacy" funds at the drawn time
// only while the wallet is open and unlocked, and an order not funded in its window stops with nothing sent: the Swap page and the Review
// say so where the delay is chosen, the progress page names the drawn time and the last moment the runner still funds the order — the one
// it stops the order at —, and Home calls such an order scheduled, never executing (E11-9). A staged $50K–$100K swap states the plan's
// time for its steps, on the Swap page and the Review, never the one order's minutes (E11-15). Home's badge and the Privacy Center it
// opens read one level for one posture (E11-11).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import type { Protection } from "@privacy-wallet/sdk/swapService";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { ONE_CONFIRM_EXECUTE_WINDOW_SECONDS, runOrderTick } from "@privacy-wallet/sdk/wallet/orderRunner";
import { FUNDING_MARGIN_MS, patchSwap, windowEndOf } from "@privacy-wallet/sdk/swapFunding";
import { getOperation, newOperation, putOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { swapRecordId, syncSwapRecord } from "@privacy-wallet/sdk/operations/swapRecords";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { stepsSeconds } from "../src/features/swap/model";
import { Home } from "../src/features/wallet/Home";
import { HomeView } from "../src/features/home/View";
import { homeModel } from "../src/features/home/model";
import { levelOf, privacyCenterModel } from "../src/features/privacy-center/model";
import { formatDateTime } from "../src/app/i18n/intl";
import { durationText } from "../src/app/i18n/duration";
import { en } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { t } from "../src/app/i18n/messages";
import { prefs } from "../src/storage/prefs";
import { deployment, ETH_VAULT, fetchMock, resetWorld, world } from "./helpers/swapWorld";

// the private withdrawal into the escrow has its own suites: here a funding is counted, and nothing is sent
const funding = vi.hoisted(() => ({ count: 0 }));
vi.mock("@privacy-wallet/sdk/swapFunding", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/swapFunding")>();
  return {
    ...orig,
    fundEscrow: async () => {
      funding.count++;
      throw new Error("no funding in this test");
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
  funding.count = 0;
});

const ETH = 10n ** 18n;
const QUOTED = { timeout: 15_000 };
/** A wallet holding `eth` ETH in one note — `recent`: protected a moment ago, so "Delay for more privacy" is offered. */
async function wallet(eth: bigint, o: { recent?: boolean } = {}) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({
    note: { vaultId: BigInt(ETH_VAULT), amount: eth * ETH, ownerCommitment: 1n, noteSecret: 2n },
    leafIndex: 0,
    noteData: "0x",
    spent: false,
    ...(o.recent ? { addedAt: Date.now() } : {}),
  });
  await priceStore.refresh(deployment); // ETH at $2,500
}
function mountSwap() {
  const router = createMemoryRouter(
    [
      { path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: ["/swap"], future: ROUTER_FUTURE },
  );
  render(
    <Providers deployment={deployment}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
  return router;
}
async function quoted(amount: string) {
  fireEvent.input(screen.getByTestId("amount-input"), { target: { value: amount } });
  await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
}
/** One tick of the order's runner at `at`, as the scheduler would run it then; a tick that throws goes to the scheduler's backoff. */
async function tickAt(orderId: string, at: number): Promise<{ step?: string; error?: unknown }> {
  const a = session.journal().schedule.find((x) => x.id === `order-tick:${orderId}`);
  expect(a, "the order has a tick planned").toBeTruthy();
  const out: { step?: string; error?: unknown } = {};
  await act(async () => {
    try {
      out.step = (await runOrderTick(a!, { masterSeed: session.state().seed!, deployment, now: () => at }))?.step;
    } catch (e) {
      out.error = e;
    }
  });
  return out;
}

describe("E11-9: a funding delayed for privacy runs only while the wallet is open and unlocked", () => {
  it("the Swap page, the Review and the progress page say so; the last moment the progress page names is the one the runner stops the order at", async () => {
    world.windowAsAsked = true; // the execute window the wallet asks for, as the swap API builds it
    await wallet(1n, { recent: true });
    const router = mountSwap();
    await quoted("0.5");
    fireEvent.click(screen.getByTestId("swap-delay"));
    // the least time a delayed funding still runs after its drawn time, on every route: the one-confirm window less the funding's margin
    const grace = (ONE_CONFIRM_EXECUTE_WINDOW_SECONDS * 1000 - FUNDING_MARGIN_MS) / 60_000;
    expect(grace).toBe(25);
    const note = t("screen.swap.delayNote", { minutes: grace });
    expect(note, "the wallet's part, where the choice is made").toContain("only while this wallet is open and unlocked");
    expect(note).toContain("then or within the next 25 minutes");
    expect(screen.getByTestId("swap-delay-note").textContent).toBe(note);
    fireEvent.click(screen.getByTestId("swap-review"));
    expect((await screen.findByTestId("swap-review-delay")).textContent, "and on the Review").toBe(note);
    await act(async () => {
      fireEvent.click(await screen.findByTestId("review-confirm"));
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\//));
    const [order] = session.journal().swaps;
    const drawn = order.runner!.delayUntil!;
    // the order's window as the engine built it from the wallet's request: the delay and the one-confirm window after the quote's expiry
    const fundBy = windowEndOf(order) - FUNDING_MARGIN_MS;
    expect(windowEndOf(order) - drawn).toBeGreaterThanOrEqual(ONE_CONFIRM_EXECUTE_WINDOW_SECONDS * 1000);
    expect(fundBy - drawn, "never less than the Swap page and the Review say").toBeGreaterThanOrEqual(grace * 60_000);
    const line = (await screen.findByTestId("swap-funding-at")).textContent;
    expect(line).toBe(`${t("screen.swap.fundingAt", { time: formatDateTime(drawn) })} ${t("screen.swap.fundingBy", { until: formatDateTime(fundBy) })}`);
    expect(line).toContain("only while this wallet is open and unlocked");
    // the runner agrees with the words: opened a minute before that moment, it funds the order (counted here; nothing is sent) ...
    const before = await tickAt(order.orderId, fundBy - 60_000);
    expect(before.step, "not stopped a minute before the moment named").not.toBe("stopped");
    expect(funding.count, "the funding was attempted then").toBe(1);
    // ... and opened at it, the swap is cancelled with nothing sent
    const at = await tickAt(order.orderId, fundBy);
    expect(at.step).toBe("stopped");
    expect(getOperation(swapRecordId(order.orderId), session)).toMatchObject({
      state: "CANCELLED",
      reason: { code: "order_expired", fundsClass: "not-moved" },
    });
    expect(funding.count, "nothing more was funded").toBe(1);
  }, 60_000);
});

describe("E11-9: Home calls an unfunded delayed order scheduled, never executing", () => {
  const SWAP = "0x" + "d1".repeat(32);
  /** an order committed an hour ago — before this app session — whose funding waits for its drawn time */
  async function scheduledOrder(drawn: number): Promise<StoredSwap> {
    await session.create("a strong password");
    session.acknowledgePhrase();
    const amount = (5n * 10n ** 17n).toString();
    const stored = {
      orderId: SWAP,
      attemptId: "0x" + "01".repeat(32),
      refundCounter: 0,
      provider: "thorchain",
      policy: "balanced",
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
        amount,
        destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
        slippageBps: 50,
        destinationKind: "fresh",
      },
      params: { amount, executeDeadline: Math.floor(drawn / 1000) + 2400 },
      endpoint: "0x" + "ee".repeat(20),
      createdAt: Date.now() - 3600_000,
      state: "committed",
      runner: { confirmedAt: Date.now() - 3600_000, delayUntil: drawn },
    } as unknown as StoredSwap;
    session.update((j) => {
      j.swaps = [...j.swaps, stored];
    });
    recordActivity({ id: `swap:${SWAP}`, kind: "swap", asset: "ETH", decimals: 18, amount, status: "committed", ref: SWAP, note: "→ BTC" }, session);
    syncSwapRecord(session.journal().swaps[0], null, null, Date.now() - 3600_000, session);
    return stored;
  }
  const mountHome = () =>
    render(
      <MemoryRouter>
        <Providers deployment={null}>
          <Home />
        </Providers>
      </MemoryRouter>,
    );

  it("its card reads Scheduled and when, the line after a return says the wallet's part; once funded it executes", async () => {
    const drawn = Date.now() + 5 * 3600_000;
    await scheduledOrder(drawn);
    expect(getOperation(swapRecordId(SWAP), session)?.state, "the record of an order not funded yet").toBe("AWAITING_AUTHORIZATION");
    mountHome();
    const card = await screen.findByTestId("operation-card");
    expect(card.textContent, "it funds only while the wallet is unlocked: nothing executes yet").not.toContain("Executing");
    expect(card.textContent).toContain("Scheduled");
    expect(screen.getByTestId("operation-scheduled").textContent).toBe(t("home.scheduledNote", { time: formatDateTime(drawn) }));
    expect(screen.getByTestId("operation-scheduled").textContent).toContain("open and unlocked");
    expect(screen.getByTestId("home-returning").textContent).toBe(t("home.stillScheduled", { title: "ETH → BTC", time: formatDateTime(drawn) }));
    expect(screen.getByTestId("home").textContent).not.toContain("still executing");
    // funded: it executes, and Home says so
    await act(async () => {
      patchSwap(SWAP, { state: "funded", fundedTx: "0x" + "11".repeat(32), fundedAt: Date.now() }, session);
      syncSwapRecord(session.journal().swaps[0], null, null, Date.now(), session);
    });
    await waitFor(() => expect(screen.getByTestId("operation-card").textContent).toContain("Executing"));
    expect(screen.queryByTestId("operation-scheduled")).toBeNull();
    expect(screen.getByTestId("home-returning").textContent).toBe(t("home.stillExecuting", { title: "ETH → BTC" }));
  });

  it("a card being prepared reads Preparing, as Activity says it — never Executing", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    putOperation(
      newOperation(
        {
          kind: "send",
          amounts: { asset: "ETH", decimals: 18, input: (10n ** 17n).toString() },
          destination: { kind: "fresh", display: "0x01", chain: "ethereum" },
          tier: "standard",
          state: "PREPARING_PROOF",
        },
        Date.now(),
      ),
      session,
    );
    mountHome();
    const card = await screen.findByTestId("operation-card");
    expect(card.textContent).toContain("Preparing");
    expect(card.textContent).not.toContain("Executing");
  });
});

describe("E11-15: a staged band swap states the plan's time for its steps", () => {
  // each step of the plan: the route's twelve minutes, a minute, Bitcoin's hour of finality and the mean cadence (swap-engine risk/protection.ts)
  const PER_STEP = 720 + 60 + 3600 + 180;
  const staged: Protection = {
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
    estimatedSeconds: 5 * PER_STEP,
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

  it("the Swap page's Estimated time is the steps' time in all, and the Review states it with the wallet's part", async () => {
    world.protection = staged;
    await wallet(40n);
    mountSwap();
    await quoted("32"); // $80,000: the band, staged by the service
    const eta = screen.getByTestId("swap-eta").textContent ?? "";
    fireEvent.click(screen.getByTestId("swap-review"));
    await screen.findByTestId("review-view");
    expect(eta, "hours of steps, never the one order's minutes").toMatch(/\d+ h, in \d+ steps/);
    const n = Number(/Protected steps: (\d+) pieces/.exec(screen.getByTestId("review-large-order").textContent ?? "")?.[1]);
    expect(n, "the Review names the steps").toBeGreaterThan(1);
    const duration = durationText(t, n * PER_STEP);
    expect(eta).toBe(`${t("screen.swap.estimatedTime")}${t("screen.swap.stepsEta", { duration, n })}`);
    expect(screen.queryByTestId("review-steps-time"), "the Review states the steps' time").not.toBeNull();
    const time = screen.getByTestId("review-steps-time").textContent;
    expect(time).toBe(t("screen.review.large.stepsTime", { duration }));
    expect(time).toContain("only while this wallet is open and unlocked");
  }, 60_000);

  it("the plan's time per step for the steps this wallet runs, one at a time; never less than their swaps alone", () => {
    expect(stepsSeconds({ estimatedSeconds: 5 * PER_STEP, estimatedTranches: 5, concurrency: "sequential" }, 6, 600)).toBe(6 * PER_STEP);
    expect(
      stepsSeconds({ estimatedSeconds: (5 * PER_STEP) / 2, estimatedTranches: 5, concurrency: "parallel" }, 6, 600),
      "the band's steps go one at a time",
    ).toBe(6 * PER_STEP);
    expect(stepsSeconds({ estimatedSeconds: 0, estimatedTranches: 0, concurrency: "sequential" }, 4, 660), "a plan without a time: the swaps alone").toBe(
      4 * 660,
    );
  });
});

describe("E11-11: Home's badge and the Privacy Center it opens read one level", () => {
  const BADGE = { high: "home.badge.high", medium: "home.badge.medium", low: "home.badge.low" } as const;
  const noop = () => {};
  const home = (overall: "Excellent" | "Good" | "Reduced" | null) =>
    homeModel({ assets: [], notes: [], prices: { status: "ready", prices: {} } as never, overall, rows: [], advanced: null }, t);
  it("one rule for every posture: the badge's level is the Center's — Reduced Low, Good Medium, Excellent High", () => {
    for (const overall of ["Reduced", "Good", "Excellent"] as const) {
      const center = privacyCenterModel({
        posture: { overall, categories: [], limits: [] },
        rpcEndpoints: 2,
        lightClient: true,
        relayerSubmission: true,
        freshDestinations: true,
        stored: { notes: 0, operations: 0, addressBook: 0 },
        purposes: [],
        poolNotes: null,
      });
      expect(center.level).toBe(levelOf(overall));
      const model = home(overall);
      expect(model.protection, `${overall}: Home reads the level of the Center its badge opens`).toBe(center.level);
      const { unmount } = render(
        <Providers deployment={null}>
          <HomeView
            model={model}
            actions={{ onProtect: noop, onSend: noop, onSwap: noop, onPrivacy: noop, onSettings: noop, onWallet: noop, onReceive: noop, onOperation: noop }}
          />
        </Providers>,
      );
      expect(screen.getByTestId("privacy-badge").textContent, overall).toBe(t(BADGE[center.level!]));
      unmount();
    }
  });
  it("Reduced — every wallet's posture today — reads Low protection, as audit gap 65 says; a posture not known claims nothing", () => {
    expect(home("Reduced").protection).toBe("low");
    expect(t(BADGE.low)).toBe("Low protection");
    expect(home(null).protection).toBe("low");
  });
});

describe("the words", () => {
  const KEYS = [
    "screen.swap.delayNote",
    "screen.swap.fundingAt",
    "screen.swap.fundingBy",
    "screen.swap.stepsEta",
    "screen.review.large.stepsTime",
    "operation.scheduled",
    "home.stillScheduled",
    "home.scheduledNote",
  ] as const;
  it("read in Korean with the English placeholders and no English word; none is a word a Simple screen never shows", () => {
    const placeholders = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);
    for (const k of KEYS) {
      const e = (en as Record<string, string>)[k];
      const kk = (ko as Record<string, string | undefined>)[k];
      expect(e, k).toBeTruthy();
      expect(kk, k).toBeTruthy();
      expect(placeholders(kk!), k).toEqual(placeholders(e));
      expect(kk!.replace(/\{\w+\}/g, ""), `${k}: no English word in Korean`).not.toMatch(/[A-Za-z]{2,}/);
      for (const rx of [/\bescrow/i, /\bgas\b/i, /\bproofs?\b/i, /\broot\b/i, /\bmemo\b/i, /\bslippage\b/i, /\btranche/i, /\bnullifier/i, /\bcommitment/i])
        expect(e, `${k}: ${rx}`).not.toMatch(rx);
      for (const rx of [/anonym/i, /\bmixers?\b/i, /untraceable/i, /undetectable/i]) expect(e, `${k}: ${rx}`).not.toMatch(rx);
    }
    expect(ko["screen.swap.delayNote" as keyof typeof ko]).toContain("잠금 해제");
  });
});
