// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), E11-10: a failure is said in the wallet's own words — the catalog's for a code it knows, in the
// reader's language — never in a service's, a provider's or the runner's text, which stays for Advanced, after those words: the Swap Review's
// commit and the quote; the guest screen, where a THORNode gateway or the swap service could otherwise put words of its choosing in front of a
// guest about to pay by hand; a protected execution's pause and alerts, and its pause notification.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { getAddress } from "viem";
import { buildMemo } from "@privacy-wallet/swap-engine/adapters/thorchain";
import { ApiError, ApiTimeout } from "@privacy-wallet/sdk/api/client";
import { swapService } from "@privacy-wallet/sdk/swapService";
import { thornodeGateways } from "@privacy-wallet/sdk/providerCall";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { withAlert } from "@privacy-wallet/sdk/wallet/alerts";
import { createCampaign, withCampaignState, type Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SwapScreen } from "../src/features/swap/SwapScreen";
import { Guest } from "../src/components/Guest";
import { CampaignProgress } from "../src/features/swap/protected/CampaignProgress";
import { shownWords } from "../src/app/notifications";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale } from "../src/app/i18n/messages";
import { en } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { prefs } from "../src/storage/prefs";
import { deployment, ETH_VAULT, fetchMock, resetWorld, world } from "./helpers/swapWorld";

// the commit's answer: what apiCall builds from the API's refusal, `new ApiError(status, code, error)` (apps/api routes/swap.ts)
const commit = vi.hoisted(() => ({ error: null as unknown }));
/** the note scan's action as the commit found it when it began (the twelfth review round, ZK's critique: the demand made before it) */
const engineSaw = vi.hoisted(() => ({ scan: undefined as { dueAt: number; heldFailures?: number } | null | undefined, at: 0 }));
vi.mock("@privacy-wallet/sdk/swapProvider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/swapProvider")>();
  return {
    ...orig,
    walletSwapProvider: () => ({
      prepare: async () => {
        const { session: s } = await import("@privacy-wallet/sdk/wallet/session");
        engineSaw.at = Date.now();
        engineSaw.scan = s.journal().schedule.find((a) => a.id === "discovery:pool" && !a.done) ?? null;
        throw commit.error;
      },
    }),
  };
});

beforeEach(() => {
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
  setLocale("en");
  vi.restoreAllMocks();
  commit.error = null;
});

