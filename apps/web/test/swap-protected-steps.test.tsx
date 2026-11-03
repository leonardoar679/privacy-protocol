// @vitest-environment happy-dom
// V7 Stage 13 (spec v3.0 §4; the owner's decisions 3 and 4): the $50K–$100K band is a Protected Large Swap — an $80,000 ETH → BTC
// swap on the V6 screens is ONE order by default: no "Protect this order" checkbox and no mode, the Review's Protected execution
// card with its checks and "One order — no automatic split", Hold to Confirm, then ONE confirmation commits one order (its
// progress page, no campaign). The steps run only when the service's plan is staged or the user asked under Advanced
// ("Protected steps"): the planner's varied pieces under the quarter, one at a time, /swap/steps/:id with amounts only and
// "Return the rest". The band's exposure limit (one protected operation in flight per wallet), the route's liquidity
// qualification and the Advanced gate over $100,000 close Review Swap and block a confirmation. The pure pieces too.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { exposure, withTrancheState, type Campaign, withCampaignState } from "@privacy-wallet/protocol/wallet/campaign";
import { feeForWithdrawal, swapFunding } from "@privacy-wallet/protocol/wallet/fees";
import type { Protection, ServiceQuote } from "@privacy-wallet/sdk/swapService";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { campaignById, campaignsOf, putCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { protectedInFlight } from "@privacy-wallet/sdk/wallet/inFlight";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale, t } from "../src/app/i18n/messages";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { campaignProgressModel } from "../src/features/progress/model";
import { confirmBlockers, protectedCommitBlocker, protectedStepsAmount, stepsAmountAtFixedPoint, STRICT_QUOTE_TTL_SECONDS } from "../src/features/swap/model";
import { prefs } from "../src/storage/prefs";
import { deployment, ETH_VAULT, fetchMock, requests, resetWorld, world } from "./helpers/swapWorld";

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
});

const ETH = 10n ** 18n;
/** The engine's recommendation at the $50K band (spec v3.0 §4): varied pieces between an eighth and a quarter, one in flight. */
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
/** The same route, staged by the service (a thin route: impact or reliability): the steps run without asking. */
const stagedPlan: Protection = { ...bandPlan, staged: true, reasons: ["staged below $1M: the only venue quotes with high impact or low reliability"] };

