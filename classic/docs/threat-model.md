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
| The RPC endpoints (`VITE_CLASSIC_RPC_URLS`) | see the IP address, the pools read, when the history is synced, a disclosed `isSpent` read's nullifier hash; lie about the chain | make the app accept a wrong history: the root is held to the pool's own `isKnownRoot` / `getLastRoot()` and the leaf count to `nextIndex()` (a lying endpoint can only make the history "unverified", which blocks withdrawals) |
| The snapshot host (`/classic/data/`) | serve an old, a wrong or no snapshot | pass off a wrong tree: every file is hashed to the manifest, the leaves to the commitments, the worker's root to the manifest's, and the whole to the chain; a snapshot whose block the chain does not confirm is refused; none served means a full sync |
| The artifact host (`/classic/artifacts/`) | serve nothing | serve another circuit or key: both pinned by sha256 and size (`classic/src/prover/artifacts.json`, imported by the worker), cached only under the pin |
| The relayer chosen | see the IP address, the recipient, the pool, the proof; refuse; delay; take the fee shown | spend a different note, pay a different recipient, take a different fee (bound in the proof); a FAILED job spends nothing, another relayer or the wallet can be chosen |
| The relayer registry and the router (governance) | disable an instance (the router then refuses; a direct deposit remains possible behind the warning); change the protocol fee a relayer burns | touch a pool: the pools have no owner, upgrade or pause (`operator()` renounced on all four) |
| The browser wallet (EIP-6963) | see the deposit transaction it signs (the commitment, the amount, the router); in wallet mode, the withdrawal it signs | see the note (never handed to it); link the deposit to a relayed withdrawal |
| The served code (the host of `/classic/`) | replace the application | run anything else on the page: the policy allows the origin's scripts and WebAssembly only, no inline script, no eval; the budget and bundle scan hold the build; the pins hold the artifacts — the host's integrity itself is the residual (a content-addressed build or a signed app would close it) |
| Another script in the page (an extension) | read what the page holds while it is open — the note on the screen, the input field | read the worker's memory directly; the proof's inputs cross to the worker as a message the extension could also read in a web page — as in the original |
| The user's device | hold the note on the clipboard, in the saved file, in a screenshot; hold the withdrawal records (relayer, job, transaction) in IndexedDB until the user clears them (History → Clear history) | hold a deposit's record past its page (the fourth review round, 2026-11-03): it lives in the page's memory — a deposit row beside a withdrawal row on one device is the link the pool exists to hide |
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
