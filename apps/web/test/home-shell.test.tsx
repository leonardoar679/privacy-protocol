// @vitest-environment happy-dom
// The shell (plan V2 §39–§45, §49, §93, §97; spec §2): the preference and the tiers set under Settings are journaled
// and survive a lock; the Privacy badge shows the overall level and opens the Center; the Activity route renders the
// journal's records and lets finished ones go; an unreadable journal is kept — the wallet says so, writes nothing,
// and sets it aside only when the user asks; replacing a wallet needs a typed confirmation.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { JOURNAL_KEY, UNREADABLE_JOURNAL_KEY } from "@privacy-wallet/sdk/wallet/storage";
import { secureStore } from "../src/storage";
import { idbGet, idbPut } from "../src/storage/idb";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { KEYSTORE_KEY, memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { prefs } from "../src/storage/prefs";
import { renderApp } from "./helpers/render";

beforeAll(() => { globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch; });
afterEach(() => { session.forget(); settings.reset(); prefs().reset(); });

const type = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });
const labelled = (text: string) => [...document.querySelectorAll("label")].find((l) => l.textContent?.includes(text)) as HTMLLabelElement | undefined;
const LAZY = { timeout: 15_000 };

async function mountUnlocked() {
  await session.create("a strong password");
  session.acknowledgePhrase();
  const r = await renderApp("/");
  await screen.findByTestId("home");
  return r;
}
async function openSettings() { fireEvent.click(screen.getByRole("button", { name: "Settings" })); await screen.findByTestId("settings"); }
async function lock() { fireEvent.click(screen.getByRole("button", { name: "Lock" })); await screen.findByTestId("lock-screen"); }
async function unlockThrough(password: string) {
  type(document.querySelector('input[type="password"]') as HTMLInputElement, password);
  fireEvent.click(screen.getByTestId("unlock"));
  await waitFor(() => expect(session.state().status).toBe("unlocked"), { timeout: 20_000 });
  await screen.findByTestId("home");
}

