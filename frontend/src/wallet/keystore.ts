// Encrypted keystore + recovery phrase (plan §44). While the wallet is unlocked the master seed lives
// in memory only; at rest nothing but this ciphertext exists: scrypt(password) → XChaCha20-Poly1305
// over the 32-byte seed, so TC-01 (no raw secret in dapp-origin storage) still holds. The recovery
// phrase is the BIP-39 encoding of the same 32 bytes (24 words): a phrase restores exactly the seed
// that derives every key (pool keys, privacy address, chain keys, one-time order keys).
import { scryptAsync } from "@noble/hashes/scrypt";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

export interface KdfParams { N: number; r: number; p: number }
export interface Keystore { v: 1; kdf: KdfParams & { name: "scrypt"; dkLen: 32 }; salt: string; nonce: string; ct: string }

/** 64 MiB, about a second in a browser; tests pass a smaller N. */
export const KDF_DEFAULT: KdfParams = { N: 1 << 16, r: 8, p: 1 };
export const SEED_BYTES = 32;
const AAD = utf8ToBytes("privacy-protocol/v1/keystore");

async function deriveKey(password: string, salt: Uint8Array, p: KdfParams): Promise<Uint8Array> {
  if (!(p.N >= 1 << 10 && Number.isInteger(Math.log2(p.N)) && p.r >= 1 && p.p >= 1)) throw new Error("unsafe KDF parameters");
  return scryptAsync(utf8ToBytes(password.normalize("NFKD")), salt, { N: p.N, r: p.r, p: p.p, dkLen: 32 });
}

export async function createKeystore(seed: Uint8Array, password: string, params: KdfParams = KDF_DEFAULT, rng: (n: number) => Uint8Array = randomBytes): Promise<Keystore> {
  if (seed.length !== SEED_BYTES) throw new Error(`the seed must be ${SEED_BYTES} bytes`);
  if (!password) throw new Error("a password is required");
  const salt = rng(16), nonce = rng(24);
  const key = await deriveKey(password, salt, params);
  try {
    const ct = xchacha20poly1305(key, nonce, AAD).encrypt(seed);
    return { v: 1, kdf: { name: "scrypt", N: params.N, r: params.r, p: params.p, dkLen: 32 }, salt: bytesToHex(salt), nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
  } finally {
    key.fill(0);
  }
}

/** The seed, or null when the password is wrong or the keystore was tampered with (AEAD failure). */
export async function unlockKeystore(ks: Keystore, password: string): Promise<Uint8Array | null> {
  if (!ks || ks.v !== 1 || ks.kdf?.name !== "scrypt" || ks.kdf.dkLen !== 32) return null;
  let key: Uint8Array;
  try { key = await deriveKey(password, hexToBytes(ks.salt), ks.kdf); } catch { return null; }
  try {
    const seed = xchacha20poly1305(key, hexToBytes(ks.nonce), AAD).decrypt(hexToBytes(ks.ct));
    return seed.length === SEED_BYTES ? seed : null;
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

/** The 24-word recovery phrase of a 32-byte seed (BIP-39, English). */
export function seedToPhrase(seed: Uint8Array): string {
  if (seed.length !== SEED_BYTES) throw new Error(`the seed must be ${SEED_BYTES} bytes`);
  return entropyToMnemonic(seed, wordlist);
}

/** The seed a recovery phrase encodes; throws on a mistyped or short phrase. Whitespace and case are normalized. */
export function phraseToSeed(phrase: string): Uint8Array {
  const norm = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  if (norm.split(" ").length !== 24) throw new Error("the recovery phrase has 24 words");
  if (!validateMnemonic(norm, wordlist)) throw new Error("not a valid recovery phrase (a word is misspelt or the checksum fails)");
  const entropy = mnemonicToEntropy(norm, wordlist);
  if (entropy.length !== SEED_BYTES) throw new Error("the phrase does not encode a 32-byte seed");
  return entropy;
}
