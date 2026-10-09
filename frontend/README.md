# Frontend — the privacy wallet (Vite + React + TypeScript + viem)

A mobile-first wallet for the shielded pool, rebuilt in V5 on its own design system and shell
([`docs/privacy-wallet-web-spec-v1.0.md`](../docs/privacy-wallet-web-spec-v1.0.md), the normative text; the pass in
`docs/roadmap.md`, V5 table). Everything a user touches is new; everything that moves money is the V1.1–V4 engine
underneath, unchanged: client-side proving in a Web Worker over the normative prover
(`reference/typescript/src/prover.ts`), the encrypted keystore and journal, fresh per-chain addresses, private
submission through a relayer, the swap engine with its six adapters, the campaign engine, the lint, the assessment,
the Privacy Center model. Only the `transact` calldata or a relayed submission ever leaves the page; the seed, the
keys and the notes never do (`test/privacy-leakage.test.tsx` reads every request to prove it).

> **Status (2026-10-08): builds ✅, 406/406 vitest + 6 live, the gates green** (`node scripts/verify-all.mjs` at the
> repository root: the suites, the lint over all of `src`, the privacy leakage gate, the artifact pins, the dependency
> audit, the build with its content security policy). The browser run over the local stack: `docs/local-run.md`.

## The tree (spec §45)
```
src/
  design-system/   tokens.ts → tokens.css (generated, pinned) · base.css · components.css · icons/ (inline SVG)
                   primitives/ (the only files importing @radix-ui: Dialog, Sheet, Tabs, Toast, Switch, RadioGroup, …)
                   components/ (Layout, Money, Inputs, Sheets, Status, Button) · labels.ts (its own words, set by the app)
                   Gallery.tsx (every component in every state; /gallery in dev; axe in test)
  app/             App.tsx (the data router) · routes → routes/index.tsx · Gate.tsx (ready → keystore → unlocked) · Shell.tsx
                   (Home / Swap / Activity / More) · Providers.tsx (deployment, toasts, the locale) · Background.tsx (the
                   scheduler, housekeeping, campaign ticks) · i18n/ (en.ts, messages.ts, detect.ts, catalogs.ts, pseudo.ts)
  features/        onboarding/ (Welcome, the experience, Create / Unlock / Restore, the phrase)
                   wallet/ (connection.ts: EIP-6963, injected, lazy WalletConnect; Home; Receive)
                   protect/ · send/ · swap/ (the quote card, Compare routes, the order panel, the wizard and the protected
                   execution screens) · review/ (the Review before every irreversible moment) · activity/ (the list and the
                   detail) · operations/ (the record, the reducer, the adapters, the error catalog, recovery, progress)
                   fees/ (the fee engine) · more/ (Security, Wallet, Advanced, the More menu) · privacy-center/ (the facts,
                   What stays private?) · classic-privacy/ (the ClassicPool interface, the devnet mock, the screens)
                   ai/ · guest/ (the V1.1 Private AI and guest swap screens, mounted as chunks)
  storage/         idb.ts · secureStore.ts (pp.keystore, pp.journal in IndexedDB; a memory mirror) · migrate.ts · prefs.ts · guard.ts
  api/             transport.ts (credentials omitted, redirects refused, the host allow-list; every request goes through it)
  sdk/             the engine: privateTx (shield / withdraw / transfer / merge / split), relayer, swapService, swapExecute,
                   orderTracker, chain (the RPC quorum, the tree), prices, simulate, swapGuard, swapSign, providerCall,
                   allowances, verifiedReads + lightclient/, core (the Rust core's WASM), assets, tiers, policy, refunds
  wallet/          session, keystore, journal, settings, notes, campaigns, campaignRunner, addressBook, alerts,
                   notifications, activity, schedule, posture, housekeeping, operationRecord, classicRecord
  prover/          client.ts (one worker per proof; the build's pins travel with the request) · worker.ts (snarkjs over
                   @ref/prover; the proving key and the witness generator fetched, hashed and checked: pins.ts)
  keys/ · zkapi/ · privacy/ · components/ (the V1.1–V4 components still mounted: the address book panel, Private AI,
                   the guest swap, the lint, the scorecard, the destination and settlement lines)
scripts/           build-tokens.ts · csp.mjs (the policy and the headers) · pin-artifacts.mjs / check-artifact-pins.mjs ·
                   copy-core-assets.mjs · build-zkapi-assets.mjs / check-zkapi-pins.mjs
public/            artifacts.json (the pins) · core/ (the Rust core's WASM, gitignored) · zkapi/ (gitignored) · manifest
test/              406 vitest tests (node; the screens under happy-dom or jsdom), test/live (6, verify-all --live)
```

