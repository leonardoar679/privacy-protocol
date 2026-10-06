// Output payloads (spec §12) and the chain/core binding (spec §11).
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes } from "@noble/hashes/utils";
import { FIELD } from "./field";
import { OUTPUT_BINDING_TAG, TX_DOMAIN_TAG, bytesToBigInt } from "./domains";

export const NOTE_DATA_BYTES = 169;
export const PROTOCOL_ID = keccak_256(new TextEncoder().encode("privacy-protocol/v1.0"));
export const CIRCUIT_ID = keccak_256(
  new TextEncoder().encode("privacy-protocol/v1/circuit/transaction-2in3out-depth32-poseidon2"),
);

/** noteDataHash = keccak256(OUTPUT_BINDING tag ‖ noteData) mod p — what PrivacyCore.noteDataHash computes. */
export function noteDataHash(noteData: Uint8Array): bigint {
  if (noteData.length !== NOTE_DATA_BYTES) throw new Error(`noteData must be ${NOTE_DATA_BYTES} bytes`);
  return bytesToBigInt(keccak_256(concatBytes(OUTPUT_BINDING_TAG, noteData))) % FIELD;
}

/**
 * txDomain = keccak256(abi.encode(TX_DOMAIN_TAG, PROTOCOL_ID, chainId, coreAddress, CIRCUIT_ID)) mod p.
 * abi.encode of (bytes32, bytes32, uint256, address, bytes32) is five left-padded 32-byte words.
 */
export function txDomain(chainId: bigint, coreAddress: bigint): bigint {
  const words = [bytesToBigInt(TX_DOMAIN_TAG), bytesToBigInt(PROTOCOL_ID), chainId, coreAddress, bytesToBigInt(CIRCUIT_ID)];
  const pre = new Uint8Array(32 * words.length);
  words.forEach((w, i) => {
    let x = w;
    for (let j = 31; j >= 0; j--) {
      pre[i * 32 + j] = Number(x & 0xffn);
      x >>= 8n;
    }
  });
  return bytesToBigInt(keccak_256(pre)) % FIELD;
}

/** Plaintext of the envelope: amount ‖ noteSecret ‖ vaultId, 3 × 32 bytes (spec §12). */
export function packPlaintext(amount: bigint, noteSecret: bigint, vaultId: bigint): Uint8Array {
  const out = new Uint8Array(96);
  [amount, noteSecret, vaultId].forEach((v, i) => {
    let x = v;
    for (let j = 31; j >= 0; j--) {
      out[i * 32 + j] = Number(x & 0xffn);
      x >>= 8n;
    }
  });
  return out;
}

/**
 * A fixed-size payload with the spec's layout but deterministic pseudo-random content, for fixtures
 * and tests. A wallet fills the same layout with X25519 + XChaCha20-Poly1305 to the recipient's view
 * key (outside the core; the core checks only the size and the binding hash).
 */
export function testNoteData(seed: bigint): Uint8Array {
  const out = new Uint8Array(NOTE_DATA_BYTES);
  out[0] = 0x01;
  let off = 1;
  let ctr = 0n;
  while (off < NOTE_DATA_BYTES) {
    const block = keccak_256(packPlaintext(seed, ctr, 0n));
    for (let i = 0; i < 32 && off < NOTE_DATA_BYTES; i++) out[off++] = block[i];
    ctr++;
  }
  return out;
}
