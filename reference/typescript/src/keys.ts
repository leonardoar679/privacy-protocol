// Local, wallet-side key derivation (spec §4). The master seed NEVER leaves the client and is NEVER
// persisted to dapp-origin storage (the TC-01 fix). This is the reference derivation; a production
// wallet may use another KDF as long as ownerCommitment is computed exactly as note.ts does.
import { keccak_256 } from "@noble/hashes/sha3";
import { utf8ToBytes, concatBytes } from "@noble/hashes/utils";
import { FIELD } from "./field";
import { bytesToBigInt } from "./domains";

function deriveField(seed: Uint8Array, label: string): bigint {
  return bytesToBigInt(keccak_256(concatBytes(seed, utf8ToBytes(label)))) % FIELD;
}

export interface WalletKeys {
  spendKey: bigint; // authorizes spends (nullifier key); ownerCommitment = H(OWNER_COMMITMENT, spendKey)
  viewKey: bigint; // decrypts incoming note payloads
  noteKey: bigint; // derives per-note secrets
}

export function deriveKeys(masterSeed: Uint8Array): WalletKeys {
  return {
    spendKey: deriveField(masterSeed, "/spend"),
    viewKey: deriveField(masterSeed, "/view"),
    noteKey: deriveField(masterSeed, "/note"),
  };
}

/** noteSecret for the wallet's own notes: keccak(noteKey ‖ uint64 counter) mod p (spec §5.5). */
export function deriveNoteSecret(noteKey: bigint, counter: number): bigint {
  const b = new Uint8Array(40);
  let k = noteKey;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(k & 0xffn);
    k >>= 8n;
  }
  let c = BigInt(counter);
  for (let i = 39; i >= 32; i--) {
    b[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return bytesToBigInt(keccak_256(b)) % FIELD;
}
