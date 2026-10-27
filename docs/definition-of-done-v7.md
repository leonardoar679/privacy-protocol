# Definition of Done — V7 (doc §14)

The owner's document ("Privacy Wallet Web V1.1 — Master Development Plan", §1–§15, 2026-10-26) ends on a progress and
acceptance checklist of 21 tracker items (§14). This page maps every item to the evidence that it holds in this
repository — a test, a verify-all step, a local-stack report, a reviewed screenshot, a section of the spec, a document —
and gives its status. The normative text behind each item is [`docs/privacy-wallet-web-spec-v3.0.md`](privacy-wallet-web-spec-v3.0.md)
(which supersedes v2.0 where it says so and leans on it everywhere else); the pass that built it is the V7 table of
[`docs/roadmap.md`](roadmap.md) (Stages 0–17). The V6 product underneath keeps its own page,
[`docs/definition-of-done-v6.md`](definition-of-done-v6.md).

Status: **✅** done and evidenced here · **⚠** done, with a limit stated in [`docs/audit-package.md`](audit-package.md) §4
(the gap's number) · **⏳** the owner's, outside this repository (a person, an auditor, a lawyer, a device, a ceremony).

How the evidence runs:
- **verify-all** — `node scripts/verify-all.mjs --rust --forge <solc-0.8.24> --browser --live` runs every suite, the
  lint, the gates, the builds with their budgets and bundle scans, forge, the Rust core and both screenshot harnesses;
  the Classic application has its own steps (lockfile, typecheck, lint with the word policy, tests, build, dist, budget,
  pins, visual). Its steps are named below in quotes.
- **the harnesses** — `tests/visual/run.mjs` renders every fixture of the wallet at 390×844, 430×932, 768×1024 and
  1440×900 against the reviewed baselines (`tests/visual/baselines/win32`), checks the layout at the ten sizes and runs
  the acceptance and accessibility checks; `classic/tests/visual/run.mjs` does the same for the Classic screens
  (`classic/tests/visual/baselines/win32`) under the Classic word policy.
- **the local stack** — `scripts/local-stack/e2e.mjs` clicks the flows in a real browser against a Hardhat devnet (chain
  id 1), the API, the relayer, live provider quotes, and — V7 — Tornado Classic's mainnet contracts placed at their
  mainnet addresses with a relayer stand-in (sections 11, 11b, 11c). A **full run** is one without `SKIP_CAMPAIGN`: its
  report carries the $10M campaign's "step 1 funded, signed and handed over by the runner" check; a quick pass skips that
  section. The V7 reports are `scripts/local-stack/results/report-2026-10-27-v7-stage10.json` (the first with the Classic
  sections), `report-2026-10-27-v7-stage15.json` (the first full run since Stage 12 — it found the step fee bound, §7
  below) and the final `report-2026-10-27-v7.json`.
- **the Classic correctness ladder** (spec v3.0 §7.10) — the vendored-file hashes → the note and tree vectors → a proof
  verified offline (snarkjs 0.7.6 with the verifying key transcoded from `Verifier.sol`) → the same proof accepted by the
  deployed verifier `0xce17…557a` by `eth_call` → every pool's live history frontier reproduced (the root `getLastRoot`)
  → a deposit and a withdrawal on the devnet with the real bytecode → the relayer survey. The mainnet-fork rung
  (`classic/test/fork/withdraw.fork.test.ts`) is the owner's to run on a machine whose fork node starts (gap 53).
- **the real-device checklist** — [`docs/mobile-web-gate.md`](mobile-web-gate.md) §2, the owner's to run and record (§5
  there).

## 1. Design foundation

