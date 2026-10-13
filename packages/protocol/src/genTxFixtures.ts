// Emit Transaction-circuit witness fixtures (honest + adversarial) for circuits/test/witness.mjs.
// Output: circuits/test/fixtures/v1/*.json + manifest.json. Each attack violates exactly ONE rule,
// so a rejection is attributable to that rule. (The v0-draft regression fixtures are static files.)
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { utf8ToBytes } from "@noble/hashes/utils";
import { FIELD } from "./field";
import { hash4 } from "./poseidon";
import { PHANTOM_NULLIFIER } from "./domains";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "./note";
import { nullifier } from "./nullifier";
import { MerkleTree } from "./merkle";
import { deriveKeys, deriveNoteSecret } from "./keys";
import { noteDataHash, testNoteData, txDomain } from "./payload";
import { buildTxInputs, dummyOutput, type CircuitInputs, type SpendNote, type TxSpec } from "./txInputs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "..", "..", "circuits", "test", "fixtures");

const alice = deriveKeys(utf8ToBytes("privacy-protocol/example-master-seed")); // = primitives.json keys
const bob = deriveKeys(utf8ToBytes("privacy-protocol/example-bob"));
const relayer = deriveKeys(utf8ToBytes("privacy-protocol/example-relayer"));
const mallory = deriveKeys(utf8ToBytes("privacy-protocol/example-mallory"));

const ONE = 10n ** 18n;
const VAULT = 0xabn; // = primitives.json sampleNote.vaultId
const OTHER_VAULT = 0xcdn;
const RECIPIENT = 0xbeefn;
const aliceOC = ownerCommitmentOf(alice.spendKey);
const bobOC = ownerCommitmentOf(bob.spendKey);
const relayerOC = ownerCommitmentOf(relayer.spendKey);
const malloryOC = ownerCommitmentOf(mallory.spendKey);

let rndCtr = 1000;
const rnd = () => deriveNoteSecret(alice.noteKey, rndCtr++); // deterministic "randomness" for dummies

// On-chain tree = two of Alice's deposits: 1.0 @ leaf 0 and 2.0 @ leaf 4 (one group each).
const tree = new MerkleTree(32);
const note0: SpendNote = { spendKey: alice.spendKey, ownerCommitment: aliceOC, vaultId: VAULT, amount: ONE, noteSecret: deriveNoteSecret(alice.noteKey, 0), leafIndex: 0 };
const note1: SpendNote = { spendKey: alice.spendKey, ownerCommitment: aliceOC, vaultId: VAULT, amount: 2n * ONE, noteSecret: deriveNoteSecret(alice.noteKey, 1), leafIndex: 4 };
tree.insertLeaf(noteCommitment(noteBody(note0), 0n));
tree.insertLeaf(noteCommitment(noteBody(note1), 4n));
const leaves = tree.leaves;

const out = (ownerCommitment: bigint, amount: bigint, vaultId = VAULT): Note => ({ ownerCommitment, amount, vaultId, noteSecret: rnd() });
const dummy = () => dummyOutput(VAULT, rnd);
const base = {
  leaves,
  outDataHash: [0, 1, 2].map((k) => noteDataHash(testNoteData(BigInt(k)))) as [bigint, bigint, bigint],
  txDomain: txDomain(31337n, 0xc0den),
};

const transfer: TxSpec = { ...base, inputs: [note0, null], outputs: [out(bobOC, 6n * ONE / 10n), out(aliceOC, 4n * ONE / 10n), dummy()], withdrawal: null };
const withdraw: TxSpec = { ...base, inputs: [note1, null], outputs: [out(aliceOC, ONE / 2n), dummy(), dummy()], withdrawal: { vault: VAULT, amount: 3n * ONE / 2n, recipient: RECIPIENT } };

type Entry = { schema: "v1"; name: string; expect: "sat" | "unsat"; rule: string; inputs: CircuitInputs };
const entries: Entry[] = [];
const add = (name: string, expect: Entry["expect"], rule: string, inputs: CircuitInputs) =>
  entries.push({ schema: "v1", name, expect, rule, inputs });
const bad = (spec: TxSpec) => buildTxInputs(spec, { check: false });

