# Privacy Wallet Web — Specification V2.0

Normative. The frozen product contracts of the owner's complete document "Privacy Wallet Web V1 — Core Product →
UX → Application → Privacy → Swap → Security → Production" (§1–§96, 2026-10-13; "doc §n" below), as decided by
the owner on 2026-10-13: what the user sees and in which words, the monorepo layout the code lives in, the fee
model and its formulas, the asset, chain and deployment registries, the one operation state machine, the swap
and provider contracts, the privacy and risk assessments, the API and its storage rules, the two new periphery
contracts, the gates a build passes, and the Definition of Done. It supersedes
`docs/privacy-wallet-web-spec-v1.0.md` for everything the user sees (v1.0 stays as the record of the V5 pass);
`docs/private-swap-spec-v1.1.md`, `docs/whale-execution-spec-v1.0.md`, `docs/high-value-protection-spec-v1.0.md`
and `docs/high-value-execution-contract-v1.0.md` stay normative for the engines underneath, except where a
section here is marked *V6*. **`PrivacyCore`, the vaults, the circuits and the `SwapOrderEscrow` /
`SwapOrderFactory` bytecode are unchanged by this document**; the two contracts it adds (`ProtectRouter`,
`ShieldReceiver` + factory) are periphery: they call the vaults' public `deposit` like any user. The services
never hold a user's portfolio, address list, identity or wallet secret; the AI recommends and never signs; the
wallet never claims atomicity and never says "anonymous".

Status words MUST / MUST NOT / SHOULD are RFC-2119. Each section names the doc sections it freezes and the V6
stage that builds it (`docs/roadmap.md`, the V6 table). `Code:` lines name the paths after the Stage 1–4 layout.

---

## 1. Product model (doc §1–§3, §16, §92, §96) — *Stage 0*

The product is a **Privacy Wallet**: not an exchange, a blockchain explorer, a trading terminal, a generic Web3
dashboard or a mixer UI. The wallet owns the experience; everything else is a capability: **Protect, Private
Send, Private Swap, Cross-chain Swap, Protected Balance, Activity, Classic Privacy**.

The user knows three states and nothing else outside Advanced:

| State | What it is | Code |
|---|---|---|
| **Public Wallet** | the assets the user's external wallet (MetaMask, a WalletConnect wallet) controls, shown as `0x7A…91F2` | `packages/wallet-engine` |
| **Protected Wallet** | the private balance of notes the protected wallet's seed controls, in USD with per-asset rows | `packages/sdk` (notes, session) |
| **Destination** | where assets arrive: the protected balance, an EVM address, a Bitcoin or a Solana address | `packages/config` (chains), `packages/protocol/src/wallet/destinations.ts` |

The external wallet and the protected wallet are different things (doc §16): connecting MetaMask never creates,
unlocks or exposes the protected wallet, and the protected wallet's keys never reach the external wallet.

**One mental model** for Protect, Send, Swap and Cross-chain (doc §3), in this order on every screen: *What do I
have? → What do I want? → How much? → How much will I receive? → What will it cost? → Is protection enabled? →
Confirm.* The `FlowCard` pattern (§5) draws the first two; `FeeLines` the next three; the protection line and the
one primary action the last two.

**The Golden UX rule** (doc §92) is the acceptance test of every screen: a first-time phone user understands
what will happen, how much they will receive, how much they will pay, and whether the transaction is protected,
without blockchain terms. These words MUST NOT appear in a Simple screen's visible text (the §19 vocabulary gate):
Router, Calldata, Gas, Merkle, root, Nullifier, Proof, Provider ID, escrow, commitment, witness, nonce, wei, gwei,
tranche, memo, slippage, relayer job, a full `0x` + 40-hex address, an amount with more decimals than the asset's
`displayDecimals`. They stay available under **Advanced Details** (a sheet or a collapsible on the same page).

## 2. Transaction classes (doc §4, §49–§51, §87) — *Stage 13*

| Class (doc) | Value | Tier (code) | What turns on |
|---|---|---|---|
| Normal | $1K–$20K (and below) | `standard` | standard protected execution |
| Medium | $20K–$50K | `large` | additional quote and destination checks: the Review and the privacy lint (V5), the strict quote (§12.6) and a typed-in destination re-confirmed (*V6*) |
| Large | $50K–$100K | `large-protected` | High-value protection, automatic: the §3.9 notice, destination verified, quote locked, route health checked, execution limits (in flight ≤ the configured limit: four sequential quarters), Hold to Confirm |
| Future | > $100K | `enhanced` and above | the V3/V4 layer unchanged; V1 is not optimized for it |

`classOf(tier)` maps the tiers to the four classes (`packages/protocol/src/wallet/valuation.ts`); the tier names
and thresholds stay (`TIER_DEFAULTS`: large 20,000, largeProtected 50,000, enhanced 100,000, …), user-adjustable
under More → Security. From `large-protected` the protection is **automatic** (doc §87): no "Protect this order"
checkbox and no mode toggle in Simple; V4's deliberate two-step opt-out stays under Advanced only. Without a price
the wallet fails safe (the tier is at least `high-value`, V3).

## 3. The fee model (doc §5, §22, §24, §26, §30, §43, §80, §86) — *Stage 7*

Notation (all integers in the asset's base units, bigint only — no float in fee code, a source scan enforces it):
`A` the input (what the user types as "You pay" / "Amount"), `b` the privacy fee in bps (product: **100**, i.e.
1.00 %), `F` the relayer/network cost the wallet pays (the relayer's live minimum `m` × 1.1), `W` a withdrawal's
public amount, `f` the fee note's amount, `T` the swap executor's tip, `S` the shield tip (§13.3).

**Privacy fee** `p(A) = ⌈A·b / 10000⌉` — exactly 1 % for every round amount ($1,000 → $10, $10,000 → $100,
$100,000 → $1,000 in 6, 8 and 18 decimals), at most one base unit more otherwise.

| Operation | Formula | Lines shown before signing |
|---|---|---|
| **Protect** (deposit through `ProtectRouter`, §11.1) | `net = A − p(A)`; the note is built for `net`; the user's own network cost is paid in ETH by their wallet | `You receive net` · `Privacy fee p(A)` · `Relayer/network ≈ $x` (the user's gas: `eth_estimateGas` × the live fee history) |
| **Send, exact input** (default) | `f = p(A) + F`, `R = A − f` (one fee note to the relayer); `R < 1` → "This amount is too small to send privately." | `Recipient receives R` (largest) · `Privacy fee p(A)` · `Relayer ≈ F` |
| **Send, exact output** ("Recipient receives exactly") | `A* = ⌈(R + F)·10000 / (10000 − b)⌉`, `f = p(A*) + F` | `You pay A*` (`Maximum you pay` for a public exit, F re-read at submit) · the same lines |
| **Swap / cross-chain** | `W = A − p(A) − F` funds the escrow (one fee note: `p(A) + F`); the provider is quoted on `W − T`; a same-chain swap into the protected balance also pays `S` from the output | `You pay A` · `You receive ≈ expected` · `Minimum receive` · `Privacy fee p(A)` · `Relayer/network F + T (+ S)` · `Swap/provider` (the provider's fees) · `Market rate & impact` (the signed residual) · `Total fees` |

Exact output is the minimal input that delivers exactly `R`: with `g(A) = A − ⌈Ab/10000⌉ = ⌊A(10000−b)/10000⌋`,
`g` is non-decreasing in steps of at most 1, so `g(A*) = R + F` (property-tested over 10,000 seeded cases,
round trip and minimality).

**The display identity** (doc §5): `input − privacy fee − relayer/network − swap/provider − market rate & impact =
estimated receive`, where "market rate & impact" is the residual (it may be negative) — the lines always add up.
USD figures are integer cents; a fee in an unpriced asset is shown in that asset, never guessed. Fees are never
hidden until after authorization; Simple shows `Fees $x` with the breakdown one tap away (a bottom sheet).

**Enforcement** (*V6*, `apps/relayer/src/relayer.ts`): one shared function `feeMeetsTerms(W, f, b, m)`
(`packages/protocol/src/wallet/fees.ts`) — for every withdrawal (`pi.mode === 1`), **escrow funding included** (the
V5 exemption is removed), the relayer requires `f ≥ ⌈(W + f)·b/10000⌉ + m`; `fee_too_low` when `f < m`, else
`fee_below_percent`. A private transfer hides its amount: the relayer enforces `f ≥ m` only and the wallet pays
`p + F` (a stated gap, `docs/audit-package.md`). A direct vault deposit bypasses the router's fee (a stated gap:
the official wallet always uses the router).

**The executor tip** (*V6*, `packages/swap-engine/src/tips.ts`): the execution's gas cost, not a percentage —
`T = ⌈units × (2·baseFee + priorityFee) × 1.2⌉` from `eth_feeHistory` through the service's RPC endpoints (never a
fixed gas price), converted for an ERC-20 order through the service's Chainlink valuer (`tip_unpriced` without a
price); `T > W/100` (the on-chain cap, `SwapOrderEscrow.sol:74`) refuses the order with `amount_too_small`. The
wallet's guard refuses a tip above 3 × its own estimate; the executor waits rather than execute below cost.
`TIP_BPS` is removed.

