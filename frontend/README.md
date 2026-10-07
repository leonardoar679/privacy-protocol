# Frontend — V1 wallet shell (Vite + React + TypeScript + viem)

A consumer wallet for the shielded pool (spec §69–73): the UX shape, the two client-side privacy
fixes from the study, and — since V1.1 step 16 — **real client-side proving**: every private
operation (send, withdraw, fund a swap escrow) builds its witness from this session's notes and
proves it in a Web Worker over the normative prover (`reference/typescript/src/prover.ts`); only the
`transact` calldata reaches the connected wallet.

> **Status: builds ✅** (`npm install` → `npm run build` run here: `tsc -b` type-checks clean, then
> `vite build` emits `dist/` — 503 modules, ~467 kB main / ~462 kB proving worker (snarkjs), both
> free of node-only references). The prover itself is verified in node against the real circuit
> artifacts (`reference/typescript/test/prover.test.ts`: it reproduces the forge-verified e2e public
> inputs bit for bit and proves a fresh withdrawal in ~1 s); the browser flow could not be exercised
> on this machine (no browser, no reachable chain), so the UI wiring is type-checked, not clicked. `npm audit` reports 2 dev-toolchain advisories
> (esbuild/Vite dev-server only, GHSA-67mh-4wv8-2f99); the production `dist/` is unaffected and the
> fix is a breaking Vite 8 bump, deferred for V1.

## What's here
- `src/App.tsx` + `src/components/*` — Shield / Send privately / Withdraw / PrivateBalance / PrivacyScore.
- `src/sdk/privacyProtocol.ts` — contract ABIs, deposit tx builders and `buildTransact` (the
  `PrivacyCore.transact` calldata for a locally produced proof: abi.encode(a, b, c) + the 14 public
  inputs + 3 payloads).
- `src/prover/` — `worker.ts` (snarkjs browser build over `@ref/prover`), `client.ts` (one worker per
  proof; artifacts from `/artifacts/*`, served in dev by the Vite plugin from `../circuits`, or
  `VITE_ARTIFACT_BASE`). `src/sdk/chain.ts` — deployment from env (`VITE_RPC_URL`, `VITE_CORE`,
  `VITE_ETH_VAULT`, `VITE_CHAIN_ID`), tree rebuilt from `NoteInserted` events and checked against the
  core's root, submission via the injected wallet. `src/sdk/privateTx.ts` — shield, private transfer
  and private withdrawal end to end (UTXO selection, change note, placeholder payloads, prove,
  submit, record the new leaves). `src/wallet/notes.ts` — the session note store (memory only).
  Formerly `buildTransact` was a stub that explained the missing piece: client-side Groth16 proving from `circuits/transaction.circom`,
  submitted over a private channel (never sending the secret to a server, spec §95).
- `src/keys/wallet.ts` — local key derivation. **The raw seed/secret is never persisted to
  dapp-origin `localStorage`** (`assertNotPersistingSecret` enforces it) — the direct fix for TC-01.
- `src/privacy/privacyScore.ts` — ports the research timing/amount/effective-anonymity sims into a
  live score (spec §73).
- **V1.1 `src/components/Swap.tsx` — "Swap privately"** (spec v1.1, plan §68): quotes every provider
  through the local service (`services/private-swap`: `npm run serve`), ranks them by policy with the
  engine's scores and the cross-chain privacy score, commits an order whose source is a one-time
  escrow (the withdrawal recipient), and **signs the provider call in the browser** with a one-time
  order key (`src/keys/swapKeys.ts`, derived from the master seed per attempt; refund note = the
  wallet's own commitment via `@ref/note`). The service only ever sees the signer address and the
  signature (verified there by recovery). Order of operations (spec §5/§8): **1 ·** a real
  private withdrawal proved in the worker funds the escrow; **2 ·** only then the tab re-quotes with the
  escrow as sender, signs the provider call with the one-time key and hands (factory, params, signed
  execution, refund payload) to the relayer's swap executor, showing its state (Pending / Executing /
  Completed / Refunding / Refunded / Failed) every 15 s and offering "Re-sign with a fresh quote" when
  the executor reports the signed quote expired.

## Run
`.env.example` lists every setting; `docs/local-run.md` is the end-to-end order on a workstation.
```
cd frontend
npm install
npm run dev     # or: npm run build
(cd ../services/private-swap && npm run serve)   # the Swap tab talks to http://127.0.0.1:8787 (VITE_SWAP_SERVICE to override)
```

- **`src/zkapi/` + `src/components/PrivateAI.tsx` — Private AI (plan step 04)** on the zkAPI browser
  SDK (`@openanonymity/zkapi-browser-sdk`, the pinned sibling clone as a `file:` dependency): runtime-key
  mode only (`privateTransport` refuses proxying), a fresh seed-derived funding address exposed to the
  SDK as an EIP-1193 provider and funded by a private withdrawal from the pool, credit buckets,
  spending tiers, streaming chat straight to OpenRouter, mutual-close withdrawal. Build the SDK assets
  and run the deployment-pin check before using the tab:
  `ZKAPI_NETWORK=sepolia npm run zkapi:assets && npm run zkapi:pins` (writes `public/zkapi/`, gitignored;
  the tab stays disabled without a passing, recent `pin-check.json`). Dev server proxies
  `/zkapi-deployment/*` to the network's protocol server. The Sepolia shared-password dialog is wired.
  Details and status: `docs/private-ai.md`.
- **Private submission** (`src/sdk/relayer.ts`, `src/wallet/settings.ts`): by default every private
  transaction goes to a relayer (`VITE_RELAYER_URL`, default `http://127.0.0.1:8790`; `services/relayer`)
  that submits it from its own key and is paid by a private fee note the wallet adds as an output
  (encrypted to the relayer's privacy address, priced from the relayer's live minimum + 10 %); the
  connected wallet is the public fallback, switchable in the app header.
- **Merges**: the circuit spends at most two notes, so a spend that needs more first merges pairs with
  private self-transfers (`mergeSchedule` / `planMerge` / `ensureSpendable` in `src/sdk/privateTx.ts`),
  each paying the relayer fee; the schedule accounts for those fees and refuses honestly when they eat
  the balance. Withdrawals and transfers run the merges automatically before the final spend.
- **`npm test` — 27 node tests** of the non-UI glue (`test/`): zkAPI transport policy + pin gate + SSE
  parsing, the fresh funding provider signing against a local mock JSON-RPC server, tree sync vs the
  reference Merkle tree, note discovery from envelopes on a mock chain (ours found, others' not, spent
  state from the nullifier set), withdrawal planning (incl. the relayer fee note) and merge planning
  through the reference witness builder, the relayer client against a mock relayer.

## Still open
Payloads are the spec §12 envelope (view key → X25519, XChaCha20-Poly1305; `docs/crypto-spec.md`):
notes are recovered from chain by rescanning ("Rescan the chain for my notes"), senders use the
recipient's `pp1…` privacy address; submission goes to a relayer by default (the connected wallet is the
public fallback); no live-chain run has happened here; the dev proving key is insecure.

## Deliberately out of scope for the scaffold
Real proof generation (Web Worker + wasm), UTXO selection / note scanning, private submission
transport (L3), and private RPC (L4). These are later stages; the SDK/types are shaped so they can
be added without changing the immutable contracts.
