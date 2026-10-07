# Audit package — plan step 20 (independent audits)

Status (2026-10-06): **package assembled; no engagement started.** This document is what an external
auditor receives first: scope, how to pin and rebuild the code, where the invariants and tests are,
what is known to be unfinished, and the questions we want answered. The engagement itself (choice of
firm, scheduling, fix rounds, report publication) is outside this repository.

## 1. Scope
| Component | Path | Lines of interest | Audit question |
|---|---|---|---|
| **PrivacyCore + vaults (immutable money layer)** | `contracts/src/core`, `contracts/src/vaults`, `contracts/src/factory`, `contracts/src/verifier`, `contracts/src/hasher` | `PrivacyCore.transact/deposit`, `NativeAssetVault`, `ERC20AssetVault`, `AssetVaultFactory`, `Groth16Verifier` adapter | Can anyone move value without a valid proof of a note they own? Can a vault release more than it holds? Can any path change the tree, the nullifier set or the verifier after deployment? |
| **Circuit** | `circuits/transaction.circom` (+ `circuits/lib`) | 2-in/3-out transaction, Poseidon2, Merkle (depth 32), nullifier derivation, public-input binding | Soundness: can a witness exist for a transaction that is not a legitimate spend (fake Merkle path, wrong owner, value imbalance, nullifier malleability)? Does every public input bind what the contract assumes? |
| **Poseidon2** | `circuits/lib/poseidon2*.circom`, `contracts/src/hasher/Poseidon2Hasher.sol`, `reference/typescript/src/poseidon2.ts`, `reference/python` | round constants, MDS, domain separation | Do the four implementations agree (vectors) and match the chosen parameter set? |
| **Swap periphery (replaceable)** | `contracts/src/periphery/swap/*` | `SwapOrderEscrow.execute/refund`, `SwapOrderFactory` (CREATE2) | Can anyone but the order key choose provider / value / calldata / deadline? Can an escrow leak more than its own balance? Can a refund re-shield something other than the committed note? |
| **PrivateSwap engine** | `services/private-swap/src` | adapters' local verification (`lifi.ts`, `chainflip.ts`, `thorchain.ts`, `mayan.ts`, `across.ts`), `engine.ts`, `endpoints.ts`, `scoring.ts` | Does the engine sign only calldata it verified? Does the escrow prediction / digest exactly match the contracts? |
| **Relayer (replaceable)** | `services/relayer/src` | `relayer.ts::validateShape/submit` | Can a request make the relayer spend gas without paying it, or alter what is submitted? (It should not be able to: every field is proof-bound.) |
| **Wallet reference** | `reference/typescript/src` (keys, notes, amounts, payload envelope) | key derivation, note commitment, bucket policy | Is anything derived from the master seed reusable across contexts? Is the payload envelope binding? |

Out of scope: zkAPI (third party; our assessment is `docs/zkapi/security.md`), the six providers'
own contracts, the UI shell (`frontend`), gas optimisation.

## 2. Pinning and reproducing
- Repository: this directory (`privacy-protocol`); the auditor pins the commit hash of the handed-over
  tree. Core ABIs are frozen and checksummed: `sha256sum -c contracts/abi/SHA256SUMS`.
- Build settings are pinned in `contracts/foundry.toml` (solc 0.8.24, optimizer 200 runs, paris,
  no metadata hash): `cd contracts && FOUNDRY_OFFLINE=true forge build --use <solc-0.8.24>` must
  reproduce `contracts/abi/*.json` byte for byte.
- Circuit: `circuits/README.md` (circom 2.2.2, `--O2`), constraint count 23,343 / 14 public inputs;
  the dev setup (`circuits/scripts/dev-setup.sh`) is **insecure by design** (single-party, power 15)
  and only exists to exercise real proofs in tests — the production ceremony is still owed.
- Specifications the code claims to implement: `docs/spec-v1.0.md` (core), `docs/vault-spec.md`,
  `docs/private-swap-spec-v1.1.md` (periphery + engine), `docs/zkapi-integration-spec.md`.