**Actual against estimated** (doc §43): the relayer records `gasUsed × effectiveGasPrice` from the receipt on
every job (`/status/:txHash`, `/swap/:orderId`); the wallet reads its receipts itself and records `costs
{estimated, charged, actualNetworkWei}` on the operation; Advanced shows `Estimated / Actual / Difference`; an
actual cost above 1.5 × the estimate, or a charge at least 3 × the actual cost, adds a note to the operation and the
API logs `fee.deviation` (no amounts).

## 4. The monorepo (doc §6, §15, §20, §27, §34, §42, §44, §47, §60–§61, §65, §70, §72, §89 Step 2) — *Stages 1–4*

```
apps/web              the React/Vite wallet (was frontend/)
apps/relayer          the private submission + swap executor + shield executor (was services/relayer/)
apps/api              Express 5 + node:sqlite: the /v1 API (the HTTP layer of services/private-swap)
packages/protocol     the TypeScript reference implementation (was reference/typescript/)
packages/protocol-types  the frozen types: Asset, ChainConfig, ProtocolDeployment, QuoteRequest, Quote,
                      PrivacyAssessment, RiskAssessment, OperationState, settlement states, Store<T>
packages/config       chains.ts (ChainConfig registry), assets.ts (the asset registry)
packages/contracts    typed ABIs, gas units, deployments + verifyDeployment()
packages/ui           the design system: tokens/ components/ patterns/ icons/ animations/
packages/sdk          the engine the UI consumes: wallet core, notes, operations, fees, swaps, the §61 facade
packages/wallet-engine   external wallet connection (EIP-6963, injected, lazy WalletConnect)
packages/privacy-engine  the privacy assessment + transport/ (PrivacyTransport, the http policy)
packages/risk-engine  assessRisk() → RiskAssessment, the §48 blockers
packages/swap-engine  the route engine, provider adapters, scoring, tips, settlementOf (was services/private-swap/)
packages/server-kit   the typed privacy-safe logger, rate limiter, security headers, CORS (api + relayer)
privacy-core/         the Rust workspace (was core/rust/): privacy-core, privacy-core-wasm, privacy-prover,
                      privacy-ffi, uniffi-bindgen
contracts/ circuits/ tests/ benchmarks/ docs/ scripts/ tools/zkapi-lab/
```

Rules: npm scope `@privacy-wallet/*`, every package `private`; packages are consumed as TypeScript source (no build
step; exports `{".": "./src/index.ts", "./*": "./src/*.ts"}`); one root lockfile for `apps/*` and `packages/*`
(`circuits/`, `scripts/local-stack/`, `tools/zkapi-lab/` keep their own); **packages never import apps; engine
packages never import React or `ui`; `ui` never imports the SDK** (`boundaries.test.ts`); `import.meta.env` is read
only by `apps/web/src/config.ts`, which validates it into an `SdkConfig` and calls `configure()` before the first
render — engine modules read the configuration through accessors and throw "not configured" when used before
(`import-purity.test.ts`); React hooks live in `apps/web/src/hooks/` over the engines' `subscribe/get` stores;
browser storage and the prover stay platform code (`apps/web/src/platform/`) injected through the configuration —
the seam a React Native shell will implement later (doc §95). The Rust core keeps its crates; `privacy-core`'s
modules are grouped as doc §60 lists (`crypto/ notes/ commitments/ nullifiers/ merkle/ encoding/ proof/ wallet/`)
with every existing path re-exported, so `privacy-core-wasm` and `privacy-ffi` compile unchanged.

Tooling (doc §89 Step 2): TypeScript (`tsconfig.base.json`, strict, bundler resolution, case-consistent imports),
ESLint 9 flat config with the house rules, Prettier (enforced on new code), Vitest (one workspace), Playwright (the
screenshot harness and the local-stack run), Vite.

## 5. The design system (doc §6–§10, §55–§57) — *Stage 5*

`packages/ui/src/{tokens,components,patterns,icons,animations}/`. The target feeling is **calm, premium, friendly,
trustworthy** — never a hacker terminal, neon or an exchange dashboard. Light theme by default (the OS decides
dark), a high-contrast set under `prefers-contrast: more` and `forced-colors`.

**Tokens** `DesignTokens { spacing, radius, typography, elevation, motion }` (plus colour, z-index, breakpoints);
typography roles **Display, Heading, Title, Body, Body-small, Caption, Numeric-large, Numeric-medium** (the two
numeric roles use tabular figures); the font is a self-hosted Inter (latin subset, OFL; same origin, CSP
`font-src 'self'`) with the system font for Hangul; spacing on a 4-point grid; touch targets ≥ 44 px; motion
120 / 200 / 320 ms and 0 under `prefers-reduced-motion`.

**Components** (doc §9; screens MUST NOT build one-off versions): AppShell, Header, BottomNavigation, Button,
IconButton, Card, Input, AmountInput, AddressInput, AssetRow, AssetSelector, ChainSelector, FeeSummary, QuoteCard,
ProtectionBadge, StatusBadge, WarningCard, SuccessCard, ErrorCard, BottomSheet, Modal, ConfirmSheet,
TransactionTimeline, ProgressIndicator. Supporting: HoldButton, Segmented, ListRow, Collapsible, Skeleton,
TextButton, Toast.

