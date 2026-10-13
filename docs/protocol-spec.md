# Protocol — overview (the normative text is `protocol-spec-v1.0.md`)

V1 scope: an **immutable, non-custodial, Ethereum-L1 shielded pool** for ETH + selected ERC-20s,
specified exactly in [`protocol-spec-v1.0.md`](protocol-spec-v1.0.md). Nothing more.

## Components
| Component | Role | Code |
|-----------|------|------|
| `PrivacyCore` | immutable state machine; holds NO assets | `contracts/src/core/` |
| `AssetVaultFactory` | one canonical CREATE2 vault per asset | `contracts/src/factory/` |
| `NativeAssetVault` / `ERC20AssetVault` | per-asset custody + strict accounting + claimable payout | `contracts/src/vault/` |
| `Poseidon2Hasher` | the protocol hash on-chain (spec §2) | `contracts/src/hasher/` |
| `IProofVerifier` / `Groth16Verifier` | pluggable, immutable proof verifier | `contracts/src/verifier/` |
| circuit | 2-in/3-out transaction proof (spec §10) | `circuits/` |
| wallet references | keys, notes, witness builder, amount policy, reorg indexer | `packages/protocol/`, `reference/python/` |

## Core principle
The privacy state is **unified** (one global commitment tree for all assets) but monetary custody is
**compartmentalized** (one vault per asset). The core owns the state machine, not the money, so an
asset-issuer freeze can only ever damage that asset's own vault.

## Flows (spec §6, §8, §13)
**Shield (public deposit):** `vault.deposit(ownerCommitment, noteSecret, noteData)` pulls funds with
strict balance-delta accounting and calls `core.commitDeposit`, which forms
`commitment = H(NOTE_COMMITMENT, H(NOTE_BODY, vaultId, amount, ownerCommitment, noteSecret), leafIndex)`
and appends one aligned leaf group. The core never touches the asset.

**Private transfer:** `core.transact(mode = 0)` — a proof over 2 inputs / 3 outputs (recipient,
change, relayer fee — or dummies); nullifiers consumed, three output commitments appended, nothing
public but opaque hashes and fixed-size payloads.

**Withdrawal (public exit):** `core.transact(mode = 1)` — the same, plus `vault.release(recipient,
amount)` on the proof-named canonical vault. A failed payout is booked **claimable** instead of
reverting, so a reverting or frozen recipient cannot grief the relayer (TC-11).

## Public inputs (spec §11)
`root, nullifier0, nullifier1, outputBody0..2, mode, withdrawalVault, withdrawalAmount,
withdrawalRecipient, noteData0..2Hash, txDomain` — `PrivacyCore.encodePublicInputs`. The proof is
bound to this exact vector; `txDomain` binds it to one chain, one core, one circuit.

## State-machine ordering (spec §13.2, CEI-safe)
canonical encodings → txDomain → payload binding → root known → nullifiers distinct + unspent →
verify → mode/vault rules → **effects** (spend nullifiers, append group, advance root) →
**interaction** (vault payout). `nonReentrant` on both core and vault.

## Out of scope for V1
No bridge, governance, DAO, proxy/upgrade, AMM/lending, NFTs, arbitrary private calls, cross-chain,
or central compliance gate. No production verifier/ceremony/audit yet.
