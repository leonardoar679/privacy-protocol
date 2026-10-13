# Privacy Wallet Web — Specification V1.0

Normative. How the wallet looks and behaves for the person holding the phone: the four concepts a user
needs (a public wallet, a protected balance, a destination, an operation), the four-tab shell and its
routes, every screen with its words, the design system every screen is composed from, the fee model and
its formulas, the one operation state machine behind Protect / Send / Swap / Cross-chain, the consumer
value bands below the high-value layer, the words the wallet may and may not use, how errors and recovery
read, what the Privacy Center states as fact, the boundary of the Classic Privacy module, the typed SDK
facade, where state lives at rest, and the gates a build must pass (plan "Privacy Wallet Web V1 —
Mobile-First Privacy + Swap + Private Transfer Platform" §1–§88; §89 onward is folded into the addendum of
§24 when received). It extends `docs/private-swap-spec-v1.1.md`, `docs/whale-execution-spec-v1.0.md`,
`docs/high-value-protection-spec-v1.0.md` and `docs/high-value-execution-contract-v1.0.md`, which stay
normative for the engines underneath; where this document and those disagree on what the *user sees*, this
document wins, and where they disagree on what the *engine does*, they win. **`PrivacyCore`, the vaults,
the circuits and the `SwapOrderEscrow` / `SwapOrderFactory` bytecode are unchanged by this document**, and so
are the V1.1 order machine, the relayer's job machine and the V2–V4 engines except where a section is marked
*V5*. The services never hold a user's portfolio, address list or identity (whale spec §22, §25); the AI
recommends and warns and never signs (plan V3 §92); the wallet never claims atomicity and never says
"anonymous" (§18 here).

Status words MUST / MUST NOT / SHOULD are RFC-2119. Code: `frontend/src/` (`app/`, `routes/`,
`design-system/`, `features/`, `storage/`, `api/` are new in this pass; `sdk/` and `wallet/` stay),
`reference/typescript/src/wallet/`, `services/relayer/` (fee terms only), `scripts/local-stack/`,
`scripts/verify-all.mjs`.

Status (2026-10-08): a section marked *Stage N* is built by the V5 pass in that stage, in order Every stage (0–12) landed on `main` on 2026-10-08 (`docs/roadmap.md`, the V5 table); §89 onward awaits the owner's addendum (§24).
(`docs/roadmap.md` tracks completion). The owner's decisions this document rests on: the rebuild happens
inside `frontend/` (the plan's §81 monorepo layout is a later mechanical pass); the privacy fee is the
relayer's percentage term paid through the fee note that already exists, and the executor tip on swaps; the
consumer bands sit below the V4 bands, which stay as they are from $100K; Classic Privacy lands as a module
boundary and screens on a pool interface, its contracts and legal review later; the UI stack is the lean one
of §4; the services stay as they are; the encrypted at-rest formats move to IndexedDB unchanged.

---

## 1. Product model (plan §1–§3, §34–§35, §60, §84, §86)

The product is **one wallet** whose job is to protect financial privacy without teaching the user privacy
technology. The user's concepts are exactly these, and the UI MUST NOT introduce others outside Advanced:

| Concept | What it is | Code |
|---|---|---|
| **Public Wallet** | the user's ordinary EVM account, shown as `0x7A…91F2` | `features/wallet/connection.ts` (*Stage 4*) |
| **Protected Balance** | the private balance of notes the seed controls, shown in USD with per-asset rows | `wallet/notes.ts`, `features/protected-balance/` (*Stage 4*) |
| **Destination** | where money goes: a `pp1…` privacy address, or a chain address (Ethereum, Bitcoin, Solana) | `@ref/wallet/destinations.ts`, `wallet/addressBook.ts` |
| **Operation** | Protect, Send, Swap, Cross-chain Swap — each tracked by the one state machine of §12 | `features/operations/` (*Stage 6*) |

The user's mental model is one sentence: **choose what I have → choose what I want → review → confirm.**
Send, Swap and Cross-chain look the same (plan §34): the second choice is an address, an asset, or an asset
on another chain.

Ranges (plan §2) and what each turns on (§11): normal $1K–$20K, large $20K–$50K, protected large $50K–$100K,
above $100K the V3/V4 high-value layer. The app optimizes for the $1K–$20K user and becomes more protective
on its own above that.

The §86 flow is the acceptance test of this pass and of every later UI change: a new user, unassisted, can
open the site → connect a wallet → protect assets → see the protected balance → choose Swap → select
ETH → BTC → understand the fees → understand the minimum they receive → confirm → watch progress → see the
completed result, without knowing what a zk-SNARK, a Merkle tree, a nullifier, a relayer or a cross-chain
protocol is. The following MUST stay invisible outside Advanced (plan §84): Merkle tree, nullifier,
commitment, circuit, Groth16, Poseidon, root history, RPC privacy, relayer workers, provider adapters,
execution envelopes, settlement proofs.

## 2. Navigation and routes (plan §4, §9, §35, §52) — *Stage 3*

Four items in the bottom navigation on a phone and never more: **Home · Swap · Activity · More**. On a
screen ≥ 1024 px wide the same four live in a top bar with the Wallet status (§9).

| Route | Screen | Gate |
|---|---|---|
| `/welcome` | first launch (§3.1) | none |
| `/unlock`, `/create`, `/restore` | the lock screens | keystore present / absent |
| `/guest` | the walletless swap | none |
| `/` | Home (§3.3) | unlocked |
| `/protect`, `/protect/review`, `/protect/progress/:opId` | Protect (§3.4) | unlocked |
| `/send`, `/send/review`, `/send/progress/:opId` | Send (§3.5) | unlocked |
| `/receive` | Receive | unlocked |
| `/swap`, `/swap/review`, `/swap/:orderId`, `/swap/protected/:campaignId` | Swap, cross-chain, protected execution (§3.6–§3.8) | unlocked |
| `/activity`, `/activity/:id` | Activity, the detail (§3.10) | unlocked |
| `/recovery/:opId` | recovery (§3.12) | unlocked |
| `/more` | the More menu | unlocked |
| `/more/privacy`, `/more/privacy/what-stays-private`, `/more/privacy/advanced` | Privacy Center (§15), §3.13, the six categories | unlocked |
| `/more/security`, `/more/wallet`, `/more/advanced`, `/more/ai` | Security, Wallet, Advanced, Private AI | unlocked |
| `/more/classic`, `/more/classic/:poolId` | Classic Privacy (§16) | unlocked |
| `/gallery` | the design-system gallery | dev builds only |

Rules. **Pages** are full-screen routes (Swap, Send, Protect, Review, Activity detail, security settings).
**Sheets** (bottom sheets ≤ 1023 px, centered dialogs above) are component state, never routes: asset and
wallet selection, route comparison, fee details, advanced details. **Dialogs** appear only for a dangerous or
destructive confirmation: forget the wallet, replace it, turn protection off. The browser's back button
closes an open sheet before it leaves a page; a page whose operation is at `AWAITING_SIGNATURE` or later
blocks navigation with a dialog ("Your operation is in progress"). `/…/review` without a draft redirects to
the flow's first screen. The router is react-router v6 (`createBrowserRouter`); static hosting needs the
SPA fallback of `docs/deployment.md`.

## 3. Screen inventory with the words (plan §5–§6, §10, §13–§18, §23–§28, §30–§33, §37–§38, §47, §56, §61)

Every string below is a key in the message catalog (§19); the English text is the one here, verbatim.

### 3.1 First launch (plan §10) — *Stage 3*
```
Protect your financial privacy
Your wallet stays under your control.
[ Connect Wallet ]
No account required
```
then
```
Choose your experience
● Simple      We choose the safest practical settings.
○ Advanced    Show more controls and technical details.
```
Default **Simple**; the choice is `prefs.experience` (§8) and can be changed under More → Security. "Connect
Wallet" MAY be skipped ("Not now"): a protected wallet is created without a public wallet, and Protect asks
to connect when needed.

### 3.2 Backup (plan §13) — *Stage 7, Stage 10*
```
Protect your wallet
Your recovery information controls access to your protected assets.
[ Back up now ]
○ I understand this cannot be recovered by us.
```
Status line under More → Security: `Backup status  ✓ Recovery backup created` with the date; "Not backed up
yet" otherwise. The nudge card appears on Home while the protected balance is ≥ $1,000 and no backup is
recorded, and once on the Protect review before the first protect without a backup. The words "nullifier
key", "viewing key", "note secret", "commitment database" MUST NOT appear.

### 3.3 Home (plan §5–§6, §83) — *Stage 4*
Top bar: `🛡 Protected` (→ `/more/privacy`) and the gear (→ `/more/security`). Then, in this order:
`$24,382.41` / `Protected balance`; the asset rows (`ETH 4.82`, `USDC 12,400`, …; hidden while empty); the
card `Protect your assets / Keep your financial activity more private / [ Protect Assets ]` (shown while
the balance is empty or until the first protect, then under the rows as a smaller row); `Send | Swap`; the
current-operation line (`Executing`, `Completed`, `Needs attention` → the operation); `Recent activity`
(three rows → `/activity`); `View details` (collapsed: the core line, the light-client line, the pool size).
The hierarchy is money → actions → current operation → advanced; nothing from the §1 list is on this screen.

### 3.4 Protect Assets (plan §14) — *Stage 7*
```
Protect Assets
From            [ Ethereum Wallet ]     0.84 ETH  ≈ $2,840
↓
Protect as      [ ETH ]
You will receive   ≈ 0.84 ETH protected
Service fee     none now · 1.00 % applies when you send or swap privately
Network / relayer   ≈ $3.84
[ Protect ]
```
The network figure is `eth_estimateGas × maxFeePerGas` read through the connected wallet's provider at
render time, converted with the wallet's price read (`sdk/prices.ts`) — never a constant (user decision:
no cost at a hard-coded gas price). Technical details (vault, leaf index, hashes) are collapsed under
Advanced. The review then the progress of §3.11 follow.