**Buttons** (doc §10): three levels only — **Primary** (Protect Assets, Review Swap, Confirm), **Secondary** (View
Details, Compare Routes, Advanced), **Destructive** (Cancel, Reset Wallet, Remove Data); a text link (`TextButton`)
for navigation. **At most one visible primary per screen**; a destructive button is never adjacent to a
confirmation (doc §57); labels fit on one line at 360 px (a HoldButton keeps its size while held).

**Patterns**: `FlowCard` (have → want, §1), `FeeLines` (§3), `ReviewLayout`, `StateScreen` (empty / loading /
error / done), `AddressChip` (`0x43…82C1`, `bc1q…82c1`), `AmountText` (per-asset `displayDecimals`, grouping, USD
in integer cents — never a raw base-unit string), `StickyAction` (the primary action stays visible: it scrolls
into view when an input takes focus and rises above the on-screen keyboard through `visualViewport`, doc §56).

**Inputs** (doc §56): amounts `inputmode="decimal"`, addresses `inputmode="text"` with autocapitalize / autocorrect /
spellcheck off, whole numbers `inputmode="numeric"`; never `type="number"`.

**Sheets** (doc §55): asset selection, network selection, route comparison, advanced details and the fee breakdown
are bottom sheets on a phone and centred dialogs from 1024 px; the browser's back closes an open sheet first.

The component preview page is `/__preview` (dev and fixtures builds only).

## 6. The shell, the routes and the layouts (doc §11–§12, §53–§54, §88) — *Stage 5, Stage 16*

Mobile: Header on top, content, **BottomNavigation `Home · Swap · Activity · More`** — four items, never more.
From 1024 px: one top bar **`Logo · Home Swap Activity · Wallet`** (the Wallet menu holds the connection status
and every More entry) and no bottom bar; content max width 1200–1280 px, centred. The same routes and components
reflow — there is no separate desktop application, and everything on mobile is reachable on desktop (doc §88, a
parity test). Design canvas 390 × 844; validated at 360×800, 375×812, 390×844, 393×852, 412×915, 430×932,
768×1024, 1024×768, 1280+ and 1440+ (no horizontal scroll, 44 px targets).

| Route | Screen |
|---|---|
| `/welcome`, `/create`, `/restore`, `/unlock` | first launch and the lock screens |
| `/` | Home (§7.1) |
| `/protect` (+ `/review`, `/progress/:opId`) | Protect (§7.3) |
| `/send` (+ `/review`, `/progress/:opId`) | Send (§7.4) |
| `/receive` | Receive |
| `/swap` (+ `/review`, `/:opId`) | Swap and cross-chain (§7.5) |
| `/activity`, `/activity/:id`, `/recovery/:opId` | Activity, the detail, recovery (§7.8) |
| `/more`, `/more/privacy` (alias `/privacy`), `/more/security`, `/more/wallet`, `/more/advanced`, `/more/language`, `/more/classic`, `/more/ai` | More (§7.10–§7.11) |
| `/__preview`, `fixtures.html` | the component preview and the screenshot fixtures — never in a production build |

Classic Privacy is reachable only from More (doc §53), never beside Swap or Send.

## 7. The screens and their words (doc §13–§14, §19, §22–§26, §29–§33, §35–§36, §39–§41, §48–§52, §58, §75) — *Stages 6, 10, 11, 13–15*

Every string is a catalog key (§18); the English below is verbatim. Each screen is a pure `View` over a view-model
(`apps/web/src/features/<screen>/{View.tsx, model.ts, fixtures.ts}`); Views import no store or SDK module, so the
§19 fixtures render them exactly.

### 7.1 Home (doc §13–§14, §38)
```
🛡 Protected                                   ⚙
$24,382.41
Protected balance
ETH        4.82
USDC     12,400
USDT      2,100
┌ Protect your assets
│ Keep your activity more private
└ [ Protect Assets ]                (the one primary)
[ Send ]   [ Swap ]                 (two secondary tiles)
Recent
USDC → ETH   ✓   $8,200
```
It answers how much, whether it is protected, and what the user can do. States: **new user** → `/welcome`
(`Welcome / Protect your financial activity / [ Connect Wallet ]`); **connected, nothing protected** →
`$0 / Protected balance / [ Protect Assets ]`; **has assets** (above); **executing** → a card `Executing / ETH →
BTC / $12,400 / View progress` (and after a return: "Your ETH → BTC swap is still executing."); **action needed** →
`Action needed / Your funds are safe. / View operation` — "Your funds are safe." only when the funds class allows
it (§12.4), otherwise `We're checking on your funds.`. An old failed or cancelled operation never blocks Home:
only open operations raise a card, the newest first. Moved off Home in Simple: the maintenance schedule, the
pricing source sentence, the campaign controls (to the operation's detail), the pool and core lines (to More →
Advanced). The gear opens More → Security; `🛡 Protected` opens the Privacy Center.

### 7.2 Recovery information (doc §19)
```
Protect your wallet
Your recovery information gives you access to your protected assets.
We cannot restore it for you.
[ Back up now ]
```
Status under More → Security: `✓ Recovery information secured` (with the date) or `Not backed up yet`.
Cryptographic terms stay in Advanced.

### 7.3 Protect (doc §22–§23)
One page before confirmation:
```
Protect Assets
From
External Wallet                0x7A…91F2 · 5,210 USDC
[ 5,000 USDC ]
↓
Protected
USDC
You receive            4,950 USDC
Privacy fee               50 USDC
Relayer/network          ≈ $4.30
[ Review ]
```
The flow `SELECT_ASSET → ENTER_AMOUNT → VALIDATE_BALANCE → CALCULATE_FEE → PREPARE_TRANSACTION → WALLET_CONFIRM →
SUBMITTED → CONFIRMED → PROTECTED_BALANCE_UPDATED` is a pure reducer mapped onto the operation states (§12).
Common amounts (the V2 privacy buckets) move to Advanced. An ERC-20 asks the wallet to approve the router for
exactly the amount, then to protect (two prompts, one operation).

### 7.4 Send (doc §24–§25)
```
Send Privately
Asset                          USDC
Amount                        2,500
To                     0x43…82C1
✓ Valid address  ✓ Correct network  ✓ Supported asset  ✓ Destination format valid
Recipient receives       2,470.90 USDC     (largest)
Privacy fee                 25.00 USDC
Relayer                    ≈ 4.10 USDC
[ Review ]
```
A privacy address (`pp1…`) sends privately inside the pool ("Nothing about this transfer is public."); an EVM
address is a public exit ("The recipient and amount become public."). A Bitcoin destination shows `✓ Bitcoin
address  ✓ Bitcoin network` and continues as a cross-chain send (§7.5). **The selected network never changes
silently**: an address of another chain asks first. "Recipient receives exactly this amount" switches to exact
output (§3).

