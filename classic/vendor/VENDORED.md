# Vendored prover — origins and hashes

The Classic app proves withdrawals with the original's own stack (spec v3.0 §7.3; the compatibility matrix §1–§2): the
files below are copied **byte for byte** from the pinned upstreams and never edited. `scripts/vendor.mjs` turns them into
the ES modules under `src/prover/legacy/` by the literal replacements it lists (CommonJS into imports, `Buffer` into
`Uint8Array`, the two `eval`s of the witness calculator into the precompiled templates, web3-utils into js-sha3,
blake-hash's native binding into its own pure JavaScript, websnark's "a browser is a window" into "not Node", its worker
count bounded, its randomness from `globalThis.crypto`); `node scripts/vendor.mjs` fails when a module differs from that
conversion, and `test/vendored.test.ts` re-hashes every file here against this table. All of it is **GPL-3.0** except
blake-hash (MIT); the Classic app is GPL-3.0 for that reason (`../LICENSE`, `../THIRD_PARTY_NOTICES.md`).

## Sources

| Upstream | Pinned at | Taken from | Licence |
|---|---|---|---|
| `tornadocash/websnark` | commit `4c0af6a8b65aabea3c09f377f63c44e7a58afa6d` (2020-04-13, "pin snarkjs version" — the phase2 build whose FFT non-residue is 7; master `2041cfa5` proves invalidly against the deployed key) | the read-only clone `E:\Code\Tornado\reference\websnark`, `git show 4c0af6a8:<path>` | GPL-3.0 (`websnark/COPYING`) |
| `snarkjs` 0.1.20 (the witness calculator the original UI and CLI used; the tornadocash fork `869181cf` is byte-identical in these files) | the npm registry tarball `snarkjs-0.1.20.tgz`, sha256 `b9d25fb798f9408aa3218e75ddcf10452ca52749fde5914abdaef9e680d77112` | the tarball's `package/` | GPL-3.0 (`snarkjs-0.1.20/COPYING`) |
| `tornadocash/circomlib` | commit `3b492f9801573eebcfe1b6c584afe8a3beecf2b4` (2020-10-27; the pin of the original's `package.json`) | the read-only clone `E:\Code\Tornado\reference\circomlib` at that commit | GPL-3.0 (the manifest's `license`; the repository carries no licence file at that commit) |
| `blake-hash` 2.0.0 (the BLAKE-256 the Pedersen generators are derived with; circomlib's dependency) | the npm registry tarball `blake-hash-2.0.0.tgz`, sha256 `8703b531f70f5bd5fbc7f0a60697b377d34a032e304213a1eeafaa49101d7f39` | the tarball's `package/lib/` (the pure-JavaScript engine; the native binding is not vendored) | MIT |

Registry packages the converted modules import at run time (reviewed in `../../docs/dependency-reviews.md`):
`big-integer@1.6.52` (Unlicense; snarkjs 0.1's and websnark's arithmetic where native BigInt is not used),
`js-sha3@0.13.0` (MIT; the keccak256 chain of the MiMCSponge constants, in place of web3-utils). `snarkjs@0.7.6`
(GPL-3.0) verifies proofs offline (`src/prover/offline.ts`); it is not part of the vendored stack.

## Files (sha256 of the LF bytes)

| File | Bytes | sha256 |
|---|---|---|
| `blake-hash-2.0.0/lib/blake.js` | 2671 | `81d3fc05774490d0f67ce7392d2d38da2bfbe95435350f8e3490a19b5d51d3b4` |
| `blake-hash-2.0.0/lib/blake256.js` | 3206 | `4b1bf75d0b8beb1f42e25f3d0b19a82031d8b085fc38d607710553130b97e81a` |
| `blake-hash-2.0.0/package.json` | 730 | `73d4d2afec23fbdf5c66236f777dde513753f43b02a7984654604ba7f50c7ade` |
| `circomlib/package.json` | 865 | `0862abbae2f0a5ccee6b0ec8d0e77785c2eb676139c00649815b94150b48a19d` |
| `circomlib/src/babyjub.js` | 3135 | `14c86fcedbd4f64243311b4ef1580ecea179ee9b790333bce7c275293cd04a83` |
| `circomlib/src/mimcsponge.js` | 2258 | `d931bb6e7639107abf7597758aee85ee131482fddc98de7115973fae88097c4f` |
| `circomlib/src/pedersenHash.js` | 3065 | `7fa3e464680f6d593709aa14ebd4bc82ee95b9d0d33fbd99c2fbb49450ed0f17` |
| `snarkjs-0.1.20/COPYING` | 35141 | `589ed823e9a84c56feb95ac58e7cf384626b9cbf4fda2a907bc36e103de1bad2` |
| `snarkjs-0.1.20/package.json` | 806 | `51cc7e94ca3ef4f9b016550de65d7fbfeb6aa44d805510ed281e55a0c286695c` |
| `snarkjs-0.1.20/src/bigint.js` | 11553 | `ed536201cd51de513a43c1732867d7f85456a178e4c124d5aa77d5aa82105f20` |
| `snarkjs-0.1.20/src/calculateWitness.js` | 8137 | `0239f6419dcf04fa09dd7140c534899c140d804f7b20d5a0918649103800d932` |
| `snarkjs-0.1.20/src/circuit.js` | 6213 | `a72556c35e886953de1e0c4340702cf358ca58a2653aa464516ba8def68641e0` |
| `snarkjs-0.1.20/src/futils.js` | 1328 | `5f764b866aac6634a398648e6a5b9520976164a7afd865df16dacfaa5afa46d0` |
| `snarkjs-0.1.20/src/stringifybigint.js` | 1675 | `3c9812d0ab408321f0fc4b525b5fbb34198cbe2c59e9ae0be9eac2432e40c528` |
| `snarkjs-0.1.20/src/zqfield.js` | 4037 | `120352eaccd8d0c4578a9ced552c84c399f5b62b1b70a8861c7e9e8713616d6d` |
| `websnark/COPYING` | 35141 | `589ed823e9a84c56feb95ac58e7cf384626b9cbf4fda2a907bc36e103de1bad2` |
| `websnark/build/groth16_wasm.js` | 40356 | `f3dfe57eeb393d1a07794c1e710805e748064345f5f4ad2fb594a7882aa47d3c` |
| `websnark/package.json` | 1066 | `901fc7bf8d03b5cf5ee076565065161848edfcbf86e24f0e7cb34d63c3e4bdaa` |
| `websnark/src/groth16.js` | 19872 | `715466cd17ee6f096e2cf052dfbd2ffde77de10a95d8e0c1ea8b942b362bd932` |
| `websnark/src/utils.js` | 3655 | `0441ef88c50121d856fea5c26122455b061d3af18b62cfa69e021b026fe5d6ba` |
| `websnark/tools/stringifybigint.js` | 2689 | `5053c72386313a8ce31999248e4ec9789a19610e25fc9ba36e6e7b23d5e74d13` |

## What the conversion changes, file by file

The lists are the authority (`scripts/vendor.mjs`, `FILES`); this is the summary.

- **snarkjs 0.1.20** `bigint.js`, `futils.js`, `zqfield.js`, `stringifybigint.js`: imports and exports; `Buffer.alloc`
  → `Uint8Array`; the field's random byte from `globalThis.crypto`. `circuit.js`: the constructor takes the precompiled
  templates and functions (`src/prover/generated/templates.js`, from `scripts/compile-circuit.mjs`) in place of the two
  `eval` loops; the constraints are optional (the served `witness.json` carries none). `calculateWitness.js`: imports
  and exports, and **the triggering of ready components made iterative** — the original ran a component the moment its
  last input was set, nested inside that setter, and one withdrawal is a chain of about 8,800 components (220 MiMC
  rounds × 2 × 20 levels), deeper than a Web Worker's stack (Chrome overflowed where Node did not); a ready component
  now waits in a queue — when a signal not yet set is read, `drainFor()` runs the waiting components, last ready first
  (so a parent runs before a child whose inputs alias its own), until the signal is set, and `drain()` runs the rest
  once the inputs are all set. The values are the same: `test/prover.test.ts` holds the converted calculator's witness,
  signal for signal, to the pristine original's (loaded with its `eval`, in Node).
- **websnark** `utils.js`: imports; `genWitness` and `genWitnessAndProve` take the precompiled templates.
  `groth16.js`: imports (`big-integer`, the WebAssembly module, `node:` built-ins loaded only in Node); "in a browser"
  means "not Node" (the prover runs in a Web Worker, which has no `window`); `maxWorkers` bounds the sub-workers; the
  randomness of `r` and `s` from `globalThis.crypto`; `TERMINATE` closes a Web Worker with `self.close()`; the default
  export. `build/groth16_wasm.js`: the base64 WebAssembly decoded with `atob` into a `Uint8Array` (no `Buffer`), the
  two offsets kept. `tools/stringifybigint.js`: imports and exports.
- **circomlib** `babyjub.js`: the field from the vendored snarkjs (`r`, `Fr`) in place of `snarkjs.bn128`, named
  exports, `Uint8Array.from`. `pedersenHash.js`: blake-hash's engine called as `update(bytes)` then `digest()`.
  `mimcsponge.js`: web3-utils' `keccak256` replaced by js-sha3 with web3-utils' convention (a `0x` string hashed as
  bytes, any other string as UTF-8); the constants chain and the rounds untouched.
- **blake-hash** `blake.js`, `blake256.js`: `Buffer` → `Uint8Array` with two helpers for the big-endian 32-bit words.

What is proven about the result: the MiMCSponge reproduces the deployed pools' twenty `zeros(i)` and the 100 ETH pool's
own root over 27,544 real leaves (`vectors/zeros.json`, `vectors/roots.json`); the Pedersen hashes equal circomlibjs
0.1.2's on the note vectors (`vectors/notes.json`); a proof of the converted pipeline verifies under snarkjs 0.7.6 with
the deployed verifier's key and is accepted by the deployed verifier itself (`vectors/proof.json`,
`test/live/verifier.live.test.ts`).
