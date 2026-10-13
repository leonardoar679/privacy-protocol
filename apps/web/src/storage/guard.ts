// The TC-01 guard on both stores (spec §8): a key whose name looks like a secret is refused (the V1 rule from
// keys/wallet.ts), a `secure` value that is not shaped like the encrypted keystore or the encrypted journal is
// refused, and a prefs value outside its schema is refused (prefs.ts). Shapes only: no value is decrypted here.
import { assertNotPersistingSecret } from "@privacy-wallet/sdk/keys/wallet";
import { JOURNAL_KEY, KEYSTORE_KEY, UNREADABLE_JOURNAL_KEY } from "./keys";

export { assertNotPersistingSecret };

const HEX = /^[0-9a-fA-F]+$/;
const isHex = (x: unknown, min = 2): x is string => typeof x === "string" && x.length >= min && HEX.test(x);

/** The encrypted keystore of docs/wallet-formats.md §2: {v, kdf{name, N, r, p, dkLen}, salt, nonce, ct}, every secret under the cipher. */
export function isKeystoreShaped(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const k = x as Record<string, unknown>;
  const kdf = k.kdf as Record<string, unknown> | undefined;
  return k.v === 1 && !!kdf && typeof kdf === "object" && typeof kdf.name === "string" && typeof kdf.N === "number" && typeof kdf.r === "number" && typeof kdf.p === "number"
    && isHex(k.salt) && isHex(k.nonce) && isHex(k.ct);
}

/** The encrypted journal: {v, nonce, ct}. */
export function isJournalShaped(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  const j = x as Record<string, unknown>;
  return j.v === 1 && isHex(j.nonce) && isHex(j.ct) && Object.keys(j).every((key) => key === "v" || key === "nonce" || key === "ct");
}

/** Refuses a write to the secure store that is not one of the two ciphertext shapes under its known key. */
export function assertSecureShape(key: string, value: string): void {
  assertNotPersistingSecret(key);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`Refusing to persist a non-JSON value under "${key}" (TC-01 guard: ciphertext only).`); }
  if (key === KEYSTORE_KEY) { if (!isKeystoreShaped(parsed)) throw new Error(`Refusing to persist "${key}": not an encrypted keystore (TC-01 guard).`); return; }
  if (key === JOURNAL_KEY || key === UNREADABLE_JOURNAL_KEY) { if (!isJournalShaped(parsed)) throw new Error(`Refusing to persist "${key}": not an encrypted journal (TC-01 guard).`); return; }
  throw new Error(`Refusing to persist an unknown key "${key}" in the secure store (TC-01 guard).`);
}
