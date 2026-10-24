# Build hashes — the runtime artifacts and their pins (Privacy Wallet Web spec §20)

`apps/web/public/artifacts.json` is served beside the app; the prover worker (`src/prover/pins.ts`) hashes the proving key it fetched and
refuses a mismatch in a production build (a warning in dev). `node scripts/check-artifact-pins.mjs` (verify-all's "apps/web artifact pins"
step) recomputes every pinned file on the machine. Regenerate with `node scripts/pin-artifacts.mjs` after a circuit build, a core build or a
ceremony, and commit both files.

Pinned at 2026-10-24T14:12:24.934Z. Setup: circuits/setup/dev — the insecure single-party development setup; a production ceremony replaces the proving key and this pin.

| artifact | served at | SHA-256 | bytes | source |
|---|---|---|---|---|
| `transaction.wasm` — the circuit's witness generator (circom → wasm) | `/artifacts/transaction.wasm` | `6abe5463c45b3b830e1e925a2ef150bc2af680aa169990ca1998b4323ba5af02` | 207,764 | `circuits/build/transaction_js/transaction.wasm` |
| `transaction_final.zkey` — the Groth16 proving key (dev: the insecure single-party setup of circuits/setup/dev) | `/artifacts/transaction_final.zkey` | `099f5a9634ef8377f7de700cbdae001def21a504b1a399f4828cf8db7a7890f7` | 30,784,288 | `circuits/build/setup/transaction_final.zkey` |
| `verification_key.json` — the verification key the wallet checks a proof against before submitting it | `/artifacts/verification_key.json` | `f42740257b9f7eb4ee8e16f1fbc0f07c5cbd439f16180c8fe165acb29aa4963f` | 5,311 | `circuits/setup/dev/verification_key.json` |
| `privacy_core_wasm_bg.wasm` — the Rust core (Poseidon2, the layered tree, note discovery) compiled to WASM | `/core/privacy_core_wasm_bg.wasm` | `91fe1384ccd6ec79f3facd219a3c415675c86755f0987e590c32b04d532acb73` | 560,925 | `apps/web/public/core/privacy_core_wasm_bg.wasm` |
| `privacy_core_wasm.js` — the WASM package's JavaScript glue (wasm-bindgen) | `/core/privacy_core_wasm.js` | `e298b84b30f778885eb366706380a106c37f78cd1612e40f8d91a52285e1365b` | 26,853 | `apps/web/public/core/privacy_core_wasm.js` |
