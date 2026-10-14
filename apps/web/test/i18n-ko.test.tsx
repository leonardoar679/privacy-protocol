// @vitest-environment jsdom
// Korean (spec v2.0 §18; doc §78; V6 Stage 16): the catalog has every English key, each with the English placeholders
// (a plural ending excepted) and none of the words the wallet never uses; it is its own chunk, in memory only once a
// Korean reader needs it; every Simple screen rendered in Korean shows no English word beyond names, symbols and
// units; the picker under More → Language (Automatic, English, 한국어) writes the preference, and the catalog, the
// document's lang and Intl follow — English chosen on a Korean device stays English.
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetLabels } from "@privacy-wallet/ui";
import { LIMITS } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { en } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { catalogReady, loadCatalog } from "../src/app/i18n/catalogs";
import { getLocale, setLocale, t } from "../src/app/i18n/messages";
import { formatCount, formatDate, intlLocale } from "../src/app/i18n/intl";
import { applyLocale } from "../src/app/i18n/locale";
import { prefs } from "../src/storage/prefs";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { FIXTURES } from "../src/fixtures/registry";
import { groupByDay, type ActivityRow } from "../src/features/activity/rows";
import { LIMIT_KEYS } from "../src/features/privacy-center/View";
import { renderApp } from "./helpers/render";

const nav = navigator as unknown as { languages: readonly string[] };
const browserLanguages = (languages: readonly string[]) => Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
const original = nav.languages;
afterEach(() => {
  cleanup();
  setLocale("en");
  resetLabels();
  prefs().reset();
  session.forget();
  settings.reset();
  browserLanguages(original);
});

const placeholders = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);
/** Names, symbols and units a Korean screen keeps as they are (proper names of networks, assets and services). */
const NAMES = ["USD Coin", "Tether USD", "Wrapped Ether"];
const KEPT = new Set([
  "IP",
  "Tor",
  "ETH",
  "USDC",
  "USDT",
  "BTC",
  "WETH",
  "DAI",
  "SOL",
  "USD",
  "RPC",
  "API",
  "EVM",
  "AI",
  "ID",
  "JSON",
  "Ethereum",
  "Bitcoin",
  "Solana",
  "Base",
  "Arbitrum",
  "Optimism",
  "Sepolia",
  "THORChain",
  "THORNode",
  "Chainlink",
  "Chainflip",
  "NEAR",
  "LI.FI",
  "Face",
  "Touch",
  "Windows",
  "Hello",
  "bps",
  "tx",
  "REPLACE",
  "FORGET",
]);

