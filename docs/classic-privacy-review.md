# Classic Privacy — the dedicated review

**Status:** V6 Stage 14, 2026-10-13. Spec v2.0 §11.3 (doc §52–§53) asks for this document. It covers five things:

- the module's boundary;
- how the note is handled;
- which of the research's Tornado Cash findings apply, and how each is answered;
- what the relayer client checks;
- what still waits for an external security review and for the legal review.

It is written for the owner and for those two reviews.

**Scope.** The module runs on the devnet mock pool. The classic contracts, the circuit port, the proving keys and the
legal review stay deferred by the owner's V5 decision. So:

- No real pool is read.
- No proof is generated.
- No classic relayer is called. The module makes no network request in this pass.

A production build offers no pool at all (C-1, §6).

The research cited here is the Tornado Cash study beside this repository. Its findings register is
`research/FINDINGS.md`: TC-01 to TC-25 and the positive controls TC-P1 to TC-P7.

## 1. The module

| File | Role |
|---|---|
| `apps/web/src/features/classic-privacy/contracts.ts` | `ClassicPrivacyContracts` (`pools()`, `pool(id)`), `ClassicPool`, the devnet `MockPool`, `noClassicContracts` |
| `apps/web/src/features/classic-privacy/relayer.ts` | `ClassicPrivacyRelayer`: zod schemas for `GET /v1/status`, `POST /v1/tornadoWithdraw`, `GET /v1/jobs/:id`; a client over an injected `fetch` |
| `apps/web/src/features/classic-privacy/service.ts` | `ClassicPrivacyService`: pools, this wallet's deposits, a pool's status, deposit, recovery from a pasted note, a prepared withdrawal |
| `apps/web/src/features/classic-privacy/View.tsx` | the pure Views: home, pool status, pool actions, recovery, relayer choice |
| `apps/web/src/features/classic-privacy/ClassicPrivacyUI.tsx` | the screens over the service and the session |
| `apps/web/src/features/classic-privacy/fixtures.ts` | the screenshot fixtures |
| `packages/protocol/src/classic/note.ts` | the note: format, parse, validate, generate |
| `packages/sdk/src/wallet/classicRecord.ts` | the record the journal keeps for a deposit |

