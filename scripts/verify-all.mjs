#!/usr/bin/env node
// One command for the whole verification surface (docs/audit-package.md §3): every offline suite,
// the builds, and — opt-in — the live suites, forge and the Rust core (+ its WASM build).
// Prints a summary and exits non-zero if anything failed. Usage:
//   node scripts/verify-all.mjs                 # offline suites + builds (≈ 3 min)
//   node scripts/verify-all.mjs --live          # + the live suites (network, ≈ 3 min more): provider adapters and the
//                                               #   wallet's own checks against real provider calls; the wallet's light
//                                               #   client on mainnet and Sepolia. LI.FI allows an anonymous caller 75
//                                               #   quotes per 2 h: one run uses about 30
//   node scripts/verify-all.mjs --forge <solc>  # + forge test with that solc binary (FOUNDRY_OFFLINE)
//   node scripts/verify-all.mjs --browser       # + the screenshot harness (tests/visual/run.mjs: the installed Chrome, the
//                                               #   reviewed baselines of this platform; local only)
//   node scripts/verify-all.mjs --ci            # the CI form (.github/workflows/ci.yml): forge may download its solc,
//                                               #   the dependency review compares with the parent commit
//   node scripts/verify-all.mjs --ledger <file> # + a JSON ledger of every step's passed / failed / skipped counts (the
//                                               #   monorepo move compares two ledgers step by step: a path that broke never hides as a skip)
//   node scripts/verify-all.mjs --rust          # + cargo test of privacy-core (incl. the native prover against the circuit's
//                                               #   real artifacts when circuits/build exists), the wasm32 build, the WASM
//                                               #   package (CARGO, WASM_BINDGEN env for the binaries) and the WASM-vs-TypeScript check
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const browser = argv.includes("--browser");
const rust = argv.includes("--rust");
const solc = argv.includes("--forge") ? argv[argv.indexOf("--forge") + 1] : process.env.FOUNDRY_SOLC;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cargo = process.env.CARGO ?? "cargo";
// the native prover's tests need the circuit build (zkey) and the snarkjs witnesses; with them, they must run
const circuitsBuilt = existsSync(join(root, "circuits/build/setup/transaction_final.zkey")) && existsSync(join(root, "circuits/build/transaction_js/transaction.wasm"));
const ledgerFile = argv.includes("--ledger") ? argv[argv.indexOf("--ledger") + 1] : null;
const ci = argv.includes("--ci");
// V6 Stage 2: Prettier checks the code V6 adds (the earlier passes keep their style until a one-shot reformat); each stage
// appends its new files and directories here
const PRETTIER_FILES = [".github/workflows/ci.yml", ".prettierrc.json", "tsconfig.base.json", "scripts/check-lockfile.mjs", "scripts/dependency-review.mjs", "scripts/check-import-case.mjs", "scripts/check-doc-paths.mjs", "apps/web/src/zkapi/unavailable.ts", "packages/sdk/src/wallet/discovery.ts", "apps/web/src/platform/activeTab.ts", "apps/web/test/active-tab.test.ts",
  // Stage 3
  "packages/protocol-types", "packages/config", "packages/contracts", "eslint.house.mjs", "eslint.config.mjs", "apps/web/src/config.ts", "packages/sdk/src/config.ts", "apps/web/src/hooks/index.ts", "apps/web/test/config.test.ts", "apps/web/test/import-purity.test.ts",
  // Stage 4
  "packages/sdk/src/index.ts", "packages/sdk/src/operations/recovery.ts", "packages/sdk/src/operations/stale.ts", "packages/sdk/test", "packages/wallet-engine/src/index.ts", "packages/wallet-engine/test", "packages/privacy-engine/src/index.ts", "packages/privacy-engine/src/transport/chain.ts", "packages/privacy-engine/test", "packages/risk-engine", "scripts/check-boundaries.mjs",
  // Stage 5
  "packages/ui/src/tokens/index.ts", "packages/ui/src/animations", "packages/ui/src/patterns", "packages/ui/src/format.ts", "packages/ui/src/useMediaQuery.ts", "packages/ui/src/components/Button.tsx", "packages/ui/src/components/Layout.tsx", "packages/ui/src/Preview.tsx", "packages/ui/src/index.ts", "packages/ui/src/base.css", "packages/ui/src/fonts.css", "packages/ui/test", "packages/ui/vitest.config.ts", "apps/web/src/app/Shell.tsx", "apps/web/src/features/more/entries.ts", "apps/web/src/fixtures", "apps/web/src/build-flags.d.ts", "apps/web/scripts/check-dist.mjs", "apps/web/fixtures.html", "tests/visual/run.mjs",
  // Stage 6
  "apps/web/src/features/viewKit.tsx", "apps/web/src/features/amounts.ts", "apps/web/src/features/fixtureAmounts.ts", "apps/web/src/features/flowFixtures.ts", "apps/web/src/features/home", "apps/web/src/features/protect/View.tsx", "apps/web/src/features/send/View.tsx", "apps/web/src/features/swap/View.tsx", "apps/web/src/features/review/View.tsx", "apps/web/src/features/progress/View.tsx", "apps/web/src/features/activity/View.tsx", "apps/web/src/features/activity/model.ts", "apps/web/src/features/activity/fixtures.ts", "apps/web/src/features/activity/Activity.tsx", "apps/web/src/features/activity/Detail.tsx", "apps/web/src/features/wallet/Home.tsx", "apps/web/test/home.test.tsx", "apps/web/test/badge-words.test.ts",
  // Stage 7
  "packages/protocol/src/wallet/fees.ts", "packages/protocol/test/fees-v2.test.ts", "packages/swap-engine/src/tips.ts", "packages/swap-engine/test/tips.test.ts", "packages/swap-engine/test/helpers/tips.ts", "packages/sdk/src/executionCost.ts", "packages/sdk/src/operations/costs.ts", "apps/web/src/features/fees/feeEngine.ts", "apps/web/test/fee-engine.test.ts", "apps/web/test/costs-detail.test.ts",
  // Stage 8
  "packages/protocol/src/wallet/settlement.ts", "packages/swap-engine/src/settlement.ts", "packages/sdk/src/operations/upgrade.ts", "packages/sdk/src/operations/errors/codes.ts",
  // Stage 9
  "packages/server-kit", "apps/api", "packages/sdk/src/api/client.ts", "apps/web/test/helpers/apiV1.ts",
  // Stage 10
  "apps/web/src/features/protect/ProtectScreen.tsx", "apps/web/src/features/protect/model.ts", "apps/web/src/features/send/SendScreen.tsx", "apps/web/src/features/send/model.ts", "apps/web/src/features/progress/model.ts", "apps/web/test/protect.test.tsx", "apps/web/test/send.test.tsx", "apps/web/test/send-progress-model.test.ts", "packages/sdk/src/deploymentGuard.ts", "packages/sdk/test/deployment-guard.test.ts",
  // Stage 11
  "apps/web/src/features/swap/SwapScreen.tsx", "apps/web/src/features/swap/model.ts", "apps/web/test/swap-one-confirm.test.tsx", "apps/web/test/swap-model.test.ts", "apps/web/test/helpers/swapWorld.ts", "packages/sdk/src/wallet/orderRunner.ts", "packages/sdk/src/wallet/privacyTiming.ts", "packages/sdk/src/operations/swapRecords.ts", "packages/swap-engine/test/selection.test.ts",
  // Stage 12
  "packages/sdk/src/shieldReceiver.ts", "apps/relayer/src/shieldExecutor.ts", "apps/relayer/test/shieldExecutor.test.ts", "apps/relayer/test/monitor.test.ts", "packages/swap-engine/test/same-chain.test.ts", "packages/swap-engine/test/thorchain-vaults.test.ts",
  // Stage 13
  "apps/web/test/swap-protected-steps.test.tsx", "tests/high-value/policy/band-property.test.ts",
  // Stage 14
  "packages/protocol-types/src/services.ts", "apps/web/src/features/privacy-center/model.ts", "apps/web/src/features/privacy-center/View.tsx", "apps/web/src/features/privacy-center/PrivacyCenter.tsx", "apps/web/src/features/privacy-center/fixtures.ts", "apps/web/src/features/classic-privacy/contracts.ts", "apps/web/src/features/classic-privacy/relayer.ts", "apps/web/src/features/classic-privacy/service.ts", "apps/web/src/features/classic-privacy/View.tsx", "apps/web/src/features/classic-privacy/ClassicPrivacyUI.tsx", "apps/web/src/features/classic-privacy/fixtures.ts", "apps/web/test/privacy-center.test.tsx", "apps/web/test/classic-v6.test.tsx",
  // Stage 15
  "packages/sdk/src/operations/notify.ts", "packages/sdk/src/session/autoLock.ts", "packages/sdk/src/wallet/proofStats.ts", "packages/sdk/test/operation-notifications.test.ts", "packages/sdk/test/auto-lock.test.ts", "packages/sdk/test/relayer-recovery.test.ts", "packages/privacy-engine/src/transport/connectivity.ts", "packages/privacy-engine/test/connectivity.test.ts", "apps/relayer/src/edge.ts", "apps/relayer/test/edge.test.ts", "apps/relayer/test/logs.test.ts", "apps/web/src/app/notifications.tsx", "apps/web/src/platform/index.ts", "apps/web/src/platform/autoLock.ts", "apps/web/src/platform/connectivity.ts", "apps/web/src/platform/crypto/protocol.ts", "apps/web/src/platform/crypto/engine.ts", "apps/web/src/platform/crypto/worker.ts", "apps/web/src/platform/crypto/client.ts", "apps/web/test/notifications-v6.test.tsx", "apps/web/test/auto-lock-v6.test.tsx", "apps/web/test/offline-v6.test.tsx", "apps/web/test/crypto-worker.test.ts", "apps/web/test/privacy-leakage-worker.test.ts", "scripts/scan-bundle.mjs", "benchmarks/proof/build.mjs", "benchmarks/proof/rust-wasm-vs-snarkjs.mjs",
  // Stage 16
  "scripts/check-budget.mjs", "apps/web/src/hooks/core.ts", "apps/web/src/hooks/wallet.ts", "packages/sdk/src/env.ts", "packages/sdk/src/priceState.ts", "packages/sdk/src/wallet/mergeSchedule.ts", "apps/web/src/app/i18n/locale.ts", "apps/web/src/app/i18n/intl.ts", "apps/web/src/app/i18n/ko.ts", "apps/web/src/features/more/Language.tsx", "apps/web/test/i18n-ko.test.tsx", "apps/web/test/desktop-v6.test.tsx", "apps/web/test/a11y/fixtures.test.tsx", "apps/web/test/activity-window.test.tsx"];
