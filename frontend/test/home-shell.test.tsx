// @vitest-environment happy-dom
// The V2 shell (plan V2 §39–§45, §49, §93, §97): the preference and the tiers set under Settings are
// journaled and survive a lock; the Privacy badge shows the overall level and opens the Center; the
// Activity list renders the journal's records and lets finished ones go; an unreadable journal is kept —
// the wallet says so, writes nothing, and sets it aside only when the user asks; replacing a wallet needs
// a typed confirmation.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";
import { recordActivity } from "../src/wallet/activity";
import { JOURNAL_KEY, UNREADABLE_JOURNAL_KEY } from "../src/wallet/storage";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => { globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch; });
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); settings.reset(); });

const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
const byText = (c: ParentNode, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const navButton = (c: HTMLElement, text: string) => byText(c.querySelector("nav")!, text);
const labelled = (c: ParentNode, text: string) => [...c.querySelectorAll("label")].find((l) => l.textContent?.includes(text)) as HTMLLabelElement | undefined;

async function mountUnlocked(container: HTMLElement) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  await act(async () => { root = createRoot(container); root.render(<App />); });
  expect(container.querySelector('[data-testid="home"]')).toBeTruthy();
}
async function unlockThrough(container: HTMLElement, password: string) {
  const pw = container.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => { setValue(pw, password); });
  await act(async () => { byText(container, "Unlock")!.click(); });
  await vi.waitFor(() => expect(session.state().status).toBe("unlocked"), { timeout: 20_000 });
  await act(async () => { await Promise.resolve(); });
}

describe("the V2 shell", () => {
  it("Settings: the trade preference and the tiers are journaled and come back after a lock; nonsense thresholds are refused", async () => {
    const container = document.createElement("div");
    await mountUnlocked(container);
    await act(async () => { byText(container, "⚙ Settings")!.click(); });
    const radio = labelled(container, "Best privacy")!.querySelector("input") as HTMLInputElement;
    await act(async () => { radio.click(); });
    expect(settings.get().preference).toBe("best-privacy");
    expect((session.journal().settings as any).preference).toBe("best-privacy");
    const enhanced = labelled(container, "Enhanced review from")!.nextElementSibling as HTMLInputElement;
    await act(async () => { setValue(enhanced, "250000"); enhanced.dispatchEvent(new Event("blur")); });
    // React's onBlur listens to focusout
    await act(async () => { enhanced.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(settings.get().tiers.enhanced).toBe(250_000);
    await act(async () => { setValue(enhanced, "5000000"); enhanced.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(settings.get().tiers.enhanced, "enhanced above high-value is refused").toBe(250_000);
    expect(container.textContent).toMatch(/must|below|order|increase/i);
    await act(async () => { byText(container, "Lock")!.click(); });
    expect(container.querySelector('[data-testid="lock-screen"]')).toBeTruthy();
    settings.reset();
    await unlockThrough(container, "a strong password");
    expect(settings.get().preference).toBe("best-privacy");
    expect(settings.get().tiers.enhanced).toBe(250_000);
    expect(container.querySelector('[data-testid="home"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Trade preference"); // the sheet closed with the lock
  });

  it("the Privacy badge shows the overall level and opens the Center; Activity renders the journal and removes finished rows", async () => {
    const container = document.createElement("div");
    await mountUnlocked(container);
    const badge = container.querySelector('[data-testid="privacy-badge"]')!;
    expect(badge.textContent).toMatch(/Privacy: (Excellent|Good|Reduced)/);
    await act(async () => { (badge as HTMLButtonElement).click(); });
    expect(container.querySelector('[data-testid="privacy-center"]')!.textContent).toContain("Timing privacy");
    await act(async () => { byText(container, "Close")!.click(); });
    await act(async () => {
      recordActivity({ id: "shield:0xabc", kind: "shield", asset: "ETH", decimals: 18, amount: (15n * 10n ** 17n).toString(), status: "completed", ref: "0xabc", at: Date.now() - 60_000 });
      recordActivity({ id: "swap:0xdef", kind: "swap", asset: "ETH", decimals: 18, amount: (5n * 10n ** 17n).toString(), status: "funded", ref: "0xdef", note: "→ BTC", at: Date.now() });
    });
    await act(async () => { navButton(container, "Activity")!.click(); });
    const rows = [...container.querySelectorAll('[data-testid="activity-row"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Swap"); // newest first
    expect(rows[0].textContent).toContain("0.5 ETH");
    expect(rows[0].textContent).toContain("Funded");
    expect(rows[0].textContent).not.toContain("Remove"); // still moving
    expect(rows[1].textContent).toContain("Added funds");
    expect(rows[1].textContent).toContain("1.5 ETH");
    expect(rows[1].textContent).toContain("Completed");
    await act(async () => { byText(rows[1], "Remove")!.click(); });
    expect(container.querySelectorAll('[data-testid="activity-row"]')).toHaveLength(1);
    expect(session.journal().activity!.map((r) => r.id)).toEqual(["swap:0xdef"]);
  });

  it("an unreadable journal is kept: the wallet opens with a notice, persists nothing, and sets it aside only on request", async () => {
    const container = document.createElement("div");
    await mountUnlocked(container);
    await act(async () => { byText(container, "⚙ Settings")!.click(); });
    await act(async () => { byText(container, "Lock")!.click(); });
    const corrupt = JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "11".repeat(48) });
    localStorage.setItem(JOURNAL_KEY, corrupt);
    await unlockThrough(container, "a strong password");
    expect(container.querySelector('[data-testid="journal-unreadable"]')).toBeTruthy();
    expect(session.state().journalUnreadable).toBe(true);
    await act(async () => { recordActivity({ id: "shield:0x1", kind: "shield", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x1" }); });
    expect(localStorage.getItem(JOURNAL_KEY), "nothing overwrites the unreadable blob").toBe(corrupt);
    expect(localStorage.getItem(UNREADABLE_JOURNAL_KEY)).toBeNull();
    await act(async () => { byText(container, "Set it aside and start fresh")!.click(); });
    expect(container.querySelector('[data-testid="journal-unreadable"]')).toBeNull();
    expect(localStorage.getItem(UNREADABLE_JOURNAL_KEY)).toBe(corrupt);
    expect(localStorage.getItem(JOURNAL_KEY)).not.toBe(corrupt);
    expect(session.journal().activity!.map((r) => r.id)).toEqual(["shield:0x1"]); // the in-memory journal is what got persisted
  });

  it("creating a wallet over an existing one needs the typed confirmation", async () => {
    const container = document.createElement("div");
    await mountUnlocked(container);
    await act(async () => { byText(container, "⚙ Settings")!.click(); });
    await act(async () => { byText(container, "Lock")!.click(); });
    const keystoreBefore = localStorage.getItem("pp.keystore");
    await act(async () => { byText(container, "Create a new wallet (replaces this one)")!.click(); });
    const [pw, confirm] = [...container.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
    await act(async () => { setValue(pw, "another password"); setValue(confirm, "another password"); });
    expect(byText(container, "Create wallet")!.disabled, "no confirmation typed").toBe(true);
    await act(async () => { setValue(container.querySelector('[data-testid="replace-confirm"]') as HTMLInputElement, "REPLACE"); });
    expect(byText(container, "Create wallet")!.disabled).toBe(false);
    await act(async () => { byText(container, "Create wallet")!.click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="recovery-phrase"]')).toBeTruthy(), { timeout: 20_000 });
    expect(localStorage.getItem("pp.keystore")).not.toBe(keystoreBefore);
  });
});
