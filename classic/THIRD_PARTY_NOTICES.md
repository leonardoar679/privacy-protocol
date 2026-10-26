# Third-party notices — Tornado Classic

The Classic app is licensed under the GNU General Public License v3.0 (`LICENSE`), the licence of the original prover it
vendors (the owner's decision 10 of 2026-10-26; spec v3.0 §7.8). The Privacy Wallet's own packages elsewhere in this
repository are MIT-licensed (`../LICENSE`).

## Vendored (Stage 6 — not yet present)

The original proving stack will be vendored verbatim under `vendor/` with every file's origin and sha256 recorded in
`vendor/VENDORED.md`: tornadocash/websnark at `4c0af6a8` (GPL-3.0), the snarkjs 0.1.20 witness calculator (GPL-3.0),
tornadocash/circomlib at `3b492f9` (GPL-3.0), and BLAKE-256 for the Pedersen generators.

## npm dependencies (runtime)

| Package | Licence |
|---|---|
| react, react-dom | MIT |
| zod | MIT |

The development dependencies (Vite, Vitest, TypeScript, ESLint and their plugins, Testing Library, happy-dom) ship
nothing in the build.
