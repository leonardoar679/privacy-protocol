# Tornado Classic — the release gate

**Status:** V7 Stage 11, 2026-10-27. Spec v3.0 §7.10 (doc §4.3 E, §13). One row per pool and per function. A pool
function may be switched live (`VITE_CLASSIC_LIVE`, spec §7.7) only when every rung of its row is green **and** the legal
review is recorded (`legal-review.md`). Until then every build offers no transaction: the screens work on real data and
every sending button reads "Not connected — interface prototype, pending verification and legal review" (doc §4.4).

## The rungs

| Rung | What it proves | Evidence | How it is run again |
|---|---|---|---|
| **Contract** | the pool at its mainnet address runs the code of the Sourcify-verified source (solc 0.5.11, rebuilt with the pinned compiler and compared modulo the Hasher link and the metadata hash); its verifier is `0xce17…557a`, 20 levels, the denomination, the operator renounced, `ROOT_HISTORY_SIZE` 100; the router and the two registries named | `classic/src/config/deployment.json` (read at block 26,278,752 on 2026-10-26), `classic/docs/deployment-verification-2026-10-26.md`, `classic/test/deployment.test.ts`, `classic/test/live/deployment.live.test.ts`; the app verifies the pins against the chain at start (`classic/src/app/services/contract.ts`: the code **bytes** hashed, Stage 10) | `npm run verify-deployment -- --write`; `verify-all --live` |
| **History** | the tree hash and the insertion semantics are the chain's: every pool's frontier plus its last deposit hash to `getLastRoot()`; the 100 ETH pool's whole history (49,628 leaves to block 26,279,460) hashes to a root the pool knows with `nextIndex()` the leaf count; the delta sync with checkpoints and rollback; the one check before every withdrawal | `classic/test/history.test.ts`, `classic/test/live/history.live.test.ts`, `classic/docs/compatibility-matrix.md` §12; the devnet (Stage 10): the chain's `hashLeftRight` through the Hasher equals the app's before any deposit | `verify-all --live`; `npm run snapshot -- --pool <id>` |
| **Prover** | the vendored original (websnark 4c0af6a8, snarkjs 0.1.20, circomlib 3b492f9) converted without eval proves what the deployed verifier accepts: the recorded proof accepted by `0xce17…557a` through `eth_call`; the witness equal to the pristine original's signal for signal; proofs in Node and in Chrome under the built policy; a deposit and a withdrawal with the real bytecode on the devnet in the browser (Stage 10, 234/234) and in Node (the fork suite's devnet mode, incl. the root aging out of the pool's hundred) | `classic/vendor/VENDORED.md`, `classic/test/vendored.test.ts`, `classic/test/crypto.test.ts`, `classic/test/prover.test.ts`, `classic/test/live/verifier.live.test.ts`, `classic/tests/prover/run.mjs`, `scripts/local-stack/results/report-2026-10-27-v7-stage10.json`, `classic/test/fork/withdraw.fork.test.ts` | `verify-all --live --browser`; `npm run test:fork` |
| **Prover on a mainnet fork** ⏳ | the same deposit and withdrawal through the real router and registry against mainnet's real state | `classic/test/fork/withdraw.fork.test.ts` in fork mode — **not run yet**: a fork node cannot start on the development workstation (Hardhat's fork engine dies at start, as anvil does there); the owner's run on another machine | `npx hardhat node --port 8547 --fork <mainnet rpc>` in `scripts/local-stack`, then `CLASSIC_FORK_RPC=http://127.0.0.1:8547 npm run test:fork` |
| **Relayer** | the curated relayers come from the registry (`RelayerRegistered`, the ENS `url` record, the stake) and pass the protocol's rules (healthy, mainnet, the four pools at the pinned addresses, the registered reward account, a fee under the cap, a queue of at most five, 4.1.4+ / 5.x); the request as the relayer's validator wants it; the call data held to real transactions | `classic/relayers.json` (23 online, 2026-10-26), `classic/test/relayer.test.ts`, `classic/test/live/relayers.live.test.ts`, `classic/docs/compatibility-matrix.md` §13 | `npm run relayers`; `verify-all --live` |
| **Leakage** | no note in any request body or URL, console line, storage write or page after the modal closes, during deposit, recovery and withdrawal; the Classic database holds the history and the job records only; `localStorage` holds the language choice alone (`tornado-classic:locale`); no host but the origin, the RPC endpoints and the chosen relayer | `classic/test/screens.test.tsx`, `classic/test/app-live.test.tsx`, `classic/test/flows.test.ts` (the records without a note or a recipient), the browser run's section 11c (`scripts/local-stack/e2e.mjs`: 395 requests read, two notes, none found; the hosts) | `scripts/local-stack` quick pass with `CLASSIC_FULL=1` |
| **Build** | the policy (`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src` the configured hosts and the curated relayers), the budget (the first route under 200 KB gzipped, no prover, no WASM, none of the vendored arithmetic), the pins, no source map, the bundle scan, the dependency audit and review, the word policy | `classic/scripts/check-build.mjs`, `classic/scripts/gates.mjs`, `scripts/scan-bundle.mjs classic/dist`, `scripts/verify-all.mjs` (the Classic steps), CI's `classic` job | `verify-all` |
| **Legal** ⏳ | the owner's legal review recorded: where the app may be offered, the sanctions oracle and the geofence (`VITE_CLASSIC_COMPLIANCE_ORACLE`, `VITE_CLASSIC_GEOFENCE`, both off), the wording, the relayers listed | `legal-review.md` — **empty until it concludes** | the owner |

