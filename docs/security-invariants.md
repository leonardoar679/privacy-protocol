# Security Invariants — V1

Spec §16 / plan §70–§71, each mapped to the executed test that demonstrates it. Run:
`cd contracts && forge test` (see `contracts/README.md` for the exact solc/offline invocation).

## Core invariants (plan §70)
| # | Invariant | Test |
|---|-----------|------|
| 1 | PrivacyCore ETH balance == 0 | `invariants/Invariants.t.sol::invariant_CoreHoldsNoETH` (fuzz), `core/Smoke.t.sol::test_CoreHoldsNoAssets_AfterDeposit`, `e2e/RealProofE2E.t.sol` |
| 2 | PrivacyCore ERC-20 balance == 0 | `invariants/…::invariant_CoreHoldsNoERC20` (fuzz), `vault/ERC20Accounting.t.sol::test_StandardToken_DepositWithdraw` |
| 3 | one note → one successful nullifier | circuit C4/C8 (`attack-foreign-key`, `attack-phantom-*`), `reference.test.ts` 1:1, `e2e/…::test_E2E_RealProofWithdraws` |
| 4 | spent nullifier cannot be reused | `core/Smoke.t.sol::test_DoubleSpend_Reverts`, `adversarial/Adversarial.t.sol::test_NullifierReuse_AcrossTransactions_Rejected`, `test_DuplicateNullifier_Rejected`, `e2e/…::test_E2E_ReplayRejected` |
| 5 | invalid proof cannot modify state | `adversarial/…::test_MalformedProof_Rejected`, `test_TamperedRecipient_Rejected`, `test_TamperedAmount_Rejected`, `verifier/Groth16RealProof.t.sol` (8), `e2e/…::test_E2E_RedirectedRecipientRejected` |
| 6 | invalid root cannot modify state | `reorg/RootHistory.t.sol::test_RootExpiresAfterBlockWindow`, `e2e/…::test_E2E_FeeNoteSpendBeforeItExistsRejected` |
| 7 | vault A cannot release asset B | `invariants/…::invariant_NoCrossAssetBacking` (fuzz), `adversarial/Reentrancy.t.sol::test_VaultReleaseIsCoreOnly`; in-circuit asset conservation C7/C11 |
| 8 | non-canonical vault cannot be used | `adversarial/…::test_NonCanonicalVault_Rejected`, `adversarial/Reentrancy.t.sol::test_MaliciousVault_Rejected` |
| 9 | unsupported token behaviour cannot corrupt accounting | `vault/ERC20Accounting.t.sol` (fee-on-transfer, rebasing, burn, false-return, malformed-return rejected; no-return supported; pause → claimable; donation ≠ liability) |
| 10 | no privileged state transition exists | `invariants/NoPrivilege.t.sol` — runtime bytecode of core/vaults/factory has no DELEGATECALL/CALLCODE/SELFDESTRUCT (core/vaults also no CREATE*), no admin-style selector dispatched; everything else is `immutable` |

Also: chain/core/circuit binding (`adversarial/…::test_WrongTxDomain_Rejected`), payload binding
(`test_SwappedNoteData_Rejected`, `test_WrongSizeNoteData_Rejected`, `e2e/…::test_E2E_SwappedNoteDataRejected`),
canonical encoding (`test_NonCanonicalField_Rejected`), leaf groups always aligned
(`invariants/…::invariant_LeafGroupsAligned`), tree capacity (`reorg/…::test_RootStress_1000Inserts`).

## Issuer isolation (plan §71) and vault solvency
| Invariant | Test |
|-----------|------|
| Blacklist(vault_X) changes no state of any other vault, the tree, or the nullifier set | `issuer-risk/IssuerFreeze.t.sol::test_BlacklistVault_DamageIsAssetLocal` (snapshot of ETH + USDC vaults unchanged; tree + nullifiers advance) |
| a failed vault_X transfer creates no deficit elsewhere | `issuer-risk/…::test_DestroyVaultFunds_IsolatedInsolvency` |
| Blacklist(core) is inert | `issuer-risk/…::test_BlacklistCore_NoPrincipalAffected` |
| frozen recipient → claim, never a revert (TC-11) | `issuer-risk/…::test_BlacklistedRecipient_GetsClaim_NotRevert`, `vault/…::test_PausedToken_RejectedOnDeposit_ClaimableOnWithdraw` |
| actualBalance ≥ accountedDeposits + totalClaimable, every vault | `invariants/…::invariant_VaultsSolvent` (fuzz, ETH + ERC-20) |
| one canonical vault per asset, deterministic salt | `vault/…::test_Factory_OneCanonicalVault_Deterministic` |