// V6 Stage 3: the packages V6 adds — typechecked, linted (eslint.config.mjs) and tested one after the other; Stage 4: the
// engine, the wallet connection, the transport, the risk assessment and the design system out of apps/web
const V6_PACKAGES = ["packages/protocol-types", "packages/config", "packages/contracts", "packages/sdk", "packages/wallet-engine", "packages/privacy-engine", "packages/risk-engine", "packages/ui", "packages/server-kit"];
const V6_TESTED = V6_PACKAGES.filter((p) => existsSync(join(root, p, "test")));
// V6 Stage 1: a suite that skips while its artifact is missing must FAIL when the artifact exists and its path is wrong —
// read at the step's start (the --rust steps build the WASM package first)
const wasmCore = () => existsSync(join(root, "privacy-core/pkg/node/privacy_core_wasm.js"));
const proverArtifacts = circuitsBuilt && existsSync(join(root, "circuits/node_modules/snarkjs/build/main.cjs")) && existsSync(join(root, "circuits/setup/dev/verification_key.json"));
const requireWasm = () => (wasmCore() ? { REQUIRE_WASM_CORE: "1" } : {});

const steps = [
  // the Rust core first when requested, so the reference suite's WASM-vs-TypeScript check finds a fresh package
  ...(rust ? [
    ...(circuitsBuilt ? [{ name: "native prover fixtures (snarkjs witnesses + proofs of the v1 fixtures → circuits/build/prover-fixtures)", cwd: ".", cmd: process.execPath, args: ["privacy-core/scripts/gen-prover-fixtures.mjs"] }] : []),
    { name: `privacy-core (cargo test: 14 vector suites == circuit / contracts / TypeScript / web wallet + ${circuitsBuilt ? "12 native witness + prover tests on the real circuit and key" : "the native prover SKIPPED: no circuits/build"})`, cwd: "privacy-core", cmd: cargo, args: ["test"], env: circuitsBuilt ? { PRIVACY_PROVER_REQUIRE_ARTIFACTS: "1" } : {} },
    { name: "privacy-core FFI (UniFFI: Swift + Kotlin + Python generated from the compiled library; 11 Python tests over it incl. the EVM-verified native proof)", cwd: ".", cmd: process.execPath, args: ["privacy-core/scripts/ffi-bindings.mjs"], env: circuitsBuilt ? { PRIVACY_PROVER_REQUIRE_ARTIFACTS: "1" } : {} },
    { name: "privacy-core (cargo build --target wasm32-unknown-unknown, the workspace minus the native-only FFI crates)", cwd: "privacy-core", cmd: cargo, args: ["build", "--target", "wasm32-unknown-unknown", "--workspace", "--exclude", "privacy-ffi", "--exclude", "uniffi-bindgen"] },
    { name: "privacy-core WASM package (release + wasm-bindgen → pkg/node, pkg/web)", cwd: "privacy-core", cmd: process.execPath, args: ["scripts/build-wasm.mjs"] },
  ] : []),
  // V6 Stage 2 (spec v2.0 §17; doc §69): what npm ci installs is what the registry published; relative imports keep their
  // exact case (the CI runner's file system is case-sensitive); every TypeScript workspace typechecks
  { name: "lockfile (v3; every package from the npm registry with a sha512 integrity; @privacy-wallet/* only as workspace links; no file: / git / http dependency; nested lockfiles only in the tool directories)", cwd: ".", cmd: process.execPath, args: ["scripts/check-lockfile.mjs"] },
  { name: `dependency review (the lockfile against ${ci ? "the parent commit" : "HEAD"}: added, changed and removed packages; a cryptography-sensitive package or an install script needs a dated line in docs/dependency-reviews.md)`, cwd: ".", cmd: process.execPath, args: ["scripts/dependency-review.mjs", "--base", ci ? "HEAD~1" : "HEAD"] },
  { name: "import case (every relative import of apps/, packages/, tests/ and scripts/ names its file with the exact case)", cwd: ".", cmd: process.execPath, args: ["scripts/check-import-case.mjs"] },
  // V6 Stage 4 (spec v2.0 §4): no relative import crosses a workspace; a package never imports an app; an engine never imports
  // React or the UI; the UI never imports an engine; every @privacy-wallet/* import declared, the graph acyclic; one viem client
  // constructor (doc §65) and one reader of window.ethereum
  { name: "package boundaries (scripts/check-boundaries.mjs: the seven rules over every workspace)", cwd: ".", cmd: process.execPath, args: ["scripts/check-boundaries.mjs"] },
  { name: "prettier (the code V6 adds: scripts/verify-all.mjs PRETTIER_FILES)", cwd: ".", cmd: npx, args: ["prettier", "--check", ...PRETTIER_FILES] },
  { name: "packages/protocol typecheck (tsc --noEmit)", cwd: "packages/protocol", cmd: npx, args: ["tsc", "--noEmit", "-p", "."] },
  // V6 Stage 3 (spec v2.0 §4, §9–§10): the frozen types (in step with the spec's lists), the chain and asset registries (the V5 swap
  // destinations reproduced), the contract boundary (forge's ABIs and creation code, the deployment check and its fingerprint)
  ...V6_PACKAGES.map((p) => ({ name: `${p} typecheck (tsc --noEmit)`, cwd: p, cmd: npx, args: ["tsc", "--noEmit", "-p", "."] })),
  { name: "V6 packages lint (eslint.config.mjs: typescript-eslint, no build environment, no React in an engine package; the UI under the rules of hooks and jsx-a11y strict; the API and the server kit without console)", cwd: ".", cmd: npx, args: ["eslint", ...V6_PACKAGES, "apps/api"] },
  // Stage 4: the facade's §61 names over a configured engine (a send planned into a witness the reference builder accepts), the
  // wallet engine's §15 names over a scripted wallet, the PrivacyTransport against a local endpoint, the risk assessment's blockers
  ...V6_TESTED.map((p) => ({ name: `${p} (vitest)`, cwd: p, cmd: npx, args: ["vitest", "run"] })),
  { name: "packages/protocol (158 + 9 WASM-vs-TypeScript when privacy-core/pkg exists: the classic note's vectors (V5); primitives, witness, layered tree, prover vs real artifacts, envelope + address, reorg, chain keys, scorecard, the sync batches; V2: valuation + tiers, the Privacy Center model, destinations, the privacy lint, the housekeeping planner; V3: the campaign core — splitter, exposure, gates, pause detection, reducer —, risk classes, the address book, the lint additions, the campaign lab invariants; V4: the exposure policy, the privacy assessment, I6 and the ledger, the approval step and staleness)", cwd: "packages/protocol", cmd: npx, args: ["vitest", "run"], env: () => ({ ...requireWasm(), ...(proverArtifacts ? { REQUIRE_CIRCUIT_ARTIFACTS: "1" } : {}) }) },
  // V4 (High-Value Execution Engine plan §116–§118; contract §5): the tests tree over the pure modules — the bounds, the quote lifecycle and
  // normalization, the ledger with the §117 property test, the splitter, the RFQ interface, streaming, eligibility / the breaker /
  // concentration, the §70 states and gates, recovery, provider failure, the privacy invariants, the journal, the §118 chaos test
  { name: "tests/high-value (62: V6 Stage 13 — the $50K band's exact quarters and 500 worlds through the runner's reducer (in flight ≤ a quarter, one step at a time, every world ends); V5 policy — the ladder monotone with the consumer bands, the $50K band's quarter unmoved by tier and mode; the plan's §116 tree — order, quote, exposure incl. 1,000 random campaigns, tranche, rfq, streaming, routing, settlement, recovery, provider-failure, privacy, mobile, adversarial chaos)", cwd: ".", cmd: process.execPath, args: ["node_modules/vitest/vitest.mjs", "run", "--root", "tests/high-value"] },
  { name: "packages/swap-engine typecheck (tsc --noEmit)", cwd: "packages/swap-engine", cmd: npx, args: ["tsc", "--noEmit", "-p", "."] },
  { name: "packages/swap-engine offline (109: V6 follow-ups — THORChain's vault on the move (the quote's vault the gateways suggest, or an active vault every gateway lists; the router they agree on), a provider's failure at prepare is its own, the health check inside the per-provider time budget (a check that hangs is a timeout, its late answer cached, the status view bounded too); V6 Stage 12 — same-chain swaps into the protected balance (the same-chain providers only, a canonical vault, the shield tip in the output asset, a minimum below a hundred tips filtered); Stage 11 — the route selection (partial quotes refused, the lowest fee, best price); V6 — the executor tip is the execution's gas (eth_feeHistory, the 1 % cap, an ERC-20's valued tip, the committed tip at prepare); V5 — the $50K band's four exact sequential quarters under a 30-minute window, the ladder's seven names; state machine, scoring, privacy score incl. the link composition, endpoints == forge, restore, escrow call per ingress + asset, what an escrow can re-shield, unit; V2: the five policies and filters, the competition record, the health tracker and breaker, placeholders, MinimumMoved, the price guard's typed refusal, the valuer, the zkAPI gateway; V3: the risk database loader, the security breakdown, the breaker's new triggers and probe, the protection recommendation, the execution window; V4: the presets, PAES, the normalized line, the exposure tier / caps / remedy / share cap)", cwd: "packages/swap-engine", cmd: npx, args: ["vitest", "run", "test/engine-core.test.ts", "test/engine-v2.test.ts", "test/valuation.test.ts", "test/gateway.test.ts", "test/endpoints.test.ts", "test/restore.test.ts", "test/escrow-call.test.ts", "test/escrow-assets.test.ts", "test/chainflip-unit.test.ts", "test/mayan-unit.test.ts", "test/price-guard.test.ts", "test/risk.test.ts", "test/tips.test.ts", "test/selection.test.ts", "test/same-chain.test.ts", "test/thorchain-vaults.test.ts"] },
  ...(live ? [{ name: "packages/swap-engine LIVE (107: adapters incl. the Uniswap-Across leg, Mayan SWIFT and swap & lock, THORChain streaming plans, adversarial, privacy flow incl. USDC-sourced orders and the phase-1 placeholders, guest deposit, the wallet's own provider-call check on every prepared call)", cwd: "packages/swap-engine", cmd: npx, args: ["vitest", "run", "test/adapters-live.test.ts", "test/adversarial.test.ts", "test/privacy-flow.test.ts", "test/guest.test.ts", "test/wallet-check.test.ts"] }] : []),
  { name: "apps/relayer typecheck (tsc --noEmit)", cwd: "apps/relayer", cmd: npx, args: ["tsc", "--noEmit", "-p", "."] },
  // V6 Stage 9 (spec v2.0 §15): the API — Express 5 over the engine and node:sqlite
  { name: "apps/api typecheck (tsc --noEmit)", cwd: "apps/api", cmd: npx, args: ["tsc", "--noEmit", "-p", "."] },
  { name: "apps/api (38: a settlement stall only from the API's own records — the operation named, the relayer's execution, its hand-over and plan; a caller's timing about made-up transactions opens no breaker —, the schema's second migration; every request body and tracking query checked at the edge, a malformed one 400 before any provider is asked; the reconcile throttle keeps an answer only while it serves it; a provider's failure answers 502 and is logged as the provider's; the reads of the relayer and the RPC endpoints end after their limit; the schema pinned and STRICT, the pragmas, retention; the routes — the §46 quote's keys, op_/qt_ ids, no listing, no order id in a URL, the blob gone at finalize, resume and restore; reconcile over the doc §82 legs, the throttle, fee.deviation once; the HTTP edge — the headers, CORS, 413/415/429, X-Forwarded-For ignored; the log gate; the database after a flow)", cwd: "apps/api", cmd: npx, args: ["vitest", "run"] },
  { name: "apps/relayer (63 — a V6 follow-up: the submissions looked at again on its own tick (a receipt settles a job, a dropped transaction releases its notes); V6 Stage 15: the HTTP edge (the security headers, CORS for the allowed origins only, the rate limit by socket, 415), every console line naming the relayer and never a request, a lost answer found by its nullifier; Stage 12: the shield executor (forge's receiver prediction, the job admission, the paid shield once, the wait below cost until the swap is over, unpaid shields bounded and floored, expiry, a revert without gas, one pass at a time); the rate limiter's 3 moved to packages/server-kit in V6 Stage 9: V6 — the percentage on every withdrawal incl. the escrow funding, the receipt's actual cost on the jobs, the executor waiting below cost; V5 — one pass of the swap executor at a time (the hand-over's tick and the interval's never send an execution twice); the percentage privacy fee: the terms on /info, fee_below_percent on a withdrawal, the escrow exemption, a transfer on the minimum only, the floor; submission vs forge e2e tx, ERC-20 fee vaults, swap executor vs forge vector incl. WETH, foreign-token and ETH-at-an-ERC-20-order refunds, the unpaid re-shield budget and floors, the late-refund watch, refund-only jobs, journals, limits; V3: the admin token on the job list)", cwd: "apps/relayer", cmd: npx, args: ["vitest", "run"], env: { REQUIRE_FORGE_FIXTURE: "1" } },
  { name: "apps/web tests (543: the V6 follow-ups — a suspected settlement stall names the order's operation, never the wallet's timing; a THORChain halt at signing an outage (tried again, never an unsafe call or a guest mismatch), an order whose execution window closes (never funded, never signed, Return funds or Review again; a protected step planned again or refunded), THORChain's vault on the move (a call or a guest's address on another active vault every gateway lists is signed or shown, one no gateway lists stopped, an accepted call on a retired vault prepared afresh) and THORNode gateways that do not answer (an outage tried again, never an unsafe call), a funding never sent twice on its own (journaled before it is sent; a Resume while it may land sends nothing, a dead one only after the user resumed), the offline probe ending when the next one starts, campaign steps at the price bound, one unlocked tab at a time (a Web Lock, the step aside, the waiting screen), note discovery (after an unlock, every ten minutes, Activity and Receive; a first launch request-free; a transfer received in Activity), Delay for more privacy from older notes first, else a random time, an order stopped unfunded when they no longer cover it; V6 Stage 16 — Korean complete and its own chunk (every key, the placeholders, the vocabulary, no English on a Simple screen read in Korean, the picker: Automatic, English, 한국어 — an English choice on a Korean device stays), the desktop (the Home tiles and two columns, the Swap route details beside the card, every 390 px action at 1440 px for every fixture), accessibility on every fixture (axe, the keyboard through Protect, Send and Swap, the hold held and its dialog alternative, a sheet keeping and giving back the focus, the live regions), Activity windowed, a quote typed past cancelled; V6 Stage 15 — the operation notifications (the catalog's words, no amount by default, a toast once), the auto-lock on the page (15 idle minutes by default, the chosen minutes, a hidden tab, pagehide, the drafts forgotten, the return after an automatic lock only), offline (the banner's words, the scheduler held until the browser is back, the probe), the crypto worker's engine (the core's formats, the inputs built from the plan, the key cached under its pin and checked on every read) and the worker boundary (the secrets only in the crypto worker, no key or input in a reply, a lock ends it), sessionStorage, the location and the history in the leakage gate, the swap's time from the device's own proof; Stage 14 — the Privacy Center's seven sections from facts, 'Data sent to services' generated from the transport's purposes and the API's field list, the fixtures pinned to the model, the 'Why?' sheet; Classic Privacy's service, relayer client, production build, recovery and relayer screens; Stage 13 — $80,000 protected automatically: the V6 Review's Protected execution and the hold, one confirmation into the steps, the amounts-only progress, Return the rest, the steps amount inside what was typed, the strict quote from $20K, the runner giving up an unfunded step while the rest returns; Stage 12 — the quote lines of a swap into the protected balance; V6 Stage 11 — the Swap with one confirmation on the order runner against the real engine, the model, the blockers, the privacy timing; Stage 10 — Protect and Send on the routed V6 screens: the destination's kinds and the hand-over to Swap, the bands, the fresh address reserved once, the verdicts, the send and progress models; Stage 8 — the operation contract V6: the 2,000 sequences under I-O1–I-O7 and the I-O7 sweep, a declined prompt back to the review, a delay as an attribute, the adapters on the V6 targets, the Activity without drafts; Stage 7 — the fee engine on the V6 formulas, a swap quoted on W, the costs on the detail, the router as an allowance spender; Stage 5 — from 1024 px the top bar and its Wallet menu with every More entry (the design system's suites moved to packages/ui); Stage 3–4 — one reader of the environment, every engine package imported before configure(); V5 Stage 12 — the hold keeps its size and survives a layout shift, the campaign Review with its details open; Stage 11 — the leakage gate through the real engine, the content security policy, the artifact pins and the worker's verdict, the locale and the pseudo-locale with the dead-key rule, fourteen screens under axe; Stage 10 — More — Security (the backup file and stamp, the phrase behind the password, the thresholds, Forget), Wallet (the connection, the trade preference, the allowances), Advanced (every protected-execution control); the Privacy Center on computed facts and the §15 rows, What stays private with the LIMITS; Classic Privacy on the mock pool — the disclosures, the note once, the journal's optional field, a withdrawal against a note; Activity and the operation's detail — the rows merged by id and hash, the groups by day, the advanced list, the recovery card; the Swap on the design system — the band's checks, the $80K plan of four quarters, the progress words, the recovery card, the restyled Review; the Protect and Send flows on the operation record — the wallet's balance and the network cost through its own provider, the private and public paths with the §16 checks, the exact-input fee summary, the bands, the verdicts; the operation state machine — the reducer's table and invariants under 2,000 random sequences, the adapters from every vocabulary, the error catalog's source scan, the store across lock / unlock, the engine's typed events; the fee engine per operation kind and the controls per band; the connection, the transport policy, the new Home; the shell — the gate, the first launch, the four routes, the lazy chunks, the More menu; the design system — tokens, the component inventory, sheets and the confirmation, the gallery under axe; the storage container — the secure store over IndexedDB, the migration, the prefs schema, the TC-01 guard; the Ethereum light client on a synthetic chain + the pool check in the spend flows, refunded swaps found and proven by their commitment, the Swap screen clicked through against the real engine, the guest deposit instruction checked in the browser, the swap-service guard (escrow recomputed, orders and signatures checked), the provider call read before signing (pinned contracts, receiver, refunds, approved minimum), the Rust core path and the TypeScript path through sync / discovery / planning, keystore + journal + at-rest vectors, ERC-20 assets + fee terms + relayer failover, fresh addresses, RPC quorum, first launch, scheduling, zkAPI policy + capability failures, planning, merges, relayer client; V2: prices through the RPC quorum, the four-tab shell at first launch with zero requests, the Privacy Center, Activity, journal safety, the serialized scheduler with backoff, the pre-trade simulation on mock endpoints, destinations on the screens, the high-value Review with the hold, the second factor and the institutional hold against the real engine, settlement tracking, housekeeping, the sanitized trade check, the fee line in asset units; V3: the campaign runner against a scripted world — start, one action per tick, the gate and the cadence, reconcile without a second send, pauses and alerts, reroute Review, cancel, a lock, the re-scheduled tick; the protection screens: the campaign Review with the maximum-loss model and the paired verdict, the separate device, the progress panel, Home's line and switch, Activity, Settings → Protected execution, the trade check; the $1M / $5M / $10M flows against the real engine and risk layer; the address book on the screens — add, the groups, the signed challenge, the cooling-off and the Immediate override, fresh addresses retired, Settings, Receive —, allowances through the injected provider; the exposure dashboard; V4: the confirmed state, unknown / reconnecting, the reorg and velocity pauses, the user-cap rules, the EXECUTION line and the §69 sentence, the opt-out and the knobs, the address book's approval)", cwd: "apps/web", cmd: npx, args: ["vitest", "run"], env: requireWasm },
  ...(live ? [{ name: "apps/web LIVE (6: the light client on mainnet and Sepolia — sync, a two-period walk, storage proofs, bent data refused)", cwd: "apps/web", cmd: npx, args: ["vitest", "run", "--config", "vitest.live.config.ts"] }] : []),
  // V5 Stage 11 (spec §21): the privacy leakage gate — every request of the create → protect → send flows and of the swap scenario read for secrets
  { name: "apps/web privacy leakage (the create → protect → send flows against the mock core and a relayer stub with the real engine behind a mocked proof, and the swap scenario against the real engine: every request body, every provider call and every console line read for the seed, the phrase, the keys, the note secrets, the keystore; the worker alone sees the circuit inputs; the hosts allow-listed; the store ciphertext only)", cwd: "apps/web", cmd: npx, args: ["vitest", "run", "test/privacy-leakage.test.tsx", "test/swap-flow.test.tsx"] },
  { name: "apps/web lint (eslint 9 over all of src — the components still mounted without the any and label rules —: typescript-eslint, the rules of hooks, jsx-a11y strict, the house rules — no storage API outside src/storage, no fetch (the privacy engine's transport), no window.ethereum (the wallet engine), no Radix (the UI package), no inline style or literal text on a screen, no forbidden word; the engine and the design system are linted as packages since V6 Stage 4)", cwd: "apps/web", cmd: npx, args: ["eslint", "."] },
  { name: "apps/web build (tsc -b + vite build)", cwd: "apps/web", cmd: npm, args: ["run", "build"] },
  // V6 Stage 5 (spec v2.0 §6, §19): the screenshot fixtures and the component preview never reach a production build; the typeface does
  { name: "apps/web dist (no fixtures, no component preview, no source map; the latin Inter served from this origin)", cwd: "apps/web", cmd: process.execPath, args: ["scripts/check-dist.mjs"] },
  // V6 Stage 15 (spec v2.0 §17, §19; doc §83): first-party code only — no tracker SDK or host, no source map, no test seed
  { name: "bundle scan (scripts/scan-bundle.mjs: apps/web/dist ships no tracker SDK or host, no source map, no test seed; its self-test sees each kind first)", cwd: ".", cmd: process.execPath, args: ["scripts/scan-bundle.mjs"] },
  // V6 Stage 16 (spec v2.0 §19; doc §89 Step 20): the performance budget over the build's Vite manifest
  { name: "performance budget (scripts/check-budget.mjs: the first route at most 250 KB of gzipped JS, Home at most 80 KB more, no snarkjs and no WASM before they are needed)", cwd: ".", cmd: process.execPath, args: ["scripts/check-budget.mjs"] },
  // V5 Stage 11 (spec §20): the artifact pins against the files on this machine and the built index.html (its policy, the pin file shipped); the dependency audit (offline → skipped)
  { name: "apps/web artifact pins (public/artifacts.json vs the circuit artifacts and the core WASM on this machine; dist/index.html carries the content security policy and ships the pin file)", cwd: "apps/web", cmd: process.execPath, args: ["scripts/check-artifact-pins.mjs"], env: () => (circuitsBuilt && wasmCore() ? { REQUIRE_PINNED_ARTIFACTS: "1" } : {}) },
  { name: "documentation paths (every backticked repository path in README.md, docs/ and the READMEs exists — planned and historical ones listed in scripts/doc-paths-allowlist.txt —; no path of the pre-V6 layout)", cwd: ".", cmd: process.execPath, args: ["scripts/check-doc-paths.mjs"] },
  { name: "dependency audit (npm audit --omit=dev --audit-level=high over the root workspaces, packages/swap-engine and apps/relayer; an unreachable registry is skipped)", cwd: ".", cmd: process.execPath, args: ["scripts/audit.mjs"] },
  ...(solc ? [{ name: "contracts (forge: 146 incl. V6 ShieldReceiver (15: predict = deploy, the 2300-gas send, dust, the WETH unwrap, foreign and unsupported tokens, re-entry, the fuzzed accounting, the vector shared with TypeScript) and ProtectRouter (20) and the periphery gas bench with its vectors, real-proof e2e, swap periphery with USDT-like orders and refundToken (WETH and ETH at an ERC-20 order re-shield as ETH), native-prover proofs on the verifier)", cwd: "contracts", cmd: process.env.FORGE ?? "forge", args: ["test", "--use", solc], env: ci ? {} : { FOUNDRY_OFFLINE: "true" } }] : []),
  // V6 Stage 5 (spec v2.0 §19): the screenshots against this platform's reviewed baselines and the layout at the ten sizes (local only: Chrome)
  ...(browser ? [{ name: "visual (tests/visual/run.mjs: every fixture at 390x844, 430x932, 768x1024, 1440x900 against the reviewed baselines; no horizontal scroll, the shell's one bar, one primary, 44 px targets at the ten sizes)", cwd: ".", cmd: process.execPath, args: ["tests/visual/run.mjs"] }] : []),
];