### 3.5 Send Privately (plan §15–§16) — *Stage 7*
```
Send Privately
Asset     [ USDC ]
Amount    [ 2,500.00 ]
To        [ Paste address ]
Privacy   ● Protected
You send            2,500 USDC
Privacy fee         25.00 USDC
Relayer             ≈ 4.10 USDC
Recipient receives  ≈ 2,470.90 USDC
[ Review ]
```
**Recipient receives** is the largest number. Under the address, as checks resolve:
```
✓ Valid address   ✓ Correct network   ✓ Token supported   ✓ Destination format valid
```
and for a cross-chain destination `Bitcoin · bc1q… · ✓ Bitcoin address · ✓ Correct network`. The wallet
MUST NOT reinterpret a destination silently: a Bitcoin address typed into an Ethereum send is refused with
the existing sentence ("this looks like a Bitcoin address; the destination is Ethereum"), and changing the
destination chain is an explicit choice in the asset selector. A `pp1…` address takes the private path
(`privateTransfer`); a chain address the public path (`privateWithdrawal`, a fresh address of this wallet
pre-filled by default).

### 3.6 Swap (plan §17, §37) — *Stage 8*
One large card:
```
Swap
From   ┌ 8,000 USDC          Balance: 12,400 USDC ┐
       ↓
To     ┌ ETH                 ≈ 2.31 ETH            ┐
Best protected route
You'll receive at least   ≈ 2.28 ETH
Privacy fee        80 USDC
Relayer             4.20 USDC
Swap / network     11.70 USDC
Estimated time     ~1–3 min
Privacy            ✓ Protected
[ Review Swap ]
```
The user never selects a provider, a relayer, a route, an RPC, a gas strategy, a Merkle root or a proof
parameter; the engine does (private-swap spec, whale spec). The quote card (plan §37) is `You pay / You
receive / Minimum / Fees / Time / Protection High ✓`; **Compare routes** (the table `Route | Receive | Time |
Risk | Privacy` from the competition record) exists only under Advanced, and the provider's name appears
only there — the default word is **Best route**.

### 3.7 Cross-chain swap (plan §18) — *Stage 8*
The same card with the destination asset on another chain, plus the checklist
```
Protected execution
✓ Source isolated   ✓ Destination verified   ✓ Route healthy
```
`Source isolated` = the one-time escrow is funded privately; `Destination verified` = the §3.5 checks and
the address book's status; `Route healthy` = the provider's breaker is closed and its health is current
(`GET /risk/:provider`). The Review of a cross-chain route carries, verbatim, "Cross-chain settlement is not
atomic: your funds leave first and arrive later, and a failure in between is refunded, not reversed."

