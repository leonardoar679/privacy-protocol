# Tornado Classic — the threat model

**Status:** V7 Stage 11, 2026-10-27. Spec v3.0 §7 (doc §4.3 E, §4.5, §13). What each party can and cannot do to a
user of the Classic application; the pools' own model is the original's and is not restated (`research/FINDINGS.md`,
`classic/docs/compatibility-matrix.md`).

## What is protected

- The link between a deposit and its withdrawal: only the pool's zero-knowledge proof hides it; the application adds
  nothing to the pool's privacy and takes nothing from it (fixed denominations; "Time passed" and "Subsequent
  deposits" tell the user what the set is worth).
- The note: the only key to a deposit. It exists on the device, once on the screen, in the file the user saves and on
  the clipboard if copied — never in storage, a request, a URL, a log.
- The funds: a withdrawal goes only where the proof says; the fee, the recipient and the relayer are bound in it.

## Who can do what

| Party | Can | Cannot |
|---|---|---|
| The chain (public) | see every deposit and withdrawal, their times, the relayer paid, the recipient | see which deposit a withdrawal spends (the proof) |
| The RPC endpoints (`VITE_CLASSIC_RPC_URLS`) | see the IP address, the pools read, when the history is synced, a disclosed `isSpent` read's nullifier hash; lie about the chain; move a deposit's time (the tree and the count are verified, a timestamp is the source's word: the tenth review round, C10-6; audit gap 111). With one endpoint configured, that endpoint is the user's trust (audit gap 76): dropping a recent deposit and answering `nextIndex()`, `getLastRoot()` and `isKnownRoot` for its own leaves, it has a history verified that says a note has no deposit; calling known a root the pool does not know, it has the user's own wallet-mode `withdraw` revert (some 300,000 gas) or a relayed proof mined as a revert at the relayer's cost, either publishing the nullifier hash beside the recipient. With two or more, the first endpoint alone can still refuse a withdrawal: a root it calls unknown, a read it does not answer | with two or more configured: make the app accept a wrong history — the root is held to the pool's own `isKnownRoot` / `getLastRoot()` and the leaf count to `nextIndex()` at every sync, asked of the first endpoint alone and of the others at the history's block (the eleventh review round, 2026-11-04, C11-12), a disagreement or a silence leaving the history unverified for the page, which blocks withdrawals; have a withdrawal proved on a root only it vouched for — a relayed withdrawal whose root aged out, before its proof or after it, is refused rather than proved again, a wallet-mode one is proved again on a history both endpoints held (the critique of C11-9); have the user's own wallet-mode `withdraw` sent on its word alone (the fifth review round, 2026-11-03: the second must agree on the spent bit right before the send); as the second endpoint, learn a relayed withdrawal's root or its nullifier hash at the withdrawal's moment — the reads that name the note or the proof's root go to the first endpoint alone, never through the failover, and the pool's history is held from syncing from the Withdraw click to the flow's end (C11-9 and its critique) — a hold every page of the device also takes from its records, read again at each sync, while a relayed withdrawal of the pool is unsettled and its record was written in the last 15 minutes (running in another tab, its page closed during it, or ended so), during which Check on chain asks the first endpoint alone —, save two cases: a relayed withdrawal refused for a root that aged out — found before its proof or after it — syncs the history once before its retry, both endpoints asked, and the second then learns the root the retry will use; and one that ended before its relayer's outcome (its answer lost, its job no longer followed) keeps the pool held 15 minutes more (IN_FLIGHT_HOLD_MS), after which the next sync asks both, possibly before the relayer published it. Not covered by the second endpoint: the history's spent marks — its Withdrawal events are the word of the endpoint that served them — until Check on chain, which asks both (the first alone during a hold) |
| The snapshot host (`/classic/data/`) | serve an old, a wrong or no snapshot; move a deposit's time in it (C10-6, audit gap 111) | pass off a wrong tree: every file is hashed to the manifest, the leaves to the commitments, the worker's root to the manifest's, and the whole to the chain; a snapshot whose block the chain does not confirm is refused; none served means a full sync |
| The artifact host (`/classic/artifacts/`) | serve nothing | serve another circuit or key: both pinned by sha256 and size (`classic/src/prover/artifacts.json`, imported by the worker), cached only under the pin |
| The relayer chosen | see the IP address, the recipient, the pool, the proof; refuse; delay; take the fee shown | spend a different note, pay a different recipient, take a different fee (bound in the proof); a FAILED job spends nothing, another relayer or the wallet can be chosen |
| The relayer registry and the router (governance) | disable an instance (the router then refuses; a direct deposit remains possible behind the warning); change the protocol fee a relayer burns | touch a pool: the pools have no owner, upgrade or pause (`operator()` renounced on all four) |
| The browser wallet (EIP-6963) | see the deposit transaction it signs (the commitment, the amount, the router); in wallet mode, the withdrawal it signs | see the note (never handed to it); link the deposit to a relayed withdrawal |
| The served code (the host of `/classic/`) | replace the application | run anything else on the page: the policy allows the origin's scripts and WebAssembly only, no inline script, no eval; the budget and bundle scan hold the build; the pins hold the artifacts — the host's integrity itself is the residual (a content-addressed build or a signed app would close it) |
| Another script in the page (an extension) | read what the page holds while it is open — the note on the screen, the input field | read the worker's memory directly; the proof's inputs cross to the worker as a message the extension could also read in a web page — as in the original |
| The user's device | hold the note on the clipboard, in the saved file, in a screenshot; hold the withdrawal records (relayer, job, transaction) in IndexedDB until the user clears them (History → Clear history) — and, while a relayed record's outcome is unknown, a keyed digest of the note's nullifier hash that can be tested against the pool's public Withdrawal events, until the note's withdrawal paid to the record's relayer completes it or History is cleared (the eleventh review round, C11-1, and its critique) — in the page's memory only when the browser refuses IndexedDB, which History then says (the eleventh review round, C11-5); hold the witness in the prover's memory until the withdrawal ends (the fifth review round, 2026-11-03: the worker is then retired — it answers what was sent to it, its tree requests always, then ends, and its sub-workers zero their scratch; the next request starts a fresh worker, the eleventh review round's critique of C11-6) | hold a deposit's record past its page (the fourth review round, 2026-11-03): it lives in the page's memory — a deposit row beside a withdrawal row on one device is the link the pool exists to hide |
| The Privacy Wallet | link to the application | read or write anything of it: no shared storage, session, secret or code (rule 9) |
| The owner / operator | switch a pool function live or off (`VITE_CLASSIC_LIVE`); switch the sanctions oracle and the geofence (`VITE_CLASSIC_COMPLIANCE_ORACLE`, `VITE_CLASSIC_GEOFENCE`); choose the curated relayers (`classic/relayers.json`) | see a note, a user, an IP: the application keeps no account, no log, no analytics, no error reporter |

## What the application does not attempt

- Hiding the IP address from the RPC endpoints or the relayer (a web build cannot; stated on the screen). Every listed relayer
  is asked for its status when the Withdraw tab or the relayer settings open — not at page load (the second review round,
  2026-11-03) — and the chosen one again right before proving.
- Judging whether a withdrawal's timing is safe (the figures are shown; the choice is the user's).
- Keeping a deposit list (the note is the only key; a device-kept, encrypted list is an owner follow-up).
- Replacing a pool, a verifier or a relayer protocol (nothing but the original's is used).

## Evidence

`classic/docs/security-review.md` §8; the release gate's rungs (`classic/docs/release-gate.md`); the browser run of 2026-10-27
(`scripts/local-stack/results/report-2026-10-27-v7-stage10.json`, section 11).
