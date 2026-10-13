// @vitest-environment happy-dom
// Plan V2 §39 and Privacy Wallet Web spec §2–§3, pinned: at first launch — through the welcome, the experience
// choice, creating a wallet, the four routes (Home, Swap, Activity, More — never more) and every screen reached
// from Home (Send, Protect, Receive, the Privacy Center, Settings) — the app makes NO network request of its own
// (no analytics, no tracking, no infrastructure call, no price read without a balance). The only loads allowed
// are same-origin files of this build for Private AI, and only once the user opens it. Nothing is persisted in the
// clear: the secure store holds the two ciphertext blobs and localStorage holds nothing of ours.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { secureStore } from "../src/storage";
import { prefs } from "../src/storage/prefs";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { renderApp } from "./helpers/render";

const fetchSpy = vi.fn(async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }));
const beaconSpy = vi.fn(() => true);
class Forbidden { constructor(...args: unknown[]) { throw new Error(`forbidden network primitive used: ${JSON.stringify(args).slice(0, 80)}`); } }

beforeAll(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  (globalThis as unknown as Record<string, unknown>).XMLHttpRequest = Forbidden;
  (globalThis as unknown as Record<string, unknown>).WebSocket = Forbidden;
  (globalThis as unknown as Record<string, unknown>).EventSource = Forbidden;
  (navigator as unknown as Record<string, unknown>).sendBeacon = beaconSpy;
  (globalThis as unknown as Record<string, unknown>).Worker = Forbidden; // the prover worker is created only when a proof is requested
});
afterEach(() => { session.forget(); settings.reset(); prefs().reset(); connection.reset(); });

const passwordInputs = () => [...document.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
const type = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });
const LAZY = { timeout: 15_000 };

