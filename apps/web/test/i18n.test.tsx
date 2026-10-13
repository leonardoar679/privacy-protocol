// @vitest-environment happy-dom
// Localization (spec §19; Stage 11): the locale from the browser's languages, an explicit preference, a `?locale=`
// query; the catalogs typed against the English table (no stray key); every English key is referenced by the
// screens (a dead key fails); the pseudo-locale lengthens and accents every string while keeping placeholders, and
// the screens render it without an English leak; the document's lang follows.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { chooseLocale, detectLocale, SUPPORTED } from "../src/app/i18n/detect";
import { pseudoCatalog, pseudoLocalize } from "../src/app/i18n/pseudo";
import { CATALOGS, registerCatalogs, strayKeys } from "../src/app/i18n/catalogs";
import { en } from "../src/app/i18n/en";
import { getLocale, setLocale, t } from "../src/app/i18n/messages";
import { applyLocale } from "../src/app/Providers";
import { prefs } from "../src/storage/prefs";
import { Welcome } from "../src/features/onboarding/Welcome";
import { MemoryRouter } from "react-router-dom";

afterEach(() => { cleanup(); setLocale("en"); prefs().reset(); });

const SRC = join(__dirname, "..", "src");
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !p.endsWith(join("i18n", "en.ts")) && !p.endsWith(join("i18n", "catalogs.ts"))) out.push(readFileSync(p, "utf8"));
  }
  return out;
}

describe("the locale (spec §19)", () => {
  it("is the first browser language with a catalog, by base language; English otherwise", () => {
    expect(detectLocale(["ko-KR", "en-US"])).toBe("ko");
    expect(detectLocale(["de-DE", "zh-Hans-CN"])).toBe("zh");
    expect(detectLocale(["JA"])).toBe("ja");
    expect(detectLocale(["fr-FR", "de"])).toBe("en");
    expect(detectLocale(undefined)).toBe("en");
    expect(SUPPORTED).toEqual(["en", "ko", "zh", "ja"]);
  });
  it("the query wins (and admits the pseudo-locale), then a preference other than the default, then the browser", () => {
    expect(chooseLocale({ query: "pseudo", prefs: "ko", languages: ["ja"] })).toBe("pseudo");
    expect(chooseLocale({ query: "ZH", prefs: "ko", languages: ["ja"] })).toBe("zh");
    expect(chooseLocale({ query: "xx", prefs: "ko", languages: ["ja"] })).toBe("ko");
    expect(chooseLocale({ prefs: "en", languages: ["ja"] }), "the default English is not a choice").toBe("ja");
    expect(chooseLocale({ prefs: "ja-JP", languages: ["ko"] })).toBe("ja");
    expect(chooseLocale({ languages: ["pt-BR"] })).toBe("en");
  });
  it("the catalogs carry only English keys and fall back key by key; the document's lang follows the locale applied from the prefs", () => {
    registerCatalogs();
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      expect(strayKeys(catalog), locale).toEqual([]);
      expect(Object.keys(catalog).length).toBeGreaterThanOrEqual(20);
      expect(t("nav.home", undefined, locale)).not.toBe(en["nav.home"]);
      expect(t("security.forget.confirm", undefined, locale), "a missing key falls back to English").toBe(en["security.forget.confirm"]);
    }
    prefs().update({ locale: "ko" });
    expect(applyLocale()).toBe("ko");
    expect(getLocale()).toBe("ko");
    expect(document.documentElement.lang).toBe("ko");
    prefs().update({ locale: "en" });
    expect(applyLocale(), "the browser decides again (happy-dom: en-US)").toBe("en");
  });
  it("every English key is referenced by the sources (a literal or a template prefix): no dead key", () => {
    const src = sources(SRC).join("\n");
    // a key built from a template: `op.state.${state}` (recovery.ts) or t(`op.error.${code}.title`): its dotted prefix counts
    const prefixes = [...src.matchAll(/`([a-zA-Z0-9]+(?:\.[a-zA-Z0-9-]+)*\.)\$\{/g)].map((m) => m[1]);
    const dead = Object.keys(en).filter((k) => !src.includes(`"${k}"`) && !src.includes(`'${k}'`) && !prefixes.some((p) => k.startsWith(p)));
    expect(dead).toEqual([]);
    expect(prefixes).toEqual(expect.arrayContaining(["op.error.", "op.state.", "privacyCenter.level.", "wallet.status."]));
  });
  it("the pseudo-locale lengthens and accents every string, keeps placeholders and the marks, and the screens render it without an English leak", () => {
    expect(pseudoLocalize("Send {amount} now")).toBe("[Šéñđ {amount} ñóŵ ~~~]");
    expect(pseudoLocalize("✓ Protected · 12 %")).toBe("[✓ Þřóţéçţéđ · 12 % ~~~]");
    expect(pseudoLocalize("a".repeat(40)), "the lengthening wraps: groups of three, never one run").toBe("[" + "á".repeat(40) + " ~~~ ~~~ ~~~ ~~~ ~~~]");
    expect(pseudoLocalize("")).toBe("[]");
    const cat = pseudoCatalog(en);
    expect(Object.keys(cat)).toEqual(Object.keys(en));
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(cat[k]!.length).toBeGreaterThanOrEqual(en[k].length + 2);
      for (const ph of en[k].match(/\{\w+\}/g) ?? []) expect(cat[k]).toContain(ph);
    }
    registerCatalogs();
    setLocale("pseudo");
    render(<MemoryRouter><Welcome /></MemoryRouter>);
    const welcome = screen.getByTestId("welcome");
    expect(welcome.textContent).toContain(pseudoLocalize(en["welcome.title"]));
    expect(welcome.textContent).not.toContain(en["welcome.title"]);
    expect(welcome.textContent).not.toContain(en["welcome.connect"]);
  });
});
