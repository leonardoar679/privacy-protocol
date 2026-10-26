// The Classic note's derivations and the pool's tree hash (spec v3.0 §7.3; the compatibility matrix §3), over the
// vendored originals (src/prover/legacy: circomlib 3b492f9's Pedersen on Baby Jubjub with BLAKE-256 generators, its
// MiMCSponge; snarkjs 0.1's field): commitment = Pedersen(nullifier ‖ secret).x, nullifierHash = Pedersen(nullifier).x,
// and hashLeftRight as the deployed MerkleTreeWithHistory computes it — MiMCSponge(left, 0), + right, MiMCSponge again.
// Equal to circomlibjs 0.1.2 on the note vectors, to the pools' own zero subtrees on chain and to a real pool's root
// over 27,544 leaves (test/crypto.test.ts, vectors/). Importing this loads snarkjs 0.1's BigInt extensions: the app does
// so in the prover worker only (src/prover/worker.ts).
import * as legacyBigInt from "../prover/legacy/bigint.js";
import * as babyJub from "../prover/legacy/babyjub.js";
import * as mimc from "../prover/legacy/mimcsponge.js";
import * as pedersen from "../prover/legacy/pedersenHash.js";
import type { ClassicNote } from "../model/notes";

/** snarkjs 0.1's field element (a native BigInt with extra methods, or big-integer's object): what the originals pass around. */
interface LegacyBig {
  toString(): string;
}
const bigInt = legacyBigInt.default as unknown as (x: string | number) => LegacyBig;
const mimcHash = mimc.hash as unknown as (xL: LegacyBig, xR: LegacyBig, k: LegacyBig) => { xL: LegacyBig; xR: LegacyBig };
const pedersenHash = pedersen.hash as unknown as (data: Uint8Array) => Uint8Array;
const unpackPoint = babyJub.unpackPoint as unknown as (packed: Uint8Array) => [LegacyBig, LegacyBig] | null;

/** The BN254 scalar field the circuit and the pool compute in. */
export const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** keccak256("tornado") mod FIELD_SIZE: the empty leaf (the contract's ZERO_VALUE). */
export const ZERO_VALUE = 21663839004416932945382355908790599225266501822907911457504978515578255421292n;

const toBig = (x: LegacyBig): bigint => BigInt(x.toString());

/** The x coordinate of the Pedersen hash of `data` (the original's pedersenHash(data)). */
export function pedersenX(data: Uint8Array): bigint {
  const point = unpackPoint(pedersenHash(data));
  if (!point) throw new Error("the Pedersen point did not unpack");
  return toBig(point[0]);
}

/** MiMCSponge(left, 0) then + right then MiMCSponge again: MerkleTreeWithHistory.hashLeftRight. */
export function hashLeftRight(left: bigint, right: bigint): bigint {
  if (left >= FIELD_SIZE || right >= FIELD_SIZE) throw new Error("a leaf or node must be inside the field");
  const first = mimcHash(bigInt(left.toString()), bigInt(0), bigInt(0));
  const R = (toBig(first.xL) + right) % FIELD_SIZE;
  const second = mimcHash(bigInt(R.toString()), first.xR, bigInt(0));
  return toBig(second.xL);
}

/** The note's commitment, the leaf the deposit inserts: Pedersen(nullifier ‖ secret).x. */
export const commitmentOf = (note: ClassicNote): bigint => pedersenX(new Uint8Array([...note.nullifier, ...note.secret]));
/** The note's nullifier hash, what a withdrawal reveals: Pedersen(nullifier).x. */
export const nullifierHashOf = (note: ClassicNote): bigint => pedersenX(note.nullifier);

/** A field element as the 32-byte hex the contracts and the relayers use. */
export const toHex32 = (x: bigint): `0x${string}` => `0x${x.toString(16).padStart(64, "0")}`;
