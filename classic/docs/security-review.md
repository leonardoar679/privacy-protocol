# Tornado Classic — the security review

**Status:** V7 Stage 11, 2026-10-27. Spec v3.0 §7.8, §7.10, §7.11 (doc §4.3 E, §4.5). This document replaces
`docs/classic-privacy-review.md` (V6 Stage 14), which reviewed the in-app module on a devnet mock; that module was
removed in this stage. It covers the Classic application as it stands: the boundary, how the note is handled, which of
the research's Tornado Cash findings apply and how each is answered, the relayer checks, the closure of the earlier
review's open items, and what awaits the external security review and the legal review. The research is the study
beside this repository (`research/FINDINGS.md`: TC-01 to TC-25, the positive controls TC-P1 to TC-P7).

## 1. The application and its boundary

`classic/` is a product apart: its own package and lockfile, its own build under `/classic/`, its own content security
policy, budget, pins, tests, harness and gates, its own licence (GPL-3.0, the vendored provers'). It shares nothing at
runtime with the Privacy Wallet — rule 9 of `scripts/check-boundaries.mjs`: nothing under `classic/` imports a
`@privacy-wallet` package or reaches into `apps/` or `packages/`, and nothing there reaches into `classic/`; the design
tokens cross as a generated stylesheet by a script, the note parser is a twin pinned to the same vectors. It needs no
seed, no unlock, no journal. The Privacy Wallet links to it under More (`<a href="/classic/">`: a full navigation); the
V6 module's old paths lead there.

| Where | What |
|---|---|
| `classic/src/config.ts` | the one reader of the build's environment; the switches (`VITE_CLASSIC_LIVE`, the compliance pair), the development-only settings a production build refuses |
| `classic/src/app/services/` | the services: each pool's history, the relayer directory, the wallet session, the operation adapter, the contract and router facts, the gas price, the compliance pieces, the two flows |
| `classic/src/prover/` | the worker (the vendored stack converted without eval; the trees; a note's hashes), its client, the offline verifier |
| `classic/src/history/`, `classic/src/crypto/`, `classic/src/relayer/`, `classic/src/wallet/`, `classic/src/net/`, `classic/src/storage/` | the modules the services compose; `classic/src/net/` holds every fetch, `classic/src/storage/` every storage API (the lint pins both) |
| `classic/src/views/`, `classic/src/fixtures/` | the screens as pure views, and their fixtures for the harness |

## 2. The note

| Step | What happens | Where the note exists |
|---|---|---|
| Generation | 62 bytes from `crypto.getRandomValues` — a 31-byte nullifier, a 31-byte secret — as `tornado-eth-<amount>-1-0x<124 hex>` (the original's format, `classic/src/model/notes.ts`) | the Deposit tab's memory |
| Display | shown once in the note modal after the original's backup words; **a file download first**, a copy second; "Send Deposit" enables only after "I backed up the note" | the screen; the file the browser saved; the clipboard if copied |
| Deposit | the worker derives the commitment; the router (or the pool, behind the warning) receives it; the record keeps the id, the state, the transaction hash — never the note | nowhere in storage |
| Recovery | a pasted note is parsed; the worker derives its commitment and nullifier hash; the verified history answers found / spent / none — on the device, no request | the input field's memory; the worker's message |
| Withdrawal | the worker proves over the path and the note's bytes; the request to the relayer carries the proof and the six public arguments; the record keeps the relayer's job id, its URL and the states — never the note, never the recipient | memory |
| On-chain check | "Check on chain" asks the pool `isSpent(nullifierHash)` with its disclosure: this read tells the endpoint the nullifier hash | — |

**Inputs** set `autoComplete="off"` and `spellCheck={false}` (an enhanced spell check can send a field to a server).

**Where the note never goes:** a URL, the history, any storage, the console, any request. Evidence: `classic/test/screens.test.tsx`
(the note never in the page after the modal closes, never in the URL, never in storage), `classic/test/flows.test.ts` (the records
without a note or a recipient; the request exactly the relayer's six arguments), the browser run's section 11c
(`scripts/local-stack/e2e.mjs`: 395 requests and 80 bodies read for two notes, none found; the Classic database holds the
history and the job records only; `localStorage` empty; the hosts the origin, the RPC endpoint and the relayer).

**Residual risks** (stated, not solved by software): the clipboard if the user copies (clipboard managers, history, cloud
sync — the file download comes first for this reason); the screen (screen sharing, screenshots — shown once); the served
code (TC-01, §3): whoever controls what the browser runs controls the note when it is generated and pasted — the policy,
the pins, the bundle scan and the budget bound it; the host's integrity remains (the upgrade is a content-addressed build
checked against its hash, or a signed native app).

## 3. The research's findings against the application

| Finding | Applies | The application's answer | Status |
|---|---|---|---|
| TC-01 the frontend or device holds the raw note | yes | never stored; no deposit record; the worker derives the hashes; the policy (`script-src 'self' 'wasm-unsafe-eval'`), the pins (`classic/public/artifacts.json`), the bundle scan, no third-party script or font | storage closed; host integrity open (§6) |
| TC-04 / TC-05 timing leaks | yes | fixed denominations; "Time passed" and "Subsequent deposits" with the original's warnings (under 24 hours, fewer than 5 deposits); the choice is the user's | disclosed, by design |
| TC-06 the amount fingerprint | partly | deposits fixed; a withdrawal is the denomination minus the chosen relayer's fee — a rare fee is a small fingerprint; the curated list shows each fee | by design |
| TC-07 the relayer sees IP, recipient, pool, transaction | yes | the IP notice under the relayer choice; wallet mode as the alternative, with its own warning (the connected account pays the gas: linkable) | stated limit |
| TC-08 the RPC endpoint sees IP, the pool reads, timing | yes | the configured endpoints are shown under Settings; the history is read from a served snapshot where one exists, then the delta; "Check on chain" is disclosed as a read the endpoint sees | stated limit |
| TC-09 the trusted setup | yes | the original's artifacts, pinned (`tornado.json` sha256 `3ddd61db…`, the proving key `8e2d2f22…`); the key's `alfa1`, `beta2`, `delta2` equal `Verifier.sol`'s; provenance beyond that is the ceremony's record | the artifacts' provenance: §6 |
| TC-10 the root window | yes (100, not 30) | the history's root is checked before the proof, the proof's after it and again before the submission; aged out → with two or more endpoints a relayed withdrawal is refused and its retry synced first (C10-14), otherwise synced again and proved again once (`classic/src/app/services/flows.ts`; the fork suite's hundred deposits) | closed |
| TC-11 relayer griefing | relayer side | not a risk to funds | the relayer's |
| TC-13 / TC-14 / TC-16 / TC-24 relayer infrastructure | relayer side | the client trusts nothing past the schema; a FAILED job spends no nullifier — another relayer or the wallet can be chosen; timeouts and a bounded poll | the relayer's |
| TC-22 the nullifier hash binds the nullifier alone | yes | fresh halves for every deposit from Web Crypto; no deposit record exists to compare against (the note is the only key) | by design |
| TC-02, TC-03, TC-12, TC-15, TC-17 to TC-21, TC-23, TC-25 | no | Nova, governance, the bridge — the pools have no owner, no upgrade, no pause (`operator()` renounced on all four, verified) | — |

**Positive controls, verified rather than assumed:** TC-P1 the pools are immutable (the operator renounced; the router
and the registries are governance-controlled and *can* disable an instance — reported apart by the availability model,
never as the pool's own state); TC-P2 no double spend (the pool's `nullifierHashes`); TC-P3 fee, recipient and relayer
bound in the proof (the flows test holds the input the prover receives to the note's own derivation and the user's
choices); TC-P5 range discipline (the original circuit, 28,275 constraints, unchanged); TC-P6 note keys from Web Crypto;
TC-P7 a proof verifies only under its own key (the offline verifier refuses a bent public input; the deployed verifier
accepted the recorded proof).

## 4. The relayer checks

| | Check | Where |
|---|---|---|
| R-1 | a status is parsed by its schema (the string health, nullable instances); an answer that does not parse is "offline", never trusted | `classic/src/relayer/schema.ts`, `classic/src/relayer/client.ts` |
| R-2 | only an online relayer can be chosen, on the screen and in the flow | the relayer directory in `classic/src/app/services/`, `flows.ts` (FlowRefused) |
| R-3 | the request is the validator's: a 512-hex proof, the pool's address, six arguments as bytes32 / address / bytes32 — nothing else | `WithdrawRequestSchema` (strict), `classic/test/relayer.test.ts` |
| R-4 | a job's answer is parsed; the seven states; an unknown one refused; a terminal state ends the follow | `classic/src/relayer/client.ts` `followJob` |
| R-5 | the relayer chosen is kept in the job record (its URL), never a note | `classic/src/app/services/operations.ts` |
| R-6 | `netId` is 1 and the pool is listed in `instances` at the pinned address | `classic/src/relayer/rules.ts` |
| R-7 | the proof's public inputs are the user's choices: `relayer` and `fee` the chosen relayer's reward account and the fee shown, `recipient` the typed address, `refund` 0 | `classic/test/flows.test.ts` (the input equals `prover/input.ts`'s derivation), the fork suite |
| R-8 | the fee under the cap the user sees (20 %) and the relayer's own percentage shown; the relayer re-checks at submission | `rules.ts` `MAX_FEE_PERCENT`, `classic/src/model/fees.ts` |
| R-9 | every request through the app's own transport with a timeout, the job poll bounded; the endpoints and the relayers listed under Settings | `classic/src/net/relayer.ts`, `classic/src/net/rpc.ts`, `FOLLOW_DEFAULTS` |
| R-10 | the relayer sees the IP address: said under the choice | `withdraw.ipNotice` |
| R-11 | the relayers are asked for their status when the Withdraw tab or the relayer settings open — never at page load — and the chosen one again right before proving (the second review round, 2026-11-03) | `classic/src/app/App.tsx`, `RelayerDirectory.refreshOne`, `flows.ts` |

## 5. The earlier review's open items

| Item (V6) | Now |
|---|---|
| C-1 the mock pool in a production build | closed: the module is gone; a production build offers no transaction until a pool function is switched live after this gate and the legal review |
| C-2 no nullifier-reuse check | closed by design: the application keeps no deposit record to compare against; fresh halves from Web Crypto for every deposit (TC-22) |
| C-3 no timing guidance | closed: "Time passed" and "Subsequent deposits" with the original's warnings before every withdrawal |
| C-4 the clipboard | closed: the file download first, the copy second; the note never stored |
| C-5 the relayer checks R-6 to R-10 | closed: §4 |
| C2-1 a mixed-case recipient without its checksum (the second review round, 2026-11-03) | closed: EIP-55 checked when the address carries both cases (`classic/src/model/format.ts`) |
| C2-2 the deposit's pool was the selector's, reachable behind the note modal | closed: the flow refuses a pool that is not the note's; the App deposits into the note's pool |
| C2-3 a relayer answer that did not arrive read FAILED | closed: RECOVERY_REQUIRED with the words to check on chain first; a refusal stays FAILED |
| C2-4 the Withdraw button came back at the confirmation | closed: one flow at a time |
| C2-5 the gas price read once per page | closed: read again every minute and after a flow's message |
| C2-6 canDeposit / canWithdraw unwired | closed: the buttons follow the facts, the flows check them, the note's pool is checked too |
| C2-7 every listed relayer received the IP at page load; the chosen one's status was stale | closed: asked when the Withdraw tab or the relayer settings open, the chosen one again before proving; the notices say so |
| C2-8 a relayed job whose page was gone stayed "Sent" | closed: read again (`jobOf`) when the history is read, never re-submitted |
| C2-9 a crashed prover worker lost every tree until a reload | closed: the tree is loaded again from the device's copy, or built again from the deposits the history holds (the eleventh review round's critique of C11-6); a phone's sub-workers get 1,000 pages |
| C2-10 no on-chain isSpent before a withdrawal | closed: read before proving and again right before anything is sent |
| C10-1 the confirmation followed the mode selected since and named neither the recipient nor the relayer (the tenth review round, 2026-11-04) | closed: the inputs fixed while a flow runs; the confirmation built from the proof's public signals — the recipient in full, the relayer and its account, the fee, what arrives |
| C10-2 a valid note called invalid when the history failed or lagged | closed: a miss says what the history knows — verified up to block N, or not checkable ("This does not mean the note is invalid") |
| C10-3 a relayer's CONFIRMED taken as the outcome | closed: complete once the pool says the note is spent (the flow's own read) or the synced Withdrawal events hold a withdrawal of the record's own note (its keyed digest, kept while the record is open: the eleventh review round, C11-1); "Reported by the relayer" until then |
| C10-4 a late deposit read "did not go through" | closed: kept sent and waiting ("Keep your note"); a revert says nothing was deposited; a reload asked first while a flow is in flight |
| C10-5 the history's own check accepted a root of fewer leaves | closed: the pool's last root exactly at the history's block |
| C10-6 a deposit's timestamp is the source's word | open as stated (audit gap 111) |
| C10-7 "spent" from unverified events hid the chain check | closed: "Check on chain" offered beside the source named; the pool's answer wins |
| C10-8 token contracts passed the recipient rule | closed: WETH, stETH, wstETH and rETH refused by name |
| C10-9 the sanctions switch was a Connect-time check that failed open | closed behind the switch (off): every account screened, a failed read disconnects, the sending account screened before each send |
| C10-10 no chain binding at the send | closed: the wallet's chain read right before every send and named in it |
| C10-11 closing the shared prover ended other pools' work | closed: a close retires the worker — it answers what was sent to it (tree requests always, the rest until CLOSE_DEFER_MS) and ends; later requests go to a fresh worker, whose prover waits for the retired one to be gone (the eleventh review round, C11-6, and its critique) |
| C10-12 the user's own receipts went to the app's endpoint | closed: read through the connected wallet, the app's endpoint only when the wallet answers none |
| C10-13 the spent read ran before the confirmation | closed: only after it, said under the Withdraw button |
| C10-14 a relayed proof on an invented root | closed with two or more endpoints, differently since the eleventh review round (C11-9): a relayed proof's root is its history's, held to both endpoints at the history's sync; the history is held from syncing while a relayed withdrawal runs, so the second endpoint is not asked at the withdrawal's moment; a relayed withdrawal whose root aged out — the history's root is checked before the proof and the proof's after it — is refused, its retry starting on a history synced once more, both endpoints asked, never proved again on a root one endpoint vouched for; one that ended before its relayer's outcome keeps the pool held 15 minutes more. With one endpoint, as stated (audit gap 76): an aged root is synced again and proved again on that endpoint's word (tornado-relayer 4.x checks none) |
| C10-15 the smaller items | closed: a relayer's or a wallet's free text kept as one plain line, a deposit's answer in its own note's modal, the relayers asked only when a withdrawal is live, the router-disabled warning, the tooltip, the snapshot size bound, chain 1 in production, a pool function switched on only with `legal-review.md` clearing it (`classic/scripts/live-gate.mjs`); open as stated (audit gap 111): the backup file's name, History's spent filters, two tabs, Clear history's leftovers |
| C11-1 a relayed record completed by any withdrawal in the relayer's transaction (the eleventh review round, 2026-11-04) | closed: History completes a relayed record only on a Withdrawal event naming its note — through a keyed digest of its nullifier hash kept from the submission until the record ends — paid to its relayer and from its submission's block on; a lost answer, a page closed during the submission and a relayer that forgot the job are settled the same way. The flow itself completes it on the relayer's CONFIRMED and the pool's spent bit (C10-3) |
| C11-2 a served or stored tree's layers trusted as served | closed: a tree is hashed from its leaves by this device before it is trusted; a copy from before the rule is hashed once |
| C11-3 the relayer's account read twice; the proof sent not the one confirmed | closed: the account copied once; a proof made again pays what was confirmed or nothing is sent; a relayer gone offline is sent nothing |
| C11-4 the live gate and the NODE_ENV guard keyed on `--mode production` | closed: every build; one machine-read block in `legal-review.md`, held to its visible table |
| C11-5 a refused or blocked database kept as refused | closed: the memory stores for the page, History saying so; a blocked opening waited for BLOCKED_WAIT_MS; a late connection closed at once |
| C11-6 a deferred close cancelled by any request; the witness kept for the page | closed: the close retires the worker (C10-11 above) |
| C11-7 the account screened not the one that sends | closed: the send refuses another account |
| C11-8 a record left at PREPARING_PROOF by a prover that failed at the note | closed: the note's hashes come before the record |
| C11-9 the second endpoint asked the proof's root seconds before a relayed submission | closed with two or more endpoints: its word taken at the history's syncs, none while a relayed withdrawal runs (its own record writes had started one) nor 15 minutes past an unsettled end — a hold every page of the device takes from its records at each sync while a relayed withdrawal of the pool is unsettled (running in another tab, its page closed during it, or ended so; its record written in the last 15 minutes), during which Check on chain asks the first endpoint alone; the reads that name the note or the proof's root go to the first endpoint alone, a silent one refusing; a relayed withdrawal whose root aged out is refused; two stated exceptions: the retry's sync after that refusal, and the sync after an unsettled flow's 15-minute hold (C10-14 above) |
| C11-10 a pool check that could not read kept for the page | closed: asked again after CHECK_RETRY_MS, the router's fact too |
| C11-11 a relayer's or an endpoint's answer read without a bound | closed: read to RELAYER_ANSWER_MAX and RPC_ANSWER_MAX; the sync halves its window on an answer past it |
| C11-12 one endpoint's word on what a note is | closed with two endpoints: the history's root and count held to both, Check on chain asking both; a disagreement or a silence leaves the history unverified for the page; with one, as stated (audit gap 76) |
| C11-13 the smaller items | closed: a relayer's FAILED for a note the pool reports spent kept open until the note's event; wallet mode screens before any read names the note; an unverified history's statistics and availability row marked; the deposit's words |
| N-4 the served code | open as stated (§2): the policy, pins and scan bound it; the host's integrity remains |

## 6. What awaits the external security review

- The vendored prover's conversion (`classic/scripts/vendor.mjs`: literal replacements over websnark, snarkjs 0.1.20 and circomlib;
  the witness calculator's nested triggering made a queue; `classic/test/vendored.test.ts` hashes every file, `classic/test/prover.test.ts`
  holds the witness to the pristine original's).
- The artifacts' provenance beyond the pinned hashes (the original ceremony).
- The registries' upgradeability (governance can disable an instance or change the protocol fee; never the pool).
- The host's integrity for the served code (§2).
- The mainnet-fork run of `classic/test/fork/withdraw.fork.test.ts` (the release gate's open rung).
- The licence boundary: the GPL-3.0 bundle is served apart from the MIT wallet; `snarkjs` 0.7.6 (GPL-3.0) inside the
  Privacy Wallet's worker is flagged for the owner's lawyer (`docs/audit-package.md`).

## 7. What awaits the legal review

`legal-review.md`: where the interface may be offered, the compliance switches, the relayers listed, the words.

## 8. Evidence

| What | Where |
|---|---|
| the screens, the note never in the page / URL / storage, the switch off | `classic/test/screens.test.tsx`, `classic/test/app.test.tsx`, `classic/test/fixtures.test.tsx` |
| the services, the flows, the wired app | `classic/test/services.test.ts`, `classic/test/flows.test.ts`, `classic/test/app-live.test.tsx` |
| the cryptography, the prover, the vendored files | `classic/test/crypto.test.ts`, `classic/test/prover.test.ts`, `classic/test/prover-client.test.ts`, `classic/test/vendored.test.ts` |
| the history, the snapshot, the sync | `classic/test/history.test.ts`, `classic/test/history-db.test.ts`, `classic/test/net-snapshot.test.ts`, `classic/test/snapshot-script.test.ts` |
| the relayers, the wallet, the call data | `classic/test/relayer.test.ts`, `classic/test/wallet.test.ts` |
| the deployment pins, the configuration, the policy, the gates | `classic/test/deployment.test.ts`, `classic/test/config.test.ts`, `classic/test/csp.test.ts`, `classic/test/gates.test.ts` |
| against mainnet | `classic/test/live/` (`verify-all --live`) |
| end to end | the browser run's section 11 (`scripts/local-stack/results/report-2026-10-27-v7-stage10.json`), `classic/test/fork/withdraw.fork.test.ts` |
| the boundary | `scripts/check-boundaries.mjs` (rule 9), `scripts/verify-all.mjs` |
