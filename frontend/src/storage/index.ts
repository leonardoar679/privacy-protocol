// The storage layer (spec §8): the secure store (ciphertext only), the prefs store (nothing financial), the guard.
export { createSecureStore, resetSecureStore, secureStore, type SecureStore } from "./secureStore";
export { createPrefsStore, DEFAULT_PREFS, parsePrefs, prefs, PrefsSchema, resetPrefsStore, usePrefs, type Prefs, type PrefsStore } from "./prefs";
export { assertNotPersistingSecret, assertSecureShape, isJournalShaped, isKeystoreShaped } from "./guard";
export { LEGACY_KEYS, migrateFromLocalStorage, type MigrationReport } from "./migrate";
export { DB_NAME, DB_VERSION, hasIndexedDb, resetDbCache } from "./idb";
export { JOURNAL_KEY, KEYSTORE_KEY, SECURE_KEYS, UNREADABLE_JOURNAL_KEY } from "./keys";
