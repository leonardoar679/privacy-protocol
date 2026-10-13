# Threat Model — V1

Adversary ladder A1–A12 (from `research/12-new-protocol/threat-model.md`). V1's key win is a
**smaller trusted computing base**: by choosing Ethereum L1 + an immutable, asset-free core, two of
Tornado Nova's worst adversaries are removed from scope entirely (§114).

| # | Adversary | V1 status / defense |
|---|-----------|----------------------|
| A1 | Blockchain observer | ZK at L2 + minimal events (`NoteInserted`, `ShieldedTransaction`); amount/timing hardening in the wallet |
| A2 | RPC provider | the wallet reads every proved view from ALL configured endpoints and refuses a disagreement (`apps/web/src/sdk/chain.ts::syncTreeQuorum`, plan §38); on mainnet and Sepolia it then checks that tree against the pool an Ethereum light client proves at the latest finalized block (sync-committee signature, header by hash, storage proofs of `nextLeafIndex` and `currentRoot`: `src/sdk/lightclient/`, `src/sdk/verifiedReads.ts`) — hidden or invented notes are refused, before spending and on every rescan, and each found note's spent status is proven at that block too (an endpoint calling a spent note unspent is refused); leaves newer than finality (~13 min) still rest on the quorum; reads are fetch-all, never address-specific; a private RPC transport remains the native upgrade; the scorecard shows the exposure |
| A2b | Beacon API (light-client data) | sees a client asking for public light-client updates (the same for every user) and when: a light client synced in the last 20 minutes is reused, so a sync is not tied to the next transaction (the RPC reads before a spend carry that timing hint already; a private transport, A12, removes both); can withhold them (the wallet then stops: verification on by default, Advanced can switch it off); cannot make a forged header, committee or execution block verify. Trust anchor: a configured checkpoint (`VITE_LC_CHECKPOINT`), the wallet's own saved store (≤ 12 sync-committee periods old), or on first use a finalized root every configured beacon API reports identically |
| A3 | Honest-but-curious relayer | shielded fee note; recipient is in the proof, not disclosed to the relayer (L3) |
| A4 | Malicious relayer | proof-bound recipient/amount/vault — a relayer can't redirect or over-charge (tests in `adversarial/`) |
| A5–A7 | MEV searcher / builder / validator | private submission (L3) denies the pre-inclusion signal |
| A8 | Malicious frontend | frontend-independent client; the seed is at rest only as scrypt + XChaCha20-Poly1305 ciphertext and the journal is encrypted under a seed-derived key (`apps/web/src/wallet/{keystore,journal}.ts`); raw secrets never persisted (TC-01 guard); recovery by the 24-word phrase needs no site (`test/keystore.test.ts` scans storage) |
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
| a swap provider / solver / aggregator API (A5–A7 analogues) | the balance of the one escrow that order funded (`SwapOrderEscrow.t.sol::test_MaliciousProvider_CanOnlyTakeTheEscrowBalance`) — and only if the wallet signs the call the engine prepared, which the engine's adapters refuse to prepare for a redirected target, a changed receiver / chain / asset / minimum, a vault not confirmed by the gateway quorum, or a re-quote below the market (`packages/swap-engine/test/adversarial.test.ts`, `docs/test-matrix.md`) | release anything from a vault, change the tree, re-enter an executed escrow, learn the permanent wallet (`test/privacy-flow.test.ts`) |
| the swap service (engine) the wallet talks to | with the wallet's checks (`apps/web/src/sdk/swapGuard.ts`, `providerCall.ts`, `swapSign.ts`; tests `swap-guard`, `provider-call`, `swap-sign`, live `packages/swap-engine/test/wallet-check.test.ts`): it cannot redirect the private withdrawal (the wallet recomputes the escrow from its own `VITE_SWAP_FACTORY` and the journaled params), change the order signer, the refund note, the amount, the asset, the refund vault, a tip above 1 % or lock a refund for more than a week, or have the order key sign any call other than the one it shows. The wallet also reads that call before signing: a pinned provider contract, the wallet's fresh address as receiver, provider refunds to the escrow (Mayan: at the fresh address, as the quote says), exactly the forwarded amount, and a minimum no lower than the one the user approved (a lower one is signed only with fresh consent to that value). What it still decides: which route and when to re-quote (a worse price shows up as a lower minimum the user must accept); under the Fastest policy, a LI.FI → Mayan call whose minimum the wallet cannot read. A guest's deposit instruction is checked by the browser the same way (`src/sdk/guestGuard.ts`): THORChain's vault from the gateways, the typed destination, a memo a UTXO chain can carry, the quoted minimum | take the withdrawal, the refund, the tip or the swap's output; redirect a guest's deposit; touch the pool |
| public THORNode gateways (queried by the wallet at signing time) | see the wallet's IP ask for the current inbound addresses (the same request for every user: no order, amount or address); one gateway that lies or disagrees fails the check closed | redirect a THORChain deposit, unless a quorum of independent gateways (2 of the 3 configured, `VITE_THORNODE_URLS`) lie identically while the router stays pinned |
| a relayer executing swap orders | nothing: it can only submit executions signed by the order key, or refund to the pool; it earns the committed tip | change provider, value, calldata (limit/destination) or deadline |
| a relayer submitting private transactions (`apps/relayer`) | nothing: the proof binds every public input incl. the payload hashes; it earns the fee note the wallet chose; it learns the submitter's IP and sees a transaction that is public anyway | change any field, redirect funds, take a fee without mining the transaction, or stop a user who self-submits or uses another relayer |
| the zkAPI server / operator | the service credit a user chose to deposit there (capped per note), by over-charging ≤ `request_charge_cap` per request or by pause + 30-day expiry | touch `PrivacyCore`, our vaults, our verifier or our notes; learn which pool user holds which credit |
| the order key of one swap | that one order (keys are one-time, wallet-derived) | any other order or the pool |
Rules 1–13 of the plan hold by construction: the core has no import of, call to, or configuration from any of these systems (`NoPrivilege.t.sol`, frozen ABIs).

