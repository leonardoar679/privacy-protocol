# Audit package — plan step 20 (independent audits)

Status (2026-10-06): **package assembled; no engagement started.** This document is what an external
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
| `apps/web/src/wallet/{keystore,journal,session,storage}.ts`, `docs/wallet-formats.md` | the at-rest formats: scrypt parameters and their floor, XChaCha20-Poly1305 use (nonce handling, AAD), the seed-derived journal key, what a backup file reveals (nothing in the clear), TC-01 (no raw secret in dapp-origin storage), the recovery phrase = seed entropy |
| `packages/protocol/src/wallet/chainKeys.ts`, `privacy-core/privacy-core/src/chainkeys.rs` | BIP-32 / BIP-44 / BIP-84 / SLIP-0010 correctness beyond the pinned vectors; per-dApp index derivation (§37); address encoders (bech32 v0, base58, EIP-55) |
| `apps/web/src/sdk/chain.ts` (RPC quorum) | can a single endpoint still mislead the wallet (reads compared: root, size, event digest); what one endpoint learns (fetch-all reads only) |
| `privacy-core/privacy-core` + `privacy-core-wasm` | equivalence with the circuit / contracts / TypeScript beyond the vectors (differential fuzzing is the suggested method); constant-time properties of the scalar / field code paths that touch secrets; the WASM surface takes caller randomness only |
| `packages/swap-engine` `/guest/*`, `apps/web/src/components/Guest.tsx`, `apps/web/src/sdk/guestGuard.ts` | the walletless path: the deposit address comes only from the THORNode gateway quorum, and the browser re-checks it and the memo (destination, asset, OP_RETURN size, minimum) before showing them; nothing identifying leaves the client except the destination |
| `apps/web/src/sdk/providerCall.ts`, `swapGuard.ts`, `swapSign.ts` | the wallet's own reading of the provider call before the one-time key signs: the pinned contracts, each decoder against the deployed provider contracts (THORChain router, Chainflip Vault, Across SpokePool, Mayan forwarder + Fast-MCTP, LI.FI AcrossFacetV4 / MayanFacet), the minimum and the consent flow |
| **V2** `packages/protocol/src/wallet/{valuation,privacyLint,destinations,noteStrategy,privacyCenter}.ts`, `apps/web/src/sdk/{prices,simulate,tiers,secondFactor,orderTracker,poolDeposits}.ts`, `apps/web/src/wallet/{housekeeping,lintFacts}.ts`, `apps/web/src/zkapi/tradeCheck.ts` | the whale execution layer (`docs/whale-execution-spec-v1.0.md`): the Chainlink reads through the RPC quorum and the fail-safe (can a lying endpoint or feed lower a tier?), the pre-trade simulation's revert decoding and the second call from the escrow, the WebAuthn gate (it verifies the user, not a signature — is that enough for its role?), the lint's categories against the privacy factors, the destination parsers (bech32 / bech32m / base58check / EIP-55 / base58), the tracker's state derivation, the housekeeping planner (fee accounting, note-count bounds, the observer's clustering caveat in `docs/privacy-lab.md`), the trade-check sanitizer (address shapes) |
| **V2** `packages/swap-engine/src/{scoring,health,engine,valuation,placeholders,gateway}.ts`, `adapters/{thorchain,chainflip,mayan}.ts` | the five policies and the tier override, the impact / limit / stream filters, the competition record and the per-adapter budget, the breaker, the price guard at `/prepare`, the placeholders at phase 1, the streaming memo (`LIMIT` per sub-swap), Chainflip `dcaParams` equality, Mayan swap & lock (the USDC vault requirement), the gateway's key handling |
| **V3** `packages/protocol/src/wallet/{campaign,riskClasses,addressBook}.ts`, `apps/web/src/wallet/{campaigns,campaignRunner,addressBook,alerts,notifications}.ts`, `apps/web/src/sdk/{swapExecute,allowances}.ts`, `apps/web/src/components/protection/*` | the high-value protection layer (`docs/high-value-protection-spec-v1.0.md`): the tranche splitter and the exposure invariants I1–I5, the settlement gate with the elapsed-time margin (no explorer), the reducer's one action per tick, the runner's reconcile before every money movement (never a second funding or hand-over), the bounds one confirmation binds, the address book's verification methods and the Immediate override, the separate cross-platform device with no password fallback, what the trade check sends |
| **V3** `packages/swap-engine/src/risk/{riskDb,security,protection}.ts`, `packages/swap-engine/risk/`, `packages/swap-engine/src/health.ts`, `apps/relayer/src/admin.ts` | the risk database's validation, the security breakdown's adjustments and the incident decay, the breaker's new triggers and the half-open probe, the recommendation's band / cap / gate / ELPF / concentration (advice the wallet re-derives), the execution window clamp, the job list's token |
| `apps/web/src/sdk/lightclient/`, `apps/web/src/sdk/verifiedReads.ts` | the Ethereum light client: SSZ roots and generalized indices per data format (Electra/Fulu, Gloas), update validation and committee rotation against consensus-specs, the BLS ciphersuite, the trust-on-first-use bootstrap and the snapshot age limit, the execution header field list, the Merkle-Patricia walk (inclusion and exclusion), and the pool check (prefix root, nullifier slots) |
| **V5** `apps/web/src/{storage,api}`, `apps/web/src/features/{operations,fees,privacy-center/status.ts}`, `apps/web/src/prover/pins.ts`, `apps/web/scripts/{csp,artifact-pins-lib}.mjs`, `apps/web/src/app/i18n`, `packages/protocol/src/wallet/fees.ts`, `packages/protocol/src/classic/note.ts`, `apps/relayer/src/relayer.ts` (the percentage fee) | the secure store over IndexedDB (the same ciphertext; the migration's equal read-back rule; the prefs schema that holds no secret); the transport policy (credentials omitted, redirects refused, the host allow-list, every request through one module); the fee rule and where the relayer can enforce it (gap 25); the operation state machine's invariants I-O1–I-O5 and the error catalog's funds classes; the pin check in the prover worker; the content security policy's construction from the environment; what the leakage gate reads and what it cannot see; the Privacy Center's facts (computed, never asserted); the classic note format and the module boundary |

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
| contracts (forge) | 107: 47 mock-based incl. 5 fuzz invariants, token zoo, no-privilege bytecode scan, the pool's storage slots; Poseidon2 KAT 5; real verifier 8; **real-proof e2e 10** (incl. note → escrow → provider, escrow → refund note → spent); swap periphery 32 (incl. USDT-like orders, `refundToken`, WETH and ETH paid back to a USDC order re-shielded as ETH); **native-prover proofs 5** (proofs from `privacy-core/privacy-prover` on the same verifier) | `FOUNDRY_OFFLINE=true forge test --use $SOLC` |
| circuits | KAT 18, soundness 17 (negative witnesses), Groth16 harness 14 | `circuits/README.md` |
| reference | TypeScript 72 (vitest, incl. 9 WASM-vs-TypeScript), Python 31 (vectors); five implementations agree on every primitive | `npm test` in `packages/protocol`, `python reference/python/test_vectors.py` |
| Rust core + native prover + FFI | 11 Python tests over the generated UniFFI bindings (`privacy-core/privacy-ffi`), 14 vector suites (`privacy-core/privacy-core`), 12 prover tests (`privacy-core/privacy-prover`: a witness proving another statement refused, the native witness == snarkjs' and the soundness manifest's verdicts, the zkey parses to the published key, native ⇄ snarkjs proofs verified both ways), wasm32 build | `cargo test` in `privacy-core` (after `node privacy-core/scripts/gen-prover-fixtures.mjs`), `node privacy-core/scripts/ffi-bindings.mjs` |
| wallet | 154 vitest + 6 live (the light client: sync committees, BLS, Gloas/Fulu formats, header by hash, storage proofs, the pool check before every transaction; a refused or cancelled order returned by a refund-only job; the walletless deposit instruction checked in the browser; the Swap screen clicked through against the real engine; the swap-service guard: escrow recomputation == forge vector, order and signature checks; the provider call read before signing — pinned contracts, receiver, refunds, approved minimum — against the service adapters' own encoders and the THORNode quorum; keystore / journal, chain keys, RPC quorum, first launch without a request, the Rust core path vs the TypeScript path, ERC-20 + relayer failover, planning, merges) + build | `cd apps/web && npm test && npm run build` |
| private-swap engine | 149 vitest: 43 offline (state machine, scoring, privacy score incl. the cross-chain link composition, endpoint == forge vector, signature recovery, restore, the escrow call per ingress and asset, what an escrow can re-shield), 106 live: 26 adapter quotes (incl. the Uniswap-Across leg to USDC and to native ETH, Mayan SWIFT orders), **68 adversarial** (plan §71/§74: outage, refusal, tampered calldata/quotes per provider, status mapping, a source swap into a token the escrow cannot re-shield, the Across Swap API bent eight ways, the Mayan SWIFT quote bent eleven ways), 4 flow (§72, incl. USDC-sourced orders), 2 guest deposit, 6 wallet-check (the wallet's own decoder on every call the engine prepares, incl. the swap leg) — `docs/test-matrix.md` | `npm test` (network) |
| privacy | lab (`benchmarks/privacy/results.json`), cross-chain lab (`benchmarks/privacy/crosschain.json`) | `docs/privacy-lab.md` |
| relayer | 38 vitest: private submission vs the forge e2e transaction, ERC-20 fee vaults, swap executor vs the periphery vector (incl. refund-only jobs, WETH and foreign-token refunds, ETH at an ERC-20 order's escrow, the late-refund watch and its budget and floors), journals, limits | `cd apps/relayer && npm test` |
| **everything** | `node scripts/verify-all.mjs --forge <solc-0.8.24> --rust` (add `--live` for the provider suites) — 13/13 steps here, incl. `tsc --noEmit` for the swap engine and the relayer, the Rust core, the native prover, the UniFFI bindings and the WASM package | |

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
   §74 damage bound; THORChain's gateway quorum (2 of 3) runs over three independent public gateways (Liquify, cosmos.directory, THORWallet; Nine Realms' host stopped resolving in 2026-10 and was replaced). The wallet re-checks every provider call itself before signing (`apps/web/src/sdk/providerCall.ts`) with pinned contracts — a provider upgrade (e.g. a new THORChain router, `VITE_THORCHAIN_ROUTER`) makes the wallet refuse until its pins are updated. Found and fixed on 2026-10-07: THORChain memos had no refund address (a refund would have paid the relayer), LI.FI's AcrossFacetV4 output was read from a word the facet overwrites from `outputAmountMultiplier`, and LI.FI's MayanFacet sweep recipient was unchecked. On the same day the escrow learned to unwrap WETH: Across refunds an unfilled ETH deposit to the escrow as WETH, which `refund()` could not re-shield (the factory now carries `WRAPPED_NATIVE`, the escrow creation code changed, the e2e real-proof fixture was regenerated).
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
    mocked prover (the proof itself is public data); the locale catalogs beside English are partial (the shell and the first
    screens) and fall back key by key.

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
   decoders in `apps/web/src/sdk/providerCall.ts` against the deployed provider contracts, and
   `packages/swap-engine/src/adapters/acrossSwap.ts`: is anything in a swapAndBridge call or its
   MulticallHandler message able to move the swapped or bridged tokens elsewhere? And a Mayan SWIFT
   order (`src/adapters/mayan.ts`, Swift V2): with the escrow as trader, can its cancellation refund
   reach anyone else, or can the destination pay less than the order's `minAmountOut` (the
   destination-side fulfilment contract is not pinned here; the order hash binds the parameters)?
5. Light client (`apps/web/src/sdk/lightclient/`): the update validation against consensus-specs
   (participation threshold 2/3, period rules, generalized indices per format, the Gloas execution
   block hash being the bid's parent hash), the trust-on-first-use bootstrap cross-check, and the
   12-period limit on resuming a saved store.
6. Key derivation: domain separation between spend / view / note / order keys and the refund note
   secrets (`packages/protocol/src/keys.ts`, `apps/web/src/keys/swapKeys.ts`).

## 7. Deliverables expected from the engagement
Findings with severity and reproduction; a fix-review round; a statement on the ceremony requirements;
a public report that can be linked from `README.md`. Fix commits will reference finding ids.