### 3.8 Protected execution (plan §23–§24) — *Stage 8*
At the `large-protected` band (§11), before the Review — from `enhanced` the V3 wizard and the V3 Review carry
the same safeguards, so the V4 tiers are unchanged (plan V5 decision 3):
```
Protected execution
Because this transaction is large, we're using additional execution safeguards.
✓ Destination verified   ✓ Route checked   ✓ Protected execution   ✓ Transaction limits applied
[ Continue ]
```
While a split order runs:
```
Protected execution
Your $80,000 swap is being completed in protected steps.
Completed   $20,000
Executing   $20,000
Remaining   $40,000
✓ Route healthy   ✓ Destination verified
```
`Tranche #1/40` and `Step k of n` MUST NOT appear outside Advanced (the V4 counter stays under Advanced with
its `data-step` / `data-steps` attributes). The user experiences one transaction goal.

### 3.9 Review and confirmation (plan §25–§26) — *Stage 7, Stage 8*
One review screen for every money movement:
```
Review Swap
$8,000 USDC  →  ≈ 2.31 ETH
You receive at least   ≈ 2.28 ETH
Fees      Privacy $80.00 · Relayer $4.20 · Swap $7.60
Network   Ethereum
Destination   0x43…82C1   ✓ Verified
Protection    ✓ Private execution
[ Hold to Confirm ]
```
`Confirm` (a tap) below the `large-protected` band; `Hold to Confirm` with the progress ring from it (the V3
hold, `VITE_HOLD_MS`), the second factor from `high-value-secondary`, the separate device at
`institutional` — the V3 controls are unchanged above $100K. The confirmation is deliberately slower than
navigation. Biometrics are the native shells' addition (plan §26), out of scope here.

### 3.10 Activity and the detail (plan §27–§28) — *Stage 9*
Chronological groups (`Today`, `Yesterday`, then dates), an icon per kind (protect, send, swap, cross-chain,
recovery), the amount, the status word. The detail:
```
ETH → BTC   $12,400
Status        Executing
Source        Protected ETH
Destination   bc1q…7f2a   ✓ Verified
Privacy fee   $124
Relayer       $16.30
Provider      THORChain        (Advanced only)
Transaction   0x…
[ View advanced details ]
```
Advanced details: Execution ID, Quote ID, Block, Root, Nullifier status, Provider execution ID, Relayer
transaction, Confirmation state, Recovery state.

### 3.11 Progress (plan §47) — *Stage 7*
```
Preparing secure transaction...
Generating proof...   ████████████░░░
Almost ready
```
The lines follow the operation's `progress.step` (§12): fee terms / merging / syncing / verifying → "Preparing
secure transaction…"; witness / proof → "Generating proof…" with the bar; local-verify / submitting →
"Almost ready". The main thread never blocks (the prover runs in its Web Worker).

### 3.12 Errors and recovery (plan §38, §61) — *Stage 6, Stage 8*
An error is never `CALL_EXCEPTION` or `execution reverted`. The normal form:
```
We couldn't complete this operation.
Your funds were not moved.
Reason: The selected route expired before submission.
[ Get a new quote ]
```
The high-value form:
```
Your funds are still protected.
We stopped the operation because the destination verification changed.
No additional transaction was submitted.
[ Review destination ]
```
Recovery (never a blind Retry):
```
Something needs attention
Your protected funds are safe.
The cross-chain route did not complete as expected.
Source        ✓ Confirmed
Swap          ⚠ Delayed
Destination   Waiting
[ View recovery ]
→ Recovery options: Continue monitoring  or  Start refund/recovery process
```

### 3.13 Privacy status and "What stays private?" (plan §30, §56) — *Stage 10*
Tapping `🛡 Protected`:
```
Privacy Center — Your current session
✓ No analytics   ✓ Protected balance encrypted locally   ✓ Private operation
✓ Destination isolated   ✓ No third-party tracking
Network visibility — Public transaction data
Some information is necessarily visible on the underlying blockchain.
[ Learn more ]
```
"Learn more" opens
```
What stays private?
Your protected balance and private transaction details are not stored as plain public blockchain data.
What remains public?
Some blockchain transaction metadata, network activity, and destination-side information may still be visible.
Privacy is strongest when the entire transaction path is designed carefully.
```
followed by the five LIMITS sentences of `@ref/wallet/privacyCenter.ts`. "100 % anonymous" MUST NOT appear.

### 3.14 Classic Privacy (plan §32–§33) — *Stage 10*
Under More only, never on the Swap screen. `Classic Privacy / Fixed Pool / ETH [ 1 ETH ] / [ Protect ] or
[ Withdraw ]`; a pool: `1 ETH pool / Pool size 1,482 ETH / Deposits 1,027 / Your private position 1 ETH /
Status Ready / [ Withdraw privately ]`; Advanced: commitment, Merkle root, root age, relayer, relayer fee,
proof status. The disclosures of §16 precede every deposit.

## 4. Visual language and tokens (plan §7–§8, §51, §74, §76) — *Stage 1*

The wallet looks like a premium consumer financial app: large typography, generous spacing, rounded cards,
soft elevation, a clear hierarchy, subtle status indicators, simple icons, restrained animation, one obvious
primary action per screen. It MUST NOT use terminal-like black screens, neon, heavy gradients, trading
dashboards, many panels on one screen, tiny text, jargon or dense tables. Personality: calm, premium,
friendly, secure.

Tokens (`frontend/src/design-system/tokens.ts`, the source of truth; `tokens.css` is generated from it and
a test asserts they agree): colours `bg, surface, surface-2, border, fg, fg-muted, accent, accent-fg,
accent-soft, shield, shield-soft, warn, warn-soft, danger, danger-soft, success` in a light and a dark set
(`prefers-color-scheme` and `[data-theme]` from the prefs); type scale display 40/44 700 · title 28/32 700 ·
heading 20/26 600 · body 16/24 · label 14/20 500 · caption 12/16, tabular numerals for money; spacing on a
4-pt scale (1–12); radius sm 8 · md 12 · lg 16 · xl 20 · full; elevation 0–3 (soft shadows in light, borders
in dark); motion fast 120 ms · base 200 ms · slow 320 ms with one easing, all 0 ms under
`prefers-reduced-motion`; z-index nav 10 · sheet 20 · dialog 30 · toast 40; breakpoints 360 · 480 · 768 ·
1024 · 1280; `--nav-h 64px`; `--touch 44px`. The primary canvas is 390 × 844; the ten sizes 360×800,
375×812, 390×844, 393×852, 412×915, 430×932, 768×1024, 1024×768, 1280+, 1440+ MUST render without
horizontal scroll, every control at least 44 px tall. Desktop centers the app at max-width 1200 px (plan
§9). Icons are an inline SVG set on a 24 grid drawing with `currentColor`, `aria-hidden` unless titled.
Animation communicates a state change (quote updated, proof generated, transaction submitted, protection
completed) and nothing else.