### 7.5 Swap and cross-chain (doc §26, §29–§33)
```
Swap
You pay                  8,000 USDC
↓
You receive              ≈ 2.31 ETH        (Your protected balance)
Minimum receive          2.28 ETH
Protection               ✓ High
Fees                     $91.80
Estimated time           ~2 min            (the real estimate, §13.1)
[ Review Swap ]
```
The quote reads **"Best protected route"**; the provider's name, route, expected output, fee, execution time, risk
and privacy are under Advanced (and Compare routes). Cross-chain (`ETH $12,000 → BTC`): `You'll receive at least
0.176 BTC`, `Privacy fee $120`, `Relayer/network $18.40`, `Swap/provider $24.10`, `Estimated 2–5 min`,
`Protection ✓ High`; the destination block:
```
BTC destination
bc1q…82c1
✓ Valid Bitcoin address  ✓ Correct network  ✓ Compatible destination
```
and from the Medium class, for a typed-in address, `Destination verified [ View address ]` with an explicit
confirmation. A same-chain swap delivers into the protected balance (§11.2): the destination reads `Your protected
balance`. Beginners see `You'll receive at least`; Advanced adds Expected output, Minimum output, Slippage, Price
impact. Every quote carries `expiresAt` and hard bounds (the minimum is signed into the provider call); expired:
```
This quote is no longer available.
Your funds were not moved.
[ Get new quote ]
```

### 7.6 Review and confirmation (doc §26, §31, §51, §86–§87)
The Review shows, for a $10,000 USDC → ETH swap: `You pay $10,000 (10,000 USDC)`, `You receive ≈ x ETH`, `Minimum
y ETH`, `Privacy fee $100.00`, `Relayer/network $…`, `Swap/provider $…`, `Total fees $…`, the destination, the
protection status, and the confirmation action — nothing hidden. A cross-chain Review carries the one sentence
"Cross-chain settlement is not atomic: your funds leave first and arrive later, and a failure in between is
refunded, not reversed." as a caption. Below $50K the action is a tap (`Confirm`); from $50K it is **Hold to
Confirm** (1.5 s; Enter held is the keyboard equivalent; a confirm dialog is the accessible alternative). Large
(doc §49):
```
Protected execution
Because this is a large transaction, we added additional safety checks.
✓ Destination verified  ✓ Quote locked  ✓ Route health checked  ✓ Execution limits enabled
```
**One confirmation** (owner, 2026-10-13): after Confirm the wallet commits the order, funds the escrow
immediately, and signs the provider call by itself while the fresh hard quote's minimum is at least the approved
one (the existing `swapSign` checks run first); a worse minimum pauses the operation (`QUOTE_EXPIRED`, reason
`price_moved`) with `Accept new minimum` or `Return funds`. "Delay for more privacy" schedules the funding at a
random time in 1–24 h instead.

### 7.7 Progress (doc §40, §50, §58)
```
Preparing your protected transaction…
● Checking balance
● Calculating fees
○ Securing your transaction
○ Waiting for confirmation
[████████████░░░░]
```
"Securing your transaction" replaces the doc's "Preparing secure proof" / "Generating proof" in Simple (§92 keeps
"proof" in Advanced; the owner may restore the doc's words). The bar is determinate: key download, then the witness
and the proving estimated from this device's last proof. The browser stays responsive (the crypto worker, §14.3).
A large operation shows amounts, never step counts: `$80,000 ETH → BTC / Protected execution / Completed $20,000 /
Executing $20,000 / Remaining $40,000`.

### 7.8 Activity, the detail, recovery (doc §39–§41, §73)
Activity groups by day (`Today`, `Yesterday`, then the date in the user's locale) with a friendly icon per kind:
`ETH → BTC $12,400 Executing`, `USDC → ETH $8,200 Completed`, `Private Send $1,200 Completed`, `Protected USDC
$5,000 Completed`. Opening Activity reconciles every open operation (local → API → chain → provider, §12.5); the
row shows the reconciled state. The detail:
```
ETH → BTC
$12,400
● Executing
You pay          12,400 USDC
You receive      0.176 BTC
Privacy fee      $124
Relayer/network  $18.40
Execution
✓ Quote created
✓ Transaction authorized
✓ Protected execution submitted
● Destination settlement
○ Complete
```
Advanced: Operation ID, Provider, Execution ID, Blockchain transaction, Block, Root, Proof status, Settlement
state, Recovery state, Estimated / Actual / Difference (§3), Remove from this device. Recovery never offers a
generic Retry: the wallet determines the settlement state (§12.4) and offers the valid path — `Your funds are safe.
/ The external swap is still being confirmed. / [ View progress ]`, `Return funds` when a refund is available, or
`Continue monitoring`.

### 7.9 Blockers (doc §48)
```
We stopped this transaction
The route changed before confirmation.
Your funds have not moved.
[ Review again ]
```
The second line names the blocker (§13.4): the quote expired; the asset is not supported; the destination is not
valid; the route's provider is unavailable; the minimum fell below your protection limit; the execution
parameters changed; the network does not match; the contract call did not pass our checks.

### 7.10 Privacy (doc §35–§36)
The indicator reads `🛡 High protection` (or `Medium protection`, `Low protection`); tapping it opens:
```
Why?
✓ Protected source
✓ Fresh destination
✓ Reduced provider metadata
✓ Privacy-preserving execution
Some blockchain metadata remains public.
```
(each line from the assessment's reasons, a failed one with its plain reason). Never "100% anonymous", "impossible
to trace" or "untraceable". The **Privacy Center** (`/more/privacy`) has seven sections: Protection status, Wallet
privacy, Network privacy, Transaction privacy, Data stored locally, Data sent to services, Advanced settings — with
the rows `Protection High`, `Wallet data Encrypted locally`, `Analytics Off`, `Tracking Off`, `Private transport
Enabled`, `Fresh destination Enabled`, each computed from a fact (V5 §15), "Data sent to services" generated from
the transport's purpose registry and the API's field list.

### 7.11 More, Classic Privacy, offline (doc §36, §52–§53, §75)
More lists Privacy Center, Classic Privacy, Security, Wallet, Networks, Advanced, Language (and Private AI where
the build has it). Classic Privacy (§11.3) keeps its own screens: pool selection, deposit, deposit recovery,
withdrawal, relayer, status. A lost connection shows, over every screen:
```
Connection interrupted
Your transaction state is being preserved.
We will not submit another transaction until the current state is verified.
```

## 8. External wallet and protected wallet (doc §15–§19) — *Stages 4, 15*

`packages/wallet-engine` exposes `connect`, `disconnect`, `switchNetwork`, `getAddress`, `signMessage`,
`requestSignature`, `detectWallet` over EIP-6963 discovery, the injected provider and a lazily loaded WalletConnect
connector (only with a project id). The doc's wagmi is not used (the owner's lean-stack decision of V5); the UI
contains no low-level wallet code.

The protected wallet's at-rest formats are unchanged (scrypt + XChaCha20-Poly1305, byte-pinned in TS, Rust and
Python) inside the encrypted IndexedDB container of V5 (`privacy-wallet` / `secure`); WebCrypto provides the
randomness, the zkey hash and the Cache API key. Nothing secret is ever in localStorage, sessionStorage, a URL or
query, a cookie, a server database or an analytics event (§19 gates).

**Auto-lock** (doc §18): the protected wallet locks after 15 minutes idle (1 / 5 / 15 / 60 under Security; the
setting lives in the encrypted journal), 5 minutes after the tab is hidden, on an explicit Lock, and on `pagehide`.
Focus loss counts as idleness only (wallet pop-ups and the WalletConnect modal take focus). `session.hold(reason)`
defers a lock through a critical section — the signature prompt, proving, submission, commit → hand-over — for at
most 30 minutes, then the lock happens at the runner's next safe point. A lock clears the seed and keys, the notes,
the runners' caches, drafts and the crypto worker; unlocking reconciles open operations.

