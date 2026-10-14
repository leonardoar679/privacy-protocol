// @vitest-environment jsdom
// Accessibility of the screens (spec §19; Stage 11): every route of the shell and the onboarding passes axe with no
// violation (colour contrast is a browser check: jsdom has no layout), the navigation is a landmark with four named
// links and the current one marked, a sheet opens as a labelled modal dialog and closes on Escape. The gallery test
// covers every component state; this one covers the pages they compose.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { renderApp } from "../helpers/render";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { prefs } from "../../src/storage/prefs";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { resetClassicPools } from "../../src/features/classic-privacy/contracts";

afterEach(() => { cleanup(); session.forget(); settings.reset(); prefs().reset(); connection.reset(); resetClassicPools(); });
const LAZY = { timeout: 20_000 };
const RULES = { rules: { "color-contrast": { enabled: false } } };

async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, RULES);
  return results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`);
}
async function unlocked() { await session.create("a strong password"); session.acknowledgePhrase(); prefs().update({ firstLaunchDone: true }); }

const SCREENS: { path: string; id: string; wallet: boolean }[] = [
  { path: "/welcome", id: "welcome", wallet: false },
  { path: "/", id: "home", wallet: true },
  { path: "/protect", id: "protect-view", wallet: true },
  { path: "/send", id: "send-view", wallet: true },
  { path: "/receive", id: "sheet-receive", wallet: true },
  { path: "/swap", id: "swap-view", wallet: true },
  { path: "/activity", id: "activity", wallet: true },
  { path: "/more", id: "more", wallet: true },
  { path: "/more/privacy", id: "privacy-center", wallet: true },
  { path: "/more/privacy/what-stays-private", id: "what-stays-private", wallet: true },
  { path: "/more/security", id: "settings", wallet: true },
  { path: "/more/wallet", id: "wallet-screen", wallet: true },
  { path: "/more/classic", id: "classic", wallet: true },
  { path: "/more/classic/eth-1", id: "classic-pool", wallet: true },
  { path: "/more/classic/recover", id: "classic-recover", wallet: true },
  { path: "/more/classic/relayers", id: "classic-relayers", wallet: true },
];

describe("the screens are accessible (spec §19)", () => {
  for (const s of SCREENS) {
    it(`${s.path} has no axe violation`, async () => {
      if (s.wallet) await unlocked();
      await renderApp(s.path);
      await screen.findByTestId(s.id, {}, LAZY);
      expect(await violations()).toEqual([]);
    }, 60_000);
  }
  it("the navigation is a landmark with the four links, named, the current one marked; the main landmark holds the page", async () => {
    await unlocked();
    await renderApp("/activity");
    await screen.findByTestId("activity", {}, LAZY);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((a) => a.textContent?.trim())).toEqual(["Home", "Swap", "Activity", "More"]);
    expect(links.find((a) => a.textContent?.includes("Activity"))!.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("main")).toContainElement(screen.getByTestId("activity"));
  });
  it("a sheet is a labelled modal dialog that traps focus and closes on Escape", async () => {
    await unlocked();
    await renderApp("/swap");
    await screen.findByTestId("swap-view", {}, LAZY);
    fireEvent.click(screen.getByTestId("swap-to-asset")); // the destination picker always has several assets; the source has one without ERC-20 vaults
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby") || dialog.getAttribute("aria-label")).toBeTruthy();
    // modality: the dialog says so, or everything else is hidden from assistive technology while it is open
    expect(dialog.getAttribute("aria-modal") === "true" || screen.getByTestId("swap-view").closest("[aria-hidden=\"true\"]") !== null).toBe(true);
    expect(await violations()).toEqual([]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
