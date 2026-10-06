# Contracts — Privacy Protocol V1 (Foundry)

The immutable, asset-free core plus per-asset canonical vaults, exactly as specified in
[`../docs/protocol-spec-v1.0.md`](../docs/protocol-spec-v1.0.md). **No external dependencies**: a
minimal `ReentrancyGuard` and the two Poseidon2 implementations are vendored (`src/utils`,
`src/hasher/poseidon2`, provenance + sha256 in `VENDORED.md`), so `forge build` needs only solc.

## Status: built + tested ✅ — 65/65 (this environment)
- **Mock-based suites (44)** — `MockVerifier` + `MockHasher` isolate the state machine: fund-safety
  smoke, strict ERC-20 accounting with the full token zoo (plan §72), issuer-freeze isolation across
  three vaults (§71), adversarial proof-binding, the reentrancy matrix (§73), block-based root history
  + tree-capacity stress, 5 stateful fuzz invariants (core holds nothing in ETH or ERC-20, every vault
  solvent, no cross-asset backing, aligned leaf groups), and the **no-privilege bytecode scan** (§74).
- **Real Poseidon2 (5)** — both vendored implementations reproduce the nargo vectors and agree on fuzzed inputs.
- **Real Groth16 verifier (8)** — real proofs of `circuits/transaction.circom` on the BN254 precompiles.
- **End to end (8)** — nothing mocked: depth-32 Poseidon2 tree with 4-aligned groups, real verifier,
  two real proofs built by the wallet reference for this deployment (a shield → private withdrawal
  paying a private relayer-fee note → the relayer spending it).

## Build / test
This machine's forge crashes on the svm solc auto-fetch, so pass a local solc and run offline:
```
FOUNDRY_OFFLINE=true forge build --use "$SOLC"
FOUNDRY_OFFLINE=true forge test  --use "$SOLC" -vv
forge test --match-contract GasBench -vv          # steady-state gas (feeds ../benchmarks/gas)
DEV_VERIFIER=true forge script script/Deploy.s.sol  # local dry run of the deployment sequence
```
On a normal machine `forge build && forge test` (letting forge fetch solc) is enough. Build
settings are pinned in `foundry.toml` (solc 0.8.24, optimizer 200, paris, no metadata) so the
deployed runtime code is reproducible byte-for-byte (spec §18).

## Layout
- `src/core/` — `PrivacyCore` (state machine; immutable; holds no assets), `CoreTypes` (public-input
  struct, errors, identifiers), `IPrivacyCore`.
- `src/vault/` — `BaseAssetVault` + `NativeAssetVault` + `ERC20AssetVault` (strict accounting,
  claimable payout), `IAssetVault`, `VaultTypes`.
- `src/factory/` — `AssetVaultFactory` + `IAssetVaultFactory` (one canonical CREATE2 vault per asset).
- `src/verifier/` — `IProofVerifier`; `Groth16Verifier` (adapter over an immutable snarkjs verifier);
  `dev/TransactionVerifierDev.sol` (generated from the **insecure dev setup**, tests only).
- `src/hasher/` — `Poseidon2Hasher` (the production `IHasher`) over `poseidon2/` (vendored).
- `src/libraries/` — `MerkleAccumulator` (4-aligned groups, block-based roots), `NoteLib`,
  `NullifierLib`, `FieldLib`, `DomainSeparators`, `IHasher`.
- `script/Deploy.s.sol` — the spec §18 deployment sequence (refuses the dev verifier off-chain-31337).
- `abi/` — the frozen ABI set (spec §14) with `SHA256SUMS`; regenerate from `out/` after an ABI change.
- `test/` — `mocks/`; `core/ vault/ issuer-risk/ adversarial/ reorg/ invariants/ gas/` (mock suites);
  `hasher/ verifier/ e2e/` (real crypto).

## Deploying (what must be true)
`PrivacyCore(verifier, hasher, 32)`: the tree depth must equal the circuit's (32) and the hasher must
be `Poseidon2Hasher` (the circuit's exact instance). The `Groth16Verifier` must wrap a verifier from a
real ceremony, never `TransactionVerifierDev`. Gas at depth 32: `transact` ≈ 1.79M, `deposit` ≈ 1.52M
(`../benchmarks/gas`, live cost via `node cost.mjs`).

## Regenerating fixtures
`test/verifier/DevProofFixtures.sol` comes from `circuits/test/prove.mjs`; `test/e2e/E2EFixture.sol`
from `circuits/scripts/e2e-fixture.sh`. The proofs bind the vault's address, so any change to the
vault/core bytecode (or build settings) makes the e2e tests fail with "fixture is stale" — rerun the
script. Lint warnings (arbitrary-send on the withdrawal; bounded typecasts) are expected and documented inline.
