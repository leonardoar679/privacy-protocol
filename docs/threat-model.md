# Threat Model — V1

Adversary ladder A1–A12 (from `research/12-new-protocol/threat-model.md`). V1's key win is a
**smaller trusted computing base**: by choosing Ethereum L1 + an immutable, asset-free core, two of
Tornado Nova's worst adversaries are removed from scope entirely (§114).

| # | Adversary | V1 status / defense |
|---|-----------|----------------------|
| A1 | Blockchain observer | ZK at L2 + minimal events (`NoteInserted`, `ShieldedTransaction`); amount/timing hardening in the wallet |
| A2 | RPC provider | the wallet reads every proved view from ALL configured endpoints and refuses a disagreement (`frontend/src/sdk/chain.ts::syncTreeQuorum`, plan §38); on mainnet and Sepolia it then checks that tree against the pool an Ethereum light client proves at the latest finalized block (sync-committee signature, header by hash, storage proofs of `nextLeafIndex` and `currentRoot`: `src/sdk/lightclient/`, `src/sdk/verifiedReads.ts`) — hidden or invented notes are refused, before spending and on every rescan, and each found note's spent status is proven at that block too (an endpoint calling a spent note unspent is refused); leaves newer than finality (~13 min) still rest on the quorum; reads are fetch-all, never address-specific; a private RPC transport remains the native upgrade; the scorecard shows the exposure |
| A2b | Beacon API (light-client data) | sees a client asking for public light-client updates (the same for every user) and when: a light client synced in the last 20 minutes is reused, so a sync is not tied to the next transaction (the RPC reads before a spend carry that timing hint already; a private transport, A12, removes both); can withhold them (the wallet then stops: verification on by default, Advanced can switch it off); cannot make a forged header, committee or execution block verify. Trust anchor: a configured checkpoint (`VITE_LC_CHECKPOINT`), the wallet's own saved store (≤ 12 sync-committee periods old), or on first use a finalized root every configured beacon API reports identically |
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
| the swap service (engine) the wallet talks to | with the wallet's checks (`frontend/src/sdk/swapGuard.ts`, `providerCall.ts`, `swapSign.ts`; tests `swap-guard`, `provider-call`, `swap-sign`, live `services/private-swap/test/wallet-check.test.ts`): it cannot redirect the private withdrawal (the wallet recomputes the escrow from its own `VITE_SWAP_FACTORY` and the journaled params), change the order signer, the refund note, the amount, the asset, the refund vault, a tip above 1 % or lock a refund for more than a week, or have the order key sign any call other than the one it shows. The wallet also reads that call before signing: a pinned provider contract, the wallet's fresh address as receiver, provider refunds to the escrow (Mayan: at the fresh address, as the quote says), exactly the forwarded amount, and a minimum no lower than the one the user approved (a lower one is signed only with fresh consent to that value). What it still decides: which route and when to re-quote (a worse price shows up as a lower minimum the user must accept); under the Fastest policy, a LI.FI → Mayan call whose minimum the wallet cannot read. A guest's deposit instruction is checked by the browser the same way (`src/sdk/guestGuard.ts`): THORChain's vault from the gateways, the typed destination, a memo a UTXO chain can carry, the quoted minimum | take the withdrawal, the refund, the tip or the swap's output; redirect a guest's deposit; touch the pool |
| public THORNode gateways (queried by the wallet at signing time) | see the wallet's IP ask for the current inbound addresses (the same request for every user: no order, amount or address); one gateway that lies or disagrees fails the check closed | redirect a THORChain deposit, unless a quorum of independent gateways (2 of the 3 configured, `VITE_THORNODE_URLS`) lie identically while the router stays pinned |
| a relayer executing swap orders | nothing: it can only submit executions signed by the order key, or refund to the pool; it earns the committed tip | change provider, value, calldata (limit/destination) or deadline |
| a relayer submitting private transactions (`services/relayer`) | nothing: the proof binds every public input incl. the payload hashes; it earns the fee note the wallet chose; it learns the submitter's IP and sees a transaction that is public anyway | change any field, redirect funds, take a fee without mining the transaction, or stop a user who self-submits or uses another relayer |
| the zkAPI server / operator | the service credit a user chose to deposit there (capped per note), by over-charging ≤ `request_charge_cap` per request or by pause + 30-day expiry | touch `PrivacyCore`, our vaults, our verifier or our notes; learn which pool user holds which credit |
| the order key of one swap | that one order (keys are one-time, wallet-derived) | any other order or the pool |
Rules 1–13 of the plan hold by construction: the core has no import of, call to, or configuration from any of these systems (`NoPrivilege.t.sol`, frozen ABIs).
