// What another application on this origin keeps in the browser's storage, removed at a Forget (the fifth review round,
// 2026-11-03): Tornado Classic's locale key, the one entry it writes to localStorage (classic/src/storage/prefs.ts). Spec §8:
// only this directory touches the browser's storage, so the platform's forget asks here.
/** Every key with this prefix (the ninth review round, B-F6: the zkAPI SDK keeps more than one). */
export function removeLocalStorageKeysWithPrefix(prefix: string, store: Storage | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < (store?.length ?? 0); i++) {
      const k = store!.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) store!.removeItem(k);
  } catch {
    // no storage, or unreadable: nothing to remove
  }
}

export function removeLocalStorageKey(key: string, store: Storage | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    store?.removeItem(key);
  } catch {
    // no storage, or unreadable: nothing to remove
  }
}
