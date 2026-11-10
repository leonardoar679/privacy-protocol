// @vitest-environment happy-dom
// The application shell (spec §2, §3.1, §6; v2.0 §6): the gate's redirects, the first-launch copy and the Simple
// default, the experience preference mirrored into the journal, the More menu and — from 1024 px — the Wallet menu with
// the same entries (doc §88), the lazy routes, the component preview in the dev and fixtures builds only, the Classic
// entry, Connect Wallet on the welcome screen, an unknown path back to Home.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";
import { prefs } from "../src/storage/prefs";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { renderApp } from "./helpers/render";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { activeTab } from "../src/platform/activeTab";

beforeAll(() => { globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch; });
afterEach(() => { session.forget(); settings.reset(); prefs().reset(); connection.reset(); delete (window as unknown as Record<string, unknown>).ethereum; });
const LAZY = { timeout: 15_000 };

async function unlockedWallet() { await session.create("a strong password"); session.acknowledgePhrase(); }

describe("the application shell (spec §2)", () => {
  it("a V6 follow-up: while another tab holds the wallet this one waits and says why (nothing behind the gate runs); then it opens", async () => {
    await unlockedWallet();
    act(() => activeTab.set("waiting"));
    try {
      await renderApp("/");
      expect((await screen.findByTestId("other-tab")).textContent).toContain("The wallet is open in another tab");
      expect(screen.queryByTestId("home")).toBeNull();
      act(() => activeTab.set("checking"));
      expect(screen.getByTestId("splash")).toBeInTheDocument();
      act(() => activeTab.set("active"));
      await screen.findByTestId("home", {}, LAZY);
    } finally {
      act(() => activeTab.set("active"));
    }
  });

  it("a V6 follow-up: an unlock looks for the wallet's notes in the pool; the first launch, request-free, does not", async () => {
    const deployment: Deployment = { chainId: 31337, core: "0x000000000000000000000000000000000000cccc", ethVault: "0x000000000000000000000000000000000000aaaa", rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [] };
    await unlockedWallet(); // created here: the first launch
    await renderApp("/", { deployment });
    await screen.findByTestId("home", {}, LAZY);
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); // the lazy Background mounts and its effects run
    expect(session.journal().schedule.filter((a) => a.kind === "discovery"), "the first launch stays request-free").toEqual([]);
    await act(async () => { session.lock(); });
    await act(async () => { expect(await session.unlock("a strong password")).toBe(true); });
    await waitFor(() => expect(session.journal().schedule.some((a) => a.kind === "discovery")).toBe(true), LAZY);
    // a scan failing in a row, backed off: the next unlock starts its count again, the scan due at once (the twelfth review round, W6 §5)
    await act(async () => { scheduleAction({ kind: "discovery", orderId: "pool", dueAt: Date.now() + 4 * 60_000, heldFailures: 3 }, session); });
    await act(async () => { session.lock(); });
    const unlockedAt = Date.now();
    await act(async () => { expect(await session.unlock("a strong password")).toBe(true); });
    await waitFor(() => {
      const scan = session.journal().schedule.find((a) => a.kind === "discovery")!;
      expect(scan.heldFailures ?? 0, "the count started again (a failure since, at most)").toBeLessThan(2);
      // due at the unlock — or, the unlock holding the counters until its scan, a minute after its one failure since — never the old four minutes
      expect(scan.dueAt).toBeLessThanOrEqual(unlockedAt + 2 * 60_000);
    }, LAZY);
  });
  it("a device without a wallet lands on the welcome with the plan's words; Simple is the default; Continue leads to create", async () => {
    const { pathname } = await renderApp("/");
    await screen.findByTestId("welcome");
    expect(pathname()).toBe("/welcome");
    expect(screen.getByRole("heading", { level: 2, name: "Protect your financial privacy" })).toBeInTheDocument();
    expect(screen.getByText("Your wallet stays under your control.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Wallet" })).toBeInTheDocument();
    expect(screen.getByText("No account required")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("welcome-skip"));
    expect(screen.getByRole("heading", { level: 1, name: "Choose your experience" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Simple/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("We choose the safest practical settings.")).toBeInTheDocument();
    expect(screen.getByText("Show more controls and technical details.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Advanced/ }));
    fireEvent.click(screen.getByTestId("experience-continue"));
    await screen.findByTestId("lock-screen");
    expect(pathname()).toBe("/create");
    expect(prefs().get()).toMatchObject({ experience: "advanced", firstLaunchDone: true });
  });
  it("once the first launch is done a device without a wallet goes straight to create; a locked wallet to unlock", async () => {
    prefs().update({ firstLaunchDone: true });
    const a = await renderApp("/");
    await screen.findByTestId("lock-screen");
    expect(a.pathname()).toBe("/create");
    a.unmount();
    await unlockedWallet();
    session.lock();
    const b = await renderApp("/swap");
    await screen.findByTestId("lock-screen");
    expect(b.pathname()).toBe("/unlock");
    expect(screen.getByRole("heading", { level: 1, name: "Unlock your wallet" })).toBeInTheDocument();
  });
  it("an unlocked wallet never sees the onboarding routes, and an unknown path goes to Home", async () => {
    await unlockedWallet();
    const a = await renderApp("/welcome");
    await screen.findByTestId("home");
    expect(a.pathname()).toBe("/");
    a.unmount();
    const b = await renderApp("/nowhere/at/all");
    await screen.findByTestId("home");
    expect(b.pathname()).toBe("/");
  });
  it("the experience preference is mirrored into the journal's advanced flag at unlock; the Settings toggle writes both", async () => {
    prefs().update({ experience: "advanced", firstLaunchDone: true });
    await unlockedWallet();
    const { router } = await renderApp("/");
    await screen.findByTestId("home");
    await waitFor(() => expect(settings.get().advanced).toBe(true));
    expect((session.journal().settings as { advanced?: boolean }).advanced).toBe(true);
    await act(async () => { await router.navigate("/settings"); }); // V7 Stage 4 (spec v3.0 §2): the experience switch lives under Settings → Experience
    await screen.findByTestId("settings");
    const toggle = [...document.querySelectorAll("label")].find((l) => l.textContent?.includes("Show the cryptographic detail"))!.querySelector("input") as HTMLInputElement;
    fireEvent.click(toggle);
    expect(settings.get().advanced).toBe(false);
    expect(prefs().get().experience).toBe("simple");
  });
  it("More lists Tornado Classic (a plain link to the Classic app), the Privacy Center and Settings; Private AI only under the advanced experience (spec v3.0 §2)", async () => {
    await unlockedWallet();
    const { pathname } = await renderApp("/more");
    await screen.findByTestId("more");
    expect([...screen.getByTestId("more").querySelectorAll("[data-testid^='more-']")].map((e) => e.getAttribute("data-testid"))).toEqual(["more-classic", "more-privacy", "more-settings"]);
    const classic = screen.getByTestId("more-classic");
    expect(classic.tagName).toBe("A");
    expect(classic).toHaveAttribute("href", "/classic/");
    expect(classic).toHaveTextContent("Tornado Classic");
    expect(screen.queryByTestId("more-ai")).toBeNull();
    prefs().update({ experience: "advanced" });
    expect(await screen.findByTestId("more-ai")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("more-settings"));
    await screen.findByTestId("settings", {}, LAZY);
    expect(pathname()).toBe("/settings");
    // the old More paths redirect to their new homes (bookmarks and the auto-lock's return path)
    const back = await renderApp("/more/security");
    await screen.findAllByTestId("settings", {}, LAZY);
    expect(back.pathname()).toBe("/settings");
  });
  it("from 1024 px: the top bar (Home · Swap · Activity · Wallet) above the content; the Wallet menu holds the connection and every More entry (doc §88)", async () => {
    (globalThis as { __TEST_VIEWPORT_WIDTH__?: number }).__TEST_VIEWPORT_WIDTH__ = 1440;
    try {
      await unlockedWallet();
      const { pathname } = await renderApp("/");
      await screen.findByTestId("home");
      expect(screen.queryByTestId("bottom-navigation")).toBeNull();
      const top = screen.getByTestId("top-navigation");
      expect([...top.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Home", "Swap", "Activity"]);
      expect(screen.getByTestId("app-bar").compareDocumentPosition(screen.getByRole("main")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.click(screen.getByTestId("nav-wallet"));
      const panel = screen.getByTestId("nav-wallet-panel");
      expect(within(panel).getByTestId("menu-connection")).toHaveTextContent("Not connected");
      // the same entries as the phone's More screen, Advanced only in the advanced experience
      // V7 Stage 4 (spec v3.0 §2): Connect wallet, then the same entries as the phone's More screen; Private AI in the advanced experience
      expect([...panel.querySelectorAll("[data-testid^='menu-']")].map((e) => e.getAttribute("data-testid")).filter((id) => id !== "menu-connection")).toEqual(["menu-connect", "menu-classic", "menu-privacy", "menu-settings"]);
      expect(within(panel).getByTestId("menu-connect")).toHaveTextContent("Connect wallet");
      expect(within(panel).getByTestId("menu-classic")).toHaveAttribute("href", "/classic/");
      fireEvent.click(within(panel).getByTestId("menu-settings"));
      // the screen is a lazy route (V6 Stage 16): the location changes once its chunk has loaded
      await waitFor(() => expect(pathname()).toBe("/settings"));
      expect(screen.queryByTestId("nav-wallet-panel")).toBeNull();
      // More stays lit on /settings (the bottom bar is the phone's; the desktop has no More item, so the top bar marks nothing)
      fireEvent.click(screen.getByTestId("nav-wallet"));
      fireEvent.click(within(screen.getByTestId("nav-wallet-panel")).getByTestId("menu-connect"));
      expect(await screen.findByTestId("connect-sheet")).toHaveTextContent("No wallet was found in this browser");
    } finally {
      delete (globalThis as { __TEST_VIEWPORT_WIDTH__?: number }).__TEST_VIEWPORT_WIDTH__;
    }
  });
  it("the Swap route is a separate chunk that resolves through the shell's loading state", async () => {
    await unlockedWallet();
    const { pathname } = await renderApp("/");
    await screen.findByTestId("home");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Swap" }));
    expect(pathname()).toBe("/swap");
    expect(await screen.findByTestId("swap-view", {}, LAZY)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Swap" })).toHaveAttribute("aria-current", "page");
  });
  it("the component preview exists only where the build carries it (dev and fixtures), outside the wallet's gates", async () => {
    await unlockedWallet();
    const a = await renderApp("/__preview", { preview: false });
    await screen.findByTestId("home");
    expect(a.pathname()).toBe("/");
    a.unmount();
    session.lock();
    const b = await renderApp("/__preview", { preview: true });
    expect(await screen.findByTestId("preview", {}, LAZY)).toBeInTheDocument();
    expect(b.pathname()).toBe("/__preview");
  });
  it("Connect Wallet on the welcome screen uses the injected provider and shows the short account", async () => {
    (window as unknown as Record<string, unknown>).ethereum = { request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? ["0x7A0000000000000000000000000000000000091F2"] : null) };
    await renderApp("/");
    await screen.findByTestId("welcome");
    fireEvent.click(screen.getByTestId("welcome-connect"));
    expect((await screen.findByTestId("welcome-connected")).textContent).toBe("Connected: 0x7A…91F2");
    fireEvent.click(screen.getByTestId("welcome-continue"));
    expect(screen.getByTestId("experience")).toBeInTheDocument();
  });
  it("without an injected provider the welcome says so and still continues", async () => {
    await renderApp("/");
    await screen.findByTestId("welcome");
    fireEvent.click(screen.getByTestId("welcome-connect"));
    expect(await screen.findByRole("status")).toHaveTextContent("No wallet was found in this browser");
    fireEvent.click(screen.getByTestId("welcome-skip"));
    expect(screen.getByTestId("experience")).toBeInTheDocument();
  });
});