async function wallet(ethNotes = 40n) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({
    note: { vaultId: BigInt(ETH_VAULT), amount: ethNotes * ETH, ownerCommitment: 1n, noteSecret: 2n },
    leafIndex: 0,
    noteData: "0x",
    spent: false,
  });
  await priceStore.refresh(deployment); // ETH at $2,500: 32 ETH is $80,000 — the $50K band; 50 ETH is $125,000 — over $100K
}
function mount(path: string | { pathname: string; state?: unknown } = "/swap") {
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
async function typeAndReview(amount: string) {
  fireEvent.input(screen.getByTestId("amount-input"), { target: { value: amount } });
  await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
  fireEvent.click(screen.getByTestId("swap-review"));
  return screen.findByTestId("review-view");
}
async function holdToConfirm() {
  const hold = screen.getByTestId("hold-to-confirm") as HTMLButtonElement;
  await act(async () => {
    hold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
  });
}
/** An open order of a band in the journal (its funding sent), as the runner would have left it. */
const openOrder = (tier: string, orderId = "0x" + "ab".repeat(20)): StoredSwap =>
  ({
    orderId,
    attemptId: "0x" + "01".repeat(32),
    refundCounter: 0,
    provider: "thorchain",
    policy: "balanced",
    request: {},
    params: {},
    endpoint: "0x" + "ee".repeat(20),
    createdAt: Date.now(),
    state: "funded",
    tier,
  }) as StoredSwap;

describe("V7 Stage 13: the Protected Large Swap — one order by default (spec v3.0 §4)", () => {
  it("$80,000: no checkbox, no mode, no gate; the Review's Protected execution card says One order; the hold commits ONE order to its progress page — no campaign", async () => {
    world.protection = bandPlan;
    await wallet();
    const router = mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
    expect(screen.queryByTestId("protect-this-order"), "no checkbox").toBeNull();
    expect(screen.queryByText(/Protection mode|Max privacy|Max safety/i), "no mode to choose in Simple").toBeNull();
    expect(screen.queryByTestId("swap-advanced-gate"), "the band is open to the Simple experience").toBeNull();
    expect(screen.queryByTestId("swap-in-flight"), "nothing of the band in flight yet").toBeNull();
    fireEvent.click(screen.getByTestId("swap-review"));
    const review = await screen.findByTestId("review-view");
    for (const words of ["Protected execution", "Destination verified", "Quote locked", "Route health checked", "Execution limits enabled"])
      expect(review.textContent).toContain(words);
    expect(screen.getByTestId("review-large-order").textContent).toContain("One order — no automatic split");
    expect(screen.queryByTestId("review-confirm"), "never a tap from $50K").toBeNull();
    await holdToConfirm();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\/r[0-9a-f]{32}$/), { timeout: 15_000 });
    expect(campaignsOf(session.journal()), "no campaign: one order").toHaveLength(0);
    expect(session.journal().swaps).toHaveLength(1);
    const [stored] = session.journal().swaps;
    expect(stored.tier).toBe("large-protected");
    expect(BigInt((stored.params as { amount: string }).amount), "the whole funding in one order, never a quarter").toBeGreaterThan(30n * ETH);
    expect(protectedInFlight(), "the band's one operation in flight").toBe(1);
  });

  it("the exposure limit: with an order of the band open, a second $80,000 names the limit and keeps Review Swap closed; another band's order or a closed one never counts", async () => {
    world.protection = bandPlan;
    await wallet(80n);
    act(() => {
      session.update((j) => {
        j.swaps = [...j.swaps, openOrder("large-protected")];
      });
    });
    expect(protectedInFlight()).toBe(1);
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
    await screen.findByTestId("swap-in-flight", {}, { timeout: 15_000 });
    expect(screen.getByTestId("swap-in-flight").textContent).toContain("One protected swap of this size at a time");
    await waitFor(() => expect(screen.getByTestId("swap-quote")).toBeInTheDocument(), { timeout: 15_000 });
    expect(screen.getByTestId("swap-review"), "closed although a route is quoted").toBeDisabled();
    act(() => {
      session.update((j) => {
        j.swaps = [openOrder("enhanced"), { ...openOrder("large-protected", "0x" + "cd".repeat(20)), state: "refunded" }];
      });
    });
    await waitFor(() => expect(screen.queryByTestId("swap-in-flight")).toBeNull());
    expect(protectedInFlight()).toBe(0);
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled());
  });

  it("the route's qualification: the service's §46 quote says route_not_qualified — the words, Review Swap closed", async () => {
    world.quoteRisk = { score: 100, level: "high", blockers: ["route_not_qualified"], warnings: [] };
    await wallet();
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
    await screen.findByTestId("swap-route-limit", {}, { timeout: 15_000 });
    expect(screen.getByTestId("swap-route-limit").textContent).toContain("Try a smaller amount");
    await waitFor(() => expect(screen.getByTestId("swap-quote")).toBeInTheDocument(), { timeout: 15_000 });
    expect(screen.getByTestId("swap-review")).toBeDisabled();
  });

  it("over $100,000 in the Simple experience: the card with the switch; the switch turns Advanced on and Review Swap opens; the band below never meets it", async () => {
    await wallet(80n); // 50 ETH at $2,500 = $125,000: the enhanced band
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "50" } });
    const gate = await screen.findByTestId("swap-advanced-gate", {}, { timeout: 15_000 });
    expect(gate.textContent).toContain("Over $100,000 needs the Advanced experience");
    await waitFor(() => expect(screen.getByTestId("swap-quote")).toBeInTheDocument(), { timeout: 15_000 });
    expect(screen.getByTestId("swap-review"), "closed although a route is quoted").toBeDisabled();
    fireEvent.click(screen.getByTestId("swap-advanced-switch"));
    await waitFor(() => expect(screen.queryByTestId("swap-advanced-gate")).toBeNull());
    expect(prefs().get().experience).toBe("advanced");
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled());
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
    await waitFor(() => expect(screen.getByTestId("swap-amount-usd").textContent).toContain("$80,000"));
    expect(screen.queryByTestId("swap-advanced-gate")).toBeNull();
  });

  it("the blockers (pure): the band's limit and the service's route qualification stop a confirmation; the service's other verdicts the wallet judges itself", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    const quote = { expiresAt: Math.floor(now / 1000) + 600, toAmount: "100", toAmountMin: "99", impactBps: 0 } as ServiceQuote;
    const facts = {
      now,
      quotedAt: now - 1000,
      quote,
      approvedMin: 99n,
      destinationValid: true,
      providerHealthy: true,
      chainId: 1,
      crossChain: true,
      largeTrade: true,
      strictQuote: true,
    };
    expect(confirmBlockers(facts)).toEqual([]);
    expect(confirmBlockers({ ...facts, inFlight: { count: 1, limit: 1 } })).toEqual(["in_flight_limit"]);
    expect(confirmBlockers({ ...facts, inFlight: { count: 0, limit: 1 } })).toEqual([]);
    expect(confirmBlockers({ ...facts, serviceBlockers: ["route_not_qualified"] })).toEqual(["route_not_qualified"]);
    expect(confirmBlockers({ ...facts, serviceBlockers: ["quote_expired", "provider_unhealthy"] }), "judged by the wallet's own facts").toEqual([]);
    expect(confirmBlockers({ ...facts, inFlight: { count: 1, limit: 1 }, serviceBlockers: ["route_not_qualified"] })).toEqual([
      "in_flight_limit",
      "route_not_qualified",
    ]);
  });
  it("the protected screen's own guard (pure): the band's limit, then the service's route qualification; the rest the screen judges itself (the review round of 2026-11-02)", () => {
    expect(protectedCommitBlocker({ tier: "large-protected", limitReached: true, serviceBlockers: [] })).toBe("in_flight_limit");
    expect(protectedCommitBlocker({ tier: "enhanced", limitReached: true, serviceBlockers: [] }), "the limit is the band's").toBeNull();
    expect(protectedCommitBlocker({ tier: "enhanced", limitReached: false, serviceBlockers: ["route_not_qualified"] })).toBe("route_not_qualified");
    expect(protectedCommitBlocker({ tier: "large-protected", limitReached: true, serviceBlockers: ["route_not_qualified"] })).toBe("in_flight_limit");
    expect(protectedCommitBlocker({ tier: "large-protected", limitReached: false, serviceBlockers: ["quote_expired", "provider_unhealthy"] })).toBeNull();
  });
  it("the merges a swap's funding needs first are on the Review, each at the relayer's minimum, and bound the funding (the review round of 2026-11-03, E3)", async () => {
    world.relayerInfo = { minFeeWei: (10n ** 15n).toString() };
    await wallet(10n);
    noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 10n * ETH, ownerCommitment: 1n, noteSecret: 3n }, leafIndex: 1, noteData: "0x", spent: false });
    noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 10n * ETH, ownerCommitment: 1n, noteSecret: 4n }, leafIndex: 2, noteData: "0x", spent: false });
    const router = mount();
    await typeAndReview("25"); // three notes of 10: one merge first
    expect(screen.getByTestId("review-fee-merges").textContent).toMatch(/1/);
    await holdToConfirm();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/progress\//));
    const [sw] = session.journal().swaps;
    expect(sw.reviewedMergeFee, "each merge at most the Review's F: the relayer's minimum with its margin").toBe((11n * 10n ** 14n).toString());
  });
  it("the V5 screen (/swap/protected) is the Advanced experience's: by URL in the Simple experience it goes back to /swap, with a campaign id not in the journal too; under Advanced it opens (the review round of 2026-11-02)", async () => {
    await wallet();
    let router = mount("/swap/protected");
    await waitFor(() => expect(router.state.location.pathname).toBe("/swap"));
    cleanup();
    router = mount({ pathname: "/swap/protected", state: { campaignId: "0x" + "77".repeat(32) } });
    await waitFor(() => expect(router.state.location.pathname).toBe("/swap"));
    cleanup();
    prefs().update({ experience: "advanced" });
    router = mount("/swap/protected");
    await screen.findByTestId("swap");
    expect(router.state.location.pathname).toBe("/swap/protected");
  });
});