## 5. Component inventory (plan §51–§53) — *Stage 1*

Every screen MUST be composed from these and MUST NOT carry an inline style object; a lint rule enforces both.

| Component | Props (essentials) | Built on |
|---|---|---|
| `AppShell` | nav items, top bar, children | — |
| `TopBar` | title, back, actions, status | — |
| `BottomNav` | four items {to, label, icon}, current | router |
| `Page` | title, back, primary action, width phone / wide | — |
| `Card` | elevation 0–2, padding | — |
| `BalanceCard` | label, USD amount or null, subline, status protected / unavailable / loading | Card |
| `AssetRow` | asset, units, usd, onPress, trailing | — |
| `AssetSelector` | assets, value, onChange, showAddresses (Advanced) | Sheet + search |
| `AmountInput` | asset, value (string), onChange, usd, buckets, max, mode asset / usd, error | — |
| `AddressInput` | chain, value, onChange, checks[], book, onPaste, status | — |
| `FeeSummary` | lines, total, receive {label, value}, pay {label, value}, collapsed (default true, `aria-expanded`) | — |
| `QuoteCard` | the §36 view, privacy level, expiresAt, onCompare (Advanced) | Card |
| `ProtectionBadge` | level High / Reduced / Off, onPress | — |
| `StatusBadge` | tone ok / pending / warn / danger / neutral, label | — |
| `TransactionTimeline` | steps {label, state done / active / waiting / failed, detail} | `role=list` |
| `ConfirmSheet` | title, summary, mode tap / hold, holdMs, onConfirm, onCancel, disabledReason | Sheet + the hold logic |
| `ErrorCard` | title, reason, fundsState not-moved / still-protected / unknown, actions | Card |
| `SecurityCard` | icon, title, body, action | Card |
| `Modal` | open, title, danger, children | Dialog |
| `BottomSheet` | open, title, onClose, children | Dialog, bottom-anchored ≤ 1023 px |
| `Toast` | kind, title, body (`useToast`) | Toast |
| `Button`, `IconButton`, `Field`, `Segmented`, `ListRow`, `Collapsible`, `Progress`, `Skeleton` | — | — |

The Radix primitives are wrapped once under `design-system/primitives/`; no other file imports `@radix-ui/*`
and no component's props mention a Radix type, so the primitive layer can be replaced. The token selector
(plan §53) lists icon, name, symbol and protected balance; contract addresses only under Advanced. A chain
is implied by the asset (plan §54): "BTC · Bitcoin", never "Bitcoin Mainnet · Network ID".

## 6. Experience modes (plan §10, §53, §84) — *Stage 3*

`prefs.experience` is `simple` (default) or `advanced`. Advanced reveals, and Simple hides: provider names
and the route comparison, contract and vault addresses, transaction hashes and the §3.10 advanced list, the
Merkle / nullifier / proof lines, the core and light-client status lines, the exposure dashboard, allowances,
the campaign step counter, the executor tip line, the scorecard numbers. After unlock `settings.advanced`
(the V2 flag inside the encrypted journal) mirrors the pref once; the Settings toggle writes both.

## 7. Wallet connection and the transport policy (plan §11, §50) — *Stage 4*

Two security domains, never mixed: the browser ↔ external wallet (EIP-1193) and the browser ↔ shielded key
manager (§8). Connection: EIP-6963 discovery keyed by `rdns`, `window.ethereum` as the fallback, a
WalletConnect connector loaded only on tap and only when `VITE_WC_PROJECT_ID` is set (its relay sees session
metadata; §3.13 says so). The expected chain is the deployment's; a wrong network shows "Switch network"
(`wallet_switchEthereumChain`), never a silent reinterpretation. `accountsChanged`, `chainChanged` and
`disconnect` are listened to. The account is shown as `0x7A…91F2` and persisted only as the connector's
`rdns` in the prefs.

`api/transport.ts` is the one place the wallet talks to a network: `credentials: "omit"`, `redirect:
"error"`, `cache: "no-store"`, no cookies, a host allowlist from the env (`VITE_RPC_URLS`, `VITE_RELAYER_URL(S)`,
`VITE_SWAP_SERVICE`, `VITE_BEACON_URLS`, `VITE_THORNODE_URLS`, the zkAPI base, same origin) and a request hook
the leakage gate instruments. Every `fetch` and every viem transport goes through it; a lint rule forbids
`fetch(` outside `src/api/` and `src/sdk/`. The private-read transport behind this seam (plan §50) is a later,
native-host item.

## 8. State categories and the storage container (plan §12, §48) — *Stage 2*

| Category | Lives in | Examples |
|---|---|---|
| ephemeral | React state / memory | the draft of an operation, the current quote, a sheet's open state |
| persistent, non-sensitive | IndexedDB `privacy-wallet` / store `prefs` | `experience`, `theme`, `locale`, `recentNetwork`, backup timestamps, `lastConnector`, `firstLaunchDone` |
| sensitive | IndexedDB `privacy-wallet` / store `secure` | `pp.keystore`, `pp.journal`, `pp.journal.unreadable` — ciphertext only |

The prefs store MUST NOT hold an amount, a pair, an address, an operation timestamp or anything that
identifies a transaction; the plan's "quote history" (§48) therefore goes into the encrypted journal, a
deliberate deviation. The at-rest **formats** of `docs/wallet-formats.md` §2 are unchanged byte for byte
(scrypt → XChaCha20-Poly1305 over the seed; the journal under `sha256(tag ‖ seed)`); only the container
changes, from localStorage to IndexedDB, with a one-time migration that copies each key, reads it back,
compares the bytes and only then removes the localStorage entry. After it, localStorage MUST be empty. The
TC-01 guard applies to both stores: a key whose name looks like a secret is refused, a `secure` value that is
not keystore- or journal-shaped is refused, a prefs value outside its schema is refused. The seed, the
journal key and the decrypted journal live only in memory while unlocked (`wallet/session.ts`). Nothing
sensitive is ever sent to a service.

## 9. Backup UX (plan §13) — *Stage 7, Stage 10*