## 9. Assets and chains (doc §20–§21, §72) — *Stage 3*

`packages/protocol-types/src/assets.ts`:
```ts
type Asset = { id: string; symbol: string; name: string; chain: ChainId; address?: `0x${string}`; decimals: number;
  displayDecimals: number; icon: string; privacySupported: boolean; swapSupported: boolean; enabled: boolean;
  status: "supported" | "temporarily-unavailable" | "unsupported" }
```
The registry (`packages/config/src/assets.ts`) is the only place a token appears; components never hard-code one.
The UI distinguishes `✓ Supported`, `Temporarily unavailable` (a provider or vault is down — from the API's
`/v1/assets`) and `Not supported` (an unknown token, a fee-on-transfer, rebasing or callback-heavy token): no ERC-20
is assumed safe. `packages/config/src/chains.ts`:
```ts
type ChainConfig = { id: ChainId; name: string; family: "evm" | "bitcoin" | "solana"; chainId?: number;
  rpcPolicy: { quorum: number; endpoints: "config" | "none"; privateTransport: boolean };
  explorer: { name: string; tx: string; address: string }; confirmations: number }
```
for ethereum, sepolia, base, arbitrum, optimism, bitcoin, solana, plus a `local` overlay (the devnet). Network
assumptions never live in components.

## 10. Contract deployments (doc §70–§71) — *Stage 3*

`packages/contracts`: typed ABIs (exported from `contracts/abi/**` by `contracts/scripts/export-abi.mjs`), gas units
(`gas.ts`, pinned by forge GasBench tests), and
```ts
type ProtocolDeployment = { chainId: number; protocolVersion: string; privacyCore: Address; verifier: Address;
  vaultFactory: Address; vaults: Record<string, Address>; swapFactory?: Address; protectRouter?: Address;
  shieldFactory?: Address; feeRecipient?: Address }
```
`verifyDeployment()` reads on chain the core's `PROTOCOL_ID` / `CIRCUIT_ID` / `HASH_ID`, `VAULT_VERSION`, its
verifier, `vaultOf(asset)` for every registry asset, and every periphery contract's `CORE()`; the result's
fingerprint is remembered, and a different fingerprint is a blocking notice ("This app does not match the deployed
protocol."), never a silent switch.

## 11. The periphery contracts (*V6*) — *Stages 7, 12, 14*

### 11.1 `ProtectRouter` (`contracts/src/periphery/protect/ProtectRouter.sol`)
No owner, no setters, no upgrade, no funds held between calls. `FEE_BPS = 100` constant; immutables `CORE`,
`VAULT_FACTORY`, `FEE_RECIPIENT`. `feeOf(gross) = ⌈gross·100/10000⌉`. `protectETH(ownerCommitment, noteSecret,
noteData, expectedNet) payable` and `protectERC20(token, gross, ownerCommitment, noteSecret, noteData,
expectedNet)`: the vault always from `VAULT_FACTORY.vaultOf(asset)` (`NoVault` when absent; the router never creates
one); `AmountMismatch` when `gross − fee ≠ expectedNet` (the note is built for the net); ERC-20 by a strict
`transferFrom` with a balance-difference check, the fee by a strict transfer to `FEE_RECIPIENT`, an exact approval
and `vault.deposit(net, …)`; `Protected(asset, vault, gross, fee, leafIndex)`. The fee recipient is public; the
deposit was public already.

### 11.2 `ShieldReceiver` + `ShieldReceiverFactory` (`contracts/src/periphery/shield/`)
A one-time CREATE2 receiver per same-chain swap: the provider pays its predicted address (THORChain's 2300-gas
`send` fits its empty `receive()` before and after deployment); anyone may then call
`factory.deployAndShield(params, noteData)` (or `…Token`): `keccak(noteData) == params.noteDataHash`, WETH unwrapped
for an ETH receiver, `vaultOf(asset) ≠ 0`, the tip `shieldTip ≤ minAmount/100` paid once and only on a delivery ≥
`minAmount` (dust cannot claim it), the rest deposited as the committed note (`ownerCommitment`, `noteSecret`
derived from the seed by counter, so a phrase restore finds it). An unsupported token can only be swept to the
committed `fallbackRecipient`. Provider refunds still go to the order's escrow. No second 1 %: the receiver
deposits directly.

### 11.3 Classic Privacy (doc §52–§53)
An isolated module (`apps/web/src/features/classic-privacy/`): `ClassicPrivacyService`, `ClassicPrivacyUI`,
`ClassicPrivacyContracts` (an interface — still the devnet mock pool; the contracts, the circuit port and the legal
review stay deferred, owner V5), `ClassicPrivacyRelayer` (the zod relayer API). Its own journal field, its own
state, no import to or from the protected-wallet engine (lint), More only. The dedicated review is
`docs/classic-privacy-review.md`.

## 12. The operation contract (doc §37–§38, §41, §73–§76) — *Stage 8*

### 12.1 States
One shared definition, `packages/protocol-types/src/operations.ts`, used by the wallet and the API:
```
OperationState = DRAFT | QUOTING | REVIEW | AWAITING_SIGNATURE | SIGNED | SUBMITTED | CONFIRMING | EXECUTING
  | SETTLING | COMPLETED | QUOTE_EXPIRED | FAILED | RECOVERY_REQUIRED | REFUNDING | REFUNDED | CANCELLED
```
The doc's fifteen plus `CANCELLED` (a documented extension: abandoning before money moves is not a failure).
Terminal: `COMPLETED`, `REFUNDED`, `CANCELLED`, `FAILED`. `DRAFT … REVIEW` live in memory; a record is journaled
from `AWAITING_SIGNATURE` (`JournalData.operations?`, optional, never in `emptyJournal()`). Order of the open
states: `SUBMITTED` (accepted by the relayer / the network) → `CONFIRMING` (source confirmations) → `EXECUTING`
(the relayer or the provider executing) → `SETTLING` (destination settlement) → `COMPLETED`; a Protect or a Send
goes `SUBMITTED → CONFIRMING → COMPLETED`.

Record fields beyond V5: `reason? {code, fundsClass: "not-moved" | "still-protected" | "unknown"}` (replaces
`failure`), `delayed? {since, code}` (a delay is an attribute of the phase state, never a state of its own),
`declined?` (a signature prompt refused), `settlement?` (§12.4), `costs? {estimated, charged, actualNetworkWei}`
(§3), `v: 2`.

### 12.2 The V5 → V6 mapping (applied to stored records when the journal is decrypted; idempotent; persisted at the next write)
| V5 | V6 |
|---|---|
| QUOTE_READY | REVIEW (drafts only; never journaled) |
| RELAYER_EXECUTING | EXECUTING |
| NETWORK_CONFIRMING | CONFIRMING for protect / send / withdraw; EXECUTING for swap / cross-chain (the tracker's source legs) |
| SETTLEMENT_VERIFYING | SETTLING |
| SIGNATURE_REJECTED | live: back to REVIEW with `declined`; stored: CANCELLED with `user_rejected` |
| SUBMISSION_FAILED | FAILED (reason kept) |
| NETWORK_DELAYED | the phase state (funding → CONFIRMING, execution → EXECUTING, settlement → SETTLING) with `delayed` |
| PROVIDER_FAILED | RECOVERY_REQUIRED (reason kept; settlement derived) |
| every other name | unchanged |

### 12.3 Invariants
I-O1 a terminal state never changes. I-O2 history timestamps are monotone. I-O3 every failure carries a catalog
reason. I-O4 `COMPLETED` needs a settlement reference (a leaf index, a destination transaction, the tracker's
completion). I-O5 the words "Transaction failed" never describe a delay or a provider that executed with the
destination still confirming. **I-O6** (*V6*) `FAILED` only when the funds class is `not-moved` or `still-protected`;
an unknown outcome is always `RECOVERY_REQUIRED`. **I-O7** (*V6*) after `SUBMITTED` a record never returns to a
state before signing — nothing is ever re-sent. A 2,000-sequence property test holds them.

### 12.4 Settlement and recovery (doc §41)
`settlementOf(legs)` (a pure function in `packages/swap-engine`'s browser-safe entry, shared by the wallet and the
API) derives one of `SOURCE_CONFIRMED`, `PROVIDER_PENDING`, `DESTINATION_PENDING`, `REFUND_AVAILABLE`, `REFUNDING`,
`COMPLETED` from the legs: the funding receipt and the escrow's balance, the executor job, `adapter.track`, the
destination or the shield receiver, the refund job and `refundAfter`. The recovery path follows the settlement:
wait (`PROVIDER_PENDING`, `DESTINATION_PENDING`), return funds (`REFUND_AVAILABLE` → a refund-only relayer job),
watch the refund (`REFUNDING`), done. "Your funds are safe." is said only for `not-moved`, `still-protected`, or an
escrow that can be refunded. A read that fails keeps the last known state (never a downgrade); a reorg sends the
leg back to pending and nothing is re-sent.

### 12.5 Persistence, reconciliation, notifications (doc §38, §73–§76)
The operation id persists locally (the journal) and survives a reload, a tab close, a browser restart, a mobile
Safari reload, a temporary network loss and a wallet disconnect (§19 e2e). The displayed state is the reconciled
one: local record → the API's record (`POST /v1/operations/:id/reconcile`, swaps only) → the chain (the wallet's own
quorum) → the provider; the wallet's own chain reads win when they disagree. While offline, money-moving steps
pause and resume only after the state is verified (§7.11). `notificationFor(prev, next, prefs)` produces the five
kinds (Quote ready, Transaction confirmed, Cross-chain executing, Completed, Recovery required) without amounts
unless the user opted in (the V3 preview setting); delivery (web push) is later.

## 13. Swap engine, providers, risk (doc §27–§33, §45–§48, §81–§82) — *Stages 3, 9, 11, 12*

### 13.1 Interfaces
```ts
interface SwapEngine { getQuotes(r: QuoteRequest): Promise<Quote[]>; selectBestQuote(q: Quote[]): Quote;
  validateQuote(q: Quote): Promise<ValidationResult>; prepareExecution(q: Quote): Promise<PreparedExecution> }
interface SwapProvider { quote(r): Promise<Quote>; prepare(r, q): Promise<PreparedExecution>;
  validate(p): Promise<ValidationResult>; execute(p): Promise<Execution>; track(id): Promise<ExecutionStatus>;
  recover(id): Promise<RecoveryResult> }
```
`packages/swap-engine` implements them over the existing engine: `quote` and `prepare` are the adapters'
`quote` / `prepareIngress`; `validate` is the adapters' own calldata verification plus the wallet-side
`checkProviderCall`; `execute` is the relayer's hand-over (the escrow's `deployAndExecute`); `track` the adapters'
`track`; `recover` the order's `recoverState` + `settlementOf`. THORChain is the first adapter; Chainflip, Mayan,
LI.FI, Across and NEAR Intents remain. The frontend is never coupled to a provider: provider-specific code lives
in the adapter and in the wallet's independent call decoder (`providerCall.ts`, a verification layer). The
estimated time is the real one: proving + funding confirmations + the provider's own estimate, never a constant.