describe("V7 Stage 13: protected steps only when staged or asked (spec v3.0 §4)", () => {
  it("asked under Advanced (Protected steps): the Review names the steps, the hold starts them — varied pieces under the quarter, one in flight, amounts only, Return the rest", async () => {
    world.protection = bandPlan;
    settings.set({ protection: { ...settings.get().protection, stepsAtBand: true } });
    await wallet();
    const router = mount();
    await typeAndReview("32");
    expect(screen.getByTestId("review-large-order").textContent).toMatch(/Protected steps: \d+ pieces of varied size, one at a time/);
    expect(screen.queryByTestId("review-confirm"), "never a tap from $50K").toBeNull();
    await holdToConfirm();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/steps\/0x[0-9a-f]{64}$/));
    expect(session.journal().swaps, "no single order: the steps are the campaign's").toHaveLength(0);
    const [c] = campaignsOf(session.journal());
    expect(c.tier).toBe("large-protected");
    const total = BigInt(c.request.amount);
    const pieces = c.tranches.map((x) => BigInt(x.amount));
    expect(pieces.length).toBeGreaterThanOrEqual(4);
    expect(pieces.reduce((s, x) => s + x, 0n)).toBe(total);
    for (const x of pieces) expect(x <= total / 4n, `${x} under the quarter`).toBe(true);
    expect(new Set(pieces.map(String)).size, "varied sizes, never identical quarters").toBeGreaterThan(1);
    for (let i = 1; i < pieces.length - 1; i++) expect(pieces[i], `piece ${i} differs from its neighbour`).not.toBe(pieces[i - 1]);
    expect(c.plan.exact, "the V5 exact quarters are withdrawn").toBeUndefined();
    expect(exposure(c).cap, "a quarter in flight at most").toBe(total / 4n);
    expect(total <= 32n * ETH, "the steps' own fees stay inside what was typed").toBe(true);
    // its Activity line names what may leave the protected balance: the 32 ETH typed, the steps' fee notes included (audit round 2, r18)
    expect(session.journal().activity?.find((x) => x.id === `campaign:${c.id.toLowerCase()}`)?.amount).toBe((32n * ETH).toString());
    expect(protectedInFlight(), "the campaign is the band's one operation in flight").toBe(1);
    // the progress: amounts, never step counts
    const large = await screen.findByTestId("progress-large");
    expect(large.textContent).toContain("$80,000.00");
    expect(large.textContent).toContain("ETH → BTC");
    for (const words of ["Completed", "Executing", "Remaining"]) expect(large.textContent).toContain(words);
    expect(screen.getByTestId("swap-steps").textContent).not.toMatch(/Step \d|Tranche|of ~?\d/);
    // Return the rest: the planned steps are skipped and the rest stays in the protected balance
    await act(async () => {
      fireEvent.click(screen.getByTestId("swap-steps-return"));
    });
    expect(campaignById(c.id, session)?.state).toBe("winding-down");
    expect(campaignById(c.id, session)?.tranches.every((x) => x.state === "skipped")).toBe(true);
    expect(screen.getByTestId("swap-steps-note").textContent).toMatch(/Returning the rest/);
    // cancelled with a step delivered: part of the swap is complete, never "Returned" alone (the audit's unverified m58)
    const back = campaignById(c.id, session)!;
    await act(async () => {
      putCampaign({ ...back, state: "cancelled", tranches: back.tranches.map((x, i) => (i === 0 ? { ...x, state: "settled" as const } : x)) }, session);
    });
    expect((await screen.findByTestId("swap-steps-done")).textContent).toContain("Part of your ETH → BTC swap is complete.");
    expect(screen.getByTestId("swap-steps-done").textContent).not.toContain("Returned to your protected balance.");
  });

  it("staged by the service (a thin route): the steps run without asking; the Review says so", async () => {
    world.protection = stagedPlan;
    await wallet();
    const router = mount();
    await typeAndReview("32");
    expect(screen.getByTestId("review-large-order").textContent).toMatch(/Protected steps: \d+ pieces/);
    await holdToConfirm();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/steps\/0x[0-9a-f]{64}$/));
    expect(campaignsOf(session.journal())).toHaveLength(1);
    expect(session.journal().swaps).toHaveLength(0);
  });
  it("the steps carry the Review's terms: the relayer's minimum and percentage the Review showed bound every step's funding (spec v3.0 §3; the review round of 2026-11-02)", async () => {
    world.protection = stagedPlan;
    world.relayerInfo = { minFeeWei: (2n * 10n ** 15n).toString(), feePercentBps: 100 };
    await wallet();
    const router = mount();
    await typeAndReview("32");
    await holdToConfirm();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/steps\/0x[0-9a-f]{64}$/));
    const [c] = campaignsOf(session.journal());
    expect(c.bounds.relayerFeeBps).toBe(100);
    expect(c.bounds.maxRelayerFee).toMatch(/^\d+$/);
    expect(BigInt(c.bounds.maxRelayerFee!) >= 2n * 10n ** 15n, "at least the minimum the Review showed").toBe(true);
  });

  it("after the hold, Back never shows the confirmed Review again: one campaign, never a second from the same quote (audit round 2, r15)", async () => {
    world.protection = stagedPlan;
    await wallet();
    const router = mount();
    await typeAndReview("32");
    await holdToConfirm();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/steps\/0x[0-9a-f]{64}$/));
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname, "the steps page replaced the Review in the history").toBe("/swap");
    expect(screen.queryByTestId("hold-to-confirm")).toBeNull();
    expect(campaignsOf(session.journal())).toHaveLength(1);
  });

  it("paused with a step funded: that step is said to be held for its swap, not in the protected balance (the audit round of 2026-10-16, c51)", async () => {
    world.protection = stagedPlan;
    await wallet();
    const router = mount();
    await typeAndReview("32");
    await holdToConfirm();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/steps\/0x[0-9a-f]{64}$/));
    const [c] = campaignsOf(session.journal());
    const now = Date.now();
    const paused = (funded: boolean) => {
      const x = funded ? withTrancheState(c, 0, "funded", now, { orderId: "0x" + "ab".repeat(32) }) : c;
      return withCampaignState(x, "paused", now, "paused", { pause: { reason: "price-deviation", detail: "The market moved.", at: now } });
    };
    act(() => putCampaign(paused(false), session));
    expect((await screen.findByTestId("swap-steps-safe")).textContent).toBe(
      "Your funds are safe: what has not been handed over stays in your protected balance.",
    );
    act(() => putCampaign(paused(true), session));
    await waitFor(() =>
      expect(screen.getByTestId("swap-steps-safe").textContent).toMatch(
        /a step already funded is held for its swap and returns to your protected balance after its refund time/,
      ),
    );
  });

  it("a pause reads in the catalog's words, the runner's own detail under Advanced; a funding not yet confirmed never reads as safe (audit round 2, n87, p05)", async () => {
    world.protection = stagedPlan;
    await wallet();
    const router = mount();
    await typeAndReview("32");
    await holdToConfirm();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/steps\/0x[0-9a-f]{64}$/));
    const [c] = campaignsOf(session.journal());
    const now = Date.now();
    const pausedFor = (reason: "price-deviation" | "reconcile", detail: string) =>
      withCampaignState(c, "paused", now, "paused", { pause: { reason, detail, at: now } });
    const title = () => screen.getByTestId("swap-steps-paused").querySelector("h2")!.textContent;
    act(() => putCampaign(pausedFor("price-deviation", "The market moved."), session));
    await screen.findByTestId("swap-steps-paused");
    expect(title()).toBe("Paused: the price moved");
    expect(screen.getByTestId("swap-steps-reason").textContent).toBe(t("op.error.price_deviation.reason"));
    expect(screen.queryByText("The market moved."), "the runner's own words: Advanced only").toBeNull();
    // a funding sent and not confirmed (a reconcile pause): where the funds are is being checked — never "safe"
    act(() => putCampaign(pausedFor("reconcile", "The funding of step 1 was sent and is not confirmed yet."), session));
    await waitFor(() => expect(screen.getByTestId("swap-steps-safe").textContent).toBe("We are checking where your funds are."));
    expect(title()).toBe("Reconciling");
    // in Korean: the catalog's Korean, no English line
    await loadCatalog("ko");
    act(() => setLocale("ko"));
    try {
      await waitFor(() => expect(title()).toBe(t("op.error.reconcile.title", undefined, "ko")));
      expect(screen.getByTestId("swap-steps-reason").textContent).toBe(t("op.error.reconcile.reason", undefined, "ko"));
      expect(screen.getByTestId("swap-steps-safe").textContent).toBe(t("op.funds.unknown", undefined, "ko"));
    } finally {
      act(() => setLocale("en"));
    }
    // Advanced: the runner's detail too
    act(() => settings.set({ advanced: true }));
    try {
      expect((await screen.findByTestId("swap-steps-detail")).textContent).toBe("The funding of step 1 was sent and is not confirmed yet.");
    } finally {
      settings.reset();
    }
  });

  it("the quote follows the band: one fetched at the fail-safe band before the prices load is fetched again at the band they give (the audit's unverified m57)", async () => {
    world.protection = bandPlan;
    world.feedDown = true;
    await session.create("a strong password");
    session.acknowledgePhrase();
    noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 40n * ETH, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    priceStore.reset();
    const from = requests.length;
    const quoted = () =>
      requests
        .slice(from)
        .filter((r) => r.url.endsWith("/v1/quotes"))
        .map((r) => (JSON.parse(r.body!) as { tier?: string }).tier);
    mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
    await waitFor(() => expect(quoted().length).toBeGreaterThan(0), { timeout: 15_000 });
    expect(quoted().at(-1), "no price: the fail-safe band").toBe("high-value");
    world.feedDown = false;
    await act(async () => {
      await priceStore.refresh(deployment, { force: true });
    });
    await waitFor(() => expect(quoted().at(-1), "quoted again at the band of the price").toBe("large-protected"), { timeout: 15_000 });
  });

  it("below the band ($20K–$50K) the swap stays one order — the strict quote from the Medium band (spec v2.0 §2)", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    const quote = { expiresAt: Math.floor(now / 1000) + STRICT_QUOTE_TTL_SECONDS - 1, toAmount: "100", toAmountMin: "99", impactBps: 0 } as ServiceQuote;
    const facts = {
      now,
      quotedAt: now - 1000,
      quote,
      approvedMin: 99n,
      destinationValid: true,
      providerHealthy: true,
      chainId: 1,
      crossChain: true,
      largeTrade: false,
    };
    expect(confirmBlockers({ ...facts, strictQuote: true }), "less than a minute left: as good as expired").toEqual(["quote_expired"]);
    expect(confirmBlockers({ ...facts, strictQuote: false })).toEqual([]);
    expect(confirmBlockers({ ...facts, strictQuote: true, quote: { ...quote, expiresAt: quote.expiresAt + 2 } })).toEqual([]);
  });
});