const QUOTED = { timeout: 15_000 };
async function korean() {
  await loadCatalog("ko");
  setLocale("ko");
  prefs().update({ locale: "ko", localeChosen: true });
}
/** 1 ETH protected; at $2,500 a 0.5 ETH swap is a standard one (the V6 Review, one tap). */
async function wallet() {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
  await priceStore.refresh(deployment);
}
function mountSwap() {
  const router = createMemoryRouter([{ path: "/swap/*", element: <SwapScreen masterSeed={session.state().seed!} deployment={deployment} /> }], {
    initialEntries: ["/swap"],
    future: ROUTER_FUTURE,
  });
  render(
    <Providers deployment={deployment}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
}
/** The page → the Review → its one confirmation; the commit's refusal is `commit.error`. */
async function confirmRefused(): Promise<string> {
  mountSwap();
  fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
  await waitFor(() => expect(screen.getByTestId("swap-review")).toBeEnabled(), QUOTED);
  fireEvent.click(screen.getByTestId("swap-review"));
  await act(async () => {
    fireEvent.click(await screen.findByTestId("review-confirm"));
  });
  return (await screen.findByTestId("swap-status")).textContent ?? "";
}

describe("E11-10 (1): the Swap screens say a failure in the catalog's words", () => {
  it("a commit the service refused reads in the catalog's Korean for a Korean reader, never the service's English", async () => {
    await korean();
    await wallet();
    commit.error = new ApiError(400, "no_quote", "no quote from thorchain");
    const status = await confirmRefused();
    expect(status).toBe(ko["op.error.no_quote.reason"]);
    expect(status).not.toContain("no quote from thorchain");
  }, 60_000);

  it("under Advanced the service's own text follows the catalog's words, never in their place", async () => {
    await wallet();
    settings.set({ advanced: true });
    commit.error = new ApiError(400, "no_quote", "no quote from thorchain");
    expect(await confirmRefused()).toBe(`${en["op.error.no_quote.reason"]} (no quote from thorchain)`);
  }, 60_000);

  it("a quote the service refused reads in the catalog's words, one that failed otherwise in the swap's own — never the thrown English", async () => {
    await korean();
    await wallet();
    const quote = vi.spyOn(swapService, "quote").mockRejectedValue(new ApiError(400, "invalid_request", "slippageBps must be an integer between 1 and 500"));
    mountSwap();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-no-route").textContent).toBe(ko["op.error.invalid_request.reason"]), QUOTED);
    // the service did not answer in time (the wallet's own English, a code the catalog has no row for): the swap's own words
    quote.mockRejectedValue(new ApiTimeout(90_000));
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.4" } });
    await waitFor(() => expect(screen.getByTestId("swap-no-route").textContent).toBe(ko["screen.swap.quoteFailed"]), QUOTED);
    expect(document.body.textContent).not.toMatch(/slippageBps|did not answer within/);
  }, 60_000);
});

describe("before the commit, the codes of a later step read as the swap's own words (the critique of E11-10)", () => {
  // the API's 502 for a provider that did not answer (apps/api routes/swap.ts), and a request that reached no service at all
  const unanswered = () => [
    new ApiError(502, "provider_unavailable", "thorchain: upstream 502"),
    new TypeError("Failed to fetch"),
    new ApiError(500, "internal", "internal error"), // the API's own failure (its second critique)
  ];

  it("a quote: 'No quote could be fetched right now' — never 'The provider failed … the wallet tries again on its own', nor 'The transaction was secured'", async () => {
    await wallet();
    const quote = vi.spyOn(swapService, "quote");
    mountSwap();
    let amount = 0.5;
    for (const e of unanswered()) {
      quote.mockRejectedValue(e);
      amount -= 0.1;
      fireEvent.input(screen.getByTestId("amount-input"), { target: { value: amount.toFixed(1) } });
      await waitFor(() => expect(screen.getByTestId("swap-no-route").textContent).toBe(en["screen.swap.quoteFailed"]), QUOTED);
    }
  }, 60_000);

  it("the commit: 'The swap was not confirmed' — under Advanced the thrown text after it", async () => {
    await wallet();
    for (const e of unanswered()) {
      commit.error = e;
      expect(await confirmRefused()).toBe(en["screen.swap.notConfirmed"]);
      cleanup();
    }
    settings.set({ advanced: true });
    commit.error = new TypeError("Failed to fetch");
    expect(await confirmRefused()).toBe(`${en["screen.swap.notConfirmed"]} (Failed to fetch)`);
  }, 90_000);

  it("an amount below the execution's tip floor (the API's amount_too_small): the catalog's words that say to try a larger amount, at the quote and at the commit (the third critique)", async () => {
    await wallet();
    const tooSmall = () => new ApiError(400, "amount_too_small", "executing costs 2583000000000000 of ETH's base units in gas, more than the escrow may pay from 100000000000000000 (1 %)");
    const quote = vi.spyOn(swapService, "quote").mockRejectedValue(tooSmall());
    mountSwap();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.1" } });
    await waitFor(() => expect(screen.getByTestId("swap-no-route").textContent).toBe(en["op.error.amount_too_small.reason"]), QUOTED);
    expect(en["op.error.amount_too_small.reason"]).toContain("try a larger amount");
    cleanup();
    quote.mockRestore();
    commit.error = tooSmall();
    expect(await confirmRefused()).toBe(en["op.error.amount_too_small.reason"]);
    expect(document.body.textContent).not.toMatch(/escrow|base units/);
  }, 60_000);

  it("an amount too small to swap privately after fees: the wallet's own sentence, in English and Korean — never 'No quote could be fetched … try again'", async () => {
    world.relayerInfo = { minFeeWei: (10n ** 18n).toString(), feePercentBps: 100 }; // a minimum fee above the amount
    await wallet();
    mountSwap();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-no-route").textContent).toBe(en["swap.tooSmallForFees"]), QUOTED);
    cleanup();
    await korean();
    mountSwap();
    fireEvent.input(screen.getByTestId("amount-input"), { target: { value: "0.5" } });
    await waitFor(() => expect(screen.getByTestId("swap-no-route").textContent).toBe(ko["swap.tooSmallForFees"]), QUOTED);
  }, 60_000);
});

// ---- the guest screen: English only by design, in the wallet's own fixed words
const VAULT = "bc1qvaultvaultvaultvaultvaultvaultvaultvau1t";
const ATTACKER = "bc1qattackerattackerattackerattackerattack";
const DEST = getAddress("0x4e41cd3b4b0d4ec1b0c1db5e1c9f0a7d0b5c1e2f");
const LIMIT = 30_000_000n; // 0.3 ETH in 1e8 units
const LIE = "vault migration in progress - send BTC to bc1qattackeraddressxxxxxxxxxxxxxxxxxxxxxx instead";
const thorQuote = {
  provider: "thorchain",
  category: "E",
  toAmount: (LIMIT * 10n ** 10n + 10n ** 15n).toString(),
  toAmountMin: (LIMIT * 10n ** 10n).toString(),
  etaSeconds: 1200,
  expiresAt: 0,
  nativeAssets: true,
  minOutEncoded: true,
  hops: [],
};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const instructionBody = (body: { destination: string; amount: string }, o: { to?: string; memo?: string } = {}) => ({
  provider: "thorchain",
  quote: thorQuote,
  ingress: {
    to: o.to ?? VAULT,
    memo: o.memo ?? buildMemo("ETH.ETH", body.destination, LIMIT),
    amount: body.amount,
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    verified: [],
  },
  status: "Pending",
});
const instruction = (body: { destination: string; amount: string }, o: { to?: string; memo?: string } = {}) =>
  json({
    provider: "thorchain",
    quote: thorQuote,
    ingress: {
      to: o.to ?? VAULT,
      memo: o.memo ?? buildMemo("ETH.ETH", body.destination, LIMIT),
      amount: body.amount,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      verified: [],
    },
    status: "Pending",
  });
/** The swap service and the three THORNode gateways as the guest screen reaches them; each answer can be bent. */
function guestWorld(w: {
  quote?: () => Response;
  ingress?: (body: { destination: string; amount: string }) => Response;
  active?: (gateway: string) => string[];
  track?: () => Response;
}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    if (path.endsWith("/thorchain/inbound_addresses")) return json([{ chain: "BTC", address: VAULT, router: "", halted: false }]);
    if (path.endsWith("/thorchain/vaults/asgard")) {
      const gateway = thornodeGateways().find((g) => url.startsWith(g + "/")) ?? "";
      return json([{ status: "ActiveVault", addresses: (w.active?.(gateway) ?? [VAULT]).map((address) => ({ chain: "BTC", address })) }]);
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/guest/quote") return w.quote?.() ?? json({ quotes: [thorQuote], scores: [], errors: {} });
    if (path === "/v1/guest/ingress") return w.ingress?.(body) ?? instruction(body);
    if (path.startsWith("/v1/guest/track/")) return w.track?.() ?? json({ status: "Pending" });
    return json({ error: `unexpected ${path}` }, 404);
  }) as unknown as typeof fetch;
}
async function quoted() {
  render(
    <Providers deployment={null}>
      <Guest onBack={() => {}} />
    </Providers>,
  );
  fireEvent.input(screen.getAllByRole("textbox")[1], { target: { value: DEST } });
  await act(async () => {
    fireEvent.click(screen.getByText("Get a quote"));
  });
}
async function askInstruction() {
  await quoted();
  await act(async () => {
    fireEvent.click(await screen.findByText("Show my deposit instruction"));
  });
}

