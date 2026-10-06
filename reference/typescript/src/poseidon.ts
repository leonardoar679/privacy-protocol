// The protocol hash (spec §2): Poseidon2 / BN254 / t=4 with the Noir sponge, from the vendored
// implementation in ./poseidon2.ts (UseArclite, verbatim). Arity helpers for every object the protocol
// hashes; all checked against the nargo vectors in test/poseidon2.test.ts and against the circuit and
// the contracts through circuits/vectors/primitives.json.
import { hash } from "./poseidon2";

export const hash1 = (a: bigint): bigint => hash([a]);
export const hash2 = (a: bigint, b: bigint): bigint => hash([a, b]);
export const hash3 = (a: bigint, b: bigint, c: bigint): bigint => hash([a, b, c]);
export const hash4 = (a: bigint, b: bigint, c: bigint, d: bigint): bigint => hash([a, b, c, d]);
export const hash5 = (a: bigint, b: bigint, c: bigint, d: bigint, e: bigint): bigint => hash([a, b, c, d, e]);
export { hash as poseidon2, permute as poseidon2Permute } from "./poseidon2";
