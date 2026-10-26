// The geofence probe (spec v3.0 §7.7; behind CLASSIC_GEOFENCE): one HEAD request to the configured URL; the status code
// back (451 is the host's block), null when nothing answered.
export async function probeGeofence(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5_000): Promise<number | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "HEAD", cache: "no-store", credentials: "omit", signal: ctl.signal });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
