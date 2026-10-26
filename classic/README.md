# Tornado Classic

An original-style interface for the existing Tornado Cash Classic pools on Ethereum mainnet (0.1, 1, 10 and 100 ETH),
with the original note format — the second product of the owner's "Privacy Wallet Web V1.1" document, frozen by
`../docs/privacy-wallet-web-spec-v3.0.md` §7. It is **a separate application**: its own `package.json` and
`package-lock.json`, its own Vite build served under `/classic/`, its own content security policy, budget, artifact
pins, tests, word policy and release gate, and its own licence (GPL-3.0 — the vendored original prover's). It shares
nothing at runtime with the Privacy Wallet in `../apps/web`: the design tokens arrive as a generated stylesheet
(`src/tokens.generated.css`, from `../packages/ui/src/tokens/tokens.css`, `npm run tokens`), nothing else crosses
(`../scripts/check-boundaries.mjs`, rule 9).

**Status (V7 Stage 3):** the package, the gates, and the original-style screens on mock data — the Deposit | Withdraw
tabs, the four amounts, the note modal, the withdraw flow with its facts, settings, fee lines and errors, the
Statistics, History and Settings (`docs/parity.md` against the original, element by element) — with the Classic
screenshot harness (`npm run visual`), axe and the word policy. The data behind the screens is `src/model/mock.ts`
until the deployment verification, the cryptography, the history, the relayers and the flows arrive with Stages 5–9;
the end-to-end runs and the release gate with Stages 10–11 (`../docs/roadmap.md`, the V7 table). **No build sends a
transaction** until a pool function is switched live (`VITE_CLASSIC_LIVE`) after its release-gate row and the owner's
legal review (`classic/docs/release-gate.md`, `classic/docs/legal-review.md` — Stage 11): every sending button reads
"Not connected" and the banner says so on every screen.

## Layout

| Path | What |
|---|---|
| `src/config.ts` | the only reader of the build's environment: `VITE_CLASSIC_CHAIN_ID` (1), `VITE_CLASSIC_RPC_URLS`, `VITE_CLASSIC_RELAYER_URLS`, `VITE_CLASSIC_DATA_BASE`, `VITE_CLASSIC_ARTIFACT_BASE`, `VITE_CLASSIC_LIVE` (a JSON object of pool id → functions), `VITE_CLASSIC_COMPLIANCE_ORACLE`, `VITE_CLASSIC_GEOFENCE`, `VITE_CLASSIC_DONATION_ADDRESS` (the address "Donate" fills in; none hides the button) |
| `src/app/` | the controller (`App.tsx`), the routes (`router.ts`: `/classic`, `/classic/deposit`, `/classic/withdraw`, `/classic/history`, `/classic/settings` — no query string, no fragment) and the catalogs (`i18n/`: en, ko) |
| `src/views/` | the pure screens: the shell, the deposit tab and the note modal, the withdraw tab, the Statistics, History, Settings and the availability card, the primitives |
| `src/model/` | the pools, the note, Classic's fee lines, the time words, the formatting, the data-source interface and the Stage 3 mock |
| `src/storage/` | the only module that touches the browser's storage — preferences alone, never a note |
| `src/fixtures/`, `fixtures.html` | the screenshot fixtures, served by `vite --mode fixtures` only and never built |
| `tests/visual/` | the screenshot harness (`run.mjs`) and the reviewed baselines per platform |
| `src/tokens.generated.css`, `src/styles.css` | the Privacy Wallet's tokens (generated) and the app's styles (mobile-first; the Statistics beside the form from 1024 px) |
| `scripts/csp.mjs` | the content security policy (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src` the configured hosts only) |
| `scripts/tokens.mjs`, `scripts/words.mjs`, `scripts/check-deps.mjs`, `scripts/gates.mjs` | the source gates: the tokens up to date, no promise word, every import declared here |
| `scripts/check-dist.mjs`, `scripts/check-budget.mjs`, `scripts/check-pins.mjs`, `scripts/check-build.mjs` | the build gates: the policy meta and the manifest in `dist/`, the first route ≤ 200 KB gzipped without the prover, the artifact pins (`public/artifacts.json`) |
| `docs/` | the compatibility matrix, the original interface's reference captures, the parity table, the release gate |
| `test/` | the suites (`npm test`); `test/live/` and `test/fork/` read the chain and run under `verify-all --live` |

## Commands

```
npm ci                 # its own lockfile (never the root's)
npm run dev            # http://127.0.0.1:5174/classic/
npm run build          # tsc --noEmit, then vite build (dist/, with the policy meta and the manifest)
npm test               # vitest
npm run lint           # eslint
npm run gates          # words, declared dependencies, tokens
npm run check-build    # dist, budget, pins (after a build)
npm run visual         # the screenshot harness (installed Chrome; UPDATE_BASELINES=1 rewrites the baselines — review them)
```

`../scripts/verify-all.mjs` runs every gate above; CI installs this lockfile and runs them too.
