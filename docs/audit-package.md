# Audit package — plan step 20 (independent audits)

Status (2026-10-14, after the V6 pass): **package assembled; no engagement started.** This document is what an external
auditor receives first: scope, how to pin and rebuild the code, where the invariants and tests are,
what is known to be unfinished, and the questions we want answered. The engagement itself (choice of
firm, scheduling, fix rounds, report publication) is outside this repository.

## 1. Scope
| Component | Path | Lines of interest | Audit question |
|---|---|---|---|
| **PrivacyCore + vaults (immutable money layer)** | `contracts/src/core`, `contracts/src/vault`, `contracts/src/factory`, `contracts/src/verifier`, `contracts/src/hasher` | `PrivacyCore.transact/deposit`, `NativeAssetVault`, `ERC20AssetVault`, `AssetVaultFactory`, `Groth16Verifier` adapter | Can anyone move value without a valid proof of a note they own? Can a vault release more than it holds? Can any path change the tree, the nullifier set or the verifier after deployment? |
| **Circuit** | `circuits/transaction.circom` (+ `circuits/lib`) | 2-in/3-out transaction, Poseidon2, Merkle (depth 32), nullifier derivation, public-input binding | Soundness: can a witness exist for a transaction that is not a legitimate spend (fake Merkle path, wrong owner, value imbalance, nullifier malleability)? Does every public input bind what the contract assumes? |
| **Poseidon2** | `circuits/lib/poseidon2*.circom`, `contracts/src/hasher/Poseidon2Hasher.sol`, `packages/protocol/src/poseidon2.ts`, `reference/python` | round constants, MDS, domain separation | Do the four implementations agree (vectors) and match the chosen parameter set? |
| **Swap periphery (replaceable)** | `contracts/src/periphery/swap/*` | `SwapOrderEscrow.execute/refund`, `SwapOrderFactory` (CREATE2) | Can anyone but the order key choose provider / value / calldata / deadline? Can an escrow leak more than its own balance? Can a refund re-shield something other than the committed note? |
| **PrivateSwap engine** | `packages/swap-engine/src` | adapters' local verification (`lifi.ts`, `chainflip.ts`, `thorchain.ts`, `mayan.ts`, `across.ts`), `engine.ts`, `endpoints.ts`, `scoring.ts` | Does the engine sign only calldata it verified? Does the escrow prediction / digest exactly match the contracts? |
| **Relayer (replaceable)** | `apps/relayer/src` | `relayer.ts::validateShape/submit` | Can a request make the relayer spend gas without paying it, or alter what is submitted? (It should not be able to: every field is proof-bound.) |
| **Wallet reference** | `packages/protocol/src` (keys, notes, amounts, payload envelope) | key derivation, note commitment, bucket policy | Is anything derived from the master seed reusable across contexts? Is the payload envelope binding? |

Out of scope: zkAPI (third party; our assessment is `docs/zkapi/security.md`), the six providers'
own contracts, the UI shell (`apps/web`), gas optimisation.

### 1.1 Added in the plan-gap pass (V1.1 wallet + core)
| Component | What to audit |
|---|---|
| `packages/sdk/src/wallet/{keystore,journal,session,storage}.ts`, `docs/wallet-formats.md` | the at-rest formats: scrypt parameters and their floor, XChaCha20-Poly1305 use (nonce handling, AAD), the seed-derived journal key, what a backup file reveals (nothing in the clear), TC-01 (no raw secret in dapp-origin storage), the recovery phrase = seed entropy |
| `packages/protocol/src/wallet/chainKeys.ts`, `privacy-core/privacy-core/src/wallet/chainkeys.rs` | BIP-32 / BIP-44 / BIP-84 / SLIP-0010 correctness beyond the pinned vectors; per-dApp index derivation (§37); address encoders (bech32 v0, base58, EIP-55) |
| `packages/sdk/src/chain.ts` (RPC quorum) | can a single endpoint still mislead the wallet (reads compared: root, size, event digest); what one endpoint learns (fetch-all reads only) |
| `privacy-core/privacy-core` + `privacy-core-wasm` | equivalence with the circuit / contracts / TypeScript beyond the vectors (differential fuzzing is the suggested method); constant-time properties of the scalar / field code paths that touch secrets; the WASM surface takes caller randomness only |
| `packages/swap-engine` `/guest/*`, `apps/web/src/components/Guest.tsx`, `packages/sdk/src/guestGuard.ts` | the walletless path: the deposit address is confirmed by the THORNode gateway quorum (the vault they suggest, or since 2026-10-14 another active vault every gateway that answers lists), and the browser re-checks it and the memo (destination, asset, OP_RETURN size, minimum) before showing them; nothing identifying leaves the client except the destination |
| `packages/sdk/src/providerCall.ts`, `swapGuard.ts`, `swapSign.ts` | the wallet's own reading of the provider call before the one-time key signs: the pinned contracts, each decoder against the deployed provider contracts (THORChain router, Chainflip Vault, Across SpokePool, Mayan forwarder + Fast-MCTP, LI.FI AcrossFacetV4 / MayanFacet), the minimum and the consent flow |
| **V2** `packages/protocol/src/wallet/{valuation,privacyLint,destinations,noteStrategy,privacyCenter}.ts`, `packages/sdk/src/{prices,simulate,tiers,secondFactor,orderTracker,poolDeposits}.ts`, `packages/sdk/src/wallet/{housekeeping,lintFacts}.ts`, `apps/web/src/zkapi/tradeCheck.ts` | the whale execution layer (`docs/whale-execution-spec-v1.0.md`): the Chainlink reads through the RPC quorum and the fail-safe (can a lying endpoint or feed lower a tier?), the pre-trade simulation's revert decoding and the second call from the escrow, the WebAuthn gate (it verifies the user, not a signature — is that enough for its role?), the lint's categories against the privacy factors, the destination parsers (bech32 / bech32m / base58check / EIP-55 / base58), the tracker's state derivation, the housekeeping planner (fee accounting, note-count bounds, the observer's clustering caveat in `docs/privacy-lab.md`), the trade-check sanitizer (address shapes) |
| **V2** `packages/swap-engine/src/{scoring,health,engine,valuation,placeholders,gateway}.ts`, `adapters/{thorchain,chainflip,mayan}.ts` | the five policies and the tier override, the impact / limit / stream filters, the competition record and the per-adapter budget, the breaker, the price guard at `/prepare`, the placeholders at phase 1, the streaming memo (`LIMIT` per sub-swap), Chainflip `dcaParams` equality, Mayan swap & lock (the USDC vault requirement), the gateway's key handling |
| **V3** `packages/protocol/src/wallet/{campaign,riskClasses,addressBook}.ts`, `packages/sdk/src/wallet/{campaigns,campaignRunner,addressBook,alerts,notifications}.ts`, `packages/sdk/src/{swapExecute,allowances}.ts`, `apps/web/src/components/protection/*` | the high-value protection layer (`docs/high-value-protection-spec-v1.0.md`): the tranche splitter and the exposure invariants I1–I5, the settlement gate with the elapsed-time margin (no explorer), the reducer's one action per tick, the runner's reconcile before every money movement (never a second funding or hand-over), the bounds one confirmation binds, the address book's verification methods and the Immediate override, the separate cross-platform device with no password fallback, what the trade check sends |
| **V3** `packages/swap-engine/src/risk/{riskDb,security,protection}.ts`, `packages/swap-engine/risk/`, `packages/swap-engine/src/health.ts`, `apps/relayer/src/admin.ts` | the risk database's validation, the security breakdown's adjustments and the incident decay, the breaker's new triggers and the half-open probe, the recommendation's band / cap / gate / ELPF / concentration (advice the wallet re-derives), the execution window clamp, the job list's token |
| `packages/sdk/src/lightclient/`, `packages/sdk/src/verifiedReads.ts` | the Ethereum light client: SSZ roots and generalized indices per data format (Electra/Fulu, Gloas), update validation and committee rotation against consensus-specs, the BLS ciphersuite, the trust-on-first-use bootstrap and the snapshot age limit, the execution header field list, the Merkle-Patricia walk (inclusion and exclusion), and the pool check (prefix root, nullifier slots) |
| **V5** `apps/web/src/storage`, `packages/privacy-engine/src/transport/http.ts` (V5's `api/transport.ts`, moved in V6 Stage 4), `apps/web/src/features/{operations,fees,privacy-center/status.ts}`, `apps/web/src/prover/pins.ts`, `apps/web/scripts/{csp,artifact-pins-lib}.mjs`, `apps/web/src/app/i18n`, `packages/protocol/src/wallet/fees.ts`, `packages/protocol/src/classic/note.ts`, `apps/relayer/src/relayer.ts` (the percentage fee) | the secure store over IndexedDB (the same ciphertext; the migration's equal read-back rule; the prefs schema that holds no secret); the transport policy (credentials omitted, redirects refused, the host allow-list, every request through one module); the fee rule and where the relayer can enforce it (gap 25); the operation state machine's invariants I-O1–I-O5 and the error catalog's funds classes; the pin check in the prover worker; the content security policy's construction from the environment; what the leakage gate reads and what it cannot see; the Privacy Center's facts (computed, never asserted); the classic note format and the module boundary |

### 1.2 Added in V6 (`docs/privacy-wallet-web-spec-v2.0.md`)
| Component | What to audit |
|---|---|
| **`contracts/src/periphery/protect/ProtectRouter.sol`** (new, replaceable) | the 1 % fee on a protect: `fee + net == gross` for every gross; the vault only from the factory's `vaultOf`; strict transfers with balance checks (fee-on-transfer and false-return tokens refused); nothing held between calls; no owner, setter or upgrade; re-entry through a token's hooks |
| **`contracts/src/periphery/shield/`** (new, replaceable): `ShieldReceiver`, `ShieldReceiverFactory` | a one-time receiver at the CREATE2 address of its committed parameters; THORChain's 2300-gas send before and after deployment; the tip once and only on a delivery ≥ `minAmount`; the committed note only (the note data's hash); WETH unwrapped; an unsupported token only to the committed fallback; can a griefer, the provider or the relayer change where a delivery goes or claim the tip with dust? |
| `apps/api/src` + `packages/server-kit/src` | the API over the swap engine: what it stores (`db.ts`: a migration of STRICT tables, the destination and refund material only until finalize), the retention purge, the typed logger's redaction (no address, hash or amount can be logged), the edge (CORS allowlist, headers, body limits, the rate limiter that a forged X-Forwarded-For cannot multiply), the reconcile as a second source |
| `apps/relayer/src/{relayer,shieldExecutor,edge}.ts` | the 1 % rule on every withdrawal incl. a swap's escrow funding (`feeMeetsTerms`), the shield executor's tip against the estimated gas and its bounded re-shields, the job lookup by nullifier (hash and status only) |
| `packages/sdk/src/wallet/orderRunner.ts`, `packages/sdk/src/deploymentGuard.ts`, `packages/sdk/src/session/autoLock.ts`, `packages/sdk/src/wallet/session.ts` | one confirmation (reconcile before every money movement; sign only while the approved minimum holds); the deployment fingerprint and its refusal; the auto-lock verdict, the holds and their 30-minute cap, what a lock forgets |
| `apps/web/src/platform/crypto/` | the long-lived crypto worker: only the spend plan and the view key cross into it, no reply carries a key or a circuit input, the proving key cached in the Cache API under its pin and hashed on every read, the worker ended at every lock |
| `packages/privacy-engine/src/transport/connectivity.ts`, `packages/sdk/src/privateTx.ts` | offline detection, the wait before a relayer attempt, the lost answer found by its nullifier before anything is sent again |

