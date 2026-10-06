// Wallet-side key material (spec §42–44). THE RULE: the raw spending secret / master seed is NEVER
// written to dapp-origin localStorage (the direct fix for TC-01). This stub keeps the seed in
// memory only; a real wallet uses an OS keystore / hardware-backed key / encrypted backup.
import { keccak256, type Hex } from "viem";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const enc = new TextEncoder();

export interface WalletKeys {
  spendKey: bigint; // owner nullifier key — authorizes spends
  viewKey: bigint; // scans/decrypts incoming notes
  noteKey: bigint; // derives per-note secrets
}

export function generateMasterSeed(): Uint8Array {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s); // full-entropy CSPRNG — the one thing Tornado got right (keep it)
  return s;
}

function deriveField(seed: Uint8Array, label: string): bigint {
  const labelBytes = enc.encode(label);
  const buf = new Uint8Array(seed.length + labelBytes.length);
  buf.set(seed, 0);
  buf.set(labelBytes, seed.length);
  const h = keccak256(buf) as Hex;
  return BigInt(h) % FIELD;
}

export function deriveKeys(masterSeed: Uint8Array): WalletKeys {
  return {
    spendKey: deriveField(masterSeed, "/spend"),
    viewKey: deriveField(masterSeed, "/view"),
    noteKey: deriveField(masterSeed, "/note"),
  };
}

/**
 * Guard used across the app: refuse to persist anything that looks like raw secret material in
 * dapp-origin storage. (A real wallet routes secrets to an OS/hardware keystore instead.)
 */
export function assertNotPersistingSecret(key: string): void {
  if (/seed|secret|spend|private|note-?key/i.test(key)) {
    throw new Error(`Refusing to persist secret-like key "${key}" to localStorage (TC-01 guard).`);
  }
}