describe("the twelfth review round, W6 §5: the swap's one confirmation asks for a scan the counters wait on", () => {
  it("the counters waiting on a scan that keeps failing: the confirmation asks for it at once, its failures counted afresh", async () => {
    await wallet();
    commit.error = new Error("the service is down");
    scheduleAction({ kind: "discovery", orderId: "pool", dueAt: Date.now() + 4 * 60_000, heldFailures: 3 }, session);
    noteStore.holdCounters();
    try {
      const before = Date.now();
      await confirmRefused();
      expect(engineSaw.scan, "asked for before the commit took its refund counter").toBeTruthy();
      expect(engineSaw.scan!.dueAt).toBeLessThanOrEqual(engineSaw.at);
      expect(engineSaw.scan!.heldFailures ?? 0).toBe(0);
      const scan = session.journal().schedule.find((a) => a.id === "discovery:pool" && !a.done);
      expect(scan!.dueAt, "due at the confirmation").toBeGreaterThanOrEqual(before);
      expect(scan!.dueAt).toBeLessThanOrEqual(Date.now());
      expect(scan!.heldFailures ?? 0, "its failures counted afresh").toBe(0);
    } finally {
      noteStore.releaseCounters(0);
    }
  });
});

describe("E11-10 (2): the guest screen says a refusal in its own fixed words, never a service's or a gateway's", () => {
  it("THORChain's quote error — the first gateway to answer decides it — never reaches the screen", async () => {
    guestWorld({ quote: () => json({ quotes: [], scores: [], errors: { thorchain: `THORChain quote: ${LIE}` } }) });
    await quoted();
    const line = await screen.findByText(/No verifiable deposit route right now/);
    expect(line.textContent).toBe("No verifiable deposit route right now: THORChain gave no quote for this swap. Try again later, or with another amount.");
    expect(document.body.textContent).not.toContain("bc1qattacker");
  });

  it("the swap service's 502, the provider's words inside, reads as the screen's own sentence", async () => {
    guestWorld({ ingress: () => json({ error: `THORChain quote: ${LIE}`, code: "provider_unavailable" }, 502) });
    await askInstruction();
    expect(await screen.findByText("THORChain gave no deposit instruction for this swap right now. Try again later, or with another amount.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("bc1qattacker");
  });

  it("a refused instruction names its field in the screen's words, never the service's memo", async () => {
    guestWorld({ ingress: (body) => instruction(body, { memo: "send BTC to bc1qattacker instead" }) });
    await askInstruction();
    expect(
      await screen.findByText(
        "The deposit instruction does not match what you asked for: its memo is not one this browser can read and check. It is not shown.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("bc1qattacker");
    expect(screen.queryByTestId("guest-checked"), "nothing to pay").toBeNull();
  });

  it("an address the service named that one gateway lists and the others do not is never repeated", async () => {
    guestWorld({
      ingress: (body) => instruction(body, { to: ATTACKER }),
      active: (gateway) => (gateway === thornodeGateways()[0] ? [VAULT, ATTACKER] : [VAULT]),
    });
    await askInstruction();
    expect(await screen.findByText(/^THORChain's deposit address cannot be confirmed right now/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("bc1qattacker");
    expect(screen.queryByTestId("guest-checked")).toBeNull();
  });

  it("the instruction's own status, before any transaction is typed, is held to the plan's words too (the third critique)", async () => {
    guestWorld({ ingress: (body) => json({ ...JSON.parse(JSON.stringify(instructionBody(body))), status: "Failed: the deposit was lost, send it again to bc1qattacker" }) });
    await askInstruction();
    await screen.findByTestId("guest-checked");
    expect(screen.getByText(/^Status:/).textContent).toContain("Status: Pending");
    expect(document.body.textContent).not.toContain("bc1qattacker");
  });

  it("a status of the plan is shown as it is: a refunded guest reads Refunded (the third critique)", async () => {
    guestWorld({ track: () => json({ status: "Refunded" }) });
    await askInstruction();
    await screen.findByTestId("guest-checked");
    fireEvent.input(screen.getAllByRole("textbox")[2], { target: { value: "ab".repeat(32) } });
    await waitFor(() => expect(screen.getByText(/^Status:/).textContent).toContain("Status: Refunded"));
  });

  it("a refusal with another code reads as the screen's own sentence: an internal error, an amount too small (the third critique)", async () => {
    guestWorld({ ingress: () => json({ error: LIE, code: "internal" }, 500) });
    await askInstruction();
    expect(await screen.findByText("The swap service could not answer this request right now. Try again in a moment.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("bc1qattacker");
    cleanup();
    guestWorld({ ingress: () => json({ error: "executing costs more than the escrow may pay", code: "amount_too_small" }, 400) });
    await askInstruction();
    expect(await screen.findByText("This amount is too small for this swap. Try a larger amount.")).toBeTruthy();
  });

  it("a track's status outside the plan's words reads as Pending, never as the service wrote it", async () => {
    let tracked = 0;
    guestWorld({
      track: () => {
        tracked++;
        return json({ status: "Failed: the deposit was lost, send it again to bc1qattacker" });
      },
    });
    await askInstruction();
    await screen.findByTestId("guest-checked");
    fireEvent.input(screen.getAllByRole("textbox")[2], { target: { value: "ab".repeat(32) } });
    await waitFor(() => expect(tracked).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText(/^Status:/).textContent).toContain("Status: Pending");
    expect(document.body.textContent).not.toContain("bc1qattacker");
  });
});

// ---- a protected execution's pause, its alerts and its notification
const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
const eth = (n: number) => BigInt(n) * 10n ** 18n;
// the runner's own words for the pause and its alert (campaignRunner.ts undeliveredWords; the executor's failure alert)
const DETAIL =
  "Step 1: the provider could not deliver and refunded at its fresh destination address, in its own refund asset; nothing came back to your private balance. The next step is not sent to the same route on its own: resume to carry on, or return the rest.";
const ALERT_TEXT = "The executor or the provider reported a failure on the current step.";
/** $80,000 ETH → BTC in four steps; step 1 ended undelivered (refunded at its destination address), the execution paused on it. */
function pausedOnUndelivered(): Campaign {
  const t0 = Date.now() - 600_000;
  let c: Campaign = createCampaign({
    id: "0x" + "e1".repeat(32),
    now: t0,
    mode: "balanced",
    tier: "large-protected",
    request: { from: ETH, to: BTC, amount: eth(32).toString(), preference: "balanced" },
    bounds: {
      orderId: "0x" + "e1".repeat(32),
      assetIn: ETH,
      chainIn: "ethereum",
      amountInLimit: eth(32).toString(),
      assetOut: BTC,
      chainOut: "bitcoin",
      destination: { kind: "fresh-per-tranche" },
      minimumOutput: "1",
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
    referenceRateE18: 1n,
  } as never);
  c = {
    ...c,
    provider: "thorchain",
    tranches: c.tranches.map((x, i) => (i === 0 ? { ...x, state: "undelivered", outcome: { undelivered: "refunded-at-destination" } } : x)),
  } as Campaign;
  c = withCampaignState(c, "paused", t0 + 5000, "paused", { pause: { reason: "provider-error", detail: DETAIL, at: t0 + 5000 } } as never);
  return withAlert(c, "provider-degraded", ALERT_TEXT, t0 + 5000, 0);
}
const progress = (c: Campaign, advanced?: boolean) =>
  render(
    <Providers deployment={null}>
      <CampaignProgress campaign={c} advanced={advanced} onPause={() => {}} onResume={() => {}} onCancel={() => {}} />
    </Providers>,
  );

describe("E11-10 (3): a protected execution's pause and alerts by their kinds; the runner's English under Advanced only", () => {
  it("in Korean: the kind's title, the pause's reason, where the undelivered step went — none of the runner's or the SDK's English", async () => {
    await korean();
    const c = pausedOnUndelivered();
    progress(c);
    const pause = screen.getByTestId("campaign-pause").textContent ?? "";
    expect(pause).toContain(ko["campaign.pausedTitle"].replace("{title}", ko["campaign.alert.provider-degraded"]));
    expect(screen.getByTestId("campaign-pause-reason").textContent).toBe(ko["op.error.provider_error.reason"]);
    expect(screen.getByTestId("campaign-pause-undelivered").textContent).toBe(ko["campaign.undelivered.refunded-at-destination"]);
    expect(pause).not.toMatch(/Provider degraded|could not deliver/);
    expect(screen.queryByTestId("campaign-pause-detail")).toBeNull();
    const alerts = screen.getByTestId("campaign-alerts").textContent ?? "";
    expect(alerts).toContain(`${ko["campaign.alert.provider-degraded"]} (${ko["campaign.stepWord"].replace("{n}", "1")})`);
    expect(alerts).not.toMatch(/Provider degraded|reported a failure/);
    cleanup();
    // Advanced: the runner's own sentences too, after the catalog's words
    progress(c, true);
    expect(screen.getByTestId("campaign-pause-reason").textContent).toBe(ko["op.error.provider_error.reason"]);
    expect(screen.getByTestId("campaign-pause-detail").textContent).toBe(DETAIL);
    expect(screen.getByTestId("campaign-alerts").textContent).toContain(`${ko["campaign.alert.provider-degraded"]} — ${ALERT_TEXT}`);
  });

  it("a pause's notification in Korean says its kind's words; the runner's own reason under Advanced only", async () => {
    await korean();
    const n = {
      id: "p1",
      at: 0,
      kind: "provider-degraded" as const,
      title: "Protected swap paused",
      body: DETAIL,
      campaignId: "c1",
      words: { key: "paused" as const },
    };
    expect(shownWords(n)).toEqual({ title: ko["notification.campaign.paused.title"], body: ko["op.error.provider_error.reason"] });
    expect(shownWords({ ...n, kind: "paused" }).body, "a kind with no reason of its own").toBe(ko["notification.campaign.paused.body"]);
    settings.set({ advanced: true });
    expect(shownWords(n).body).toBe(DETAIL);
  });
});
