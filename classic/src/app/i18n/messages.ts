// The message layer: t(key, params) over the English catalog and the Korean one, the locale chosen in Settings or
// taken from the browser's language; the small plural and duration helpers the original's words need.
import { en } from "./en";
import { ko } from "./ko";
import type { Passed } from "../../model/time";

export type MessageKey = keyof typeof en;
export type Locale = "en" | "ko";
export type LocaleChoice = "auto" | Locale;

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, ko };
let current: Locale = "en";
const listeners = new Set<() => void>();

export function detectLocale(language: string | undefined): Locale {
  return (language ?? "").toLowerCase().startsWith("ko") ? "ko" : "en";
}
export function setLocale(l: Locale): void {
  if (current === l) return;
  current = l;
  listeners.forEach((f) => f());
}
export const locale = (): Locale => current;
export function onLocale(f: () => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** The message of a key in the current locale, with {name} placeholders filled. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let s: string = catalogs[current][key] ?? en[key];
  for (const [k, v] of Object.entries(params ?? {})) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** "no deposits" / "only 1 deposit" / "{n} deposits" (the original's plural). */
export function depositsCount(n: number): string {
  if (n <= 0) return t("withdraw.depositsNone");
  if (n === 1) return t("withdraw.depositsOne");
  return t("withdraw.depositsMany", { n: new Intl.NumberFormat(current === "ko" ? "ko-KR" : "en-US").format(n) });
}

/** "2 days", "1 hour", "12 minutes". */
export function passedWords(p: Passed): string {
  if (p.unit === "days") return p.n === 1 ? t("time.daysOne") : t("time.days", { n: p.n });
  if (p.unit === "hours") return p.n === 1 ? t("time.hoursOne") : t("time.hours", { n: p.n });
  return p.n === 1 ? t("time.minutesOne") : t("time.minutes", { n: p.n });
}

export const intlLocale = (): string => (current === "ko" ? "ko-KR" : "en-US");
