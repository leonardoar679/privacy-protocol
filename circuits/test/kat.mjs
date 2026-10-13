// Known-answer test: compute the KAT circuit's witness and compare every output to the nargo
// Poseidon2 vectors and to vectors/primitives.json (produced by packages/protocol).
// Prereq: circom test/kat.circom --wasm -l node_modules -o build
import { readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const builder = require(join(root, "build/kat_js/witness_calculator.js"));
const v = JSON.parse(readFileSync(join(root, "vectors/primitives.json"), "utf8"));

const calc = await builder(readFileSync(join(root, "build/kat_js/kat.wasm")));
const w = await calc.calculateWitness(
  {
    spendKey: v.keys.spendKey,
    amount: v.sampleNote.amount,
    vaultId: v.sampleNote.vaultId,
    noteSecret: v.sampleNote.noteSecret,
    zeroLeaf: v.zeroLeaf,
    outputs: v.tree.outputs,
  },
  true,
);

// witness layout: w[0] = 1, then main's outputs in declaration order
const P = v.poseidon2;
const expected = [
  ["perm([0,0,0,0])[0]", P["permute([0,0,0,0])[0]"]],
  ["perm([1,2,3,4])[0]", P["permute([1,2,3,4])[0]"]],
  ["perm([1,2,3,4])[3]", P["permute([1,2,3,4])[3]"]],
  ["H(0)", P["hash([0])"]],
  ["H(1)", P["hash([1])"]],
  ["H(0,0)", P["hash([0,0])"]],
  ["H(1,2)", P["hash([1,2])"]],
  ["H(0,0,0)", P["hash([0,0,0])"]],
  ["H(1,2,3)", P["hash([1,2,3])"]],
  ["H(1,2,3,4)", P["hash([1,2,3,4])"]],
  ["ownerCommitment", v.sampleNote.ownerCommitment],
  ["body", v.sampleNote.body],
  ["commitment", v.sampleNote.commitment],
  ["nullifier", v.sampleNote.nullifier],
  ["phantom", v.sampleNote.phantom],
  ["emptyRoot", v.tree.emptyRoot],
  ["rootAfterDeposit", v.tree.rootAfterDeposit],
  ["rootAfterTx", v.tree.rootAfterTx],
];

let failed = 0;
expected.forEach(([name, want], i) => {
  const got = w[i + 1].toString();
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(20)} ${ok ? got : `got ${got}\n      want ${want}`}`);
});
console.log(`\nKAT: ${expected.length - failed}/${expected.length} match (nargo Poseidon2 + primitives.json)`);
process.exit(failed ? 1 : 0);