## What the wallet does (spec §3)
- **First launch** — Welcome (Connect Wallet or continue without one), the experience (Simple is the default; Advanced
  shows the cryptographic detail), Create (the password; the seed never leaves the device), the 24-word phrase, Home.
- **Home** — the protected balance in USD with its asset rows, Protect / Send / Swap, the recent activity, the
  privacy badge opening the Privacy Center, the gear opening Security.
- **Protect** — a public deposit through the connected wallet's own provider (the balance and the network cost read
  through it, never through the wallet's endpoints); "Service fee: none now".
- **Send** — privately to a `pp1…` privacy address or publicly to a fresh address of this wallet (default) or an
  entered one with the four checks; the fee summary collapsed to one number (the privacy fee, the relayer, "You
  send" / "Recipient receives"); the Review from $20K with the lint, the hold and protected execution from $50K.
- **Swap** — one card, the best protected route, the quote card with the estimate and the minimum, Compare routes
  under Advanced, the Review before every commit, the order panel (Fund now, the hard quote, the simulated execution,
  the hand-over, the tracker), protected execution in steps for large orders (the V3/V4 engine, untouched).
- **Activity** — every operation grouped by day with its status, the detail with its references and the recovery card
  ("Your funds were not moved." / "Your funds are still protected." / "We are checking where your funds are.").
- **More** — Security (the backup, the phrase behind the password, the second confirmation, the large-transfer
  thresholds, Forget), Wallet (the connection, the trade preference, the allowances), Advanced (the deployment, the
  light client, the submission path, maintenance, every protected-execution control, the address book), the Privacy
  Center (the session's facts, computed; "What stays private?"), Classic Privacy (a fixed pool on a devnet mock
  behind a frozen interface), Private AI.

## The gates (spec §20–§21)
- `npm run lint` — ESLint over all of `src`: typescript-eslint, the rules of hooks, jsx-a11y strict, the house rules
  (no storage API outside `storage/`, no `fetch` outside `api/` and `sdk/`, no `window.ethereum` outside
  `features/wallet/`, no Radix outside the primitives, no inline style and no literal text on a screen, no forbidden
  word).
- `test/privacy-leakage.test.tsx` — create → protect → send through the real engine; every request, provider call,
  transport record and console line read for the seed, the phrase, the keys, the private notes' secrets, the keystore
  and the forbidden field names; the swap scenario of `test/swap-flow.test.tsx` does the same.
- `scripts/csp.mjs` — the content security policy built from the build's `VITE_*` hosts and written into
  `dist/index.html`; the headers on `npm run preview`; `docs/deployment.md`.
- `scripts/pin-artifacts.mjs` / `check-artifact-pins.mjs` — `public/artifacts.json` and `docs/build-hashes.md`; the
  prover worker hashes the proving key and the witness generator it fetched and refuses a mismatch in production.
- `../scripts/audit.mjs` — `npm audit --omit=dev --audit-level=high` with `scripts/audit-allowlist.json`.
- `test/i18n.test.tsx` — the locale from the browser, a preference or `?locale=`; the ko / zh / ja partial catalogs;
  no dead English key; the pseudo-locale (`?locale=pseudo`) for the layout checks.
- `test/a11y/screens.test.tsx` — fourteen routes under axe; `test/design-system/a11y.test.tsx` — the gallery.

## Run
`.env.example` lists every setting (`VITE_RPC_URLS`, `VITE_CORE`, `VITE_ETH_VAULT`, `VITE_CHAIN_ID`, the relayer and the
swap service, the beacon and THORNode gateways, `VITE_WC_PROJECT_ID` for WalletConnect, `VITE_ARTIFACT_BASE`).
```
cd frontend
npm install
npm run dev        # http://localhost:5173 (the circuit artifacts and the Rust core served from ../circuits and ../core)
npm run build      # dist/ with the policy in index.html; npm run preview sends the headers
npm test           # 406 tests; npm run lint; node scripts/check-artifact-pins.mjs
(cd ../services/private-swap && npm run serve)   # the Swap screen talks to http://127.0.0.1:8787
(cd ../services/relayer && npm start)            # private submission at http://127.0.0.1:8790
```
The whole stack on a workstation, with the browser run: `docs/local-run.md`. Deploying a build: `docs/deployment.md`.

## Still open (spec §23)
The §81 monorepo move (a mechanical pass); Express + SQLite for the services (recorded as the target; the services are
unchanged but for the relayer's fee terms); the native shells, push notifications and background execution
(`docs/mobile.md`); biometrics beyond WebAuthn; the Classic contracts, circuit port and legal review (the boundary and
the mock only); WalletConnect's relay privacy (disclosed); real ko / zh / ja translations (the catalogs fall back to
English); the production ceremony, audits and a testnet broadcast; a private read transport.

## What came before (V1.1–V4, all still underneath)
- **V1.1** (plan §30–§31, §36, §38–§39, §44–§46, §49, §76–§79): the keystore and recovery (`wallet/keystore.ts`,
  `session.ts`, `journal.ts`; scrypt + XChaCha20-Poly1305; the journal under a seed-derived key), the Chain Key
  Abstraction and fresh addresses (`keys/chainKeys.ts`), the RPC quorum (`sdk/chain.ts`), private submission through
  a relayer paid by a fee note (`sdk/relayer.ts`), merges before a spend (`sdk/privateTx.ts`), the swap signed in the
  browser with a one-time order key (`keys/swapKeys.ts`, `sdk/swapSign.ts`), the provider call read before signing
  (`sdk/providerCall.ts`, `swapGuard.ts`), the guest swap, private ERC-20 assets, the Rust core in the browser
  (`sdk/core.ts`), Private AI on the zkAPI SDK (`zkapi/`, `docs/private-ai.md`), the at-rest vectors
  (`test/wallet-vectors.test.ts`, `docs/wallet-formats.md`).
- **V2** (the whale execution layer): prices through the RPC quorum (`sdk/prices.ts`), the value tiers
  (`sdk/tiers.ts`), the destination card and the privacy lint, the Review with its controls (a tap, a hold, the
  WebAuthn second factor), the pre-trade simulation (`sdk/simulate.ts`), settlement tracking (`sdk/orderTracker.ts`),
  private balance maintenance (`wallet/housekeeping.ts`), "Check this trade" (`zkapi/tradeCheck.ts`).
- **V3** (high-value protection): the campaign engine and runner (`wallet/campaigns.ts`, `campaignRunner.ts` over
  `@ref/wallet/campaign`), the protection screens, the address book with its verification methods and cooling-off,
  alerts and notifications, the separate device at institutional.
- **V4** (the high-value execution engine): the exposure policy and tiers, the assessment, the user's fraction and the
  modes, the opt-out, concentration and velocity, the runner's confirmed / unknown / reorg states.

The light client (`sdk/lightclient/`, `sdk/verifiedReads.ts`) checks every spend and rescan against the pool an
Ethereum light client proves at the latest finalized block on mainnet and Sepolia; a devnet has none and reads rest on
the RPC quorum. A Tor / mixnet transport stays out of scope.