## The rows (2026-10-27)

| Pool | Function | Contract | History | Prover | Relayer | Leakage | Build | Legal | `CLASSIC_LIVE` |
|---|---|---|---|---|---|---|---|---|---|
| 0.1 ETH `0x12d6…b8fc` | deposit | ✅ | ✅ | — | — | ✅ | ✅ | ⏳ | **off** |
| 0.1 ETH | withdraw | ✅ | ✅ | ✅ (fork ⏳) | ✅ | ✅ | ✅ | ⏳ | **off** |
| 1 ETH `0x47ce…2936` | deposit | ✅ | ✅ | — | — | ✅ | ✅ | ⏳ | **off** |
| 1 ETH | withdraw | ✅ | ✅ | ✅ (fork ⏳) | ✅ | ✅ | ✅ | ⏳ | **off** |
| 10 ETH `0x910c…9dbf` | deposit | ✅ | ✅ | — | — | ✅ | ✅ | ⏳ | **off** |
| 10 ETH | withdraw | ✅ | ✅ | ✅ (fork ⏳) | ✅ | ✅ | ✅ | ⏳ | **off** |
| 100 ETH `0xa160…f291` | deposit | ✅ | ✅ | — | — | ✅ | ✅ | ⏳ | **off** |
| 100 ETH | withdraw | ✅ | ✅ | ✅ (fork ⏳) | ✅ | ✅ | ✅ | ⏳ | **off** |

A deposit needs the contract, the chain, the router (or the direct fallback behind its warning) and the wallet; a
withdrawal needs the history, the prover and a relayer or the wallet too (`classic/src/model/availability.ts`). The
availability card says, per pool and right now, what is verified, enabled, online, synced, ready and connected — the
gate here says what may be switched on at all.

## Switching a function on

1. Every rung of the row green, the fork rung included, at a block recorded in the matrix.
2. `legal-review.md` filled in: the reviewer, the date, the scope, the outcome, the conditions, the pool functions cleared and
   the owner's sign-off; the compliance switches as the review decides; and its `classic-live-gate` block set to the same
   outcome and pool functions (the build refuses a block the table does not match, and a table without the block).
3. The build's `VITE_CLASSIC_LIVE` names the pool and the function (`{"eth-1":["withdraw"]}`); nothing else changes.
   `VITE_CLASSIC_DEPLOYED_BLOCK` and `VITE_CLASSIC_RELAYERS_CURATED=0` are development settings a production build refuses.
4. `npm run build`, `npm run check-build`, `verify-all --live --browser`; the host's headers checked (docs/deployment.md,
   the `/classic/` location) and the Chrome prover bench under the built policy.
5. The row in this file updated with the date and the build's hash; the roadmap row.

## What stays off regardless

Classic never calls `PrivacyCore` or a vault; the Privacy Wallet never calls a pool or the router; no note crosses
between the two; the wallet's 1 % is never applied; no pool is replaced by another contract (spec §7.11). A user-typed
relayer URL is an owner follow-up (it cannot pass the strict policy). A deposit list kept on the device is an owner
follow-up too: today the note is the only key, as in the original's IPFS mode.
