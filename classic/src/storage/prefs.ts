// The Classic app's preferences (spec v3.0 §7.8): the only module that touches the browser's storage, and it stores
// preferences alone — never a note, never a deposit, never a recipient (the note is the only key to a deposit, and it
// never rests on the device; spec §7.11). Stage 3 keeps one preference, the language. The public caches (the history
// snapshots) arrive with Stage 7 in the app's own IndexedDB.
const LOCALE_KEY = "tornado-classic:locale";

export type StoredLocale = "auto" | "en" | "ko";

/** The language the user chose, or "auto" (the browser's). A refused storage reads as "auto". */
export function readLocaleChoice(): StoredLocale {
  try {
    const v = window.localStorage.getItem(LOCALE_KEY);
    return v === "en" || v === "ko" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function writeLocaleChoice(v: StoredLocale): void {
  try {
    if (v === "auto") window.localStorage.removeItem(LOCALE_KEY);
    else window.localStorage.setItem(LOCALE_KEY, v);
  } catch {
    // storage refused (a private window, a quota): the choice lives for this page only
  }
}

/** The keys this module may ever write — the tests check nothing else lands in storage. */
export const STORAGE_KEYS: readonly string[] = [LOCALE_KEY];
