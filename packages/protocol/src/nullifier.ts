// 1:1 nullifier + phantom padding (spec §5.3–5.4), mirroring NullifierLib.sol and the circuit.
import { NULLIFIER, PHANTOM_NULLIFIER } from "./domains";
import { hash3, hash4 } from "./poseidon";

/** nullifier = H(NULLIFIER, commitment, spendKey) */
export const nullifier = (commitment: bigint, spendKey: bigint): bigint => hash3(NULLIFIER, commitment, spendKey);

/**
 * Nullifier of an unused input slot: H(PHANTOM_NULLIFIER, nullifier0, inputIndex, spendKey0).
 * Derived in-circuit; unique per transaction; NOT recomputable by an observer (PP-P02).
 */
export const phantomNullifier = (nullifier0: bigint, inputIndex: number, spendKey0: bigint): bigint =>
  hash4(PHANTOM_NULLIFIER, nullifier0, BigInt(inputIndex), spendKey0);