The words of §3.2. A backup is recorded in `prefs.backup` when the user re-acknowledges the phrase or exports
the backup file (`session.exportBackup`, both files already encrypted). The nudge appears before the first
substantial protected balance (§3.2) and never blocks an operation.

## 10. The fee model (plan §14–§17, §21–§22) — *Stage 5*

Notation: `R` the amount delivered, `A` the amount leaving the protected balance, `F` the relayer's live
minimum × 1.1 (today's `feeForRelayer`), `b` the relayer's `feePercentBps` (product default 100 = 1.00 %;
absent = 0), all in the transaction's vault units.

**Private send and withdrawal** (one fee note to the relayer, as today — output 1 of a withdrawal, output 2
of a transfer): exact-input (the Send default, as the §3.5 card: the typed amount is what leaves the
balance and "Recipient receives" is computed and shown largest; "You send" is the typed amount) and
exact-output (the user switches "Recipient receives exactly this amount"; "You pay" / "Maximum you pay" is
computed). Exact-output: `fee = max(F, ⌈R·b / 10000⌉)`, `A = R + fee`. Exact-input ("You send" is what the user types):
`R = min(A − F, ⌊A·10000 / (10000 + b)⌋)`, `fee = A − R`. Lines: `Privacy fee (1.00 %)` = `⌈R·b/10000⌉`;
`Relayer / network` = `F`, written "included" when the percentage already covers it; `Total fees` = `fee`.
Sends show `You pay`; withdrawals show `Maximum you pay` because `F` is re-read at submit — a rise beyond the
margin reopens the Review and never submits silently.

**Swap and cross-chain**: the funding withdrawal to the one-time escrow pays `F` only (its recipient is the
escrow); `Privacy fee` = the executor tip `T = ⌊amount · tipBps / 10000⌋` (the service's 25 bps, at most
1 % on chain, `SwapOrderTypes.TIP_DIVISOR`), paid by the escrow at `deployAndExecute`; `Swap / provider` =
`NormalizedQuote.providerFee + networkFee` in USD when the provider values its fees, else the fee list in
asset units (`feeSummary`); `Estimated receive` = `quote.toAmount` and `You'll receive at least` =
`quote.toAmountMin`, both quoted by the service on `amount − T` — the tip MUST NOT be subtracted twice.

**Protect**: no fee note; the service-fee line reads "none now · 1.00 % applies when you send or swap
privately"; `You will receive` is the full amount; the network figure as in §3.4.

**Display** (plan §22): collapsed by default — `You'll receive $9,886 / Total fees $114 / ⓘ View fee
details`; expanded, the lines above. Exact-output systems show `Maximum you pay` and `Minimum you receive`.
Fees are never hidden until after the user signs.

**Enforcement** (*V5*, relayer): `GET /info` adds `feePercentBps`, `feeMinimumWei` (= today's `minFeeWei`) and
`feeVaults[].feePercentBps` (optional, per ERC-20 vault); `POST /submit` accepts an optional
`swap: { factory, params }`. For a withdrawal (`pi.mode` says so; `withdrawalAmount` and
`withdrawalRecipient` are public inputs) the relayer MUST refuse `fee < max(min, ⌈withdrawalAmount·b/10000⌉)`
with the code `fee_below_percent`, unless `withdrawalRecipient` equals the escrow it recomputes from `swap`
(then the minimum applies). For a private transfer the amount is hidden: the relayer can enforce only its
minimum and the wallet pays the percentage; this is a stated limit (`docs/audit-package.md`).

## 11. The tier ladder and the consumer bands (plan §2, §23–§24, §26, §62) — *Stage 5*

```
Tier = "standard" | "large" | "large-protected" | "enhanced" | "high-value" | "high-value-secondary" | "institutional"
TIER_DEFAULTS = { large: 20_000, largeProtected: 50_000, enhanced: 100_000, highValue: 1_000_000,
                  highValueSecondary: 5_000_000, institutional: 10_000_000 }
tierLabel: large → "Large transfer", large-protected → "Protected transfer"; the rest unchanged
```
The two new tiers sit **below** `enhanced`, so every V2–V4 rule keyed on `enhanced` and above keeps its
meaning and its tests. `controlsFor` (`frontend/src/sdk/tiers.ts`):

| From tier | Controls on |
|---|---|
| `large` ($20K) | `review`, `lint` |
| `large-protected` ($50K) | `hold`, `simulation`, `destinationConfirm`, `protectedExecution`, `providerHealth`, `strictQuote`, `recoveryTracking` |
| `enhanced` ($100K) | as V2–V4 (`review`, `lint`; the campaign when staged or opted in) |
| `high-value` and above | as V2–V4, unchanged |

`EXPOSURE_POLICY` gains `large { word "Normal", no cap }` and `large-protected { word "Protected", capBps 2500,
range [2500, 5000], activation "staged-or-opt-in" }`; `capBpsFor` uses that row at the band and keeps the
`enhanced` fallback below it: at the band the cap is the band's own — a quarter whatever the route's exposure
tier and the mode (the §6 tier ceilings and the Maximum Safety 1 % are the high-value layer's); an R4 route is not
split finer but handed to the next healthy route. A split order at the band runs at most four sequential steps of
25 % with the V3 gate per risk class and `executeWindowSeconds ≤ 1800`: exact quarters of the order
(`planTranches` with `exact`, carried on the campaign's plan as `exact?`), not the alphabet's buckets — a
remainder of a few base units, when the order is not a multiple of four, is a piece of its own. A stored V2–V4
thresholds object (four values) keeps its meaning: `fillThresholds` adds the two bands as the defaults, or a
fifth and a half of a lowered `enhanced` (`healSettings` never resets a user's thresholds over them).

**Protected execution for an order at the band** (plan §23), split or not: (1) the destination confirmed —
an entered address re-typed group by group or taken from the address book, plus the book's status line;
(2) the route checked — the simulation on every endpoint before the signature and the provider's health
(`GET /risk/:provider`: breaker closed, security ≥ 60, no incident within 24 h), else the next route is
quoted (plan §58); (3) the quote strict — at `/prepare` the hard quote MUST have `expiresAt − now ≥ 60 s`
and `approvedMin ≥ toAmount·(1 − 50 bps)`, the request's `slippageBps` capped at 50; (4) limits — one
protected operation in flight per wallet at the band (the next waits: "one at a time"), the V4 velocity
limit honoured, the four-step split when the service says `staged` or the user asks; (5) the additional
confirmation — the §3.8 interstitial, then Hold to Confirm; (6) recovery tracking — the operation polled
every 15 s while open, `NETWORK_DELAYED` at three times the ETA, `RECOVERY_REQUIRED` on the tracker's
"Needs attention", the §3.12 screen. Thresholds stay user-adjustable (More → Security → Large transfers;
`healSettings` fills the two new keys; `checkThresholds` keeps them increasing).

## 12. The operation state machine (plan §3, §29, §60) — *Stage 6*

```
OperationRecord {
  id, kind: "protect"|"send"|"withdraw"|"swap"|"cross-chain"|"classic-deposit"|"classic-withdraw",
  state: OperationState, phase?: "funding"|"execution"|"settlement", createdAt, updatedAt,
  amounts: { asset, decimals, input, expectedOutput?, minimumOutput?, delivered? }, fees: FeeLine[],
  destination: { kind: "fresh"|"entered"|"book"|"privacy-address"|"escrow", display, chain },
  refs: { activityId?, orderId?, campaignId?, jobId?, txHashes: string[], executionTx?, executionRef?, leafIndex?, quoteId?, provider? },
  tier, protectedExecution?: { checklist: { destination, route, execution, limits } },
  failure?: { code, class: "not-moved"|"still-protected"|"unknown" },
  recovery?: { state: "monitoring"|"refund-offered"|"refunding"|"refunded"|"resolved", since, lastCheckedAt },
  progress?: { step: "fee-terms"|"merging"|"syncing"|"verifying"|"witness"|"proof"|"local-verify"|"submitting", i?, n? },
  history: { state, at, note? }[]
}
OperationState = DRAFT → QUOTING → QUOTE_READY → REVIEW → AWAITING_SIGNATURE → SIGNED → SUBMITTED →
  RELAYER_EXECUTING → NETWORK_CONFIRMING → SETTLEMENT_VERIFYING → COMPLETED
  | QUOTE_EXPIRED | SIGNATURE_REJECTED | SUBMISSION_FAILED | NETWORK_DELAYED | PROVIDER_FAILED
  | RECOVERY_REQUIRED | REFUNDING | REFUNDED | CANCELLED
```
`CANCELLED` is added to the plan's list (the wallet's "abandoned"). Records are journaled under
`JournalData.operations?` (optional, never written by `emptyJournal()`) from `AWAITING_SIGNATURE` on;
`DRAFT` … `REVIEW` stay in memory. `Code:` the record's types and sets in `frontend/src/wallet/operationRecord.ts` (the journal's
import), the reducer, the adapters, the catalog, the store and the recovery model under `frontend/src/features/operations/`.
The history is one line per state; a note (an approval's hash, a relayer retry) joins the current state's line.
The mapping from every existing vocabulary (`features/operations/adapters.ts`):

| State | protect | send / withdraw | swap / cross-chain (`StoredSwap.state`, `OrderState`, `SwapJobState`) | campaign tranche |
|---|---|---|---|---|
| DRAFT … REVIEW | form / estimate / review | form / fee terms / review | form / `/quote` / chosen / commit review | wizard / recommendation / review |
| AWAITING_SIGNATURE | the wallet prompt (approve, then deposit) | proving (`progress`) | `committed` → funding (a nested send) → `funded` → `prepareAndSign` | committed / funded |
| SIGNED | hash returned | — (the proof authorizes) | signed in memory, simulation ok | signed |
| SUBMITTED | hash, no receipt | relayer accepted (`txHash`) or self-submitted | hand-over → job `waiting-funding` | executing |
| RELAYER_EXECUTING | — | job `submitted` | job `executing` | — |
| NETWORK_CONFIRMING | receipt pending | `mined`, leaf not yet seen | `SOURCE_SUBMITTED` / `SOURCE_FINAL` / `PROVIDER_EXECUTING` | source-confirmed |
| SETTLEMENT_VERIFYING | — | — | `DESTINATION_SUBMITTED` / `DESTINATION_FINAL` | destination-submitted / destination-confirmed |
| COMPLETED | leaf journaled | activity "completed" | `COMPLETED` / job `completed` | settled |
| QUOTE_EXPIRED | estimate > 60 s old | fee terms > 5 min old at confirm | `EXPIRED`, 409 `minimum_moved`, `price_guard` | requoting |
| SIGNATURE_REJECTED | EIP-1193 4001 | cancel at the hold → REVIEW | cancel at the execute review → REVIEW | user pause |
| SUBMISSION_FAILED | RPC refusal / receipt status 0 | `RelayerRefusal` after the fallbacks / job `reverted` | `SOURCE_FAILED` / a refusal at `/finalize` | failed before hand-over |
| NETWORK_DELAYED | no receipt after 10 block times | mined, not seen after N blocks | `PROVIDER_TIMEOUT`, `lastReadFailedAt` ("Unknown / reconnecting") | chain-congestion pause |
| PROVIDER_FAILED | — | — | `DESTINATION_FAILED` / job `execute-failed` | provider-error pause |
| RECOVERY_REQUIRED | — | — | `FAILED` ("Needs attention"), `PARTIAL`, a reconcile pause | reconcile / anomaly pause |
| REFUNDING | — | — | `REFUND_PENDING`, job `expired` / `refund-only` / `refunding` | refunding |
| REFUNDED | — | — | `REFUNDED` / job `refunded` | refunded |
| CANCELLED | closed before signing | closed before proving | `abandoned` | cancelled |

Invariants: **I-O1** a terminal state (`COMPLETED`, `REFUNDED`, `CANCELLED`) never changes; **I-O2** history
timestamps are monotone; **I-O3** every failure state carries a catalog reason (§13); **I-O4** `COMPLETED`
needs a settlement reference (a leaf index, a destination transaction or the tracker's completion);
**I-O5** the words "Transaction failed" are never shown while the truth is "the provider executed and the
destination confirmation is delayed" (`NETWORK_DELAYED` and `SETTLEMENT_VERIFYING` have their own words).
The engine modules are unchanged: `privateTx.ts` emits typed events beside its status strings,
`orderTracker.deriveState`, the relayer job states and the campaign states are read through the adapters.

## 13. Errors and recovery (plan §38, §61) — *Stage 6*

`features/operations/errors/catalog.ts` maps every code to `{ title, reason, fundsClass, actions }`: every
relayer `RelayerError` code (`bad_proof`, `bad_public_inputs`, `bad_payloads`, `wrong_domain`,
`payload_hash_mismatch`, `bad_fee`, `fee_vault_not_accepted`, `fee_note_mismatch`, `fee_payload_unreadable`,
`fee_too_low`, `fee_below_percent` (*V5*), `nullifier_in_flight`, `simulation_failed`, `send_failed`,
`rate_limited`, `unsupported_media_type`, `capacity`, `too_large`, the swap-executor and admin codes), every
service 4xx (`minimum_moved`, `price_guard`, …), EIP-1193 4001, `RpcDisagreement`, `ServiceMinimumMoved`, the
guard refusals (`swapGuard`, `swapSign`, `providerCall`, `guestGuard`). A test scans the relayer and service
sources for codes and fails on one without a row. The funds class decides the first sentence: `not-moved`
→ "Your funds were not moved."; `still-protected` → "Your funds are still protected."; `unknown` → "We are
checking where your funds are." Recovery offers `Continue monitoring` (the tracker keeps polling) or `Start
refund/recovery process` (a refund-only relayer job through `returnOrderToBalance`, or the campaign runner's
cancel); a retry is always a new quote or a tracked resume, never a re-send of the same transaction.

## 14. Activity (plan §27–§28) — *Stage 9*

Rows come from the operation records merged with the V2 `activity[]` rows by `activityId` (one row per
money movement, never two); campaigns are one row unless Advanced. Groups by day in the user's locale;
icons by kind; the status word from the state (`Completed`, `Executing`, `Needs attention`, `Refunded`,
`Cancelled`). The detail is §3.10; its Advanced list reads the record's `refs`.

## 15. Privacy status and the Privacy Center (plan §30–§31, §56–§57) — *Stage 10*

The §3.13 session facts and the §31 rows are computed, never asserted:

| Row | Fact |
|---|---|
| Protection ● High / Good / Reduced | the posture's overall level (`@ref/wallet/privacyCenter.ts`) |
| Wallet data ✓ Stored locally | the `secure` store holds ciphertext; nothing is sent (§8) |
| Analytics Off · Tracking Off | structural: no such code path exists; the leakage gate (§21) proves it on every build |
| Private RPC Enabled | the read quorum has ≥ 2 endpoints and the light client verifies the pool (`wallet/posture.ts`) |
| Shielded operations Enabled | private transactions are submitted by a relayer paid with a private note |
| Fresh destination Enabled | (*V5*) no entered destination used in the last 30 days, from the address book — replacing the hard-coded `freshDestinations: true` |

`[ Advanced privacy settings ]` opens the six V2 categories with their levels and the LIMITS. The per-route
assessment (`@ref/wallet/privacyAssessment.ts`: source, amount, timing, destination, provider, cross-chain
linkabilities → score, level, basis) is compressed on the quote card to `Privacy ✓ High` with a "Why?"
listing the basis sentences (`✓ Fresh destination · ✓ Protected source · ✓ Provider metadata minimized ·
✓ Route passed privacy checks`). Provider health → route score → breaker → provider disabled is the V2–V4
chain; the wallet chooses another valid route (plan §58).

## 16. Classic Privacy Mode — the module boundary (plan §32–§33) — *Stage 10*

A legacy compatibility module with its own state, never mixed with `PrivacyCore`:
`features/classic-privacy/`; `ClassicNote` = `tornado-<currency>-<amount>-<netId>-0x<124 hex>` (62 bytes:
a 31-byte nullifier then a 31-byte secret, little-endian), parsed and formatted by
`reference/typescript/src/classic/note.ts`; `interface ClassicPool { id; currency; denomination; stats():
{ size, deposits, rootAge }; deposit(note): ClassicDepositRecord; prepareWithdrawal(note, recipient, relayer):
ClassicWithdrawal; status(ref): ClassicStatus }`; the classic relayer API as zod schemas (`GET /v1/status`,
`POST /v1/tornadoWithdraw`, `GET /v1/jobs/:id`; states QUEUED / ACCEPTED / SENT / MINED / CONFIRMED / FAILED);
the journal field `classic?: { deposits: ClassicDepositRecord[] }` (optional, never in `emptyJournal()`).
Disclosures before a deposit: fixed denominations only; the note is the only key and cannot be recovered;
the deposit and its count are public; a relayer fee applies; "a classic pool is a separate, older design and
does not use your protected balance". This pass ships the screens on a devnet mock pool (`mockPool.ts`);
the contracts (the research harness's verbatim Classic contracts on solc 0.7.6), the circuit port, the
proving keys and the legal review are a later pass — the mock's withdrawal is labelled "proof generation
arrives with the circuit port".

## 17. The SDK facade (plan §19, §36, §64) — *Stage 7*

`frontend/src/sdk/facade.ts` re-exports the existing engine under the plan's names:

| Plan name | Code |
|---|---|
| `createProtectedNote` | the note construction of `privateTx.ts` (`keys/`, `wallet/notes.ts`) |
| `prepareProtect` | `prepareShield` (*V5*: approve / deposit requests + the gas estimate) |
| `preparePrivateSend` | `planTransfer` (*V5*, extracted from `privateTransfer`) |
| `preparePrivateSwap` | `swapExecute.commitOrder` then `prepareAndSign` |
| `prepareWithdrawal` | `planWithdrawal` + `feeTerms` |
| `generateProof` | `prover/client.ts proveInBrowser` |
| `submitPrivateTransaction` | `relayerSubmit` / `sendViaInjectedWallet` / `handOverSigned` |
| `getProtectedBalance` | `noteStore.balance` + `valueOfBalances` |
| `getOperationStatus` | the operations store (§12) |
| `SwapProvider` | the service's `ProviderAdapter` (quote / prepare / validate / execute / track / recover) |
| `Quote` (plan §36) | `NormalizedQuote` + `privacyAssessment` + the risk view: sourceAsset, destinationAsset, inputAmount, expectedOutput, minimumOutput, privacyFee, relayerFee, providerFee, networkFee, estimatedTime, provider, route, expiresAt, privacyAssessment, riskAssessment |

The React code imports the facade and the feature modules, never a raw ABI.

## 18. Wording (plan §55 and the standing rules) — *Stage 1 lint, Stage 8 pin*

MUST NOT appear in user-facing text: mixer, anonymous, untraceable, invisible, undetectable, "100 %",
"Tranche #", "Transaction failed" (the bare form). Preferred: private, protected, shielded, reduced public
linkage, private execution, protected balance. The wallet never claims atomicity; the one sentence of §3.7
is the only place the word occurs. The ESLint rule enforces the list on every file under `src/features` and
`src/app`; the V3 wording pin keeps reading the moved files.

## 19. Localization and accessibility (plan §74–§75) — *Stage 1, Stage 11*

Every user-facing string goes through `t(key, vars)` from the typed catalog (`app/i18n/en.ts`); `ko`, `zh`
and `ja` catalogs exist as `Partial` tables falling back to English (translation is content work, out of
scope); the locale comes from `prefs.locale` or `navigator.language`; a pseudo-locale (lengthened strings)
is rendered in tests and in the viewport pass so no layout depends on English widths. Accessibility: roles
and names on every control, labels linked by `htmlFor`, live regions for status lines, a visible focus ring,
a logical focus order in sheets (focus trapped, Escape closes, focus restored), `prefers-reduced-motion`
honoured, 44 px targets, dark mode and high contrast through the tokens. The design-system gallery and each
screen pass axe with no violations.

## 20. Security and build (plan §49, §68–§70, §73, §77–§78) — *Stage 11*

No analytics, no session replay, no third-party script: the build contains only first-party code and the
lint fails on a known tracker import. The production page carries a Content-Security-Policy
(`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'
<the allowlisted hosts>; img-src 'self' data: blob:; style-src 'self'; style-src-attr 'unsafe-inline';
font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'`) and the header set of
`docs/deployment.md` (`frame-ancestors 'none'`, HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, `Permissions-Policy`, COOP). The build is reproducible and its artefacts pinned:
`public/artifacts.json` records the sha256 of `transaction.wasm`, `transaction_final.zkey`,
`verification_key.json` and the core WASM; `docs/build-hashes.md` records the `dist/` hashes; the prover
worker hashes the zkey it fetched and refuses a mismatch. The first screen never waits for the proof
libraries, the circuit artefacts, the swap engine or the light client: they are separate chunks loaded when
their feature opens (plan §77). Proof generation stays in its worker with the §3.11 progress (plan §78).

## 21. Test gates (plan §67–§68, §73) — *Stage 11*

| Gate | What it checks | Where |
|---|---|---|
| unit | every package's suites | `scripts/verify-all.mjs` steps as today |
| design system | tokens agree, each component per state, axe on the gallery | `frontend/test/design-system/` |
| privacy leakage | create → protect → send → swap on mocks: no seed, phrase, note secret, view key or witness byte in any request; no address, amount or destination in the console; ciphertext-only storage; every host allowlisted | `frontend/test/privacy-leakage.test.tsx`; its Playwright twin |
| lint | typescript-eslint, react-hooks, jsx-a11y, the house rules (§5, §7, §18) | `npm run lint` |
| artifact pins | the sha256 records of §20 | `frontend/scripts/check-artifact-pins.mjs` |
| dependency audit | `npm audit --omit=dev --audit-level=high` × 3, skipped with a note offline | `scripts/audit.mjs` |
| viewports | the money flow once, then the shell on 360×800, 390×844, 412×915, 768×1024, 1280×800: no horizontal scroll, 44 px targets, screenshots | `scripts/local-stack/e2e.mjs` |
| accessibility | axe per screen, focus order, roles and names | `frontend/test/a11y/` |

verify-all gains the steps `frontend lint`, `frontend privacy leakage`, `frontend artifact pins`,
`dependency audit`; the viewport matrix stays in the local stack (it needs the chain). CI order (plan §73):
TypeScript → lint → unit → crypto → contracts → privacy leakage → build → Playwright → audit → artefact pins.

## 22. Implementation order (plan §82, §87)

| Stage | Plan §87 items | Section here |
|---|---|---|
| 0 | this document | — |
| 1 | 1 design system | §4, §5, §18, §19 |
| 2 | 5 protected wallet state (the container) | §8 |
| 3 | 2 app shell, 3 mobile Home (shell), the first launch | §2, §3.1, §6 |
| 4 | 4 wallet connection, 3 Home, the transport | §3.3, §7 |
| 5 | 10 fee engine, 18 the bands | §10, §11 |
| 6 | 11 operation state machine, recovery model | §12, §13 |
| 7 | 7 Protect, 8 Send | §3.4, §3.5, §3.9, §3.11, §9, §17 |
| 8 | 9 Swap, 13 cross-chain route UI, 15 recovery UI, 18 large-trade mode | §3.6–§3.8, §3.12 |
| 9 | 12 Activity | §3.10, §14 |
| 10 | 16 Classic Privacy, 17 Privacy Center, More | §3.13, §3.14, §15, §16 |
| 11 | 19 privacy / security test suite | §20, §21 |
| 12 | 20 desktop refinement, docs | §2 (desktop), the docs |

14 (THORChain adapter) exists since V1.1; 6 (protected balance) is Stage 4's Home.

## 23. Out of scope (plan §81, §39–§43, §26, §32, §75, §78–§80)

- **The §81 monorepo layout** (`apps/`, `packages/`): a later mechanical pass; the rebuild lives in `frontend/`.
- **Express + SQLite services** (plan §39–§43): recorded as the target topology; this pass changes only the
  relayer's fee terms. The two `node:http` services keep holding no per-user state.
- **Native shells, push notifications, background execution, biometrics**: `docs/mobile.md`; the web wallet
  runs operations while unlocked; the WebAuthn second factor stays the control.
- **Classic Privacy contracts, circuit port, proving keys, legal review**: §16 lands the boundary and the
  screens on a mock.
- **WalletConnect relay privacy**: the relay sees session metadata and IPs; disclosed in §3.13, not mitigated.
- **Real ko / zh / ja translations**: catalogs fall back to English.
- **A private read transport** (Tor, mixnet, a native light client) behind the §7 seam.
- **The production ceremony, external audits, the testnet broadcast**: unchanged from the roadmap.
- **Any change to the executor tip, the contracts or the circuits.**

## 24. Addendum — plan §89 onward

Superseded (2026-10-13). The owner pasted the complete document as a rewrite ("Privacy Wallet Web V1 — Core
Product → UX → Application → Privacy → Swap → Security → Production", §1–§96, new numbering). Its frozen contracts
are `docs/privacy-wallet-web-spec-v2.0.md`, which supersedes this document for everything the user sees; this one
stays as the record of the V5 pass. The V6 stages are in `docs/roadmap.md`.
