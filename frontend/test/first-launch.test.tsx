// @vitest-environment happy-dom
// Plan §39, pinned: at first launch — and through creating a wallet and opening every tab — the app
// makes NO network request of its own (no analytics, no tracking, no infrastructure calls). The only
// loads allowed on the Pay tab are same-origin files of this build (the zkAPI pin check and config),
// and they happen only after the user opens that tab.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { session } from "../src/wallet/session";
import { peekFreshAddress } from "../src/keys/chainKeys";

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
const byText = (c: HTMLElement, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const passwordInputs = (c: HTMLElement) => [...c.querySelectorAll('input[type="password"]')] as HTMLInputElement[];

describe("first launch (plan §39)", () => {
  it("renders the lock screen, creates a wallet and opens every tab without one network request; the Pay tab loads only same-origin files", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => { root = createRoot(container); root.render(<App />); });
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
    expect(container.textContent).toContain("Private ETH");
    expect(session.state().status).toBe("unlocked");

    for (const tab of ["Shield", "Send privately", "Receive", "Withdraw", "Swap privately"]) {
      await act(async () => { byText(container, tab)!.click(); });
      expect(fetchSpy, `after opening ${tab}`).not.toHaveBeenCalled();
      if (tab === "Receive") expect(container.querySelector("svg"), "the Receive QR is inline, no image request").toBeTruthy();
      if (tab === "Withdraw") {
        // the default recipient is the next fresh EVM address of this wallet, shown but not reserved
        const evmIndex = session.journal().chainIndexes.evm ?? 0;
        const recipient = [...container.querySelectorAll("input")].find((i) => /^0x[0-9a-fA-F]{40}$/.test((i as HTMLInputElement).value)) as HTMLInputElement | undefined;
        expect(recipient?.value, "Withdraw pre-fills a fresh address").toBe(peekFreshAddress(session.state().seed!, "evm").address);
        expect(session.journal().chainIndexes.evm ?? 0, "showing it reserves nothing").toBe(evmIndex);
      }
    }
    expect(beaconSpy).not.toHaveBeenCalled();

    // the Pay tab: only same-origin build files, only once opened
    await act(async () => { byText(container, "Private AI")!.click(); });
    await act(async () => { await Promise.resolve(); });
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u, "same-origin relative URL").toMatch(/^\/zkapi\//);

    // lock → nothing persisted in the clear
    await act(async () => { byText(container, "Lock")!.click(); });
    expect(container.querySelector('[data-testid="lock-screen"]')).toBeTruthy();
    const stored = Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join("\n");
    expect(Object.keys(localStorage).sort()).toEqual(["pp.journal", "pp.keystore"]);
    for (const w of phrase.split(" ").filter((w) => w.length > 5)) expect(stored.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
  });
});
