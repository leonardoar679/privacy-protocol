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
| The last connector is reconnected after a reload without a prompt (`eth_accounts`): an EIP-6963 or injected wallet since Stage 4; WalletConnect not (audit gap 112; the eleventh review round, F11-2): the reload check (`hasWalletConnectSession`, the review round of 2026-11-02) reads localStorage, and the WalletConnect this build installs keeps its sessions in IndexedDB — it moves an older build's localStorage session there at its start — so nothing is initialized at a reload (no relay socket) and the chip reads not connected — Connect → WalletConnect then takes up the session WalletConnect still holds, with no pairing (its provider's `enable()`, the eleventh review round, slice 6c); an older build's session left in localStorage is taken up once. A remembered connector that was present and answered no account is forgotten (`connectorAnsweredNothing`), so no reload asks again; one not present (still announcing, or missing on this browser) is kept. | `packages/wallet-engine/src/{connection,walletConnect}.ts` (`reconnect`, `hasWalletConnectSession`, `connectorAnsweredNothing`), `apps/web/src/app/Providers.tsx` | `packages/wallet-engine/test/wallet-engine.test.ts` (the older layout), `apps/web/test/review11-wc-reload.test.ts` (WalletConnect's own storage), `packages/wallet-engine/test/review11-wc-connect.test.ts` (the stored session taken up by a tap, over the real provider) |
| WalletConnect declares its icon and where a phone's wallet app returns after signing (`metadata.icons`, `metadata.redirect.universal` = this origin). A first connection pairs, and the pairing shows in the wallet's own sheet — the QR code for a wallet app on another device, "Open the wallet app" (the `wc:` link) on this one, Cancel — never in the library's modal, whose `<style>` elements the policy refuses (under it the modal took no tap; the eleventh review round, slice 6c): in the connector picker while it is open, else in a sheet of its own; one connection at a time, and a pairing approved after its Cancel is ended at its relay (one already on its way as a WalletConnect retry begins excepted: audit gap 122). With a project id the policy allows WalletConnect's relay and the verify iframe — and nothing else, by exact host, never a wildcard (the review round of 2026-11-02: `*.walletconnect.org` had let the telemetry and RPC hosts through): WalletConnect's telemetry (`pulse`), push (`echo`) and RPC (`rpc`) hosts and the modal's (AppKit's API, the explorer) are never allowed; the test matches the telemetry, push and RPC hosts against every source as a browser would, and finds none of the modal's in `connect-src` or `img-src`. | `packages/wallet-engine/src/{walletConnect,connection}.ts`, `apps/web/src/features/wallet/{ConnectSheet,PairingPanel,PairingSheet,RootPairing}.tsx`, `apps/web/scripts/csp.mjs` (`connect-src`, `img-src`, `frame-src`) | `packages/wallet-engine/test/{wallet-engine,review11-wc-connect}.test.ts`, `apps/web/test/{review11-connect-sheet,csp}.test.ts*` |
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
| 1 | Protect through a wallet app over WalletConnect: tap Confirm, then switch to the wallet app yourself — its notification, or the app switcher: a request opens no app by itself (§6) — (pagehide), sign there, come back. | The site is still unlocked on return (the hold deferred the pagehide lock); the progress ends "Sent — your wallet did not report the result" (WalletConnect gives no receipt under the policy) and the Protect completes within minutes, the amount added to the protected balance; the wallet app returned to the site on its own (the `redirect`). |
| 2 | The same, but close the browser tab while the wallet app shows the prompt; reopen the site after a minute. | The lock screen; after the unlock, Activity shows the Protect; within the stale limit it is completed from the chain if the wallet sent it, or marked interrupted (nothing moved) if it did not. |
| 3 | Reload the page in the middle of a Send's proof (desktop browsers; iOS Safari shows no dialog). | The browser's "leave this page?" dialog; Cancel lets the proof finish; Leave — the record reads interrupted, nothing moved (the proof was never submitted) or the chain's answer once reconciled. |
| 4 | Put the tab in the background for six minutes with nothing in progress; come back. | Locked on return (the hidden rule). |
| 5 | Put the tab in the background for six minutes while a wallet prompt is open; answer it; come back. | Not locked before the answer; the transaction is sent; the lock follows at the hold's release (the tab was hidden for more than five minutes) and the record completes from the chain at the next unlock; past the hold's 30-minute cap the lock waits for the safe point instead. |
| 6 | Tap Lock while the wallet app shows the second prompt of an ERC-20 Protect (the deposit after the approval). | The approval stands on chain; the deposit is never asked for; the record reads interrupted; the leftover approval is reported on the next Protect. |
| 7 | Start a Protect, leave the wallet prompt unanswered, go back and start another. | The Review says "We stopped this transaction. Another operation of this kind is still waiting…"; nothing moves. |
| 8 | Reload after connecting (an EIP-6963 wallet; then WalletConnect, in a page with no WalletConnect Disconnect since it started — audit gap 112). | The account chip is back without a prompt for the EIP-6963 wallet; WalletConnect reads not connected, and Connect → WalletConnect takes up the session it still holds — no new pairing (audit gap 112). |
| 9 | Low memory: open other apps until the browser discards the tab; return to it. | The lock screen (the page reloaded); the journal intact after the unlock; Activity complete. |
| 10 | Storage persistence: after an unlock, in the browser's developer tools, `await navigator.storage.persisted()`. | `true` on Chrome once the site has been used (Chrome grants to engaged sites); Safari grants after an interaction; where `false`, the backup file is the guarantee — say so in §5. |
| 11 | The seven screens at 360 × 800 and the phone's own width, portrait and landscape, with the browser's bars shown and hidden. | No sideways scroll, one bar, the primary action reachable (the harness's rules, on the device). |
| 12 | Connect → WalletConnect on the phone with no session (Home's chip: the picker): the sheet shows the code and "Open the wallet app"; tap it, approve in the wallet app, come back. Disconnect (the chip → Disconnect), then connect again: open the wallet app from the sheet, come back without approving and Cancel; approve the old request in the wallet app, come back to the page, then look at the wallet app's list. Then once more: decline in the wallet app, come back. Then from Welcome's Connect on a fresh install (WalletConnect the phone's only connector): decline once more. | A pairing holds no lock: where the switch to the wallet app fires `pagehide` (row 1), the page comes back to the lock screen with the pairing's own sheet over it while the pairing waits (§6); elsewhere to the picker. Approved: the chip shows the account after the unlock. After the Cancel nothing is connected, and once the page has run again neither session is in the wallet app's list — the first ended by the Disconnect, the late approval at its relay. Declined: over the lock screen, the pairing's own sheet says "The wallet declined the connection." with Try again; in the picker (no `pagehide`, or the code scanned from another device) its words, with WalletConnect listed to choose again. From Welcome, the same sheet. Which app a `wc:` link opens is the system's choice (§6). |

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
- "Open the wallet app" is the pairing's `wc:` link: which app it opens is the system's choice (on iOS the app that registered
  the scheme; Android may ask). A link to a named wallet would need WalletConnect's explorer API, another host the policy does
  not allow; the code stays for a wallet app on another device (scenario 12). And a request — a Protect's approval, its
  deposit — opens no wallet app by itself: WalletConnect's sign client deep-links a request only to a wallet its own modal
  recorded, and the modal is off; the user switches to the wallet app (its notification, the app switcher) to sign (scenario 1).
- A WalletConnect pairing holds no lock (its connection is the public wallet's): on a phone that fires `pagehide` at the switch to
  the wallet app, the protected wallet locks, and the pairing goes on in its own sheet over the lock screen — the chip shows the
  account after the unlock (scenario 12).
- A browser that refuses persistent storage keeps the origin on best effort: the recovery phrase and the backup file
  (spec v2.0 §8) are the guarantee, and the checklist's §5 says which browser refused.
- The hand-over hold (commit → hand-over) is released when a runner tick throws and taken again by the next tick of the open
  order (the review round of 2026-11-02): between a failed tick and its retry (ten minutes, doubling) the lock is not held
  off — a wallet idle that long locks, and the retry reconciles before it sends.
- WalletConnect's RPC host is not in the policy (audit gap 64): the wallet reads the chain through its own endpoints, and a
  wallet flow that routed a read there would fail under the policy — the real-device run is where it would show. A Protect's
  receipts are such reads: the Protect ends "Sent — your wallet did not report the result" (`deposit_unconfirmed`) and its deposit is
  recorded from the pool by a scan half a minute later, or one each minute after it (never held for finality), an ERC-20's approvals
  are read from the first endpoint (audit gap 100; the eleventh review round, F11-10).
- One Protect or Send at a time: the Review's blocker says how the earlier one resolves when its page is gone — the wallet
  settles it from the chain: the pool's own spend event names a transaction whose answer was lost as soon as the next scan
  reads it, and a transaction every endpoint forgot with the notes unspent reads dropped after an hour either way
  (`STALE_DROP_MS`, `STALE_DROP_WALLET_MS`; the sixth review round, 2026-11-03); until then the second cannot start.
- One funding of an order at a time in a tab (the second review round, 2026-11-03): a second caller — Fund now beside the
  runner's tick — is refused as a funding on its way, and the spend's turn reads the journal again; a reconciling tick signs
  and hands over under the hand-over hold like any other.
