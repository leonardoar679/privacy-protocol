# Threat Model — V1

Adversary ladder A1–A12 (from `research/12-new-protocol/threat-model.md`). V1's key win is a
**smaller trusted computing base**: by choosing Ethereum L1 + an immutable, asset-free core, two of
Tornado Nova's worst adversaries are removed from scope entirely (§114).

| # | Adversary | V1 status / defense |
|---|-----------|----------------------|
| A1 | Blockchain observer | ZK at L2 + minimal events (`NoteInserted`, `ShieldedTransaction`); amount/timing hardening in the wallet |
| A2 | RPC provider | the wallet reads every proved view from ALL configured endpoints and refuses a disagreement (`frontend/src/sdk/chain.ts::syncTreeQuorum`, plan §38); reads are fetch-all, never address-specific; light client / private RPC remain the native upgrade; the scorecard shows the exposure |
| A3 | Honest-but-curious relayer | shielded fee note; recipient is in the proof, not disclosed to the relayer (L3) |
| A4 | Malicious relayer | proof-bound recipient/amount/vault — a relayer can't redirect or over-charge (tests in `adversarial/`) |
| A5–A7 | MEV searcher / builder / validator | private submission (L3) denies the pre-inclusion signal |
| A8 | Malicious frontend | frontend-independent client; the seed is at rest only as scrypt + XChaCha20-Poly1305 ciphertext and the journal is encrypted under a seed-derived key (`frontend/src/wallet/{keystore,journal}.ts`); raw secrets never persisted (TC-01 guard); recovery by the 24-word phrase needs no site (`test/keystore.test.ts` scans storage) |
| A9 | Compromised device | OS/hardware keystore for keys (wallet responsibility) |
| **A10** | **Governance** | **REMOVED from the core TCB** — the core is immutable; no owner/upgrade/pause (fixes TC-02) |
| **A11** | **Bridge** | **REMOVED from V1** — Ethereum L1 only; no AMB/omnibridge (fixes TC-03/12/18) |
| A12 | Network observer | mixnet/Tor transport for RPC + submission (wallet) |

## What V1 still trusts
Ethereum consensus, the ZK assumptions + the (one-time, public) trusted setup if Groth16 is chosen
(TC-09), one audited Poseidon2 instance (spec §2, pinned by the nargo vectors in four independent
implementations), and — per asset — that token's issuer. Issuer risk is **isolated**
to that asset's vault (see `vault-spec.md`); it is disclosed, not eliminated (§39, §67).

## Explicitly NOT trusted
Protocol admin, governance, bridge validators, any official relayer, any official frontend, a single
RPC, or a single company. The same immutable contracts are usable from any client (direct fix for
TC-01's "mutable frontend = full break").

## V1.1 — three layers, independent failure (plan §60, §74–§75, §85)
```
PRIVATE MONEY (PrivacyCore + vaults, immutable)   PRIVATE SERVICES (zkAPI)        PRIVATE SWAPS (engine + providers)
        │ withdrawal to a one-time escrow                 │ expiring credit                 │ replaceable adapters
        ▼                                                ▼                                ▼
 holds the users' money                     OA server / OpenRouter            THORChain · Chainflip · Mayan · NEAR · LI.FI · Across
```
| If this is compromised… | …the most it can take | …and it cannot |
|---|---|---|
| a swap provider / solver / aggregator API (A5–A7 analogues) | the balance of the one escrow that order funded (`SwapOrderEscrow.t.sol::test_MaliciousProvider_CanOnlyTakeTheEscrowBalance`) — and only if the wallet signs the call the engine prepared, which the engine's adapters refuse to prepare for a redirected target, a changed receiver / chain / asset / minimum, a vault not confirmed by the gateway quorum, or a re-quote below the market (`services/private-swap/test/adversarial.test.ts`, `docs/test-matrix.md`) | release anything from a vault, change the tree, re-enter an executed escrow, learn the permanent wallet (`test/privacy-flow.test.ts`) |
| the swap service (engine) the wallet talks to | with the wallet's checks (`frontend/src/sdk/swapGuard.ts`, `test/swap-guard.test.ts`): it cannot redirect the private withdrawal (the wallet recomputes the escrow from its own `VITE_SWAP_FACTORY` and the params), change the order signer, the refund note, the amount, the asset, the refund vault, a tip above 1 % or lock a refund for more than a week, or have the order key sign any call other than the one it shows. What it still decides: the provider call itself — receiver and minimum output are checked by its adapters (`services/private-swap/test/adversarial.test.ts`), not yet again in the wallet — so the swap's output is at the mercy of a dishonest service; a refund to the pool stays possible for any unexecuted order | take the withdrawal, the refund or the tip outright; touch the pool |
| a relayer executing swap orders | nothing: it can only submit executions signed by the order key, or refund to the pool; it earns the committed tip | change provider, value, calldata (limit/destination) or deadline |
| a relayer submitting private transactions (`services/relayer`) | nothing: the proof binds every public input incl. the payload hashes; it earns the fee note the wallet chose; it learns the submitter's IP and sees a transaction that is public anyway | change any field, redirect funds, take a fee without mining the transaction, or stop a user who self-submits or uses another relayer |
| the zkAPI server / operator | the service credit a user chose to deposit there (capped per note), by over-charging ≤ `request_charge_cap` per request or by pause + 30-day expiry | touch `PrivacyCore`, our vaults, our verifier or our notes; learn which pool user holds which credit |
| the order key of one swap | that one order (keys are one-time, wallet-derived) | any other order or the pool |
Rules 1–13 of the plan hold by construction: the core has no import of, call to, or configuration from any of these systems (`NoPrivilege.t.sol`, frozen ABIs).