### 1.3 Added in V7 (`docs/privacy-wallet-web-spec-v3.0.md`)
| Component | What to audit |
|---|---|
| **`classic/`** (GPL-3.0, the separate application) | `classic/vendor/` (websnark `4c0af6a8`, snarkjs 0.1.20, circomlib `3b492f98` — converted without `eval`; the hashes in `VENDORED.md`), `classic/src/crypto/` (the original Pedersen and MiMC, the note), `classic/src/prover/` (the worker, the local verification with the transcoded key), `classic/src/history/` (the snapshot, the delta sync with checkpoints and rollback, the root held to `getLastRoot` / `isKnownRoot`, spent status from the chain before a withdrawal), `classic/src/relayer/` (the schemas as real relayers speak, the registry rules, the fee at the live gas price), `classic/src/app/services/` (the flows, the availability rows, the `CLASSIC_LIVE` / `CLASSIC_COMPLIANCE_ORACLE` / `CLASSIC_GEOFENCE` switches), the policy and the gates (`classic/scripts/`), `classic/docs/{threat-model,security-review,release-gate,legal-review}.md` |
| `packages/sdk/src/wallet/campaigns.ts` (`stepReviewedFee`), `packages/sdk/src/wallet/campaignRunner.ts` (the fund case) | a piece's fee bound is the funding's own exact-output formula under the Review's terms; a moved fee pauses the campaign and sends nothing; the Review's `F × n` against the pieces' bounds |
| `packages/sdk/src/wallet/inFlight.ts`, `packages/protocol/src/wallet/exposurePolicy.ts`, `apps/api/src/quote.ts` | one protected operation of the band in flight per wallet (the wallet's own count); the route's liquidity qualification from the risk database; the cap table's override (`EXPOSURE_POLICY_FILE`) never above the band's range |
| `packages/swap-engine/src/provider.ts`, `packages/sdk/src/swapProvider.ts` | the facade commits and prepares exactly what the direct flow does; `validate` signs nothing; the recovery options are pure |
| `packages/sdk/src/operations/{reducer,upgrade,adapters}.ts`, `apps/api/src/db.ts` (migration 3), `apps/api/src/reconcile.ts` | the fifteen states and I-O7 from SUBMITTING; the V6 → V7 upgrade on read (idempotent, the history merged) and the API's migration (the rows renamed in place, an expired quote closed before its funding) |
| `packages/sdk/src/session/autoLock.ts` (`pageHidden`), `apps/web/src/platform/{autoLock,unloadGuard}.ts`, `apps/web/src/storage/persist.ts`, `packages/sdk/src/privateTx.ts` (`assertStillUnlocked`), `packages/wallet-engine/src/{walletConnect,connection}.ts`, `apps/web/scripts/csp.mjs` | the mobile-web gate: a pagehide deferred by a live hold and resumed by pageshow; a Protect that stops prompting once locked; the unload guard; persistent storage; WalletConnect's metadata, the restored session, the policy's hosts (never a telemetry host) |
| the review round of 2026-11-02 (`apps/web/src/features/swap/{SwapScreen,Swap}.tsx`, `apps/api/src/{quote.ts,routes/swap.ts,db.ts (migration 4),reconcile.ts}`, `packages/sdk/src/operations/{reducer,upgrade,stale}.ts`, `packages/sdk/src/wallet/orderRunner.ts`, `packages/wallet-engine/src/{walletConnect,connection}.ts`, `apps/web/scripts/csp.mjs`, `classic/src/app/services/{history,flows}.ts`) | the band's steps carry the Review's terms; the V5 screen is the Advanced experience's and judges the band's limit and the route qualification itself; the API values the qualification at what the user pays and refuses a gross below the funding; the wallet's own prompt is a field of AWAITING_AUTHORIZATION; a spend sent without a known transaction waits as RECOVERY_REQUIRED (`outcome_unknown`); an order expired before its funding waits until its refund time; a tick that threw releases the hand-over hold; the policy names WalletConnect's hosts exactly; WalletConnect is initialized at a reload only with a stored session; a lock between two steps reads `locked_mid_flow`; Classic takes a delta only when the pool's count at its block agrees and prices the relayer's minimum at the live gas price |
| the second review round (2026-11-03): `packages/sdk/src/{swapFunding,privateTx}.ts`, `packages/sdk/src/wallet/{orderRunner,campaignRunner}.ts`, `apps/relayer/src/{swapExecutor,server,shieldExecutor,relayer}.ts`, `apps/api/src/{reconcile,store}.ts`, `apps/api/src/routes/swap.ts`, `packages/swap-engine/src/engine.ts`, `apps/web/src/features/{swap,send,protect,review,activity,more}`, `packages/sdk/src/wallet/posture.ts`, `classic/src/app/services/{flows,source,relayers,history}.ts`, `classic/src/model/format.ts` | one funding of an order at a time and the spend's turn re-reads the journal; a funding on its way is never abandoned; the merges a swap needs are named and bound; the relayer's cap answers a known job and admits a funded escrow; a job keeps only its fields; a lapsed job reads REFUNDING; the shapes checked at the commit and the executor; the preference words and the posture say what the runner does; Remove removes the record; no Protect Review without a wallet; Classic checks the recipient's checksum, the note's pool, the facts and the chain before sending, keeps one withdrawal at a time, asks the relayers only when the tab opens |
| the third review round (2026-11-03, the contracts): `contracts/src/periphery/shield/ShieldReceiver.sol` (`shieldToken`'s ETH branch at a token receipt, `sweepUnsupported`'s wrapped-native guard), `contracts/src/periphery/swap/SwapOrderEscrow.sol` (`_payTip`), the re-exported `contracts/abi/periphery/*.json`, `packages/contracts/src/gas.ts` | a WETH or ETH delivery at a receiver is never sweepable to the public fallback (at an ETH receipt WETH unwraps through `shield()`, at a token receipt both shield as ETH through `shieldToken`); ETH at a token receipt is recoverable; an escrow holding the tip or less refunds whole, untipped — nothing stuck until a donation; the creation code of both factories changed with it, before any public deployment: the pins, the three vectors and the real-proof fixture are of the new build (`contracts/test/periphery/{ShieldReceiver,SwapOrderEscrow}.t.sol`, the three round-3 tests) |
| the third review round (2026-11-03, the engines and the guard): `packages/sdk/src/{providerCall,swapSign,prices,swapExecute,swapProvider}.ts`, `packages/sdk/src/wallet/{lintFacts,notes,session,campaigns}.ts`, `packages/sdk/src/{privateTx,chain}.ts`, `packages/swap-engine/src/adapters/{mayan,lifi}.ts`, `packages/swap-engine/src/config.ts`, `apps/web/src/features/swap/SwapScreen.tsx`, `apps/web/src/features/review/View.tsx` | a Mayan order's ETH → USDC leg is bounded at this wallet's own agreed ETH price less 2 % (`MAYAN_MIDDLE_MAX_SHORTFALL_BPS`) and refused without a fresh price — before, any positive floor passed, and a swap service could route the whole order through its own pool; the order inside LI.FI's Mayan facet is read (trader = escrow, receiver, asset, minimum); the approved minimum is never defaulted to zero; LI.FI bridges exactly the escrow's amount; a THORChain stream fits a day as a whole; the scan reads every note's spent bit from every endpoint (agreed) and proves the marks both ways, lifting one the finalized chain does not confirm; a result after a lock or a REPLACE writes nothing into the new wallet; every note new to the store in the unproven tail waits; the proof's public inputs are recomputed on the main thread from the plan and a prover's other answer is refused (`packages/protocol/src/prover.ts` `assertPublicInputsOfSpec`, defence in depth); the band's steps Review states the campaign's price bound and marks the tips as estimates (`apps/web/test/provider-call.test.ts`, `apps/web/test/unproven-notes.test.ts`, `packages/sdk/test/{note-store,not-this-spend,campaign-minimum}.test.ts`, `apps/web/test/swap-protected-steps.test.tsx`) |
| the fourth review round (2026-11-03, the light client, the platform, the service side and the Classic app): `packages/sdk/src/lightclient/index.ts`, `packages/sdk/src/verifiedReads.ts`, `packages/sdk/src/wallet/session.ts`, `packages/sdk/src/privateTx.ts`, `packages/protocol/src/txInputs.ts`, `packages/wallet-engine/src/walletConnect.ts`, `apps/web/src/platform/{activeTab,index}.ts`, `apps/web/src/features/onboarding/Lock.tsx`, `apps/web/src/components/PrivateAI.tsx`, `apps/web/src/features/more/entries.ts`, `apps/web/src/config.ts`, `apps/api/src/store.ts`, `apps/api/src/routes/swap.ts`, `apps/relayer/src/{sender,relayer,swapExecutor,shieldExecutor,journal,server}.ts`, `classic/src/model/recipient.ts`, `classic/src/app/services/{source,flows,history}.ts`, `classic/src/config.ts`, `classic/src/prover/engine.ts`, `classic/src/storage/historyDb.ts`, the Classic views, `scripts/dependency-review.mjs`, `scripts/verify-all.mjs` | the light client's first-use anchor needs at least two beacon APIs on distinct hosts agreeing on one finalized root at the same slot, each as finalized and no older than 12 sync-committee periods (`agreedFinalizedRoot`; one API, or two behind one host, is refused), a saved store is read only when it has a store's shape, and a reused client more than 12 epochs behind the current finalized slot syncs again before any read rests on it (`MAX_FINALITY_LAG_EPOCHS`); the spent proofs say which block each batch was proven at, and a mark is lifted only by a proof at or past the block it was seen at; a REPLACE while another tab of this browser holds the wallet is refused before anything is written (`ReplaceRefused`; the platform's Web Lock query answers); the password fields take no autocorrect, the AI prompt refuses an address-like string and never carries a note, ending a WalletConnect connection clears its own store; the API writes an order's blob back only while the operation still has one and finalizes in one transaction; the relayer journals a submission as `sending` before the broadcast (a hook between the signature and the send) and a job's words carry no endpoint URL, every journal entry is validated at the load, a request of the wrong shape costs no chain read, the gas price is cached for five seconds, the admin token has a floor and the bodies a cap; Classic refuses a withdrawal to the zero address, a burn address or the pools' own contracts before any proof, keeps a deposit's record in the page's memory only (the device's IndexedDB holds the withdrawal records, clearable from History), reads a deposit's late receipt again, drops a device copy the chain refused and rebuilds one the chain does not know, refuses a re-proof's unknown root instead of submitting it, moves a followed job to the relayer's state, names a production build's operator relayer list as development-only, and the witness calculator's failure is one fixed phrase; the dependency review sweeps every installed package once (`--all`) | `apps/web/test/{lightclient,verified-reads,unproven-notes,active-tab}.test.ts`, `packages/sdk/test/session-replace-guard.test.ts`, `apps/relayer/test/{sender,journal,relayer,swapExecutor}.test.ts`, `apps/api/test/store-blob.test.ts`, `classic/test/{model,flows,services,screens,prover,app-live,config}.test.*` |
| the fifth review round (2026-11-03, the core contracts and the circuit, the wallet at rest, the Classic prover and history, the money path): `contracts/src/core/{PrivacyCore,CoreTypes}.sol`, `contracts/src/vault/{ERC20AssetVault,NativeAssetVault}.sol`, `contracts/script/Deploy.s.sol`, `contracts/scripts/export-abi.mjs`, `packages/contracts/src/deployments.ts`, `packages/protocol-types/src/deployment.ts`, `packages/protocol/src/txInputs.ts`, `packages/sdk/src/{deploymentGuard,secondFactor,swapFunding}.ts`, `packages/sdk/src/wallet/{keystore,session,notes}.ts`, `packages/sdk/src/keys/chainKeys.ts`, `apps/web/src/platform/forget.ts`, `apps/web/src/storage/guard.ts`, `apps/web/src/features/more/Security.tsx`, `classic/src/prover/{worker,engine,protocol}.ts`, `classic/src/app/services/{history,flows,source}.ts`, `classic/src/history/sync.ts`, `classic/scripts/vendor.mjs`, `apps/relayer/src/swapExecutor.ts`, `apps/api/src/{store,reads}.ts`, `apps/api/src/routes/swap.ts` | the core refuses a withdrawal to address(0), the vault or itself (`InvalidRecipient`), the ERC-20 payout reads a 32-byte answer as a word (non-zero = paid; a word that is neither 0 nor 1 had reverted the whole transact after a valid proof — since the eleventh round, G11-3: paid when the vault's own balance fell, the answer unread, a claim only when nothing left), the ETH payout hands its recipient 100,000 gas at most (a receive() burning all of it had reverted the relayer's transact at a tight limit — since the eleventh round, G11-5/G11-2: the token call 300,000 at most, and the claim forwards its caller's gas); the deploy script pins the ceremony verifier by `INNER_VERIFIER_CODEHASH` and refuses the development one off a devnet, and the wallet's deployment check reads the inner verifier (its code hash in the fingerprint; the development key a problem in a production build) and the tree's depth; the plan check refuses a zero withdrawal and a non-address; a restored backup's keystore is wrapped again at the build's scrypt cost (so is a weaker one at the unlock), the counters are held at every unlock until the scan after it and a stale journal applies the reserve, Forget clears everything of the wallet's under the origin, the chain-key cache is zeroed at the lock, the keystore's shape is exact; the Classic tree's path must fold to its root or the tree is rebuilt from the deposits, a window the chain keeps moving under is redone three times then refused, a wallet-mode send asks a second endpoint, the prover is closed after a terminal record and its sub-workers zero their scratch, the witness failure phrase covers the calculator's own refusals only, the precompiled templates are pinned; the executor's last call sends an execution below the tip in the window's last half hour rather than into a costlier refund, every listed refund token needs a floor, the API's restore and resume write the blob only while nothing is finalized, and the relayer's answers are read in the shapes the API acts on | `contracts/test/adversarial/Adversarial.t.sol`, `contracts/test/vault/ERC20Accounting.t.sol`, `packages/contracts/test/deployment-inner.test.ts`, `packages/protocol/test/txInputs.test.ts`, `packages/sdk/test/{keystore-rewrap,counter-floor,chain-keys-lock}.test.ts`, `apps/web/test/{forget,storage,keystore}.test.ts`, `classic/test/{services,history,flows,vendored,prover}.test.ts`, `apps/relayer/test/{swapExecutor,executorMore}.test.ts`, `apps/api/test/{store-blob,reads}.test.ts` |
| the sixth review round (2026-11-03, the release gates, linkability, the settlement tracking, the operation machine): `scripts/{verify-all,audit,dependency-review,check-lockfile}.mjs`, `scripts/audit-allowlist.json`, `apps/web/scripts/{zkapi-sdk-pins-lib,pin-zkapi-sdk,check-zkapi-sdk,boundary,check-artifact-pins,artifact-pins-lib}.mjs`, `apps/web/zkapi-sdk.pins.json`, `apps/web/vite.config.ts`, `classic/scripts/{boundary,csp,relayers}.mjs`, `classic/vite.config.ts`, `tests/visual/run.mjs`, `.npmrc`, `.nvmrc`, `classic/.npmrc`, `packages/sdk/src/chain.ts`, `packages/sdk/src/wallet/{spends,privacyTiming,campaignRunner,orderRunner,session}.ts`, `packages/sdk/src/privateTx.ts`, `packages/sdk/src/operations/{stale,reducer}.ts`, `packages/sdk/src/operations/errors/codes.ts`, `packages/sdk/src/keys/chainKeys.ts`, `packages/sdk/src/{orderTracker,swapFunding,assets}.ts`, `packages/protocol/src/wallet/{settlement,privacyLint}.ts`, `packages/swap-engine/src/adapters/{mayan,across,thorchain}.ts`, `apps/api/src/{reconcile,reads}.ts`, `apps/relayer/src/relayer.ts`, `apps/web/src/features/{swap/SwapScreen,swap/Swap,send/SendScreen,wallet/Receive}.tsx`, `apps/web/src/app/Background.tsx`, `apps/web/src/hooks/index.ts` | the zkAPI SDK clone is pinned by commit and file hash and the build refuses another; every module Vite resolves is held to the application's trees (the Classic app's never); the tool directories' lockfiles and dependency reviews are gated, an audit acceptance names its advisory and path, CI must get an answer from the registry, a pin file that changed since the base fails where the artifacts are not; the Classic production policy carries no development relayer and no host without a public suffix; the visual harness fails on a baseline without a fixture; install scripts are off and Node 24 pinned. The scan reads the pool's spend events fetch-all with the note events (one filter per window, every endpoint agreeing on both) and takes the spent bits from them — no per-nullifier `isNullifierSpent` read names this wallet's notes to an endpoint; the stale mover's spent bits and the transaction that spent a record's pair come from the same index (a Send whose relayer answer was lost completes from it — only when that transaction's call carries the public inputs the record kept at its submission: two Sends of one note share the nullifier pair, and another operation's spend fails the record as `spent_elsewhere`); a Protect's receipt is read through the connected wallet's own provider. A lock after a send is `locked_after_send` (funds unknown), and the reducer turns any not-moved failure of a sent record into RECOVERY_REQUIRED unless the chain's own verdict; a campaign gives up a dead funding with the flag and tries a passing signing failure at the next tick five times before the backoff; the journal is read again before a hand-over; a runner's tick writes only into the journal it began with (`WalletSession.pinned`). A refund paid at the destination (Mayan Fast-MCTP) is final (`REFUNDED_AT_DESTINATION`), a provider failure with nothing back by the end of the watch ends the order with its reason (`PROVIDER_FAILED`, `provider_failed`), an unread escrow after the watch settles nothing, the API's reconcile mirrors the three; Across lists the LP fee once; THORChain's prepare refuses a halted destination; a sent funding reads dead after an hour. A delayed order's window is the delay plus the one-confirm window (the escrow's deadline encodes the planned funding, not the commit); the amount fact is judged on what leaves and a whole-note exit is named; the relayer's refusal names no amount; the timing fact is floored by the wallet's own last Protect (older notes cannot hide it); Receive never shows an address something used; the campaign's requote and the Advanced swap's indicative quote carry no destination |
| the seventh review round (2026-11-03, the relayer, the cryptography, the campaign engine, the figures): `apps/relayer/src/swapExecutor.ts` (`checkOrder`'s types, each job's tick in its own try/catch, urgent jobs first, a foreign refund, `paramsKey`), `apps/api/src/routes/swap.ts` (the types, the tip hint), `packages/protocol/src/{envelope,address,poseidon2}.ts` and `privacy-core/privacy-core/src/{encoding/envelope,encoding/address,wallet/keystore}.rs` (the dummy's key, the canonical view key, the field, the keystore's sizes), `packages/sdk/src/chain.ts` (the read boundary), `packages/protocol/src/wallet/campaign.ts` (`undelivered`, `ended`, `kept`, `holdUntil`, the re-plan's question, `maxExecutorTip`, the refund of a failed step), `packages/sdk/src/wallet/{campaigns,campaignRunner}.ts` (`protectionOf`, `routeRules`, `withRoute`, the destination read at every commit, the velocity window), `packages/sdk/src/orderTracker.ts`, `packages/sdk/src/swapExecute.ts` (`shownTip`), `apps/web/src/features/{review,swap,send,protect}/*`, `classic/src/app/App.tsx` | a poisoned order never stops the executor; a dummy output is an envelope to an observer; nothing outside the field is hashed or read from the chain; a campaign never commits before its hold or to a destination the book refuses, never runs looser than the wallet's model of its route, never reports undelivered value as completed nor swaps a returned step again without asking; the velocity limit is the wallet's and fails closed; every Review states what leaves and every fee |
| the tenth review round (2026-11-04, round 9's orders and records, round 9's chain truth and service, the Classic app, the wallet at rest): `packages/protocol/src/keys.ts` (`assertLiveSeed`), `packages/sdk/src/{chain,privateTx,swapExecute,swapFunding,rpcUrls}.ts` (the windowed read's span, count and pace, one event listed twice, the opening's epoch at every flow, `orderIsOurs`), `packages/sdk/src/wallet/{notes,session,journal,orderRunner,campaignRunner,discovery,operationRecord}.ts` (`StoreClosed`, the public all-zero seed refused, `restoredJournal`, `mergeJournals`, `isEncryptedJournal`, `SHIELD_RECHECK_MS`, `HANDOVER_SETTLE_MS`, the outcomes), `packages/sdk/src/operations/{stale,store,swapRecords,upgrade,errors/codes}.ts`, `packages/sdk/src/lightclient/index.ts`, `apps/api/src/{quote,store,reconcile,routes/swap}.ts`, `packages/swap-engine/src/risk/{protection,security}.ts`, `packages/wallet-engine/src/walletConnect.ts`, `apps/web/src/platform/forget.ts`, `apps/web/src/zkapi/tradeCheck.ts`, `apps/web/vite.config.ts`, the Swap, Activity and Home screens, and the Classic app (`classic/src/app/services/{flows,source}.ts`, `classic/src/history/verify.ts`, `classic/src/storage/historyDb.ts`, `classic/scripts/live-gate.mjs`) | no key, note or order key is made from the zeroed seed a lock leaves, no flow is carried into another opening of the wallet, and no order whose refund note is not this seed's is funded; an honest capped endpoint's sync always finishes; a Send that never settles holds nothing back; a swap's outcome says only what the record knows; a restore never hands out the earlier installation's addresses again (two restores of one source, since the eleventh round, rarely: a random draw) and a backup never drops a newer journal; a Forget waits for its deletes and takes WalletConnect's store (since the eleventh round, while a page holds WalletConnect, kept for a later page start where none does); the route qualifies for the path the swap takes; Classic's confirmation restates what the proof pays and a note is never called invalid for a history that failed |
| the eleventh review round (2026-11-04..06, the provider adapters against the guard, the wallet at rest and the platform, the records and the service, the Classic app, the screens, the contracts and the cores, the documents' truth): `packages/swap-engine/src/adapters/{thorchain,lifi,mayan,acrossSwap,chainflip}.ts`, `packages/sdk/src/{providerCall,swapSign,swapExecute,guestGuard}.ts`, `packages/protocol/src/wallet/destinations.ts`, `packages/sdk/src/wallet/addressBook.ts` (bd730e0), `packages/sdk/src/wallet/{journal,session,settings,notes,keystore,storage,housekeeping}.ts`, `packages/sdk/src/session/autoLock.ts`, `apps/web/src/platform/{activeTab,autoLock,forget,pendingWipe}.ts`, `packages/wallet-engine/src/walletConnect.ts`, `scripts/check-boundaries.mjs`, `apps/web/scripts/boundary.mjs`, `apps/web/src/storage/{idb,prefs,secureStore}.ts`, `packages/protocol/src/keys.ts`, `packages/sdk/src/secondFactor.ts`, `classic/vite.config.ts` (57ca635), `packages/sdk/src/{orderTracker,swapFunding,chain,rpcUrls,relayer}.ts`, `packages/sdk/src/wallet/{orderRunner,campaignRunner}.ts`, `apps/api/src/reconcile.ts`, `packages/privacy-engine/src/transport/http.ts`, `packages/sdk/src/lightclient/beacon.ts`, `packages/sdk/src/operations/swapRecords.ts`, `packages/swap-engine/src/risk/protection.ts`, `packages/swap-engine/src/adapters/across.ts` (02dc971), the Classic app (`classic/src/app/services/{flows,history,source,wallet}.ts`, `classic/src/net/{capped,relayer,rpc}.ts`, `classic/src/prover/client.ts`, `classic/scripts/live-gate.mjs`, `classic/vite.config.ts`, `classic/src/storage/historyDb.ts`, `classic/src/app/services/operations.ts`; ad39f76), the Activity, Home, Swap, Protect, Send, Review, progress and Privacy Center screens, `packages/protocol/src/wallet/privacyLint.ts`, `packages/protocol/src/wallet/campaign.ts` (9f8138a), `contracts/src/vault/{Base,ERC20,Native}AssetVault.sol`, `contracts/script/{Deploy,DeployShieldReceiver,DeploySwapPeriphery}.s.sol`, `packages/contracts/src/deployments.ts`, `packages/sdk/src/deploymentGuard.ts`, the Rust core's keys and address decoder with its WASM build and FFI, `packages/protocol/src/address.ts` (ff6c654), `packages/sdk/src/{chain,privateTx}.ts`, `packages/sdk/src/operations/{stale,store,notify,reducer}.ts`, `packages/sdk/src/wallet/discovery.ts`, `packages/wallet-engine/src/{injected,walletConnect}.ts`, `classic/src/app/App.tsx` (5a19862), `packages/wallet-engine/src/{connection,walletConnect}.ts`, `apps/web/src/features/wallet/{ConnectSheet,PairingPanel,PairingSheet,RootPairing,pairingHost,connectWords}.ts*`, `apps/web/scripts/csp.mjs` (35c2130) | the route reviewed is the route signed and paid, at every adapter's own limits; one rule for where a restore resumes, a backup merged with its settings and funding facts, nothing deleted under a WalletConnect connection; an order closed only on a settled reading, a hand-over attempt kept once the executor was asked; a Classic tree trusted only once this device hashed it, a relayed withdrawal completed only by its own note's withdrawal, the second endpoint not asked at a relayed withdrawal's moment (the retry's sync and the one after a hold excepted, gap 120); a step not delivered never reads complete, no raw service text outside Advanced; a claim pays whatever gas its recipient needs, an ERC-20 payout counts only when the vault's balance moved, the core held to this build's protocol, circuit, hasher and key, both factories to the chain's WETH; a Protect's transactions never asked about at the privacy endpoints (WalletConnect's approvals excepted, gap 100); Classic asks no relayer while nothing is live; WalletConnect's first connection pairs in the wallet's own sheet, one connection at a time — audit gaps 118–122 |
| the ninth review round (2026-11-04, the operations engine, the private transactions and Private AI after round 8, how the wallet knows what is on chain, the swap service after round 8): `packages/sdk/src/wallet/{journal,orderRunner,campaignRunner,campaigns,operationRecord,spends,discovery,lintFacts,posture}.ts` (`fundedOf`, `fundingSeenOf`, the hand-over attempt, `handover_unknown`, the outcome, `spentInAnyIndex`), `packages/sdk/src/{orderTracker,swapFunding,swapProvider,privateTx,chain,rpcUrls,prices,simulate}.ts` (`fundingUnderWay`, `OrderClosed`, the agreed call reads, the full receipt key, the bounded marks and window walk, the notes past the pool, the fee re-read after merges), `packages/sdk/src/operations/{stale,store,swapRecords,adapters,notify,errors/codes}.ts`, `packages/sdk/src/lightclient/{index,beacon}.ts`, `apps/api/src/{app,routes/swap,db,store,reconcile,reads,quote}.ts`, `packages/swap-engine/src/{health,risk/riskDb,risk/protection,risk/security}.ts`, `packages/risk-engine/src/index.ts`, `apps/web/src/zkapi/{creditWallet,tradeCheck}.ts`, `apps/web/src/components/PrivateAI.tsx`, `apps/web/src/platform/forget.ts`, the Swap, Send and Activity screens | a handed-over order is never read as never funded, nor abandoned while this tab funds it, nor read "nothing was swapped" after a lost hand-over; a record never goes back before its submission and a sped-up transaction settles; a finished swap names a partial fill or a refund at the destination; the relayer's job is adopted only for the record's own call; no note recorded past the pool stays, no spent mark outlives the chain's block, every endpoint's receipt agrees in full; the light client is never stopped by one API's genuine data; a restore at the cap is answered, the checkpoint never stalls the API, an incident is never dropped, an order no ceiling can stage is planned at the cap; the credit wallet's provider is revoked by a lock and Forget leaves no SDK key |
| the eighth review round (2026-11-03, the swap service, the competition and the risk engine, the private transactions, Private AI and the connection): `apps/api/src/{routes/swap,db,store,reconcile,reads,app}.ts` (the tip's band, secure_delete and the WAL, the capacity and each caller's commits, the slim blob, the state paths, the re-sign overtaken, the edge's types and assets), `packages/swap-engine/src/{engine,scoring,health,risk/riskDb,risk/protection,risk/security,adapters/lifi,adapters/nearIntents,adapters/thorchain}.ts` (`boundedTip`, `isOutage`, `boundedQuote`, the two-pass scoring, the incidents, `routePairOf`, the planner's bound), `packages/protocol/src/wallet/campaign.ts` (`MAX_TRANCHES`, `stallAfterSeconds`), `packages/sdk/src/{privateTx,swapFunding,swapGuard}.ts`, `packages/sdk/src/wallet/{housekeeping,session,journal,campaigns}.ts`, `apps/web/src/zkapi/{policy,aiSession,tradeCheck,sdk}.ts`, `apps/web/src/components/PrivateAI.tsx`, `apps/web/src/platform/forget.ts`, `apps/web/scripts/csp.mjs` | the service vouches only for a tip it valued and keeps no order's secret in its file past finalize; a never-executable quote steers no choice and no caller opens a breaker for everyone; no plan loops past its bound; no housekeeping step pays above the fee its cap was checked against and no spend runs merges its Review did not name; a spend's mark survives a lagging scan; a funding's fate is its own call's; a Forget leaves no credit wallet; a Protect's prompts go from the account reviewed |

## 2. Pinning and reproducing
- Repository: this directory (`privacy-protocol`); the auditor pins the commit hash of the handed-over
  tree. Core ABIs are frozen and checksummed: `sha256sum -c contracts/abi/SHA256SUMS`.
- Build settings are pinned in `contracts/foundry.toml` (solc 0.8.24, optimizer 200 runs, paris,
  no metadata hash): `cd contracts && FOUNDRY_OFFLINE=true forge build --use <solc-0.8.24>` must
  reproduce `contracts/abi/*.json` byte for byte.
- Circuit: `circuits/README.md` (circom 2.2.2, `--O2`), constraint count 23,343 / 14 public inputs;
  the dev setup (`circuits/scripts/dev-setup.sh`) is **insecure by design** (single-party, power 15)
  and only exists to exercise real proofs in tests — the production ceremony is still owed.
- Specifications the code claims to implement: `docs/protocol-spec-v1.0.md` (core), `docs/vault-spec.md`,
  `docs/private-swap-spec-v1.1.md` (periphery + engine), `docs/zkapi-integration-spec.md`.

## 3. Invariants and the tests that execute them
`docs/security-invariants.md` is the index (core invariants, issuer isolation, reentrancy, liveness /
reorgs, circuit soundness, proof binding, end-to-end, periphery, privacy). Test inventory:
| Suite | Count | Runs |
|---|---|---|
| contracts (forge) | **146** (2026-10-14): V6 adds ProtectRouter 20 and ShieldReceiver 15 (predict = deploy, the 2300-gas send, dust, WETH, foreign and unsupported tokens, re-entry, the fuzzed accounting, the vector shared with TypeScript), the periphery gas bench and the e2e deployment fixture's pin. Before V6, 107: 47 mock-based incl. 5 fuzz invariants, token zoo, no-privilege bytecode scan, the pool's storage slots; Poseidon2 KAT 5; real verifier 8; **real-proof e2e 10** (incl. note → escrow → provider, escrow → refund note → spent); swap periphery 32 (incl. USDT-like orders, `refundToken`, WETH and ETH paid back to a USDC order re-shielded as ETH); **native-prover proofs 5** (proofs from `privacy-core/privacy-prover` on the same verifier) | `FOUNDRY_OFFLINE=true forge test --use $SOLC` |
| circuits | KAT 18, soundness 17 (negative witnesses), Groth16 harness 14 | `circuits/README.md` |
| reference | TypeScript 173 (vitest, incl. 9 WASM-vs-TypeScript; V6: the fee formulas of spec v2.0 §3, the settlement states), Python 31 (vectors); five implementations agree on every primitive | `npm test` in `packages/protocol`, `python reference/python/test_vectors.py` |
| Rust core + native prover + FFI | 30 cargo tests across 15 binaries (2026-10-14); 11 Python tests over the generated UniFFI bindings (`privacy-core/privacy-ffi`), 14 vector suites (`privacy-core/privacy-core`), 12 prover tests (`privacy-core/privacy-prover`: a witness proving another statement refused, the native witness == snarkjs' and the soundness manifest's verdicts, the zkey parses to the published key, native ⇄ snarkjs proofs verified both ways), wasm32 build | `cargo test` in `privacy-core` (after `node privacy-core/scripts/gen-prover-fixtures.mjs`), `node privacy-core/scripts/ffi-bindings.mjs` |
| wallet | **V6** (2026-10-14): `apps/web` 523 vitest + 9 in the leakage gate + 6 live (5 ran, 1 skipped by the network); the engines in `packages/sdk` 97, `packages/ui` 49, `packages/contracts` 19, `packages/risk-engine` 7, `packages/privacy-engine` 6, `packages/config` 5, `packages/protocol-types` 4, `packages/wallet-engine` 3; the screenshot harness (189 screenshots against reviewed baselines, 363 layout checks, 124 acceptance and accessibility checks); the performance budget. Before V6, 154 vitest + 6 live (the light client: sync committees, BLS, Gloas/Fulu formats, header by hash, storage proofs, the pool check before every transaction; a refused or cancelled order returned by a refund-only job; the walletless deposit instruction checked in the browser; the Swap screen clicked through against the real engine; the swap-service guard: escrow recomputation == forge vector, order and signature checks; the provider call read before signing — pinned contracts, receiver, refunds, approved minimum — against the service adapters' own encoders and the THORNode quorum; keystore / journal, chain keys, RPC quorum, first launch without a request, the Rust core path vs the TypeScript path, ERC-20 + relayer failover, planning, merges) + build | `cd apps/web && npm test && npm run build` |
| private-swap engine | **V6** (2026-10-14): 103 offline + 107 live (the gas-based tip, same-chain quotes, selection). Before V6, 149 vitest: 43 offline (state machine, scoring, privacy score incl. the cross-chain link composition, endpoint == forge vector, signature recovery, restore, the escrow call per ingress and asset, what an escrow can re-shield), 106 live: 26 adapter quotes (incl. the Uniswap-Across leg to USDC and to native ETH, Mayan SWIFT orders), **68 adversarial** (plan §71/§74: outage, refusal, tampered calldata/quotes per provider, status mapping, a source swap into a token the escrow cannot re-shield, the Across Swap API bent eight ways, the Mayan SWIFT quote bent eleven ways), 4 flow (§72, incl. USDC-sourced orders), 2 guest deposit, 6 wallet-check (the wallet's own decoder on every call the engine prepares, incl. the swap leg) — `docs/test-matrix.md` | `npm test` (network) |
| privacy | lab (`benchmarks/privacy/results.json`), cross-chain lab (`benchmarks/privacy/crosschain.json`) | `docs/privacy-lab.md` |
| relayer | **V6** (2026-10-14): 59 (the 1 % rule on every withdrawal, the actual gas, the shield executor, the edge, the logs, a job by its nullifier). Before V6, 38 vitest: private submission vs the forge e2e transaction, ERC-20 fee vaults, swap executor vs the periphery vector (incl. refund-only jobs, WETH and foreign-token refunds, ETH at an ERC-20 order's escrow, the late-refund watch and its budget and floors), journals, limits | `cd apps/relayer && npm test` |
| API | 26 (V6: the schema, the routes, reconcile, retention, security, the logs, a full flow) and the server kit 9 | `cd apps/api && npm test` |
| high-value tests tree | 62 | `node node_modules/vitest/vitest.mjs run --root tests/high-value` |
| **everything** | `node scripts/verify-all.mjs --forge <solc-0.8.24> --rust --live --browser` — **52/52 steps** on 2026-10-14: every typecheck and suite above, the lint, the package boundaries, the lockfile and the dependency review, the leakage gate, the build with its bundle scan and performance budget, the artifact pins, the documentation paths, the dependency audit, forge, the Rust core, the native prover, the UniFFI bindings, the WASM package, the live provider and light-client suites, and the screenshot harness | |

## 4. Known gaps and open decisions (please do not re-discover these)
1. **No production ceremony.** The deployed verifier must come from a multi-party setup; the dev
   verifier is gated to chain ids 31337 / 11155111 in `contracts/script/Deploy.s.sol`.
2. **Proof system not final** (plan §41–42): Groth16 today; Halo2/FRI comparison outstanding.
3. **Payload cipher binding is a proposal** (`crypto-spec.md`, "Output payload envelope"): view key → X25519 via tagged sha256, envelope key from the shared secret and both public keys; please review the KDF and the absence of sender authentication (by design: the recipient verifies the opening against the leaf).
4. **Gas above targets** (`transact` 1.79M vs 650k target); levers in `benchmarks/gas/README.md`.
5. **Proving**: the web wallet proves with snarkjs in a Web Worker; the native wallets with
   `privacy-core/privacy-prover` (native witness + Groth16, proofs verified by the on-chain verifier in
   forge). Both use the INSECURE dev key until the ceremony (item 1).
6. **Provider adapters are mainnet-pinned**; NEAR Intents' ingress is withheld (contract-sent
   deposits unconfirmed); Mayan's source-chain swap leg trusts Mayan's router calldata within the
   §74 damage bound — its floor bounded at the wallet's own agreed ETH price less 2 % since the third review round (2026-11-03;
   before, any positive floor passed, so the bound was the whole order); THORChain's gateway quorum (2 of 3) runs over three independent public gateways (Liquify, cosmos.directory, THORWallet; Nine Realms' host stopped resolving in 2026-10 and was replaced). The wallet re-checks every provider call itself before signing (`packages/sdk/src/providerCall.ts`) with pinned contracts — a provider upgrade (e.g. a new THORChain router, `VITE_THORCHAIN_ROUTER`) makes the wallet refuse until its pins are updated. Found and fixed on 2026-10-07: THORChain memos had no refund address (a refund would have paid the relayer), LI.FI's AcrossFacetV4 output was read from a word the facet overwrites from `outputAmountMultiplier`, and LI.FI's MayanFacet sweep recipient was unchecked. On the same day the escrow learned to unwrap WETH: Across refunds an unfilled ETH deposit to the escrow as WETH, which `refund()` could not re-shield (the factory now carries `WRAPPED_NATIVE`, the escrow creation code changed, the e2e real-proof fixture was regenerated). Found and fixed on 2026-10-16: the Across swap leg took the deposit's `outputAmount` as the minimum while the swap before it was bounded only by a non-zero `minExpectedInputTokenAmount` (an exchange the call names could keep the order and leave a deposit nobody fills, refunded at the floor), and LI.FI's AcrossFacetV4 swap variant let an inflated `outputAmountMultiplier` over one unit of `minAmount` read as any minimum. Both decoders now count the swap's floor in the asset delivered (WETH for ETH, one dollar stablecoin for another) and require it to cover the minimum. On the same day: Mayan Fast-MCTP orders carried the API's gas drop, fees and deadline unbounded (the verified FastMCTP pays `refundFee` to whoever calls refund, which for a USDC output is how the order delivers); they are now bounded as SWIFT orders are, in both decoders.
7. **Cross-chain privacy** (`docs/privacy-lab.md`, cross-chain section): every adapter publishes the
   escrow → destination link; it reaches only the privately funded escrow, so a swap is as private as
   its pool withdrawal. The score multiplies the pool-side and cross-chain links (corrected 2026-10-07
   from taking the worse of the two); please check that composition.
8. **zkAPI** is used as service credit only; its own issues (pause + 30-day expiry, single-party
   setup, server-dependent operation) are in `docs/zkapi/security.md`.
9. **V2 — UniswapX is deferred** (`docs/whale-execution-spec-v1.0.md` §11): it needs the escrow to
   answer EIP-1271 for a Permit2 order, a bytecode change; EVM→EVM keeps Across and LI.FI.
10. **V2 — the zkAPI quote gateway is blocked upstream** (spec §22): the interface and the status
    exist; no live zkAPI deployment leases keys for this service.
11. **V2 — the second factor is a platform-authenticator gate**, not a cryptographic check of the
    assertion signature (the wallet checks the credential id answered with user verification
    required); the wallet password is the fallback. Please judge whether that is enough for its role.
12. **V2 — the whale labs are upper bounds** (`docs/privacy-lab.md`): a per-piece observer, no
    clustering of a whale's pieces, one amount shared by the whales; the housekeeping planner's
    pieces inherit those limits.
13. **V3 — UniswapX RFQ (R2) and OTC (R6) are interfaces only** (`docs/high-value-protection-spec-v1.0.md`
    §19): UniswapX needs the escrow to answer EIP-1271 (a bytecode change); an OTC leg has no adapter.
14. **V3 — multi-device 2-of-3 approval is out of scope**: the institutional control is a second factor on a
    separate device (a cross-platform WebAuthn credential asked after the platform factor, no password
    fallback), not threshold signing across devices; the wallet still holds every key.
15. **V3 — no push notifications and no background execution**: a campaign runs while the web wallet is
    unlocked on any tab and resumes at unlock; in-app alerts always, the browser's Notification API only when
    enabled and the tab is hidden (generic text by default). A swap's funding delayed for privacy also runs only while the wallet
    is unlocked, but it does not resume at any later unlock as a campaign does: its order's window ends 30 minutes after the drawn
    time and the commit's quote lifetime later (the escrow's deadline encodes the planned funding, the sixth review round), and an
    order not funded in it — 25 minutes after that time at the least, on every route — stops unfunded at the next unlock
    (`order_expired`, nothing sent). Since the eleventh review round (2026-11-04, E11-9) the Swap page and the Review say so where
    the delay is chosen, the progress page names the drawn time and the last moment the wallet can be opened for it, and Home reads
    the order "Scheduled", never "Executing"; they had promised the funding at the drawn time.
16. **V3 — destination finality is an elapsed-time margin** after the provider's delivered state (Bitcoin
    60 min, Solana 1 min, EVM 15 min, lab-calibrated), never a third-party explorer query (it would leak the
    destination); a provider lying about delivery can at most delay the next release (I3 fails closed) until
    the journaled facts disagree. Please judge the margins.
17. **V3 — the escrow approves the provider for its whole post-tip balance at execute** (bytecode, unchanged):
    a provider that pulls less keeps an allowance over that one escrow; D1 bounds it to the tranche.
18. **V3 — a campaign is a visible pattern**: N fundings of one-time escrows on a random cadence (and, with an
    entered destination, N payments to one address) are public; the lint says so and the privacy lab
    quantifies the burst share. Maximum Privacy widens the cadence; it does not hide the pattern.
19. **V3 — the risk database and the ELPF priors are assumptions**: the provider records (class, custody,
    upgradeability, incidents, audits) are maintained by hand. The audits were taken from the published reports
    on 2026-10-08 — the firm, the date, the scope and the URL of each; a date known only to the month is recorded
    as the month's last day; a per-facet audit log (LI.FI's) counts as one entry dated by its latest review. The
    incidents on record are THORChain's GG20 exploit (2026-05-15), LI.FI's two arbitrary-call exploits (2022-03-20,
    2024-07-16, both against wallets holding infinite approvals, which the escrow never grants) and NEAR Intents'
    Omni Bridge exploit (2026-10-01, refunded). Bug bounties are recorded only where a maximum is published (NEAR
    Intents $300K, LI.FI $1M); TVL and volume are not recorded. The route records are generated by the lab from
    measured quotes, and the failure priors (2 % TSS / MPC, 1.5 % relayer bridge / CCTP, 3 % intent) stand in
    until settlement history exists. The security score's adjustments (`packages/swap-engine/src/risk/security.ts`)
    are a judgement, not a measurement: a last audit older than two years costs 3 points (Chainflip's, from
    2024-08, does today), a recent incident 20–25 decaying linearly over a year (NEAR Intents' costs ≈ 20 today and
    puts its routes at exposure tier R4 for 30 days). Please judge the weights and the half-lives.
20. **V4 — the §4 policy table is read with the plan's §91**: the full protection layer activates at ≥ $1M; at
    $100K–$1M an order runs under the Protected policy (5 %) only when the service says `staged`, when Settings say so,
    or when the user asks for that order — every $100K order is not a 20-step campaign by default. The exposure tiers
    R0–R4 are derived from the V3 risk class and the live facts (`packages/protocol/src/wallet/exposurePolicy.ts`);
    no R0 or R1 route exists today (UniswapX stays an interface), so 3 % and above are unreachable in practice.
21. **V4 — the policy benchmark decides the default by a stated rule** (`docs/HighValuePolicyBenchmark.md`: among the caps
    that complete $10M within a week on the reference cross-chain route, the smallest expected loss plus cost — 1 % loses on
    the week, 5 % on the expected loss, 2.5 % is kept); the expected loss uses the assumed class priors (gap 19), the cost is
    gas at the price of the run plus the measured price impact of the pieces, and the privacy score is the assessment of
    contract §3.11, not an observer. Please judge the rule — the week is a budget, not a measurement — and whether 2.5 % should move.
22. **V4 — "Cross-chain settlement is not atomic" is now said on the Review** (plan §69) while the wording pin still forbids
    any claim of atomicity; the sentence names the fact and the refund, nothing else.
23. **V4 — the approval step and its staleness are wallet rules**, not cryptographic: an approval is a journaled tap after
    verification and the cooling-off (or the Immediate override), and a re-check after 90 days idle re-runs a verification
    method. A compromised unlocked session can approve; the second factor and the separate device still gate the payment.
24. **V4 — the velocity limit and the opt-out are the user's**: both live in the encrypted journal; a compromised unlocked
    session can raise the limit or turn the layer off (the latter behind a warned second step). There is no server-side
    limit by design (self-custody, plan §63).
25. **V5 — the percentage privacy fee is enforceable by the relayer only where the amount is public**: a withdrawal's
    `withdrawalAmount` is a public input, so the relayer refuses `fee < max(minimum, ⌈amount·bps/10000⌉)` (`fee_below_percent`); a
    private transfer's amount is not, so the wallet pays the percentage and the relayer checks its minimum only. A modified
    wallet can underpay transfers; the relayer's economics then rest on withdrawals and swaps. Please judge.
26. **V5 — WalletConnect's relay** (only when `VITE_WC_PROJECT_ID` is set, loaded lazily) sees the dApp's origin, the wallet's
    metadata, the encrypted session envelopes and the timing of the public deposits it carries; it is never used for a
    private operation. The connector is disclosed on "What stays private?".
27. **V5 — the content security policy lives in a meta tag** written into `index.html` at build time (a static host without
    headers still gets it) and in the server's headers (`docs/deployment.md`); `frame-ancestors` cannot live in a meta tag;
    a host that rewrites the HTML can remove either. The policy keeps `style-src-attr 'unsafe-inline'` for the V1.1–V4
    components still mounted (the design system sets no inline style).
28. **V5 — the pin file (`public/artifacts.json`) is served by the application's origin** and shares its trust: it binds the
    artifacts to the build (a swapped key on another host is refused), not the build to a ceremony; a production release
    pins the ceremony's key and publishes `docs/build-hashes.md` out of band.
29. **V5 — the gates run in the test browsers' limits**: axe in jsdom / happy-dom (no layout, no colour contrast) and the
    viewport matrix in one Chromium build; the leakage gate's swap leg runs the service's engine behind a fetch mock and a
    mocked prover (the proof itself is public data). V6 Stage 16: Korean is complete (every key, test-enforced) — see gap 41;
    the Chinese and Japanese tables stay partial (the shell and the first screens) and fall back key by key; colour
    contrast, the 200 % text, more contrast and forced colours are checked in Chrome by the screenshot harness.
30. **V6 — the protect fee is paid only through ProtectRouter** (`contracts/src/periphery/protect/ProtectRouter.sol`): the vaults'
    `deposit` stays public and fee-free, so a direct deposit skips the 1 % (the official wallet always uses the router; the
    core and the vaults are unchanged). The router holds nothing between calls and has no privileged path (NoPrivilege).
31. **V6 — the percentage on a private transfer is the wallet's to pay** (as gap 25): the relayer checks `f ≥ m` there; and
    an operation funded by the connected wallet (no relayer) pays no fee note at all — the privacy fee is then unpaid.
32. **V6 — the executor tip is the execution's gas, not the refund's**: a refund-only job (deploy + re-shield) costs about
    1.8 × the tip at the same gas price (forge: 3.28M against 1.81M units), and an ERC-20 order's tip, valued by the service
    when it was committed (since 2026-10-16 at the pool's own symbol and decimals for the token, `ERC20_VAULTS`: a caller's own had
    made the gas a dust tip on a vouched order), is not re-valued by the executor; the executor waits while an ETH order's execution would cost
    more than its tip, and refunds a never-executed order only from a balance that pays its tip (the escrow pays none below it); such a job ends (`lapsed`) a day past its window when the escrow holds less than its tip (audit round 2, r00). Small orders are refused when the gas exceeds the escrow's 1 % cap (`amount_too_small`).
33. **V6 — the gas pins are a toolchain's measurement** (`contracts/test/periphery/vectors/gas.json`, forge's production
    configuration): another compiler, EVM version or provider call moves them; the wallet uses them only as a fallback beside
    `eth_estimateGas`, and the tip's ×1.2 margin and the executor's below-cost wait absorb a provider call above its allowance.
34. **V6 — the API keeps swap metadata for its retention window** (`apps/api/src/db.ts` `RETENTION`): an operation's row (the
    escrow, its asset and amount, the provider, the deadlines, the states) lives until 7 days after it ends, or 2 days after
    an abandoned order's refund window; the destination and the refund material until finalize only. An operator with the
    database learns which escrows the API served and when — the chain shows the escrows anyway; it never learns who.
35. **V6 — the API's reconcile and quotes are a second source** (`apps/api/src/reconcile.ts`, `quote.ts`): the chain is read
    from the first RPC endpoint that answers (no quorum), the §46 fees are indicative; the wallet's own reads (its quorum)
    win, and it computes the escrow's W with its own relayer terms. The rate limiter is in memory (a restart resets it).

36. **V6 — same-chain swaps into the protected balance run on THORChain only** (`Capabilities.sameChain`): LI.FI's
    same-chain route needs a GenericSwapFacet verifier in the adapter and the wallet first. The relayer's shield executor
    calls `shield()` only; `shieldToken` and `sweepUnsupported` are left to anyone (the third review round, 2026-11-03: the sweep
    refuses ETH and the wrapped native token — the pool's own asset in another form — so a WETH delivery can never be moved to the
    public fallback; at a token receipt ETH and WETH shield as ETH through `shieldToken`). A receipt registers with the relayer in
    the hand-over tick, before finalize: a journal lost before that point can recover the delivery only with its
    `receiptId` (the seed re-derives the note's payload by counter).
37. **V6 — ProtectRouter, ShieldReceiver and ShieldReceiverFactory are new and unaudited.** They are periphery
    (replaceable: the core and the vaults do not know them), with no privileged path (NoPrivilege) and forge suites of their
    own (`contracts/test/periphery/ProtectRouter.t.sol`, `ShieldReceiver.t.sol`), fuzzed accounting and vectors shared with
    the TypeScript; their gas is pinned in `contracts/test/periphery/vectors/gas.json`. They are part of this engagement's scope (§1.2). The third
    review round (2026-11-03) changed the receiver (the WETH/ETH rules of gap 36) and the escrow (`_payTip` pays only when more
    than the tip is there), so both factories' creation code changed — before any public deployment; the exported artifacts, the
    three vectors, the gas pins (`shieldETH` 2,990,000, `shieldERC20` 3,020,000) and the real-proof fixture are of that build.
38. **V6 — a legitimate redeploy on a chain the wallet used is accepted only by forgetting the remembered deployment**
    under More → Advanced (`packages/sdk/src/deploymentGuard.ts`): there is no in-flow acceptance, by design (a deployment
    that changes under the user is the attack the check exists for).
39. **V6 — the seed stays on the main thread while the wallet is unlocked** (spec v2.0 §14.3): the crypto worker holds the
    circuit inputs, the spend plans and the view key for discovery, but another script of the origin can read the main
    thread as in any web wallet. Unlocking inside the worker is a later pass. The proving key's Cache API entry is public data
    under its pin.
40. **V6 — auto-lock and its holds are wallet rules**: a compromised unlocked session can raise the idle time (1–60 minutes)
    or keep a hold; a hold lasts at most 30 minutes, then the next safe point locks. Focus loss counts as idle only (a wallet
    popup or WalletConnect takes focus).
41. **V6 — the Korean catalog awaits a native speaker's review** (`apps/web/src/app/i18n/ko.ts`): every key is translated
    and tested for placeholders and the words the wallet never uses, but a person has not read it.
42. **V6 — offline is inferred** (the browser's event, or three unanswered requests in a row) and a lost answer is resolved
    by asking the relayer for the job by its nullifier: a relayer that answers "unknown" for a submission it did make can
    only cause a second attempt that fails on chain (a nullifier spends once) — a wasted fee, never a double spend. The
    same holds for a transaction the relayer counts as dropped (unknown to its node 10 minutes after it was sent, its
    nullifiers unspent) that is mined after all: the wallet's next attempt reverts (2026-10-14). A swap's funding that is
    sent and never confirmed is never sent again: a dead one (its notes unspent and its transaction reverted or gone)
    stops the swap (`funding_unconfirmed`), and one that may still land keeps it reconciling past its window; landed late,
    the swap stops for "Return funds" (`execution_window_closed`). Until a follow-up later that day, the window's end
    stopped the swap whatever the funding's fate, and the claim here that a later landing "comes back through the escrow's
    refund" had no one to trigger it: the escrow's `refund()` needs the refund note data, which only the wallet holds. Since the
    same day, a funding is journaled before it is sent and never sent twice on its own: a reload during a funding had
    sent a second one (both landed when the notes differed, the excess held in the escrow until its refund). A dead
    funding (its notes unspent, no relayer job, older than 10 minutes) stops a swap, and only the user's Resume funds a
    protected execution's step again. The relayer's executors count a swap, refund or shield transaction as dropped by the
    same rule and send it again (2026-10-15); if the dropped one lands after all, the second call reverts at the relayer's
    cost (an escrow executes once and refunds what it holds; a receiver shields what it holds).
43. **V6 — a trending price can ask the user again** (narrowed 2026-10-14). The local stack's run had accepted six moved
    minimums in a row: after "Accept new minimum" the runner prepared a fresh hard quote, which in a market moving one way
    was lower again. Now the runner keeps the call behind the pause and, once its minimum is accepted, checks it again
    and signs that very call while at least two minutes of it remain (`ACCEPTED_CALL_MARGIN_MS`). The execution lands
    unless the market moves past that minimum before it does; the provider then refunds, or the call reverts and the
    funds wait in the escrow. What remains:
    - a call that expired meanwhile, or that a lock or reload forgot (it is kept in memory only), is quoted afresh, and a
      lower minimum asks again;
    - the wallet never signs below a minimum the user accepted. A tolerance would trade the remaining friction for a
      minimum the user did not see.
    - Inside a protected execution (V3, and the $50K band) there is no such question: a step is held to the campaign's
      price bound, the confirmation's minimum per unit less the 50 bps the user approved (V3 §3; enforced at signing
      since 2026-10-14). A dip inside it is signed; below it the steps pause, by design.
44. **V6 — a route change can hold a funded step until its refund window** (observed 2026-10-14 in the local stack's $80K
    run; narrowed the same day).
    - Below the second-confirmation tier, a requote adopts a better route by itself (`campaignRunner.ts`, `adoptsRoutes`).
    - A step already funded on the old route used to return through its refund-only job at once. The escrow allows that
      refund only after `refundAfter`: about 2 h 40 min after the step's commit in the $50K band (a 30-minute execute
      window, then the 2-hour refund window). Meanwhile the band's one-quarter cap held the next step.
    - Now such a step finishes on the route it was funded on: the route it was approved on, while that route is sound
      (`leftRouteUnsound`: its breaker closed, no incident since the campaign started, read fresh) and signs it at its
      approved minimum. The V3 §8 rule only asks that a route change be confirmed, or adopted below the
      second-confirmation tier; the refund of a funded step was this implementation's choice, made for the price guard.
    - What remains: a step whose own route now guarantees less than approved, is refused by the price guard, or is
      unsound still returns through its refund and waits for the escrow's window. The funds are never at risk (the
      escrow re-shields into the pool), but the swap waits.
