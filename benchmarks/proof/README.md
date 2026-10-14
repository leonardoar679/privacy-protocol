# Proof benchmarks — Groth16 / BN254 (circom 2.2.2 + snarkjs 0.7.6)

Measured numbers for `circuits/transaction.circom` (spec §10: 2-in/3-out, depth 32, Poseidon2) on
the authoring machine (Windows 11, Node 24, snarkjs multi-threaded WASM prover). **Desktop** figures;
the mobile column of the decision rule (plan §41–42) is still open.

| Metric | Value |
|---|---|
| Constraints | **23,343** (`--O2`; 20,553 before Poseidon2 + the per-note secret) |
| Public inputs | 14 (spec §11) |
| Proving time, witness + proof (`groth16.fullProve`) | **0.83–0.98 s** per transaction |
| Proof size | 256 bytes (2 G1 + 1 G2, as `abi.encode(a, b, c)`) |
| On-chain verification | **285,523 gas** (adapter), 275,361 (raw verifier) |
| Proving key (`.zkey`) / witness wasm / r1cs | 29.4 MB / 0.2 MB / 23.3 MB (`--O2` folds the linear constraints into denser ones: fewer constraints, a larger key) |
| Powers of tau needed | 2^15 |
| Trusted setup | per-circuit Groth16 phase 2 — a **ceremony** is required for production |

The setup used here is the deterministic dev setup (`circuits/scripts/dev-setup.sh`), insecure by
design. Timings do not depend on who contributed, so they carry over to a ceremony key.

## The Rust prover on wasm32 (V6 Stage 15; spec v2.0 §14.3)

The rule: the wallet adopts the Rust prover in the browser only if it is at least 1.5× faster than snarkjs, run as
the browser runs it (with worker threads), and its public signals are identical. Otherwise snarkjs stays and the
numbers stay here.

The Rust prover is `privacy-core/privacy-prover-wasm`, a bench-only crate. It is the native prover compiled to
wasm32: the witness through the `wasmi` interpreter, arkworks Groth16 on a single thread.

Measured on 2026-10-14 on the authoring desktop (28 threads, Node 24): the dev zkey, the `ok-transfer` inputs, all
bytes in memory, three runs after a warm-up (`results-2026-10-14.json`).

| Prover | Median | Runs |
|---|---|---|
| snarkjs `fullProve`, worker threads | **934 ms** | 916 / 934 / 1716 ms |
| snarkjs `fullProve`, single thread | 7,490 ms | 7549 / 7450 / 7490 ms |
| Rust on wasm32, single thread | 6,340 ms | 6248 / 6412 / 6340 ms |

- The public signals are identical, and both proofs verify under the dev verification key.
- The Rust prover is **0.15×** threaded snarkjs and 1.18× single-threaded snarkjs: **not adopted**. The difference is
  threads, not the arithmetic.
- The way back in is a threaded build (wasm-bindgen-rayon). It needs `SharedArrayBuffer`, so the app must be
  cross-origin isolated (COOP/COEP headers). The benchmark would then compare threaded with threaded; that is a later
  pass.

Reproduce:
```
node build.mjs                       # CARGO, CARGO_HOME, WASM_BINDGEN (0.2.117) as for privacy-core/scripts/build-wasm.mjs
node rust-wasm-vs-snarkjs.mjs 3      # writes results-<date>.json
```

## Still pending (Stage 12)
- Mobile proving (mid-range and flagship) and browser proving in a Web Worker; the proving-key
  download is itself a mobile UX cost.
- The same circuit in a universal/transparent system (PLONKish/Halo2, FRI) for the plan's §41–42
  decision: proving time, proof size, verify gas and setup assumptions side by side.

## Reproduce
```
cd ../../circuits
circom transaction.circom --r1cs --wasm --sym --O2 -l node_modules -o build
bash scripts/dev-setup.sh
node test/prove.mjs        # prints proving time per transaction
```
