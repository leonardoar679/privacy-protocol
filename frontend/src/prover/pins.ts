// The artifact pins at runtime (Privacy Wallet Web spec §20; Stage 11): the wallet ships public/artifacts.json (written
// by scripts/pin-artifacts.mjs) with the SHA-256 of the proving key and the witness generator it loads; the prover
// worker hashes what it fetched before proving with it. A mismatch is a refusal in a production build and a warning in
// dev (where the circuit may have been rebuilt without re-pinning); no pin at all is "unpinned" — allowed in dev,
// refused in production. Pure: the decision is a function, so the gate can test it without a worker.
export interface ArtifactPins { zkey?: string; wasm?: string }

export type PinVerdict = "match" | "unpinned" | "mismatch";

/** sha256 of bytes as lower-case hex, through WebCrypto (the worker and the main thread both have it). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The verdict for one artifact: its pin (or none) against the hash of the fetched bytes. */
export function verdictOf(pin: string | undefined, actual: string): PinVerdict {
  if (!pin) return "unpinned";
  return pin.toLowerCase() === actual.toLowerCase() ? "match" : "mismatch";
}

/**
 * Enforces a verdict: in production a mismatch or a missing pin refuses to prove (the key would not be the one the build
 * was made for); in dev a mismatch warns and an unpinned artifact passes silently. Returns the verdict it accepted.
 */
export function enforce(name: string, verdict: PinVerdict, o: { production: boolean; warn?: (message: string) => void }): PinVerdict {
  if (verdict === "match") return verdict;
  const message = verdict === "mismatch" ? `${name}: the fetched artifact does not hash to its pin in artifacts.json` : `${name}: no pin in artifacts.json (run scripts/pin-artifacts.mjs)`;
  if (o.production) throw new Error(`refusing to prove — ${message}`);
  o.warn?.(`artifact pins: ${message}; proceeding because this is a development build`);
  return verdict;
}

/** The pins of a build, from the served pin file's shape ({ files: { "<name>": { sha256 } } }). */
export function pinsFromManifest(manifest: unknown): ArtifactPins {
  const files = (manifest as { files?: Record<string, { sha256?: string }> } | null)?.files ?? {};
  return { zkey: files["transaction_final.zkey"]?.sha256, wasm: files["transaction.wasm"]?.sha256 };
}
