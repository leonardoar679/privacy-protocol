# Circuits (circom) — 2-input / 3-output shielded transaction

The zero-knowledge circuit for the shielded pool: `docs/protocol-spec-v1.0.md` §10 (constraints
C1–C13). Groth16 over BN254 (V1 baseline, pluggable), **Poseidon2** (spec §2).

> **Status: compiled, exercised, proven, and verified on-chain end to end in this repo. Not audited
> externally.** The internal review found and fixed PP-C01 (critical), PP-C02/C03, and the privacy
> defects PP-P01/P02 — see [`../docs/circuit-audit.md`](../docs/circuit-audit.md). The trusted setup
> here is a **dev setup, insecure by design**; production needs a multi-party ceremony (spec §18).

| Check | Result |
|-------|--------|
| Compile (`circom 2.2.2 --O2`) | **23,343 constraints**, 14 public inputs |
| Known answers: nargo Poseidon2 vectors + `vectors/primitives.json` | **18/18** (`test/kat.mjs`) |
| Witness soundness harness (honest + single-rule attacks + frozen draft regressions) | **17/17** (`test/witness.mjs`) |
| Groth16 proof/verifier harness | **14/14** (`test/prove.mjs`), ~0.9 s per proof |
| On-chain: verifier 8/8, Poseidon2 KAT 5/5, end-to-end 8/8 (two real proofs incl. the relayer fee note) | `../contracts/test/{verifier,hasher,e2e}` |

## Files
- `transaction.circom` — `Transaction(32, 2, 3)`, spec §10. Derives each input's owner commitment
  from its spending key (C4), binds the per-note secret (C5/C10), enforces membership for real inputs
  (C6), asset (C7/C11) and value (C13) conservation, the mode rules (C12), key-bound derived phantom
  nullifiers (C8) and distinct nullifiers (C9). Public-input order = spec §11.
- `lib/poseidon2/` — vendored TaceoLabs `Poseidon2(t)` permutation (MIT, verbatim, sha256 in
  `../contracts/src/hasher/poseidon2/VENDORED.md`); `lib/poseidon2_hash.circom` — the Noir sponge
  `Poseidon2Hash(n)`; `lib/domains.circom` — domain constants (identical to Solidity / TS / Python).
- `note.circom` (`OwnerCommitment`, `NoteBody` (5 inputs), `NoteCommitment`), `nullifier.circom`
  (`NullifierHasher`, `PhantomNullifier`), `merkle.circom`.
- `vectors/primitives.json` — known answers from `reference/typescript` (`npm run vectors`).
- `test/kat.circom` + `kat.mjs` — the hash and every primitive must reproduce the vectors.
- `test/fixtures/` — witness fixtures from the reference (`npm run fixtures`, `npm run e2e`);
  `v0-draft/` is static and reproduces PP-C01 on `test/regressions/transaction_v0_draft.circom`
  (with its own frozen copies of the pre-Poseidon2 templates under `test/regressions/v0/`).
- `test/witness.mjs`, `test/prove.mjs`, `test/prove-e2e.mjs`, `scripts/dev-setup.sh`, `scripts/e2e-fixture.sh`.

## Build & test
circom 2.x is a standalone binary (`circom-windows-amd64.exe` etc. from the iden3/circom releases).
```
npm install                                   # circomlib (bitify + the draft regression) + snarkjs
(cd ../reference/typescript && npm run vectors && npm run fixtures)

circom transaction.circom --r1cs --wasm --sym --O2 -l node_modules -o build
circom test/kat.circom --wasm -l node_modules -o build
circom test/regressions/transaction_v0_draft.circom --wasm -l node_modules -o build

node test/kat.mjs           # 18/18 known answers
node test/witness.mjs       # 17/17 fixtures
bash scripts/dev-setup.sh   # ~3 min: 2^15 ptau, phase 2, zkey verify
node test/prove.mjs         # 14/14 + Solidity proof fixtures
FORGE_FLAGS="--use <solc>" bash scripts/e2e-fixture.sh   # four e2e proofs for the forge deployment (incl. the swap-order exit + refund-note spend)
```

## The dev setup (insecure by design)
Every contribution is a **public beacon** (sha256 of `privacy-protocol/v1/dev-setup/INSECURE-PUBLIC-BEACON`,
2^10 iterations), so the setup is byte-for-byte reproducible and **anyone can recompute the toxic
waste and forge proofs against this key.** Never deploy `TransactionVerifierDev`. A production key
comes from a multi-party ceremony over the *finalized* circuit (spec §18); the public-input vector
(spec §11) is frozen. The generated verifier inherits snarkjs's **GPL-3.0** template licence.
