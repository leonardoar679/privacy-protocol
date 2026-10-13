#!/usr/bin/env node
// Witnesses and snarkjs proofs of the v1 circuit fixtures for the native prover's tests
// (privacy-core/privacy-prover/tests/prover.rs). For each circuits/test/fixtures/v1/ok-*.json input:
//   circuits/build/prover-fixtures/<name>.wtns        snarkjs' witness calculator over transaction.wasm
//   circuits/build/prover-fixtures/<name>.proof.json  snarkjs groth16.prove with the dev zkey: the proof,
//                                                     the public signals, the Solidity calldata snarkjs
//                                                     exports, and how long snarkjs took to prove
// Needs the circuit build and the dev setup (circuits/scripts/compile.sh, dev-setup.sh); the output
// sits under circuits/build (gitignored, like the zkey it belongs to). No network.
//   node privacy-core/scripts/gen-prover-fixtures.mjs
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const circuits = join(root, "circuits");
const snarkjs = createRequire(join(circuits, "package.json"))("snarkjs");
const WASM = join(circuits, "build/transaction_js/transaction.wasm");
const ZKEY = join(circuits, "build/setup/transaction_final.zkey");
const OUT = join(circuits, "build/prover-fixtures");
for (const p of [WASM, ZKEY]) {
  if (!existsSync(p)) {
    console.error(`missing ${p}: build the circuit and the dev setup first (circuits/scripts/compile.sh, dev-setup.sh)`);
    process.exit(1);
  }
}
mkdirSync(OUT, { recursive: true });
const vk = JSON.parse(readFileSync(join(circuits, "setup/dev/verification_key.json"), "utf8"));

for (const name of ["ok-transfer", "ok-withdraw", "ok-two-inputs", "ok-relayer-fee"]) {
  const input = JSON.parse(readFileSync(join(circuits, "test/fixtures/v1", `${name}.json`), "utf8"));
  const wtns = join(OUT, `${name}.wtns`);
  await snarkjs.wtns.calculate(input, WASM, wtns);
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(ZKEY, wtns);
  const snarkjsMs = Math.round(performance.now() - t0);
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${name}: the snarkjs proof does not verify`);
  const [a, b, c] = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
  writeFileSync(join(OUT, `${name}.proof.json`), JSON.stringify({ proof, publicSignals, calldata: { a, b, c }, snarkjsMs }, null, 1) + "\n");
  console.log(`${name}: witness + snarkjs proof (${snarkjsMs} ms)`);
}
console.log(`written to ${OUT}`);
process.exit(0); // snarkjs keeps its curve workers alive
