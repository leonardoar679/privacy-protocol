# Frontend — V1 wallet shell (Vite + React + TypeScript + viem)

A consumer wallet shell for the shielded pool (spec §69–73). It demonstrates the UX shape and the
two client-side privacy fixes from the study; the heavy crypto is intentionally stubbed.

> **Status: builds ✅** (`npm install` → `npm run build` run here: `tsc -b` type-checks clean, then
> `vite build` emits `dist/` — 459 modules, ~163 kB JS / ~52 kB gzip). The heavy crypto (client-side
> Groth16 proving) is still a documented stub. `npm audit` reports 2 dev-toolchain advisories
> (esbuild/Vite dev-server only, GHSA-67mh-4wv8-2f99); the production `dist/` is unaffected and the
> fix is a breaking Vite 8 bump, deferred for V1.

## What's here
- `src/App.tsx` + `src/components/*` — Shield / Send privately / Withdraw / PrivateBalance / PrivacyScore.
- `src/sdk/privacyProtocol.ts` — contract ABIs + deposit tx builders. `buildTransact` is a **stub**
  that explains the missing piece: client-side Groth16 proving from `circuits/transaction.circom`,
  submitted over a private channel (never sending the secret to a server, spec §95).
- `src/keys/wallet.ts` — local key derivation. **The raw seed/secret is never persisted to
  dapp-origin `localStorage`** (`assertNotPersistingSecret` enforces it) — the direct fix for TC-01.
- `src/privacy/privacyScore.ts` — ports the research timing/amount/effective-anonymity sims into a
  live score (spec §73).

## Run
```
cd frontend
npm install
npm run dev     # or: npm run build
```

## Deliberately out of scope for the scaffold
Real proof generation (Web Worker + wasm), UTXO selection / note scanning, private submission
transport (L3), and private RPC (L4). These are later stages; the SDK/types are shaped so they can
be added without changing the immutable contracts.
