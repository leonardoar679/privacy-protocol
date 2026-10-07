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
| Private note → swap-order escrow → provider / refund note → spent again, all with real proofs (V1.1 step 14) | `e2e/…::test_E2E_PrivateNoteExitsToSwapOrder_RealProof`, `test_E2E_SwapOrderRefund_ReShieldsAndIsSpendableWithRealProof` |
| Replay / redirected recipient / swapped payload / premature spend rejected | `e2e/…` (4 tests) |

## Periphery — private-swap exit (spec v1.1 §11, plan §74)
| Invariant | Test |
|-----------|------|
| D1: a provider can reach only the funded escrow's balance; core balance 0; vault accounting unchanged; no re-entry | `periphery/SwapOrderEscrow.t.sol::test_MaliciousProvider_CanOnlyTakeTheEscrowBalance` |
| Only the one-time order key authorizes provider / value / calldata / deadline; no replay across escrows; deadline ≤ committed cap | `…::test_ExecutionNotSignedByOrderKey_Rejected`, `test_TamperedCalldata_Rejected`, `test_ReplayOnAnotherEscrow_Rejected`, `test_SignedDeadline_CannotExceedCommittedDeadline` |
| A failed / expired order returns to the pool as the committed fresh note and is spendable | `…::test_QuoteExpires_RefundReShieldsAsFreshNote_ThenSpendable`, `test_ProviderRevert_FundsStayAndRefundLater`, `test_ProviderRefundsToEscrow_ThenReShield` |
| A funded order can be re-routed to a fallback provider without on-chain change | `…::test_FundedOrder_CanBeReRoutedToFallbackProvider` |
| Counterfactual address == TypeScript prediction; digest == TypeScript digest; signature recovers to the signer | `services/private-swap/test/endpoints.test.ts` (forge vector) |
| Periphery has no privileged path; the core is unchanged (frozen ABI checksums) | `invariants/NoPrivilege.t.sol::test_SwapPeripheryHasNoPrivilegedPath`, `contracts/abi/SHA256SUMS` |
| With the real circuit + verifier: a note exits to the escrow and the provider is paid; the refund branch re-shields exactly the pre-committed note and that note is spent with a real proof | `e2e/RealProofE2E.t.sol::test_E2E_PrivateNoteExitsToSwapOrder_RealProof`, `test_E2E_SwapOrderRefund_ReShieldsAndIsSpendableWithRealProof` |
| Engine (plan §74): nothing the order key signs is taken on trust from a provider API — pinned targets (incl. THORChain's router), facets read by selector, decoded calldata, quorum-confirmed vaults, consistent minimums (LI.FI Across: minAmount × multiplier, PP-S01), sweep recipients (PP-S03), price guard; every §71 failure row degrades or refunds, never loses | `services/private-swap/test/adversarial.test.ts` (47, live with tampered responses) — `docs/test-matrix.md` |
| Every provider refund lands where `refund()` re-shields it: THORChain's memo names the escrow as refund address (PP-S02); an ETH order paid back in WETH (Across) is unwrapped first (PP-S04); provider refund stipends (2300 / 8,000 gas) fit the escrow's `receive()`; the relayer refunds on ETH + WETH; an order the wallet will not execute is handed over as a refund-only job, so a funded escrow never waits for somebody who knows its params | `adapters-live` / `adversarial` / `privacy-flow` memo assertions; `periphery/SwapOrderEscrow.t.sol::test_ProviderRefundsWrappedNative_UnwrappedAndReShielded`, `test_BrokenWrappedNative_StillReShieldsTheEth_ThenTheRest`, `test_ProviderRefund_FitsTheGasStipendsProvidersForward`; `services/relayer/test/executorMore.test.ts` "paid back in WETH" |
| A guest is shown no deposit instruction the browser has not checked (PP-S06): THORChain's vault from its own gateway quorum, the typed destination, the chosen asset, a memo that fits the 80-byte OP_RETURN (PP-S07), the quoted minimum | `frontend/test/guest-guard.test.ts`, `guest-flow.test.tsx`; live `services/private-swap/test/guest.test.ts` |
| The wallet acts only on a pool view an Ethereum light client proves (plan §38): the tree from the RPC quorum must contain, as its first leaves, the pool at the latest finalized block — root and leaf count by storage proof (slots pinned by `test/core/StorageLayout.t.sol`) under a header 2/3 of the sync committee signed | `frontend/test/lightclient.test.ts` (synthetic chain, real BLS), `verified-reads.test.ts`; live `test/live/lightclient.live.test.ts` (mainnet Fulu, Sepolia Gloas) |
| The wallet signs nothing the swap service shaped (PP-S05): the escrow from its own factory and journal, the digest of the call shown, and the call itself — pinned provider, its fresh address as receiver, refunds to the escrow, the approved minimum (lower only with consent) | `frontend/test/swap-guard.test.ts`, `provider-call.test.ts`, `swap-sign.test.ts`, `swap-flow.test.tsx`; live `services/private-swap/test/wallet-check.test.ts` |
| Privacy (plan §72): the permanent wallet never appears in any provider request, signed calldata or order; the escrow is the only sender, the fresh address the only receiver; endpoints are one-time | `services/private-swap/test/privacy-flow.test.ts` (live) |
| Relayer: never spends gas on a transaction that is not bound to this chain/core, whose payloads do not hash to the proven values, that does not pay it the fee note it is told, that is below the live minimum, that is already in flight, or that would revert; submits from its own key (the user's address never appears) | `services/relayer/test/relayer.test.ts` (forge-verified e2e tx on a mock chain) |

## Privacy (plan §65–§68) — `docs/privacy-lab.md`
Amount unique-link 0.00 % under the default wallet policy (Nova-like: 11.5 %); joint effective
anonymity set 10 → 349 (default) / 1,073 (high); guess-hit 24 % → 0.7 % / 0.2 %. Cross-chain leg
(`benchmarks/privacy/crosschain.json`): bucketed amounts through a native-chain provider at
100 swaps/h give a joint effective set of 5.9 (0.3 % uniquely linked), at 5/h 1.2 (66 %); arbitrary
amounts are linked almost always — the privacy score carries this term.

Still owed: a production ceremony (the dev setup is insecure by design) and an external audit of
the circuit and the contracts.
