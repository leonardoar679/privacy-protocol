// The artifacts kept on the device between visits (spec v3.0 §7.3): Cache Storage, one entry per artifact keyed by its
// URL and pinned sha256, so a new pin never reads an old file. Public data only — never a note, never a proof. Every
// failure (no Cache Storage, a private window, a full store) means "fetch again".
const CACHE = "tornado-classic-artifacts-v1";
const key = (url: string, sha256: string) => `${url}?sha256=${sha256}`;
const available = () => typeof caches !== "undefined";

export async function cachedArtifact(url: string, sha256: string): Promise<Uint8Array | null> {
  if (!available()) return null;
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key(url, sha256));
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function storeArtifact(url: string, sha256: string, bytes: Uint8Array): Promise<void> {
  if (!available()) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(key(url, sha256), new Response(bytes as BodyInit, { headers: { "content-type": "application/octet-stream" } }));
  } catch {
    // the next visit fetches again
  }
}

export async function forgetArtifact(url: string, sha256: string): Promise<void> {
  if (!available()) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.delete(key(url, sha256));
  } catch {
    // nothing to forget
  }
}