describe("Korean (spec v2.0 §18, doc §78)", () => {
  it("is its own chunk: not in memory until a Korean reader needs it (an English reader never downloads it)", async () => {
    expect(catalogReady("en")).toBe(true);
    expect(catalogReady("ko"), "nothing loaded it yet").toBe(false);
    const catalogs = readFileSync(join(__dirname, "..", "src", "app", "i18n", "catalogs.ts"), "utf8");
    expect(catalogs).toContain('import("./ko")');
    expect(catalogs).not.toMatch(/from "\.\/ko"/);
    await loadCatalog("ko");
    expect(catalogReady("ko")).toBe(true);
    expect(t("nav.home", undefined, "ko")).toBe("홈");
  });

  it("has every English key, each with the English placeholders (no plural ending), and translates every sentence", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      const e = placeholders(en[k]);
      const kk = placeholders(ko[k]);
      for (const p of kk) expect(e.has(p), `${k}: ${p} is not an English placeholder`).toBe(true);
      for (const p of e) if (p !== "{plural}") expect(kk.has(p), `${k} lacks ${p}`).toBe(true);
      expect(kk.has("{plural}"), `${k}: Korean has no plural ending`).toBe(false);
      expect(ko[k].trim(), k).not.toBe("");
      // a value left as the English is only one with no word to translate ("{n}", "tx {hash}", "REPLACE")
      if (ko[k] === en[k]) expect(en[k].replace(/\{\w+\}/g, "").replace(/\b(REPLACE|FORGET|tx)\b/g, ""), k).not.toMatch(/[A-Za-z]{3,}/);
    }
  });

  it("never uses the words the wallet never uses, says only that the settlement is not atomic, and keeps the typed words", () => {
    const NEVER = ["익명", "믹서", "믹싱", "추적 불가", "추적할 수 없", "보이지 않", "탐지 불가", "탐지할 수 없", "감지 불가", "감지할 수 없"];
    for (const [k, v] of Object.entries(ko)) {
      for (const w of NEVER) expect(v.includes(w), `${k} uses ${w}`).toBe(false);
      if (v.includes("원자적")) expect(v, k).toMatch(/원자적이지 않/);
    }
    expect(ko["screen.review.notAtomic"]).toMatch(/원자적이지 않습니다/);
    // the confirmation compares the typed word itself (Lock.tsx, Security.tsx)
    expect(ko["lock.replacePlaceholder"]).toBe("REPLACE");
    expect(ko["lock.replaceWarning"]).toContain("REPLACE");
    expect(ko["security.forget.body"]).toContain("FORGET");
    expect(ko["security.forget.typeWord"]).toContain("FORGET");
  });

  it("every Simple screen in Korean shows no English word beyond names, symbols and units", async () => {
    await loadCatalog("ko");
    prefs().update({ locale: "ko", localeChosen: true });
    expect(applyLocale(), "the catalog and the design system's words").toBe("ko");
    const screens = FIXTURES.filter((f) => f.kind === "screen" && f.simple && !f.id.startsWith("shell"));
    expect(screens.length).toBeGreaterThan(25);
    const leaks: string[] = [];
    for (const f of screens) {
      const { container, unmount } = render(<>{f.render()}</>);
      const main = container.querySelector("main") ?? container;
      // text node by node (adjacent elements do not run together), what a reader reads (not an aria-hidden glyph)
      const nodes: string[] = [];
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest("[aria-hidden='true']")) nodes.push(n.textContent ?? "");
      const words = nodes.flatMap((x) => {
        let text = x
          .replace(/0x[0-9a-fA-F]+(…[0-9a-fA-F]+)?/g, " ")
          .replace(/\b(bc1|tb1)[0-9a-z…]+/g, " ")
          .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/g, " ");
        for (const name of NAMES) text = text.split(name).join(" ");
        return text.match(/[A-Za-z][A-Za-z.]*[A-Za-z]|[A-Za-z]/g) ?? [];
      });
      const english = [...new Set(words.filter((w) => !KEPT.has(w)))];
      if (english.length) leaks.push(`${f.id}: ${english.join(", ")}`);
      unmount();
    }
    expect(leaks).toEqual([]);
  });

  it("the wallet's limits are the protocol's, said in the reader's language", async () => {
    expect(LIMIT_KEYS.map((k) => en[k])).toEqual([...LIMITS]);
    for (const k of LIMIT_KEYS) expect(ko[k]).toMatch(/[가-힣]/);
  });

  it("numbers, dates and the days of Activity are written in the wallet's language (Intl)", async () => {
    await loadCatalog("ko");
    setLocale("ko");
    expect(intlLocale()).toBe("ko-KR");
    expect(formatDate(Date.UTC(2026, 9, 1, 12))).toMatch(/2026\. 10\. 1\./);
    expect(formatCount(1234567)).toBe("1,234,567");
    const now = Date.UTC(2026, 9, 14, 12);
    const row = (at: number) => ({ id: String(at), at }) as unknown as ActivityRow;
    const groups = groupByDay([row(now), row(now - 86_400_000), row(Date.UTC(2026, 9, 1, 12))], (k) => t(k), now, intlLocale());
    expect(groups.map((g) => g.label)).toEqual(["오늘", "어제", "2026년 10월 1일"]);
    setLocale("en");
    expect(intlLocale()).toBe("en-US");
  });

  it("More → Language: Automatic follows the device, an explicit choice wins — English on a Korean device stays English", async () => {
    browserLanguages(["ko-KR", "en-US"]);
    await session.create("a strong password");
    session.acknowledgePhrase();
    prefs().update({ firstLaunchDone: true });
    await renderApp("/more/language");
    // Automatic: the device is Korean, so the wallet is (once the Korean chunk has loaded)
    await waitFor(() => expect(document.documentElement.lang).toBe("ko"));
    expect(await screen.findByTestId("language")).toHaveTextContent("언어");
    expect(screen.getByTestId("language-auto")).toHaveAttribute("aria-checked", "true");
    // English, chosen
    fireEvent.click(screen.getByTestId("language-en"));
    expect(prefs().get()).toMatchObject({ locale: "en", localeChosen: true });
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(getLocale()).toBe("en");
    expect(screen.getByTestId("language")).toHaveTextContent("Language");
    expect(applyLocale(), "the device's Korean does not override the choice").toBe("en");
    // Automatic again: the device decides
    fireEvent.click(screen.getByTestId("language-auto"));
    expect(prefs().get().localeChosen).toBeUndefined();
    await waitFor(() => expect(document.documentElement.lang).toBe("ko"));
    // 한국어 on an English device
    browserLanguages(["en-US"]);
    fireEvent.click(screen.getByTestId("language-ko"));
    expect(prefs().get()).toMatchObject({ locale: "ko", localeChosen: true });
    await waitFor(() => expect(getLocale()).toBe("ko"));
    expect(document.documentElement.lang).toBe("ko");
    expect(screen.getByTestId("language-ko").closest("label")).toHaveTextContent("한국어");
  });
});
