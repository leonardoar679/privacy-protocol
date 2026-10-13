// Test helpers over the storage layer: the public surface plus a raw read of the `secure` store's entries.
import { idbEntries } from "../../src/storage/idb";
export { assertSecureShape, createPrefsStore, createSecureStore, JOURNAL_KEY, KEYSTORE_KEY, resetDbCache, resetPrefsStore, resetSecureStore, secureStore, UNREADABLE_JOURNAL_KEY } from "../../src/storage";

/** The `secure` store's entries sorted by key. */
export async function idbEntriesForTest(): Promise<[string, string][]> {
  return (await idbEntries("secure")).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
