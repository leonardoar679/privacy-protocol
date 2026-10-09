// @vitest-environment happy-dom
// Plan §39, pinned: at first launch — and through creating a wallet, the four tabs (Home, Swap, Send,
// Activity) and every sheet over Home (Add funds, Receive, Privacy Center, Settings) — the app makes NO
// network request of its own (no analytics, no tracking, no infrastructure calls, no price read without a
// balance). The only loads allowed under Private services are same-origin files of this build (the zkAPI
// pin check and config), and they happen only after the user opens Private AI.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { session } from "../src/wallet/session";
import { peekFreshAddress } from "../src/keys/chainKeys";
import { secureStore } from "../src/storage";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fetchSpy = vi.fn(async (input: any) => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }));
const beaconSpy = vi.fn(() => true);
class Forbidden { constructor(...args: unknown[]) { throw new Error(`forbidden network primitive used: ${JSON.stringify(args).slice(0, 80)}`); } }

beforeAll(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  (globalThis as any).XMLHttpRequest = Forbidden;
  (globalThis as any).WebSocket = Forbidden;
  (globalThis as any).EventSource = Forbidden;
  (navigator as any).sendBeacon = beaconSpy;
  (globalThis as any).Worker = Forbidden; // the prover worker is created only when a proof is requested
});

let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); });

const setValue = (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const byText = (c: ParentNode, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const navButton = (c: HTMLElement, text: string) => byText(c.querySelector("nav")!, text);
const passwordInputs = (c: HTMLElement) => [...c.querySelectorAll('input[type="password"]')] as HTMLInputElement[];

describe("first launch (plan §39; V2 four tabs)", () => {
  it("renders the lock screen, creates a wallet and opens every tab and sheet without one network request; Private AI loads only same-origin files", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container); root.render(<App />); });
    await act(async () => { await session.ready; }); // V5: the store hydrates before the lock screen
    expect(container.querySelector('[data-testid="lock-screen"]')).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();

    // create: password twice → the recovery phrase → acknowledge
    const [pw, confirm] = passwordInputs(container);
    await act(async () => { setValue(pw, "a strong password"); setValue(confirm, "a strong password"); });
    await act(async () => { byText(container, "Create wallet")!.click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="recovery-phrase"]')).toBeTruthy(), { timeout: 20_000 });
    const phrase = container.querySelector('[data-testid="recovery-phrase"] code')!.textContent!.trim();
    expect(phrase.split(" ")).toHaveLength(24);
    await act(async () => { (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await act(async () => { byText(container, "Continue")!.click(); });
    expect(container.querySelector('[data-testid="home"]')).toBeTruthy();
    expect(container.textContent).toContain("Private balance");
    expect(container.querySelector('[data-testid="private-usd"]')!.textContent).toBe("—"); // nothing to value, nothing read
    expect(session.state().status).toBe("unlocked");
    expect(fetchSpy, "Home").not.toHaveBeenCalled();

    // the four tabs, and nothing else in the main navigation
    const main = [...container.querySelectorAll("nav button")].filter((b) => !b.classList.contains("desktop-only")).map((b) => b.textContent?.trim());
    expect(main).toEqual(["Home", "Swap", "Send", "Activity"]);
    for (const tab of ["Swap", "Send", "Activity", "Home"]) {
      await act(async () => { navButton(container, tab)!.click(); });
      expect(fetchSpy, `after opening ${tab}`).not.toHaveBeenCalled();
      if (tab === "Swap") { expect(container.querySelector('[data-testid="swap"]')).toBeTruthy(); expect(container.textContent).not.toMatch(/Priority/); } // the preference lives in Settings
      if (tab === "Activity") expect(container.textContent).toContain("Nothing yet");
      if (tab === "Send") {
        expect(container.querySelector('[data-testid="send-tab"]')).toBeTruthy();
        await act(async () => { byText(container, "To a public address")!.click(); });
        // the default recipient is the next fresh EVM address of this wallet, shown but not reserved
        const evmIndex = session.journal().chainIndexes.evm ?? 0;
        const recipient = [...container.querySelectorAll("input")].find((i) => /^0x[0-9a-fA-F]{40}$/.test((i as HTMLInputElement).value)) as HTMLInputElement | undefined;
        expect(recipient?.value, "Withdraw pre-fills a fresh address").toBe(peekFreshAddress(session.state().seed!, "evm").address);
        expect(session.journal().chainIndexes.evm ?? 0, "showing it reserves nothing").toBe(evmIndex);
        expect(fetchSpy, "after the public mode").not.toHaveBeenCalled();
      }
    }

    // the sheets over Home
    await act(async () => { byText(container, "Add funds")!.click(); });
    expect(container.querySelector('[data-testid="shield"]')).toBeTruthy();
    await act(async () => { byText(container, "Close")!.click(); });
    await act(async () => { byText(container, "Receive")!.click(); });
    expect(container.querySelector('[data-testid="sheet-receive"] svg'), "the Receive QR is inline, no image request").toBeTruthy();
    await act(async () => { byText(container, "Close")!.click(); });
    await act(async () => { (container.querySelector('[data-testid="privacy-badge"]') as HTMLButtonElement).click(); });
    const center = container.querySelector('[data-testid="privacy-center"]')!;
    for (const c of ["Financial history", "Address separation", "Network privacy", "RPC privacy", "Timing privacy", "Cross-chain privacy"]) expect(center.textContent).toContain(c);
    expect(center.textContent).toContain("What this wallet cannot promise");
    expect(center.textContent!.toLowerCase()).not.toMatch(/anonymous/);
    await act(async () => { byText(container, "Close")!.click(); });
    await act(async () => { byText(container, "⚙ Settings")!.click(); });
    expect(container.querySelector('[data-testid="settings"]')).toBeTruthy();
    expect(container.textContent).toContain("Trade preference");
    await act(async () => { byText(container, "Close")!.click(); });
    await act(async () => { byText(container, "Details")!.click(); });
    expect(container.textContent).toContain("Private ETH");
    expect(fetchSpy, "after every sheet").not.toHaveBeenCalled();
    expect(beaconSpy).not.toHaveBeenCalled();

    // Private AI (under Details → Private services): only same-origin build files, only once opened
    await act(async () => { byText(container, "Private AI")!.click(); });
    await act(async () => { await Promise.resolve(); });
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u, "same-origin relative URL").toMatch(/^\/zkapi\//);
    await act(async () => { byText(container, "Close")!.click(); });

    // lock (Settings) → nothing persisted in the clear
    await act(async () => { byText(container, "⚙ Settings")!.click(); });
    await act(async () => { byText(container, "Lock")!.click(); });
    expect(container.querySelector('[data-testid="lock-screen"]')).toBeTruthy();
    // V5 (spec §8): the two ciphertext blobs are the secure store's only records; localStorage holds nothing of ours
    const store = secureStore();
    await store.flush();
    expect(localStorage.length).toBe(0);
    expect(store.keys()).toEqual(["pp.journal", "pp.keystore"]);
    const stored = store.keys().map((k) => `${k}=${store.get(k)}`).join("\n");
    for (const w of phrase.split(" ").filter((w) => w.length > 5)) expect(stored.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
  });
});
