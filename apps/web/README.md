# apps/web — the privacy wallet (Vite + React + TypeScript)

A mobile-first wallet for the shielded pool, rebuilt in V6 to the owner's complete document
([`docs/privacy-wallet-web-spec-v2.0.md`](../../docs/privacy-wallet-web-spec-v2.0.md), the normative text; the pass in
`docs/roadmap.md`, V6 table; done means [`docs/definition-of-done-v6.md`](../../docs/definition-of-done-v6.md)). V7
(spec v3.0, [`docs/definition-of-done-v7.md`](../../docs/definition-of-done-v7.md)) added the document's information
architecture (Settings, `/privacy`, the Classic link, the Connect chip), the fee statement, the amount policy, the swap
provider facade, the fifteen operation states and the mobile-web gate; Tornado Classic itself is the separate
application under `../../classic/`.
- **What this package holds.** The screens, the routes, the words, and the platform: the encrypted store, the prover,
  the crypto worker, auto-lock, connectivity.
- **What lives elsewhere.** Every engine is a package beside it: `packages/sdk` (the wallet engine: session, journal,
  notes, private transactions, swaps, operations), `wallet-engine`, `privacy-engine`, `risk-engine`, `protocol`, and
  `ui` (the design system).
- **What leaves the page.** Only a `transact` calldata or a relayed submission. The seed, the keys and the notes never
  do; the leakage gates read every request to prove it.

> **Status (2026-10-14): builds ✅.**
> - 523 vitest, plus 9 in the leakage gate and 6 live.
> - The screenshot harness: 189 screenshots against the reviewed baselines, the layout at ten sizes, the acceptance and
>   accessibility checks.
> - The performance budget: the first route 185.6 KB gzipped of 250, Home 33.1 KB more of 80.
> - All of it through `node scripts/verify-all.mjs` at the repository root. The browser run over the local stack:
>   `docs/local-run.md`.

## The tree (spec v2.0 §4)
```
src/
  config.ts        the only reader of the build's environment (VITE_*): the configuration handed to the engines (configure())
  app/             App.tsx (the data router) · Gate.tsx (locked / unlocked) · Shell.tsx (one bar at a time: the phone's
                   bottom bar or, from 1024 px, the top bar with the Wallet menu) · Providers.tsx · Background.tsx (the
                   scheduler and the runners, loaded after the shell) · notifications.tsx · deployment.ts
                   i18n/ en.ts · ko.ts (every key, its own chunk) · catalogs.ts (+ the partial zh / ja) · locale.ts (the
                   language before the first render) · intl.ts (numbers and dates) · detect.ts · pseudo.ts · useT.ts
  routes/          index.tsx: the onboarding routes, then the shell and every screen behind the gate as lazy routes
  features/        <screen>/View.tsx (pure: a view-model in, callbacks out) · model.ts (the engine → the view-model) ·
                   fixtures.ts (the screenshots) — home · protect · send · swap (SwapScreen: one confirmation; the
                   $50K steps; the V3–V5 protected execution under /swap/protected) · review · progress · activity
                   (windowed) · privacy-center · more (Security, Wallet, Advanced, Language) ·
                   onboarding · operations (the words of the records: progress, recovery cards) · fees · wallet (Home,
                   Receive) · ai · guest
  hooks/           core.ts (the first route's: session, settings, prefs, connection, connectivity) · wallet.ts (Home's
                   data) · index.ts (the rest)
  platform/        autoLock.ts · activeTab.ts (one unlocked tab at a time) · connectivity.ts · crypto/ (the long-lived crypto
                   worker: protocol, engine, worker, client)
  storage/         the encrypted IndexedDB container: secureStore.ts, idb.ts, migrate.ts, prefs.ts, guard.ts
  prover/          client.ts (the proof's entry and the pins) · pins.ts
  fixtures/        registry.tsx + main.tsx: fixtures.html for the screenshot harness (vite --mode fixtures only)
  zkapi/           Private AI on the zkAPI SDK (ZKAPI_SDK_DIR), or a stub that says it is not in this build
  components/      the V1.1–V4 components still mounted (the address book panel, Private AI, the guest swap, the lint);
                   the two nothing mounted since V6 (AssetSelect, PrivateBalance) are gone
scripts/           csp.mjs (the policy and the headers) · pin-artifacts.mjs / check-artifact-pins.mjs · check-dist.mjs ·
                   copy-core-assets.mjs · build-zkapi-assets.mjs / check-zkapi-pins.mjs
public/            artifacts.json (the pins) · core/ (the Rust core's WASM, gitignored) · zkapi/ (gitignored)
test/              523 vitest tests (node; the screens under happy-dom or jsdom) · a11y/ · operations/ · live/ (6)
```

