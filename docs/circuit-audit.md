# Circuit Audit Log — `circuits/transaction.circom`

Internal review, done while compiling and exercising the circuit for the first time. It is **not**
an external audit. Every claim below has a command that reproduces it (see *Reproduce*).

## Method (current pipeline — spec v1.0, Poseidon2)
1. **Compile** with circom 2.2.2 (`--r1cs --wasm --sym --O2`): 23,343 constraints, 14 public inputs.
2. **Hash known answers (spec §2)**: the ten nargo/barretenberg Poseidon2 vectors reproduced in
   circom (TaceoLabs permutation + our Noir sponge), Solidity (two independent vendored
   implementations, which must also agree with each other on fuzzed inputs), TypeScript and Python.
3. **Protocol known answers**: a KAT circuit recomputes every value in `vectors/primitives.json`
   (owner commitment, body, commitment, nullifier, phantom, empty root, roots after a deposit group
   and a transaction group) → **18/18**; the on-chain hash path (`Poseidon2Hasher` → `NoteLib` →
   `MerkleAccumulator`) and the Python reference reproduce the same file (31/31).
4. **Witness-level soundness harness**: honest fixtures must be satisfiable; each adversarial
   fixture breaks **exactly one** rule and must be unsatisfiable *at that rule's constraint line*
   (circom reports the template and line) → **17/17**, incl. the frozen pre-audit draft that still
   reproduces PP-C01.
5. **Groth16 proof/verifier harness** over the reproducible dev setup: real proofs verify, every one
   of the 14 public inputs is bound, no cross-transaction replay, public-signal order ==
   `PrivacyCore.encodePublicInputs` → 14/14.
6. **On-chain verifier** (forge 8/8): the same proofs through the `IProofVerifier` adapter on the
   BN254 precompiles; non-canonical inputs and off-curve points rejected.
7. **End-to-end, nothing mocked** (forge 8/8): depth-32 Poseidon2 tree with 4-aligned groups, real
   verifier, two real proofs built by the wallet reference against the live deployment: Alice
   shields 1 ETH and withdraws 0.6 ETH paying a private relayer-fee note; the relayer then spends
   that note. Roots match the wallet's before and after each transaction; replay, a redirected
   recipient, a swapped payload and a premature spend are rejected.

## Findings

### PP-C01 — Critical — owner commitment was a free witness (theft + unlimited re-spend)
**Draft:** `inOwnerCommitment[i]` and `inOwnerKey[i]` were independent private inputs, and nothing
enforced `inOwnerCommitment == Poseidon(OWNER_COMMITMENT, inOwnerKey)`. Membership was proven over
the commitment, and the nullifier was computed from an *arbitrary* key.

**Impact:** anyone who knows a note's opening `(ownerCommitment, amount, vault, leafIndex)` can
spend it, so the **sender of every payment can steal it back**. The leaf index is public and the
sender chose everything else. Each key also yields a different nullifier, so **one note can be
spent any number of times**, draining the other depositors in that vault. This breaks the 1:1
nullifier property (the TC-22 fix) at its root.

**Evidence (executed):** on the compiled draft, three spends of the *same* leaf under the *same*
root were all satisfiable. Alice's key, Mallory's key and a second Mallory key gave three
distinct nullifiers: `16498964…`, `16759905…`, `20295852…`.

**Fix:** the owner commitment is **derived** in-circuit (`OwnerCommitment()` in `note.circom`), and
`inOwnerCommitment` is no longer an input. Opening a note now requires the spending key's
Poseidon preimage, and each note has exactly one nullifier.
**Regression:** `attack-foreign-key` is unsatisfiable at `transaction.circom:100` (membership).

### PP-C02 — Medium — phantom nullifier freely chosen (liveness DoS, fingerprinting, wallet mismatch)
**Draft:** a phantom input's nullifier was the generic nullifier of whatever pad the prover chose.
The default pad gives a **constant** (`54906677…`, identical across all three draft transactions).

**Impact:** the first phantom-padded transaction burns that constant on-chain. Every later one
reverts with `Core: nullifier1 spent`, a liveness DoS on the 1-input path. Wallets that randomize
the pad ad hoc create a fingerprint. And the reference's `phantomNullifier()` could never produce
a valid proof (wallet ⇄ circuit mismatch).