45. **V6 — a service that stops answering** (narrowed 2026-10-14). A provider's health check had no time budget.
    THORChain's walks up to three gateways in turn, so one slow provider held up every competition, and with it every
    quote, every commit and the status read before every hand-over (in the local stack's quick pass, a commit waited
    over two minutes). Now one budget per provider (25 s) covers its health check and its quote. The status read answers
    from the health cache within that budget, and the wallet ends every API call after 90 s (`ApiTimeout`).
    - What remains: the prepare's hard quote and ingress are bounded only by each adapter's own request limits
      (THORChain: up to three gateways in turn, then the gateways' inbound vaults and, when the quote names another vault
      than the one they suggest, their lists of active vaults — each read in parallel, 20 s). The order runner retries a
      prepare that timed out.
    - The wallet's relayer calls end too (the same day): a read after 20 s, a submission or a hand-over after 90 s
      (`packages/sdk/src/relayer.ts`). A timeout is a lost answer, resolved by the lookup by nullifier (gap 42), and the
      failover moves on from a relayer that does not answer its terms. The API's reads of the relayer and of the RPC
      endpoints end after 10 s.
46. **V6 — the relayer's journals are never pruned** (noted 2026-10-15). `submissions.json`, `swap-jobs.json` and
    `shield-jobs.json` keep every job the relayer ever had, and every change rewrites the whole file (flushed to the
    disk before its rename since the same day), so a busy relayer's writes grow with its history. Pruning settled jobs
    is a decision across components, not a cleanup:
    - a fee note whose payload the relayer cannot read (`REQUIRE_READABLE_FEE_PAYLOAD=0`) has its opening only there;
    - the wallet's reconciler asks the relayer by nullifier about a submission whose page closed mid-way
      (`packages/sdk/src/operations/stale.ts`), and a withdrawal without a change note stays open when neither the relayer
      nor the chain names its transaction (its nullifiers spent, the job gone);
    - the wallet registers a shield job again when the relayer does not know it, which for a delivery shielded long ago
      would read as expired.
    Until a retention rule settles those, the files grow; `GET /jobs` and `GET /swap` (operator only) show how far.
