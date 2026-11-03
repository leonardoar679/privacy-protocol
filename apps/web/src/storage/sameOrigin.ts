// What another application on this origin keeps in the browser's storage, removed at a Forget (the fifth review round,
// 2026-11-03): Tornado Classic's locale key, the one entry it writes to localStorage (classic/src/storage/prefs.ts). Spec §8:
// only this directory touches the browser's storage, so the platform's forget asks here.
export function removeLocalStorageKey(key: string, store: Storage | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    store?.removeItem(key);
  } catch {
    // no storage, or unreadable: nothing to remove
  }
}