| Item | Evidence | Status |
|---|---|---|
| Mobile-first design tokens | V6's tokens (`packages/ui/src/tokens/tokens.css`, spec v2.0 §5) are the wallet's; the Classic application carries the same identity through a generated stylesheet, `classic/src/tokens.generated.css`, copied from those tokens by `classic/scripts/tokens.mjs` with a hash check (Stage 2) — the one thing the two products share, and not at runtime (`scripts/check-boundaries.mjs` rule 9). | ✅ |
| Home / Protect / Send / Swap / Activity prototypes | The five core screens as pure Views on fixtures (`apps/web/src/fixtures/registry.tsx`, V6) under the harness — 185 screenshots at four sizes against reviewed baselines, 353 layout checks at ten sizes, 121 acceptance checks ("visual"); Stage 4 added Settings (one page), the Privacy Center under `/privacy` and the Connect wallet chip with its picker; the Classic screens on a mock source at Stage 3 (96 baselines, "classic visual"), the original's flow element by element against the reference screenshots (`classic/docs/parity.md`). | ✅ |
| Desktop layouts | V6 Stage 16's layouts from 1024 px (spec v2.0 §6); Stage 4's top bar with the Wallet menu and the account chip beside it (one bar at a time, `apps/web/test/shell.test.tsx`, `desktop-v6.test.tsx`); the Classic Statistics beside the form from 1024 px (the Classic harness). | ✅ |
| Unified fee and review components | One Review (`apps/web/src/features/review/View.tsx`) for Protect, Send, Swap and cross-chain, one Progress, one record under every flow (spec v2.0 §7.9, §12); Stage 12's fee statement on every Review ("Privacy fee (1 %) — charged on each protect, send and swap"; a swap's "Your funds paid 1 % when they were protected; this swap pays 1 % again"; `Relayer/network (n steps)` for a protected execution), the Quote's `feeTerms`, `docs/fee-policy.md` and the in-app "Fees & refunds" page (English and Korean); the blockers of spec v2.0 §13.4 with V7's `in_flight_limit`, `route_not_qualified` and `one_at_a_time`. | ✅ |

## 2. Tornado Classic

| Item | Evidence | Status |
|---|---|---|
| Pinned upstream source and licences | `classic/docs/compatibility-matrix.md` (Stage 1): classic-ui `a83fae07` (MIT), tornado-core at the deployed era, tornado-cli `378ddf8b`, tornado-relayer `22477306`, websnark `4c0af6a8` (the phase-2 commit; master computes another FFT non-residue), circomlib `3b492f98`, the snarkjs fork `869181cf` = npm 0.1.20; the vendored files hashed by `classic/test/vendored.test.ts` against `classic/vendor/VENDORED.md`; the artifacts pinned (`classic/public/artifacts.json`: `tornado.json` LF `3ddd61db…`, the proving key `8e2d2f22…`); GPL-3.0 for the Classic bundle (`classic/LICENSE`, `classic/THIRD_PARTY_NOTICES.md`), MIT for the repository's own code (`LICENSE`) — the owner's decision 10; the GPL stack never enters the wallet's bundle (rule 9, the bundle scan). | ✅ |
| Four pools and router verified | Stage 5: `classic/scripts/verify-deployment.mjs` rebuilds the Sourcify records (`classic/contracts/verified/`: TornadoCash_Eth_01 and TornadoCash_eth at solc 0.5.11, the Verifier at 0.5.17, the TornadoRouter at 0.6.12) and compares the runtime code with the chain's, reads `verifier()`, `levels()` = 20, `denomination()`, `operator()` = 0, `ROOT_HISTORY_SIZE()` = 100, the verifying key's constants, the instance registry's ENABLED rows and the relayer registry — into `classic/src/config/deployment.json` (the pins) and `classic/docs/deployment-verification-2026-10-26.md`; `classic/test/live/deployment.live.test.ts` under `--live`; the app reads the facts again under Settings (the availability rows, Stage 9) and hashes the code's bytes (a Stage 10 finding). | ✅ |
| Note and proof compatibility | Stage 6's vectors (`classic/vectors/`): the note's commitment and nullifier hash by the original Pedersen, the MiMC tree with the original zero leaf, a proof made by the vendored websnark + snarkjs 0.1 witness calculator (converted without `eval`, under the real policy), verified offline and accepted by the deployed verifier by `eth_call` (the live test); Stage 7: every pool's history frontier reproduced from the classic-ui caches plus `eth_getLogs` and matched to `getLastRoot` live; Stage 10: a 1 ETH deposit through the router and its withdrawal by the stand-in relayer, and a 0.1 ETH withdrawal in wallet mode, on the devnet with the mainnet bytecode (e2e 11b); the mainnet-fork rung with the root-aging scenario is written (`classic/test/fork/withdraw.fork.test.ts`, 3/3 in its devnet mode) and waits for a machine whose fork node starts. | ⚠ 53 |
| Original-style deposit / withdraw frontend | Stage 3's screens — Deposit / Withdraw tabs, the note modal and its backup acknowledgement, the found-note card (time passed, subsequent deposits), Relayer / Wallet settings, the fees table, Statistics, History, Settings — against the reference screenshots (`classic/docs/reference/`, `classic/docs/parity.md`); Stage 9 wired them to the real services (`classic/src/app/services/`); the original words under the Classic word policy (`classic/scripts/words.mjs`: the statistics allowed, the promises banned) — the owner's decision 8. | ✅ |
| Audited transaction and relayer integration | Stage 8's relayer client (the schemas as real relayers speak — string health, RESUBMITTED —, the registry rules, 23 live relayers in `classic/relayers.json` from `classic/scripts/relayers.mjs`, the R-6..R-10 checks, calldata held to real transactions), Stage 10's stand-in run, Stage 11's `classic/docs/security-review.md` (C-1..C-5 and R-1..R-10 closed or named) and `classic/docs/threat-model.md`; every `CLASSIC_LIVE` switch off in a production build until the release gate and the legal review (`classic/docs/release-gate.md`, `legal-review.md`). The external audit is the owner's. | ⏳ |

