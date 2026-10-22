// @vitest-environment happy-dom
// V6 Stage 13 (spec v2.0 §2, §7.6–§7.7, §13.5; doc §49–§50, §87): from $50K the protection is automatic — an $80,000 ETH
// → BTC swap on the V6 screens: no "Protect this order" checkbox and no mode to choose, the Review's Protected execution
// card with its four checks and Hold to Confirm, then ONE confirmation starts the protected steps (the band's sequential
// quarters, funded so that the steps' own fees stay inside what the user typed) and /swap/steps/:id shows amounts only —
// "$80,000.00 ETH → BTC / Completed / Executing / Remaining" — with "Return the rest". The pure pieces too: the progress
// in amounts, the fee-inclusive steps amount, the strict quote from the Medium band.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { exposure, withTrancheState, type Campaign, withCampaignState } from "@privacy-wallet/protocol/wallet/campaign";
import { feeForWithdrawal, swapFunding } from "@privacy-wallet/protocol/wallet/fees";
import type { Protection, ServiceQuote } from "@privacy-wallet/sdk/swapService";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { campaignById, campaignsOf, putCampaign } from "@privacy-wallet/sdk/wallet/campaigns";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { campaignProgressModel } from "../src/features/progress/model";
import { confirmBlockers, protectedStepsAmount, stepsAmountAtFixedPoint, STRICT_QUOTE_TTL_SECONDS } from "../src/features/swap/model";
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
});

const ETH = 10n ** 18n;
/** The engine's recommendation at the $50K band (spec v2.0 §13.5): four sequential quarters, one in flight. */
const bandPlan: Protection = {
  provider: "thorchain",
  riskClass: "R3",
  flags: [],
  custody: "tss-vaults",
  bandBps: [2500, 2500],
  capBps: 2500,
  sizing: "bucket",
  concurrency: "sequential",
  maxParallel: 1,
  gate: "destination-final",
  cadenceSeconds: [60, 300],
  providerShareCapBps: 10000,
  executeWindowSeconds: 1800,
  estimatedTranches: 4,
  estimatedSeconds: 3600,
  trancheUsd: [20_000, 20_000],
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

async function wallet() {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 40n * ETH, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
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

describe("V6 Stage 13: large trades are protected automatically (spec v2.0 §2, §7.6)", () => {
  it("after the hold, Back never shows the confirmed Review again: one campaign, never a second from the same quote (audit round 2, r15)", async () => {
    world.protection = bandPlan;
    await wallet();
    const router = mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
    fireEvent.click(screen.getByTestId("swap-review"));
    await screen.findByTestId("review-view");
    const hold = screen.getByTestId("hold-to-confirm") as HTMLButtonElement;
    await act(async () => {
      hold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/steps\/0x[0-9a-f]{64}$/));
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.pathname, "the steps page replaced the Review in the history").toBe("/swap");
    expect(screen.queryByTestId("hold-to-confirm")).toBeNull();
    expect(campaignsOf(session.journal())).toHaveLength(1);
  });

  it("$80,000: the Protected execution checks and the hold, one confirmation, then the steps in amounts only", async () => {
    world.protection = bandPlan;
    await wallet();
    const router = mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
    expect(screen.queryByTestId("protect-this-order"), "no checkbox: the protection is automatic").toBeNull();
    expect(screen.queryByText(/Protection mode|Max privacy|Max safety/i), "no mode to choose in Simple").toBeNull();
    fireEvent.click(screen.getByTestId("swap-review"));
    // the V6 Review (not the V5 protected screen): the four checks and Hold to Confirm
    const review = await screen.findByTestId("review-view");
    for (const words of ["Protected execution", "Destination verified", "Quote locked", "Route health checked", "Execution limits enabled"])
      expect(review.textContent).toContain(words);
    expect(screen.queryByTestId("review-confirm"), "never a tap from $50K").toBeNull();
    const hold = screen.getByTestId("hold-to-confirm") as HTMLButtonElement;
    await act(async () => {
      hold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/swap\/steps\/0x[0-9a-f]{64}$/));
    expect(session.journal().swaps, "no single order: the steps are the campaign's").toHaveLength(0);
    const [c] = campaignsOf(session.journal());
    expect(c.tier).toBe("large-protected");
    expect(
      c.tranches.map((t) => BigInt(t.amount)),
      "four equal quarters",
    ).toEqual(Array(4).fill(BigInt(c.request.amount) / 4n));
    expect(BigInt(c.request.amount) <= 32n * ETH && BigInt(c.request.amount) % 4n === 0n).toBe(true);
    expect(exposure(c).cap, "one quarter in flight at most").toBe(BigInt(c.request.amount) / 4n);
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
    expect(campaignById(c.id, session)?.tranches.every((t) => t.state === "skipped")).toBe(true);
    expect(screen.getByTestId("swap-steps-note").textContent).toMatch(/Returning the rest/);
    // cancelled with a step delivered: part of the swap is complete, never "Returned" alone (the audit's unverified m58)
    const back = campaignById(c.id, session)!;
    await act(async () => {
      putCampaign({ ...back, state: "cancelled", tranches: back.tranches.map((x, i) => (i === 0 ? { ...x, state: "settled" as const } : x)) }, session);
    });
    expect((await screen.findByTestId("swap-steps-done")).textContent).toContain("Part of your ETH → BTC swap is complete.");
    expect(screen.getByTestId("swap-steps-done").textContent).not.toContain("Returned to your protected balance.");
  });

  it("paused with a step funded: that step is said to be held for its swap, not in the protected balance (the audit round of 2026-10-16, c51)", async () => {
    world.protection = bandPlan;
    await wallet();
    const router = mount();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "32" } });
    await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), { timeout: 15_000 });
    fireEvent.click(screen.getByTestId("swap-review"));
    await screen.findByTestId("review-view");
    const hold = screen.getByTestId("hold-to-confirm") as HTMLButtonElement;
    await act(async () => {
      hold.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
    });
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