**Fix:** for a phantom slot, `nullifier[i] = Poseidon(PHANTOM_NULLIFIER, nullifier[0], i)`, enforced by
a mux on `inIsReal[i]`. The result is unique per transaction, pseudo-random, domain-separated from
every real nullifier, and matches the reference.
**Regression:** `attack-phantom-burn` (choose `nullifier[1]` = an unspent note's nullifier) is
unsatisfiable at `transaction.circom:119`.

### PP-C03 — Low (defense in depth) — duplicate input notes guarded only by the contract
**Draft:** the same note in both input slots was satisfiable and minted 2× value. Only
`PrivacyCore`'s `require(nullifier0 != nullifier1)` prevented it.

**Fix:** pairwise-distinct nullifiers enforced in-circuit (the inverse gadget, ~1 constraint per pair).
**Regression:** `attack-duplicate-input` is unsatisfiable at `transaction.circom:128`.

**Cost of all three fixes:** 19,800 → 20,553 non-linear constraints (+3.8%). Still 14 public inputs.

### PP-P01 — High — no per-note secret (dictionary attack on recipients; identical dummies)
**Before:** `outputBody = H(dom, ownerCommitment, amount, vaultId)`. A recipient's `ownerCommitment`
is their receiving address, so anyone who knows it (every past sender) could recompute candidate
bodies for plausible amounts and identify **all** of that recipient's incoming notes on-chain; and
every dummy output (`amount 0`) of a given sender hashed to the **same** value, marking dummies and
linking that sender's transactions.

**Fix (spec §5):** `body = H(NOTE_BODY, vaultId, amount, ownerCommitment, noteSecret)` with a
uniformly random `noteSecret` carried in the encrypted payload; dummies use a random owner (no key →
unspendable) and a random secret. Witness `attack-wrong-note-secret` is unsatisfiable at the
membership constraint; `reference.test.ts` checks that two notes differing only in the secret hash
differently. The deposit path takes `noteSecret` as calldata (a public shield is public anyway;
wallets should use a deposit-only owner key — the reference wallet does since 2026-10-16: every deposit is made out to
its own, `packages/protocol/src/keys.ts` `deriveOwnerKey`, with no circuit change).

### PP-P02 — Medium — phantom nullifier recomputable by observers
**Before (my PP-C02 fix):** `nullifier[1] = H(PHANTOM, nullifier[0], 1)` — derivable from on-chain
data, so an observer could test every transaction and learn which ones had a single real input,
exactly what the fixed 2-input shape is meant to hide (plan §15).

**Fix (spec §5.4):** `H(PHANTOM_NULLIFIER, nullifier[0], inputIndex, spendKey[0])` — the private
spending key makes it unrecomputable while keeping it unique per transaction and derived in-circuit.
Witness `attack-phantom-without-key` (a phantom computed without the key) is unsatisfiable at C8.

**Cost of the Poseidon2 migration + PP-P01/P02:** 20,553 → 23,343 constraints (+13.6%); still 14
public inputs (`chainId` → `txDomain`, spec §11).

## Verified, no finding
| Property | Evidence |
|---|---|
| Value conservation (§31) | `attack-inflation` (1.1 out of 1.0) → unsatisfiable at `:161` |
| Range checks, incl. field wrap-around | `attack-negative-amount` (2.0 + (p − 1.0) ≡ 1.0) → unsatisfiable in `Num2Bits` |
| Asset conservation (§32) | `attack-cross-asset` → unsatisfiable at `:149` |
| Mode rules | `attack-withdraw-wrong-vault` → `:158`; `attack-withdraw-as-transfer` → `:157` |
| Honest flows | `ok-transfer`, `ok-withdraw`, `ok-two-inputs` satisfiable and provable |
| Public-signal order == `PrivacyCore.encodePublicInputs` | `test/prove.mjs` (exact 14-field match) |
| All 14 public inputs bound | `test/prove.mjs` + `contracts/test/verifier/Groth16RealProof.t.sol` |
| Non-canonical public input (≥ r) rejected, off-curve proof point rejected | `Groth16RealProof.t.sol` |
| On-chain Poseidon2 == nargo vectors == circuit == wallet == Python | `contracts/test/hasher/Poseidon2Hasher.t.sol` (5, incl. fuzz), `reference/python/test_vectors.py` (31/31) |
| Full shield → private withdraw on-chain with a real proof | `contracts/test/e2e/RealProofE2E.t.sol` (6/6) |

## Other observations
- **PP-O01 — malformed proofs burn the submitter's whole gas limit.** A failed BN254 pairing
  precompile consumes all gas forwarded to it (EIP-197). forge shows ~1.02B gas for an off-curve
  point, which is just the test gas limit. It is fail-closed and costs the protocol nothing, but a
  relayer that forwards a user's proof without first simulating it (`eth_call`) and without a tight
  gas limit pays for it. That is the same class as the study's TC-11 relayer gas-drain. Relayer
  guidance: always simulate, and cap `gasLimit`.
- **PP-O02 — gas.** With Poseidon2 and 4-aligned leaf groups, `transact` costs **1.79M gas**
  (was 4.44M) and `deposit` **1.52M** (was 1.71M); ~60% of both is the 32–33 Merkle-path hashes.
  Live cost and the levers are in `benchmarks/gas` (`node cost.mjs`): at today's ~0.15 gwei a
  private transaction is ≈ $0.75; the plan's §79 gas targets are still 2.4–10× away.
- **The generated verifier is GPL-3.0** (snarkjs's template); the rest of `contracts/` is MIT.
  That's fine for the test artifact, but confirm the licensing posture before shipping the
  ceremony-generated one.

## Decisions taken since the first review
- **Relayer fee** = a private output note (spec §5, plan §49): no public relayer field, the
  public-input count stays 14; executed end to end (`test_E2E_RelayerSpendsPrivateFeeNote`).
- **Poseidon2** everywhere (spec §2), pinned by the nargo vectors in all four implementations.
- **Chain/core/circuit binding** = `txDomain` (spec §11) in place of the bare `chainId`.
- **Groth16 proofs are malleable** (re-randomizable). Nothing in `PrivacyCore` keys on proof bytes;
  nullifiers are the uniqueness key. Keep it that way.

## Reproduce
```
cd packages/protocol && npm test && npm run vectors && npm run fixtures
cd ../python && python test_vectors.py                 # 31/31
cd ../../circuits
circom transaction.circom --r1cs --wasm --sym --O2 -l node_modules -o build
circom test/kat.circom --wasm -l node_modules -o build
circom test/regressions/transaction_v0_draft.circom --wasm -l node_modules -o build
node test/kat.mjs        # 18/18 (nargo Poseidon2 + primitives.json)
node test/witness.mjs    # 17/17 fixtures (v1 + draft regressions)
bash scripts/dev-setup.sh && node test/prove.mjs       # 14/14 Groth16 harness + Solidity fixtures
FORGE_FLAGS="--use <solc>" bash scripts/e2e-fixture.sh # two e2e proofs for the forge deployment
cd ../contracts && forge test                          # 65 tests: mock suites + verifier + hasher + e2e + no-privilege
```