/** passed / failed / skipped of one step's output: vitest's "Tests" line, cargo's result lines, Python's unittest, forge */
function countsOf(out) {
  const vitest = [...out.matchAll(/^[ \t]*Tests[ \t]+([^\n]*)\((\d+)\)/gm)].slice(-1)[0];
  if (vitest) {
    const n = (w) => Number(vitest[1].match(new RegExp(`(\\d+) ${w}`))?.[1] ?? 0);
    return { passed: n("passed"), failed: n("failed"), skipped: n("skipped") + n("todo"), total: Number(vitest[2]) };
  }
  const cargo = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length) return { passed: cargo.reduce((a, m) => a + Number(m[1]), 0), failed: cargo.reduce((a, m) => a + Number(m[2]), 0), skipped: cargo.reduce((a, m) => a + Number(m[3]), 0), binaries: cargo.length };
  const forge = out.match(/(\d+) tests passed, (\d+) failed, (\d+) skipped/);
  if (forge) return { passed: Number(forge[1]), failed: Number(forge[2]), skipped: Number(forge[3]) };
  const py = out.match(/Ran (\d+) tests? in/);
  if (py) { const skipped = Number(out.match(/skipped=(\d+)/)?.[1] ?? 0); const failedPy = Number(out.match(/failures=(\d+)/)?.[1] ?? 0) + Number(out.match(/errors=(\d+)/)?.[1] ?? 0); return { passed: Number(py[1]) - skipped - failedPy, failed: failedPy, skipped }; }
  return {};
}