## What the wallet does (spec v2.0 §7)
- **First launch** — Welcome (Connect Wallet, or continue without one), the experience (Simple by default; Advanced
  shows the technical detail), Create (a password; the seed never leaves the device), the 24-word phrase, Home.
- **Home** — the protected balance, the assets, an open operation's card (executing, or action needed — an old failure
  never blocks Home), "Protect your assets" as the one primary action with Send and Swap beside it, the recent
  activity, the privacy badge (→ the Privacy Center) and the gear (→ Security). From 1024 px: the tiles Protect | Send |
  Swap above two columns, Protected assets | Recent activity.
- **Protect** — the 1 % privacy fee through ProtectRouter; "You receive", the fee and the relayer / network cost in
  dollars from the wallet's own estimate.
- **Send** — exact input by default ("Recipient receives" is the largest line), exact output on request. Four checks;
  an address of another chain is never switched silently; a Bitcoin address continues as a cross-chain send.
- **Swap** — the quote as you type (debounced; a superseded request is cancelled). The minimum ("You'll receive at
  least"), the protection, the fees and the time. One confirmation: the order runner funds, checks, signs and hands
  over, and asks again only if the price got worse; an accepted minimum is signed on the very call it was read from.
  Right after a Protect, "Delay for more privacy" funds from notes protected earlier when they cover the swap, and
  otherwise at a random time in 1–24 h. Same-chain swaps land in the protected balance; from $50,000 the steps are
  protected automatically (the four checks, Hold to Confirm or its dialog), and a step already funded finishes on its
  own route when the route changes.
- **Activity** — by day, a page at a time, the detail with its timeline and, when needed, its recovery, read from
  where the money is. The wallet finds its notes in the pool by itself: after an unlock, every ten minutes, and when
  Activity or Receive opens. A private transfer received shows as `Private Receive`; a first launch stays request-free.
- **More** (V7 Stage 4, spec v3.0 §2) — Tornado Classic (a plain link to the separate Classic application under
  `/classic/`), the Privacy Center (seven sections, computed) and **Settings**, one page: Backup & security (the backup,
  auto-lock, the second confirmation, the thresholds, Forget), Connected wallet (the connection through the connector
  picker, the allowances, the Receive address), Trading preference, Language (Automatic, English, 한국어), Experience,
  Notifications, and — in the Advanced experience — Advanced (the deployment check, the light client, the submission
  path, the protected execution's controls); Private AI in the Advanced experience. The old `/more/*` paths redirect.
- **Connect wallet** — in Home's header and in the desktop's Wallet menu: the connector picker lists the wallets this
  browser announces (EIP-6963), the injected wallet and WalletConnect when configured; the last connector reconnects
  after a reload without a prompt. Connecting never creates, unlocks or exposes the protected wallet.
- **Offline** — a banner. Nothing that moves money runs until the network is back, and an answer lost mid-submission
  is found by its nullifier, never sent twice.
- **One tab at a time** — the wallet is unlocked in one tab: another tab waits ("The wallet is open in another tab")
  while the first locks as soon as nothing is in progress there, so two tabs never overwrite each other's records.

## The gates (spec v2.0 §17–§19)
- **Lint.** `npm run lint` runs ESLint over all of `src`: typescript-eslint, the rules of hooks, jsx-a11y strict, and the
  house rules (one reader of the environment, no storage API outside `storage/`, no Radix outside the UI package, no
  inline style and no literal text on a screen, no forbidden word). Views import no engine.
- **Leakage.** `test/privacy-leakage.test.tsx` and `privacy-leakage-worker.test.ts` read every request, provider call,
  worker message, console line and storage for a secret. The swap scenarios do the same.
- **Build checks.**
  - `scripts/csp.mjs`: the policy in `dist/index.html`, the headers on `npm run preview`.
  - `scripts/check-dist.mjs`: no fixtures and no preview in a production build.
  - `../../scripts/scan-bundle.mjs` and `../../scripts/check-budget.mjs`: first-party code only, and the budget.
- **Pins and audit.** `scripts/pin-artifacts.mjs` and `check-artifact-pins.mjs` cover the proving key and the witness
  generator, cached by the crypto worker under their pin. `../../scripts/audit.mjs` runs the dependency audit.
- **Words and access.**
  - `test/i18n.test.tsx` and `i18n-ko.test.tsx`: Korean has every key and no English on a Simple screen.
  - `test/a11y/`: axe on every route and every fixture state, the keyboard through Protect, Send and Swap, the hold and
    its dialog, a sheet's focus.
  - `test/desktop-v6.test.tsx`: every 390 px action at 1440 px.
- **Screenshots.** `../../tests/visual/run.mjs` (`verify-all --browser`).

## Run
`.env.example` lists every setting:
- the deployment: `VITE_RPC_URLS`, `VITE_CORE`, `VITE_ETH_VAULT`, `VITE_CHAIN_ID`, `VITE_SWAP_FACTORY`,
  `VITE_PROTECT_ROUTER`, `VITE_SHIELD_FACTORY`, `VITE_ERC20_VAULTS`;
- the services: the API and the relayer;
- the gateways: the beacon APIs and THORNode;
- the rest: `VITE_WC_PROJECT_ID` for WalletConnect and `VITE_ARTIFACT_BASE`;
- three settings for tests and local runs that a production build never lowers below their defaults: `VITE_HOLD_MS`,
  `VITE_REVIEW_HOLD_MINUTES` and `VITE_KDF_LOG2N` (the keystore's scrypt cost).

```
npm ci                       # at the repository root (one lockfile for every workspace)
cd apps/web
npm run dev                  # http://localhost:5173 (the circuit artifacts and the Rust core served from ../../circuits and ../../privacy-core)
npm run build                # dist/ with the policy in index.html; npm run preview sends the headers
npm test                     # 523 tests; npm run lint
(cd ../api && npm start)     # the API the Swap screen talks to: http://127.0.0.1:8787/v1
(cd ../relayer && npm run serve)   # private submission and the executors: http://127.0.0.1:8790
```
The whole stack on a workstation, with the browser run: `docs/local-run.md`. Deploying a build: `docs/deployment.md`.

## Still open (spec v2.0 §23)
- The native shells and push delivery.
- Biometrics and second-device confirmation (doc §51 "later").
- Tornado Classic itself: a separate application (`../../classic/`, V7) the wallet links to under More; the V6 in-app
  module (a devnet mock) was removed in V7 Stage 11.
- A native speaker's review of Korean.
- Unlocking inside the worker (the seed stays on the main thread).
- LI.FI and Chainflip same-chain routes.
- A private read transport.
- The production ceremony, the audits and a testnet broadcast.

## What came before (V1.1–V5, all still underneath)
The engines now live in `packages/sdk` (V6 Stage 4):
- **V1.1** — the keystore and recovery, fresh addresses, the RPC quorum, private submission through a relayer paid by
  a fee note, merges, the swap signed with a one-time order key, the provider call read before signing, the guest
  swap, ERC-20 assets, the Rust core in the browser, Private AI.
- **V2** — prices and tiers, the destination card and the privacy lint, the Review's controls, the pre-trade
  simulation, settlement tracking, maintenance, "Check this trade".
- **V3–V4** — the campaign engine and runner, the protection screens, the address book, the exposure policy, the
  assessment.
- **V5** — the first design system and shell, the encrypted IndexedDB container, the operation machine, the gates.

The light client (`packages/sdk/src/lightclient/`, `verifiedReads.ts`) checks every spend and rescan against the pool an
Ethereum light client proves at the latest finalized block on mainnet and Sepolia; a devnet has none.