describe("the pure pieces", () => {
  it("the steps amount: the steps' own fees stay inside what was typed, in whole steps", () => {
    const terms = { minimum: 4_100_000n, feePercentBps: 100 };
    for (const units of [80_000_000_000n, 80_000_000_003n, 50_000_000_001n, 99_999_999_999n]) {
      const amount = protectedStepsAmount(units, terms, 4);
      expect(amount % 4n).toBe(0n);
      // each step funds a quarter of the amount and pays its fee note on top (the exact output of its withdrawal)
      const spent = 4n * (amount / 4n) + 4n * (swapFunding(units / 4n, terms).privacy + swapFunding(units / 4n, terms).network);
      expect(spent <= units, `${units}: ${spent}`).toBe(true);
      expect(units - amount < units / 50n, "about 1 % plus four relayer fees, no more").toBe(true);
    }
    expect(protectedStepsAmount(80_000_000_003n, null, 4), "no fee note: a whole number of steps").toBe(80_000_000_000n);
  });
  it("the steps amount keeps room for each step's fee note priced when it is funded, hours later: a tenth more than the Review's F (audit round 2, r11)", () => {
    const terms = { minimum: 4_100_000n, feePercentBps: 100 };
    const later = { ...terms, minimum: (terms.minimum * 11n) / 10n }; // the relayer's F a tenth up by the time the steps are funded
    for (const units of [80_000_000_000n, 99_999_999_999n, 10_000_000_000_000n]) {
      const step = protectedStepsAmount(units, terms, 4) / 4n;
      expect(4n * (step + feeForWithdrawal(step, later)) <= units, `${units}: the last step is still fundable`).toBe(true);
    }
  });
  it("the steps amount at its own count: a lower amount that makes more steps pays a fee note for each (the audit round of 2026-10-16, c50)", () => {
    const terms = { minimum: 10n ** 15n, feePercentBps: 0 };
    // 100 steps of 4 ETH for 400 ETH; anything less makes steps of 2 ETH (the band under the 4 ETH bucket)
    const countFor = (amount: bigint) => (amount >= 400n * ETH ? 100 : Number((amount + 2n * ETH - 1n) / (2n * ETH)));
    const { n, amount } = stepsAmountAtFixedPoint(400n * ETH, terms, countFor);
    expect(n, "the count of the steps' own amount").toBe(countFor(amount));
    expect(amount + BigInt(n) * terms.minimum <= 400n * ETH, "the steps and a fee note each stay inside what was typed").toBe(true);
    expect(protectedStepsAmount(400n * ETH, terms, 100) + 200n * terms.minimum > 400n * ETH, "sized for the first count alone it would not").toBe(true);
  });
  it("the progress of a protected execution: amounts that add up, the step in hand, never a count", () => {
    const pieces = [20n, 20n, 20n, 20n].map((x) => x * ETH);
    const base = {
      id: "c",
      state: "running",
      request: { from: { symbol: "ETH", decimals: 18 }, to: { symbol: "BTC", decimals: 8 }, amount: (80n * ETH).toString() },
      bounds: { maxExternalExposure: (20n * ETH).toString() },
      plan: { capBps: 2500, maxParallel: 1, concurrency: "sequential", providerShareCapBps: 10000 },
      tranches: pieces.map((amount, index) => ({ index, amount: amount.toString(), state: "planned", history: [] })),
      value: { usd: 80_000, at: 0 },
    } as unknown as Campaign;
    let m = campaignProgressModel(base);
    expect(m.large).toMatchObject({
      title: "ETH → BTC",
      totalUsdCents: 8_000_000n,
      completedUsdCents: 0n,
      executingUsdCents: 0n,
      remainingUsdCents: 8_000_000n,
    });
    const c1 = withTrancheState(withTrancheState(base, 0, "settled", 1), 1, "executing", 2);
    m = campaignProgressModel(c1);
    expect(m.large).toMatchObject({ completedUsdCents: 2_000_000n, executingUsdCents: 2_000_000n, remainingUsdCents: 4_000_000n });
    expect(m.steps.map((s) => s.state)).toEqual(["done", "done", "done", "active"]);
    expect(campaignProgressModel({ ...c1, state: "completed" } as Campaign).steps.every((s) => s.state === "done")).toBe(true);
    expect(campaignProgressModel({ ...base, value: undefined } as Campaign).large, "no valuation: the lines alone").toBeNull();
  });
});