47. **V6 — the swap executor pays for orders it cannot value** (noted 2026-10-15; closed for swap orders 2026-10-16, the
    owner's choice: the executor runs only what the swap service vouched for). It admitted orders from anyone who can
    sign one (the order key is the committer's own). Since the same day it serves only the deployment's factory: it had
    called whatever factory an order named, at its own gas. Each order's terms on that factory are still its committer's:
    - an ERC-20 order's tip is in the order's token, and the executor does not value it. The API valued it when it
      committed the order, but the relayer never sees whether the API did. A token of no value, or a tip below the
      gas, costs the relayer the execution's gas, and the provider call the order signed can make that gas large;
    - the first refund of an order that never executed pays the committed tip and is sent with no cost check. A refund
      costs about 3.45M gas (`packages/contracts/src/gas.ts`) and the escrow allows a zero tip, so an order made never
      to execute cost the relayer up to a whole refund, while its maker spent a transfer and got the funds back as a
      note. An honest tip prices the execution's 2.05M units at twice the base fee plus the priority fee, with 20 %
      more: about 1.4 refunds' worth at the same base fee, short only when the base fee rose by about 40 % since;
    - (closed the same day) the refund vault was the one the order names, so a refund deposited into any contract at
      the relayer's gas; now it must be the pool's own vault for the order's asset, read before admission.
    The owner chose orders the API vouches for (2026-10-16). With `API_VOUCH_KEY` the API signs the escrow of each order
    it commits (the address commits to the factory and every parameter: the tip it valued, the pool's refund vault, the
    asset, the amount) and, at the finalize, the provider call it prepared for that order, only when the wallet shows
    the order's vouch (`apps/api/src/vouch.ts`). An order rebuilt from params gets no vouch of its own. With
    `API_VOUCHER`, the relayer runs an execution only with the API's vouch for that very call and a refund only with
    its vouch for the order (`apps/relayer/src/swapExecutor.ts`); without the address it runs no swaps. What remains:
    - a committed order that never executes pays its refund with its tip, which falls short only when the base fee
      has risen by about 40 % since the commit; a party that commits orders only to have them refunded pays that tip
      each time;
    - the API's key is the relayer's trust: whoever holds it can make the relayer run any order (`docs/threat-model.md`).
      It can be rotated (a follow-up of the same day): the relayers' `API_VOUCHER` lists the new and the former
      address, and the API's finalize honors the former key's commit vouches while `API_VOUCHER_PREVIOUS` names it. A
      leaked key is dropped from both at once (`docs/deployment.md`);
    - (closed the same day) the shield executor (`POST /shield`) admitted receipts from anyone, with the same exposure
      for a token of no value. Now the API vouches for a protected order's receipt at its commit: the receiver predicted
      from `SHIELD_FACTORY` is the order's destination, it names the asset the swap delivers, and its tip is at least
      half of the one the API prices (`400 bad_shield_receipt` otherwise). The executor shields only a vouched receipt.
      Later the same day: the receipt's minimum, the delivery that pays its tip, must be at most the order's minimum
      output. A receipt whose minimum a delivery that meets the order does not reach leaves its tip unpaid: the relayer
      shielded such an ETH delivery for nothing once the swap was over (up to `MAX_UNPAID_SHIELDS` times a job), and a
      token's stayed at the receiver.

48. **V6 — what one-time owner commitments leave linked** (the audit round of 2026-10-16, c18/c29/c37; closed for new
    activity). Every protect, every order's refund note and every same-chain receipt had named the privacy address's
    owner commitment — an indexed `Deposited` topic and a public escrow or receiver immutable —, so anyone could link a
    private swap to the public account that protected the funds. Each now names its own (`packages/protocol/src/keys.ts`
    `deriveOwnerKey`, from the note's secret; found again from its self-envelope, spent with its own key). What remains:
    - what was made before stays linked: those deposits, escrows and receivers carry the privacy address's owner
      commitment, which is in `pp1…`, so whoever holds the address can list them; an order an older build committed and
      funded still refunds to it (one not yet funded is stopped, `order_outdated`);
    - protects sent from one public account stay linked by that account (`tx.from`); a fresh account per protect is
      the user's choice;
    - one order's escrow, its refunds and its receiver share that order's owner commitment (inherent, and nothing beyond
      the order);
    - the endpoint behind the light client's proofs learns each unspent note's nullifier slot (gap 80; since the sixth review round
      the quorum is asked no spent bit by name, and since the ninth no funding's either);
    - a counter handed out again republishes a note's secret and owner commitment: after a restore none is handed out
      before one complete scan, and they resume 256 past the last one found — a note 1,024 or more counters past every
      one found is beyond that search;
    - a native wallet built on `privacy-ffi` has the single-commitment scan only, and must add the opening batch
      (`docs/mobile.md`).
49. **V6 — a copied transaction takes its tip** (the audit round of 2026-10-16, c14/c45; open). The escrow factory's
    `deployAndExecute` and the shield factory's `deployAndShield` pay their tip to `msg.sender`, so anyone who copies the
    relayer's pending transaction with a higher fee takes the tip, and the relayer's own then reverts at its cost. The
    funds still go where the order key and the receipt committed: the copy runs the same call. The relayer reads the
    outcome from the escrow or the receiver (`executed()`; a mined shield that reverted reads the receiver again) rather
    than calling it failed. What remains is the executor's economics: on a public mempool it can be made to pay without
    being paid. A private transaction relay for the executors' sends answers it outside the contracts; a tip recipient
    committed in the order or the receipt answers it inside them, with a new deployment of both factories.
50. **V6 — the shield executor's job cap can be filled** (the audit round of 2026-10-16, c11; narrowed 2026-10-17). A
    relayer watches at most `MAX_SWAP_JOBS` (1,000) open shield receipts. Since the vouches (gap 47) a receipt needs the
    swap service's vouch from an order's commit, but a commit costs nothing until the order is funded, and the wallet
    registers its receipt before the funding (c12). So anyone who commits orders fast enough (past the API's per-caller
    rate limits) can fill the cap, and same-chain swaps are then refused (`capacity`, retried, nothing funded) until the
    jobs end: at their `deliverBy` and a day's late watch when nothing arrived. Before 2026-10-17 a dust delivery kept a
    job open for good; it now ends at the watch's end (c10). What would close it: a vouch over the order's `refundAfter`
    as well as the receiver (the job then ends with its own order), and a job that becomes watched each tick only once
    the order's escrow holds its funding (checked at the hand-over's registration, with the order's vouch), unfunded
    receipts kept in a short-lived tier of their own.
51. **V6 — one wallet on two devices at once** (audit round 2, r45/r46; the owner deferred multi-device use in V3). Two
    devices running the same wallet — the phrase restored on a second one, or a backup restored while the first keeps
    running — share the seed's note counters: once each has seen the other's notes, they hand out the same next counter,
    so a note secret and its public owner commitment (a deposit's, an order's refund note) can be used twice, which links
    the two operations. A backup also carries the orders and campaign steps of its moment; since 2026-10-22 one the
    executor already has is tracked rather than funded again (r45), while an order the other device handed to another
    relayer is not known here. What would close the rest: a counter space per installation (a random range or tag that a
    seed scan can enumerate), or random secrets for the notes an envelope carries, leaving counters to the seed-derived
    refund and shield payloads.

52. **V7 — Tornado Classic waits for the legal review** (the owner's decision 9 of 2026-10-26). The Classic application
    (`classic/`, spec v3.0 §7) runs against the real mainnet pools, router and registries behind `CLASSIC_LIVE` switches
    that are off in every build; the original interface's sanctions-oracle check and geofence exist behind switches, off.
    `classic/docs/release-gate.md` holds the technical rungs (green but the mainnet-fork run); `classic/docs/legal-review.md`
    is the empty record. Nothing is live until both say so.
53. **V7 — the mainnet-fork run of the Classic prover is open.** `classic/test/fork/withdraw.fork.test.ts` deposits
    through the real router and withdraws through it by a relayer stand-in, then ages the root out of the pool's hundred;
    it ran in its devnet mode against the local stack's chain (the same contracts at their mainnet addresses) but not
    against a fork of mainnet's state: a fork node cannot start on the development workstation (Hardhat's fork engine dies
    at start, as anvil does there). To be run on another machine before any pool function is switched live.
54. **V7 — the licence boundary.** The Classic bundle is GPL-3.0 (websnark, snarkjs 0.1.20, circomlib vendored) and served
    apart from the MIT wallet (the owner's decision 10); `snarkjs` 0.7.6 (GPL-3.0) runs inside the Privacy Wallet's crypto
    worker and the Classic app's offline verifier. Flagged for the owner's lawyer; no code change proposed here.
55. **V7 — what the RPC endpoints and the relayer see.** As in the original: the RPC endpoints see the IP address, the pools
    read and a disclosed `isSpent` read's nullifier hash; the chosen relayer sees the IP address, the recipient, the pool and
    the proof. Both are stated on the screen (`classic/docs/threat-model.md`); a web build cannot hide them.
56. **V7 — a user-typed relayer URL and a device-kept deposit list are owner follow-ups.** The strict policy allows the
    curated relayers' hosts only (`classic/relayers.json`), so a relayer the user types cannot be reached by a release build;
    the note is the only key (the original's IPFS-less mode), so a lost note is a lost deposit — an encrypted, device-kept
    list would be a new store of secrets and is not built.
57. **V7 — the host's integrity for the served Classic code** (TC-01's remaining half): the policy, the pins, the budget and
    the bundle scan bound what runs, but whoever controls the host controls the note when it is generated and pasted. The
    upgrade is a content-addressed build checked against its hash, or a signed native app — the same residual as the
    wallet's (`classic/docs/security-review.md` §2).
58. **V7 — the real-device run of the mobile-web gate is open.** What a phone's browser does at a wallet handoff, in the
    background and under storage pressure is met in code and under unit tests (`docs/mobile-web-gate.md` §1), and the browser
    run drives Chrome under mobile emulation; the twelve scenarios of §2 there need iOS Safari, Android Chrome and the
    wallets' in-app browsers in hand. The record of runs (§5 there) is empty until the owner fills it.
59. **V7 — a scheduler failure is silent on the screens — closed (a V7 follow-up of 2026-11-02).** A runner tick that
    throws is recorded in the journal's schedule (`error`, the backoff: ten minutes, doubling) and in `schedulerStatus`,
    which no screen rendered; the first full local run since Stage 12 found a campaign's step "committed" for ten minutes
    with nothing to say (the step fee bound, fixed in `58ac5da`, which also pauses the campaign on a moved fee). Now the
    entry keeps the catalog's code of the failure (`errorCode`), the operation's detail — the swap's progress, the Activity
    detail's campaign line, every `OperationProgress` — names the last failure in the catalog's words with the next attempt
    (the message itself under Advanced), and "Try again now" drops the backoff and wakes the scheduler: the runners
    reconcile before they send, so the user's tap is safe (`packages/sdk/src/wallet/schedule.ts` `failedAttempt` /
    `retryNow`, `apps/web/src/features/operations/AttemptLine.tsx`; `packages/sdk/test/schedule-attempt.test.ts`,
    `apps/web/test/attempt-line.test.tsx`). The browser run's campaign log names the line when it shows.
60. **V7 — WalletConnect is third-party code under the policy.** With a project id the bundle ships
    `@walletconnect/ethereum-provider`, which talks to its relay and loads the verify iframe; the policy names those hosts and
    no telemetry host, and the metadata declares this origin's icon and `redirect`. Its modal is off since the eleventh review
    round (slice 6c): the policy refuses the `<style>` elements it writes, and under it the modal took no tap — a phone could
    neither start a pairing nor cancel one —, so the wallet's own sheet shows the pairing (its QR code, the link that opens the
    wallet app, Cancel) and the modal's hosts are no longer allowed; its code still ships as chunks the provider never loads. With
    the modal off, a request opens no wallet app by itself: the sign client deep-links a request only to a wallet the modal recorded
    (`WALLETCONNECT_DEEPLINK_CHOICE`), so the user switches to the wallet app to sign (`docs/mobile-web-gate.md` §6).
    The project id, WalletConnect's own privacy terms and whether to ship the connector at all are the owner's (spec v2.0 §23's
    WalletConnect note stands).
61. **V7 — a campaign paused on a moved fee has no "accept today's fee" (the review round of 2026-11-02; the owner's).** A
    protected step whose relayer fee rose above the Review's bound pauses its campaign (`58ac5da`), and "Resume" meets the same
    bound — paused again while the fee stays higher. The user's way out today is Cancel with "Return the rest" and a new Review
    at today's fee. Whether the campaign should offer to re-bound its remaining steps to the current terms with one confirmation
    (one more place a fee is accepted) is the owner's decision; until then the pause names the bound and the fee.
62. **V7 — the API's route qualification needs a valued set (the review round of 2026-11-02; the owner's).** The §46 quote
    carries `route_not_qualified` from the risk database's measured limit against the order's dollar value — now the value of
    what the user pays (`apps/api/src/quote.ts` `valuedAt`). A set the engine could not value (no price answer) carries no
    `usd`, and the qualification cannot fire: an unvalued order above a route's measured limit passes the service's check and is
    held only by the wallet's own bands, which are unvalued too without prices. Refusing to quote a large order unvalued, or
    carrying a `valuation_unavailable` warning the Review shows, is the owner's call.
63. **V7 — the in-flight count's tier is the journaled one (a stated limit, not a gap).** `protectedInFlightOf` counts the
    open orders and running campaigns whose journaled tier is `large-protected` — the higher of the service's and the wallet's
    at the commit — so a price move after the commit never changes what counts, and a wallet whose prices were unavailable at
    the commit counts that order at the fail-safe band it was journaled at.
64. **V7 — WalletConnect's RPC host is not in the policy (the review round of 2026-11-02; the owner's real-device run tells).**
    The policy had allowed `https://*.walletconnect.org`, which let the telemetry host (`pulse`) and the provider's RPC host
    (`rpc`) through while the documents read "never"; every host is exact now and a test matches the forbidden hosts against
    every source. The provider routes `eth_accounts`, `eth_chainId` and the wallet's methods locally or through the relay; a
    read it would route to its RPC host (none of ours) fails under the policy instead of leaking. Gap 58's run is where a
    wallet flow that needs it would show.
65. **V7 — the Home badge follows the honest timing score (the second review round, 2026-11-03; the owner's to re-weigh).**
    The Privacy Center scored Timing privacy for the preference's random funding window (1–24 h, 6–72 h) and the Home badge
    read "Protected" on it, while the one-confirmation runner (spec v2.0 §7.6) funds a swap as soon as it is confirmed — only
    "Delay for more privacy", chosen on a swap, adds a random 1–24 h. The posture now scores the funding as immediate, so the
    Timing category reads Reduced and the badge — the lowest category — reads "Low protection" for every wallet, as the Privacy
    Center it opens reads "🛡 Low protection": one rule maps the posture's word to the level for both
    (`apps/web/src/features/protectionLevel.ts`). Until the eleventh review round (2026-11-04, E11-11) Home kept a rule of its own
    and read one level more — "Medium protection" for Reduced, "Protected" for Good —, so this gap had not said what the screen
    showed. The words are true; whether the overall level should be the lowest category, or weight timing differently, or offer
    the delay as a setting, is the owner's product decision.
66. **V7 — a campaign's merges are bounded, not named per step (a stated limit).** A swap's funding bounds the merges it needs
    by the Review's F (`reviewedMergeFee`, the second review round), and the Swap Review names them for a one-order swap;
    a protected execution's steps bound theirs by the same F (`bounds.maxRelayerFee`) but the Review shows no per-step merge
    count — the pieces are drawn when the steps run. A step whose notes need more merges than F × n allows pauses as a
    fee bound (`fee_moved`), never pays more.

67. **V7 — the band thresholds are the user's (the third review round, 2026-11-03; the owner's call).** The wallet-side controls of
    the $50K and $100K bands — the hold, the in-flight limit, the Advanced gate, the steps, the destination re-confirmation —
    key on `settings.tiers`, which Settings lets the user raise without a ceiling (spec v2.0 §2: "user-adjustable"); a $150K swap
    under thresholds raised to $200K / $300K runs as the lower band in the Simple experience. The API still values every order
    at its own floor and applies the route qualification. Either clamp each threshold to at most its default
    (`checkThresholds`), or keep them adjustable and say so in the spec; nothing moves until decided.

68. **V7 — Tornado Classic on the wallet's origin shares its storage partition and its Web Locks (the fourth review round, 2026-11-03;
    the owner's hosting call).** Served under `/classic/` of the wallet's origin, the Classic application is the same origin to the
    browser: the wallet's IndexedDB (two ciphertext blobs, the prefs) and its Web Lock are reachable by any script of that origin, so a
    Classic compromise (a dependency's, a host's) would be an origin-level one for the wallet too — rule 9 keeps the source trees
    apart, not the browser. Its own origin is the stricter hosting: `VITE_CLASSIC_URL` points the wallet's More entry there
    (`docs/deployment.md`, "Prefer its own origin"); until the owner chooses, `/classic/` stays the documented default.
69. **V7 — no automated run asserts the served headers (the fourth review round, 2026-11-03).** The policy tests read the policy the
    build generates (`apps/web/scripts/csp.mjs`, `classic/scripts/csp.mjs`) and the local stack's dev servers set it from the same
    source, but the production headers — the three `location` blocks of `docs/deployment.md`, now including the forced
    `Content-Type`, the `sandbox` policy and `nosniff` on `/zkapi-deployment/` — are never fetched and compared by a test. The
    deployment check is the operator's: `curl -I` each location against the document before the first public release.

70. **V7 — the wallet password is offered to the browser's password manager (the fifth review round, 2026-11-03; the owner's
    call).** The create and unlock fields carry `autoComplete="new-password"` / `"current-password"` (`apps/web/src/features/onboarding/Lock.tsx`),
    so a browser that saves it keeps the password beside the keystore it protects: a thief of the whole profile gets both, and
    the scrypt cost counts for nothing in that one threat model. A deliberate usability choice today; `autoComplete="off"` on
    those fields is the alternative, and the spec should say which.
71. **V7 — what a seized device still tells (the fifth review round, 2026-11-03; informational).** After a Forget everything of
    the wallet's under the origin goes (`apps/web/src/platform/forget.ts`; WalletConnect's own IndexedDB database among it — since
    the eleventh review round, in the page that loaded WalletConnect, its session is ended and its keys removed through its own storage
    before the Forget resolves — waited for 5 s at most (`WALLET_CONNECT_END_MS`): an end that fails (offline: the library refuses at once),
    or whose delete is not yet acknowledged when the production build restarts, is not sent again, the session staying live at the wallet
    app until it ages out; one acknowledged with its unsubscribe unanswered has removed it there (the twelfth review round, B12-3; a dev
    build, which does not restart, deletes a failed one again at the next WalletConnect tap, and refuses every tap while one is unfinished,
    as gap 112 says) —, the database
    deleted at a later page start; a Forget made while another tab holds WalletConnect leaves
    that tab's session, pairing and keychain until that tab closes and the wallet's origin is opened again with no tab holding it —, and
    the Forget resolves once its deletes are written: the tenth review round, D-3, D-9). A passkey the wallet registered —
    the second factor's or the second device's, the discoverable `privacy-wallet`, which may sync — stays in the platform's list: a
    Forget cannot delete it and signals nothing to the authenticator, since another installation of the wallet may use the same synced
    passkey (the eleventh review round's critique); the Forget's dialog tells the user to remove it there. Before a Forget: the
    preferences hold the backup dates and the last connector in the clear, the backup download is named
    `privacy-wallet-backup-<date>.json` in the Downloads folder, and the artifacts' cache says a private spend was proved here. In memory, the 24-word phrase string the
    chain keys are derived from (`@scure/bip39` takes a string) lingers until the collector and memory reuse — not the only
    copy of the seed's material the lock cannot zero (the eleventh review round, F11-8): the spend, view and note keys
    `deriveKeys` returns (at a dozen call sites) are JavaScript bigints, which nothing can zero; each EVM and Bitcoin derivation
    builds an `HDKey` from the 64-byte seed whose root is never wiped (`wipePrivateData` is not called; `dropChainSeeds` zeroes
    only the cache's copies of the master seed and the BIP-39 seed), and every derived account key — EVM, Bitcoin, Solana's
    SLIP-0010 — is a byte array never wiped. A generic backup filename would close the download's name; wiping the HD roots and
    the account keys narrows the rest, and a byte-based mnemonic derivation alone would not close the class.

72. **V7 — the executor tip is priced once, at the commit (the fifth review round, 2026-11-03; the owner's call).** An ERC-20 order's
    tip is in the token, valued by the service when the order was committed, and the executor never re-values it: committed at a low
    gas price and funded a day later at a high one ("Delay for more privacy", a 72-hour policy), the execution goes out at a loss the
    relayer bears; an ETH order's execution waits for a cheaper block and, since this round, goes out in the window's last half hour
    rather than into a refund that costs 3.45M gas against the same tip (`LAST_CALL_SECONDS`). A valuer in the relayer (the service's
    Chainlink reads, `packages/swap-engine/src/valuation.ts`) would let it wait on token orders too; sizing the tip's headroom by the
    policy's window in the API is the other half. Nothing moves until decided.
73. **V7 — a shield receipt is vouched at half the priced tip (the fifth review round, 2026-11-03; informational).** `apps/api/src/routes/swap.ts`
    accepts a receipt whose `shieldTip` is at least half of what it just priced, and the shield executor prices an ETH receipt only:
    a protected order never funded, whose receipt is registered and fed its minimum, gets one shield at the relayer's expense. The
    half is deliberate (gas moves between the wallet's pricing and the commit); a token-shield valuation is gap 72's valuer.
74. **V7 — the circuit relies on the contract's insertion rule for the leaf index (the fifth review round, 2026-11-03; for the
    pre-ceremony revision).** `circuits/transaction.circom` hashes the free `inLeafIndex` into the commitment and proves membership at
    the free `inPathIndices`; nothing ties the two. Sound today because `PrivacyCore` inserts exactly `H(body, index)` at `index`, so
    a (body, other index) pair is never a member without a Poseidon2 collision — but a `Num2Bits(32)` of the index compared to the
    path bits would make the circuit self-sufficient. A circuit change needs a new key: for the revision before the ceremony.
75. **V7 — the vouch digests carry no key id, and the restore signature covers the pair, the destination and the provider (the fifth
    review round, 2026-11-03; informational).** While a former API key is listed (`API_VOUCHER_PREVIOUS`), a compromise of it
    forges order vouches for arbitrary params (the relayer refunds any attacker escrow holding at least the tip, at 3.45M gas) and
    the API's finalize accepts the forged commit vouch; a captured restore signature could rebuild under another amount or policy —
    the wallet's own call check refuses a mismatched call. Short rotation windows are the operational answer; a key id in the vouch
    tag and the normalized request body in the restore text the structural one.
76. **V7 — Classic with one RPC endpoint trusts it alone (the fifth review round, 2026-11-03; stated on the screen).** With two or
    more endpoints the history's root and count are held to both at every sync (the eleventh review round, C11-12) and a wallet-mode
    send asks the second about the spent bit; with one, a lying endpoint can have a history verified that hides a deposit, and have the
    user's own `withdraw` revert on `isKnownRoot` (some 300,000 gas) and publish the nullifier hash beside the recipient before any
    withdrawal — the deposit itself is never at risk. tornado-relayer 4.x checks no root and no proof of its own
    (`classic/docs/compatibility-matrix.md` §4), so with one endpoint a relayed job on an invented root may be mined as a revert at the
    relayer's cost and publish the same (this gap had said the relayer route refuses such a job for free; C10-14). The tenth review round
    asked the second endpoint about a relayed proof's root before the submission; since the eleventh (C11-9 and its critique) the second
    is not asked at a relayed withdrawal's moment: the proof's root is its history's, held to both at the history's sync, the pool's
    history is held from syncing while a relayed withdrawal runs, the reads that name the note or the proof's root go to the first
    endpoint alone (never through the failover; a silent one refuses), and a relayed withdrawal whose root aged out (the history's root
    is checked before the proof, the proof's after it) is refused rather than proved again on one endpoint's word. Two moments remain when
    the second endpoint may learn the root a relayed withdrawal uses before it is on chain: the retry's sync after that refusal (both
    endpoints asked), and the sync after a flow that ended before its relayer's outcome (its answer lost, its job no longer followed),
    which keeps the pool held 15 minutes first (every page of the device takes the hold from its records at each sync while a relayed
    withdrawal of the pool is unsettled — running in another tab, its page closed during it, or ended so; Check on chain asks the first
    endpoint alone while it lasts). Configuring two endpoints is the deployment's choice (`VITE_CLASSIC_RPC_URLS`).
77. **V7 — CI runs the gate without the real inputs, and builds a bundle that is not the release's (the sixth review round,
    2026-11-03; the owner's).** The circuit artifacts, the core WASM and the zkAPI clone are not on the CI machine: the pins
    step passed on "skipped" rows, the artifact emitter built the stub, and a pull request could have rewritten a proving key's
    hash unseen. Since this round a pin file that changed since the base fails there (`PINS_BASE`), the zkAPI SDK clone is
    pinned by commit and file hashes (`apps/web/zkapi-sdk.pins.json`) and the build refuses another, the tool directories'
    lockfiles and reviews are gated, and the audit must get an answer from the registry in CI (`--require-answer`). What
    remains is a release job on a machine that has the real inputs — the owner's.
78. **V7 — a campaign's steps cluster on chain by their escrow parameters (the sixth review round, 2026-11-03; the owner's call).**
    One provider, one execute window constant, one relayer account, a cadence inside the plan's bounds; the pieces sum to the
    typed amount, the last one exact. A chain observer can group a campaign's escrows and recover the order's size. Options:
    a window drawn per step inside the plan's window, a bucketed total with the remainder kept as private change, provider
    rotation where the risk engine permits — each a change to the exposure policy the owner set (`docs/high-value-protection-spec-v1.0.md`).
79. **V7 — the fee note's position and the 1.1× margin tell the relayer the operation (the sixth review round, 2026-11-03; the
    owner's call).** A withdrawal's and a merge's fee note sit at output 1, a split's and a transfer's at output 2; the fee is
    exactly 1.1× the relayer's live minimum, which pairs a submission with the `/info` read that priced it within its 5-second
    window. On chain nothing of this shows. One position for every kind and a randomised margin (or fee tiers) would close it;
    the fee-bound tests pin the margin, so it is a decision, not a fix.
80. **V7 — what the endpoints still learn: the escrow reads and the light client's proofs (the sixth review round, 2026-11-03;
    the owner's call).** The quorum's per-nullifier `isNullifierSpent` reads are gone — the spent bits come from the pool's spend
    events read fetch-all with the note events (a swap funding's fate and the stale mover's fallback still asked them by name until
    the ninth review round, 2026-11-04) — and a Protect's receipts are read through the connected wallet's own provider only (the
    eleventh review round, F11-10: the stale mover had asked every endpoint for a Protect's hash, even with its note found, and the live
    flow had when the wallet gave none — another network, a provider error, ten minutes; now the note or that provider settles it, and a
    deposit the wallet reports nothing for is left to the scan; an ERC-20 approval through WalletConnect, whose provider answers no read under the policy: gap 100); the
    receipts of the transactions this wallet sends are read by their hash (gap 101).
    Two reads remain address-specific: every order tick reads the escrow's balance on every endpoint, and where a light client
    applies, every scan proves each unspent note's nullifier slot (`eth_getProof`), which names this wallet's notes to the
    endpoint behind the proofs. Dropping the proofs weakens the defence against an endpoint hiding a spend (n44, threat-model A2);
    a separate proof endpoint, proving only the spent marks, or decoy slots are the options — the owner's call between A2 and
    this. The Privacy Center says what the endpoints see.
81. **V7 — delivery is the provider's word (the sixth review round, 2026-11-03; design-accepted, residual stated).** No adapter
    reads the destination chain; Across reports `expired` as refunded before any refund exists and never an amount. A provider
    answering "filled" for an execution that paid nothing completes the order and retires the fresh address. Backstops: the
    relayer's late-refund watch (24 h past `refundAfter`) and `lateRefundHeld` while the record is open. What would close it:
    the API confirming EVM fills from its own RPCs before `completed` reaches the wallet, amounts from Across's fill data.
82. **V7 — LI.FI → Mayan routes are not fully read at quote time (the sixth review round, 2026-11-03; narrowed by the twelfth,
    2026-11-09; Fastest policy only).** The engine reads a Mayan facet call's refund recipient and minimum, the pinned Mayan
    protocol, and the order inside `protocolData`: its selector, its whole static part, its token (what the facet hands Mayan),
    bridged alone its amount, ETH only through a leg into USDC (VZ-2), and no gas drop and no referrer at any rate (the owner's
    decision, 2026-11-09: every LI.FI → Mayan route named LI.FI's own referrer at 0 bps that day, so none is offered). The rest of
    the order — its trader, receiver, chain, asset, fees, deadline, auction mode, payload and minimum, and a leg's floor after
    LI.FI's own swap — only the wallet decodes at signing: a route it refuses for one of them is offered and, `minOutVerified:
    false` routes going through under Fastest only, funded first; the escrow then waits for its refund. Mirroring the wallet's
    remaining checks in `verifyLifiTransaction` would close it.
83. **V7 — a "dead" funding verdict is a verdict (the sixth review round, 2026-11-03; the owner's call).** A sent funding now reads
    dead after an hour — as a spend the wallet's own connection sent does (n66) — never ten minutes, whose relayer could have
    forgotten a transaction other nodes still held. A transaction mined after that hour still leaves the escrow funded with its
    order closed (`abandoned`, the record CANCELLED): nothing ticks it, nothing offers the return, and the refund note is found
    only once someone refunds the escrow. A slow escrow watch after an abandon, until `refundAfter`, would close it.
84. **V7 — public exits default to exact input (the sixth review round, 2026-11-03; a product choice).** A bucket typed on
    Send or Swap leaves the bucket less the fee on chain; the lint now judges the amount that leaves and names a whole-note exit
    (Max with one note reproduces the deposit less its fee), so the Review no longer praises a bucket that never reaches the
    chain. Exact output as the default for a public exit — the public figure the bucket, the fee note the rest — is the owner's
    choice (`docs/fee-policy.md`).
85. **V7 — the relayer learns W + f (the sixth review round, 2026-11-03; stated in the threat model).** A withdrawal's public
    amount and its fee note's amount give the typed amount, or the whole note; the refusal text no longer names it, the job
    keeps `feeWei`. Exact-output funding (gap 84) is what closes it; the relayer is honest-but-curious in the threat model (A3).
86. **V7 — two outcomes still wait for good (the sixth review round, 2026-11-03; stated).** A THORChain swap that finalised with
    no outbound planned (a refund smaller than THORChain's outbound fee is consumed) reads "waiting for the destination" after
    the executor's watch, its order open: THORChain's status cannot tell it from an outbound not scheduled yet, and the adapter
    has no clock for the plan. A Send whose answer was lost, whose notes are spent and whose spending call cannot be read here (a
    call through a smart-contract account), or a record from before this round (no call inputs kept), waits as
    RECOVERY_REQUIRED, outcome unknown: the wallet never calls a spend of its pair its own, nor another's, without reading the
    call's public inputs. Both are read again at every scan; neither moves funds.
87. **V7 — a seed-derived payload's key field is a keyed stream (the seventh review round, 2026-11-03; stated).** A dummy output's
    payload now carries the X25519 key of a fresh scalar, so a dummy reads as an envelope. The refund and shield payloads a
    wallet derives from its seed (`0x01` ‖ keccak stream, `packages/sdk/src/keys/swapKeys.ts`) keep the stream there — their
    key field's top bit is set half the time — so such a payload is told apart from an envelope. It appears only in its
    escrow's or receiver's own transactions, which name the order anyway. A key derived from the keyed stream would close it,
    under a construction that keeps the old one for journaled and seed-restored orders (`packages/sdk/test/payload-vectors.test.ts`
    freezes today's); left for the next format revision.
88. **V7 — proofs replay across a chain split (the seventh review round; the core's own revision).** `TX_DOMAIN` is fixed from
    `block.chainid` at construction and `EXECUTION_CHAIN_ID` is compared nowhere: after a fork that changes one side's chain id,
    a `transact` calldata of one fork is valid on the other, spending the same nullifiers there with the same outputs.
    Recomputing the domain when the chain id differs (the EIP-712 cached-separator pattern), or refusing then, needs a new core:
    noted for the pre-audit revision.
89. **V7 — the relayer's fresh review is partial (the seventh review round; stated).** The relayer reviewer's report ended after
    its first finding — anyone could halt the swap executor with an order whose numbers were not of their types — and the
    probes it had written (a Return funds overtaken during a pass, a foreign refund ending the job, a refunded executed job never
    reopened, the refund-token cap, the pass's order). Those are fixed and tested; the rest of the relayer (the shield executor,
    the sender, the journal, the server) had no fresh review in this round.
90. **V7 — the velocity limit fails closed (the seventh review round; a product choice).** With a limit set, a hand-over of the
    trailing 24 h whose asset has no usable price (a feed gone stale, a token without one) holds every campaign's next hand-over
    until a price returns or the limit changes. Single orders count toward the window but are not themselves held by it: the
    contract's §2.4 names the tranches.
91. **V7 — a step that ended undelivered is no longer watched by its campaign (the seventh review round; stated).** A step
    refunded at the destination, delivered in another token or failed at its provider with nothing back ends the campaign's watch
    of it. A refund its provider pays the escrow later stays there until the order's own Return funds — or anyone's
    `deployAndRefund` — returns it; the relayer's late-refund watch has ended by then.
92. **V7 — the native core's note decoder reduces values mod p (the seventh review round; not on a production path).**
    `privacy-core`'s `decode_note` reduces a field above p where the TypeScript decoder keeps the raw value and refuses it at the
    hash; the wallet never decodes a note through the native call. Aligning them is a one-line change for the next core release.
93. **V7 — the relayer trusts the vouch's tip (the eighth review round, 2026-11-03; stated).** The API vouches only for an order
    whose executor tip lies between half of its own price at the commit and the price (`boundedTip`): gap 47's premise holds
    again — the seventh round's hint had let any caller choose a 1-wei tip. The relayer itself still prices no ERC-20 order
    (gap 72's valuer), sends an ETH order below cost in its call's last half hour, and admits a refund-only job on the order's vouch
    alone. An admission floor at today's execution cost, and the last-call rule measured from the order's `executeDeadline`, would
    let it refuse a tip the API valued too generously: left for the relayer's next review, which round 7 did not complete (gap 89).
94. **V7 — the service's storage bounds are per address and global (the eighth review round; stated).** Each caller (its address,
    an IPv6 /48 sixteen times over) may create `COMMITS_PER_MINUTE` operations a minute and the service keeps at most
    `MAX_OPEN_OPERATIONS` not yet ended: many addresses can fill the second, after which every commit answers 503 until rows end
    (an hour past its execution deadline, one never seen funded). A commit is not bound to one of the service's own live quotes,
    and a restore naming another order's id still tells whether this API knows it (409) — once the real row is purged, the restore
    holds the id.
95. **V7 — a protected execution's provider share cap never binds (the eighth review round; stated).** `providerLimit` is
    compared with the in-flight amount per provider, itself capped at 1–2.5 % of the order, so the 30 % concentration control
    of a ≥ $5M order never refuses a step: every campaign runs through one provider. Counting the completed and in-flight
    amount per provider would make it bind. Separately, the competition's normalized line judges a route's exposure on the
    whole order (always in the balanced mode) where the plan judges it per piece, and the risk database's provider class can be
    stricter than the plan's per-route model (Mayan SWIFT): display only.
96. **V7 — what the private spends still allow (the eighth review round; stated).** After a reload a pending funding's notes can
    be chosen by another spend; the funding then reads dead (its notes spent by another call) and its order stops — no note is
    reserved for it. A campaign step's merges, and those of the V5 screen's single orders, are bounded each by the Review's F but
    not in number (their Reviews name no count). The relayer's minimum has no ceiling of its own in `feeTerms`: every spend is
    bounded by its Review or by the daily housekeeping cap, never by the relayer's word alone. A withdrawal's or a transfer's fee
    read again after its merges takes the fresh terms when they are no higher; when they rose, the first read's terms are sent as
    they were — no `fee_moved` after the merges: the relayer takes them, or refuses the spend after the merges were paid (the
    eleventh review round, F11-14).
97. **V7 — Private AI's credit wallet lives in the zkAPI SDK's own store (the eighth review round; stated).** The SDK keeps the
    credit note's secret and blinding, the pending deposit and the funding address unencrypted in its database
    `zkapi-browser-wallet-v1` (per origin), outside the wallet's backup. A Forget removes it and a lock ends the session's key and
    the SDK's funding provider, but the credit cannot be recovered from the phrase: withdraw unused credit before day 30, and
    before a Forget. Binding the store to the seed needs the SDK's own change. The fixed 0.0005 ETH reserve pays a ~1M-gas
    deposit and a ~0.4M-gas close only below ~0.3 gwei; withdrawn credit stays at its fresh address with no way back to the pool
    in the app; the funding index advances at a withdrawal only, so a note that ended otherwise leaves its address current.
98. **V7 — the zkAPI assets the build ships are not pinned (the eighth review round; stated).** `apps/web/zkapi-sdk.pins.json`
    pins the SDK clone, and `apps/web/scripts/check-zkapi-pins.mjs` compares the proving keys and the wasm, not the emitted
    worker (which holds the credit's secrets) nor `sdk-assets.json`. With the current pins Private AI cannot be enabled anyway:
    the pin check requires the `zkapi-v2-note-bound-v1` circuit, the pinned SDK its concession circuit, and both pinned profiles
    are `not_deployed`. Re-pinning the zkAPI pipeline, the worker included, is the owner's step before Private AI is offered. The
    privacy leakage gate does not exercise Private AI.
99. **V7 — the trade check's residual linkage (the eighth review round; stated).** "Check this trade" sends a coarse summary —
    amounts to one significant digit, the route's mode, each provider's answer as a code — from the user's IP under the chat's own
    lease key and headers: the provider can still match a large swap to an escrow funded minutes later by pair, size class and
    time. A separate lease per check, and the check offered before the commit, would narrow it; the Review's hint says so. Since the tenth review round (B10-12) the summary's value is the rounded amount's,
    and it carries no minimum received and no expected loss: four proportional one-digit figures had pinned the amount to a few percent.
100. **V7 — a WalletConnect Protect's approval receipt (the eighth review round; stated; narrowed in the eleventh, F11-10).** A
    WalletConnect provider sends the reads outside its session's namespace to WalletConnect's RPC host, which the policy blocks: an
    ERC-20 Protect's approval receipts are then read from the wallet's first endpoint, which so holds this IP beside the public address
    (without them no ERC-20 could be protected through such a wallet), and an allowance it cannot read is cleared to zero first. Since the
    eleventh round the exception is WalletConnect's provider alone, and only while it has answered no read: any other wallet whose reads
    fail stops at its approval (`approval_unconfirmed`), one that answered before is read on to the time. Since the twelfth round (A12-2)
    WalletConnect's endpoint read is the flow's own loop: a lock or a replace ends it, and a failed read or none in three minutes stops the
    Protect at its approval, nothing deposited (`approval_unconfirmed`); an approval prompt its wallet app did not answer — WalletConnect's
    request expiry, or its session ended while the prompt was open — stops it so as well, in words that say to decline it there
    (`approval_unanswered`). The read follows the approval's own hash only: a speed-up the wallet app makes of it stops the Protect at the
    bound too (viem's wait had followed any replacement, a cancel as well, on to a deposit with no allowance), nothing deposited, and the
    next Protect clears and approves again. The deposit's receipt is never
    read there: the Protect ends "sent — your wallet did not report the result" (`deposit_unconfirmed`; no "needs your attention"
    notification for it); the record awaits its note, which a scan half a minute later — planned past the scheduler's backoff — and then
    each minute for a quarter of an hour (a failed read retried after 1, 2, 4, then 8 minutes — the scan's own count, the twelfth review
    round, W6 §5; past the window a failure is the scheduler's, from its first ten minutes) records from the endpoints' agreed view at once:
    never held for finality, half an hour on mainnet. That is the trust the receipt's fallback to the endpoints had, for that case alone —
    a page closed after its send, or a lock, leaves its note to the proof as before —, at one leaf only and with no note of its counter
    stored; a copy of a note at a second leaf goes once the other stands at a proven leaf, and the proven pool still drops a note it
    contradicts. The record completes from it — without its network cost, which no receipt gave. A second Protect is held back while the
    record reads so, a day at most; with no note and no word from the wallet that sent it a day on, it reads never landed, nothing moved
    (`deposit_never_landed`, the chain's verdict) — and stays so: a deposit that lands after all enters the balance without a line of its
    own.
    After the page is gone only the wallet holding the account the Protect came from (`refs.sender`) is asked about its transaction,
    never the browser's injected wallet in its place. The rescans are pool reads like any scan, started by the deposit: their timing is the
    one signal left. The round's connection notes: without a connection `activeProvider()` falls back to `window.ethereum`; EIP-6963
    announcements are keyed by rdns, the last one winning; the WalletConnect provider defaults to chain 1; the fresh funding
    provider signs any transaction the SDK asks of it.

101. **V7 — a sent transaction's receipt is read by its hash at every endpoint (the ninth review round, 2026-11-04, D-3; stated).**
    A spend the relayer sends, and every receipt the wallet settles, is read back by its transaction hash from every configured endpoint,
    which ties that transaction — and a withdrawal's recipient — to the user's IP at each of them. A funding's spent bits and the stale
    mover's now come from the scan's agreed spend index only, never a per-nullifier read; the receipts' fetch-all replacement (the spend
    index names the transaction that spent a pair; the change note's commitment is among the agreed NoteInserted logs) and a proof against
    the finalized root when every input lies in the proven prefix (the public root otherwise tells an endpoint which view it served) are
    the planned change. The Privacy Center says so.
102. **V7 — payloads are not proven (the ninth review round, D-7; stated).** The light client proves leaves (commitments), not the
    payloads beside them: a quorum (or the only endpoint) that keeps a leaf's commitment and swaps its payload hides a received note — and
    after a phrase restore every note — while every check passes; the restore's counters then resume below the real ones (COUNTER_RESERVE
    past the highest found) and can repeat secrets. Checking each payload against its transact's `noteDataNHash` needs the transaction
    by its hash (gap 101's link) or a receipts-trie proof under the proven header.
103. **V7 — what the window walk and the scheduler still allow (the ninth review round, D-6; stated).** A windowed log read is bounded
    by the span a chain can have (MAX_LOG_SPAN), a count of windows (MAX_LOG_WINDOWS) and its own pace — refused once the windows
    read so far project the rest past MAX_PROJECTED_READ_MS, two hours (the tenth review round, B10-1: the ninth round's fixed ten minutes
    had stopped an honest capped endpoint's every sync for good, each starting again at the pool's first block): one endpoint can still
    hold a sync for up to that long. The scheduler awaits each action
    without a deadline (one that abandoned its wait would run a funding beside the next action). The wallet's own RPC answers are bounded
    (the twelfth review round, C12-2: this gap had said no response had a size cap): by the transport, `RPC_ANSWER_MAX_BYTES` (10 MiB,
    viem's own bound made explicit) — a log read goes alone, and its answer past the bound is refused, never asked again by viem's retry,
    the windowed reader then reading that endpoint in windows (viem's refusal had been no refusal for its size to it, and an uncapped
    endpoint failed every sync once the pool passed some ten thousand events); a batch of the other reads is bounded as a whole —, and
    the light client's own reads by the same bound; so are the relayer's (4 MiB), the swap service's (8 MiB), the beacon APIs' (32 MiB)
    and THORNode's (4 MiB) answers, by their readers (the eleventh review round). What the windows still cost: the endpoints that refused
    a whole history are remembered in memory only, so each page load asks an uncapped endpoint for it once more (up to the bound read
    before the refusal), and a window halved for its size starts again at 10,000 blocks at the next read — a dense stretch costs up to the
    bound per halving at every sync, from every endpoint. Still read without a size bound: the proving artifacts (a stall limit only), the
    prover's and zkAPI's pin manifests, zkAPI's browser configuration, Private AI's model catalog, the inference provider's error and
    streamed answers, and the zkAPI SDK's own reads over the wallet's private transport — its RPC, operator and indexer answers and its
    deployment manifests (a third party's code, read whole within its call timeout). The swap service's own RPC reads (apps/api,
    packages/swap-engine) are outside this gap.
104. **V7 — a provider failure stays "needs attention" (the ninth review round, C-03; stated).** A partial fill whose rest is
    accounted for is finished ("Delivered in part"); a provider whose last word is a failure, with nothing back by the end of the
    executor's watch, leaves its record RECOVERY_REQUIRED `provider_failed` with no action that ends it — the frozen states have no
    terminal "lost at the provider", and FAILED says the funds did not move. Home no longer calls it "still executing".
105. **V7 — one Send at a time, and its bounds (the ninth review round, C-06, C-11; stated).** A Send or withdrawal whose outcome is
    unknown holds the next one back while its notes are not seen spent in the pool's index; one whose relayer cannot be reached is
    settled from the chain alone a day after it last moved (the relayer drops a spend its node does not know after ten minutes and never
    sends it again). A transaction held privately for longer than that, or a relayer back after a day with a send of its own, is the
    residual (n66, gap 42).
106. **V7 — a completed record and a reorg (the ninth review round, C-13; stated).** Swap records are written whole by the record sync
    (now under I-O7 and through the caller's session), not through the reducer's events; a COMPLETED Protect or Send never reopens when a
    reorg drops its transaction for good, while the note store gives its notes back.
107. **V7 — the service's capacity, per caller (the ninth review round, A9-3; stated; extends gap 94).** A restore of an order the API
    holds — with that row's own escrow (the tenth review round, B10-12: an order id is public, and a body naming one with other
    params had run a competition outside the budget) — is never refused by the cap nor charged to the commit budget; a restore of an
    escrow holding its funding is never refused by the cap and is charged to the budget like a commit (this gap had said it was not). No bound counts one
    caller's open operations (it would keep an IP-derived key beside each order); a never-funded commit lives to its execution deadline
    and an hour (a delayed funding needs it); the cap is checked before the competition, so concurrent commits can overshoot it.
108. **V7 — the API's settlement reads (the ninth review round, A9-6, A9-7, A9-12; stated).** A refunded executed job is partial only
    with delivered units the provider names (the API keeps no memory of an earlier read's units, nor the other-token case); a reconcile
    never writes over a later-started one's answer (by its start since the tenth review round, B10-12 — by the row as it was read,
    two overlapping reconciles had kept the older snapshot when it wrote first —, a refused write answering what the row holds) and
    never moves a row back along the execution's three steps; an escrow's own `executed` flag, not
    its code, says it executed. The wallet's reads still win (gap 35).
109. **V7 — the competition's remaining edges (the ninth review round, A9-10, A9-14, A9-15; stated).** The relative rules can still
    knock each other out (one route over the impact cap, one long stream: no route, the commit answers 400); `isOutage` counts a
    provider's 429 and THORChain's wrapped 4xx, never an adapter's refusal; `MAX_CALL_SECONDS` is judged on the wallet's clock.
110. **V7 — Private AI's funding marks and the unnamed merges (the ninth review round, B-F7, B-I1, B-I2, B-I5; stated).** A
    funding is marked as soon as its withdrawal is submitted; a credit note that ends otherwise than by a withdrawal (an expiry claim, an
    archived note) still leaves its address funded, and pool funding then refused until the user withdraws — advancing needs the SDK's
    word that the note will not return. Private AI's pool funding and the address book's test payment name no merges and bound none; a
    connected-wallet Send counts none (each is a public prompt); a delayed one-confirm swap whose notes maintenance split after its
    Review stops at funding as `merges_moved`. A restore's first scan relies on the Gate mounting the shell only after the phrase is
    acknowledged (B-I6), and spent marks from before the fourth review round carry no block and keep the older lift (B-I7).
111. **V7 — Classic: what the history's events and the device still say (the tenth review round, 2026-11-04, C10-6, C10-15; stated).**
    A deposit's timestamp is the source's word: a snapshot's `deposits.json` (re-pinned in its manifest) or a lying logs source can
    move a deposit's time — the tree and the count are verified, the time is not — so "Time passed" and the 24-hour warning can
    mislead; "Subsequent deposits" is sound (the leaf index by continuity, the count by `nextIndex()`). Binding every delta block's
    timestamp to a header the app reads (all of a window's, so nothing singles out the user's) is the planned change. The backup
    file's name carries ten hex digits of the nullifier (the original's eight) and says a Classic deposit was made here; History's
    "Spent" and "Unspent" filters list nothing (its rows carry no facts); two tabs can run two withdrawals of one note (no Web Lock;
    the nullifier bounds them to one payment); Clear history leaves the artifacts' cache, the public history store and the locale
    (the wallet's Forget removes them on a shared origin).
112. **V7 — a WalletConnect session after a reload (the tenth review round, D-3; stated).** WalletConnect 2.26 keeps its session,
    pairing and keychain in its own IndexedDB `WALLET_CONNECT_V2_INDEXED_DB`; a Disconnect and a Forget now delete that database —
    from a page where WalletConnect was loaded, or while another page holds it (a Web Lock), at a later page start where no page holds
    it (the preferences' `pendingWipe`): in the page that loaded it, a Disconnect or a Forget removes its keys through its own storage
    first; while another tab holds it, that tab's session, pairing and keychain stay until that tab closes and the origin is opened again
    (the eleventh review round, A11-3/H11-4 and its critique). A dev build, which does not restart after a Forget, keeps the database
    until the next load.
    The reload check (`hasWalletConnectSession`) reads localStorage, where it keeps nothing, so a session is never taken up at a
    reload: the chip reads not connected until the user connects again, and that tap takes the stored session up with no pairing
    (the provider's `enable()`; the eleventh review round, slice 6c) — a Disconnect then ends it at its relay —, unless this page
    Disconnected WalletConnect, or ended a late approval, before that connection: the deletion kept for the next page start
    (`pendingWipe`) takes the newer session's copy too, so the next tap pairs anew and that session stays live at its relay, listed
    in the wallet app until it ages out. A Forget after a reload with no connection made ends no session at the relay (the wallet
    app lists it until it ages out; the device's copy is gone). Giving WalletConnect a storage the wallet owns (`EthereumProvider.init`'s `storage`) is the planned change.
    A stored session the wallet app has ended meanwhile is taken up all the same (the twelfth review round, B12-7; stated): connected with
    no word from the wallet app — a ping cannot tell a dead session from a phone app that is not running —, and its requests reach nobody
    and expire after fifteen minutes: a deposit's or a self-submitted Send's as `wallet_request_expired`, which holds the next of its kind
    (a Protect for its hour whatever the connection, a Send until the chain's verdict), a token Protect's first approval as
    `approval_unanswered`, nothing deposited and nothing held. Only that approval's words suggest connecting again; a Disconnect, then a
    new pairing, is the way out.
    The page keeps one WalletConnect provider for its life (the twelfth review round, slice 12d3c; the owner's decision of 2026-11-12):
    an end had forgotten the provider and the next tap had made a second sign client over the page's one Core, whose first engine's
    heartbeat (`cleanupOrphanedSubscriptions`) unsubscribed the second's session within seconds — a reconnect in the same page went deaf,
    its requests reaching the wallet app and their answers never the page. An end now deletes the provider's session and keeps the
    provider; the next connection is a new pairing on it, and a late approval's end is a Disconnect's.
    An end whose delete does not complete (B12-3) clears the keys all the same and leaves that session on the provider; nothing pairs
    beside it, and it is deleted again at a WalletConnect tap (the owner's decision of 2026-11-12) or by a later end — a Forget's —, never
    at the browser's `online`; its keys are cleared again whatever that delete's outcome.
    A delete that failed (offline, where the library refuses at once, or its publish expired after a minute) is deleted again by the next
    tap before it pairs: nothing of the tap's is pending yet, so the library's cleanup at that delete, which expires every pairing of the
    Core, takes nothing of the new connection; the tap reads "Connecting…" meanwhile, for at most an end's bound, then a delete again's.
    That delete failing too, the sheet reads "WalletConnect could not end the earlier connection. Check the internet connection and try
    again, or reload the page, then connect again." (its cause under Advanced), the pairing's own sheet offering Reload beside Try again
    and the picker Reload under its words: a later tap deletes it again once online; a reload starts afresh — the page start deletes
    WalletConnect's database —, that session then listed in the wallet app until it ages out. Until it is
    deleted the provider's sign client still holds that session — its topic subscribed, the socket reopened by itself (the library's
    reconnect, its heartbeat while the page is visible, `online`), the wallet app answered on it: a ping writes the history back into
    WalletConnect's store (the account among it), an update or an extension the session itself, both cleared again at the delete; the
    wallet app's own end of it runs the provider's cleanup over the Core, while no new pairing exists (a delete refused after that end
    counts as done — one refused in the moment between the sign client's own deletion and the end of that cleanup, the wallet app's end
    landing within about a round trip of a tap's delete again, reads the failed words once, and the next tap pairs: the critique of 12d3c,
    YQ). The wallet app lists it until it is deleted or ages out; the Privacy Center's "while WalletConnect is connected, its
    own record of the connection" does not hold meanwhile.
    An end past its bound was acknowledged — the wallet app has removed the session, and the library has dropped its topic — but its
    unsubscribe goes unanswered, and the library finishes it only once that answer comes: its cleanup then runs on the provider, and had
    expired a pairing made meanwhile and dropped a session made meanwhile from the provider while the wallet app kept it (the critique of
    slice 12d3c, over the installed library and a local relay). So it is never doubled or paired beside: a tap meanwhile reads
    "Connecting…" for at most the end's bound, then "WalletConnect has not finished ending the earlier connection. Once this device is
    online, reload the page, then connect again." (the page has no offline copy) — the pairing's own sheet offering Reload in place of Try
    again, the picker Reload under its words —, at once for
    every tap after the bound, until that answer comes — never, when it was lost with a socket that dropped
    (the library's unsubscribe has no bound and is never resent; the critique's next round, YO): every WalletConnect tap in that page is
    then refused until a reload, the earlier pairing's topic the only one still subscribed. A reload leaves nothing listed.
    After a Disconnect, a Forget or the wallet app's own end the page's socket to the relay stays open for the page's life (B12-8;
    stated), nothing subscribed once the end is complete: closing it right after an end cut the library's own pairing deletion short — its
    unsubscribe's answer dropped with the socket, the pairing and its key kept in memory and written back at the next pairing (the
    critique of slice 12d3c). The page authenticates to the relay with a key derived from the client seed WalletConnect keeps in its own
    store (the relay sees its public identifier, never the seed): every session from this browser, across reloads and tabs, is one client
    to the relay until that store is deleted (the page start after a Disconnect or a Forget).
113. **V7 — a production build and its NODE_ENV (the tenth review round, D-8; stated).** Every production floor — the scrypt cost,
    the holds, the strict transport, the artifact pins, the development verifier's refusal, the Forget's restart — keys on
    `import.meta.env.PROD`, which Vite takes from `NODE_ENV`: both applications' builds now refuse any other
    (`assertProductionNodeEnv`; the screenshot fixtures excepted). The dist checks carry no production sentinel of their own.
114. **V7 — the wallet at rest's remaining edges (the tenth review round, D-10; stated).** Without Web Locks (an old browser, plain
    http on a LAN host) there is no single-tab rule, and two unlocked tabs write whole journals over each other; the lock is released
    after `FLUSH_WAIT_MS` with writes still queued (r17). The keystore re-wrap raises N only (a lower r or p stays), and
    `VITE_KDF_LOG2N` allows 20 — 1 GiB in noble's scrypt, which a phone may not open. A keystore's sizes are exact in both cores, an
    extra field is refused only by the web's store on write (a backup's keystore is re-wrapped without it at the restore;
    `docs/wallet-formats.md` §2 corrected). The Rust core's derived key, NFKD password and plaintext are not zeroed (native wallets;
    the web uses the TypeScript keystore), and every journal write builds the plaintext JSON once (gap 71's class). A REPLACE asks its
    guard and then spends about a second in scrypt before writing, and an unlock's re-wrap writes the keystore before the tab holds the
    Web Lock — both need two tabs acted in at once.
115. **V7 — the records' remaining edges (the tenth review round, A10-8, A10-9; stated).** `fundedAt`/`fundedTx` are never undone
    by a reorg that drops a funding for good (gap 106's order-side twin); a `jobId` alone counts as funded (a refund-only job of an
    unfunded escrow, a job a relayer names by its order id: "handed over" with nothing in it — no funds effect); a late `submitted`
    write while locked is dropped (C-08), so a Protect sent in that window by the connected wallet fails as `interrupted` past an
    hour before the scan finds its note (an explicit lock during the wallet's prompt); a campaign step whose funding is dead while its
    escrow cannot be read waits without a pause or words.
116. **V7 — the service's remaining notes (the tenth review round, B10-12; stated).** An incident with `halfLifeDays` 0 or below
    is read at the default 365 days (an operator's "no lasting effect" costs about 24 points for a year), a future-dated one costs
    nothing until its date, and duplicates are told apart by provider, date and title only. The spend's fee re-read after merges
    keeps the first read's terms — the relayer's privacy address with them — whenever the re-read fails or its fee is higher (an
    equal or lower one is taken with its address; the eleventh review round, F11-14): a relayer that rotated its fee address and
    raised its fee meanwhile, or could not be read at that moment, gets the fee note at its old one. The credit wallet's revocable provider completes a request
    already handed to the inner provider after a lock and passes its listeners through, and the fresh funding key stays referenced
    from the SDK's singleton until the next Enable (gap 71's class).
117. **V7 — the fresh-address reserve and other wallets (the tenth review round, D-2; the owner's call).** After a restore without
    the whole journal the fresh addresses resume past what the journal knows by the reserve (`ADDRESS_INDEX_RESERVE`, 1,000) and,
    since the eleventh review round (F11-7), a random draw of up to another 999 — two restores of one source part, though not surely:
    about 2n in 1,000 overlap when each hands out n addresses —, so no address the earlier installation handed out is offered again. A wallet that imports the phrase and discovers addresses by a gap limit (BIP-44's
    20, Electrum's and Sparrow's defaults) does not see one past the reserve until its limit is raised — to about 2,000 past the last
    used index per restore —, and an EVM wallet that adds
    accounts one by one needs the account's index; nothing is lost — the paths are standard (`docs/wallet-formats.md` §3) — but a
    user who moves the phrase to another wallet must be told. A smaller reserve keeps that discovery and protects fewer earlier
    addresses; a gap scan the user starts finds the used range at the cost of asking an indexer about every address in it. The
    reserve's size and the words are the owner's call.
118. **V7 — a backup merge brings back what this device removed (the eleventh review round, A11-9; stated).** A merge unions this
    device's journal with the backup's, so an Activity line deleted or an operation record removed here since the backup comes back from
    it — as the replace before the tenth round brought them back. A maintenance action is never revived (a done entry wins the union, and
    since the round a merge brings none back pending), and a revived order, campaign or funding is checked again by its runner and
    cancelled. Tombstones for the user's removals would close it — the owner's call.
119. **V7 — an executed order whose transaction nothing names (the eleventh review round, B11; stated).** An order whose refund came
    back and whose escrow says it executed — the escrow's flag is read only then —, but whose transaction no relayer's job names and
    whose `Executed` event not every endpoint names alike (one failing, timing out or answering otherwise suffices), stays open and is
    read every `ORDER_LATE_TRACK_MS` (ten minutes) with no hand-over hold, until every endpoint names the same transaction; what came
    back is in the protected balance, the rest is where the execution sent it, and the record waits to say so.
120. **V7 — Classic's remaining edges (the eleventh review round, C11; stated).** A record whose page closed before its submission still
    reads "Waiting for receipt"; a retired prover worker waits for its tree requests without a bound. Two syncs may let the second
    endpoint learn a relayed withdrawal's root before it is on chain: the retry's after a refusal of an aged root, and the one after an
    unsettled flow's hold. The records' hold is bounded by a record's last write — a confirmation left open past 15 minutes no longer holds
    the other tabs, a relayer answering a job not mined keeps the pool held while History asks it every 15 minutes — and a withdrawal
    abandoned before its submission holds the other pages 15 minutes; during a hold a note deposited after the history's block reads "check
    again shortly"; an open relayed record keeps its digest until it is completed or History is cleared; earlier rounds' refusals still
    reach a Korean reader in English. Within an unsettled flow's 15-minute hold, a new relayed attempt on the same pool after an
    aged-root refusal cannot sync first and is refused again until the hold ends (the sync waits for the hold; C10-14's retry starts
    once it has ended); the re-check timer restarts whenever the services change, and an idle page with no note on screen never
    re-checks; one device's records do not hold another device's pages.
121. **V7 — the screens' remaining edges (the eleventh review round, E11; stated).** Home reads its clock at render; the 25-minute bound
    of a guest order assumes the API's clock and the device's agree; a status the API adds later reads Pending on /guest; an Advanced
    reader sees "<words> (<raw text>)"; a Max filled before the balance changed is taken as filled until edited (the wallet's prompt still
    judges the fee); Tornado Classic's own records are not named in the Privacy Center's stored-data note (Forget's dialog names them); the
    engine read a native non-EVM asset's units as wei when it priced a tip, which only a guest quote reached and which no longer prices
    one; the Privacy Center's "Why?" lines (its Advanced categories) keep their technical words.
122. **V7 — a WalletConnect pairing approved in the instant a retry begins (the eleventh review round, slice 6c; stated).** A pairing
    approved after its Cancel is ended at its relay — except while a WalletConnect connection is being made again on the same provider:
    ending it there would end the retry's pairing too (`provider.disconnect()` cleans up the pending pairings). The installed library's
    retry unsubscribes the earlier pairing as it starts, so only an approval already on its way reaches this branch; its session then
    stays live at the relay once the retry connects (the provider holds the newer one, which a Disconnect ends), or is taken up by the
    next tap if the retry is cancelled. Ending a session by its topic through the sign client would close it — the library's internals,
    not taken.

Running the stack on a workstation (browser + chain), in the order that exercises every flow: `docs/local-run.md`.

## 5. Threat model and trust assumptions
`docs/threat-model.md` (what V1 trusts, what it explicitly does not, the three-layer boundary of
V1.1 with the compromise table). The one sentence version: the money core trusts the circuit, the
verifier and Poseidon2 and nothing else; every provider, relayer, RPC, zkAPI server and the wallet UI
can be malicious without touching shielded funds, and the tests in §3 try to prove that.

## 6. Questions for the auditors
1. Circuit: any public-input or constraint that lets a prover reuse a nullifier, spend a note it
   does not own, or create value — especially around the two-input / three-output boundary and the
   root freshness assumption (`docs/protocol-spec-v1.0.md` §9).
2. Contracts: any sequence of external calls (vault release, escrow execute/refund, token hooks in
   the "token zoo") that re-enters or desynchronises vault accounting from the tree.
3. Periphery: can a relayer, provider or factory caller ever make an escrow forward funds to an
   address or with calldata the order key did not sign? Can `refund` be front-run to a different note?
   Can `refundToken` move the order's asset, reach a vault outside the refund vault's pool, or be
   turned against the escrow by a token's own code (it runs inside approve and the vault's pull)?
   For an order in a token it unwraps WETH and deposits the escrow's whole ETH balance into the pool's
   native vault: can that ETH reach anything but the committed note?
   Executor economics (PP-S12): after execution no tip pays for a re-shield. Is there still a way to make
   the executor spend gas beyond its budget of three per order, or below an asset's floor (dust, a token
   with no vault, a later request lowering a floor)?
4. Engine and wallet: is anything the order key signs still taken on trust from a provider API or
   the swap service after the checks in `docs/test-matrix.md` (both §74 tables)? In particular the
   decoders in `packages/sdk/src/providerCall.ts` against the deployed provider contracts, and
   `packages/swap-engine/src/adapters/acrossSwap.ts`: is anything in a swapAndBridge call or its
   MulticallHandler message able to move the swapped or bridged tokens elsewhere (the exchange stays
   opaque; since 2026-10-16 the swap's floor must cover the deposit's output in the asset delivered)? And a Mayan SWIFT
   order (`src/adapters/mayan.ts`, Swift V2): with the escrow as trader, can its cancellation refund
   reach anyone else, or can the destination pay less than the order's `minAmountOut` (the
   destination-side fulfilment contract is not pinned here; the order hash binds the parameters)?
5. Light client (`packages/sdk/src/lightclient/`): the update validation against consensus-specs
   (participation threshold 2/3, period rules, generalized indices per format, the Gloas execution
   block hash being the bid's parent hash), the trust-on-first-use bootstrap cross-check, and the
   12-period limit on resuming a saved store.
6. Key derivation: domain separation between spend / view / note / order keys and the refund note
   secrets (`packages/protocol/src/keys.ts`, `packages/sdk/src/keys/swapKeys.ts`).

## 7. Deliverables expected from the engagement
Findings with severity and reproduction; a fix-review round; a statement on the ceremony requirements;
a public report that can be linked from `README.md`. Fix commits will reference finding ids.
