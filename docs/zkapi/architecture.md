# zkAPI — architecture as deployed (plan V1.1 §61, step 01)

Source studied: `ethereum/zkapi` at `045b444` (2026-10-01; clone at `../zkapi`), and the deployed
commit `95b022fd` named by the live mainnet manifest (worktree `../zkapi-deployed`). Verified pins:
[`mainnet-verification.md`](mainnet-verification.md).

## What it is
A **prepaid, private usage-credit rail for metered APIs**: deposit native ETH once into a vault,
then authorize each API request off-chain with a Groth16 proof that a funded note covers the
request's maximum charge and has not been spent before. The provider receives a short-lived,
dollar-capped key; the zkAPI server never sees the prompt, the provider never sees the payer, and
settlement is netted at close-out. It is **service credit**, not money: notes expire, the ledger is
integer gwei, charges are converted from micro-USD at a frozen oracle quote.

## Components (and their trust role)
```
browser / zkapi-clientd ──proof-backed lease request──▶ zkapi-serverd ──▶ OA org (ephemeral key issuer)
        │                                                     │
        │──prompt + runtime key──▶ inference provider (OpenRouter)          ▼
        │                                               durable DB: leases, nullifiers,
        │──deposit / close / escape──▶ ZkApiVault (Ethereum)   signed states, journal
        │◀──Merkle root + paths──── zkapi-indexerd                 │
                                                                    ▼
                                   zkapi-challenged ──restricted signer──▶ vault.challengeEscapeWithdrawal
```
| Component | Language / location | Role | Trust |
|---|---|---|---|
| `ZkApiVault` | Solidity, `protocol/contracts` | notes, Merkle tree (depth 32, Poseidon), nullifiers, deposit / mutual close / escape withdrawal + challenge / expiry claim | immutable verifier + signing keys; **`Ownable`: pause, treasury** |
| `Groth16ProofAdapter` | Solidity | verifies request + withdrawal proofs on BN254 precompiles; VK hard-coded | immutable |
| `Bn254Poseidon` | Solidity external library | hashing for the tree | immutable |
| `zkapi-serverd` | Rust (`crates/`) | `/v2/billing/quote`, `/v2/openrouter/leases` (verify proof, reserve nullifier, issue key), retire/settle, `/v2/withdraw/clearance`, recovery | **trusted** for oracle freshness, nullifier reservation, state signing; cannot forge on-chain withdrawals |
| `zkapi-indexerd` | Rust | mirrors vault events; serves root, snapshot, note paths | availability only (paths are checked by the proof) |
| `zkapi-challenged` | Rust | watches escape withdrawals; submits prior transcripts to block stale-state withdrawals | protects the operator's revenue |
| OA org / station | hosted (`org-live.openanonymity.ai`) | issues the ephemeral OpenRouter keys; "verifier" service (`verifier-production-…`) attests station/org evidence | **trusted** for key issuance; off-chain |
| browser SDK (`sdk/`) | JS + packaged Rust→WASM wallet/prover | note secrets, blindings, signed states, recovery journal, proof generation, deposits/withdrawals | the user's device |
| `zkapi-clientd` | Go | local OpenAI/Ollama-compatible endpoint funded by a private ETH balance | the user's device |

## Lifecycle
1. **Deposit** — client samples secret `s`, commits `C = H(s, 0)`, calls `deposit(C, amount_gwei, siblings)`
   with exactly `amount × 1 gwei` of ETH; the vault inserts leaf `L = H(leaf_domain, noteId, C, D, T_exp)`.
   Initial private state: balance `B = D`, anchor `τ = 1`. **Deposits are public** (amount, address).
2. **Quote** — `GET /v2/billing/quote` returns a finalized Chainlink ETH/USD round the authorization
   will be frozen to (max age 4,500 s; RPC must support the `finalized` tag).
3. **Lease** — the client proves (Groth16, `zkapi-v2-note-bound-v1`): membership of `L`, knowledge of
   `s`, the current signed state `(E(B), τ, σ_srv)` as private witnesses, rerandomized commitment
   `E(B)_anon`, solvency `B ≥ C_max` (50,000 gwei on mainnet), nullifier `x = H(s, τ)`, and an
   authorization tag binding `x` to the exact client request ID, canonical payload hash and the quote.
   `POST /v2/openrouter/leases`: the server verifies, **reserves `x`**, persists the exact request, and
   returns a one-time runtime key with a micro-USD budget and TTL (300 s on mainnet).
4. **Use** — the client calls the provider directly with that key (runtime-key mode). The server
   never sees the prompt.
5. **Settle** — on retire (`POST …/leases/{id}`), the server reads measured usage, converts micro-USD
   → gwei with the frozen quote (`ceil(C·10⁹·10^D / (P·10⁶))`), computes `B' = B − Δ`, samples a
   fresh anchor `τ'`, signs `(E(B'), τ')` with the **state signing key** and returns it. The client
   verifies and installs the new state. One state → one next request (sequential).
6. **Close** — withdrawal is a final spend revealing `B_final` and a destination:
   *mutual close*: server signs clearance on `x_w` (**clearance key**) → instant settlement;
   *escape hatch*: no server → `initiateEscapeWithdrawal`, 24 h challenge window, then
   `finalizeEscapeWithdrawal`. Payout: user `B_final`, treasury `D − B_final`.
7. **Expiry** — after `T_exp` (30 days) with no close in progress, anyone may `claimExpired` and the
   **entire deposit goes to the treasury**.

## Privacy boundary (plan §6, confirmed in code and manifest)
| Party | Sees | Does not see |
|---|---|---|
| zkAPI server | nullifiers, rerandomized balance commitments, request IDs, payload hashes, quotes, USD usage | which deposit, who deposited, the prompt |
| provider (OpenRouter) | prompt, response, runtime key, network metadata | the payer, the note |
| OA org | key issuance evidence | prompt, payer |
| Ethereum | deposit (address, amount, time), close/escape/expiry (destination, `B_final`) | off-chain usage |
| not addressed | IP, prompt fingerprinting, timing, device | — |

## Modes
Only **runtime-key** (direct provider path) is active in v2; a proxy path does not exist in the
deployed server (`provider: native_leases`, `upstreams: ["openrouter"]`). Our integration spec keeps
proxy disabled (plan §5).

## Operator powers present in the deployment (reported by `mainnet-verification.md`)
`owner()` can `pause()` (blocks `deposit`, `mutualClose`, `initiateEscapeWithdrawal`; does **not**
block `finalizeEscapeWithdrawal` or `claimExpired`) and `setTreasury()`. Notes expire after 30 days.
See [`security.md`](security.md) for what follows from that.
