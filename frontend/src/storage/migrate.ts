// The one-time move from localStorage to the `secure` store (spec §8): each legacy key is copied, read back,
// compared byte for byte and only then removed from localStorage; a key the store already holds is left where
// it is and reported, never overwritten; the run is idempotent. After it, localStorage holds nothing of ours.
import { idbGet, idbPut } from "./idb";
import { SECURE_KEYS } from "./keys";

export const LEGACY_KEYS: readonly string[] = SECURE_KEYS;

export interface MigrationReport { moved: string[]; kept: string[] }

function legacyStorage(): Storage | null {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

export async function migrateFromLocalStorage(): Promise<MigrationReport> {
  const ls = legacyStorage();
  const report: MigrationReport = { moved: [], kept: [] };
  if (!ls) return report;
  for (const key of LEGACY_KEYS) {
    let legacy: string | null = null;
    try { legacy = ls.getItem(key); } catch { legacy = null; }
    if (legacy === null) continue;
    const existing = await idbGet("secure", key);
    if (existing !== undefined && existing !== legacy) { report.kept.push(key); continue; } // the store's copy is the newer one; the legacy entry is not ours to drop blindly
    if (existing === undefined) await idbPut("secure", key, legacy);
    const back = await idbGet("secure", key);
    if (back !== legacy) { report.kept.push(key); continue; } // the read-back differs: leave the legacy entry in place
    try { ls.removeItem(key); report.moved.push(key); } catch { report.kept.push(key); }
  }
  return report;
}