## Reentrancy (plan §73)
| Path | Test |
|------|------|
| release() → token → release() | `adversarial/Reentrancy.t.sol::test_ReleaseReenteringRelease_IsBlocked` (payout becomes a claim; released once) |
| release() → token → core.transact() | `…::test_ReleaseReenteringCore_IsBlocked` |
| release() → recipient → claim(); claim() → recipient → claim() | `…::test_RecipientReenteringClaim_IsBlocked` (claim preserved; exactly one payout possible) |
| deposit → token → deposit | `adversarial/Adversarial.t.sol::test_ReentrantToken_DepositBlocked` |

## Liveness and reorgs (spec §9, plan §37–§40, §78)
| Invariant | Test |
|-----------|------|
| Block-based root window (no deposit-count cliff) | `reorg/RootHistory.t.sol::test_OldRootStaysValid_DespiteManyDeposits` |
| Roots expire by blocks, not count | `reorg/RootHistory.t.sol::test_RootExpiresAfterBlockWindow` |
| Root stress: 10³ leaves (forge, depth 10, tree-full refused), 4·10⁵ leaves (TS, depth 32) | `reorg/…::test_RootStress_1000Inserts`; `src/stress.ts 100000`: 100,000 groups in 1,183.6 s (11.84 ms/group, 33 Poseidon2 hashes each), incremental root == full recompute of 400,000 leaves (99.4 s) |
| Wallet detects reorgs at depth 1/3/12/64, rolls back, re-syncs to the canonical root | `reference/typescript/test/reorg.test.ts` (`src/indexer.ts`) |

## Circuit (§28–32, §86–87) — executed against the compiled `circuits/transaction.circom`
Witness harness: `cd circuits && node test/witness.mjs`. Every attack must be unsatisfiable *at its
own constraint line*. Details and findings are in `docs/circuit-audit.md`.
| Invariant | Evidence |
|-----------|----------|
| Only the spending key opens a note (owner binding, PP-C01) | `attack-foreign-key` → membership, `transaction.circom:100` |
| Exactly one nullifier per note; distinct within a tx (PP-C03) | `attack-duplicate-input` → `:128` |
| Phantom nullifiers derived, never chosen (PP-C02) | `attack-phantom-burn` → `:119`; `attack-phantom-without-key` → `:119` (PP-P02) |
| Value conservation | `attack-inflation` → `:161` |
| Range checks hold even under field wrap-around | `attack-negative-amount` → `Num2Bits` |
| Asset conservation (`input.vault == output.vault`) | `attack-cross-asset` → `:149` |
| Mode rules (no exit under transfer; exit only via the note's vault) | `attack-withdraw-as-transfer` → `:157`, `attack-withdraw-wrong-vault` → `:158` |
| Note secret binds the commitment (PP-P01) | `attack-wrong-note-secret` → `:100` |
| Circuit primitives == wallet reference == Python == nargo Poseidon2 vectors | `circuits/test/kat.mjs` (18/18), `reference/python/test_vectors.py` (31/31) |

## Proof binding — real Groth16 proofs (dev setup)
| Invariant | Test |
|-----------|------|
| Public-signal order == `PrivacyCore.encodePublicInputs` | `circuits/test/prove.mjs` |
| Every one of the 14 public inputs is bound | `prove.mjs` + `verifier/Groth16RealProof.t.sol::test_EveryPublicInputIsBound` |
| No replay across transactions; malformed / non-canonical inputs rejected | `verifier/Groth16RealProof.t.sol` |

## End to end — nothing mocked
| Invariant | Test |
|-----------|------|
| On-chain Poseidon2 == nargo vectors; both vendored implementations agree | `hasher/Poseidon2Hasher.t.sol` (5 tests incl. fuzz) |
| On-chain depth-32 root (4-aligned groups) == the wallet's root, before and after each `transact` | `e2e/RealProofE2E.t.sol` |
| A real proof moves funds; the core still holds 0; vault stays solvent | `e2e/…::test_E2E_RealProofWithdraws` |
| Relayer recovers its fee from a private note (plan §76) | `e2e/…::test_E2E_RelayerSpendsPrivateFeeNote` |
| Replay / redirected recipient / swapped payload / premature spend rejected | `e2e/…` (4 tests) |

## Privacy (plan §65–§68) — `docs/privacy-lab.md`
Amount unique-link 0.00 % under the default wallet policy (Nova-like: 11.5 %); joint effective
anonymity set 10 → 349 (default) / 1,073 (high); guess-hit 24 % → 0.7 % / 0.2 %.

Still owed: a production ceremony (the dev setup is insecure by design) and an external audit of
the circuit and the contracts.
