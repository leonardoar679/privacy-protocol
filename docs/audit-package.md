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
| the fifth review round (2026-11-03, the core contracts and the circuit, the wallet at rest, the Classic prover and history, the money path): `contracts/src/core/{PrivacyCore,CoreTypes}.sol`, `contracts/src/vault/{ERC20AssetVault,NativeAssetVault}.sol`, `contracts/script/Deploy.s.sol`, `contracts/scripts/export-abi.mjs`, `packages/contracts/src/deployments.ts`, `packages/protocol-types/src/deployment.ts`, `packages/protocol/src/txInputs.ts`, `packages/sdk/src/{deploymentGuard,secondFactor,swapFunding}.ts`, `packages/sdk/src/wallet/{keystore,session,notes}.ts`, `packages/sdk/src/keys/chainKeys.ts`, `apps/web/src/platform/forget.ts`, `apps/web/src/storage/guard.ts`, `apps/web/src/features/more/Security.tsx`, `classic/src/prover/{worker,engine,protocol}.ts`, `classic/src/app/services/{history,flows,source}.ts`, `classic/src/history/sync.ts`, `classic/scripts/vendor.mjs`, `apps/relayer/src/swapExecutor.ts`, `apps/api/src/{store,reads}.ts`, `apps/api/src/routes/swap.ts` | the core refuses a withdrawal to address(0), the vault or itself (`InvalidRecipient`), the ERC-20 payout reads a 32-byte answer as a word (non-zero = paid; a word that is neither 0 nor 1 had reverted the whole transact after a valid proof), the ETH payout hands its recipient 100,000 gas at most (a receive() burning all of it had reverted the relayer's transact at a tight limit); the deploy script pins the ceremony verifier by `INNER_VERIFIER_CODEHASH` and refuses the development one off a devnet, and the wallet's deployment check reads the inner verifier (its code hash in the fingerprint; the development key a problem in a production build) and the tree's depth; the plan check refuses a zero withdrawal and a non-address; a restored backup's keystore is wrapped again at the build's scrypt cost (so is a weaker one at the unlock), the counters are held at every unlock until the scan after it and a stale journal applies the reserve, Forget clears everything of the wallet's under the origin, the chain-key cache is zeroed at the lock, the keystore's shape is exact; the Classic tree's path must fold to its root or the tree is rebuilt from the deposits, a window the chain keeps moving under is redone three times then refused, a wallet-mode send asks a second endpoint, the prover is closed after a terminal record and its sub-workers zero their scratch, the witness failure phrase covers the calculator's own refusals only, the precompiled templates are pinned; the executor's last call sends an execution below the tip in the window's last half hour rather than into a costlier refund, every listed refund token needs a floor, the API's restore and resume write the blob only while nothing is finalized, and the relayer's answers are read in the shapes the API acts on | `contracts/test/adversarial/Adversarial.t.sol`, `contracts/test/vault/ERC20Accounting.t.sol`, `packages/contracts/test/deployment-inner.test.ts`, `packages/protocol/test/txInputs.test.ts`, `packages/sdk/test/{keystore-rewrap,counter-floor,chain-keys-lock}.test.ts`, `apps/web/test/{forget,storage,keystore}.test.ts`, `classic/test/{services,history,flows,vendored,prover}.test.ts`, `apps/relayer/test/{swapExecutor,executorMore}.test.ts`, `apps/api/test/{store-blob,reads}.test.ts` |
| the sixth review round (2026-11-03, the release gates, linkability, the settlement tracking, the operation machine): `scripts/{verify-all,audit,dependency-review,check-lockfile}.mjs`, `scripts/audit-allowlist.json`, `apps/web/scripts/{zkapi-sdk-pins-lib,pin-zkapi-sdk,check-zkapi-sdk,boundary,check-artifact-pins,artifact-pins-lib}.mjs`, `apps/web/zkapi-sdk.pins.json`, `apps/web/vite.config.ts`, `classic/scripts/{boundary,csp,relayers}.mjs`, `classic/vite.config.ts`, `tests/visual/run.mjs`, `.npmrc`, `.nvmrc`, `classic/.npmrc`, `packages/sdk/src/chain.ts`, `packages/sdk/src/wallet/{spends,privacyTiming,campaignRunner,orderRunner,session}.ts`, `packages/sdk/src/privateTx.ts`, `packages/sdk/src/operations/{stale,reducer}.ts`, `packages/sdk/src/operations/errors/codes.ts`, `packages/sdk/src/keys/chainKeys.ts`, `packages/sdk/src/{orderTracker,swapFunding,assets}.ts`, `packages/protocol/src/wallet/{settlement,privacyLint}.ts`, `packages/swap-engine/src/adapters/{mayan,across,thorchain}.ts`, `apps/api/src/{reconcile,reads}.ts`, `apps/relayer/src/relayer.ts`, `apps/web/src/features/{swap/SwapScreen,swap/Swap,send/SendScreen,wallet/Receive}.tsx`, `apps/web/src/app/Background.tsx`, `apps/web/src/hooks/index.ts` | the zkAPI SDK clone is pinned by commit and file hash and the build refuses another; every module Vite resolves is held to the application's trees (the Classic app's never); the tool directories' lockfiles and dependency reviews are gated, an audit acceptance names its advisory and path, CI must get an answer from the registry, a pin file that changed since the base fails where the artifacts are not; the Classic production policy carries no development relayer and no host without a public suffix; the visual harness fails on a baseline without a fixture; install scripts are off and Node 24 pinned. The scan reads the pool's spend events fetch-all with the note events (one filter per window, every endpoint agreeing on both) and takes the spent bits from them — no per-nullifier `isNullifierSpent` read names this wallet's notes to an endpoint; the stale mover's spent bits and the transaction that spent a record's pair come from the same index (a Send whose relayer answer was lost completes from it — only when that transaction's call carries the public inputs the record kept at its submission: two Sends of one note share the nullifier pair, and another operation's spend fails the record as `spent_elsewhere`); a Protect's receipt is read through the connected wallet's own provider. A lock after a send is `locked_after_send` (funds unknown), and the reducer turns any not-moved failure of a sent record into RECOVERY_REQUIRED unless the chain's own verdict; a campaign gives up a dead funding with the flag and tries a passing signing failure at the next tick five times before the backoff; the journal is read again before a hand-over; a runner's tick writes only into the journal it began with (`WalletSession.pinned`). A refund paid at the destination (Mayan Fast-MCTP) is final (`REFUNDED_AT_DESTINATION`), a provider failure with nothing back by the end of the watch ends the order with its reason (`PROVIDER_FAILED`, `provider_failed`), an unread escrow after the watch settles nothing, the API's reconcile mirrors the three; Across lists the LP fee once; THORChain's prepare refuses a halted destination; a sent funding reads dead after an hour. A delayed order's window is the delay plus the one-confirm window (the escrow's deadline encodes the planned funding, not the commit); the amount fact is judged on what leaves and a whole-note exit is named; the relayer's refusal names no amount; the timing fact is floored by the wallet's own last Protect (older notes cannot hide it); Receive never shows an address something used; the campaign's requote and the Advanced swap's indicative quote carry no destination |
| the seventh review round (2026-11-03, the relayer, the cryptography, the campaign engine, the figures): `apps/relayer/src/swapExecutor.ts` (`checkOrder`'s types, each job's tick in its own try/catch, urgent jobs first, a foreign refund, `paramsKey`), `apps/api/src/routes/swap.ts` (the types, the tip hint), `packages/protocol/src/{envelope,address,poseidon2}.ts` and `privacy-core/privacy-core/src/{encoding/envelope,encoding/address,wallet/keystore}.rs` (the dummy's key, the canonical view key, the field, the keystore's sizes), `packages/sdk/src/chain.ts` (the read boundary), `packages/protocol/src/wallet/campaign.ts` (`undelivered`, `ended`, `kept`, `holdUntil`, the re-plan's question, `maxExecutorTip`, the refund of a failed step), `packages/sdk/src/wallet/{campaigns,campaignRunner}.ts` (`protectionOf`, `routeRules`, `withRoute`, the destination read at every commit, the velocity window), `packages/sdk/src/orderTracker.ts`, `packages/sdk/src/swapExecute.ts` (`shownTip`), `apps/web/src/features/{review,swap,send,protect}/*`, `classic/src/app/App.tsx` | a poisoned order never stops the executor; a dummy output is an envelope to an observer; nothing outside the field is hashed or read from the chain; a campaign never commits before its hold or to a destination the book refuses, never runs looser than the wallet's model of its route, never reports undelivered value as completed nor swaps a returned step again without asking; the velocity limit is the wallet's and fails closed; every Review states what leaves and every fee |
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
    enabled and the tab is hidden (generic text by default).
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
    - the RPC endpoint the wallet asks about spent status learns each found note's nullifier (open: audit c19/c38);
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
    run drives Chrome under mobile emulation; the eleven scenarios of §2 there need iOS Safari, Android Chrome and the
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
60. **V7 — WalletConnect's modal is third-party code under the policy.** With a project id the bundle ships
    `@walletconnect/ethereum-provider` and its modal, which ask `api.web3modal.org` for the wallet list and logos and load the
    verify iframe; the policy names those hosts and no telemetry host, and the metadata declares this origin's icon and
    `redirect`. The project id, the modal's own privacy terms and whether to ship the connector at all are the owner's
    (spec v2.0 §23's WalletConnect note stands).
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
    Timing category reads Reduced and the badge — the lowest category — reads "Low protection" for every wallet. The words are
    true; whether the overall level should be the lowest category, or weight timing differently, or offer the delay as a
    setting, is the owner's product decision.
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
    the wallet's under the origin goes (`apps/web/src/platform/forget.ts`), but before one: the preferences hold the backup
    dates and the last connector in the clear, the backup download is named `privacy-wallet-backup-<date>.json` in the
    Downloads folder, and the artifacts' cache says a private spend was proved here. In memory, the 24-word phrase string the
    chain keys are derived from (`@scure/bip39` takes a string) lingers until the collector and memory reuse — the one copy
    of the seed's material the lock cannot zero. A generic filename and a byte-based mnemonic derivation would close the two
    that can be closed.

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
    more endpoints a wallet-mode send asks the second about the root and the spent bit; with one, a lying endpoint can have the
    user's own `withdraw` revert on `isKnownRoot` (some 300,000 gas) and publish the nullifier hash beside the recipient before any
    withdrawal — the deposit itself is never at risk. The relayer route refuses such a job for free. Configuring two endpoints is
    the deployment's choice (`VITE_CLASSIC_RPC_URLS`).
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
    events read fetch-all with the note events — and a Protect's receipt is read through the connected wallet's own provider.
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
82. **V7 — LI.FI → Mayan routes are not pinned at quote time (the sixth review round, 2026-11-03; Fastest policy only).** The
    engine checks the refund recipient and the minimum of a Mayan facet call, not `mayanProtocol` nor the order inside
    `protocolData`; the wallet decodes both at signing and refuses a trader other than the escrow or a Fast-MCTP refund at the
    destination — after the escrow was funded, which then waits for its refund. The route is `minOutVerified: false`, so only
    the Fastest policy lets it through. Mirroring the wallet's decoding in `verifyLifiTransaction` would close it.
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
    read again after its merges is bounded by the first read's, so one that rose past it still fails after the merges were paid,
    as `fee_moved`.
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
    time. A separate lease per check, and the check offered before the commit, would narrow it; the Review's hint says so.
100. **V7 — a WalletConnect Protect's receipt (the eighth review round; stated).** A WalletConnect provider sends the reads outside
    its session's namespace to WalletConnect's RPC host, which the policy blocks: a Protect's receipt is then read from the
    wallet's own endpoints (the link gap 80 removed for injected wallets), and an allowance it cannot read is cleared to zero
    first. The round's connection notes: without a connection `activeProvider()` falls back to `window.ethereum`; EIP-6963
    announcements are keyed by rdns, the last one winning; the WalletConnect provider defaults to chain 1; the fresh funding
    provider signs any transaction the SDK asks of it.

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
