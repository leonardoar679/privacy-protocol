// The message catalog (spec §19): `t(key, vars)` over the English table and the partial tables of the other locales,
// which fall back to English key by key. The locale comes from the prefs (Stage 2) or the browser (Stage 11);
// a `{name}` placeholder is filled from `vars` and left as it is when absent, so a missing value shows itself.
import { en, type MessageKey } from "./en";

export type Catalog = Partial<Record<MessageKey, string>>;
export type Vars = Record<string, string | number>;

const catalogs: Record<string, Catalog> = { en };
let current = "en";
const listeners = new Set<() => void>();

export function registerCatalog(locale: string, catalog: Catalog): void { catalogs[locale] = catalog; }
export const getLocale = (): string => current;
export function setLocale(locale: string): void {
  if (locale === current) return;
  current = locale;
  for (const l of listeners) l();
}
export function subscribeLocale(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

export function format(template: string, vars?: Vars): string {
  return vars ? template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : template;
}

export function t(key: MessageKey, vars?: Vars, locale: string = current): string {
  const base = locale.split("-")[0];
  const s = catalogs[locale]?.[key] ?? catalogs[base]?.[key] ?? en[key];
  return format(s, vars);
}

export { en, type MessageKey };
