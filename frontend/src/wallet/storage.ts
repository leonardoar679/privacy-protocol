// The only two things this wallet ever writes to dapp-origin storage: the encrypted keystore and the
// encrypted journal (plan §44). Every write passes the TC-01 guard; the raw seed, note secrets and
// phrases never reach here in the clear. localStorage can be absent or blocked (private windows,
// cleared site data), so the browser adapter degrades to memory and the app keeps working.
import { assertNotPersistingSecret } from "../keys/wallet";

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const KEYSTORE_KEY = "pp.keystore";
export const JOURNAL_KEY = "pp.journal";
/** A journal that would not decrypt at unlock, set aside here (still encrypted) when the user chooses to start a fresh one; never overwritten silently. */
export const UNREADABLE_JOURNAL_KEY = "pp.journal.unreadable";

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { assertNotPersistingSecret(k); m.set(k, v); },
    remove: (k) => { m.delete(k); },
  };
}

export function browserStorage(): KeyValueStorage {
  const fallback = memoryStorage();
  const ls = (): Storage | null => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } };
  return {
    get: (k) => { try { return ls()?.getItem(k) ?? fallback.get(k); } catch { return fallback.get(k); } },
    set: (k, v) => { assertNotPersistingSecret(k); try { ls()?.setItem(k, v); } catch { /* blocked: keep in memory */ } fallback.set(k, v); },
    remove: (k) => { try { ls()?.removeItem(k); } catch { /* ignore */ } fallback.remove(k); },
  };
}