## 3. The Privacy Wallet

| Item | Evidence | Status |
|---|---|---|
| External wallet and protected storage | V6's connection (EIP-6963, the injected wallet, WalletConnect on request) and the encrypted keystore and journal; Stage 4's connector picker and the reconnect from `prefs.lastConnector` after a reload; Stage 16's WalletConnect icon and `redirect`, a restored WalletConnect session taken up without a pairing, `navigator.storage.persist()` asked once per page (`packages/wallet-engine/test/wallet-engine.test.ts`, `apps/web/test/storage-persist.test.ts`). | ✅ |
| Balance synchronization | V6: the note store, the tree synced from every configured endpoint with a quorum, the pool scan after every unlock (`discovery:pool`), the light client on mainnet and Sepolia; the local stack reads the protected balance after each flow. | ✅ |
| Protect and Private Send end to end | V6 and the local stack's sections 2–4 (Protect 5,000 USDC, Send 2,500 USDC, the large Reviews, the fresh address, the address book); Stage 16: a Protect stops prompting the external wallet once the session is locked (`packages/sdk/test/protect-approvals.test.ts`), one Protect or Send at a time (`apps/web/test/protect.test.tsx`, `send.test.tsx`), the `beforeunload` guard while proving or submitting. | ✅ |
| Locally generated and validated proofs | V6's crypto worker (the circuit inputs never leave it, the proving key cached under its pin, every proof verified locally before submission); Classic's prover worker (Stage 6: the whole GPL stack inside it, the Blob sub-workers under `worker-src 'self' blob:`). | ✅ |

## 4. Swap and operations

| Item | Evidence | Status |
|---|---|---|
| Exact 1 % fee engine and relayer quotes | V6's bigint fee engine (`packages/protocol/src/wallet/fees.ts`, the relayer's rule on every withdrawal); Stage 12's statement — 1 % per operation, disclosed (the owner's decision 2) —, `docs/fee-policy.md`, the §46 quote's `feeTerms` and `p(A)` of what the user pays, the pieces bound by the Review's `F`; the Stage 12 follow-up (`58ac5da`): a piece's bound is the funding's own exact-output formula, found by the first full local run since Stage 12 (§7). | ✅ |
| THORChain adapter | V6's adapter (same-chain into the protected balance through ShieldReceiver, streaming plans, vault rotation, a halt as an outage); Stage 14's `SwapProvider` facade — `fromAdapter` in the engine, `walletSwapProvider` in the sdk with `prepare`, `validate`, `getStatus`, `getRecoveryOptions` — and its parity test with the direct flow (`apps/web/test/swap-provider.test.tsx`, `packages/sdk/test/swap-provider.test.ts`). | ✅ |
| Minimum receive and destination verification | V6: the approved minimum re-checked before every signature, the four destination checks, typed destinations re-confirmed group by group; Stage 13's amount policy — one order by default at $50K–$100K (the Review's "One order — no automatic split"), protected steps of varied size only when staged or asked, the in-flight limit, the route's liquidity qualification, over $100K behind the Advanced experience (the owner's decisions 3 and 4; `tests/high-value/policy/*`, `apps/web/test/swap-protected-steps.test.tsx`). | ✅ |
| Persistent state and recovery | V6's journaled record and the reconcile paths (a Send whose answer was lost found by its nullifier, a Protect by its note, a funding by its fate); Stage 15's fifteen states (spec v3.0 §6; journal records `v: 3` upgraded on read, the API's migration 3, I-O7 from SUBMITTING, an expired quote returned to the review or into recovery); the facade's recovery options. | ✅ |

## 5. Release

| Item | Evidence | Status |
|---|---|---|
| Mobile browser end-to-end tests | The local stack's browser run under mobile emulation (430×932, touch) with the viewport matrix at ten sizes; Stage 16's guarantees each under a unit test (`docs/mobile-web-gate.md` §1); the eleven real-device scenarios (§2 there) are the owner's to run and record (§5 there). | ⚠ 58 |
| Contract / cryptography / frontend audits | The package for the auditors (`docs/audit-package.md`, §1.3 for V7) and the Classic security review; the engagements are the owner's. | ⏳ |
| Privacy leakage tests | V6's gate ("apps/web privacy leakage": every request body, provider call, transport record and console line of the create → protect → send flows and the swap scenario read for the secrets) and the browser twin; V7's Classic twin (e2e 11c: no note in any Classic request or in the Classic database, the hosts named — the origin, the devnet, the stand-in). | ✅ |
| Production readiness and legal review | The deployment page (`docs/deployment.md`: the two policies, the headers, nginx, the Classic location); `classic/docs/release-gate.md` per pool and function; `classic/docs/legal-review.md` empty until the owner's review is recorded — every `CLASSIC_LIVE` off until then (the owner's decision 9); the sanctions oracle and the geofence behind switches, off; the ceremony, the testnet broadcast and the hosting origin are the owner's. | ⏳ |

