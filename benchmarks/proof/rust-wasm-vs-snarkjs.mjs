#!/usr/bin/env node
// The proof pipeline's benchmark gate (spec v2.0 §14.3; V6 Stage 15): the native prover compiled to wasm32
// (privacy-core/privacy-prover-wasm: the witness through a pure-Rust interpreter, arkworks single-threaded) against
// snarkjs on the same circuit inputs, the same proving key and the same witness generator, both from bytes in memory.
// The wallet adopts the Rust prover only when it is at least 1.5× faster than snarkjs as the browser runs it (with its
// worker threads) and the public signals are identical; either way the numbers land in results-<date>.json.
//   node build.mjs                          (CARGO, WASM_BINDGEN as for privacy-core/scripts/build-wasm.mjs)
//   node rust-wasm-vs-snarkjs.mjs [runs]    (default 3, after one warm-up each)
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { cpus } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const runs = Number(process.argv[2] ?? 3);
const zkeyPath = join(root, "circuits/build/setup/transaction_final.zkey");
const wasmPath = join(root, "circuits/build/transaction_js/transaction.wasm");
const inputsPath = join(root, "circuits/test/fixtures/v1/ok-transfer.json");
const rustPkg = join(here, "pkg/privacy_prover_wasm.js");
for (const p of [zkeyPath, wasmPath, inputsPath, rustPkg]) if (!existsSync(p)) throw new Error(`missing ${p} (circuits built? node build.mjs?)`);

const snarkjs = createRequire(join(root, "circuits/package.json"))("snarkjs");
const rust = createRequire(import.meta.url)(rustPkg);
const zkey = new Uint8Array(readFileSync(zkeyPath));
const wasm = new Uint8Array(readFileSync(wasmPath));
const inputs = JSON.parse(readFileSync(inputsPath, "utf8"));

/** A blinding scalar: 31 random bytes under a zero byte, so it is below the field's modulus. */
const scalar = () => Uint8Array.from([0, ...randomBytes(31)]);
const words = (b) => Array.from({ length: b.length / 32 }, (_, i) => BigInt("0x" + Buffer.from(b.subarray(i * 32, i * 32 + 32)).toString("hex")).toString());
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function time(label, f) {
  await f(); // warm-up
  const ms = [];
  let last;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    last = await f();
    ms.push(Math.round(performance.now() - t));
  }
  console.log(`${label.padEnd(46)} ${ms.join(" / ")} ms (median ${median(ms)})`);
  return { ms, median: median(ms), last };
}

const threaded = await time("snarkjs fullProve (worker threads)", () => snarkjs.groth16.fullProve(inputs, wasm, zkey));
const single = await time("snarkjs fullProve (single thread)", () =>
  snarkjs.groth16.fullProve(inputs, wasm, zkey, undefined, undefined, { singleThread: true }),
);
const rustRun = await time("Rust prover on wasm32 (single thread)", () => rust.prove_transaction(zkey, wasm, JSON.stringify(inputs), scalar(), scalar()));

const rustSignals = words(rustRun.last.subarray(256));
const snarkSignals = threaded.last.publicSignals.map(String);
const identical = rustSignals.length === snarkSignals.length && rustSignals.every((s, i) => s === snarkSignals[i]);
const vk = JSON.parse(readFileSync(join(root, "circuits/setup/dev/verification_key.json"), "utf8"));
const verifies = await snarkjs.groth16.verify(vk, snarkSignals, threaded.last.proof).catch(() => null);
// the Rust proof as snarkjs reads it: the calldata's words a(2) b(4, each G2 coordinate's limbs swapped for the EVM) c(2)
const w = words(rustRun.last.subarray(0, 256));
const rustProof = {
  pi_a: [w[0], w[1], "1"],
  pi_b: [
    [w[3], w[2]],
    [w[5], w[4]],
    ["1", "0"],
  ],
  pi_c: [w[6], w[7], "1"],
  protocol: "groth16",
  curve: "bn128",
};
const rustVerifies = await snarkjs.groth16.verify(vk, rustSignals, rustProof).catch(() => null);
const speedup = threaded.median / rustRun.median;
const adopt = identical && rustVerifies === true && speedup >= 1.5;
console.log(`public signals identical: ${identical}; snarkjs's proof verifies: ${verifies}; the Rust proof verifies: ${rustVerifies}`);
console.log(`the Rust prover is ${speedup.toFixed(2)}× snarkjs (threaded); adopt: ${adopt ? "yes" : "no — snarkjs stays the browser's prover"}`);

const day = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(here, `results-${day}.json`),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      machine: { cpus: cpus().length, model: cpus()[0]?.model, node: process.version, platform: process.platform },
      circuit: "circuits/transaction.circom (dev zkey)",
      inputs: "circuits/test/fixtures/v1/ok-transfer.json",
      runs,
      snarkjsThreadedMs: threaded.ms,
      snarkjsSingleThreadMs: single.ms,
      rustWasm32Ms: rustRun.ms,
      speedupVsThreaded: Number(speedup.toFixed(2)),
      speedupVsSingleThread: Number((single.median / rustRun.median).toFixed(2)),
      publicSignalsIdentical: identical,
      snarkjsProofVerifies: verifies,
      rustProofVerifies: rustVerifies,
      rule: "adopt only at >= 1.5x snarkjs (threaded, as the browser runs it) with identical public signals",
      adopted: adopt,
    },
    null,
    2,
  ) + "\n",
);
process.exit(identical ? 0 : 1);