## V2 — the whale execution layer (`docs/whale-execution-spec-v1.0.md`)
| If this is compromised… | …the most it can do | …and it cannot |
|---|---|---|
| a Chainlink feed, or an RPC endpoint answering the price reads | with every endpoint agreeing within 0.5 % and one round, lower or raise the USD value the wallet shows and the tier it applies; one disagreeing endpoint, a stale round or a missing answer makes the price unavailable and the tier at least high-value (fail-safe) | move money, change an order, or lower a tier below what the service computes from its own read (the higher tier applies) |
| the RPC endpoints during the pre-trade simulation | one endpoint reporting a revert blocks a hand-over (a denial, retried against a fresh quote); all endpoints lying "success" together lets a reverting execution reach the relayer, whose own `estimateGas` gate refuses it | make the wallet sign something else: the simulation runs on the exact call already checked and signed, and the signature stays home until it passes |
| the platform authenticator (second factor) | let a confirmation through that the user did not verify, or refuse one (then the wallet password is asked) | learn or hold any key: it gates the action only |
| THORChain streaming or Chainflip DCA execution | deliver part of a stream and refund the rest to the escrow (a normal outcome, shown as Partial with both amounts, re-shielded by the executor's watch) | deliver below the limit per sub-swap, or send the remainder anywhere but the refund address in the memo |
| the private AI session used for "Check this trade" | mislead the user's judgement with a wrong recommendation; see the sanitized summary (assets, rounded amounts, tier, route, competition, lint ids) | learn an address, a hash, a balance or an identity (refused before sending), or sign, withdraw or change anything (the module imports nothing that can) |
| the zkAPI gateway's caller (a runtime key holder) | obtain indicative quotes with placeholder destinations, metered per request | learn any user data (the gateway keeps none) or see a key echoed back (never) |
| an observer of the pool's public side over time | cluster a whale's maintenance pieces or withdrawal campaign (`docs/privacy-lab.md`: the per-piece sets are upper bounds) | see the private balance, its notes or the housekeeping plan: every step is a private self-transfer |

## V3 — high-value protection (`docs/high-value-protection-spec-v1.0.md`)
| If this is compromised… | …the most it can do | …and it cannot |
|---|---|---|
| a provider's bridge, MPC vault, solver or counterparty during a large order (a TSS key, a CCTP attestation, an intent not filled) | take or lose what is in flight at that moment: at most one tranche under the cap (2–2.5 % of the order), since the next tranche is released only after the previous one settled; the campaign pauses (`provider-error`, `anomaly`) and the rest stays in the private balance | reach any tranche not yet handed over (D1 per escrow; the signature of the next step stays in the wallet), or make the wallet continue after an unexplained anomaly |
| the swap service's recommendation (a wrong class, band or ELPF) | mislead the words on the Review and widen or narrow the pieces within the band the wallet accepts | lift the cap above what the risk engine permits (the wallet clamps), move the minimum per unit, the destination policy or the expiry (the bounds are the wallet's), or learn a campaign id or a step index (never sent) |
| the executor's tracker, a provider's status API, or the executor's job list | hold a tranche "in flight" longer than it is, delaying the next release (I3 fails closed; a stall pauses the campaign); report a delivery that did not happen only until the elapsed-time margin and the journaled facts disagree | settle a tranche early on its word alone (the margin counts from the delivered state), hand over or fund anything (the wallet does both from its own journal and the chain) |
| the relayer's `GET /swap` without its token | nothing: 403 | list a campaign's escrows |
| the wallet's own session between a send and its journal entry (a crash, a lost answer) | leave one step with an unknown outcome: the campaign pauses `reconcile` and the next tick reads the chain and the executor before acting | fund or hand over the same step twice (the escrow's balance and the job by `orderId` are the facts, pinned) |
| the platform authenticator at institutional | refuse (then the password), or confirm a user who did not verify — then the separate device must still confirm | replace the separate cross-platform device, which has no password fallback |
| a swapped destination (a pasted address replaced under the user's eyes) | be entered into the address book | be paid by a ≥ high-value operation before it is verified (its groups re-typed from the source, a signed challenge, a test transaction) and its 24 h cooling-off passed, unless the Immediate override was given with the phrase, the hold and the second factor or device |
| an observer of the pool's public side and of the destination chain | see N fundings of one-time escrows on a random cadence and, with an entered destination, N payments to one address (the lint says so: `tranche-link`, `exact-cadence`; the privacy lab quantifies the burst share) | see the whole order at once, the private balance, or which fundings belong together without the cadence pattern |
| any of the 13 faults of the campaign lab at a $10M campaign's middle tranche (provider outage, quote mismatch, price spike, chain congestion, RPC failure, destination error, wrong chain, wrong token, reorg, bridge timeout, solver failure, app crash, network disconnect) | expose at most the tranche in flight ($128,398 at a $200,000 cap in `benchmarks/whale/campaign.md`; $12,840 at $1M); pause for 0–6.4 h | reach the rest of the order (every invariant held in every fault run) |

## V4 — the high-value execution engine (`docs/high-value-execution-contract-v1.0.md`)
| If this is compromised… | …the most it can do | …and it cannot |
|---|---|---|
| the same faults at random steps, sizes, modes and sizings (the §118 chaos test, `tests/high-value/adversarial/chaos.test.ts`) | expose at most the cap; pause; a refunded step is re-planned once | break an invariant, send a step twice, or leave the campaign stuck (completed or cancelled in every run; the same seed gives the same run) |
| a chain reorganization that removes a funding the quorum had seen | pause the campaign `reconcile` naming the possibility; delay the step until the chain is read again | make the wallet fund the step again (`fundedTx` stays) or hand over a step whose escrow is empty (the simulation refuses) |
| the service's exposure tier or the §4 row (a wrong class, a missing record) | lower the cap (an unknown route is 1 %) or keep the band's default | raise the cap above the band's range, or above the service's own recommendation unless the route is R0 / R1 (the wallet recomputes from the policy core) |
| a provider among several that quote the size | carry at most 30 % of the order in flight (I6 at the hand-over) | become the whole order's counterparty while others quote; a single venue is disclosed, never diversified for appearance |
| the user's own velocity limit, concentration or fraction (Settings → Advanced) | lower the protection (warned: "Changing this can reduce protection") within the band's range | exceed the band's range, the tier's maximum or the mode's ceiling |
| an entered destination approved long ago | be refused until re-checked (stale after 90 days idle) | be paid at ≥ high-value on the old approval |
| the settlement read (the service, the executor or the network down) | leave a step "Unknown / reconnecting" with its exposure counted (I3) | mark a step failed or settled, or release the next one |

## V5 — the web wallet (`docs/privacy-wallet-web-spec-v1.0.md`)
| If this is compromised… | …the most it can do | …and it cannot |
|---|---|---|
| the browser's storage (IndexedDB `privacy-wallet`), read by another script of the origin or lifted from a profile backup | read two ciphertext blobs (the scrypt + XChaCha20-Poly1305 keystore, the seed-keyed journal) and the prefs (the experience, the theme, the locale, the backup dates) | learn the seed, a note, an address or an amount; `localStorage` holds nothing (the one-time migration moved the blobs, read them back byte for byte, then removed the old keys) |
| the host serving the build (files swapped, a script added) | serve another wallet — the user's trust in the origin, as for any web wallet | run an inline or a third-party script under the build's policy (`script-src 'self' 'wasm-unsafe-eval'`, no `unsafe-inline`), reach a host the build did not name (`connect-src`), frame the wallet (`frame-ancestors 'none'` as a header); a host that strips the meta tag must send the headers (`docs/deployment.md`); the pin file shares the origin's trust (`audit-package.md` gap 28) |
| the artifact host (`VITE_ARTIFACT_BASE`) | serve another proving key or witness generator | have the worker prove with it in a production build: the fetched bytes are hashed against `public/artifacts.json` and a mismatch — or a missing pin — refuses (`src/prover/pins.ts`) |
| the injected wallet (a malicious extension) | see the public deposits it signs (the amount, the vault, the deposit note's public secret and payload), the gas estimate it is asked for, its own account's balance; refuse or alter a deposit before signing it | see the protected balance, a journaled note, a withdrawal's recipient or amount (the relayer path never touches it), the seed or the keys (handed to no provider) |
| WalletConnect's relay (only with `VITE_WC_PROJECT_ID`) | see the dApp's origin, the connected wallet's metadata, the encrypted session envelopes and their timing | see a private operation, a note, a destination or the journal; it carries a public deposit's calldata only when that wallet pays a deposit |
| the relayer | see a withdrawal's proof, its public inputs (the recipient, the amount), the three payloads and its own fee note's secret; refuse or delay a submission (the wallet tries the next relayer, then the connected wallet) | learn which deposit was spent — the submission carries neither the deposit's secret, its commitment nor its payload (the leakage gate reads every body) —, the seed, the keys or the change note's secret |
| the catalog or a translator | change the words | reach a secret or a request; a dead or stray key fails the catalog test; the forbidden words fail the lint |
| a console reader (an extension, a support screenshot) | see the engine's status lines | see a recipient, a privacy address, the seed or the phrase (the leakage gate reads every console line) |

The gate that executes these rows: `apps/web/test/privacy-leakage.test.tsx` (create → protect → send through the real engine against a mock
core and a relayer stub, every request body, provider call, transport record and console line read for the secrets) and the swap scenario
of `apps/web/test/swap-flow.test.tsx`; the browser twin in `scripts/local-stack/e2e.mjs`.
