# Tornado Classic

An original-style interface for the existing Tornado Cash Classic pools on Ethereum mainnet (0.1, 1, 10 and 100 ETH),
with the original note format — the second product of the owner's "Privacy Wallet Web V1.1" document, frozen by
`../docs/privacy-wallet-web-spec-v3.0.md` §7. It is **a separate application**: its own `package.json` and
`package-lock.json`, its own Vite build served under `/classic/`, its own content security policy, budget, artifact
pins, tests, word policy and release gate, and its own licence (GPL-3.0 — the vendored original prover's). It shares
nothing at runtime with the Privacy Wallet in `../apps/web`: the design tokens arrive as a generated stylesheet
(`src/tokens.generated.css`, from `../packages/ui/src/tokens/tokens.css`, `npm run tokens`), nothing else crosses
(`../scripts/check-boundaries.mjs`, rule 9).

**Status (V7 Stage 2):** the package and the gates. The original-style screens arrive with Stage 3; the deployment
verification, the cryptography, the history, the relayers and the flows with Stages 5–9; the end-to-end runs and the
release gate with Stages 10–11 (`../docs/roadmap.md`, the V7 table). **No build sends a transaction** until a pool
function is switched live (`VITE_CLASSIC_LIVE`) after its release-gate row and the owner's legal review
(`classic/docs/release-gate.md`, `classic/docs/legal-review.md` — Stage 11).

## Layout

| Path | What |
|---|---|
| `src/config.ts` | the only reader of the build's environment: `VITE_CLASSIC_CHAIN_ID` (1), `VITE_CLASSIC_RPC_URLS`, `VITE_CLASSIC_RELAYER_URLS`, `VITE_CLASSIC_DATA_BASE`, `VITE_CLASSIC_ARTIFACT_BASE`, `VITE_CLASSIC_LIVE` (a JSON object of pool id → functions), `VITE_CLASSIC_COMPLIANCE_ORACLE`, `VITE_CLASSIC_GEOFENCE` |
| `src/app/` | the screens |
| `src/tokens.generated.css`, `src/styles.css` | the Privacy Wallet's tokens (generated) and the app's base styles |
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
```

`../scripts/verify-all.mjs` runs every gate above; CI installs this lockfile and runs them too.
