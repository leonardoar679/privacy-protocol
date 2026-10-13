// @vitest-environment happy-dom
// The application shell (spec §2, §3.1, §6): the gate's redirects, the first-launch copy and the Simple default, the
// experience preference mirrored into the journal, the More menu, the lazy routes, the gallery in dev only, the
// Classic entry, Connect Wallet on the welcome screen, an unknown path back to Home.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { prefs } from "../src/storage/prefs";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { renderApp } from "./helpers/render";

beforeAll(() => { globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch; });
afterEach(() => { session.forget(); settings.reset(); prefs().reset(); connection.reset(); delete (window as unknown as Record<string, unknown>).ethereum; });
const LAZY = { timeout: 15_000 };

async function unlockedWallet() { await session.create("a strong password"); session.acknowledgePhrase(); }

describe("the application shell (spec §2)", () => {
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
    await act(async () => { await router.navigate("/more"); }); // V5 Stage 10: the experience switch lives on the More menu
    await screen.findByTestId("more");
    const toggle = [...document.querySelectorAll("label")].find((l) => l.textContent?.includes("Show the cryptographic detail"))!.querySelector("input") as HTMLInputElement;
    fireEvent.click(toggle);
    expect(settings.get().advanced).toBe(false);
    expect(prefs().get().experience).toBe("simple");
  });
  it("More lists the Privacy Center, Security, Wallet, Classic Privacy and Private AI; Advanced only under the advanced experience", async () => {
    await unlockedWallet();
    await renderApp("/more");
    await screen.findByTestId("more");
    for (const id of ["more-privacy", "more-security", "more-wallet", "more-classic", "more-ai"]) expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.queryByTestId("more-advanced")).toBeNull();
    prefs().update({ experience: "advanced" });
    expect(await screen.findByTestId("more-advanced")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("more-classic"));
    const classic = await screen.findByTestId("classic");
    expect(screen.getByTestId("classic-pool-eth-1"), "V5 Stage 10: the devnet pools").toBeInTheDocument();
    expect(classic.textContent).toContain("never your protected balance");
    fireEvent.click(screen.getByTestId("back"));
    await screen.findByTestId("more");
  });
  it("the Swap route is a separate chunk that resolves through the shell's loading state", async () => {
    await unlockedWallet();
    const { pathname } = await renderApp("/");
    await screen.findByTestId("home");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Swap" }));
    expect(pathname()).toBe("/swap");
    expect(await screen.findByTestId("swap", {}, LAZY)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Swap" })).toHaveAttribute("aria-current", "page");
  });
  it("the gallery route exists in dev builds only", async () => {
    await unlockedWallet();
    const a = await renderApp("/gallery", { dev: false });
    await screen.findByTestId("home");
    expect(a.pathname()).toBe("/");
    a.unmount();
    const b = await renderApp("/gallery", { dev: true });
    expect(await screen.findByTestId("gallery", {}, LAZY)).toBeInTheDocument();
    expect(b.pathname()).toBe("/gallery");
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