### 13.2 Quote request and quote (doc §45–§46)
```ts
type QuoteRequest = { sourceAssetId: string; destinationAssetId: string; amount: string;
  destinationType: "protected" | "external"; destination?: string }
type Quote = { id: string; sourceAsset: Asset; destinationAsset: Asset; inputAmount: string; expectedOutput: string;
  minimumOutput: string; privacyFee: string; relayerFee: string; providerFee: string; totalFee: string;
  expiresAt: number; estimatedSeconds: number; privacy: PrivacyAssessment; risk: RiskAssessment }
```
The server gets only what the route engine needs: no destination for an indicative quote (placeholders, V1.1),
the destination at commit. `destinationType: "protected"` is valid only for an asset with a canonical vault on the
pool's chain (a same-chain swap, §11.2).

### 13.3 Selection (doc §27, §81)
The engine weighs output, price impact, fees, timing, provider health, liquidity, reliability and privacy; an
unsafe route (expired, halted, breaker open, no hard minimum, an unverifiable minimum, outside the provider's
limits, a high impact at high value, a stream above four hours when a faster route exists) is scored for
information and **never chosen, whatever its nominal output**. A partial quote (no minimum, no expiry) is refused.

### 13.4 Risk and blockers (doc §47–§48)
```ts
type RiskAssessment = { score: number; level: "low" | "medium" | "high"; blockers: BlockerCode[]; warnings: string[] }
type BlockerCode = "quote_expired" | "asset_unsupported" | "destination_invalid" | "provider_unhealthy"
  | "minimum_below_limit" | "parameters_changed" | "network_mismatch" | "unsafe_contract_call"
```
`assessRisk(facts)` (`packages/risk-engine`) composes the provider health, the quote age, liquidity, the
destination check, the slippage, the execution's complexity, the network status, recent provider failures and the
large-trade status. Blockers are re-checked between the Review and every signature; one blocker stops the
operation with the §7.9 words and nothing moves.

### 13.5 Large trades (doc §49–§50)
From $50K the operation runs as protected steps: in flight ≤ the configured limit (the band's four sequential
quarters; V4's caps above $100K), the strict quote (TTL ≥ 60 s, slippage ≤ 50 bps), provider health (breaker
closed, security ≥ 60, no incident within a day), the destination verified, recovery tracking. The engine
subdivides; the UI shows amounts only.

## 14. Privacy engine, transport, proof pipeline (doc §34–§35, §59–§60, §65) — *Stages 4, 11, 15*

### 14.1 The assessment
```ts
type PrivacyAssessment = { level: "low" | "medium" | "high"; reasons: string[] }
```
from the six V4 components (source, amount, timing, destination, provider metadata, route structure) — a score of
0–100 → high ≥ 75, medium 50–75, low < 50 (the V4 words Excellent / Good / Reduced leave the UI). Timing (*V6*):
from the youngest note the funding spends — its age and the deposits since its leaf: 1 under an hour or ten
deposits, 0.7 under six hours or fifty, 0.3 under a day, else 0. Right after a Protect the level reads Medium with
"You protected these funds recently; waiting makes this swap harder to link." and `Delay for more privacy` (spend
older notes first, else fund at a random time in 1–24 h).

