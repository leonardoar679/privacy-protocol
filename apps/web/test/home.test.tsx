// @vitest-environment happy-dom
// Home (spec v2.0 §7.1): how much, whether it is protected, what the user can do — the protection badge (opens the
// Privacy Center) and the gear (Security), the balance ($0 when nothing is protected), the asset rows in their display
// decimals, the Protect card as the one primary action and Send / Swap as two secondary tiles, an open operation's
// card (an old failure never raises one), the three newest activity lines opening their detail; nothing read from the
// network for an empty balance; the technical lines only in the Advanced experience.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { newOperation, putOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { prefs } from "../src/storage/prefs";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { renderApp } from "./helpers/render";

const fetchSpy = vi.fn(async () => new Response("{}", { status: 404 }));
beforeAll(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  session.forget();
  settings.reset();
  prefs().reset();
  connection.reset();
  noteStore.clear();
  resetOperationsMemory();
  fetchSpy.mockClear();
});

const ETH_VAULT = "0x000000000000000000000000000000000000aaaa" as const;
const deployment: Deployment = {
  chainId: 31337,
  core: "0x000000000000000000000000000000000000cccc",
  ethVault: ETH_VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
};

async function unlocked() {
  await session.create("a strong password");
  session.acknowledgePhrase();
}

describe("Home (spec v2.0 §7.1)", () => {
  it("nothing protected: $0, the Protect card as the one primary action, Send and Swap as tiles; the badge and the gear are routes; no read", async () => {
    await unlocked();
    const { pathname, router } = await renderApp("/", { deployment });
    await screen.findByTestId("home");
    expect(screen.getByTestId("private-usd").textContent).toBe("$0");
    expect(screen.getByTestId("balance")).toHaveTextContent("Protected balance");
    expect(screen.getByTestId("protect-card")).toHaveTextContent("Protect your assets");
    expect(screen.getByTestId("protect-card")).toHaveTextContent("Keep your activity more private");
    expect(screen.getByTestId("protect-cta")).toHaveAttribute("data-variant", "primary");
    expect(screen.getByTestId("home").querySelectorAll('[data-variant="primary"]'), "one primary action").toHaveLength(1);
    expect(screen.getByTestId("home-send")).toHaveAttribute("data-variant", "secondary");
    expect(screen.getByTestId("home-swap")).toHaveAttribute("data-variant", "secondary");
    expect(screen.queryByTestId("assets")).toBeNull();
    expect(screen.queryByTestId("operation-card")).toBeNull();
    expect(screen.queryByTestId("home-advanced"), "Simple: no technical lines").toBeNull();
    fireEvent.click(screen.getByTestId("home-send"));
    await screen.findByTestId("send-view");
    expect(pathname()).toBe("/send");
    fireEvent.click(screen.getByTestId("back"));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByTestId("privacy-badge"));
    // the screens behind these routes are lazy (V6 Stage 16): the location changes once their chunk has loaded
    await waitFor(() => expect(pathname()).toBe("/more/privacy"));
    await act(async () => {
      await router.navigate(-1);
    });
    await screen.findByTestId("home");
    fireEvent.click(screen.getByTestId("home-settings"));
    await waitFor(() => expect(pathname()).toBe("/more/security"));
    expect(fetchSpy, "nothing read for an empty balance").not.toHaveBeenCalled();
  });

  it("with notes and no price feeds: the asset row in its display decimals, the USD value unavailable, the Protect card still there", async () => {
    await unlocked();
    noteStore.add({
      note: { vaultId: BigInt(ETH_VAULT), amount: 15n * 10n ** 17n, ownerCommitment: 9n, noteSecret: 11n },
      leafIndex: 3,
      noteData: "0x0102",
      counter: noteStore.allocateCounter(),
      spent: false,
      label: "shield",
    });
    await renderApp("/", { deployment });
    await screen.findByTestId("home");
    const rows = within(screen.getByTestId("assets")).getAllByTestId("asset-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("ETH");
    expect(rows[0]).toHaveTextContent("1.5 ETH");
    expect(screen.getByTestId("private-usd").textContent).toBe("—");
    expect(screen.getByTestId("balance")).toHaveTextContent("The value in USD is unavailable right now.");
    expect(screen.getByTestId("protect-card")).toBeInTheDocument();
    // no price feeds configured: no price read (latestRoundData). A wallet holding notes may read the pool for its notes
    // (a V6 follow-up: note discovery), which values nothing; the empty first launch above reads nothing at all
    const bodies = fetchSpy.mock.calls.map((c) => String(((c as unknown[])[1] as RequestInit | undefined)?.body ?? ""));
    expect(
      bodies.filter((b) => b.includes("0xfeaf968c")),
      "no price feeds configured: no price read",
    ).toEqual([]);
  });

  it("an open operation raises one card (an old failure none); the three newest lines open their detail; Advanced adds the technical lines", async () => {
    await unlocked();
    const { pathname, router } = await renderApp("/", { deployment });
    await screen.findByTestId("home");
    await act(async () => {
      const live = newOperation(
        {
          kind: "swap",
          amounts: { asset: "ETH", decimals: 18, input: (2n * 10n ** 18n).toString(), outputAsset: "BTC", outputDecimals: 8 },
          destination: { kind: "entered", display: "bc1q", chain: "bitcoin" },
          tier: "standard",
          state: "SUBMITTED",
        },
        2_000_000,
      );
      putOperation(live, session);
      const old = newOperation(
        {
          kind: "send",
          amounts: { asset: "ETH", decimals: 18, input: "1" },
          destination: { kind: "fresh", display: "0x01", chain: "ethereum" },
          tier: "standard",
          state: "FAILED",
        },
        1_000_000,
      );
      putOperation(old, session);
      for (let i = 0; i < 4; i++)
        recordActivity({
          id: `shield:0x${i}`,
          kind: "shield",
          asset: "ETH",
          decimals: 18,
          amount: (10n ** 18n).toString(),
          status: "completed",
          ref: `0x${i}`,
          at: 1_000_000 + i,
        });
    });
    const cards = screen.getAllByTestId("operation-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Executing");
    expect(cards[0]).toHaveTextContent("ETH → BTC");
    expect(cards[0]).toHaveTextContent("View progress");
    const recent = await screen.findAllByTestId("recent-row");
    expect(recent).toHaveLength(3);
    expect(recent[0]).toHaveTextContent("Protected ETH");
    expect(recent[0]).toHaveTextContent("1 ETH");
    expect(recent[0]).toHaveTextContent("Completed");
    fireEvent.click(recent[0]);
    expect(pathname()).toBe(`/activity/${encodeURIComponent("shield:0x3")}`);
    await act(async () => {
      await router.navigate(-1);
    });
    await screen.findByTestId("home");
    await act(async () => {
      settings.set({ advanced: true });
    });
    expect(screen.getByTestId("home-advanced")).toBeInTheDocument();
  });
});
