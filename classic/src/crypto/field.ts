// The two field constants every module may read without loading the vendored arithmetic (spec v3.0 §7.3): the BN254
// scalar field the circuit and the pool compute in, and the empty leaf keccak256("tornado") mod p.
export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ZERO_VALUE = 21663839004416932945382355908790599225266501822907911457504978515578255421292n;

export const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** A 32-byte hex string inside the field, as a bigint; null otherwise. */
export function fieldElementOf(hex: string): bigint | null {
  if (!HEX32.test(hex)) return null;
  const v = BigInt(hex);
  return v < FIELD_SIZE ? v : null;
}

/** A field element as the 32-byte hex the contracts and the relayers use. */
export const toHex32 = (x: bigint): `0x${string}` => `0x${x.toString(16).padStart(64, "0")}`;