## 3. Invariants and the tests that execute them
`docs/security-invariants.md` is the index (core invariants, issuer isolation, reentrancy, liveness /
reorgs, circuit soundness, proof binding, end-to-end, periphery, privacy). Test inventory:
| Suite | Count | Runs |
|---|---|---|
| contracts (forge) | 87: 45 mock-based incl. 5 fuzz invariants, token zoo, no-privilege bytecode scan; Poseidon2 KAT 5; real verifier 8; **real-proof e2e 10** (incl. note → escrow → provider, escrow → refund note → spent); swap periphery 19 | `FOUNDRY_OFFLINE=true forge test --use $SOLC` |
| circuits | KAT 18, soundness 17 (negative witnesses), Groth16 harness 14 | `circuits/README.md` |
| reference | TypeScript 35 (vitest), Python 31 (vectors); four implementations agree on every primitive | `npm test` in `reference/typescript`, `python reference/python/test_vectors.py` |
| private-swap engine | 96 vitest: 31 offline (state machine, scoring, privacy score, endpoint == forge vector, signature recovery), 19 live adapter quotes, **42 adversarial** (plan §71/§74: outage, refusal, tampered calldata/quotes per provider, status mapping), 3 flow (§72) — `docs/test-matrix.md` | `npm test` (network) |
| privacy | lab (`benchmarks/privacy/results.json`), cross-chain lab (`benchmarks/privacy/crosschain.json`) | `docs/privacy-lab.md` |
| relayer | 23 vitest: private submission vs the forge e2e transaction, swap executor vs the periphery vector, journals, limits | `cd services/relayer && npm test` |
| **everything** | `node scripts/verify-all.mjs --forge <solc-0.8.24>` (add `--live` for the provider suites) — 8/8 steps here, incl. `tsc --noEmit` for the swap engine and the relayer | |

## 4. Known gaps and open decisions (please do not re-discover these)
1. **No production ceremony.** The deployed verifier must come from a multi-party setup; the dev
   verifier is gated to chain ids 31337 / 11155111 in `contracts/script/Deploy.s.sol`.
2. **Proof system not final** (plan §41–42): Groth16 today; Halo2/FRI comparison outstanding.
3. **Payload cipher binding is a proposal** (`crypto-spec.md`, "Output payload envelope"): view key → X25519 via tagged sha256, envelope key from the shared secret and both public keys; please review the KDF and the absence of sender authentication (by design: the recipient verifies the opening against the leaf).
4. **Gas above targets** (`transact` 1.79M vs 650k target); levers in `benchmarks/gas/README.md`.
5. **Wallet-side proving is stubbed** in the UI shell; proofs are produced by the test pipeline.
6. **Provider adapters are mainnet-pinned**; NEAR Intents' ingress is withheld (contract-sent
   deposits unconfirmed); Mayan's source-chain swap leg trusts Mayan's router calldata within the
   §74 damage bound; THORChain's gateway quorum is limited to the two public gateways reachable.
7. **Cross-chain privacy is throughput-bound** (`docs/privacy-lab.md`, cross-chain section): the
   score now says so; a live provider-volume feed is still to be built.
8. **zkAPI** is used as service credit only; its own issues (pause + 30-day expiry, single-party
   setup, server-dependent operation) are in `docs/zkapi/security.md`.

Running the stack on a workstation (browser + chain), in the order that exercises every flow: `docs/local-run.md`.

## 5. Threat model and trust assumptions
`docs/threat-model.md` (what V1 trusts, what it explicitly does not, the three-layer boundary of
V1.1 with the compromise table). The one sentence version: the money core trusts the circuit, the
verifier and Poseidon2 and nothing else; every provider, relayer, RPC, zkAPI server and the wallet UI
can be malicious without touching shielded funds, and the tests in §3 try to prove that.

## 6. Questions for the auditors
1. Circuit: any public-input or constraint that lets a prover reuse a nullifier, spend a note it
   does not own, or create value — especially around the two-input / three-output boundary and the
   root freshness assumption (`docs/spec-v1.0.md` §9).
2. Contracts: any sequence of external calls (vault release, escrow execute/refund, token hooks in
   the "token zoo") that re-enters or desynchronises vault accounting from the tree.
3. Periphery: can a relayer, provider or factory caller ever make an escrow forward funds to an
   address or with calldata the order key did not sign? Can `refund` be front-run to a different note?
4. Engine: is anything the order key signs still taken on trust from a provider API after the
   checks in `docs/test-matrix.md` (§74 table)?
5. Key derivation: domain separation between spend / view / note / order keys and the refund note
   secrets (`reference/typescript/src/keys.ts`, `frontend/src/keys/swapKeys.ts`).

## 7. Deliverables expected from the engagement
Findings with severity and reproduction; a fix-review round; a statement on the ceremony requirements;
a public report that can be linked from `README.md`. Fix commits will reference finding ids.