### 14.2 Transport (doc §65)
`packages/privacy-engine/src/transport/`: `http.ts` (the V5 policy: no credentials, no redirect, no cache, no
referrer, a host allowlist enforced in production, every request announced for the leakage gate) and `chain.ts`:
```ts
interface PrivacyTransport { read(call): Promise<Hex>; broadcast(tx): Promise<Hash>; getBlock(tag): Promise<Block>;
  getLogs(filter): Promise<Log[]> }
```
over the read quorum and the light client — every chain read goes through it (lint: `createPublicClient` only
there), so a private RPC, distributed RPC, light-client or PIR transport replaces one module later.

### 14.3 Proof pipeline (doc §59–§60)
Main thread → a long-lived crypto worker → the Rust/WASM core and the prover. The worker hosts the WASM core (tree
layers and note discovery leave the main thread), builds the circuit inputs from a spend plan, and proves
(snarkjs); circuit inputs never exist on the main thread; the UI receives progress, success or an error only. The
proving key is cached in the Cache API under its pinned SHA-256 and re-verified on read. The seed still lives on
the main thread (unlocking inside the worker is a later pass). A Rust prover compiled to wasm32 is adopted only if
a benchmark shows it at least 1.5× faster than snarkjs with identical public signals (`benchmarks/proof/`).

## 15. The API (doc §44–§46, §63–§64, §67–§68) — *Stage 9*

`apps/api`: Express 5 on `node:sqlite` (`DatabaseSync`, WAL, `synchronous=NORMAL`, `foreign_keys=ON`,
`busy_timeout`, migrations by `PRAGMA user_version`). Routes:
```
GET  /v1/assets   /v1/networks   /v1/providers/health   /v1/status
POST /v1/quotes
POST /v1/operations              GET /v1/operations/:id
POST /v1/operations/:id/{reconcile, prepare, finalize, resume}
GET  /v1/track/:provider   /v1/risk   /v1/risk/:provider
POST /v1/guest/quote   /v1/guest/ingress     GET /v1/guest/track/:provider/:txid
GET  /v1/gateway/health          POST /v1/gateway/quote
```
Only swaps and cross-chain swaps get records (Protect and Send are chain-only). Ids are opaque — `op_` / `qt_` +
base32 of 16 random bytes; they are bearer capabilities: there is no listing endpoint, and the on-chain order id
never appears in a URL. Tables: `assets`, `providers`, `provider_health`, `chain_state`, `quotes`, `operations`,
`executions`, `relayer_jobs` (the API's cached view of the relayer's public job endpoints), `system_events`.
**Never stored**: notes, keys, recovery phrases, witnesses, balances, the user's public address, IP addresses, user
agents, the funding transaction, any history beyond retention; the order's destination and refund material exist
only in `operations.order_blob` until `finalize` nulls it. Retention (a purge every 10 minutes): quotes 1 h after
expiry; terminal operations after 7 days; an abandoned operation 2 days after `refund_after`; `system_events` 7 days;
`provider_health` 48 h. Reconcile reads the relayer job, the chain (escrow balance, receipts, the receiver) and
`adapter.track`, computes `settlementOf`, persists, answers `{state, settlement, refs, checkedAt, sources}`; one call
per id per 5 s. Security: a CORS allowlist, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, HSTS behind
TLS, no `x-powered-by`, 64 KB bodies, 415 for another content type, in-memory token buckets, `trust proxy` off.
**Logs** (doc §67, `packages/server-kit`): one JSON line per event with keys ⊆ {`at`, `level`, `event`,
`operationId`, `provider`, `state`, `errorClass`, `network`} — the typed logger accepts nothing else; no address,
transaction hash, amount, Bitcoin or Solana string ever (the §19 log gate).

## 16. The relayer (doc §42–§43) — *Stages 7, 12*

`apps/relayer` accepts, validates, estimates, submits, monitors, reconciles and reports: private submissions paid
by a fee note (§3's rule), the swap executor (one pass at a time), the refund-only jobs, and (*V6*) the shield
executor (`POST /shield`, `GET /shield/:receiptId`, states `waiting-delivery → shielding → shielded |
shield-failed`, a journal `shield-jobs.json`, the tip checked against the estimated gas, unpaid re-shields bounded).
It never receives a protected wallet's key, recovery phrase, raw note secret or full witness. Every job records its
receipt's actual cost (§3). Its logs follow §15's logger.

## 17. Security, supply chain, CI (doc §17, §64, §66, §68–§69, §83) — *Stages 2, 15*

No analytics, session replay, advertising pixels, wallet profiling or fingerprinting; the build contains only
first-party code (a bundle scan). The web build carries the V5 Content-Security-Policy and header set
(`docs/deployment.md`); the API and the relayer send §15's headers. Supply chain: `scripts/check-lockfile.mjs`
(lockfile v3; every non-link entry from `https://registry.npmjs.org` with a sha512 integrity; `@privacy-wallet/*`
only as workspace links; no `file:`, `git+` or `http:` dependency), `scripts/dependency-review.mjs` (the lockfile's
diff against a base: added and changed packages, install scripts, licences; a change to a crypto-sensitive package —
`@noble/*`, `@scure/*`, snarkjs, ffjavascript, viem, `@walletconnect/*` — fails without a dated entry in
`docs/dependency-reviews.md`), `scripts/check-import-case.mjs`, `scripts/audit.mjs` (npm audit). The zkAPI SDK is
resolved from `ZKAPI_SDK_DIR` when the clone exists, else a stub that says Private AI is not in this build.
**CI** (`.github/workflows/ci.yml`, actions pinned by commit, `permissions: contents: read`): checkout → Node 24 →
Foundry → the lockfile check → `npm ci` → `node scripts/verify-all.mjs --ci --forge 0.8.24`; a dependency-review job
on pull requests. Rust, the live suites, the screenshot harness and the local-stack browser run stay local.

## 18. Localization and accessibility (doc §77–§78) — *Stage 16*

Every string is a catalog key; the doc's ids are used where it names them (`protect.title`, `protect.subtitle`,
`swap.receive`, `swap.minimumReceive`, `swap.privacyFee`, `swap.relayerFee`, `operation.executing`,
`operation.completed`). Languages: English and **Korean** — every key used by a Simple screen, a notice or an error
is translated (test-enforced); an Advanced-only string may fall back to English and the language picker
(More → Language, `prefs.locale`, `<html lang>`) says so; a native speaker's review is a stated gap. Numbers, dates
and relative times through `Intl`. Accessibility: roles and names, labels linked, live regions for state changes,
keyboard paths for Protect / Send / Swap, focus trapped and restored in sheets, 44 px targets, reduced motion, high
contrast and forced colors, 200 % text without clipping, axe clean on every fixture state.

## 19. Gates (doc §79–§88) — *Stages 1–17*

