// Fetching a pinned artifact (spec v3.0 §7.3): streamed, capped at the pinned size, hashed, and refused unless it hashes
// to its pin — whatever the host serves. The one place the prover reaches the network.
import { sha256Hex } from "../crypto/digest";

export interface ArtifactPin {
  sha256: string;
  bytes: number;
}

export class ArtifactError extends Error {}

export async function fetchVerified(
  url: string,
  pin: ArtifactPin,
  onProgress?: (loaded: number, total: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const name = url.split("/").pop() ?? url;
  const res = await fetchImpl(url, { cache: "no-store", credentials: "omit" });
  if (!res.ok) throw new ArtifactError(`${name}: HTTP ${res.status}`);
  const out = new Uint8Array(pin.bytes);
  let loaded = 0;
  const take = (chunk: Uint8Array) => {
    if (loaded + chunk.length > pin.bytes) throw new ArtifactError(`${name}: longer than its pin (${pin.bytes} bytes)`);
    out.set(chunk, loaded);
    loaded += chunk.length;
    onProgress?.(loaded, pin.bytes);
  };
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      take(value);
    }
  } else take(new Uint8Array(await res.arrayBuffer()));
  if (loaded !== pin.bytes) throw new ArtifactError(`${name}: ${loaded} bytes, the pin says ${pin.bytes}`);
  const sha = await sha256Hex(out);
  if (sha !== pin.sha256) throw new ArtifactError(`${name}: does not hash to its pin`);
  return out;
}
