// The Classic catalogs (spec v3.0 §7.9): Korean complete against English, the placeholders alike, the original's labels
// kept, no promise word in either; the message layer's plural and duration helpers speak the original's words.
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { depositsCount, detectLocale, passedWords, setLocale, t } from "../src/app/i18n/messages";
import { scan } from "../scripts/words.mjs";

afterEach(() => setLocale("en"));

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe("the Classic catalogs (spec v3.0 §7.9)", () => {
  it("Korean has every English key, no more, each with the same placeholders and never empty", () => {
    const enKeys = Object.keys(en).sort();
    expect(Object.keys(ko).sort()).toEqual(enKeys);
    for (const k of enKeys as (keyof typeof en)[]) {
      expect(placeholders(ko[k]), k).toEqual(placeholders(en[k]));
      expect(ko[k].trim(), k).not.toBe("");
    }
    expect(enKeys.length).toBeGreaterThan(120);
  });

  it("keeps the original interface's labels", () => {
    const values = Object.values(en) as string[];
    for (const label of [
      "Deposit",
      "Withdraw",
      "Your private note",
      "I backed up the note",
      "Send Deposit",
      "Time passed",
      "Subsequent deposits",
      "Recipient Address",
      "Relayer fee",
      "Network fee",
      "Total fee",
      "Tokens to receive",
      "Generating proof",
      "Withdrawal Confirmation",
      "Anonymity set",
      "Latest deposits",
      "Note is invalid",
      "Note has been spent",
      // "There is no related deposit. The note is invalid." is not kept (the tenth review round, C10-2): it called valid notes invalid —
      // the history failed or behind, a deposit of the last minutes — and a bearer note told "invalid" is a note thrown away
    ])
      expect(values, label).toContain(label);
  });

  it("says no promise word in either language, and never names tornado.cash's own channels as this app's", () => {
    expect(scan(Object.values(en).join("\n"))).toEqual([]);
    expect(scan(Object.values(ko).join("\n"))).toEqual([]);
    expect(Object.values(en).join("\n")).not.toMatch(/tornado\.cash developers/i);
  });

  it("t fills placeholders; the plural and duration helpers speak the original's words in both languages", () => {
    setLocale("en");
    expect(t("deposit.pool", { amount: "10" })).toBe("10 ETH pool");
    expect(depositsCount(0)).toBe("no deposits");
    expect(depositsCount(1)).toBe("only 1 deposit");
    expect(depositsCount(431)).toBe("431 deposits");
    expect(depositsCount(12_345)).toBe("12,345 deposits");
    expect(passedWords({ unit: "days", n: 2 })).toBe("2 days");
    expect(passedWords({ unit: "days", n: 1 })).toBe("1 day");
    expect(passedWords({ unit: "hours", n: 1 })).toBe("1 hour");
    expect(passedWords({ unit: "minutes", n: 12 })).toBe("12 minutes");
    setLocale("ko");
    expect(t("nav.deposit")).toBe("입금");
    expect(depositsCount(431)).toBe("입금 431건");
    expect(depositsCount(0)).toBe("입금 없음");
    expect(passedWords({ unit: "days", n: 2 })).toBe("2일");
    expect(passedWords({ unit: "hours", n: 1 })).toBe("1시간");
  });

  it("detects Korean from the browser's language and falls back to English", () => {
    expect(detectLocale("ko-KR")).toBe("ko");
    expect(detectLocale("ko")).toBe("ko");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("fr")).toBe("en");
    expect(detectLocale(undefined)).toBe("en");
  });
});