describe("first launch (plan §39; spec §2–§3)", () => {
  it("welcome → experience → create → Home; every route and screen without one request; Private AI loads only same-origin files; nothing in the clear", async () => {
    const { pathname } = await renderApp("/");
    expect(await screen.findByTestId("welcome")).toBeInTheDocument();
    expect(pathname()).toBe("/welcome");
    for (const line of ["Protect your financial privacy", "Your wallet stays under your control.", "Connect Wallet", "No account required"]) expect(screen.getByText(line)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("welcome-skip"));
    expect(screen.getByTestId("experience")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Simple/ }), "Simple by default").toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("experience-continue"));
    expect(await screen.findByTestId("lock-screen")).toBeInTheDocument();
    expect(pathname()).toBe("/create");
    expect(prefs().get()).toMatchObject({ experience: "simple", firstLaunchDone: true });

    // create: password twice → the recovery phrase → acknowledge → Home
    const [pw, confirm] = passwordInputs();
    type(pw, "a strong password");
    type(confirm, "a strong password");
    fireEvent.click(screen.getByTestId("create"));
    await screen.findByTestId("recovery-phrase", {}, { timeout: 20_000 });
    const phrase = screen.getByTestId("phrase-words").textContent!.trim();
    expect(phrase.split(" ")).toHaveLength(24);
    fireEvent.click(screen.getByTestId("phrase-ack"));
    fireEvent.click(screen.getByTestId("phrase-continue"));
    expect(await screen.findByTestId("home")).toBeInTheDocument();
    expect(pathname()).toBe("/");
    expect(document.body.textContent).toContain("Protected balance");
    expect(screen.getByTestId("private-usd").textContent).toBe("—"); // nothing to value, nothing read
    expect(session.state().status).toBe("unlocked");
    expect(fetchSpy, "Home").not.toHaveBeenCalled();

    // the four routes, and nothing else in the main navigation
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Home", "Swap", "Activity", "More"]);
    fireEvent.click(within(nav).getByRole("link", { name: "Swap" }));
    expect(await screen.findByTestId("swap", {}, LAZY)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Priority/); // the preference lives in Settings
    expect(fetchSpy, "after Swap").not.toHaveBeenCalled();
    fireEvent.click(within(nav).getByRole("link", { name: "Activity" }));
    await waitFor(() => expect(document.body.textContent).toContain("Nothing yet"), LAZY);
    fireEvent.click(within(nav).getByRole("link", { name: "More" }));
    expect(await screen.findByTestId("more")).toBeInTheDocument();
    expect(screen.queryByTestId("more-advanced"), "Simple hides the Advanced entry").toBeNull();
    fireEvent.click(within(nav).getByRole("link", { name: "Home" }));
    expect(await screen.findByTestId("home")).toBeInTheDocument();
    expect(fetchSpy, "after the four routes").not.toHaveBeenCalled();

    // Send, from Home: the public mode pre-fills the next fresh EVM address of this wallet, shown but not reserved
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByTestId("send-tab")).toBeInTheDocument();
    expect(pathname()).toBe("/send");
    fireEvent.click(screen.getByRole("radio", { name: "To a public address" })); // V5: the Send screen's segmented control
    const evmIndex = session.journal().chainIndexes.evm ?? 0;
    const recipient = [...document.querySelectorAll("input")].find((i) => /^0x[0-9a-fA-F]{40}$/.test((i as HTMLInputElement).value)) as HTMLInputElement | undefined;
    expect(recipient?.value, "Withdraw pre-fills a fresh address").toBe(peekFreshAddress(session.state().seed!, "evm").address);
    expect(session.journal().chainIndexes.evm ?? 0, "showing it reserves nothing").toBe(evmIndex);
    expect(fetchSpy, "after the public mode").not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("back"));
    expect(await screen.findByTestId("home")).toBeInTheDocument();

    // the screens reached from Home are routes with a Back control
    fireEvent.click(screen.getByTestId("protect-cta")); // the card of an empty balance: "Protect Assets"
    expect(await screen.findByTestId("protect-submit"), "V5: the Protect screen").toBeInTheDocument();
    expect(pathname()).toBe("/protect");
    fireEvent.click(screen.getByTestId("back"));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByRole("button", { name: "Receive" }));
    expect((await screen.findByTestId("sheet-receive")).querySelector("svg"), "the Receive QR is inline, no image request").toBeTruthy();
    fireEvent.click(screen.getByTestId("back"));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByTestId("privacy-badge"));
    const center = await screen.findByTestId("privacy-center");
    fireEvent.click(screen.getByTestId("privacy-advanced-toggle")); // V5: the six categories sit under "Advanced privacy settings"
    for (const c of ["Financial history", "Address separation", "Network privacy", "RPC privacy", "Timing privacy", "Cross-chain privacy"]) expect(center.textContent).toContain(c);
    expect(center.textContent).toContain("What this wallet cannot promise");
    expect(center.textContent!.toLowerCase()).not.toMatch(/anonymous/);
    expect(pathname()).toBe("/more/privacy");
    fireEvent.click(screen.getByTestId("back"));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByTestId("settings")).toBeInTheDocument();
    expect(pathname()).toBe("/more/security");
    fireEvent.click(within(nav).getByRole("link", { name: "More" })); // V5: the trade preference lives under More → Wallet
    fireEvent.click(await screen.findByTestId("more-wallet"));
    await screen.findByTestId("wallet-screen");
    expect(pathname()).toBe("/more/wallet");
    expect(document.body.textContent).toContain("Trade preference");
    expect(fetchSpy, "after every screen").not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();

    // Private AI (More): only same-origin build files, only once opened
    fireEvent.click(within(nav).getByRole("link", { name: "More" }));
    fireEvent.click(await screen.findByTestId("more-ai"));
    await screen.findByTestId("sheet-ai", {}, LAZY);
    if (__ZKAPI__) {
      await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(0));
      for (const c of fetchSpy.mock.calls) expect(String(c[0]), "same-origin relative URL").toMatch(/^\/zkapi\//);
    } else {
      // a build without the zkAPI clone (the CI runner, V6 Stage 2): the screen says so and asks for nothing
      expect(await screen.findByTestId("private-ai-unavailable")).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    }

    // lock (Settings) → the unlock route; nothing persisted in the clear (spec §8)
    fireEvent.click(within(nav).getByRole("link", { name: "More" }));
    fireEvent.click(await screen.findByTestId("more-security"));
    await screen.findByTestId("settings");
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(await screen.findByTestId("lock-screen")).toBeInTheDocument();
    expect(pathname()).toBe("/unlock");
    const store = secureStore();
    await store.flush();
    expect(localStorage.length).toBe(0);
    expect(store.keys()).toEqual(["pp.journal", "pp.keystore"]);
    const stored = store.keys().map((k) => `${k}=${store.get(k)}`).join("\n");
    for (const w of phrase.split(" ").filter((w) => w.length > 5)) expect(stored.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
  }, 60_000);
});
