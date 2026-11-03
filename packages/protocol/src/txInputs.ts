// Prover-side witness builder for the 2-input / 3-output Transaction circuit (spec §10): given the
// on-chain tree contents and the notes being spent/created, assemble every circuit input (public +
// private). This is what a wallet does before proving; it mirrors circuits/transaction.circom.
import { ownerCommitmentOf, noteBody, noteCommitment, type Note } from "./note";
import { nullifier, phantomNullifier } from "./nullifier";
import { MerkleLayers, ZERO_LEAF, zeroHashes } from "./merkle";

export const TX_LEVELS = 32; // circuit depth: Transaction(32, 2, 3)

/** A note being spent: the wallet knows its opening and the spending key. */
export interface SpendNote extends Note {
  spendKey: bigint;
  leafIndex: number;
}
export interface Withdrawal {
  vault: bigint;
  amount: bigint;
  recipient: bigint;
}
export interface TxSpec {
  leaves: bigint[]; // on-chain tree contents in leaf order, incl. ZERO_LEAF padding
  tree?: MerkleLayers; // the layers over `leaves` when already computed (a synced wallet); built here otherwise
  inputs: [SpendNote, SpendNote | null]; // slot 0 is always real; a null slot 1 is a phantom pad
  outputs: [Note, Note, Note]; // recipient / change / fee (or dummies), any order
  withdrawal: Withdrawal | null; // null = internal transfer (mode 0)
  outDataHash: [bigint, bigint, bigint];
  txDomain: bigint;
  levels?: number;
}
export type CircuitInputs = Record<string, string | string[] | string[][]>;

/** A dummy output (spec §5.5): random owner (no key), amount 0, random secret. */
export const dummyOutput = (vaultId: bigint, rnd: () => bigint): Note => ({
  vaultId,
  amount: 0n,
  ownerCommitment: rnd(),
  noteSecret: rnd(),
});

export function buildTxInputs(spec: TxSpec, opts: { check?: boolean } = {}): CircuitInputs {
  const check = opts.check ?? true; // false only when deliberately building an invalid (attack) witness
  const levels = spec.levels ?? TX_LEVELS;
  const tree = spec.tree ?? MerkleLayers.build(spec.leaves, levels);
  if (tree.levels !== levels || tree.leaves.length !== spec.leaves.length) throw new Error("the tree layers do not belong to these leaves");
  const root = tree.root;
  const asset = spec.inputs[0].vaultId;
  const zeroPath = zeroHashes(levels).slice(0, levels);

  const ins = spec.inputs.map((n, i) => {
    if (n) {
      const oc = ownerCommitmentOf(n.spendKey);
      if (check && oc !== n.ownerCommitment) throw new Error(`input ${i}: spending key does not own the note`);
      const cm = noteCommitment(noteBody({ ...n, ownerCommitment: oc }), BigInt(n.leafIndex));
      if (check && cm !== spec.leaves[n.leafIndex]) throw new Error(`input ${i} does not open leaf ${n.leafIndex}`);
      const path = tree.proof(n.leafIndex);
      return {
        isReal: 1n, amount: n.amount, vaultId: n.vaultId, spendKey: n.spendKey, noteSecret: n.noteSecret,
        leafIndex: BigInt(n.leafIndex), pathElements: path.pathElements, pathIndices: path.pathIndices,
        nf: nullifier(cm, n.spendKey),
      };
    }
    return {
      isReal: 0n, amount: 0n, vaultId: 0n, spendKey: 0n, noteSecret: 0n, leafIndex: 0n,
      pathElements: zeroPath, pathIndices: Array(levels).fill(0) as number[], nf: 0n,
    };
  });
  // Phantom slot: nullifier DERIVED from slot 0 (spec §5.4), never chosen.
  if (!spec.inputs[1]) ins[1].nf = phantomNullifier(ins[0].nf, 1, ins[0].spendKey);

  const w = spec.withdrawal;
  if (check) {
    const inSum = ins.reduce((s, x) => s + x.amount * x.isReal, 0n);
    const outSum = spec.outputs.reduce((s, o) => s + o.amount, 0n) + (w?.amount ?? 0n);
    if (inSum !== outSum) throw new Error("value not conserved: the inputs and the outputs differ"); // no amounts in the words (the fourth review round, 2026-11-03): they reach the record and the console
    if (spec.inputs[1] && spec.inputs[1].vaultId !== asset) throw new Error("inputs mix assets");
    if (spec.outputs.some((o) => o.vaultId !== asset)) throw new Error("output asset != input asset");
    if (w && w.vault !== asset) throw new Error("withdrawal vault != input asset");
    if (ins[0].nf === ins[1].nf) throw new Error("duplicate input");
  }

  const s = (x: bigint | number) => x.toString();
  return {
    root: s(root),
    nullifier: ins.map((x) => s(x.nf)),
    outputBody: spec.outputs.map((o) => s(noteBody(o))),
    mode: w ? "1" : "0",
    withdrawalVault: s(w?.vault ?? 0n),
    withdrawalAmount: s(w?.amount ?? 0n),
    withdrawalRecipient: s(w?.recipient ?? 0n),
    outDataHash: spec.outDataHash.map(s),
    txDomain: s(spec.txDomain),
    inAmount: ins.map((x) => s(x.amount)),
    inVaultId: ins.map((x) => s(x.vaultId)),
    inOwnerKey: ins.map((x) => s(x.spendKey)),
    inNoteSecret: ins.map((x) => s(x.noteSecret)),
    inLeafIndex: ins.map((x) => s(x.leafIndex)),
    inPathElements: ins.map((x) => x.pathElements.map(s)),
    inPathIndices: ins.map((x) => x.pathIndices.map(s)),
    inIsReal: ins.map((x) => s(x.isReal)),
    outAmount: spec.outputs.map((o) => s(o.amount)),
    outVaultId: spec.outputs.map((o) => s(o.vaultId)),
    outOwnerCommitment: spec.outputs.map((o) => s(o.ownerCommitment)),
    outNoteSecret: spec.outputs.map((o) => s(o.noteSecret)),
  };
}

export { ZERO_LEAF };