describe("the shell", () => {
  it("Settings: the trade preference and the tiers are journaled and come back after a lock; nonsense thresholds are refused", async () => {
    const { router } = await mountUnlocked();
    await act(async () => { await router.navigate("/more/wallet"); }); // V5: the trade preference lives under More → Wallet
    await screen.findByTestId("wallet-screen");
    const radio = labelled("Best privacy")!.querySelector("input") as HTMLInputElement;
    fireEvent.click(radio);
    expect(settings.get().preference).toBe("best-privacy");
    expect((session.journal().settings as { preference?: string }).preference).toBe("best-privacy");
    await act(async () => { await router.navigate("/more/security"); }); // the thresholds and Lock live under More → Security
    await screen.findByTestId("settings");
    const enhanced = labelled("Enhanced review from")!.nextElementSibling as HTMLInputElement;
    type(enhanced, "250000");
    fireEvent.focusOut(enhanced);
    expect(settings.get().tiers.enhanced).toBe(250_000);
    type(enhanced, "5000000");
    fireEvent.focusOut(enhanced);
    expect(settings.get().tiers.enhanced, "enhanced above high-value is refused").toBe(250_000);
    expect(document.body.textContent).toMatch(/must|below|order|increase/i);
    await lock();
    settings.reset();
    await unlockThrough("a strong password");
    expect(settings.get().preference).toBe("best-privacy");
    expect(settings.get().tiers.enhanced).toBe(250_000);
    expect(document.body.textContent).not.toContain("Trade preference"); // Home, not Settings, after the unlock
  }, 60_000);

  it("the Privacy badge shows the overall level and opens the Center; Activity renders the journal and removes finished rows", async () => {
    await mountUnlocked();
    const badge = screen.getByTestId("privacy-badge");
    expect(badge).toHaveAttribute("data-level"); // from the posture (spec v2.0 §7.1); the level's reasons live in the Center
    expect(["Protected", "Medium protection", "Low protection"]).toContain(badge.textContent);
    fireEvent.click(badge);
    await screen.findByTestId("privacy-center");
    fireEvent.click(screen.getByTestId("privacy-advanced-toggle")); // V5: the six categories sit under "Advanced privacy settings"
    expect(screen.getByTestId("privacy-center").textContent).toContain("Timing privacy");
    fireEvent.click(screen.getByTestId("back"));
    await screen.findByTestId("home");
    await act(async () => {
      recordActivity({ id: "shield:0xabc", kind: "shield", asset: "ETH", decimals: 18, amount: (15n * 10n ** 17n).toString(), status: "completed", ref: "0xabc", at: Date.now() - 60_000 });
      recordActivity({ id: "swap:0xdef", kind: "swap", asset: "ETH", decimals: 18, amount: (5n * 10n ** 17n).toString(), status: "funded", ref: "0xdef", note: "→ BTC", at: Date.now() });
    });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Activity" }));
    const rows = await screen.findAllByTestId("activity-row", {}, LAZY);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("ETH → BTC"); // newest first (spec v2.0 §7.8)
    expect(rows[0].textContent).toContain("0.5 ETH");
    expect(rows[0].textContent).toContain("Executing");
    expect(rows[1].textContent).toContain("Protected ETH");
    expect(rows[1].textContent).toContain("1.5 ETH");
    expect(document.body.textContent, "Simple: no Remove on a row").not.toContain("Remove");
    // a finished line goes from the detail's Advanced section
    fireEvent.click(within(rows[1]).getByRole("button"));
    await screen.findByTestId("activity-detail", {}, LAZY);
    fireEvent.click(screen.getByTestId("detail-advanced-toggle"));
    fireEvent.click(screen.getByTestId("detail-remove"));
    await waitFor(() => expect(screen.getAllByTestId("activity-row")).toHaveLength(1));
    expect(session.journal().activity!.map((r) => r.id)).toEqual(["swap:0xdef"]);
  }, 60_000);

  it("an unreadable journal is kept: the wallet opens with a notice, persists nothing, and sets it aside only on request", async () => {
    await mountUnlocked();
    await openSettings();
    await lock();
    const corrupt = JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: "11".repeat(48) });
    secureStore().set(JOURNAL_KEY, corrupt);
    await unlockThrough("a strong password");
    expect(screen.getByTestId("journal-unreadable")).toBeInTheDocument();
    expect(session.state().journalUnreadable).toBe(true);
    await act(async () => { recordActivity({ id: "shield:0x1", kind: "shield", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x1" }); });
    expect(secureStore().get(JOURNAL_KEY), "nothing overwrites the unreadable blob").toBe(corrupt);
    expect(secureStore().get(UNREADABLE_JOURNAL_KEY)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set it aside and start fresh" }));
    await waitFor(() => expect(screen.queryByTestId("journal-unreadable")).toBeNull());
    expect(secureStore().get(UNREADABLE_JOURNAL_KEY)).toBe(corrupt);
    expect(secureStore().get(JOURNAL_KEY)).not.toBe(corrupt);
    expect(session.journal().activity!.map((r) => r.id)).toEqual(["shield:0x1"]); // the in-memory journal is what got persisted
  }, 60_000);

  it("a tab opened before another tab created the wallet asks for REPLACE before it creates over it (audit round 2, r27)", async () => {
    const { pathname } = await renderApp("/create");
    await screen.findByTestId("create");
    expect(pathname()).toBe("/create");
    expect(screen.queryByTestId("replace-confirm"), "no wallet when this tab opened").toBeNull();
    // another tab creates its wallet: IndexedDB holds it, this tab's copy of the store does not
    const other = new WalletSession(memoryStorage());
    await other.create("the other tab's password");
    const theirs = JSON.stringify((JSON.parse(other.exportBackup()) as { keystore: unknown }).keystore);
    await secureStore().flush(); // the last test's Forget queued a delete of the keystore: landed first, never after this write
    await idbPut("secure", KEYSTORE_KEY, theirs);
    const [pw, confirm] = [...document.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
    type(pw, "another password");
    type(confirm, "another password");
    fireEvent.click(screen.getByTestId("create"));
    expect(await screen.findByText(/created on this device in another tab/, {}, { timeout: 20_000 })).toBeTruthy();
    expect(await idbGet("secure", KEYSTORE_KEY), "the other tab's wallet is untouched").toBe(theirs);
    expect(screen.getByTestId("replace-confirm"), "this tab reads the wallet now, and asks").toBeTruthy();
    expect(screen.getByTestId("create")).toBeDisabled();
  }, 60_000);

  it("creating a wallet over an existing one needs the typed confirmation", async () => {
    prefs().update({ backup: { exportedAt: 1_700_000_000_000 } }); // the replaced wallet's backup
    const { pathname } = await mountUnlocked();
    await openSettings();
    await lock();
    const keystoreBefore = secureStore().get("pp.keystore");
    fireEvent.click(screen.getByTestId("to-create"));
    await screen.findByTestId("create");
    expect(pathname()).toBe("/create");
    const [pw, confirm] = [...document.querySelectorAll('input[type="password"]')] as HTMLInputElement[];
    type(pw, "another password");
    type(confirm, "another password");
    expect(screen.getByTestId("create"), "no confirmation typed").toBeDisabled();
    type(screen.getByTestId("replace-confirm") as HTMLInputElement, "REPLACE");
    expect(screen.getByTestId("create")).toBeEnabled();
    fireEvent.click(screen.getByTestId("create"));
    await screen.findByTestId("recovery-phrase", {}, { timeout: 20_000 });
    expect(secureStore().get("pp.keystore")).not.toBe(keystoreBefore);
    expect(prefs().get().backup, "the backup status was the replaced wallet's (audit round 2, r29)").toBeUndefined();
  }, 60_000);
});