**Routes.** `/more/classic` (the pools), `/more/classic/:poolId` (a pool's status, deposit and withdrawal),
`/more/classic/recover` (a deposit found from a pasted note) and `/more/classic/relayers` (the relayer choice with each
relayer's fee and status).

## 2. The boundary

1. **Imports, enforced by rule 8 of `scripts/check-boundaries.mjs`** (verify-all runs it).
   - From outside the app, the module may import only:
     - the session, which keeps its journal field;
     - the record type;
     - the build's configuration;
     - the classic note;
     - the UI kit;
     - the transport;
     - `react` and `zod`.
   - From inside the app, it may import only its words and the hooks.
   - Outside the module, only More's routes, the route table and the fixtures registry may import it.
   - When the rule was written, three planted violations were caught and then removed.
2. **State.** The module's state is the journal's optional `classic` field `{ deposits, relayer? }`.
   - `emptyJournal()` never writes it, so earlier journals and the pinned at-rest vectors stay valid.
   - The protected balance's notes are never touched: the relayer-choice test asserts `journal.notes` stays empty.
   - PrivacyCore is never called.
3. **Place.** The module is reached from More only, never from Home, Swap or Send (spec §7.11, doc §53).
4. **Words.** Before a deposit, five disclosures are shown and accepted with a checkbox:
   - fixed sizes;
   - the note is the only key;
   - deposits and withdrawals are public, and only the link between them is hidden;
   - the relayer's fee;
   - "Classic Privacy uses its own pool and never your protected balance."

   The module's home repeats the last one.
5. **Builds.** The devnet mock runs in a development build only (C-1).

## 3. Note handling

| Step | What happens | Where the note exists |
|---|---|---|
| Generation | 62 bytes from `crypto.getRandomValues`: a 31-byte nullifier and a 31-byte secret, written as `tornado-<currency>-<amount>-<netId>-0x<124 hex>` | the deposit screen's memory |
| Display | Shown once, after the disclosures are accepted, with a Copy button. "I saved the note" must be ticked before the deposit button enables. | the screen; the clipboard if copied |
| Deposit | The pool receives the commitment. The journal records the commitment, leaf index, transaction hash and status, never the note. The journal is encrypted at rest (`docs/wallet-formats.md`). | nowhere in storage |
| Recovery | A pasted note is parsed and matched to its pool by currency, amount and network. Its commitment is computed, its deposit looked up and its nullifier checked, all on this device; the test asserts that nothing is fetched. | the input field's memory |
| Withdrawal | The note, a 0x recipient and an online relayer produce a prepared withdrawal. The proof waits for the circuit port. | memory |

**Inputs.** The note and recipient fields set `autoComplete="off"` and `spellCheck={false}`, because a browser's enhanced
spell check can send a field's text to a server.

**Where the note never goes.** A URL, the history, `sessionStorage`, the console, any service request. The §83 gates
(V6 Stage 15: sessionStorage, the location and history, worker messages, the bundle scan) check the wallet's flows;
the classic screens hold the note in a component's memory only.

**Residual risks**, stated here and not solved in this pass:

- **N-1 Clipboard.** A copied note is readable by clipboard managers, by the operating system's clipboard history and by
  its cloud sync. Recommendation: make a local file download the first backup (a Blob saved by the browser, never
  uploaded) and keep copying as the second.
- **N-2 Display.** A note on screen can be captured by screen sharing or a screenshot. The screen shows it only once,
  after the disclosures.
- **N-3 Nullifier reuse (TC-22).** Classic's nullifier hash binds the nullifier alone. Two deposits that share a
  nullifier can never both be withdrawn: the first withdrawal spends the nullifier hash for both. The wallet draws both
  halves fresh for every deposit, so reuse needs a failure of the random source. The journal keeps the commitment, not
  the nullifier hash, so the wallet cannot check reuse yet (C-2).
- **N-4 The served code (TC-01).** Whoever controls the code the browser runs controls the note when it is generated and
  when it is pasted. The wallet's measures:
  - no third-party script, and self-hosted fonts;
  - a content security policy written into the production build's `index.html` (`apps/web/scripts/csp.mjs`), with
    the server headers of `docs/deployment.md`;
  - the bundle scan (`scripts/scan-bundle.mjs`, V6 Stage 15): no tracker, no source map, no test seed in `dist/`;
  - the runtime artifacts (proving key, core WASM) pinned by hash (`docs/build-hashes.md`).

  What remains is the host's integrity. The upgrade is a signed native app, or a content-addressed build checked
  against its hash.

## 4. The research's findings

**Findings that apply:**

| Finding | Applies here | The module's answer | Status |
|---|---|---|---|
| TC-01: the frontend or device holds the raw note (plaintext in `localStorage` by default) | yes | The note is never stored; the encrypted journal keeps the commitment only. | storage: answered; host integrity: open (N-4) |
| TC-04: timing and amount leaks multiply | yes | Fixed denominations close the amount channel. Timing is left to the user; the disclosure says the pool's size is the whole protection. | open (C-3) |
| TC-05: timing fingerprint | yes | as above | open (C-3) |
| TC-06: amount fingerprint | partly | Deposits are fixed. A withdrawal is the denomination minus the chosen relayer's fee, so a rare relayer fee is a small fingerprint. | by design |
| TC-07: the relayer sees IP, recipient, pool and transaction | yes | Stated in the Privacy Center ("Your IP address is visible to the RPC endpoints and to the relayer"). A web build cannot hide it. | stated limit (R-10) |
| TC-08: the RPC provider sees IP, wallet, pool and timing | at the port | The wallet's read quorum and light client. The pool's event reads must use the same transport under their own purpose. | at the port (R-9) |
| TC-09: trusted-setup toxic waste | at the port | The proving keys' provenance is an external-review item (§7). | at the port |
| TC-10: the 30-root history window | at the port | The mock's pool status shows the root's age (stale after an hour). The port must re-prove against a fresh root once the proof's root leaves the window. | at the port |
| TC-11: relayer gas-drain griefing | relayer side | Not a risk to user funds. A relayer the wallet runs for classic withdrawals must pre-flight with `eth_call`. | the relayer's |
| TC-13, TC-14, TC-16, TC-24: relayer infrastructure (Redis, crash loop, hot key, rate limits) | relayer side | The client trusts nothing past the schema. A FAILED job does not spend the nullifier, so another relayer can be chosen. | the relayer's |
| TC-22: the nullifier hash binds the nullifier alone | yes | Fresh halves for every deposit. | open (C-2) |

**Findings that do not apply:** TC-02, TC-03, TC-12, TC-15, TC-17, TC-18, TC-19, TC-20, TC-21, TC-23 and TC-25. They
concern Nova, governance or the bridge. The module has no governance, no bridge and no upgradeable contract, and the
contracts it adopts must be immutable (TC-P1).

**Positive controls the port must keep:**

- TC-P1: no owner, upgrade or pause.
- TC-P2: no double spend; checks-effects-interactions; reentrancy safety.
- TC-P3: fee, recipient and relayer bound in the proof.
- TC-P5: range discipline in the circuit.
- TC-P6: note keys of about 128 bits, which depends on the random source (Web Crypto here).
- TC-P7: a proof verifies only under its own key.

## 5. Relayer checks

**Checked today** (tested in `apps/web/test/classic-v6.test.tsx`):

- **R-1** A status is parsed by its zod schema.
  - An answer that does not parse reads "unknown" and is never trusted.
  - A non-2xx answer reads "offline", with its HTTP status.
  - The relayer's own error words are kept.
- **R-2** Only an online relayer can be chosen, on the screen and in the service.
- **R-3** A withdrawal request is checked by its schema before it leaves (a hex proof, six arguments, a 0x contract).
- **R-4** A job's answer is parsed, and an unknown state is refused.
- **R-5** The choice is kept in the module's own journal field.

**Before any real relayer is called** (with the port):

- **R-6** The relayer's `netId` is the pool's network, and the pool's contract is listed in its `instances` at the
  configured address.
- **R-7** The proof's public inputs match the user's choices:
  - `relayer` and `fee` are the chosen relayer's reward account and the fee the user saw;
  - `recipient` is the typed address;
  - `refund` is 0 for ETH.

  TC-P3 makes these binding, so the wallet has to compute them correctly.
- **R-8** The fee sits within a cap the user sees before choosing; the status's `tornadoServiceFee` is only the relayer's
  claim.
- **R-9** Requests go through the privacy engine's transport (`packages/privacy-engine/src/transport/http.ts`) under
  their own purpose, so the Privacy Center lists them. Today the client takes an injected `fetch`. Requests get timeouts
  and a bounded job poll.
- **R-10** Before the first withdrawal, the wallet says that the relayer sees the IP address (TC-07).

## 6. Findings of this review

- **C-1 (fixed in Stage 14): the mock pool in a production build.**
  - Before this stage, every build listed the devnet's pools. A production user could have "deposited" into a mock.
  - Now `classicAvailable()` is false in a production build, and the service runs on `noClassicContracts` with no
    relayer.
  - The home reads "Classic Privacy is not available in this build yet: its pools arrive once their contracts have been
    reviewed." Recovery and relayers are not offered.
  - Tested: a production build has no pool, no relayer, and recovers nothing.
- **C-2 (open): no nullifier-reuse check (N-3).** With the port, the journal should keep each deposit's nullifier hash
  (still encrypted at rest), and a deposit should be refused when its nullifier matches one.
- **C-3 (open): no timing guidance for a classic withdrawal.** The protected wallet's timing levels (the note's age and
  the deposits since it) are not applied here. Recommendation: before a withdrawal, show the deposits made since this
  one and suggest waiting while there are few.
- **C-4 (open): the clipboard (N-1).**
- **C-5 (open): the relayer checks R-6 to R-10.**

## 7. What awaits an external security review

- **The circuit port.** The withdraw circuit against the original (Pedersen commitment, MiMC Merkle tree of height 20,
  range checks, TC-P5), and the proving keys' origin (TC-09).
- **The contracts.**
  - Which pools the module talks to, and their immutability (TC-P1).
  - Addresses pinned in configuration, with a fingerprint check like the protocol deployment's
    (`packages/contracts/src/deployments.ts`).
- **The note's handling.** Generation, display, backup, recovery and the clipboard (§3; C-2, C-4).
- **The relayer client against real relayers** (R-6 to R-10).
- **The withdrawal end to end on a testnet,** including a root that leaves the history window (TC-10).
- **The boundary** (rule 8) and the journal field.

## 8. What awaits the legal review

The owner deferred the legal review in V5. This document does not assess legality. The review will need to answer:

- Where the module may be offered, if anywhere, and whether that depends on the region.
- Whether the wallet must screen recipients or deposits.
- The words of the disclosures.
- Which relayers may be listed, and what the wallet's relationship to them is.

Until it concludes, the module stays on the devnet mock, and a production build offers nothing (C-1).

## 9. Evidence

| What | Where |
|---|---|
| the service, the relayer client, the screens, a production build | `apps/web/test/classic-v6.test.tsx` (9) |
| the V5 flows on the mock pool | `apps/web/test/classic-v5.test.tsx` (3) |
| the note's format and vectors | `packages/protocol/test/classic-note.test.ts` (4) |
| the four routes under axe | `apps/web/test/a11y/screens.test.tsx` |
| the four screens at 390x844, 430x932, 768x1024 and 1440x900, reviewed by eye | `tests/visual/baselines/win32/` (`classic*.png`) |
| the boundary | `scripts/check-boundaries.mjs` (rule 8), run by `scripts/verify-all.mjs` |
