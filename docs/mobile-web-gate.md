# The mobile-web gate (spec v3.0 §9; doc §13 "Mobile web") — what the wallet guarantees, and the owner's real-device checklist

Small screens, a refresh, a background tab and the handoff to a wallet app are a gate of their own: a phone's browser
freezes a hidden tab's timers, evicts an origin's storage under pressure, and hands the page over to the wallet app in
the middle of a prompt. This page records what the wallet does about each (V7 Stage 16, as landed, with the automated
evidence) and the checks only a real device can give, which are the owner's to run and record below.

## 1. What the wallet does (Stage 16, as landed)

| Rule (spec v3.0 §9) | Where | Evidence |
|---|---|---|
| A `pagehide` locks at once — unless a critical section holds the lock off (a wallet prompt, a proof, a submission, a hand-over: a phone's wallet handoff fires `pagehide` mid-prompt, and the page must come back to an unlocked wallet). Then the lock waits for the hold's release, or past the 30-minute cap for the scheduler's safe point; a `pageshow` before that resumes. | `packages/sdk/src/session/autoLock.ts` (`pageHidden` in the verdict, `pageHide` / `pageShow`), `apps/web/src/platform/autoLock.ts` (the listeners) | `packages/sdk/test/auto-lock.test.ts`, `apps/web/test/auto-lock-v6.test.tsx` |
| A Protect stops prompting the external wallet once the session is locked: what was sent stays sent, nothing more is asked, the record reads `locked_mid_flow` — its own words since the review round of 2026-11-02 (`interrupted` is the page's closing): nothing moved by the missing prompt, at most an approval already confirmed. | `packages/sdk/src/privateTx.ts` (`assertStillUnlocked` before every prompt of `submitShield`), `packages/sdk/src/operations/errors/codes.ts` | `packages/sdk/test/protect-approvals.test.ts` |
| The last connector is reconnected after a reload without a prompt (`eth_accounts`): an EIP-6963 or injected wallet since Stage 4; WalletConnect too — only when its own store holds a session (`hasWalletConnectSession`, the review round of 2026-11-02): then its provider is initialized and restores it; none stored initializes nothing (no relay socket) and stays disconnected. A remembered connector that was present and answered no account is forgotten (`connectorAnsweredNothing`), so no reload asks again; one not present (still announcing, or missing on this browser) is kept. | `packages/wallet-engine/src/{connection,walletConnect}.ts` (`reconnect`, `hasWalletConnectSession`, `connectorAnsweredNothing`), `apps/web/src/app/Providers.tsx` | `packages/wallet-engine/test/wallet-engine.test.ts` |
| WalletConnect declares its icon and where a phone's wallet app returns after signing (`metadata.icons`, `metadata.redirect.universal` = this origin); with a project id the policy allows the modal's wallet list and logos (AppKit's API, the explorer) and the verify iframe — and nothing else, by exact host, never a wildcard (the review round of 2026-11-02: `*.walletconnect.org` had let the telemetry and RPC hosts through): WalletConnect's telemetry (`pulse`), push (`echo`) and RPC (`rpc`) hosts are never allowed, and the test matches them against every source as a browser would. | `packages/wallet-engine/src/walletConnect.ts`, `apps/web/scripts/csp.mjs` (`connect-src`, `img-src`, `frame-src`) | `packages/wallet-engine/test/wallet-engine.test.ts`, `apps/web/test/csp.test.ts` |
| Leaving the page while a hold is live is confirmed by the browser's own dialog first (`beforeunload`); nothing in progress, or a locked wallet, leaves freely. | `apps/web/src/platform/unloadGuard.ts` | `apps/web/test/unload-guard.test.ts` |
| A tab back in view, or back online, runs what came due meanwhile at once — before the next poll of the scheduler. | `apps/web/src/hooks/index.ts` (`useScheduler`) | `apps/web/test/scheduler-runner.test.tsx` |
| `navigator.storage.persist()` is asked for once per page after an unlock; the answer is remembered (persistent, best effort, unsupported) and never throws. | `apps/web/src/storage/persist.ts`, `apps/web/src/app/Background.tsx` | `apps/web/test/storage-persist.test.ts` |
| A second Protect or Send cannot start while one of the kind is still before the chain (waiting for the wallet's answer, proving, submitting): the Review says "We stopped this transaction" with the reason, nothing moves. | `packages/sdk/src/operations/store.ts` (`unresolvedOperation`), the Protect and Send screens (`one_at_a_time`) | `apps/web/test/protect.test.tsx`, `apps/web/test/send.test.tsx` |

What stays as it was: the idle lock (15 minutes by default), the hidden lock (5 minutes), one unlocked tab at a time,
the layout at the ten sizes and the 44 px targets (the visual harness), the offline banner and the scheduler's stop
while offline (spec v2.0 §8, §19, doc §75).

## 2. What only a real device can show (the owner's to run)

The browser run of the local stack drives Chrome on a workstation; none of the following can be reproduced there.
Run each on the devices of §3 with a wallet of the §4 list, against the local stack
(`docs/local-run.md`: the phone on the same network, `VITE_RPC_URLS` and the API pointed at the workstation) or a staging
deployment. Record the outcome in §5.

| # | Scenario | Expected |
|---|---|---|
| 1 | Protect through a wallet app over WalletConnect: tap Confirm, the browser hands over to the wallet app (pagehide), sign there, come back. | The site is still unlocked on return (the hold deferred the pagehide lock); the progress continues to "Added to your protected balance"; the wallet app returned to the site on its own (the `redirect`). |
| 2 | The same, but close the browser tab while the wallet app shows the prompt; reopen the site after a minute. | The lock screen; after the unlock, Activity shows the Protect; within the stale limit it is completed from the chain if the wallet sent it, or marked interrupted (nothing moved) if it did not. |
| 3 | Reload the page in the middle of a Send's proof (desktop browsers; iOS Safari shows no dialog). | The browser's "leave this page?" dialog; Cancel lets the proof finish; Leave — the record reads interrupted, nothing moved (the proof was never submitted) or the chain's answer once reconciled. |
| 4 | Put the tab in the background for six minutes with nothing in progress; come back. | Locked on return (the hidden rule). |
| 5 | Put the tab in the background for six minutes while a wallet prompt is open; answer it; come back. | Not locked before the answer; the transaction is sent; the lock follows at the hold's release (the tab was hidden for more than five minutes) and the record completes from the chain at the next unlock; past the hold's 30-minute cap the lock waits for the safe point instead. |
| 6 | Tap Lock while the wallet app shows the second prompt of an ERC-20 Protect (the deposit after the approval). | The approval stands on chain; the deposit is never asked for; the record reads interrupted; the leftover approval is reported on the next Protect. |
| 7 | Start a Protect, leave the wallet prompt unanswered, go back and start another. | The Review says "We stopped this transaction. Another operation of this kind is still waiting…"; nothing moves. |
| 8 | Reload after connecting (an EIP-6963 wallet; then WalletConnect). | The account chip is back without a prompt; WalletConnect without a new pairing. |
| 9 | Low memory: open other apps until the browser discards the tab; return to it. | The lock screen (the page reloaded); the journal intact after the unlock; Activity complete. |
| 10 | Storage persistence: after an unlock, in the browser's developer tools, `await navigator.storage.persisted()`. | `true` on Chrome once the site has been used (Chrome grants to engaged sites); Safari grants after an interaction; where `false`, the backup file is the guarantee — say so in §5. |
| 11 | The seven screens at 360 × 800 and the phone's own width, portrait and landscape, with the browser's bars shown and hidden. | No sideways scroll, one bar, the primary action reachable (the harness's rules, on the device). |

## 3. Devices and browsers

iOS Safari (the current and the previous major), Android Chrome (current), Samsung Internet (current), and the in-app
browsers of the wallets of §4 where the wallet opens the site itself. Note the OS and browser versions in §5.

## 4. Wallets

An EIP-6963 extension on the desktop control (the browser run already covers it); on the phone: MetaMask Mobile, Trust
Wallet, Rainbow and Coinbase Wallet over WalletConnect (a project id, `VITE_WC_PROJECT_ID`, is needed for the connector
to exist), and each wallet's in-app browser for the injected path.

## 5. Record of runs

None yet — the owner's to run. One row per device and wallet; a scenario that fails names the step and what was seen.

| Date | Device / OS | Browser | Wallet | Scenarios passed | Notes |
|---|---|---|---|---|---|
| | | | | | |

## 6. Known limits

- iOS Safari shows no `beforeunload` dialog: the pagehide rule and the holds are what protect a prompt there (scenario 3
  is a desktop check; scenarios 1, 2 and 5 are the phone's).
- The back-forward cache: entering it is a `pagehide` — locked at once unless a critical section holds the lock off; a page
  restored from it fires `pageshow`, which drops a lock the hold had deferred, and the controller re-evaluates with the real
  clock — a tab hidden for more than five minutes locks on return, as it would without the cache.
- WalletConnect's `redirect` needs a wallet that honours universal links; a wallet that does not leaves the user to switch
  back by hand (the session continues either way).
- A browser that refuses persistent storage keeps the origin on best effort: the recovery phrase and the backup file
  (spec v2.0 §8) are the guarantee, and the checklist's §5 says which browser refused.
- The hand-over hold (commit → hand-over) is released when a runner tick throws and taken again by the next tick of the open
  order (the review round of 2026-11-02): between a failed tick and its retry (ten minutes, doubling) the lock is not held
  off — a wallet idle that long locks, and the retry reconciles before it sends.
- WalletConnect's RPC host is not in the policy (audit gap 64): the wallet reads the chain through its own endpoints, and a
  wallet flow that routed a read there would fail under the policy — the real-device run is where it would show.
- One Protect or Send at a time: the Review's blocker says how the earlier one resolves when its page is gone — the wallet
  settles it from the chain within minutes when it went through a relayer (`STALE_DROP_MS`), up to an hour through the
  wallet (`STALE_DROP_WALLET_MS`); until then the second cannot start.
