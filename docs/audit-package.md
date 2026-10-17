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
   §74 damage bound; THORChain's gateway quorum (2 of 3) runs over three independent public gateways (Liquify, cosmos.directory, THORWallet; Nine Realms' host stopped resolving in 2026-10 and was replaced). The wallet re-checks every provider call itself before signing (`packages/sdk/src/providerCall.ts`) with pinned contracts — a provider upgrade (e.g. a new THORChain router, `VITE_THORCHAIN_ROUTER`) makes the wallet refuse until its pins are updated. Found and fixed on 2026-10-07: THORChain memos had no refund address (a refund would have paid the relayer), LI.FI's AcrossFacetV4 output was read from a word the facet overwrites from `outputAmountMultiplier`, and LI.FI's MayanFacet sweep recipient was unchecked. On the same day the escrow learned to unwrap WETH: Across refunds an unfilled ETH deposit to the escrow as WETH, which `refund()` could not re-shield (the factory now carries `WRAPPED_NATIVE`, the escrow creation code changed, the e2e real-proof fixture was regenerated). Found and fixed on 2026-10-16: the Across swap leg took the deposit's `outputAmount` as the minimum while the swap before it was bounded only by a non-zero `minExpectedInputTokenAmount` (an exchange the call names could keep the order and leave a deposit nobody fills, refunded at the floor), and LI.FI's AcrossFacetV4 swap variant let an inflated `outputAmountMultiplier` over one unit of `minAmount` read as any minimum. Both decoders now count the swap's floor in the asset delivered (WETH for ETH, one dollar stablecoin for another) and require it to cover the minimum. On the same day: Mayan Fast-MCTP orders carried the API's gas drop, fees and deadline unbounded (the verified FastMCTP pays `refundFee` to whoever calls refund, which for a USDC output is how the order delivers); they are now bounded as SWIFT orders are, in both decoders.
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
    more than its tip, and refunds a never-executed order only from a balance that pays its tip (the escrow pays none below it). Small orders are refused when the gas exceeds the escrow's 1 % cap (`amount_too_small`).
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
    calls `shield()` only; `shieldToken` and `sweepUnsupported` are left to anyone. A receipt registers with the relayer in
    the hand-over tick, before finalize: a journal lost before that point can recover the delivery only with its
    `receiptId` (the seed re-derives the note's payload by counter).
37. **V6 — ProtectRouter, ShieldReceiver and ShieldReceiverFactory are new and unaudited.** They are periphery
    (replaceable: the core and the vaults do not know them), with no privileged path (NoPrivilege) and forge suites of their
    own (`contracts/test/periphery/ProtectRouter.t.sol`, `ShieldReceiver.t.sol`), fuzzed accounting and vectors shared with
    the TypeScript; their gas is pinned in `contracts/test/periphery/vectors/gas.json`. They are part of this engagement's scope (§1.2).
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
