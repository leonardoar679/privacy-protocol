// The three keys of the secure store (spec §8; docs/wallet-formats.md §2) — part of the wallet's format, so they live with
// the engine (V6 Stage 4); the platform's store, the guard and the migration read them from here. No imports.
export const KEYSTORE_KEY = "pp.keystore";
export const JOURNAL_KEY = "pp.journal";
/** A journal that would not decrypt at unlock, set aside here (still encrypted) when the user chooses to start a fresh one; never overwritten silently. */
export const UNREADABLE_JOURNAL_KEY = "pp.journal.unreadable";
export const SECURE_KEYS: readonly string[] = [KEYSTORE_KEY, JOURNAL_KEY, UNREADABLE_JOURNAL_KEY];
