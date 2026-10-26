# Third-party notices — Tornado Classic

The Classic app is licensed under the GNU General Public License v3.0 (`LICENSE`), the licence of the original prover it
vendors (the owner's decision 10 of 2026-10-26; spec v3.0 §7.8). The Privacy Wallet's own packages elsewhere in this
repository are MIT-licensed (`../LICENSE`).

## Vendored (V7 Stage 6)

The original proving stack is vendored verbatim under `vendor/`, every file's origin and sha256 recorded in
`vendor/VENDORED.md`, and turned into the ES modules under `src/prover/legacy/` by the literal replacements
`scripts/vendor.mjs` lists:

| Component | Pinned at | Licence |
|---|---|---|
| tornadocash/websnark (`src/groth16.js`, `src/utils.js`, `tools/stringifybigint.js`, `build/groth16_wasm.js`) | commit `4c0af6a8` | GPL-3.0 |
| snarkjs 0.1.20 — the witness calculator (`bigint.js`, `zqfield.js`, `futils.js`, `stringifybigint.js`, `circuit.js`, `calculateWitness.js`) | npm `snarkjs@0.1.20` | GPL-3.0 |
| tornadocash/circomlib (`babyjub.js`, `pedersenHash.js`, `mimcsponge.js`) | commit `3b492f9` | GPL-3.0 |
| blake-hash — the pure-JavaScript BLAKE-256 (`lib/blake.js`, `lib/blake256.js`) | npm `blake-hash@2.0.0` | MIT |

The circuit `tornado.json` and the proving key `tornadoProvingKey.bin` served under `/classic/artifacts/` are the
original's (tornado-core, GPL-3.0), copied unmodified and pinned by sha256 (`src/prover/artifacts.json`); the
precompiled templates under `src/prover/generated/` are derived from the circuit by `scripts/compile-circuit.mjs`.

## npm dependencies (runtime)

| Package | Licence | Used for |
|---|---|---|
| react, react-dom | MIT | the screens |
| zod | MIT | the configuration |
| big-integer | Unlicense | snarkjs 0.1's and websnark's arithmetic where native BigInt is not used |
| js-sha3 | MIT | the keccak256 chain of the MiMCSponge constants (in place of web3-utils); the call selectors |
| snarkjs 0.7.6 (with ffjavascript, wasmcurves, wasmbuilder — GPL-3.0 —, web-worker, circom_runtime and their closure) | GPL-3.0 | `groth16.verify` alone: a proof verified on the device before it leaves (`src/prover/offline.ts`), inside the prover worker |

The development dependencies (Vite, Vitest, TypeScript, ESLint and their plugins, Testing Library, happy-dom, the
screenshot harness, solc's wrapper) ship nothing in the build.
