// Fetching a pool's history snapshot (spec v3.0 §7.4): the manifest and its three files from where the build serves them
// (`/classic/data/<pool>/` by default), as text — snapshot.ts holds them to the manifest's hashes before anything is
// read from them. One of the app's few fetches.
import type { SnapshotManifest, SnapshotTexts } from "../history/snapshot";

export class SnapshotFetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

export interface FetchedSnapshot {
  manifest: SnapshotManifest;
  texts: SnapshotTexts;
}

/** The snapshot under `${base}/${pool}/`; null when the host serves none (a 404, or a page where the manifest should be). */
export async function fetchSnapshot(base: string, pool: string, fetchImpl: typeof fetch = fetch, timeoutMs = 60_000): Promise<FetchedSnapshot | null> {
  const dir = `${base.replace(/\/+$/, "")}/${pool}`;
  const get = async (name: string): Promise<string | null> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${dir}/${name}`, { cache: "no-store", credentials: "omit", signal: ctl.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new SnapshotFetchError(`${name}: HTTP ${res.status}`, res.status);
      // a page where the file should be — a dev server's fallback to index.html — serves no snapshot
      if (/text\/html/i.test(res.headers.get("content-type") ?? "")) return null;
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  };
  const manifestText = await get("manifest.json");
  if (manifestText === null) return null;
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(manifestText) as SnapshotManifest;
  } catch {
    throw new SnapshotFetchError("manifest.json is not JSON", null);
  }
  const [deposits, withdrawals, tree] = await Promise.all([get("deposits.json"), get("withdrawals.json"), get("tree.json")]);
  if (deposits === null || withdrawals === null || tree === null) throw new SnapshotFetchError("a snapshot file is missing", 404);
  return { manifest, texts: { "deposits.json": deposits, "withdrawals.json": withdrawals, "tree.json": tree } };
}