// a failed step's whole output is kept here: a live suite spends rate-limited quota, so a failure must be readable without a rerun
const logDir = join(tmpdir(), "privacy-protocol-verify");
// On the Windows workstation these suites run on, a process that opens many sockets now and then exits natively with
// 0xC0000409 and nothing on stderr. A Winsock layered service provider (a VPN client's) is the likely cause: the API service
// died the same way after four days, and the browser run's harness once. A vitest worker that serves and fetches over HTTP
// does it in about one run in twenty of apps/api (2026-10-14; reproduced with a plain node:http server and fetch, none of
// this repository's code). Such a step runs once more and its line says so. A step with a failing test is never run again.
const workerDied = (out) => /Worker exited unexpectedly/.test(out) && !/^\s*FAIL\s+\S+ >/m.test(out);
const results = [];
for (const [i, s] of steps.entries()) {
  const cwd = join(root, s.cwd);
  if (!existsSync(cwd)) { results.push({ ...s, ok: false, ms: 0, note: "missing directory" }); continue; }
  const t0 = Date.now();
  const extraEnv = typeof s.env === "function" ? s.env() : (s.env ?? {});
  const run = () => spawnSync(s.cmd, s.args, { cwd, encoding: "utf8", shell: process.platform === "win32" && s.cmd !== process.execPath, env: { ...process.env, ...extraEnv } });
  const plain = (x) => ((x.stdout ?? "") + (x.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, ""); // plain text summaries
  let r = run();
  let out = plain(r);
  const rerun = r.status !== 0 && workerDied(out);
  if (rerun) {
    r = run();
    out = plain(r);
  }
  const rerunNote = rerun ? "  [ran twice: the first run's test worker exited natively with no failing test]" : "";
  const cargoRuns = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  // vitest's count line is anchored: its stderr (appended last) opens the failure list with "Failed Tests N"
  const summary = cargoRuns.length > 1
    ? `cargo: ${cargoRuns.reduce((n, m) => n + Number(m[1]), 0)} passed, ${cargoRuns.reduce((n, m) => n + Number(m[2]), 0)} failed across ${cargoRuns.length} test binaries`
    : out.match(/^[ \t]*Tests[ \t]+\d[^\n]*|Ran \d+ test suites[^\n]*|✓ built in [^\n]*|visual: [^\n]*|PASS  dist\/[^\n]*|test result: [^\n]*|Finished `[^\n]*|pkg\/node \+ pkg\/web written[^\n]*|written to [^\n]*|bindings generated[^\n]*|Ran \d+ tests in [^\n]*/gm)?.slice(-1)[0]?.trim();
  let note = summary ?? (r.status === 0 ? "ok" : out.split("\n").filter((l) => /error|FAIL|×/i.test(l)).slice(0, 3).join(" | "));
  if (r.status !== 0) {
    // which tests failed and why: vitest's "FAIL file > suite > test" lines, each with the first error line under it
    const lines = out.split("\n");
    const firstError = (k) => lines.slice(k + 1, k + 15).find((m) => /Error|expected/.test(m))?.trim().slice(0, 300);
    const failing = lines.flatMap((l, k) => (/^\s*FAIL\s+\S+ >/.test(l) ? [`${l.trim()}${firstError(k) ? `  ::  ${firstError(k)}` : ""}`] : []));
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, `${String(i + 1).padStart(2, "0")}-${s.cwd.replace(/\W+/g, "_")}.log`);
    writeFileSync(log, out);
    note = [note + rerunNote, ...failing.slice(0, 10), `full output: ${log}`].join("\n      ");
  }
  results.push({ ...s, ok: r.status === 0, ms: Date.now() - t0, note, counts: countsOf(out), ...(rerun ? { rerun: true } : {}) });
  console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${s.name}  (${((Date.now() - t0) / 1000).toFixed(0)} s)  ${summary ?? ""}${rerunNote}`);
}
if (ledgerFile) {
  const ledger = results.map((r) => ({ step: r.name.split(" (")[0], cwd: r.cwd, ok: r.ok, ...r.counts, ...(r.rerun ? { rerun: true } : {}) }));
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + "\n");
  console.log(`ledger: ${ledgerFile}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${live ? " (incl. live)" : ""}${browser ? " (incl. browser)" : ""}${solc ? " (incl. forge)" : ""}${rust ? " (incl. rust)" : ""}${ci ? " (CI form)" : ""}.`);
for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.note}`);
process.exit(failed.length ? 1 : 0);
