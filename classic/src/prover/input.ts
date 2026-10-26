// The circuit's input for a withdrawal (spec v3.0 §7.3; the compatibility matrix §3): the six public signals in the
// order the contract passes them — root, nullifierHash, recipient, relayer, fee, refund — and the private ones: the
// note's nullifier and secret as little-endian field elements, the leaf's path. Pure; the prover worker turns it into
// the witness. Every value a decimal string (what the witness calculator reads).
import { leBigInt, type ClassicNote } from "../model/notes";
import { nullifierHashOf } from "../crypto/hashes";
import type { MerklePath } from "../crypto/tree";

export interface WithdrawalArgs {
  /** the tree root the path proves (one the pool still knows: the last 100) */
  root: bigint;
  recipient: `0x${string}`;
  /** the relayer's reward account; the recipient itself in wallet mode */
  relayer: `0x${string}`;
  /** the relayer's fee in wei (0 in wallet mode) */
  feeWei: bigint;
  /** the ETH pools refund nothing */
  refundWei: bigint;
}

export interface CircuitInput {
  root: string;
  nullifierHash: string;
  recipient: string;
  relayer: string;
  fee: string;
  refund: string;
  nullifier: string;
  secret: string;
  pathElements: string[];
  pathIndices: string[];
}

const addressNumber = (a: `0x${string}`): string => BigInt(a).toString();

export function circuitInput(note: ClassicNote, path: MerklePath, args: WithdrawalArgs): CircuitInput {
  return {
    root: args.root.toString(),
    nullifierHash: nullifierHashOf(note).toString(),
    recipient: addressNumber(args.recipient),
    relayer: addressNumber(args.relayer),
    fee: args.feeWei.toString(),
    refund: args.refundWei.toString(),
    nullifier: leBigInt(note.nullifier).toString(),
    secret: leBigInt(note.secret).toString(),
    pathElements: path.pathElements.map((x) => x.toString()),
    pathIndices: path.pathIndices.map((x) => String(x)),
  };
}

/** The six public inputs of an input, in the contract's order, as decimal strings. */
export const publicInputsOf = (input: CircuitInput): string[] => [input.root, input.nullifierHash, input.recipient, input.relayer, input.fee, input.refund];
