// @vitest-environment happy-dom
// Home (spec §3.3): money first, then the actions, then what is happening now, then the recent activity; the
// Protect card while the balance is empty, the asset rows once it is not; every action is a route; nothing is read
// from the network at first launch.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { prefs } from "../src/storage/prefs";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { renderApp } from "./helpers/render";

const fetchSpy = vi.fn(async () => new Response("{}", { status: 404 }));
beforeAll(() => { globalThis.fetch = fetchSpy as unknown as typeof fetch; });
afterEach(() => { session.forget(); settings.reset(); prefs().reset(); connection.reset(); noteStore.clear(); fetchSpy.mockClear(); });

const ETH_VAULT = "0x000000000000000000000000000000000000aaaa" as const;
const deployment: Deployment = { chainId: 31337, core: "0x000000000000000000000000000000000000cccc", ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [] };

async function unlocked() { await session.create("a strong password"); session.acknowledgePhrase(); }

describe("Home (spec §3.3)", () => {
  it("an empty balance: the dash, the Protect card, the two actions and the rows below are routes", async () => {
    await unlocked();
    const { pathname } = await renderApp("/", { deployment });
    await screen.findByTestId("home");
    expect(screen.getByTestId("private-usd").textContent).toBe("—");
    expect(document.body.textContent).toContain("Protected balance");
    expect(screen.getByTestId("protect-card")).toHaveTextContent("Protect your assets");
    expect(screen.queryByTestId("assets")).toBeNull();
    expect(screen.queryByTestId("add-funds"), "the row appears once there is a balance").toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByTestId("send-tab");
    expect(pathname()).toBe("/send");
    fireEvent.click(screen.getByTestId("back"));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByTestId("receive"));
    await screen.findByTestId("sheet-receive");
    expect(pathname()).toBe("/receive");
    fireEvent.click(screen.getByTestId("back"));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByTestId("protection-badge"));
    await screen.findByTestId("advanced"); // V5 Stage 10: More → Advanced on the design system
    expect(pathname()).toBe("/more/advanced");
    expect(fetchSpy, "nothing read for an empty balance").not.toHaveBeenCalled();
  });
  it("with notes and no price feeds: the asset row with its amount, the USD dash with the network sentence, the Add funds row", async () => {
    await unlocked();
    noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 15n * 10n ** 17n, ownerCommitment: 9n, noteSecret: 11n }, leafIndex: 3, noteData: "0x0102", counter: noteStore.allocateCounter(), spent: false, label: "shield" });
    await renderApp("/", { deployment });
    await screen.findByTestId("home");
    const rows = within(screen.getByTestId("assets")).getAllByTestId("asset-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("ETH");
    expect(rows[0]).toHaveTextContent("1.5");
    expect(screen.getByTestId("private-usd").textContent).toBe("—");
    expect(document.body.textContent).toContain("Balance in USD unavailable on this network");
    expect(screen.queryByTestId("protect-card")).toBeNull();
    expect(screen.getByTestId("add-funds")).toBeInTheDocument();
    expect(fetchSpy, "no price feeds configured: no read").not.toHaveBeenCalled();
  });
  it("the protection line names the mode; the recent activity shows the three newest rows and opens Activity", async () => {
    await unlocked();
    const { pathname } = await renderApp("/", { deployment });
    await screen.findByTestId("home");
    expect(screen.getByTestId("protection-badge")).toHaveTextContent("Protection: Balanced ✓");
    await act(async () => { settings.set({ protection: { ...settings.get().protection, enabled: false } }); });
    expect(screen.getByTestId("protection-badge")).toHaveTextContent("Protection: Off ⚠");
    await act(async () => {
      for (let i = 0; i < 4; i++) recordActivity({ id: `shield:0x${i}`, kind: "shield", asset: "ETH", decimals: 18, amount: (10n ** 18n).toString(), status: "completed", ref: `0x${i}`, at: 1_000_000 + i });
    });
    const recent = await screen.findAllByTestId("recent-row");
    expect(recent).toHaveLength(3);
    expect(recent[0]).toHaveTextContent("Added funds");
    expect(recent[0]).toHaveTextContent("1 ETH");
    expect(recent[0]).toHaveTextContent("Completed");
    fireEvent.click(recent[0]);
    expect(pathname()).toBe("/activity");
  });
});
