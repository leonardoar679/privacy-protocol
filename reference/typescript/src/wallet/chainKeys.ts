// Chain Key Abstraction (plan §45): EVM, Bitcoin and Solana signers and fresh addresses from the one
// master secret, so the wallet can hand out one-time destinations (§28, §46) and per-dApp accounts
// (§37) without the PrivacyCore ever knowing about other chains. Standard derivations, so the 24-word
// phrase restores the same addresses in any other wallet:
//   EVM      BIP-44   m/44'/60'/0'/0/i            secp256k1 → keccak address (EIP-55 checksum)
//   Bitcoin  BIP-84   m/84'/0'/0'/change/i         secp256k1 → P2WPKH, bech32 "bc1q…"
//   Solana   SLIP-0010 ed25519  m/44'/501'/i'/0'   → base58(public key)   (Phantom / solana-keygen layout)
// Root = BIP-32 master key of the BIP-39 seed of the phrase (empty passphrase). Pinned against the
// BIP-84 and SLIP-0010 test vectors in test/vectors/chainkeys.json.
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { base58, bech32 } from "@scure/base";
import { hmac } from "@noble/hashes/hmac";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";

export type ChainKind = "evm" | "bitcoin" | "solana";

export interface ChainAccount {
  chain: ChainKind;
  index: number;
  path: string;
  address: string;
  publicKey: Uint8Array; // compressed secp256k1 (33 bytes) or ed25519 (32 bytes)
  privateKey: Uint8Array; // 32 bytes; never persisted, re-derived on demand
}

/** The 64-byte BIP-39 seed of a recovery phrase (PBKDF2; ~50 ms). Callers cache it while unlocked. */
export const bip39Seed = (phrase: string, passphrase = ""): Uint8Array => mnemonicToSeedSync(phrase, passphrase);

const HARDENED = 0x80000000;

// ---- EVM ----
export function eip55(addressHex20: Uint8Array): string {
  const lower = bytesToHex(addressHex20);
  const h = bytesToHex(keccak_256(utf8ToBytes(lower)));
  return "0x" + [...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

function evmFromSecp(privateKey: Uint8Array): { address: string; publicKey: Uint8Array } {
  const uncompressed = secp256k1.getPublicKey(privateKey, false).subarray(1);
  return { address: eip55(keccak_256(uncompressed).subarray(12)), publicKey: secp256k1.getPublicKey(privateKey, true) };
}

export function evmAccount(seed64: Uint8Array, index: number): ChainAccount {
  const path = `m/44'/60'/0'/0/${index}`;
  const k = HDKey.fromMasterSeed(seed64).derive(path);
  if (!k.privateKey) throw new Error("no private key at " + path);
  return { chain: "evm", index, path, privateKey: k.privateKey, ...evmFromSecp(k.privateKey) };
}

/** Per-dApp account index (plan §37): the same origin always gets the same fresh account, two origins never share one. */
export function dappAccountIndex(origin: string): number {
  const h = keccak_256(concatBytes(utf8ToBytes("privacy-protocol/v1/dapp"), utf8ToBytes(origin.trim().toLowerCase())));
  return (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) & 0x7fffffff; // < 2^31: a non-hardened index
}
export const dappAccount = (seed64: Uint8Array, origin: string): ChainAccount & { origin: string } => ({ ...evmAccount(seed64, dappAccountIndex(origin)), origin });

// ---- Bitcoin ----
export function p2wpkhAddress(compressedPublicKey: Uint8Array, hrp = "bc"): string {
  const hash160 = ripemd160(sha256(compressedPublicKey));
  return bech32.encode(hrp, [0, ...bech32.toWords(hash160)]);
}

export function bitcoinAccount(seed64: Uint8Array, index: number, change: 0 | 1 = 0, hrp = "bc"): ChainAccount {
  const path = `m/84'/0'/0'/${change}/${index}`;
  const k = HDKey.fromMasterSeed(seed64).derive(path);
  if (!k.privateKey) throw new Error("no private key at " + path);
  return { chain: "bitcoin", index, path, privateKey: k.privateKey, publicKey: k.publicKey!, address: p2wpkhAddress(k.publicKey!, hrp) };
}

// ---- Solana (SLIP-0010, ed25519: hardened children only) ----
export function slip10Ed25519(seed: Uint8Array, hardenedPath: number[]): { privateKey: Uint8Array; chainCode: Uint8Array } {
  let I = hmac(sha512, utf8ToBytes("ed25519 seed"), seed);
  let key = I.slice(0, 32), chain = I.slice(32);
  for (const i of hardenedPath) {
    const idx = (i >>> 0) >= HARDENED ? i >>> 0 : (i + HARDENED) >>> 0;
    const data = new Uint8Array(1 + 32 + 4);
    data.set(key, 1);
    data[33] = idx >>> 24; data[34] = (idx >>> 16) & 0xff; data[35] = (idx >>> 8) & 0xff; data[36] = idx & 0xff;
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32); chain = I.slice(32);
  }
  return { privateKey: key, chainCode: chain };
}

/** Parse "m/44'/501'/0'/0'" into hardened indexes; every component must be hardened for ed25519. */
export function parseHardenedPath(path: string): number[] {
  const parts = path.split("/");
  if (parts[0] !== "m") throw new Error("path must start with m");
  return parts.slice(1).map((p) => {
    const m = /^(\d+)(['Hh])$/.exec(p);
    if (!m) throw new Error(`ed25519 derivation needs hardened components, got ${p}`);
    return Number(m[1]);
  });
}

export function solanaAccount(seed64: Uint8Array, index: number): ChainAccount {
  const path = `m/44'/501'/${index}'/0'`;
  const { privateKey } = slip10Ed25519(seed64, parseHardenedPath(path));
  const publicKey = ed25519.getPublicKey(privateKey);
  return { chain: "solana", index, path, privateKey, publicKey, address: base58.encode(publicKey) };
}

export function accountFor(chain: ChainKind, seed64: Uint8Array, index: number): ChainAccount {
  return chain === "evm" ? evmAccount(seed64, index) : chain === "bitcoin" ? bitcoinAccount(seed64, index) : solanaAccount(seed64, index);
}

/** Loose shape checks for destinations the user types (the real check is the derivation when it is ours). */
export function looksLikeAddress(chain: ChainKind, s: string): boolean {
  if (chain === "evm") return /^0x[0-9a-fA-F]{40}$/.test(s);
  if (chain === "bitcoin") { try { const d = bech32.decode(s.toLowerCase() as `${string}1${string}`, 90); return d.prefix === "bc" && d.words[0] === 0 && bech32.fromWords(d.words.slice(1)).length === 20; } catch { return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(s); } }
  try { return base58.decode(s).length === 32; } catch { return false; }
}
