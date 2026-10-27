# Definition of Done — V6 (doc §94)

The owner's document ("Privacy Wallet Web V1 — Core Product → UX → Application → Privacy → Swap → Security →
Production", §1–§96) ends on a Definition of Done (§94). This page maps every line of it to the evidence that it holds
in this repository — a test, a verify-all step, a local-stack report, a reviewed screenshot, a section of the spec — and
gives its status. The normative text behind each line is [`docs/privacy-wallet-web-spec-v2.0.md`](privacy-wallet-web-spec-v2.0.md);
the pass that built it is the V6 table of [`docs/roadmap.md`](roadmap.md) (Stages 0–17).

Status: **✅** done and evidenced here · **⚠** done, with a limit stated in [`docs/audit-package.md`](audit-package.md) §4
(the gap's number) · **⏳** the owner's, outside this repository (a person, an auditor, a ceremony).

How the evidence runs:
- **verify-all** — `node scripts/verify-all.mjs --rust --forge <solc-0.8.24> --browser --live` runs every suite, the
  lint, the gates, the build with its budget and bundle scan, forge, the Rust core and the screenshot harness. Its steps
  are named below in quotes.
- **the harness** — `tests/visual/run.mjs` renders every fixture of `apps/web/src/fixtures/registry.tsx` in Chrome at
  390×844, 430×932, 768×1024 and 1440×900. It compares each with the reviewed baselines in `tests/visual/baselines/win32`,
  checks the layout at the ten sizes of spec §6, and runs the acceptance checks of doc §86–§92 and the accessibility
  passes of doc §77.
- **the local stack** — `scripts/local-stack/e2e.mjs` clicks the flows in a real browser against a Hardhat devnet, the API,
  the relayer and live provider quotes. The final run's record is `scripts/local-stack/results/report-2026-10-14-v6.json`.

## 1. Product

| Line | Evidence | Status |
|---|---|---|
| Beginner-usable | The Golden UX rule (doc §92): the harness's vocabulary check on every Simple fixture (no Router, Calldata, Gas, Merkle, root, Nullifier, Proof, Provider ID, escrow, commitment, witness, nonce, wei / gwei, tranche, memo, slippage, full address, extra decimals). Every technical line sits behind Advanced (spec §1, §7). One primary action per screen (the harness's layout check). The first launch is Welcome → the experience → Create, with zero requests (`apps/web/test/first-launch.test.tsx`). The words come from one catalog (`apps/web/src/app/i18n/en.ts`). | ✅; the people test is §6 below ⏳ |
| Mobile primary | The design canvas is 390×844. The harness checks the layout at the ten sizes (360×800 up): no sideways scroll, one bar, 44 px targets. The primary action stays visible above an on-screen keyboard (doc §56; the harness's keyboard check). The local stack's viewport matrix (section 9). | ✅ |
| Desktop polished | From 1024 px: the top bar with its Wallet menu, Home's tiles and two columns, the Swap route details beside the card (spec §6). Every 390 px action is at 1440 px (`apps/web/test/desktop-v6.test.tsx`; the harness's parity check, doc §88). Reviewed baselines at 1440×900 (`tests/visual/baselines/win32/home-funded@1440x900.png`, `swap-advanced@1440x900.png`). | ✅ |
| Consistent core flows | One model for Protect, Send, Swap and cross-chain: what you have → what you want (FlowCard). One Review layout and one Progress. One operation record under every flow (spec §12; `apps/web/test/operations/property.test.ts`: 2,000 random sequences under I-O1–I-O7). The local stack runs every flow on the same screens (sections 2–8b). | ✅ |
| Transparent fees | Every Review shows the privacy fee (1 %), the relayer / network cost, the swap / provider fee and the total. The harness's §86 check reads the ten items of the $10,000 Review. Fee math is bigint only (`packages/protocol/test/fees-v2.test.ts`). The local stack reads the exact figures on chain (Protect 5,000 USDC → 4,950 + 50; Send 2,500 → 2,470.90). Estimated vs actual network cost is under Advanced (`packages/sdk/test/costs.test.ts`). | ✅ |
| Stronger protection for large transactions | (Superseded by V7 Stage 13, spec v3.0 §4: one order by default at $50K–$100K, protected steps only when staged or asked.) Automatic from $50,000, with no mode to choose. The four checks and Hold to Confirm (the harness's §87 check). The steps show amounts only (`apps/web/test/swap-protected-steps.test.tsx`). The V3–V4 layer applies from $1M (`tests/high-value`: 62, incl. the 1,000-campaign property test). The local stack's $80,000 band (section 8b) and $10M campaign (section 8). | ✅ |

## 2. Wallet

| Line | Evidence | Status |
|---|---|---|
| External connection | EIP-6963, the injected provider, and WalletConnect loaded on request, behind the doc §15 names (`packages/wallet-engine`; `apps/web/test/connection.test.ts`). The public wallet signs deposits only and never sees the protected balance. | ✅ ⚠ 26 (WalletConnect's relay) |
| Protected wallet | The seed, the keys, the notes and the protected balance live in the SDK behind the doc §61 facade (`packages/sdk/src/index.ts`; `packages/sdk/test/facade.test.ts`). No cryptography in React; the platform passes its store and prover (spec §4). | ✅ |
| Encrypted local storage | The keystore (scrypt + XChaCha20-Poly1305) and the seed-keyed journal sit in IndexedDB; the at-rest formats are byte-pinned (`docs/wallet-formats.md`; `apps/web/test/wallet-vectors.test.ts`, `keystore.test.ts`, `storage.test.ts`). `localStorage` and `sessionStorage` stay empty (the leakage gate). | ✅ |
| Lock / unlock | Auto-lock after 15 idle minutes (1 / 5 / 15 / 60), 5 minutes after the tab is hidden, and at pagehide. A hold defers it through signing, proving and submission; a lock forgets the drafts, the runners' memory and the crypto worker (`packages/sdk/test/auto-lock.test.ts`, `apps/web/test/auto-lock-v6.test.tsx`; local stack section 9b). | ✅ |
| Recovery | The 24-word phrase and the backup file. A restore finds the wallet's notes and refunds by rescanning (PP-P03; `apps/web/test/refunds.test.ts`). An operation's recovery is read from where the money is, never a blind retry (spec §12.4; `packages/sdk/test/settlement.test.ts`). | ✅ |

## 3. Privacy

| Line | Evidence | Status |
|---|---|---|
| Protected balance | Valued through the wallet's own RPC quorum. The pool's view is proven by the Ethereum light client before every spend (`apps/web/test/lightclient.test.ts`, `verified-reads.test.ts`). Home shows it first (`apps/web/test/home.test.tsx`). | ✅ |
| Protect | 1 % through ProtectRouter, `fee + net == gross` for every gross (`contracts/test/periphery/ProtectRouter.t.sol`). The Protect screen (`apps/web/test/protect.test.tsx`). Local stack section 2b: the vault and the fee recipient read on chain. | ✅ ⚠ 30 (a direct vault deposit skips the fee) |
| Private Send | Exact input by default, exact output on request. The four checks; a pasted address of another chain is never switched silently (`apps/web/test/send.test.tsx`). The relayer's fee rule (`apps/relayer/test/fees.test.ts`). Local stack: 2,500 → exactly 2,470.90. | ✅ ⚠ 31 (a transfer's percentage is the wallet's to pay) |
| Privacy status | High / Medium / Low, with "Why?" (spec §7.10). Right after a Protect it reads Medium and offers "Delay for more privacy": older notes first, else a random time in 1–24 h (`packages/sdk/test/privacy-timing.test.ts`, `apps/web/test/swap-one-confirm.test.tsx`). The assessment: `packages/protocol/test/privacyAssessment.test.ts`. | ✅ |
| Privacy Center | Seven sections on computed facts, never asserted (`apps/web/test/privacy-center.test.tsx`). What the wallet cannot promise, said in the reader's language. Baselines `tests/visual/baselines/win32/privacy-center@390x844.png`. | ✅ |
| Data minimization | The API keeps swap records only: no note, key, phrase, witness, balance, user address, IP or user agent (`apps/api/test/schema.test.ts`, `flow.test.ts`). Every log line is JSON with the allowed keys only (`apps/api/test/logs.test.ts`, `apps/relayer/test/logs.test.ts`). No request carries a secret (`apps/web/test/privacy-leakage.test.tsx`, `privacy-leakage-worker.test.ts`). The bundle has no tracker (`scripts/scan-bundle.mjs`). The first launch makes no request. | ✅ ⚠ 34 (the API's retention window) |

## 4. Swap

| Line | Evidence | Status |
|---|---|---|
| Same-chain | Into the protected balance through a one-time ShieldReceiver (`contracts/test/periphery/ShieldReceiver.t.sol`; `apps/relayer/test/shieldExecutor.test.ts`; `packages/swap-engine/test/same-chain.test.ts`; `packages/sdk/test/shield-receipt.test.ts`). Local stack section 7b: USDC → ETH, the receiver shielded by the relayer, the note found. | ✅ ⚠ 36 (THORChain only for now; LI.FI behind its capability) |
| Cross-chain | ETH → BTC with "You'll receive at least" and the one sentence that the settlement is not atomic (`apps/web/test/swap-one-confirm.test.tsx`; local stack section 7). | ✅ |
| THORChain adapter | The memo names the escrow for refunds; the router is pinned; the vault is confirmed by a quorum of gateways, by the service and again by the wallet (`packages/swap-engine/test/adapters-live.test.ts`, `adversarial.test.ts`; `apps/web/test/provider-call.test.ts`). | ✅ |
| Provider abstraction | One adapter interface, six live adapters, selection and the breaker (`packages/swap-engine/test/selection.test.ts`, `engine-v2.test.ts`). The doc §48 blockers (`packages/risk-engine/test/assess.test.ts`). | ✅ |
| Quote expiry | The countdown, "This quote is no longer available." with "Your funds were not moved.", and the blocker at signing (`apps/web/test/swap-one-confirm.test.tsx` "an expired quote says so"). | ✅ |
| Minimum receive | The minimum the user approved binds the signature; a lower one waits for the user's choice (`swap-one-confirm` "a lower minimum waits for the user"; `apps/web/test/swap-sign.test.ts`). | ✅ |
| Fee calculation | The privacy fee on the input, the relayer / network on top, the provider apart, and the market rate as the residual, so the lines always balance (`packages/protocol/test/fees-v2.test.ts`). The tip is gas-based (`packages/swap-engine/test/tips.test.ts`). | ✅ ⚠ 32 (a refund-only job costs more than the tip) |
| Destination validation | The three checks, a wrong chain refused by name (`packages/protocol/test/destinations.test.ts`, `apps/web/test/destination-card.test.tsx`). A typed address from $20K is confirmed group by group. | ✅ |
| Settlement tracking | The legs and the settlement states (spec §12.4; `packages/sdk/test/settlement.test.ts`). The API's reconcile (`apps/api/test/reconcile.test.ts`). The tracker (`apps/web/test/order-tracker.test.ts`). | ✅ ⚠ 35 (the API is a second source) |
| Recovery | "Return funds" (a refund-only job; nothing signed). Recovery cards read from the settlement, never a generic Retry (`apps/relayer/test/executorMore.test.ts`; `swap-one-confirm` "Return funds"). | ✅ |

## 5. Classic Privacy

| Line | Evidence | Status |
|---|---|---|
| Separate mode | Under More only, never beside Swap or Send (spec §7.11; `apps/web/test/classic-v6.test.tsx`). | ✅ |
| Separate state | Its own journal field, `classic` (`docs/wallet-formats.md`). | ✅ |
| Separate boundary | Neither side imports the other (`scripts/check-boundaries.mjs`, rule 8). A production build lists no pool (finding C-1, fixed). | ✅ |
| Dedicated review | `docs/classic-privacy-review.md` covers the boundary, note handling, the study's findings that apply and the relayer checks. The Classic contracts, the circuit port and the legal review are deferred by the owner (V5); the module runs on a mock pool. | ✅ internal review · ⏳ the contracts, an external review, the legal review |

## 6. Security

| Line | Evidence | Status |
|---|---|---|
| Contract tests | Forge (146, incl. ProtectRouter 20 and ShieldReceiver 15, the real-proof e2e and the periphery gas bench). No privileged path in any contract (NoPrivilege). The verify-all step "contracts (forge …)". | ✅ · ⏳ the external audit ([`docs/audit-package.md`](audit-package.md); gap 37: the two V6 contracts are new) |
| Crypto tests | The circuit's KAT and soundness. Five implementations of every primitive agree. The Rust core and native prover. Proofs verified on chain (`privacy-core`, `circuits`; verify-all with `--rust`). | ✅ · ⏳ the production ceremony (gap 1) |
| Browser privacy | The content security policy and the headers (`apps/web/test/csp.test.ts`, `docs/deployment.md`). No tracker or source map in the build (`scripts/scan-bundle.mjs`). Auto-lock (§2). The light client (§3). | ✅ |
| Network leakage | Every request goes through one transport with a host allowlist (`apps/web/test/transport.test.ts`). The secrets cross only into the crypto worker (`apps/web/test/privacy-leakage-worker.test.ts`). The local stack's leakage twin (section 10) reads every request. | ✅ |
| Storage leakage | Two ciphertext blobs in IndexedDB, and nothing in `localStorage`, `sessionStorage`, the URL or the history (`apps/web/test/privacy-leakage.test.tsx`; local stack section 10). | ✅ |
| E2E tests | The local stack's full run on the final code: Welcome → Create, Protect, Send, the large Reviews, ETH → BTC, USDC → ETH into the protected balance, the $80,000 band, the $10M campaign, the viewports and the pseudo-locale, reload / tab close / restart / offline / disconnect, leakage (`scripts/local-stack/results/report-2026-10-14-v6.json`). | ✅ |
| Failure / recovery tests | The doc §82 scenarios one by one (`packages/sdk/test/settlement.test.ts`). Offline, with a lost answer found by its nullifier (`apps/web/test/offline-v6.test.tsx`, `packages/sdk/test/relayer-recovery.test.ts`). The operation property test. The persistence run (local stack section 9b: one relayer submission, the escrow funded once). | ✅ |

## 7. The first-time user (doc §85) — a scripted check for the owner

Doc §85 asks that a first-time user understands the balance, Protect, Swap, what they pay and receive, the 1 % fee,
the relayer cost and completion. Software cannot attest that; five people can.

**Setup.**
- A build on the local stack (`docs/local-run.md`) or a testnet, a wallet with some ETH and USDC to protect, and a phone at 390 px or a desktop.
- Five participants who have not used the wallet. No help is given during the tasks.
- The observer notes answers only, never the wallet's data.

**Tasks.**
1. "How much money do you have protected?" — Pass: the participant points at the protected balance and reads it.
2. "Protect 100 USDC." — Pass: they finish Protect alone and can say what it did ("it moved my USDC into the protected balance").
3. "Swap 50 USDC for ETH." — Pass: they finish the Swap alone.
4. On the Swap's Review, before confirming, ask:
   - "What will you pay?"
   - "What will you receive at least?"
   - "How much is the privacy fee?" (1 %)
   - "What does the relayer / network cost?"

   Pass: each answer matches the screen.
5. After confirming: "Is it finished? How do you know?" — Pass: they point at Completed (or the progress) and say where the ETH arrived.

**Done when** four of the five participants pass every task without help. A task that fails twice is a screen to fix,
recorded with its words in `docs/roadmap.md`. Status: ⏳ the owner's.

## 8. The final runs

On the final code, 2026-10-14 (the V6 table of `docs/roadmap.md`, row 17):
- **verify-all** with `--rust --forge --live --browser`: **52/52** steps. The Rust core 30, its UniFFI bindings 11, the
  protocol 173, the high-value tree 62, the swap engine 103 + 107 live, the API 26, the relayer 59, the web wallet 508 +
  5 live (1 skipped) + 9 in the leakage gate, the packages (sdk 79, ui 49, contracts 19, server kit 9, risk 7, privacy 6,
  config 5, types 4, wallet 3), and forge 146.
- **The screenshot harness**: 189 screenshots against the reviewed baselines, 363 layout checks at ten sizes, and 124
  acceptance and accessibility checks.
- **The local stack's full run**: **212/212** (`scripts/local-stack/results/report-2026-10-14-v6.json`).

After the V6 follow-ups the same day (`25baf33` older notes first, `77a84b0` audit gap 43, `8191b3f` audit gap 44,
`d6e1eba` note discovery, `03d877c` the production floors, `71faabd` one unlocked tab, `82a5fbf` one private spend at a
time, `c0c8753` the campaign's price bound, `05f6af4` the API's time limits, `1d65cbc` verify-all's second run of a
test worker that exits natively, then the waits on the relayer and the chain):
- **verify-all** `--browser`: 44/44, with the web wallet at 524, the sdk at 105, the swap engine at 105 and the API at
  28. Earlier the same day, one run's API suite ran twice: its first worker exited natively with no failing test, the
  workstation fault described in `docs/roadmap.md`.
- **The local stack's quick pass**: 197/197 (`scripts/local-stack/results/report-2026-10-14-v6-relayer-timeouts.json`).
