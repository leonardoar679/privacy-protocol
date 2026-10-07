# zkAPI v2 — protocol as implemented (plan V1.1 §61)

Condensed from `protocol/PROTOCOL.md`, `protocol/SPEC.md`, `docs/native-eth-billing.md`,
`docs/note-bound-commitments.md`, `docs/api-spec.md` and the vault source at the deployed commit.
Exact public statements: `protocol/SPEC.md`.

## Primitives
- Proof system Groth16 / BN254; hash Poseidon (BN254); signatures Schnorr on Baby-JubJub; tree depth 32.
- `s` user secret · `C = H(s, 0)` registration commitment · `D` deposit (integer gwei) · `T_exp` expiry.
- Leaf `L = Poseidon(leaf_domain, noteId, C, D, T_exp)` (the note is bound into every later statement).
- **Note-bound balance commitment** `E(B) = B·G + r·H + L·J` on Baby-JubJub, `J` an independent
  generator (`zkapi.v2.note-binding.generator.v1`, try-and-increment, cofactor cleared). The `L·J`
  term is fixed across all transitions and rerandomizations, so a signed balance cannot be moved to
  another note without breaking binding/signature or finding a Poseidon collision.
- State anchor `τ` (first `τ = 1`), server signature `σ_srv` on `(E(B), τ)`; both are **private
  witnesses**, never public inputs (prevents the server from linking requests by the carried state).
- Nullifier `x = H(s, τ)`; withdrawal nullifier `x_w` in the same namespace.

## Request statement (`zkapi-v2-note-bound-v1`, 12 public inputs)
Proves: `L` ∈ tree (root), knowledge of `s`, valid `σ_srv` on the current state for non-genesis
spends, opening of `E(B)`, `E(B)_anon` is a rerandomization of `E(B)`, `B ≥ C_max`, `x = H(s, τ)`,
an authorization tag binding `x` to the client request ID + canonical payload hash (which includes
the frozen `billing_quote`), a request time with `T_exp ≥ time`, and deployment-bound inputs.

## Withdrawal statement (14 public inputs)
Proves membership, `s`, the current signed state, the opening of `E(B_final)` (revealing `B_final`),
`x_w = H(s, τ_current)` (or `H(s, 1)` if never spent), and a tag binding `x_w` to destination,
`B_final` and clearance mode.

## Server flow (`zkapi-serverd`)
```
GET  /v2/billing/quote                     pinned finalized ETH/USD round (feed, decimals, max age)
POST /v2/openrouter/leases                 ApiRequestV2 {client_request_id, canonical payload, payload hash,
                                           public inputs, {backend: groth16_bn254, proof: base64 (256 B)}}
                                           -> verify proof, check oracle round, reserve nullifier,
                                              persist exact request, provision key, return runtime key ONCE
GET  /v2/openrouter/leases/{id}            non-secret lease status
POST /v2/openrouter/leases/{id}            retire: measured usage -> gwei charge -> B' = B - Δ,
                                           fresh τ', Schnorr-sign (E(B'), τ') -> client verifies + installs
POST /v2/openrouter/leases/{id}/expire     authoritative recovery of an expired / superseded unaccepted request
POST /v2/withdraw/clearance                mutual-close clearance σ_clear(x_w); marks x_w spent
GET  /v2/requests/{id}, /v2/nullifiers/{x} recover signed settlement
```
Lease issuance is journaled (`not_started` → `may_have_issued` → `confirmed_unissued`); exact retries
reuse the saved proof and quote; an unavailable provider receipt is never treated as zero usage.
Charge conversion: `charge_gwei = ceil(C_microusd · 10⁹ · 10^D / (P · 10⁶))`.

## Vault (`ZkApiVault`, immutable verifier + keys, `Ownable`)
| Function | Guard | Effect |
|---|---|---|
| `deposit(C, amount, siblings)` | `whenNotPaused`, `msg.value == amount·1 gwei`, `amount ≤ 2⁵³−1` | new note, leaf inserted, `T_exp = now + noteTtl` (bucketed to days) |
| `mutualClose(inputs, proof, siblings, σ_clear)` | `whenNotPaused` | verify withdrawal proof + clearance signature; pay user `B_final`, treasury `D − B_final` |
| `initiateEscapeWithdrawal(…)` | `whenNotPaused` | verify proof; remove leaf; start `challengePeriod` (24 h) |
| `challengeEscapeWithdrawal(…)` | — | operator submits a prior accepted transcript using the same nullifier → stale withdrawal rejected |
| `finalizeEscapeWithdrawal(noteId)` | after the window | settle as mutual close |
| `claimExpired(noteId, siblings)` | `now ≥ T_exp`, note active | **full deposit to treasury** |
| `setTreasury`, `pause`, `unpause` | `onlyOwner` | operator controls |

## Deployment pins the client must verify (and we did)
`chain_id`, `contract_address`, `proof_adapter_address`, `state_signing_key`, `clearance_signing_key`,
`request_charge_cap`, `circuit_id`, `request/withdrawal proving-key sha256` (+ verifying keys),
packaged WASM hashes, `native_price_feed_address` (+ decimals, max age), `billing_asset = native_eth`,
deployment manifest URL allow-list. Mainnet and Sepolia are independent deployments with their own keys.

## Differences from the launch description
- Assets: **native ETH only** on both deployments (`billing_token_address: null`); "ETH or USDC" in the
  announcement does not match the code or the manifests.
- The announcement's "proxy mode" is not an active server path; only runtime-key leasing exists in v2.