// ---- honest ----
add("ok-transfer", "sat", "1 real input + phantom pad, 3 outputs, mode 0", buildTxInputs(transfer));
add("ok-withdraw", "sat", "public exit through the note's own vault, mode 1", buildTxInputs(withdraw));
add("ok-two-inputs", "sat", "both input slots real (merge 1.0 + 2.0)", buildTxInputs({
  ...base, inputs: [note0, note1], outputs: [out(bobOC, 5n * ONE / 2n), out(aliceOC, ONE / 2n), dummy()], withdrawal: null,
}));
add("ok-relayer-fee", "sat", "withdraw 0.6 with a 0.05 private fee note to the relayer (plan §49)", buildTxInputs({
  ...base, inputs: [note0, null], outputs: [out(aliceOC, 35n * ONE / 100n), out(relayerOC, 5n * ONE / 100n), dummy()],
  withdrawal: { vault: VAULT, amount: 6n * ONE / 10n, recipient: RECIPIENT },
}));

// ---- adversarial (each must be UNSATISFIABLE) ----
add("attack-foreign-key", "unsat", "owner binding (PP-C01): spend Alice's note with Mallory's key", bad({
  ...transfer, inputs: [{ ...note0, spendKey: mallory.spendKey }, null], outputs: [out(malloryOC, ONE), dummy(), dummy()],
}));
add("attack-duplicate-input", "unsat", "distinct nullifiers (PP-C03): same note in both slots mints 2x", bad({
  ...base, inputs: [note0, note0], outputs: [out(aliceOC, 2n * ONE), dummy(), dummy()], withdrawal: null,
}));
add("attack-inflation", "unsat", "value conservation: outputs 1.1 > input 1.0", bad({
  ...transfer, outputs: [out(aliceOC, 6n * ONE / 10n), out(aliceOC, 5n * ONE / 10n), dummy()],
}));
add("attack-negative-amount", "unsat", "range check: outputs 2.0 + (p - 1.0) wrap to 1.0 mod p", bad({
  ...transfer, outputs: [out(aliceOC, 2n * ONE), out(aliceOC, FIELD - ONE), dummy()],
}));
add("attack-cross-asset", "unsat", "asset conservation: VAULT note spent into OTHER_VAULT outputs", bad({
  ...transfer, outputs: [out(aliceOC, ONE, OTHER_VAULT), dummyOutput(OTHER_VAULT, rnd), dummyOutput(OTHER_VAULT, rnd)],
}));
add("attack-withdraw-wrong-vault", "unsat", "mode rule: exit through a vault other than the note's asset", bad({
  ...withdraw, withdrawal: { ...withdraw.withdrawal!, vault: OTHER_VAULT },
}));
add("attack-withdraw-as-transfer", "unsat", "mode rule: a public exit amount under mode 0", {
  ...buildTxInputs(withdraw), mode: "0",
});
const honest = buildTxInputs(transfer);
add("attack-phantom-burn", "unsat", "phantom derivation (PP-C02): choose nullifier[1] = an unspent note's nullifier", {
  ...honest, nullifier: [(honest.nullifier as string[])[0], nullifier(leaves[4], alice.spendKey).toString()],
});
add("attack-phantom-without-key", "unsat", "phantom derivation (PP-P02): nullifier[1] computed without the spending key", {
  ...honest,
  nullifier: [(honest.nullifier as string[])[0], hash4(PHANTOM_NULLIFIER, BigInt((honest.nullifier as string[])[0]), 1n, 0n).toString()],
});
add("attack-wrong-note-secret", "unsat", "commitment opening: wrong noteSecret for the spent note", bad({
  ...transfer, inputs: [{ ...note0, noteSecret: rnd() }, null],
}));

for (const e of entries) {
  mkdirSync(join(outDir, e.schema), { recursive: true });
  writeFileSync(join(outDir, e.schema, `${e.name}.json`), JSON.stringify(e.inputs, null, 1) + "\n");
}
const manifest = entries.map(({ schema, name, expect, rule }) => ({ schema, name, expect, rule }));
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${entries.length} v1 fixtures to ${outDir}`);