## 6. What the owner holds

The legal and sanctions review of Tornado Classic (`classic/docs/legal-review.md`); the external audits (contracts,
cryptography, frontend, the Classic bundle); the real-device run of the mobile-web checklist; the mainnet-fork run of the
Classic prover (gap 53); a WalletConnect project id for the connector to exist; the hosting origin for Classic (the same
origin under `/classic/`, or a `classic.` subdomain); the relayer custom-URL and the device-kept deposit-list follow-ups
(gap 56); the ceremony and a testnet broadcast of the wallet's own protocol (spec v2.0 §23).

## 7. The final runs

On the final code, 2026-10-27 (the V7 table of `docs/roadmap.md`, row 17):
- **verify-all** with `--rust --forge --live --browser` (the standalone Rust toolchain on this workstation, `docs/local-run.md` §0): **63/64** steps. The web wallet 708 + 5 live (1 skipped) + 9 in the leakage gate, the sdk 235, the swap engine 133 offline + 112 live, the API 65, the relayer 131, the protocol 193, the high-value tree 62, the Classic application 160 (its lockfile, dependency review, typecheck, lint with the word policy, gates, build, build checks, bundle scan, the prover in Chrome), the packages (ui 50, wallet engine 7, risk 8, protocol types 4, config 5, contracts 24, privacy 7, server kit 19), forge 146, the Rust core 35 across 15 test binaries and its UniFFI bindings 11.
  The one step short, "classic LIVE", stopped on the public log endpoints refusing the busiest pool's one 400,000-block `eth_getLogs` ("service temporarily unavailable" from both — 10 of its 11 tests passed, the 0.1 ETH pool's frontier the one that did not); the newest-deposit scan of that test now walks 25,000-block windows newest first, and the step reran on its own: **9 passed, 2 skipped** — every pinned fact still holds, the recorded proof accepted by the deployed verifier and refused with the recipient bent, all four pools' frontiers reproduced to their `getLastRoot()`, the 100 ETH snapshot synced to head − 12 into a root the pool knows, the registry's 127 registrations, 22 of the 23 curated relayers online and within the rules.
- **The harnesses**: the wallet's 185 screenshots against the reviewed baselines (185 match), 353 layout checks at ten sizes and 121 acceptance and accessibility checks; the Classic application's 128 screenshots (128 match) and 320 layout checks.
- **The local stack's full run** (the campaign section and the Classic sections included): **250/250** checks, 0 failure(s) (`scripts/local-stack/results/report-2026-10-27-v7.json`).
- **The Classic fork suite** ran in its devnet mode on this workstation (3/3, Stage 10); the mainnet-fork rung is the owner's (gap 53). The real-device checklist is the owner's (gap 58).

Found and fixed on the way to these runs: the step fee bound of V7 Stage 12 (the first full run since that stage, at
Stage 15 — `58ac5da`), and the run script's Classic History check reading its rows before the Classic database answered
(`5e73a14`).
