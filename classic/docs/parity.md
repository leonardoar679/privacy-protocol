# Parity with the original interface (Workstream D, part 1)

V7 Stage 3 (2026-10-26). The reference is the original's built output captured in Stage 1
(`classic/docs/original-ui-reference.md`: `tornadocash/ui-minified` `7aeae4a5` at 390 × 844 and 1440 × 900, each
state's text and controls in `classic/docs/reference/inventory.json`) and the words of the archived source
(`classic/docs/compatibility-matrix.md` §6). The Classic app's screens are the pure views in `classic/src/views/`,
rendered on the Stage 3 mock (`classic/src/model/mock.ts`: the four pools with the deposit counts read on chain on
2026-10-26, two fixture notes, three relayers, a 12 gwei gas price). The fixtures in `classic/src/fixtures/registry.tsx`
hold every state below; `classic/tests/visual/run.mjs` screenshots them into `classic/tests/visual/baselines/win32/`.

**No build of this stage sends a transaction.** Every screen carries the banner of spec v3.0 §7.7, every sending button
reads "Not connected", and the availability card in Settings says what this build has verified: nothing yet.

## Element by element

| The original (ui-minified) | The Classic app (V7 Stage 3) | Status |
| --- | --- | --- |
| One page `/` with the **Deposit \| Withdraw** tabs (Buefy tabs, no URL per tab) | `/classic` (the deposit tab), `/classic/deposit`, `/classic/withdraw` — a `tablist` of two tabs, each a route; History and Settings as pages under `/classic/history`, `/classic/settings` | same structure; the tabs now have the URLs the owner's document names (doc §3) |
| The two notices: the public-gateway warning; "Tornado.cash was audited. However, it is still an experimental software. Please use at your own risk." | one notice: "Not connected — interface prototype. Live contract, note-generation and transaction functionality is subject to verification." (spec §7.7), on every screen | replaced by the honest state of this build |
| Header (desktop): Voting, Compliance, Docs, the network selector (Ethereum), the wallet button (Not connected / Connect), the Note Account button, Settings | header: the brand, the network chip (Ethereum), the wallet chip (Not connected — the connection arrives with Stage 8), the History and Settings links | reduced: Voting, Compliance, Docs and the Note Account are not copied (the matrix §7: the note account and the compliance PDF) |
| **Token** (ETH) | the Token select (ETH) | same |
| **Amount** as a slider with four stops: 0.1 ETH · 1 ETH · 10 ETH · 100 ETH | four stops as a radio group on a line, 44 px targets, the selected stop filled | same words; a control a thumb can hit |
| The (i) tooltip "Each amount is a standalone Tornado Cash instance with a separate anonymity set. Check the Stats tab for more info." | the (i) toggle opens the paragraph "Each amount is a standalone Classic pool with a separate anonymity set. Check the Statistics for more info." | adapted: every tooltip is a toggled paragraph a screen reader and a touch screen reach |
| **Connect** (no wallet) / **Deposit** (a wallet) | **Deposit** opens the note modal; the connect step arrives with Stage 8 | same flow from the note on |
| The note modal: "Your private note"; "Please back up your note. You will need it later to withdraw your deposit."; "Treat your note as a private key - never share it with anyone, including tornado.cash developers."; "The browser will ask to save your note as a file:" (desktop only); the checkbox "I backed up the note"; "Your note won't be saved in your browser. Please make sure it's backed up!"; **Send Deposit** | the same title and sentences; "…never share it with anyone. No support channel of this site will ever ask for it."; **Copy** and **Save as a file** (the file name shown: `backup-tornado-eth-1-1-<10 hex>.txt`); the checkbox gates **Send Deposit** on a live pool; **Not connected** otherwise; Escape closes, the focus returns, the note leaves with the modal | same, the one sentence addressed to this site |
| Withdraw: **Note** with "Please enter the note you received after deposit was made" and the placeholder "Please enter your note"; "Getting the note data…" | same words; the (i) toggle; the gear opens the withdrawal settings once a note is found | same |
| On a valid note: **Time passed** and **Subsequent deposits**, with the warnings under 24 hours and under 5 deposits ("…we recommend waiting for at least 24 hours…", "…we recommend allowing at least 5 deposits after yours for better anonymity.") | **Amount**, **Time passed**, **Subsequent deposits** as rows; the two warnings as paragraphs under the facts, the value in the warning colour | same |
| **Recipient Address**, "Please paste address here", **Donate** | same; "Recipient address is invalid" under a malformed address; **Donate** fills the address a build names in `VITE_CLASSIC_DONATION_ADDRESS` and is hidden when none is named — never the original project's address | adapted: the build's own donation address or none |
| The settings modal: **Relayer \| Wallet**; the relayer list; the wallet warning "Make sure that ETH used to pay for the gas fee is not linkable to ANY of your addresses. Otherwise, the anonymity of the withdrawal will be compromised. We recommend using a Relayer instead." | a settings panel under the gear: the same two modes; the relayer list with each one's fee and status (an offline relayer cannot be chosen) and "The relayer you choose sees your IP address when it submits the withdrawal."; the wallet warning word for word | same, inline instead of a modal |
| **Current Relayer**: Name, Fee | same | same |
| **Total**: Note balance, Gas Price, Network fee, Relayer fee, Total fee, Tokens to receive | the same lines in the same order — the network fee at the source's gas price × 550,000 gas, the relayer fee as its percent of the denomination, integer wei (`classic/src/model/fees.ts`); in wallet mode the note balance and the tokens to receive alone | same; Classic's own fees, no 1 % (spec §3 rule 8) |
| "The total fee is higher than the amount of tokens to be received…" | same, when the fee exceeds the note | same |
| **Withdraw** → "Generating proof" → **Withdrawal Confirmation**: "Your zk-Snark proof has been successfully generated! Please click Confirm to initiate the withdrawal", **Confirm** | same words and steps (the fixtures `classic-withdraw-proving`, `classic-withdraw-confirm`); live only behind `CLASSIC_LIVE` (Stage 9), **Not connected** until then | same |
| Errors: "Note is invalid", "Note has been spent", "There is no related deposit. The note is invalid.", "Your note is from another network, please change network in the app." | the same four, plus "This note names a pool this app does not serve." | same |
| **Statistics**: **Anonymity set** with its tooltip "Number of deposits from which your withdrawal will potentially originate"; "N equal user deposits"; **Latest deposits** (the ten newest with the time since each) | same, beside the form from 1024 px and below it before; it follows the selected pool, or the pool of the note being withdrawn | same |
| The history: Time passed, Amount, Subsequent deposits, Tx Hash, Status (Waiting for receipt, Failed, Spent, Deposited) | the same columns; the relayer protocol's job statuses as words (Queued … Confirmed, Failed); the Spent / Unspent filters; hashes shortened; never a note | same |
| Settings (modal): the RPC endpoint | a Settings page: the RPC endpoints by host, the relayers with their status, the language (Automatic / English / 한국어), and **Supported right now** — the availability of the selected pool, fact by fact (spec §7.7) | extended |
| Footer: the donations address, "Tornado.cash version", the social links, the language flag | the interface version | reduced: no social links, no third-party address |
| Languages: en, es, fr, ru, tr, uk, zh | en, ko (the repository's languages; every key in both) | a different set |
| Desktop-first; the viewport meta disables zoom | mobile-first; the two columns from 1024 px; zoom allowed; the text at 200 % checked on every screen | improved |
| The note in `localStorage`, the console logging, the Echo encrypted notes, the note account, the compliance PDF, the geofence `451.html`, the sanctions oracle at connect | none of it (the matrix §7); the oracle and the geofence arrive behind switches, off by default (Stage 9, the owner's decision 9) | not copied, by decision |

## What the harness proves (2026-10-26, Windows, Chrome)

- 24 fixtures (20 English, 4 Korean) × 4 sizes = 96 baselines, reviewed by eye and committed.
- 240 layout checks at the ten sizes: no horizontal scroll; the Statistics beside the form from 1024 px; the banner on
  every screen; one primary action per screen (inside the open dialog when one is open); every control ≥ 44 px.
- 72 acceptance checks: axe in the browser (colour contrast included) on every fixture; the text at 200 % cuts nothing;
  the Classic word policy, no full address and no amount past six decimals on every screen.
- Under happy-dom (`classic/test/screens.test.tsx`): the flows above on the mock, the note never in the page after the
  modal closes, never in the URL, never in storage; the language the only preference stored.

## Still open for parity (later stages)

- The wallet chooser ("Your Wallet — Please select your Web3 compatible wallet"), the network selector and the connected
  account in the header: Stage 8 (EIP-6963 and the injected provider, chain 1 only).
- A relayer entered by URL: an owner follow-up (it cannot pass a strict `connect-src`).
- The original's Statistics tab on narrow screens: the Classic app keeps the panel below the form instead.