| Gate | Checks | Where |
|---|---|---|
| unit | fees (§3, the §80 matrix), formatting, transitions, validation, ranking, privacy assessment | every package's suite |
| integration | wallet, API, relayer, swap providers (offline + live), contracts (forge), the chain sync | verify-all steps |
| E2E | Protect, Send, Swap, Cross-chain, Recovery, Activity, Classic; reload / tab close / restart / offline / disconnect | `scripts/local-stack/e2e.mjs` |
| privacy leakage | no secret in localStorage, sessionStorage, IndexedDB plaintext, URLs, query strings, console, worker messages outside the crypto worker, request bodies, API or relayer logs; every host allowlisted; the bundle has no tracker, no source map, no test seed | `apps/web/test/privacy-leakage*.test.tsx`, `apps/api/test/logs.test.ts`, `scripts/scan-bundle.mjs` |
| screenshots | Home, Protect, Send, Swap, Cross-chain, Review, Executing, Completed, Recovery, Classic, Privacy Center at 390x844, 430x932, 768x1024, 1440x900 against reviewed baselines (pixelmatch 0.1, ≤ 0.1 % pixels) | `tests/visual/` (`verify-all --browser`) |
| acceptance | §86 (the $10,000 Review's ten items), §87 ($80,000: protection, checks, verification, progress, hold, no toggle), §88 (every 390 px action at 1440 px), §92 (the vocabulary scan of every Simple fixture), layout (one primary, the CTA visible above the keyboard, no horizontal scroll at the ten §6 sizes); §85 as a scripted human checklist | `tests/visual/` |
| supply chain | lockfile, dependency review, import case, doc paths, audit | `scripts/*` |
| budget | first-route JS ≤ 250 KB gzip, Home ≤ +80 KB, snarkjs after Confirm only, WASM only when needed | `scripts/check-budget.mjs` |

## 20. Implementation order (doc §89, §91) — the V6 stages

| Stage | Doc §89 step | Sections |
|---|---|---|
| 0 | 1 freeze the product contracts | this document |
| 1–2 | 2 the monorepo; tooling; CI | §4, §17 |
| 3–4 | 2 (carve-out), 5 wallet layer, 6 protected wallet core, 7 asset registry | §4, §8–§10 |
| 5 | 3 design system + preview page, 4 the shell | §5, §6 |
| 6 | the five core screens visually correct on fixtures (§91: Home → Protect → Protected Balance → Send → Swap) | §7, §19 |
| 7 | 9 fee engine; the ProtectRouter | §3, §11.1 |
| 8 | 8 operation engine | §12 |
| 9 | the API (doc §44) | §15 |
| 10 | 10 Protect, 11 Send | §7.3–§7.4 |
| 11 | 12 swap engine, 13 THORChain, 14 cross-chain UX | §7.5–§7.9, §13 |
| 12 | same-chain swaps into the protected balance | §11.2 |
| 13 | 15 large trade protection | §2, §13.5 |
| 14 | 16 Classic Privacy, 17 Privacy Center | §7.10–§7.11, §11.3 |
| 15 | 18 security test suite; auto-lock, offline, proof pipeline | §8, §12.5, §14.3, §17, §19 |
| 16 | 19 desktop, 20 performance; Korean; accessibility | §6, §18, §19 |
| 17 | the Definition of Done | §21 |

## 21. Definition of Done (doc §94)

`docs/definition-of-done-v6.md` maps every line of doc §94 to its evidence (a test file and name, a verify-all
step, a report JSON, a baseline image, a section here) and its status. Product: beginner-usable, mobile primary,
desktop polished, consistent core flows, transparent fees, stronger protection for large transactions. Wallet:
external connection, protected wallet, encrypted local storage, lock/unlock, recovery. Privacy: protected balance,
Protect, Private Send, privacy status, Privacy Center, data minimization. Swap: same-chain, cross-chain, THORChain
adapter, provider abstraction, quote expiry, minimum receive, fee calculation, destination validation, settlement
tracking, recovery. Classic: separate mode, separate state, separate boundary, dedicated review. Security: contract,
crypto, browser privacy, network leakage, storage leakage, E2E and failure/recovery tests. Doc §85 (a first-time
user understands the balance, Protect, Swap, the pay and receive amounts, the 1 % fee, the relayer cost and
completion) is a scripted five-person checklist for the owner.

## 22. Crosswalk — doc §1–§96

| Doc § | Here | Stage |
|---|---|---|
| 1–3 product, user model, mental model | §1 | 0, 6 |
| 4 classes | §2 | 13 |
| 5 fees | §3 | 7 |
| 6–10 design system, identity, tokens, components, buttons | §5 | 5 |
| 11–12 shell, breakpoints | §6 | 5, 16 |
| 13–14 Home and its states | §7.1 | 6 |
| 15–19 wallet engine, protected wallet, storage, locking, recovery | §7.2, §8 | 3–4, 15 |
| 20–21 assets | §9 | 3 |
| 22–23 Protect | §7.3, §11.1 | 6, 7, 10 |
| 24–25 Send | §7.4 | 6, 10 |
| 26–33 Swap, engine, providers, routes, cross-chain, destination, expiry, slippage | §7.5–§7.6, §13 | 6, 9, 11, 12 |
| 34–36 privacy engine, indicator, Privacy Center | §7.10, §14.1 | 11, 14 |
| 37–41 operation states, persistence, Activity, detail, recovery | §7.8, §12 | 6, 8, 11 |
| 42–43 relayer, relayer fee | §3, §16 | 7, 12 |
| 44–48 API, quote request/response, risk, blockers | §7.9, §13.2–§13.4, §15 | 3, 9, 11 |
| 49–51 large trades | §2, §7.6–§7.7, §13.5 | 13 |
| 52–53 Classic | §11.3 | 14 |
| 54–55 desktop, bottom sheets | §5, §6 | 5, 16 |
| 56–57 keyboard, touch | §5 | 5 |
| 58–60 loading, proof pipeline, Rust core | §7.7, §14.3, §4 | 4, 15 |
| 61–62 SDK, no crypto in React | §4 | 4 |
| 63–64 local and server data, minimization | §8, §15 | 9 |
| 65 transport | §14.2 | 4 |
| 66–69 analytics, logging, headers, dependencies | §15, §17 | 2, 9, 15 |
| 70–72 contracts, versioning, chains | §9, §10 | 3 |
| 73–76 sync, refresh, offline, notifications | §7.11, §12.5 | 9, 15 |
| 77–78 accessibility, localization | §18 | 16 |
| 79–84 testing, fees, quotes, cross-chain failures, leakage, screenshots | §19 | 5–17 |
| 85–88 acceptance | §19 | 6, 17 |
| 89–91 development order, architecture, build-first | §4, §20 | all |
| 92 Golden UX rule | §1, §19 | 6 |
| 93 product structure | §1, §6 | 5 |
| 94 Definition of Done | §21 | 17 |
| 95 strategic direction | §23 | — |
| 96 principle | §1 | — |

## 23. Deviations and out of scope

Deviations, each the owner's or recorded for the owner: no wagmi (§8); "Securing your transaction" for "proof" in
Simple (§7.7); the real ETA instead of "~2 min" (§13.1); "Your funds are safe." only when true (§12.4); `CANCELLED`
kept (§12.1); the Privacy Center at `/more/privacy` (§6); no server-side note indexer — the "Indexer" of doc §90 is
the wallet's verified sync plus the API's `chain_state` (§15); Prettier on new code only; Korean for Simple screens,
notices and errors (§18); the seed on the main thread (§14.3); the visual suite local only (§17); `packages/server-kit`
added. Out of scope: the React Native apps and native shells (doc §95; `docs/mobile.md`), biometrics and
second-device confirmation (doc §51 "later"), web push delivery, the Classic contracts / circuit port / legal review,
LI.FI and Chainflip same-chain routes, a private RPC or PIR transport behind §14.2's seam, a repository-wide
reformat, the production ceremony, external audits, the testnet broadcast, and any change to PrivacyCore, the
vaults, the circuits or the swap escrow.

