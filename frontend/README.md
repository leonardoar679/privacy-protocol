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

## Out of scope for this build
A light client (the read layer is an RPC quorum, `VITE_RPC_URLS`), a Tor / mixnet transport, and
the native shells (React Native / Tauri: `docs/mobile.md`). Proof generation, note scanning,
UTXO selection and merges, and private submission through a relayer — once listed here — are built
(see above).

## Added in the plan-gap pass (plan §30–§31, §36, §38–§39, §44–§46, §49, §76–§79)
- **Keystore + recovery** (`src/wallet/keystore.ts`, `session.ts`, `journal.ts`, `storage.ts`, `components/Lock.tsx`): create / unlock / lock / restore
  from the 24-word phrase or a backup file; the seed at rest is scrypt + XChaCha20-Poly1305 ciphertext, the note journal (notes, counters,
  fresh-address indexes, swap orders, schedule, settings) is encrypted under a seed-derived key; nothing in storage is ever in the clear.
- **Chain Key Abstraction + Receive** (`src/keys/chainKeys.ts` over `@ref/wallet/chainKeys`, `components/Receive.tsx`): fresh BIP-84 Bitcoin,
  SLIP-0010 Solana and BIP-44 EVM addresses with QR codes, reserved through the journal so none is reused; swaps and withdrawals default to them.
- **Private read layer** (`VITE_RPC_URLS`): every tree view / event set is read from all endpoints and must agree (`syncTreeQuorum`); the public
  balance is read through the injected wallet's own provider.
- **No network at first launch**: `test/first-launch.test.tsx` mounts the app in happy-dom, creates a wallet, opens every tab and asserts zero
  requests (the Pay tab loads only same-origin build files).
- **Scorecard + advanced mode**: six privacy scores on every action (`components/Scorecard.tsx`), plain-words screens by default, "Advanced"
  for leaf indexes, escrows, order keys, proof timings and the submission choice.
- **Swap**: one route in plain words with *View route*, bucket suggestions, a random funding time inside the policy window kept in the journal
  (`src/wallet/schedule.ts`, fires while unlocked; *Fund now* override), open orders resumed through the service's `/order/resume`.
- **Guest mode** (`components/Guest.tsx`): swap without a wallet — a one-time deposit instruction from the service's `/guest/*` routes.
- **Private ERC-20 assets** (plan §36; `src/sdk/assets.ts`, `VITE_ERC20_VAULTS`): ETH plus every token with a canonical vault; asset selectors on Shield / Send / Withdraw / Swap, balances per asset, bucket alphabets per decimals; an ERC-20 shield is an exact-amount approve + the vault's deposit; private transfers / withdrawals / merges / swap funding run in the asset's own vault and pay the relayer in that asset (`fee.vault`). **Relayer failover** (rule 5; `VITE_RELAYER_URLS`): the first relayer that answers, serves this chain / core and takes fees in the asset is used, and the fee note is built for it; transport errors on submit are retried, refusals are not.
- **The Rust core in the browser** (plan §43; `src/sdk/core.ts`): a sync is two batches — every tree layer in one call, note discovery over every payload in one call — and both run in the Rust core's WASM build when it is served from this origin at `/core/` (dev: straight from `../core/rust/pkg/web` through a Vite plugin; build: `npm run core:assets` copies it to `public/core`, gitignored). Loaded lazily on the first sync, never at first launch; when the package is missing the TypeScript reference does the same work (`test/core-wasm.test.ts` runs both paths against one mock core). The synced layers travel with the plan, so witness paths are lookups. "Advanced" shows which core is running.
- **At-rest format vectors** (`test/wallet-vectors.test.ts` → `reference/typescript/test/vectors/wallet.json`, spec `docs/wallet-formats.md`): the keystore, journal and phrase this wallet writes are pinned so the Rust core (and any other wallet) opens the same backup file.
