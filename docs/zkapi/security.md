# zkAPI — security assessment for our use (plan V1.1 §61 step 03, §73, §75, §8–§11)

Scope: zkAPI as a **service-credit rail** that our wallet may use for metered APIs (plan Rule 11),
never as a money core. Based on the source at the deployed commit, the executed verification
([`mainnet-verification.md`](mainnet-verification.md)) and the operator's own manifest. This is an
internal assessment, not an audit; the operator states the system is unaudited and experimental.

## Verdict in one line
zkAPI delivers the separation it claims — the billing server cannot see prompts and the provider
cannot see payers — and funds cannot be forged out of the vault; but **ordinary operation, settlement
accuracy and, in one scenario, the funds themselves depend on the operator**. That is acceptable for
expiring, capped service credit and is precisely why none of it may be copied into `PrivacyCore`.

## What holds (verified or source-checked)
| Property | Basis |
|---|---|
| Deposit ↔ usage unlinkable to the server (honest users) | request nullifier `H(s, τ)`, rerandomized commitment, anchor + signature as private witnesses (`PROTOCOL.md`, SPEC public inputs) |
| Provider never learns the payer | runtime-key mode: key is capped, one-shot, issued by the OA org; server sees no prompt (`api-spec.md`) |
| No double spend of a note state | server-side nullifier set + reservation before key issuance; withdrawal nullifier in the same namespace; stale-state escape is challengeable with the prior transcript (24 h) |
| Signed balance cannot be moved between notes | note-bound commitment `E(B) = BG + rH + LJ` (`note-bound-commitments.md`); binding reduces to DL on an independently derived generator |
| Server cannot forge a withdrawal | the vault verifies the Groth16 withdrawal proof on-chain; clearance only speeds up an honest close |
| Request bound to its exact payload and quote | authorization tag over client request ID + canonical payload hash incl. the frozen `billing_quote` |
| Deployment integrity reproducible | vault + adapter byte-exact from the named commit; all pins match chain and live manifest (23/23 on both networks) |
| Retry safety | durable lease journal; exact retries reuse proof + quote; unavailable receipts are not zero usage |

## What depends on the operator (plan §8 — "server-dependent normal operation")
1. **Every state transition needs a server signature.** The chain is sequential; if the server is
   down, no new request can be authorized. Funds remain withdrawable via the escape hatch (24 h).
2. **Settlement accuracy is the server's word.** The charge `Δ` comes from the provider's measured usage
   as read by the server and converted at the frozen quote; the proof only bounds `Δ ≤ C_max` per request.
   A dishonest server can over-charge up to `C_max` (50,000 gwei ≈ $0.14 at $2,700) per request.
3. **Oracle freshness and nullifier reservation are trusted to the server** (stated in `native-eth-billing.md`).
4. **Key issuance is centralized** (OA org `org-live.openanonymity.ai`; station evidence attested by a
   hosted "verifier" service). If it is down, no inference; if dishonest, keys may be withheld.
5. **Operator pause + expiry.** `pause()` blocks `deposit`, `mutualClose` **and** `initiateEscapeWithdrawal`;
   `claimExpired` is not pausable and pays the **whole deposit** to the owner-settable `treasury`. A pause
   lasting longer than the remaining note TTL (30 days) therefore turns every active note into treasury
   revenue with no user recourse. The "withdraw even if every server disappears" guarantee holds only
   while the vault is not paused. This is the plan's "operator treasury seizure" + "service-credit expiry"
   combined, present in the deployed code.
6. **Single-party Groth16 setup** (`protocol/setup/v2`): the setup secrets are not shown to be destroyed;
   a holder could forge request proofs (steal service) and withdrawal proofs (drain the vault's ETH).
   The operator states this openly.
7. **Note TTL of 30 days** even without a pause: inactive credit is forfeited to the treasury.

## Residual privacy limits (confirmed by the operator)
IP and request-pattern correlation at the gateway (mitigation: Tor with fresh circuits per session);
prompt-content fingerprinting across sessions; timing; device. Deposits are public on Ethereum, so the
deposit address is linkable to *having* credit (not to usage). Our integration adds the transport layer
(plan §7) and uses pool-derived fresh addresses for deposits (plan §55) — see `../zkapi-integration-spec.md`.

## Compromise expectations (plan §75) — what a malicious zkAPI server can and cannot do to US
| Can | Cannot |
|---|---|
| refuse service; withhold clearance (→ 24 h escape) | touch `PrivacyCore` or any of our vaults (no coupling, Rule 1) |
| over-charge ≤ `C_max` per request; mis-settle usage | forge a withdrawal from its own vault without the setup secrets |
| with the owner: pause, then collect expired notes | change our verifier, our tree, our notes |
| correlate by IP/timing at its gateway | learn which of our users holds which credit note |
Maximum loss from a hostile zkAPI = the credit we chose to deposit there. Our design caps that per
user and per session (integration spec).

## Security test list (plan §73) — how each is covered, and what we ran ourselves
Executed on 2026-10-06 (`reproduction.md`): SDK 309/309, contracts 29/29, protocol Rust 45/45, app Rust 67 pass / 0 fail
(34 socket-bound tests cannot run on this machine — Winsock LSP, see `reproduction.md`), e2e scenario not runnable here.
| Test | Where it is exercised today | Executed here |
|---|---|---|
| wrong proof / wrong request ID / modified payload / changed quote | server recomputes payload + request binding and verifies the proof (`api-spec.md`); SDK suite 309/309 includes binding/journal tests | ✅ `zkapi-proof::request_context_is_cryptographically_bound`, `signed_state_cannot_move_to_another_note`, `signed_withdrawal_cannot_move_to_another_note`; serverd `processor::native_quote_is_bound_by_real_browser_proof_and_settles_in_gwei`, `pre_oa_failure_rejects_every_mutated_reserved_retry`, `note_binding::sequential_signed_state_cannot_branch_across_equal_or_unequal_notes`; `wasm_roundtrip` (shipped WASM proofs verify natively). Live-server replay (`test:e2e:v2`) blocked by the machine |
| replayed nullifier | server nullifier set; vault `_consumeNullifier`; challenge path | ✅ serverd `nullifier_store::test_reserve_duplicate_fails`, `test_finalize`, `oa_issuance_fence_preserves_ambiguity_across_retries`; contracts 29/29 (vault nullifier tests); `watcher::active_v2_processor_transcript_builds_challenge_calldata`. Challenged stale escape end-to-end: blocked |
| expired capability / over-cap request | lease TTL 300 s, micro-USD budget | ✅ serverd `oa_org::final_usage_must_match_the_exact_issued_lease`, `delayed_issuance_requires_explicit_replay_and_preserves_expiry_bounds`, `native_billing::one_micro_dollar_never_rounds_to_free`, `quote_identity_is_exact`, `pricing::upstream_cost_rounds_up_with_floor`. Mocked-provider lifecycle: blocked |
| server key mismatch / deployment mismatch | SDK pins + `verify:assets`; our `verify-mainnet.mjs` | ✅ `verify:assets`; `verify-mainnet.mjs` 23/23 on mainnet and Sepolia; `zkapi-proof::legacy_setup_keys_are_rejected_before_decoding`; serverd `processor::removed_proof_backends_are_rejected_on_the_wire` |
| stale root | request proves membership against a root the server validates as finalized | ✅ `zkapi-core::v2::merkle_membership_round_trip`, `merkle::test_update_and_restore`; indexerd `tree_mirror::*` (8 pass). Finalized-root gating against a live chain: blocked |
| provider usage mismatch / settlement mismatch | retire path; receipts; `reconcile_key` | ✅ serverd `oa_org::reconciliation_accepts_expired_issued_binding_but_rejects_mismatches`, `pending_usage_preserves_the_oa_retry_boundary`, `nullifier_store::openrouter_lease_never_persists_plaintext_key`; `v2-acceptance.test.mjs` provider-mock accounting 3/3. Full retire path with a live key: not possible without one |
| no unauthorized credit consumption | sum of the above | partially (unit level, above); the e2e assertion that settlement equals measured usage is blocked here |

## Ideas to borrow (plan §9) — adopted in our service layer, not in the core
note-bound state, request-ID + payload-hash binding, quote freezing, short-lived capped capabilities,
actual-usage settlement, durable recovery journal with exact retries, separate provider/payment paths,
deployment pins checked before use.

## Ideas that must not reach `PrivacyCore` (plan §10/§11) — all present in zkAPI, all absent in ours
server-signed balance evolution · server-required clearance · server-dependent normal operation ·
single-party proving setup · credit expiry · operator pause · operator-settable treasury · expiry
claims to a treasury. Our core: proof + immutable state + nullifier, no owner, notes never expire —
confirmed by `contracts/test/invariants/NoPrivilege.t.sol`.
