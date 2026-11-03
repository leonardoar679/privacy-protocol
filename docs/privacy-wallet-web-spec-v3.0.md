# Privacy Wallet Web — Specification V3.0

Normative. The frozen product contracts of the owner's document "Privacy Wallet Web V1.1 — Master Development Plan"
(§1–§15, 2026-10-26; "doc §n" below), as decided by the owner on 2026-10-26 (the ten decisions of §22). The document
describes **two products inside one website** with one visual identity and two separate transaction systems: the
**Privacy Wallet** (the main product, built by the V5 and V6 passes and frozen by `docs/privacy-wallet-web-spec-v2.0.md`)
and **Tornado Classic** (an original-style interface for the existing Tornado Cash Classic pools on Ethereum mainnet,
new in this pass). This document supersedes v2.0 only where a section here says so; every v2.0 section it does not name
stays normative, v1.0 stays as the record of the V5 pass, and `docs/private-swap-spec-v1.1.md`,
`docs/whale-execution-spec-v1.0.md`, `docs/high-value-protection-spec-v1.0.md` and
`docs/high-value-execution-contract-v1.0.md` stay normative for the engines underneath, except where a section here is
marked *V7*. **`PrivacyCore`, the vaults, the circuits, the `SwapOrderEscrow` / `SwapOrderFactory`, `ProtectRouter` and
`ShieldReceiver` bytecode are unchanged by this document.** *As landed (the third review round, 2026-11-03): a reviewer's
line-by-line read of the contracts changed `ShieldReceiver` (wrapped ETH and ETH at a receiver are never swept to the
fallback; at a token receipt they shield as ETH) and `SwapOrderEscrow` (`_payTip` leaves a balance of the tip or less whole),
so the creation code of both factories changed with them — before any public deployment; the pins, the vectors and the
real-proof fixture are of the new build (v2.0 §11.2; `docs/audit-package.md` §1.3).* The Classic app never calls `PrivacyCore`; the Privacy
Wallet never calls a Classic pool; nothing moves a Classic note into the Privacy Wallet or a protected note into a
Classic pool.

Status words MUST / MUST NOT / SHOULD are RFC-2119. Each section names the doc sections it freezes and the V7 stage
that builds it (`docs/roadmap.md`, the V7 table). `Code:` lines name paths; a path that does not exist yet is listed in
`scripts/doc-paths-allowlist.txt` until its stage lands. Paths beside the repository (the archived upstream clones)
are written `../…`.

---

## 1. Two products, one site (doc §1, §5, "Final architectural decision") — *Stage 0*

| | Privacy Wallet (main) | Tornado Classic (existing-user mode) |
|---|---|---|
| What | protect, private balance, Private Send, same-chain and cross-chain swaps; optimized for $1K–$20K, stronger safeguards at $50K–$100K | the recognizable original deposit / withdraw interface for the four Ethereum ETH pools 0.1, 1, 10 and 100 ETH, with the original note format |
| Contracts | `PrivacyCore`, its vaults, `ProtectRouter`, `ShieldReceiver`, the swap escrow (v2.0 §10–§11) | the EXISTING mainnet pools and the Tornado Router (§7.2) — never a new or substituted pool |
| Fee | the 1 % privacy fee on every billable operation + the relayer / network / provider costs (§3) | **no 1 %**: the protocol's own semantics — the relayer's fee and the network fee, disclosed as such (§7.5) |
| Words | Protect, Send, Swap (v2.0 §7) | Deposit, Withdraw, Note — the historical terms (§7.9) |
| Secrets | the protected wallet's seed, encrypted at rest (v2.0 §8) | the note, a bearer secret that is **never stored** by the app (§7.8) |
| Where | `apps/web` and the packages (v2.0 §4) | a separately built, separately locked, separately licensed app, `classic/` (§7.8, §8) |

The eight non-negotiable rules of doc §5 hold as they did in V6 (an immutable core with no custody and no
administrator; one canonical vault per asset; one note tree with every note bound to its vault; commitments,
nullifiers and local proving; private execution fees where supported and transparent relayer charges; cross-chain
execution outside the core; explicit public-data disclosures when assets leave the protected system — v2.0 §1, §3,
§11, §13) and gain one: **no automatic connection between Classic assets and the new protocol** (§7.11). The
cross-chain disclosure of doc §5 is stated in the words of v2.0 §7.6: a swap to Bitcoin is not a private Bitcoin
transfer — the provider, the settlement amounts, the timing and the destination can be seen.

## 2. Information architecture (doc §2, §3, §15) — *Stage 4* (supersedes v2.0 §6's route table and §7.11's More list)

The site opens into the Privacy Wallet at `/`. The mobile bar stays **Home · Swap · Activity · More**. **More lists
Tornado Classic, Privacy Center and Settings** (the Advanced experience adds Private AI). The desktop bar keeps the
v2.0 shape `Logo · Home Swap Activity · Wallet` with the Wallet menu holding the connection row, a **Connect wallet**
button (or the account chip `0x7A…91F2` once connected) and the More entries; on the phone the **Connect wallet** /
account chip sits in Home's header (doc §3: "Connect wallet" in the header; the one-bar rule of v2.0 §6 stays).
Connecting offers a connector picker (the EIP-6963 wallets found, the injected wallet, WalletConnect when configured)
and the last connector is reconnected after a reload (`prefs.lastConnector`). Connecting never creates, unlocks or
exposes the protected wallet (v2.0 §1).

| Route | Screen | Was |
|---|---|---|
| `/`, `/protect`, `/send`, `/swap`, `/activity` (+ their sub-routes) | unchanged (v2.0 §6) | — |
| `/receive` | Receive — reached from Settings → Connected wallet and from a secondary action on Home's balance card | More |
| `/classic`, `/classic/deposit`, `/classic/withdraw` (+ `/classic/history`, `/classic/settings`) | **Tornado Classic — a separate application served under `/classic/`** (§7.8); the More entry is a plain link that leaves the wallet's router | `/more/classic/*` |
| `/privacy`, `/privacy/what-stays-private` | Privacy Center | `/more/privacy/*` |
| `/settings`, `/settings/advanced` | **Settings**: one page with the sections Backup & security (backup, phrase, auto-lock, second factor, large-transfer thresholds, forget), Connected wallet (connection, allowances, the Receive address), Trading preference, Language, Experience (Simple / Advanced), Notifications; the Advanced section (today's `/more/advanced`) in the Advanced experience | `/more/security`, `/more/wallet`, `/more/language`, `/more/advanced`, the switch on `/more` |
| `/more` | the More list | unchanged |
| `/more/ai` | Private AI (Advanced) | unchanged |

Every old `/more/*` path **redirects** to its new home (bookmarks and the auto-lock's return path keep working); the
More tab stays highlighted on `/privacy` and `/settings` (`/classic` is another application: the wallet's bars are
not on its pages). The Settings page takes the test id `settings`; the former Security page's inner id follows it.
Every new string exists in English and Korean. *Stage 4 as landed:* the V6 Classic module's devnet screens under
`/more/classic/*` stay reachable by URL (nothing links to them) until Stage 11 removes the module, when
`/more/classic/*` redirects to `/classic/` like the rest; the notification toggles moved from Advanced to the Settings
page's Notifications section; the trading preference's words moved into the catalog (English and Korean).

Code (Stage 4): `apps/web/src/routes/index.tsx` (the routes and redirects), `apps/web/src/features/more/entries.ts`,
`apps/web/src/features/settings/Settings.tsx` (the one page composing today's `Security.tsx`, `Wallet.tsx` and
`Language.tsx` as sections — unwrapped from their pages, every test id kept — with the notification toggles from
`Advanced.tsx` and the experience switch from More; the screenshot fixture renders it over the stores at their
defaults), `apps/web/src/features/wallet/ConnectSheet.tsx` (the connector picker), `apps/web/src/features/wallet/Home.tsx` (the header's
account chip, the gear to `/settings`, the badge to `/privacy`, Receive), `apps/web/src/app/Shell.tsx` and
`packages/ui/src/components/Layout.tsx` (the Connect wallet control, the highlight prefixes),
`packages/wallet-engine/src/connection.ts` (connect by connector id, reconnect from the preference),
`apps/web/src/storage/prefs.ts` (`lastConnector` read and written), the moved test pins and the e2e shell pass.

## 3. The fee policy statement (doc §6) — *Stage 12* (adds to v2.0 §3; the owner's decision 2 of §22)

The formulas, the enforcement and the executor tip of v2.0 §3 stand. This section adds what doc §6 asks for: when the
1 % is charged, said to the user before launch.

**Billable operation.** The 1 % privacy fee `p(A)` is charged **once per operation the user confirms** — a Protect, a
Send, a withdrawal, a Swap (same-chain or cross-chain). A swap's internal steps (proving, funding the escrow, the
relayer's submission, the provider's execution, the settlement) are ONE operation and pay ONE `p(A)`; a protected
execution's pieces together pay `p(A)` of the whole (each piece's note carries its share, rounded up by at most one
base unit a piece). Merges, splits, refunds and re-shields pay no `p`; they pay the relayer's cost `F` where a relayer
acts (v2.0 §3). **A Protect followed later by a Swap are two operations and each pays its 1 %** (the owner's decision:
"1 % on every operation, disclosed"). The Review of every operation states it: `Privacy fee (1 %) — charged on each
protect, send and swap`; a Swap funded from protected notes adds the sentence `Your funds paid 1 % when they were
protected; this swap pays 1 % again.`

**The published policy** (`docs/fee-policy.md`, linked from the Privacy Center and from Settings as "Fees & refunds"):
the 1 % and its rounding; once per operation; the relayer's cost `F` as a bound shown before signing (v2.0 §3 "the fee
shown is a bound"), now **also for a protected execution's pieces** (each piece carries `reviewedFee`; the Review shows
`F × n`); the executor tip as the execution's gas; **the privacy fee of a swap is earned when the escrow is funded**: a
swap that the provider does not deliver returns the swapped amount to the protected balance (the refund path of v2.0
§11, §12.4) and does not return the fee note — the published policy says so in those words, and the refund screen's
funds line names the amount that comes back; Classic charges no 1 % and discloses the relayer's fee and the network
fee separately (§7.5). The eight rules of doc §6 and their status:

| Doc §6 rule | Status |
|---|---|
| 1 integer / exact decimal math | fee code bigint-only (v2.0 §3, a source scan); *V7*: the USD lines of the swap screen and the Classic fee lines compute in integer base units and cents too |
| 2 quotes bound to input / output asset, network, minimum receive, expiry and fee terms | *V7*: `Quote` carries `feeTerms {privacyFeeBps, relayerFee, maxFee, termsAt}` beside `expiresAt` and `minimumOutput`; the API's §46 quote states `p(A)` of what the user pays (it stated `p(W)`) |
| 3 privacy fee shown apart from relayer / network / provider fees | v2.0 §3 (the lines); on chain `p + F` ride one fee note — stated in the policy |
| 4 no hidden extra relayer percentage | the relayer's `feePercentBps` IS the privacy fee (≤ 100, else the relayer is not used); its margin on gas is stated in the policy |
| 5 bounded relayer fee with an agreed maximum | v2.0 §3 for single operations; *V7*: the pieces of a protected execution |
| 6 no fee when the service was not delivered, per a published refund policy | the policy states the opposite for the privacy fee (earned at funding, the escrow bytecode cannot hold it) and the refund of the swapped amount; nothing is charged for an operation that never leaves the Review or whose funding is refused before anything is sent (`FeeMoved`, `TipStale`, `OrderWindowClosed`, `CostUnknown`) |
| 7 retries, reconciliations and refunds follow the signed terms, never a silent second 1 % | a funding is never sent twice (v2.0 §12.5); *V7*: a protected execution's piece that is refunded and planned again pays the piece's share again — stated on the progress screen before it happens, under the Review's `F × n` bound |
| 8 Classic fees distinct | §7.5 |

Code (Stage 12): `docs/fee-policy.md`; the Review lines (`apps/web/src/features/review/`, en + ko); the Privacy Center
and Settings links; `apps/api/src/quote.ts` (`p(A)`); `packages/protocol-types/src/quotes.ts` (`feeTerms`);
`packages/sdk/src/wallet/campaignRunner.ts` and `packages/sdk/src/swapFunding.ts` (the pieces' `reviewedFee`);
`apps/web/src/features/swap/model.ts` (integer USD lines).

**As landed (Stage 12, 2026-10-27).** `docs/fee-policy.md` is the published policy — the 1 % and its rounding, once per
operation, a Protect then a Swap paying twice, the relayer's cost as a bound (the pieces of a protected execution
included), the executor tip as gas, the swap's privacy fee earned at funding and the swapped amount returned without it,
when nothing is charged, Classic apart, the eight rules — and `apps/web/src/features/privacy-center/FeesAndRefunds.tsx`
says the same in the app (English and Korean) at `/privacy/fees`, reached from the Privacy Center's transaction section
and from Settings' trading section as "Fees & refunds". Every Review's fee section ends with the statement *Privacy fee
(1 %) — charged on each protect, send and swap.* and a swap's with *Your funds paid 1 % when they were protected; this swap
pays 1 % again.*; a protected execution's relayer row reads *Relayer/network (n steps)* for `F × n`. The §46 quote states
`p(A)` of what the user pays — the wallet sends `grossAmount` beside the escrow's `amount` — and carries `feeTerms`
(the basis points, `F`, the tip, their sum as the bound, when they were read). The campaign's bounds record the Review's
`F` (`maxRelayerFee`) and its basis points (`relayerFeeBps`), and each piece's order is committed with `reviewedFee` = the
one fee note for delivering the piece under those terms — exact output, `p(W + f) + F`, as the funding itself prices it
(`stepReviewedFee` over `feeForWithdrawal`; the piece's share alone plus `F` fell short of the relayer's rule, which the first
full local run after Stage 12 found) — so a piece's funding never pays more; a piece whose relayer asks more than that pauses
the operation (`bounds`, the reason shown) rather than pays; a campaign from before stays as it was. The swap screen's provider
fee is integer cents from the price where the fee is in the source asset (the provider's own dollar figure only for a fee
in another asset). The fee code itself is unchanged: the formulas and the enforcement are v2.0 §3's.

**As landed (the review round of 2026-11-02).** The band's protected steps carry the Review's terms: the Swap screen passes
`terms` to `startCampaign`, so every step's funding is bound by the relayer's minimum and percentage the Review showed (the
steps had run without the bound since Stage 13; `apps/web/test/swap-protected-steps.test.tsx`). The API's §46 quote values
the route's qualification at what the user pays — the set is valued at the escrow's funding and `valuedAt` scales it to
`grossAmount` (`apps/api/src/quote.ts`) — and `POST /v1/quotes` refuses a `grossAmount` below `amount` (400). The facade's
parity test pins the commit's facts: the request as given reaches the service and the reviewed fee is journaled.

**As landed (the second review round, 2026-11-03).** The merges a swap's funding needs first — a spend of three notes or
more — are named on the Swap Review (the merges row, each at the relayer's minimum, as the Send Review has had them since
r43), journaled as `reviewedMergeFee` and passed to the funding as the merges' bound; a protected execution's steps bound
theirs by the Review's F (`bounds.maxRelayerFee`) at the commit and in the note shaping. A send the connected wallet submits
(Advanced) pays no privacy fee and no relayer fee: its Review's relayer row says the wallet pays the network fee and the fee
statement says no privacy fee is charged (gap 31's rule, now stated).

**As landed (the third review round, 2026-11-03).** The band's steps Review states the campaign's price bound as its Minimum —
the quote's minimum per unit less 0.5 % over the steps' amount, net of the tips, a unit per step under the steps' own floors
(`campaignMinimumOutput`) — and its Protected execution card reads "Price bound: each step guarantees the quote's minimum per
unit, less 0.5 %" in place of "Quote locked"; the relayer row for steps is marked an estimate, as the tips are (each step pays
its own at its time, within the bounds). Before, it stated the one order's minimum, which no step was held to, and the campaign
could deliver about half a per cent under it without a pause.

## 4. The amount policy (doc §8) — *Stage 13* (supersedes v2.0 §2; the owner's decisions 3 and 4 of §22)

| Doc §8 band | Tier (code) | Behaviour |
|---|---|---|
| under $1K | `standard` | the ordinary flow |
| $1K–$20K | `standard` | standard protected execution (the one-confirmation flow of v2.0 §7.5) |
| $20K–$50K | `large` | enhanced validation: the Review's privacy lint, the strict quote, a typed destination re-confirmed (v2.0 §2, §12.6) |
| $50K–$100K | `large-protected` | **Protected Large Swap: ONE order by default** — Hold to Confirm, the exposure limit (one protected operation of this band in flight per wallet, `MAX_IN_FLIGHT = 1`, enforced), the destination re-verified (a typed destination is re-confirmed group by group, an address-book destination named), the route's measured liquidity checked (`servedUpToUsd` of the risk database ≥ the order), recovery monitoring (the tracker, the stall rule and the recovery card of v2.0 §12). **The order is split only when justified**: the service's plan says `staged` (a thin route — impact above 50 bps per piece, reliability below 60, the provider's instant limit below the order) or the user asks under Advanced ("Protected steps"); the pieces then follow the V3 planner's varied sizes within the band's cap — **never identical pieces** |
| over $100K | `enhanced` and above | **the Advanced experience only**: Simple shows `Over $100,000 needs the Advanced experience` with the switch; Advanced gets the V3/V4 layer (the V2–V4 Review, campaigns where staged or opted in) after a **liquidity qualification**: a route whose measured limit is below the order is refused (`route_not_qualified`, not moved, "try a smaller amount") |

The 2–3 % simultaneous-exposure table (`EXPOSURE_POLICY`, `TIER_RANGES`, `MODE_CAP_BPS`) is **an engineering
hypothesis, configurable**: the service and the wallet read an optional override (`EXPOSURE_POLICY_FILE` / the risk
database's `bandBps`) over the compiled defaults, and nothing applies a split at the $50K band because of the table
alone. The V6 rule "automatic from $50,000, no mode to choose" (v2.0 §2, doc V6 §87) is withdrawn; the harness's §87
check becomes "one order, hold, the exposure limit, the verified destination, no silent split".

Code (Stage 13, as landed): `apps/web/src/features/swap/SwapScreen.tsx` (`protectedSteps` only when the plan is `staged` or
the user asked — `ProtectionSettings.stepsAtBand`, the Advanced page's "Protected steps" switch —; the Review's card says "One
order — no automatic split" or the steps planned; the Advanced gate card over $100K with its switch; the band's exposure limit
and the route's qualification close Review Swap and block a confirmation), `apps/web/src/features/swap/Swap.tsx` (the same rule
on the protected screen), `packages/sdk/src/wallet/inFlight.ts` (`protectedInFlight`: the band's open orders and running
campaigns; `MAX_IN_FLIGHT` enforced), `packages/sdk/src/wallet/campaigns.ts` (no exact quarters; one seed per quote draws the
Review's pieces and the confirmed plan's), `packages/swap-engine/src/risk/protection.ts` (the band's pieces varied between half
the cap and the cap, in every mode), `packages/protocol/src/wallet/exposurePolicy.ts` (`exposurePolicyFrom` /
`useExposurePolicy` / `exposurePolicy()`: the override the API reads from `EXPOSURE_POLICY_FILE`),
`packages/risk-engine/src/index.ts` and `packages/protocol-types/src/risk.ts` (`in_flight_limit`, `route_not_qualified`),
`apps/api/src/quote.ts` and `apps/api/src/routes/swap.ts` (the §46 quote's `route_not_qualified` from the risk database's
`servedUpToUsd`), `apps/web/src/features/swap/model.ts` (the blockers: the band's count, the service's qualification); the tests
`tests/high-value/policy/bands.test.ts`, `tests/high-value/policy/band-property.test.ts` and
`apps/web/test/swap-protected-steps.test.tsx` rewritten (one order by default, steps when staged or asked, the limit, the
qualification, the gate), `packages/sdk/test/in-flight.test.ts`, `apps/api/test/route-qualification.test.ts`; the quick pass:
section 5 meets the Advanced gate in Simple and switches, 8b is one order at $80K (the relayer's job carries the whole amount),
8c the exposure limit (a second $80K names it and Review Swap stays closed). **Deviation:** the planned 8c "a staged order through
a risk-database override" is covered by the unit tests instead (`staged` cannot be forced deterministically against live
providers; the in-flight limit is the e2e's 8c); `docs/HighValuePolicyBenchmark.md` noted.

**As landed (the review round of 2026-11-02).** The V5 screen (`/swap/protected`) is the Advanced experience's: the route
renders it only under `prefs.experience === "advanced"` (the gate's flag — not the settings' detail toggle) or with a campaign
id in the navigation state; the Simple experience reaches it only to see a campaign of its own, and closing it (or an id not in
the journal) goes back to `/swap`. Reachable by URL, the screen judges the band's exposure limit and the service's route
qualification itself before a commit (`protectedCommitBlocker` in `apps/web/src/features/swap/model.ts`, the same two words
Review Swap closes on). The qualification is judged at what the user pays (§3).

## 5. The swap provider facade (doc §7) — *Stage 14* (supersedes v2.0 §13.1's declared interfaces)

```ts
interface SwapProvider {
  id: string;
  getQuote(request: SwapQuoteRequest): Promise<SwapQuote>;
  prepare(quote: SwapQuote): Promise<PreparedSwap>;
  validate(prepared: PreparedSwap): Promise<ValidationResult>;
  getStatus(executionId: string): Promise<SwapStatus>;
  getRecoveryOptions(executionId: string): Promise<RecoveryOption[]>;
}
```

One interface, one name, implemented over what exists: `id` and `getQuote` are the engine's competition over the
six adapters (`quoteAll`, `POST /v1/quotes`); `prepare(quote)` is the two-phase commit of v2.0 §15 (the order is
committed — `buildOrder`, `POST /v1/operations` — then the call is prepared, `POST /v1/operations/:id/prepare`): the
`PreparedSwap` carries the order, the one-time escrow and the provider call; `validate(prepared)` runs **in the wallet**
(`checkOrder` at the commit, `checkPrepared`, `checkProviderCall`, the approved minimum; the simulation on every endpoint where the
signature is made — the independent verification
layer of v2.0 §13.1 stays wallet-side and no provider validates itself); `getStatus(executionId)` reads the operation
(`trackOrder`, the API's reconcile) by the operation id; `getRecoveryOptions(executionId)` is a pure function over the
settlement (`settlementOf`) and the paused codes: `accept-new-minimum`, `return-funds`, `continue-monitoring`,
`retry-hand-over`, `view-progress`, each with the funds class it applies to. **Authorization is separate from
submission** (v2.0 §7.5, §12): the user's Confirm commits; the runner funds, signs and hands over; a status read never
moves funds (`apps/api/src/routes/swap.ts`: no route moves funds; the API co-signs vouches only). THORChain is one
adapter among six; it is the only one for same-chain and guest routes.

**Route validation order** (doc §7): a route is offered to users only with evidence for its quote, source settlement,
destination receipt, timeout, fee and recovery. Today's evidence: 1 Ethereum asset → Ethereum asset into the
protected balance — the local stack's section 7b (quote live, the outbound played by the harness), no real-funds run;
2 ETH → BTC — live quotes, devnet executions, no real-funds delivery; 3 BTC → ETH — the guest instruction only (the
user pays from their own wallet; no wallet-integrated Bitcoin signing); 4 ETH → a Solana asset — live quotes and
calldata decoding only; 5 further EVM assets — the Base targets, quotes only. The registry of evidence is
`docs/test-matrix.md`; a real-funds rehearsal on a public network is the owner's (v2.0 §23).

Code (Stage 14, as landed): the interface `SwapProvider` and the five recovery options in
`packages/protocol/src/wallet/swapProvider.ts` (shared by both sides: the SDK never imports the engine, the engine imports the
protocol), re-exported with `fromAdapter` by `packages/swap-engine/src/provider.ts` (a provider's id, quote and tracking over its
adapter — the engine's three); `packages/sdk/src/swapProvider.ts` (`walletSwapProvider`: `getQuote` the service's competition,
`prepare` the two-phase commit — `confirmOrder` underneath, then the provider call read once —, `validate` the wallet's checks
(`checkBeforeSigning`: the escrow recomputed from the journal and this wallet's factory, the digest of exactly the call, the call
doing what was asked, the approved minimum; the simulation on every endpoint stays where the signature is made,
`prepareAndSign`), `getStatus` over `trackOrder` and the operation record, `getRecoveryOptions` the pure `recoveryOptionsOf`);
the Swap screen commits through `facade.prepare` (`withCall: false`: the runner reads its own call at funding and at signing);
the parity test `apps/web/test/swap-provider.test.tsx` (the call the facade validates is the call the runner checks and signs — the
same provider contract, value, receiver and minimum, the deadline following the fresh quote's expiry; a status read moves nothing), `packages/sdk/test/swap-provider.test.ts`
(the options), `packages/swap-engine/test/provider.test.ts` (`fromAdapter`).

## 6. The operation states V3 (doc §11) — *Stage 15* (supersedes v2.0 §12.1–§12.2's names; the owner's decision 5 of §22)

```
OperationState = DRAFT | QUOTING | READY_TO_REVIEW | AWAITING_AUTHORIZATION | PREPARING_PROOF | SUBMITTING
  | SOURCE_CONFIRMING | PROVIDER_EXECUTING | DESTINATION_CONFIRMING | COMPLETED | CANCELLED | FAILED
  | RECOVERY_REQUIRED | REFUNDING | REFUNDED
```

The document's fifteen, exactly. Terminal: `COMPLETED`, `REFUNDED`, `CANCELLED`, `FAILED`. Drafts: `DRAFT`, `QUOTING`,
`READY_TO_REVIEW` live in memory (v2.0 §12.1); a record is journaled from `AWAITING_AUTHORIZATION`. The open states in
order: `AWAITING_AUTHORIZATION` (confirmed; waiting for the external wallet's or the user's final authorization) →
`PREPARING_PROOF` (the witness, the proof, the local verification) → `SUBMITTING` (the first send in progress: the
transaction handed to the wallet or the relayer, the escrow funding sent) → `SOURCE_CONFIRMING` (accepted; the source
chain confirming) → `PROVIDER_EXECUTING` (the source final; the relayer or the provider executing) →
`DESTINATION_CONFIRMING` (the destination submitted, waiting for its finality) → `COMPLETED` (the provider's word, never
a relayer hash alone — v2.0 §12.3 I-O4). A Protect goes `AWAITING_AUTHORIZATION → SOURCE_CONFIRMING → COMPLETED` (the external wallet signs and sends in one
step — its prompt is the authorization, declinable, and `SUBMITTING` is that step's instant; as landed, Stage 15: a
Protect's progress never moves its state); a Send goes `AWAITING_AUTHORIZATION → PREPARING_PROOF → SUBMITTING →
SOURCE_CONFIRMING → COMPLETED`; a swap runs the whole line. **I-O7 moves to `SUBMITTING`**: once a record has entered
`SUBMITTING` it never returns to a state before it (the reducer names that refusal, `after-submission`, before the table's
`not-allowed`). A declined authorization goes back to `READY_TO_REVIEW` with `declined`. The post-funding "price moved" wait is `RECOVERY_REQUIRED` with the reason `minimum_moved` (actions
`accept-new-minimum`, `return-funds`); a quote that expires before funding returns the draft to `READY_TO_REVIEW` with the
reason `quote_expired` ("Get new quote"). I-O1–I-O6 stand with the new names.

| V6 (v2.0 §12.1) | V7 |
|---|---|
| REVIEW | READY_TO_REVIEW |
| AWAITING_SIGNATURE | AWAITING_AUTHORIZATION; PREPARING_PROOF while `progress.step` is witness / proof / local-verify; SUBMITTING at 'submitting' (a Protect's record stays AWAITING_AUTHORIZATION: its step is the external wallet's prompt) |
| SIGNED | SUBMITTING |
| SUBMITTED, CONFIRMING | SOURCE_CONFIRMING |
| EXECUTING | PROVIDER_EXECUTING |
| SETTLING | DESTINATION_CONFIRMING |
| QUOTE_EXPIRED | before funding: READY_TO_REVIEW + `quote_expired`; after funding: RECOVERY_REQUIRED + `minimum_moved` |
| every other name | unchanged |

The scheduler's last failure for an operation — a runner tick that threw, retried with a growing backoff — is named on
the operation's detail in the catalog's words with the next attempt, the message itself under Advanced, and "Try again
now" drops the backoff and wakes the scheduler (the runners reconcile before they send; a V7 follow-up of 2026-11-02,
audit gap 59).

Stored records upgrade when the journal is decrypted and on every read (`v: 3`, idempotent, persisted at the next
write), as the V5 → V6 mapping did; the API's `operations.state` column is migrated in place (migration 3); history
lines are renamed the same way. The tracker's internal `OrderState` (`PROVIDER_EXECUTING` already among its names) is a
different type and stays. The Classic app has **its own operation adapter** on the same fifteen names (§7.7); nothing
is shared at runtime.

Code (Stage 15, as landed): `packages/protocol-types/src/operations.ts` (the fifteen, `OPERATION_STATES_V2` and
`STATE_CROSSWALK_V2` for the upgrades), `packages/sdk/src/wallet/operationRecord.ts` (`v: 3`; the failure states FAILED and
RECOVERY_REQUIRED; the pre-submission states end at PREPARING_PROOF, the submitted ones start at SUBMITTING),
`packages/sdk/src/operations/reducer.ts` (the table over the fifteen; a `progress` step moves the record to PREPARING_PROOF or
SUBMITTING — never back —; `quote-expired` after the funding lands in RECOVERY_REQUIRED, before it in READY_TO_REVIEW with the
expiry as its reason), `packages/sdk/src/operations/upgrade.ts` (the V6 → V7 step on top of the V5 → V6 one: `upgradeStateV7`,
`upgradeRecordV7`; a V5 record takes both), `packages/sdk/src/operations/adapters.ts` (the expired-quote rows become
RECOVERY_REQUIRED: a moved minimum, a price deviation, a campaign's reassessing / requoting / rerouting, an expired funded order),
`packages/sdk/src/operations/notify.ts`, `packages/sdk/src/operations/recovery.ts`, `packages/protocol/src/wallet/settlement.ts`,
`apps/api/src/db.ts` (migration 3: the rows renamed in place, an operation expired before its funding cancelled, the system
events' column following) and `apps/api/src/reconcile.ts`, the web's progress / activity / recovery / protect models and the
`op.state.*` words (en, ko), the quick pass's `data-state` selectors, `packages/sdk/test/spec-sync.test.ts` and
`packages/protocol-types/test/spec-sync.test.ts` pinned to this section (the states and the V6 → V7 table).

**As landed (the review round of 2026-11-02).** The wallet's own prompt is a field of AWAITING_AUTHORIZATION, not a state: a
spend's `submitting` step with `by: "wallet"` (the wallet's prompt, declinable) leaves the record there, and SUBMITTING is the
relayer path's instant; the V6 → V7 upgrade reads `refs.relayerUrl` for a record at its submitting step (SUBMITTING with a
relayer, AWAITING_AUTHORIZATION without) and drops drafts; a Protect's progress never moves its state. A spend sent without a
known transaction (its nullifier spent, no hash kept) waits as RECOVERY_REQUIRED with `outcome_unknown` rather than FAILED
(`packages/sdk/src/operations/stale.ts`); `wasSent` / `SENT_STATES` (`packages/sdk/src/wallet/operationRecord.ts`) say on the
screens what left the wallet. The API's migration 4: an operation that expired before its funding waits as RECOVERY_REQUIRED
until its refund time, then CANCELLED (`order_expired`) — a funding in the mempool at the deadline still lands —, and the rows
migration 3 had cancelled with a refund time still ahead come back (`apps/api/src/db.ts`, `reconcile.ts`; the schema pin).

**As landed (the second review round, 2026-11-03), the engines.** One funding of an order at a time in a tab: a second
caller (Fund now beside the runner's tick, or the scheduler's) is refused as a funding on its way, and the spend's own turn
reads the journal again before anything is proved (`beforeSpend`); an order whose funding is on its way is never abandoned
(the Advanced screen hides Abandon and disables Fund now, the runners read the attempt's fate first); a tick that threw
releases the hand-over hold and the next tick takes it again — a tick under the reconcile pause too; the legacy scheduled
funding stops on the one-confirmation runner's permanent refusals; a funding that landed into an escrow read short asks the
executor before waiting; a campaign whose relayer runs no swaps pauses for the user. On the service side the relayer's cap
answers a job it has and admits a funded escrow (a hand-over, a Return funds) whatever the cap; a job keeps the twelve order
fields and the five execution fields; a `lapsed` job reads REFUNDING past the funding; the commit and the executor check
the shapes; the API's execution hash follows the relayer's re-send; the engine's vault lookup is by the asset's lower case.

**As landed (the third review round, 2026-11-03), the engines and the guard.** A Mayan order's ETH → USDC leg (a router Mayan
names, bounded on chain by the forwarder's `minMiddleAmount`) is bounded at this wallet's own agreed Chainlink ETH price less
2 % (`MAYAN_MIDDLE_MAX_SHORTFALL_BPS`; the price read through the wallet's RPC quorum at signing, `agreedUsd`) and the call is
refused without a fresh agreed price; the engine applies the same bound to the quotes it ranks and at the ingress — before, any
positive floor passed, and a swap service could route the whole order through its own pool with the Mayan order holding one
USDC unit, the order's own minimum being conditional on a fill. The order inside LI.FI's Mayan facet is read (a Swift order's
trader must be the escrow, the receiver the fresh address, the asset the one asked, the minimum read — the route has a
minimum now); the minimum the user approved is never defaulted to zero (a record without it signs nothing); LI.FI's
bridge-only variant bridges exactly the escrow's amount; a THORChain stream's parts × interval fit a day of blocks. The scan
reads every found note's spent bit from every endpoint, agreed (`RpcDisagreement` otherwise — the first endpoint alone had
decided it, and its false "spent" hid a note for good), and proves the marks both ways: a spent mark waits for its proof
(`spentUnproven`, `spentAtBlock` in the journal's notes; proven once, never the history again) and is lifted when the finalized
chain at or past the block it was seen at does not have the spend, or the quorum no longer makes it. A result that arrives after
a lock — or after another phrase replaced the wallet in the same tab — writes nothing (the session's epoch; the right wallet's
scan records it). Every note new to the store past the proven pool waits for the scan whose proof covers its leaf, not only a
transfer received: a protect's opening is public calldata, so the quorum could replay this wallet's own note in the tail. The
proof's public inputs are the plan's: recomputed on the main thread from the spec it made (`expectedPublicInputs`), so a
prover — the crypto worker — that answered another recipient, amount, nullifier or payload hash sends nothing (defence in
depth; before, its answer was taken as the plan's).

## 7. Tornado Classic (doc §1, §4, §10 "Tornado Classic", §11, §13 "Classic") — *Stages 1–3, 5–11* (supersedes v2.0 §11.3 and the Classic rows of §7.11 and §23)

### 7.1 Product and acceptance (doc §4.2)
Tornado Classic is a separate compatibility experience, not the foundation the new protocol builds on. For an
existing user it MUST hold, per pool and per function, before that function is live:

| Doc §4.2 criterion | How it is met |
|---|---|
| existing notes recognized without conversion | the original note `tornado-<currency>-<amount>-<netId>-0x<124 hex>` parsed as the original did (§7.3); no conversion, no import into the wallet |
| all four ETH denominations | 0.1, 1, 10 and 100 ETH, the mainnet addresses of §7.2 |
| deposit and withdrawal in the original familiar flow | §7.9: the Deposit and Withdraw tabs, the denomination selector, the note modal, the withdrawal settings, the statistics |
| the UI can tell whether a note is spent | the verified Withdrawal history first (no disclosure), an explicit on-chain `isSpent` read on request and right before a withdrawal (§7.4) |
| historical deposit events reconstructible | the snapshot + delta sync whose root matches the pool's live root (§7.4) |
| proof preparation with compatible verified parameters | the original circuit and proving key, pinned by hash; a proof the deployed verifier accepts (§7.3) |
| the app reports whether an operation is supported right now | the availability model (§7.7), contract compatibility apart from router state, relayer availability and network state |
| no new or proprietary pool silently substituted | the pinned addresses, verified at start (§7.2); nothing else is ever called |
| the wallet's 1 % never applies; Classic fees disclosed separately | §7.5 |

### 7.2 The deployed contracts (doc §1, §4.3 B) — *Stage 5*
Chain id **1**. Verified on 2026-10-26 (public RPC; Sourcify API v2 for the sources):

| Contract | Address | Facts |
|---|---|---|
| 0.1 ETH pool | `0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc` | solc 0.5.11 (`TornadoCash_Eth_01`, optimizer 200), runtime code 6,615 B, `levels() = 20`, `denomination() = 0.1 ETH`, deployed block 9,116,966 |
| 1 ETH pool | `0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936` | solc 0.5.11 (`TornadoCash_eth`), 5,191 B, deployed block 9,117,609 |
| 10 ETH pool | `0x910cbd523d972eb0a6f4cae4618ad62622b39dbf` | the 1 ETH pool's bytecode, deployed block 9,117,720 |
| 100 ETH pool | `0xa160cdab225685da1d56aa342ad8841c3b53f291` | the 1 ETH pool's bytecode, deployed block 9,161,895 |
| the shared verifier | `0xce172ce1f20ec0b3728c9965470eaf994a03557a` | solc 0.5.17 (`Verifier`); its verification key equals the one the original proving key was built for |
| Tornado Router | `0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b` | `TornadoRouter`, solc 0.6.12 (exact match); `governance() = 0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce`; `instanceRegistry() = 0xb20c66c4de72433f3ce747b58b86830c459ca911` |
| the instance registry | `0xb20c66c4…ca911` | all four pools `ENABLED`; relayer protocol fee 0.30 % on the 1 / 10 / 100 pools, 0 on the 0.1 pool |
| the relayer registry | `0x58E8dCC13BE9780fC42E8723D8EaD4CF46943dF2` | registered relayers, their ENS names and stakes (§7.5) |

Every pool: `operator() = 0x0` (the deployment-era operator that could replace the verifier is renounced — the
pools are immutable), `ROOT_HISTORY_SIZE() = 100` (count-based root validity; the pinned tornado-core master's 30
describes a later source, not the live pools), `verifier()` the shared verifier. **The router is a role apart**: it is
governance-controlled and can disable an instance, which stops router deposits and withdrawals and never the pool
itself; the pool is the deposit / withdraw target, the router the proxy the original UI used, the registry the way
relayers are found — three facts the availability model reports separately (§7.7). The Classic app pins all of this
(`classic/src/config/deployment.json`: addresses, deployed blocks, runtime code hashes, the verifier, `levels`,
`ROOT_HISTORY_SIZE`, the registry) and **verifies it at start** against the chain: a mismatch marks the pool "not
verified" and nothing is sent. The sources are rebuilt from the Sourcify-verified files with the named compilers and
compared modulo the metadata hash and the linked Hasher library address (the deployment-era pools link a `Hasher`
library generated from circomlib's MiMCSponge). *Stage 5 as landed (2026-10-26, block 26,278,752):* every rebuild with
the pinned compiler reproduced the chain's code; the Hasher is `0x83584f83f26af4edda9cbe8c730bc87c364b28fe` at both
link sites of every pool; the verifier was deployed at block 10,050,743, after the pools that point at it (their
verifier was updated before the operator was renounced); the two registries are `AdminUpgradeableProxy`s administered
by governance (implementations `0x2573bac39ebe2901b4389cd468f2872cf7767faf` and
`0x84b0c75c1f6211450fec7289c32d717adadd702a`) — upgradeable, so reported apart from the immutable pools; the report is
`classic/docs/deployment-verification-2026-10-26.md`, the records `classic/contracts/verified/`.

### 7.3 The note and the cryptography (doc §4.3 C) — *Stage 6*
Note: `tornado-<currency>-<amount>-<netId>-0x<nullifier 31 B LE><secret 31 B LE>` (124 hex); the currency compared
case-insensitively (the original CLI accepts `\w+`). `commitment = Pedersen(nullifier ‖ secret).x`,
`nullifierHash = Pedersen(nullifier).x` — circomlib's Pedersen over Baby Jubjub (bits LSB-first per byte), the
generators from BLAKE-256 of `PedersenGenerator_<i>_<j>`. Tree: height 20, zero leaf `keccak256("tornado") mod p` =
`21663839004416932945382355908790599225266501822907911457504978515578255421292`, node hash MiMCSponge (220 rounds, key 0, the
constants seeded `mimcsponge`), the `fixed-merkle-tree` semantics. Proof: Groth16 over the ORIGINAL artifacts only —
`tornado.json` (the circom-1 circuit, 28,275 constraints, the v2.1 circuit with the four hidden squares; LF bytes
sha256 `3ddd61dbff09caeec82d8edde95c674a3c34f9e66b1fe9f2c8783e72fe536f98`) and `tornadoProvingKey.bin` (14,522,256 B,
sha256 `8e2d2f22beafb5a9666daebca57b13f8029c3656c65fcfbcc86e2418fa16a3af`), copied from the pinned tornado-cli clone
(`../reference/tornado-cli/build/circuits/`, never the CRLF working copy) and pinned in `classic/public/artifacts.json`.
Public inputs in order: `root, nullifierHash, recipient, relayer, fee, refund`; private: `nullifier, secret,
pathElements[20], pathIndices[20]`; the proof packed as websnark's eight words (`a0 a1 b01 b00 b11 b10 c0 c1`).

**The prover is the original stack, vendored verbatim and GPL-3.0**: websnark at the phase2 commit `4c0af6a8` (its
FFT's non-residue is fixed to 7; the clone's master `2041cfa5` computes another and proves invalidly), snarkjs 0.1.20's
witness calculator (`circuit.js`, `calculateWitness.js`, `bigint.js`, `stringifybigint.js`; the fork commit `869181cf`
is byte-identical in these files), circomlib `3b492f9` (`babyjub.js`, `pedersenHash.js`, `mimcsponge.js`) and the
pure-JS BLAKE-256; `big-integer` and `fixed-merkle-tree@0.7.3` from the registry; `snarkjs@0.7.6` for local
verification (the verification key transcoded from the deployed `Verifier.sol`). Two changes to the vendored code,
each recorded in `classic/vendor/VENDORED.md` with the originals' hashes: **the circuit's templates are precompiled at
build time** (`classic/scripts/compile-circuit.mjs` turns the JSON's 39 templates and 1 function into a static module
and strips the constraints into a smaller `witness.json`, both hash-pinned) so that no `eval` runs and the CSP stays
`script-src 'self' 'wasm-unsafe-eval'`; and the Node-only requires are shimmed. **Everything runs in one dedicated
prover worker** (snarkjs 0.1 patches `BigInt.prototype`; the main thread never loads it); websnark's Blob sub-workers
spawn from it (`worker-src 'self' blob:`) — as landed there is no main-thread fallback: in a browser whose workers cannot spawn
workers the prover's build fails with the worker's error, and nothing is proved (the fourth review round, 2026-11-03); the
worker uses `min(cores, 4)` sub-workers and 1,000 WebAssembly pages each on a phone. A proof is **verified locally**
before it leaves the device. Vectors: `classic/vectors/notes.json` (note → commitment, nullifierHash),
`classic/vectors/proof.json` (a synthetic tree and a proof) verified offline and **accepted by the deployed verifier**
through `eth_call` (`--live`); the vendored files re-hashed by a test.

**As landed (Stage 6, 2026-10-26).** `classic/vendor/` holds the originals byte for byte (`classic/vendor/VENDORED.md`:
sources and sha256s — websnark `4c0af6a8` from the reference clone, snarkjs 0.1.20 and blake-hash 2.0.0 from the
registry tarballs, circomlib `3b492f9`), and `classic/scripts/vendor.mjs` converts them into `classic/src/prover/legacy/`
by listed literal replacements — one more than planned: snarkjs 0.1's witness calculator ran a ready component nested
inside the setter that completed its inputs, a chain of about 8,800 components for one withdrawal (220 MiMC rounds × 2
× 20 levels), deeper than a Web Worker's stack in Chrome (Node's sufficed); the converted calculator queues ready
components and runs them when a signal not yet set is read (last ready first, so a parent runs before a child whose
inputs alias its own), and a Node test holds its witness, signal for signal, to the pristine original's. The
precompiled circuit is `classic/src/prover/generated/templates.js` (39 templates, one function) with the served
`witness.json` (8,086,414 B); the pins live in `classic/src/prover/artifacts.json`, imported by the worker so that a
served pin file can never vouch for a served artifact, with `classic/public/artifacts.json` as the served copy the gates
hold equal. The derivations are `classic/src/crypto/hashes.ts` and `classic/src/crypto/tree.ts` (a sparse 20-level
tree with a layer-by-layer bulk build); the prover is `classic/src/prover/` (`engine.ts`, `worker.ts`, `client.ts`,
`protocol.ts`, `input.ts`, `offline.ts`, `verify.ts`): everything cryptographic runs in the dedicated worker —
`classic/src/app/prover.ts` loads it on first use and warms it when a live withdrawal becomes possible, and the worker
also derives a note's commitment and nullifier hash on request, so the main thread never loads the legacy modules; the
artifacts are fetched by `classic/src/net/artifacts.ts` (streamed, capped at the pinned size, sha256-checked) and kept in
Cache Storage keyed by URL and pin (`classic/src/storage/artifactCache.ts`); a proof is verified offline with snarkjs
0.7.6 against the key of the deployed `Verifier.sol` (every G2 limb pair reordered — the one order of four that
verifies) before it is returned, and `verify.ts` encodes the contract's own `verifyProof(bytes,uint256[6])` call (the
live test; wallet mode later). `fixed-merkle-tree` is not used: the tree is our own hundred lines, held to the pools'
zeros and to a real root. Measured — Node, 2 workers: witness ≈ 0.2 s, proof ≈ 11 s; Chrome on this workstation, 4
sub-workers with 2,000 pages each: witness 118 ms, proof 4.9 s, offline verification 187 ms, the 21.6 MB of artifacts
from Cache Storage in 31 ms on the second visit (`classic/tests/prover/run.mjs`, verify-all `--browser`). Vectors:
`classic/vectors/notes.json` (cross-checked with circomlibjs 0.1.2), `classic/vectors/zeros.json` (the pools' twenty
zeros, read on chain), `classic/vectors/proof.json` (accepted by the deployed verifier through `eth_call` on
2026-10-26; `classic/test/live/verifier.live.test.ts` holds it), `classic/vectors/roots.json` (the classic-ui cache's
27,544 leaves of the 100 ETH pool hash to the pool's own `getLastRoot()` at block 14,954,101 on two archive
endpoints). The phone measurements and the worker-count and page defaults for phones are Stage 7's.

### 7.4 History: events, the tree, spent notes (doc §4.3 C) — *Stage 7*
Per pool the Deposit events (`commitment, leafIndex, timestamp`) from its deployed block and the Withdrawal events
(`to, nullifierHash, relayer, fee`). A **snapshot** (`classic/scripts/snapshot.mjs`: the events, the tree's layers and
a manifest with their hashes, the block and the root; seeded from the original UI's caches to June 2022 and the CLI's
to block 14,145,999; a deploy-time artifact under `/classic/data/`) is loaded first; the client syncs the **delta** from
the snapshot's block to `head − 12` in windows with block-hash checkpoints and a rollback on a reorg; then the whole
history is **proved correct by one check: the recomputed root equals the pool's `getLastRoot()` (or `isKnownRoot`) and
the leaf count equals `nextIndex()`**. A mismatch rebuilds from the events in the worker; a history that cannot be
verified blocks withdrawals ("history not verified"). Root validity is count-based (100 roots): a proof whose root
has aged out of the window is rebuilt against the current root before submission. **Spent:** the verified Withdrawal
history answers first (nothing is disclosed); "Check on chain" and the moment before a withdrawal read `isSpent` on
chain, and the screen says that this read discloses the note's nullifier hash to the RPC endpoint. The history is
public data; it is cached in the Classic app's own IndexedDB `tornado-classic` (§7.8).

**As landed (the fifth review round, 2026-11-03).** A tree loaded from its layers is copied, not hashed: the worker's `tree:path`
folds every path back to the root and refuses one that does not (`TREE_INCONSISTENT`), and the history then rebuilds the tree
from the deposits the chain agreed with, once, and persists it — a served or stored copy with wrong inner nodes under the
right root word had passed every check and failed every proof with the note blamed. A window the chain keeps moving under
is redone three times (`MAX_MOVED_RETRIES`), then the sync fails naming the block.

**As landed (Stage 7, 2026-10-26).** `classic/scripts/snapshot.mjs` writes a pool's snapshot — `deposits.json`,
`withdrawals.json`, `tree.json` (the layers) and `manifest.json` (sha256 and size per file, the block and its hash,
the leaf count, the root, how it was held to the chain) — under `classic/public/data/<pool>/` (git-ignored; served at
`/classic/data/`), seeded from the original UI's caches when the classic-ui clone sits beside the repository
(`classic/scripts/zip.mjs` reads them) and synced through `eth_getLogs`; it refuses to write unless the leaf count is
`nextIndex()` and the root a root the pool knows, and with `--archive` unless `getLastRoot()` at the snapshot's own
block equals the root. The modules are `classic/src/history/`: `events.ts` (the two events decoded), `snapshot.ts`
(the format, held to its manifest) and `snapshotTree.ts` (built and rehashed), `sync.ts` (the delta in windows the endpoint allows — halved on a range
refusal down to 50 blocks, grown again after two successes —, 12 confirmations, a checkpoint per window, `findReorg`
and the rollback), `verify.ts` (the one check against the chain, and the frontier read) and `frontier.ts` (the frontier walk:
`filledSubtrees` plus the last leaf hashed as the contract's `_insert` does), `spent.ts` (a note's facts and spent state from the history; the disclosed
`isSpent` read apart) — one implementation for the app, the tests and the generator (Node runs them by type stripping,
so this chain carries explicit `.ts` extensions and no parameter properties); `classic/src/net/rpc.ts` is the app's
JSON-RPC transport and `classic/src/storage/historyDb.ts` the IndexedDB `tornado-classic` (one store, four records per
pool; memory where IndexedDB is absent). Measured: of the public endpoints, publicnode refuses historical logs, drpc
allows 10,000 blocks and 1rpc 50, while `gateway.tenderly.co/public/mainnet` and `rpc.mevblocker.io` answer
500,000-block windows in seconds (`PUBLIC_LOG_RPC_URLS` in `classic/scripts/deployment.mjs`; the app's operator sets
`VITE_CLASSIC_RPC_URLS` accordingly, and the sync sizes itself to whatever answers); the 100 ETH pool's delta from the
June-2022 cache to head — 22,084 deposits and 21,188 withdrawals — synced in 23 windows and 36 s, the 49,628-leaf tree
hashed in 55 s in Node, and its root equals the pool's own `getLastRoot()` at that block (archive) and is known on
chain (`npm run snapshot -- --pool eth-100`; 33 MB of files). The committed fixture
`classic/test/fixtures/history/first-1024/eth-100/` is the pool's first 1,024 deposits, its root equal to
`getLastRoot()` at block 10,734,277 (archive). The live suite (`classic/test/live/history.live.test.ts`) holds every
pool's frontier plus its last deposit to its `getLastRoot()` and syncs the local snapshot's delta to head − 12 into a
root the pool knows. The screens still read the mock; Stage 9 wires the history (the worker builds and appends the
tree; a 50,000-leaf build costs about a minute of hashing, which the persisted layers avoid repeating).

### 7.5 Relayers, fees, wallet mode (doc §4.5, §6 rule 8) — *Stage 8*
The relayer protocol of the original: `GET /status` (`rewardAccount, instances, netId, ethPrices, tornadoServiceFee`
in percent, `version`, `health.status` as the STRING `'true'`, `currentQueue`), `POST /v1/tornadoWithdraw {proof,
contract, args[6]}`, `GET /v1/jobs/:id` (`QUEUED, ACCEPTED, SENT, MINED, RESUBMITTED, CONFIRMED, FAILED`). Relayers
come from a **curated list** (`classic/relayers.json`: ENS name, URL, expected `rewardAccount`) verified at build time
against the relayer registry and the stake rule, and at runtime against `/status` (netId 1; the pool in `instances`;
`rewardAccount` as registered; version 4.x ≥ .4 or 5.0.0; `currentQueue ≤ 5`; `tornadoServiceFee ≤ 20`); a user-entered
relayer URL is a follow-up (it cannot pass a strict content-security policy). **Fees, Classic's own**: `Relayer fee =
tornadoServiceFee % × denomination`, `Network fee = gas price × 550,000` at the LIVE gas price (never a constant),
`Total fee`, `You receive`, each shown before the proof is made; the relayer's minimum (`gas price × 390,000 + amount ×
fee %`) is checked so a job is never refused for a fee below it; the service fee is capped at 20 %. **No 1 % privacy
fee exists in Classic**; should the operator ever add a service charge it is a separate line named "service charge",
never implied to be the contract's. **Wallet mode** (the original's): the connected wallet calls `withdraw` itself
with `relayer = 0x0` (as landed: the zero address, not the recipient — the pool pays no fee either way), `fee = 0`, after the
original warning that the gas-paying address must not be linkable to
the user. Every request leaves through the Classic app's own transport with timeouts and a bounded poll; before the
first withdrawal the screen says that the relayer sees the IP address.

**As landed (the fifth review round, 2026-11-03).** With two or more RPC endpoints configured, a wallet-mode send asks the second
(`secondOpinion`) about the proof's root and the note's spent bit and refuses when it disagrees — one lying endpoint had the
user's own `withdraw` revert and publish the nullifier hash beside the recipient; with one endpoint, that endpoint is the
user's trust (audit gap 76). The prover worker is closed once a withdrawal's record is terminal, and websnark's sub-workers
zero their scratch before resetting their allocation pointer: the witness carries the note's nullifier and secret.

**As landed (Stage 8, 2026-10-26).** The relayer protocol lives in `classic/src/relayer/`: `schema.ts` parses GET
`/v1/status`, GET `/v1/jobs/:id` and the POST `/v1/tornadoWithdraw` body with zod — `health.status` is read as the
string "true" or "false" the relayer software sends (a boolean is read too; the former in-app schema wanted a boolean
and would have refused every real relayer), the job states are the seven including RESUBMITTED, and the request is
strict: the proof, the pool, the six arguments as bytes32 strings for the root, the nullifier hash, the fee and the
refund and addresses for the recipient and the relayer — exactly what tornado-relayer's validator accepts. `rules.ts`
says whether a relayer may be offered for a pool (R-6 to R-8): healthy, on mainnet, the pool at its pinned address,
the reward account the registry registered, a fee under the cap the user sees (20 % at most), a queue of at most five,
a version the protocol trusts (4.1.4 and up, any 5.x; a 4.x beta from 11). `client.ts` over the transport
`classic/src/net/relayer.ts`: the status, the withdrawal handed over or refused with the relayer's own words, the job
followed every 3 s with a transient error forgiven five times and a 15-minute deadline, as the original did.
`registry.ts` reads the registry as the original UI's discovery did — every RelayerRegistered event, the newest per ENS
name, the name's owner and the `url` text record of `mainnet-tornado.<name>` through the ENS registry and resolver,
the registration and the stake — and applies its rules (the owner is the registered address, a host without a scheme,
registered, at least 40 TORN; the registry asks 5,000 TORN of a new relayer today, and burned-down stakes stay valid).
`classic/scripts/relayers.mjs` runs that over the chain and asks every qualified host for its status:
`classic/relayers.json` is the curated list — on 2026-10-26, of 127 registrations and 123 names, 48 qualified by the
registry's rules and 23 answered within the protocol's (fees 0.35–0.43 %, tornado-relayer 4.1.6 and 5.0.0, stakes 570
to 25,969 TORN; three relayers pay to an account other than the one registered and are not listed) — the relayers the
app may ask, whose hosts the content security policy allows beside the environment's (`classic/scripts/csp.mjs`,
`classic/src/relayer/curated.ts`); the status is read again from each one when a withdrawal is prepared. A relayer
the user types in is not offered (a strict policy cannot allow it; the owner's follow-up). The wallet side is
`classic/src/wallet/`: `calldata.ts` builds `router.deposit(instance, commitment, "")` (no encrypted note: the
original's backup-on-chain is not copied), `pool.deposit`, `pool.withdraw` and `router.withdraw` by hand and the six
relayer arguments, held byte for byte to a real deposit through the router and a real wallet-mode withdrawal of the
100 ETH pool; `injected.ts` sees the wallets a page can see (EIP-6963 announcements, the legacy provider last; the
only reader of `window.ethereum`); `connection.ts` is one account on mainnet or "wrong network", the transaction
handed to the wallet to sign and send, the receipt read from the app's own endpoints. Found while measuring: a burst
of parallel TLS connections from Node stalls on the development workstation (20 of 24 status requests aborted at six
in flight; all answer in about two seconds one at a time) — the discovery and the live survey ask two or one at a
time. Classic's fee lines (`classic/src/model/fees.ts`, Stage 3) already price a withdrawal at the live gas price over
550,000 gas plus the relayer's percent, with the relayer's own minimum (390,000 gas) as the floor an offer may not fall
below. The screens still read the mock; Stage 9 wires the relayers, the fees and the wallet into the flows.

### 7.6 Deposits (doc §4.4) — *Stage 9*
The connected wallet (chain 1 only) deposits through the Router — `deposit(instance, commitment, 0x)` with `value =
denomination` — while the registry lists the pool `ENABLED`; a direct `pool.deposit(commitment)` is offered only when
the router has disabled the instance, behind a warning that a direct deposit is a visible pattern. The note is
generated from `crypto.getRandomValues` (62 bytes), shown once after the original's backup words, offered as a **file
download first** and a copy second, and the deposit button enables only after "I backed up the note".

### 7.7 Availability, switches, the Classic operation adapter (doc §4.2, §4.5, §11, §13) — *Stage 9*
Per pool the app computes and shows, separately: `Pool contract verified` (§7.2) · `Router: enabled | disabled |
unknown` · `Relayers: n online` · `History: synced to block N, root verified` · `Prover: ready` (artifacts hashed) ·
`Wallet: connected on Ethereum`. A deposit needs the contract, the RPC, the router (or the fallback) and the wallet; a
withdrawal needs the contract, the history, the prover and a relayer or the wallet. Above these sits
**`CLASSIC_LIVE`**, a per-pool, per-function build switch, off by default: while off, every screen works on real data
and every transaction button is replaced by the words `Not connected — interface prototype; live contract,
note-generation and transaction functionality is subject to verification` (doc §4.4), so that no demonstration is
ever presented as operational (doc §13). A function is switched on only when its release-gate row is green and
`classic/docs/legal-review.md` records the owner's legal review (the owner's decision 9). The original's compliance
behaviour — the sanctions-oracle check at connect (`0x40C57923924B5c5c5455c48D93317139ADDaC8fb`) and the country
geofence — is implemented behind `CLASSIC_COMPLIANCE_ORACLE` and `CLASSIC_GEOFENCE`, both off until the review decides.
**The Classic operation adapter** uses the fifteen names of §6 as its own type: a deposit `DRAFT → READY_TO_REVIEW →
AWAITING_AUTHORIZATION → SUBMITTING → SOURCE_CONFIRMING → COMPLETED | FAILED`; a withdrawal `DRAFT → READY_TO_REVIEW →
PREPARING_PROOF → AWAITING_AUTHORIZATION → SUBMITTING (QUEUED, ACCEPTED, SENT) → SOURCE_CONFIRMING (MINED) → COMPLETED
(CONFIRMED) | FAILED (before any transaction) | RECOVERY_REQUIRED (RESUBMITTED, an unknown job)`; a reload shows the
job's state from the relayer, never re-submits.

**As landed (Stage 9, 2026-10-26).** The screens read the real services through the same interface the Stage 3 mock
implemented (`classic/src/app/services/source.ts`): each pool's history (`history.ts`: the device's copy, else the
snapshot the host serves at `/classic/data/<pool>/` held to its manifest, then the chain's delta in windows the
endpoint allows, then the one check — the recomputed root a root the pool knows and the leaf count its `nextIndex` —
and the whole kept in the app's IndexedDB; a checkpoint that fell rolls the history back to the newest that stands; a
served snapshot whose own block the chain does not confirm is refused), the relayer directory (`relayers.ts`: every
curated relayer asked for its status, two at a time, and held to §7.5's rules for every pool), the wallet session
(`wallet.ts`), the live gas price (`gas.ts`), the contract and router facts (`contract.ts`: the pool's code hashed as
the verification did, its verifier, levels and denomination; the registry's instance state), the operation adapter
(`operations.ts`: the fifteen state names as this app's own type, a deposit's and a withdrawal's machines, the records
kept with ids, states, a transaction hash and the relayer's job — never a note, never a recipient) and the compliance
switches' pieces (`compliance.ts`: Chainalysis' `isSanctioned` at connect behind `CLASSIC_COMPLIANCE_ORACLE`, the
host's HTTP 451 behind `CLASSIC_GEOFENCE`, both off). The two flows are `flows.ts`: a deposit sends the note's
commitment through the router from the connected wallet — straight to the pool only when the router disabled the
instance, behind the warning — and reads the receipt from the app's endpoints; a withdrawal takes the verified
history's path from the worker's tree, proves in the worker (a proof the worker could not verify goes no further),
checks the root is still one the pool knows (proving again once after a resync if not), asks the user to confirm, then
hands the relayer the request exactly as its validator wants it and follows the job to CONFIRMED, FAILED or
RECOVERY_REQUIRED (RESUBMITTED, a job that could not be followed) — or, in wallet mode, sends the pool's own `withdraw`
with no relayer and no fee and awaits the receipt. Both refuse to start unless the pool function is switched live:
the screens never offer them otherwise (`classic/src/app/App.tsx`), and the flow is the second lock. The prover
worker holds each pool's tree (loaded from persisted layers, appended as the history syncs, asked for a path).
`classic/src/model/availability.ts` turns the facts into the Settings card's rows — no RPC configured, verified against
the pins now, differs from the pins, enabled or disabled by governance, n relayers online, synced to block N with the
root verified, the prover ready, the wallet connected or on another network — and says what they allow. The withdraw
tab offers "Check on chain" with its disclosure ("this read tells the RPC endpoint the note's nullifier hash"), and the
header's chip connects a wallet (`classic/src/views/Connect.tsx`: EIP-6963 announcements, the legacy provider last;
the wrong network named). Found while wiring: a React effect without dependencies that set state from the services
looped forever — every redraw now follows the services' change counter; and the first route had come to carry the
vendored arithmetic through the flow's circuit input and the history's checks, so the history modules were split —
`verify.ts` and `snapshot.ts` read and check without hashing, `frontier.ts` and `snapshotTree.ts` hash (the worker's,
the generator's and the tests'), the field constants live in `classic/src/crypto/field.ts`, the flow builds the circuit
input from the worker's derivation, the history holds the worker's root to the manifest — and the budget gate now
refuses the MiMC and Pedersen modules in the first route (111.8 KB gzipped after the split). The screens remain honest
with the switch off: 152 Classic tests hold the flows, the services and the wired app; the local stack and the mainnet
fork are Stage 10.

### 7.8 The application (doc §4.5, §9) — *Stages 2, 11*
`classic/` is **its own application**: its own `package.json` and `package-lock.json` (the second lockfile the
repository allows beside the tool directories; checked by `scripts/check-lockfile.mjs --lockfile`), its own Vite build
(`base: '/classic/'`), its own content-security policy (`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:;
connect-src` the configured RPC and relayer hosts only), its own budget, pins, dependency audit, dependency review,
word policy, tests, visual harness and release gate, its own LICENSE (**GPL-3.0**, the vendored provers' licence; our
code elsewhere is MIT — the owner's decision 10) and third-party notices. It shares **nothing at runtime** with
`apps/web`: the design tokens arrive as a generated stylesheet copied from `packages/ui/src/tokens/tokens.css` with a
hash check (one visual identity, doc §1), the note parser is a twin of `packages/protocol/src/classic/note.ts` pinned
to the same vectors. Served under `/classic/` on the same origin by its own server location (the stricter hosting
option, a `classic.` subdomain, is documented). **It needs no Privacy Wallet**: no seed, no unlock, no journal; its
IndexedDB `tornado-classic` holds the public history caches, the relayer and RPC preferences and the job records (job
id, relayer URL, status, transaction hash) — **never a note, a nullifier, a secret, a commitment list or a deposit
record**; `localStorage` stays empty; nothing is logged; no analytics, no error reporter, no support channel collects
anything (doc §4.3 E). The old in-app module (`apps/web/src/features/classic-privacy/`, the journal's `classic` field
and `packages/sdk/src/wallet/classicRecord.ts`) is removed in Stage 11 and rule 8 of `scripts/check-boundaries.mjs`
becomes rule 9: nothing under `apps/` or `packages/` imports `classic/` and nothing under `classic/` imports them.

**As landed (the fourth review round, 2026-11-03).** The IndexedDB holds the withdrawal records only (relayer, job id,
status, transaction hash), until the user clears them from History; a deposit's record lives in the page's memory and goes
with the tab — a deposit row beside a withdrawal row on one device was the link the pool exists to hide. The wallet's More
entry can point the Classic application at its own origin (`VITE_CLASSIC_URL`): the stricter hosting, since `/classic/` on
the wallet's origin shares the browser's storage partition and Web Locks with it (audit gap 68).

**As landed (Stage 11, 2026-10-27).** The V6 module is gone: `apps/web/src/features/classic-privacy/`, its two test files,
its four fixtures and their sixteen baselines, its 62 words in each catalog, the journal's `classic` field and
`packages/sdk/src/wallet/classicRecord.ts` (a journal written with the field still parses; the field is carried, never
read). Its old paths (`/more/classic/*`) lead to the Classic app by a full navigation (`MoreRoutes.tsx` `ToClassicRoute`).
Rule 8 of `scripts/check-boundaries.mjs` is retired with it — the number stays so rule 9 keeps its name. The gate scans
the Classic build with the bundle scanner (`scripts/scan-bundle.mjs classic/dist`: no tracker, no source map, no test
seed) beside its own checks. The two Classic operation kinds of the frozen vocabulary (`classic-deposit`,
`classic-withdraw`) stay reserved: nothing writes them now, and §6's rename pass (Stage 15) decides their fate with the
rest. The host recipe (`docs/deployment.md`) gains the `/classic/` location with the application's own policy and the
cache rules for its hashed assets, artifacts and snapshots, and names the `classic.` subdomain as the stricter option.

### 7.9 User interface parity (doc §4.1, §4.4, §10) — *Stages 1, 3*
The reference is the original's **built output** (`tornadocash/ui-minified`, cloned read-only beside the repository
and served statically; the Nuxt source build on Node 14 is optional), screenshotted at 390 × 844 and 1440 × 900 for
every state (`classic/docs/reference/`). The Classic app keeps the original's structure: one page with the **Deposit |
Withdraw** tabs (also addressable as `/classic/deposit` and `/classic/withdraw`), the token and denomination selector
(ETH; 0.1 · 1 · 10 · 100), the deposit note modal ("Your private note", "Please back up your note. You will need it later
to withdraw your deposit.", "I backed up the note", "Send Deposit"), the withdraw flow (Note → the deposit found with
"Time passed" and "Subsequent deposits" and the original's warnings at fewer than 5 deposits or less than 24 h →
Recipient Address → Withdrawal settings: Relayer | Wallet → Relayer fee, Network fee, Total fee, Tokens to receive →
"Generating proof" → Withdrawal Confirmation), the Statistics panel ("Anonymity set", "Latest deposits"), the job and
transaction history; mobile-first, the desktop in two columns as the original. **Words**: the historical Deposit /
Withdraw / Note terms and the original's statistics labels, under the Classic app's own word policy
(`classic/scripts/words.mjs`): the promise words of v2.0 §1 stay banned (mixer, untraceable, undetectable, invisible,
impossible to trace, a 100 % claim, "anonymous" as a promise), the statistics labels are allowed (the owner's decision
8). The Privacy Wallet's Simple vocabulary gate does not apply inside `classic/`. English and Korean. The parity table
(`classic/docs/parity.md`) names every original element, state and string and where the Classic app shows it.

### 7.10 The Classic release gate (doc §4.3 E, §13) — *Stage 11*
Per pool and per function a row in `classic/docs/release-gate.md`: contract verified (§7.2, live) · history verified
(§7.4, live root match) · prover verified (§7.3: the offline vector, the deployed verifier's acceptance, the devnet
withdrawal with the real bytecode, the mainnet-fork withdrawal through the router) · relayer verified (§7.5, the
curated list's live survey) · leakage gate (no note in any request, console line, storage write or URL during
deposit, recovery and withdrawal) · budget, bundle scan, pins, CSP, audit and dependency review green · the legal
review recorded (`classic/docs/legal-review.md`) → `CLASSIC_LIVE[pool][function]` may be switched on. The gate runs in
`scripts/verify-all.mjs` (the Classic steps; `--live` adds the chain-reading tests; `--browser` the Classic harness) and
in CI (the `classic` job, offline).

**As landed (Stage 11, 2026-10-27).** `classic/docs/release-gate.md` holds the rungs with their evidence and the eight rows
(four pools × deposit / withdraw): contract, history, prover, relayer, leakage and build green from Stages 5–10; two rungs
open — the mainnet-fork run of the prover (the suite exists and ran in its devnet mode; a fork node cannot start on the
development workstation) and the legal review — so every `CLASSIC_LIVE` entry stays off. `classic/docs/legal-review.md` is
the empty record the gate reads (what the review decides and where each answer takes effect: the live map, the
compliance switches, the relayers, the words). `classic/docs/security-review.md` replaces `docs/classic-privacy-review.md`
(the V6 module's review): the boundary (rule 9), the note's handling with its evidence, the research's findings against
the application (TC-10 closed — the root checked after the proof and before the submission, re-proved once when aged;
TC-01's storage side closed, the host's integrity the stated residual), the relayer checks R-1 to R-10, the earlier
review's C-1 to C-5 closed, what awaits the external review (the vendored conversion, the artifacts' provenance, the
registries' upgradeability, the fork run, the licence boundary). `classic/docs/threat-model.md` names what each party can
and cannot do: the chain, the RPC endpoints, the snapshot and artifact hosts, the chosen relayer, governance, the browser
wallet, the served code, another script in the page, the device, the Privacy Wallet, the owner.

Classic never calls `PrivacyCore` or a vault; the Privacy Wallet never calls a pool or the router; no Classic note is
imported, converted, stored or transferred into the Privacy Wallet; the two apps share no storage, no session, no
secret and no runtime code; no execution crosses the protocols; the wallet's 1 % is never applied to Classic; and no
Classic pool is ever replaced by another contract.

**As landed (the review round of 2026-11-02).** A pool's history takes a delta only when the pool's own `nextIndex` at the
delta's block agrees with the leaves it would make (`classic/src/app/services/history.ts`): an endpoint that caps `eth_getLogs`
and answers short with no error halves the window and is asked again (`DELTA_ATTEMPTS`), then fails the sync with both counts
— nothing persisted at an advanced block; a chain that counts fewer than the history holds fails at once ("not the chain's").
The one check reads the pool at the history's own block, not `latest` (a deposit of the last twelve blocks had made the count
disagree with a history right up to its block). A relayed withdrawal's offered fee is checked against the relayer's minimum
(390,000 gas plus its share) at the live gas price before anything is proved, and refused with both numbers
(`classic/src/app/services/flows.ts`; `classic/test/{services,flows}.test.ts`).

**As landed (the second review round, 2026-11-03).** A mixed-case recipient must carry its EIP-55 checksum (the original's
web3-utils rule); the deposit goes to the pool the note was made for, whatever the selector says behind the modal; a relayer
whose answer did not arrive leaves the record RECOVERY_REQUIRED with the words to check on chain first (a refusal stays
FAILED); one withdrawal flow at a time; the gas price is read again every minute and after a flow's message; the deposit and
withdraw buttons follow the availability facts and the flows check them (the contract verified, an endpoint, the wallet on
mainnet); the relayers are asked for their status when the Withdraw tab or the relayer settings open — never at page load —
and the chosen one again right before proving; a relayed job whose page is gone is asked about again when the history is
read (never re-submitted); a prover worker that crashed has its trees loaded again from the device's copy; a phone's websnark
sub-workers get 1,000 pages each; the pool's `isSpent` is read before proving and again right before anything is sent.

## 8. Stack and layout (doc §9) — *Stage 0* (the owner's decisions 6 and 7 of §22)

The lean stack stays (v2.0 §4, §8, §23): React + TypeScript + Vite, Tailwind for the design system's utilities, Radix
primitives, CSS motion, React Router, viem with the wallet engine's own EIP-6963 + WalletConnect connection (no wagmi),
the hooks over the engines' stores (no TanStack Query), zod (no React Hook Form), WebCrypto + the encrypted IndexedDB
journal, Web Workers + the pinned prover, Express 5 + `node:sqlite`, Foundry, Vitest, Playwright. The document's
proposed names map onto the existing workspaces; nothing is renamed:

| Doc §9 | Here |
|---|---|
| `apps/web`, `apps/api`, `apps/relayer` | the same |
| apps/classic | `classic/` (a top-level app with its own lockfile — the document's isolation, the repository's lockfile rule) |
| apps/indexer | the snapshot generator `classic/scripts/snapshot.mjs` (a script, not a service: public data, no query endpoint — a server that answered "is this nullifier spent" would learn the note) |
| packages/design-system | `packages/ui` |
| packages/wallet-sdk, packages/privacy-sdk | `packages/sdk`, `packages/privacy-engine`, `packages/wallet-engine` |
| `packages/swap-engine`, packages/provider-adapters | `packages/swap-engine` (the adapters inside) |
| packages/fee-engine | `packages/protocol/src/wallet/fees.ts` + the screens' fee lines |
| packages/operation-engine | `packages/sdk/src/operations/` + `packages/protocol-types` |
| `packages/protocol-types`, packages/chain-config | `packages/protocol-types`, `packages/config` |
| `crypto/wasm`, `crypto/test-vectors` | `privacy-core/`, `circuits/vectors/`, `classic/vectors/` |
| `tests/{mobile, classic-compatibility, swaps, privacy, recovery, security}` | `tests/high-value/` (mobile, privacy, recovery, swaps), `tests/visual/`, `classic/test/` (compatibility), the leakage suites (security) |

## 9. The mobile-web gate (doc §13 "Mobile web") — *Stage 16*

Small screens, refresh, background tab and wallet handoff are a gate of their own. *V7*: a `pagehide` while a hold is
active (a signature prompt, a proof, a submission, a hand-over) defers the lock to the safe point instead of locking
at once, and `pageshow` resumes; a Protect stops prompting the external wallet once the session is locked; the last
connector is reconnected after a reload; WalletConnect declares `redirect` and icons and its hosts are in the policy; a
`beforeunload` warning while proving or submitting; a catch-up kick when the tab becomes visible; `navigator.storage.
persist()` is asked for; a second Protect or Send cannot start while one of the kind is unresolved. A real-device
checklist (`docs/mobile-web-gate.md`: iOS Safari, Android Chrome, the wallets' in-app browsers) is the owner's to run.

Code (Stage 16, as landed): `packages/sdk/src/session/autoLock.ts` (`pageHidden` in the verdict — due at once without a
hold, deferred by a live one like every cause, at the safe point past the cap —, `pageHide` / `pageShow`),
`apps/web/src/platform/autoLock.ts` (the `pageshow` listener), `packages/sdk/src/privateTx.ts` (`assertStillUnlocked`
before every prompt of a Protect: locked, the error reads `locked_mid_flow` — its own words since the review round of 2026-11-02;
`interrupted` is the page's closing — and nothing more is asked),
`packages/wallet-engine/src/walletConnect.ts` (`metadata.icons` = this origin's `/icon.svg`, `metadata.redirect.universal` =
this origin), `packages/wallet-engine/src/connection.ts` (`reconnect` takes a WalletConnect session its provider restored,
by `eth_accounts`, never a pairing — and only when WalletConnect's own store holds a session, `hasWalletConnectSession`, the
review round of 2026-11-02; a remembered connector that was present and answered nothing is forgotten by `Providers`,
`connectorAnsweredNothing`), `apps/web/scripts/csp.mjs` (with a project id: the modal's hosts in `connect-src` and
`img-src`, the verify iframe's in `frame-src`; `frame-src 'none'` otherwise; WalletConnect's telemetry host never),
`apps/web/src/platform/unloadGuard.ts` (`beforeunload` while a hold is live), `apps/web/src/hooks/index.ts` (the
scheduler's catch-up on `visibilitychange` and `online`), `apps/web/src/storage/persist.ts` + `apps/web/src/app/Background.tsx`
(`navigator.storage.persist()` once per page after an unlock, the answer remembered), `packages/sdk/src/operations/store.ts`
(`unresolvedOperation`: a record of the kind in AWAITING_AUTHORIZATION, PREPARING_PROOF or SUBMITTING) with the Protect and
Send Reviews' blocker `one_at_a_time` (`packages/protocol-types/src/risk.ts`). The checklist and the record of the
owner's runs: `docs/mobile-web-gate.md`.

**As landed (the review round of 2026-11-02).** A runner tick that threw releases the hand-over hold (`orderRunner.ts`: a
dead tick had kept the lock off for the cap's thirty minutes) and the next tick of an open order before its hand-over takes
the critical section again. The policy names WalletConnect's hosts exactly — never a wildcard: `*.walletconnect.org` had let
the telemetry host and the provider's RPC host through — and `apps/web/test/csp.test.ts` matches `pulse`, `echo`, `rpc` and
`secure` against every source as a browser would. WalletConnect is initialized at a reload only with a session its own store
holds; a remembered connector that answered nothing is forgotten. The one-at-a-time words say how the earlier operation
resolves when its page is gone (from the chain: within minutes through a relayer, up to an hour through the wallet).

**As landed (the second review round, 2026-11-03), the screens.** The trading preference rows and the Privacy Center say
what the runner does: a swap is funded as soon as it is confirmed, and only "Delay for more privacy" on a swap adds a random
1–24 h — the posture scores the funding as immediate (the Home badge follows; audit gap 65); the Privacy Center says the
RPC endpoints learn the wallet's own nullifiers when it checks whether its notes were spent (gap 48); "Remove from this
device" removes a finished record with its line; a Protect's Review stays closed without a wallet to pay, and "no injected
wallet" is `wallet_disconnected`; a reveal of the recovery phrase reads "Phrase shown … no backup yet", only an export reads
"backup created"; the enhanced Send Review closes its confirmation offline as the V6 Review does; the Korean fee-policy
sentence says "a round amount" the right way round.

## 10. Gates (doc §13) — *Stages 2, 10, 11, 17*

| Doc §13 gate | Evidence | Where |
|---|---|---|
| Contract | v2.0 §19 (forge, the deployment fingerprint); *V7*: the Classic pins verified live (§7.2) | `contracts/`, `classic/test/` |
| Cryptography | v2.0 §19; *V7*: the vendored-file hashes, the note and proof vectors, the deployed verifier's acceptance (§7.3) | `classic/test/`, `classic/vendor/VENDORED.md` |
| Sensitive data | v2.0 §19 (the leakage gates); *V7*: the Classic leakage twin — no note anywhere (§7.8) | `apps/web/test/privacy-leakage.test.tsx`, `classic/test/`, the e2e twin |
| Classic | §7.10's ladder per pool and function | `classic/docs/release-gate.md` |
| Relayer | v2.0 §16, §19; *V7*: the Classic relayer survey and schema tests (§7.5) | `apps/relayer/`, `classic/test/` |
| Swap | v2.0 §13, §19; *V7*: the facade's parity test (§5), the band tests (§4) | `packages/swap-engine/`, `tests/high-value/` |
| Recovery | v2.0 §12, §19; *V7*: the state upgrade and migration tests (§6) | `packages/sdk/test/`, `apps/api/test/` |
| Browser | v2.0 §17, §19; *V7*: the Classic app's own CSP, budget, bundle scan, pins, audit, dependency review | `classic/scripts/`, `scripts/verify-all.mjs`, CI |
| Mobile web | §9 | `docs/mobile-web-gate.md`, the harnesses |
| Production | v2.0 §19, §21; the owner's: audits, the ceremony, the testnet broadcast, the legal and sanctions review, incident response, rollback of the static builds and the services (the money contracts have no upgrade path) | `docs/audit-package.md`, `docs/deployment.md` |

**As landed (Stage 10, 2026-10-26).** The local stack places Tornado Classic's mainnet contracts at their mainnet
addresses on the devnet (`scripts/local-stack/deploy.mjs`, step 6): the four pools, the verifier and the MiMC Hasher
library they link, the TornadoRouter and the two registries behind their proxies — the runtime code from the Sourcify
records the pins were verified against (`classic/contracts/verified/`), the Hasher's code and the registries' storage
(the EIP-1967 slots, the initializer flags with the router, the minimum stake, the four ETH instances ENABLED) read from
mainnet once by `scripts/local-stack/classic-capture.mjs` into `scripts/local-stack/mainnet/classic-state.json`. Each
pool gets the storage its constructor writes — levels, the twenty zero subtrees in `filledSubtrees` and `zeros`, the
empty tree's root, the reentrancy counter, the denomination, the verifier, no operator — computed with the app's own tree
hash, and every getter is read back, `hashLeftRight` through the Hasher included: the chain's MiMC is held to the app's
before any deposit. `start-services.mjs` runs the Classic dev server (5174) behind the wallet's `/classic` proxy with
every pool function switched live, the history synced from the block the contracts were placed at
(`VITE_CLASSIC_DEPLOYED_BLOCK`, a development-only setting a production build refuses), and a relayer stand-in
(`scripts/local-stack/classic-relayer.mjs`, 8791) that speaks the protocol — the status with its string health, the
withdrawal request as the validator wants it, the seven job states — and submits through the real router from the devnet's
account #0, checking the fee as the original relayer does. The browser run's section 11 (`scripts/local-stack/e2e.mjs`)
reaches the app from More, reads its own policy, reads the facts under Settings for real (the pool's code verified against
the pins, the router enabled by the registry, one relayer online, the history synced with its root known to the pool, the
wallet connected), refuses a note nobody deposited and one of another network, and — in the full run — deposits 1 ETH
through the router, finds the note after twelve confirmations and a reload (the device's copy synced to the chain), proves
in the prover worker, hands the withdrawal to the stand-in and follows it to CONFIRMED, reads the recipient's balance and
the pool's `isSpent`, then withdraws 0.1 ETH in wallet mode; its twin reads every Classic request and the Classic database
for the notes (none) and names the hosts (the origin, the devnet, the stand-in) — 234/234 checks on the quick pass with the Classic sections, 35 of them Classic's (`scripts/local-stack/results/report-2026-10-27-v7-stage10.json`). The mainnet fork
(`classic/test/fork/withdraw.fork.test.ts`, `npm run test:fork` with `CLASSIC_FORK_RPC`) runs the same services in Node
against a Hardhat fork of mainnet: the served snapshot synced onto the fork and the pins verified against it, a 100 ETH
deposit through the real router and registry, the withdrawal through the router by an in-process relayer (the note spent
on chain, the pool's own Withdrawal event), then a hundred deposits between the proof and the confirmation so the root ages
out of the pool's hundred — the flow syncs again and proves again once. On this workstation the suite ran in its devnet mode against the local stack's chain (`CLASSIC_FORK_RPC=http://127.0.0.1:8546`: 3 tests in 30 s — the deposit through the real router, the withdrawal through the router by the stand-in with the note spent on chain and the pool's own Withdrawal event, the aged root proved again after a hundred deposits); a mainnet fork node could not be started here — Hardhat's fork engine dies at start with a segmentation fault, as anvil does on this machine — so the run against mainnet's real state is the owner's, on another machine. Found by this stage: the app hashed the
pool code's hex text where the pins hash its bytes (every mainnet pool would have read "differs from the pins";
`classic/src/app/services/contract.ts`, pinned by a test over the Sourcify record); the root is now checked again right
before a submission, not only after the proof; a ready history older than a minute syncs again when asked (a deposit made
meanwhile is found without a reload), and a flow waits for a running sync before reading `verified`; the build may name
relayers of its own (`VITE_CLASSIC_RELAYER_URLS`), offered beside the curated list without a registry record — the
stand-in's way in; a release names none. The first browser run also found the compiled-in curated relayers asked from the
devnet (the chain answers id 1, the pools sit at their mainnet addresses, so every rule passed and 23 mainnet relayers
learned of a development machine): a development chain now switches the curated list off (`VITE_CLASSIC_RELAYERS_CURATED=0`,
refused in a production build), and the dev server's page fallback — index.html where a manifest was asked — is no
longer taken for a snapshot (an HTML answer means none served; `classic/test/net-snapshot.test.ts`), the devnet serving none
(`VITE_CLASSIC_DATA_BASE` pointed at an empty path, since `public/data` may hold mainnet's).

## 11. Implementation order — the V7 stages (doc §12, §15)

| Stage | Doc phase | What | Sections |
|---|---|---|---|
| 0 | 0 | this document; the roadmap table | all |
| 1 | 0, 6 (A) | the original's reference screenshots and the compatibility matrix | §7.9, §7.3 |
| 2 | 1, 6 | the `classic/` package and the repository's gates for a second app | §7.8, §10 |
| 3 | 1, 6 (D) | the Classic screens on mock data, the Classic harness, the parity table | §7.9 |
| 4 | 1 | the Privacy Wallet's IA: routes, redirects, Settings, the header's Connect wallet — **doc §15's seven-screen build exists after Stages 3 and 4** | §2 |
| 5 | 6 (B) | deployment verification and the pins | §7.2 |
| 6 | 6 (C) | the vendored prover, the precompiled circuit, the vectors, the deployed verifier's acceptance | §7.3 |
| 7 | 6 (C) | snapshots, delta sync, the live root match, spent notes | §7.4 |
| 8 | 6 | the relayer client, the curated list, fees, wallet mode | §7.5 |
| 9 | 6 | the flows wired, availability, the switches, the Classic operation adapter | §7.6, §7.7 |
| 10 | 6, 8 | Classic end to end: the devnet with the real bytecode, the mainnet fork, the leakage twin — landed, §10 | §7.10, §10 |
| 11 | 6 (E) | the Classic release gate, its documents, the old module removed | §7.10, §7.11 |
| 12 | 3 | the fee policy statement | §3 |
| 13 | 7 | the amount policy | §4 |
| 14 | 5 | the swap provider facade | §5 |
| 15 | 3 | the fifteen operation states | §6 |
| 16 | 8 | the mobile-web gate | §9 |
| 17 | 8 | documents, the Definition of Done, the final runs | §12 |

## 12. Definition of Done (doc §14) — *Stage 17*

`docs/definition-of-done-v7.md` maps the document's 21 tracker items to their evidence and status: **design
foundation** — mobile-first tokens (V6; Classic's generated stylesheet), the Home / Protect / Send / Swap / Activity
prototypes (V6 fixtures and baselines), desktop layouts (V6; Stage 4), unified fee and review components (V6; the fee
terms of Stage 12); **Tornado Classic** — the pinned upstream source and licences (Stage 1), the four pools' and the
router's verification (Stage 5), note and proof compatibility (Stages 6, 7, 10), the original-style deposit / withdraw
frontend (Stages 3, 9), the audited transaction and relayer integration (Stages 8–11; the external audit the owner's);
**the Privacy Wallet** — external wallet and protected storage (V6; Stage 4's reconnect), balance synchronization (V6),
Protect and Private Send end to end (V6, the local stack), locally generated and validated proofs (V6); **swap and
operations** — the exact 1 % fee engine and relayer quotes (V6; Stage 12), the THORChain adapter (V6; Stage 14), minimum
receive and destination verification (V6; Stage 13), persistent state and recovery (V6; Stage 15); **release** — mobile
browser end-to-end tests (V6 local stack; Stage 16; the real-device run the owner's), the contract / cryptography /
frontend audits (the owner's), privacy leakage tests (V6; Stages 10–11 for Classic), production readiness and the legal
review (the owner's).

## 13. Crosswalk — doc §1–§15

| Doc § | Here | Stage |
|---|---|---|
| 1 verified Classic references | §7.2 | 5 |
| 2 the mobile web experience | §2, v2.0 §7 | 4 |
| 3 structure and navigation | §2 | 4 |
| 4 Classic implementation plan (4.1 approaches, 4.2 "same as original", 4.3 workstreams A–E, 4.4 the screen, 4.5 independence) | §7.1–§7.11 | 1–3, 5–11 |
| 5 main wallet scope and rules | §1, v2.0 §1–§3, §11, §13 | 0 |
| 6 fee engine | §3 | 12 |
| 7 swap engine and THORChain | §5 | 14 |
| 8 transaction amount policy | §4 | 13 |
| 9 web technology stack and repository | §8 | 0, 2 |
| 10 screen-by-screen requirements | v2.0 §7, §7.9 here | 3, 4 |
| 11 operation-engine contract | §6, §7.7 | 9, 15 |
| 12 delivery phases | §11 | all |
| 13 security release gates | §10, §7.10, §9 | 10, 11, 16, 17 |
| 14 progress and acceptance checklist | §12 | 17 |
| 15 the first implementation milestone | §11 (Stages 3 + 4) | 3, 4 |

## 14. Deviations and out of scope

Deviations, each the owner's decision of 2026-10-26 or recorded for the owner: the lean stack stays (no wagmi,
TanStack Query, React Hook Form or Motion — §8); the workspaces keep their names (§8); Classic is a top-level `classic/`
app rather than apps/classic (the document's isolation on the repository's lockfile rule — §7.8); the document's
apps/indexer is a snapshot script (§8); the original Nuxt source is not run — its built output is the parity
reference (§7.9); the states are renamed as the document names them, with `QUOTE_EXPIRED` expressed as a reason (§6);
the privacy fee of an undelivered swap is earned at funding, stated in the published policy, because the escrow
bytecode cannot hold it (§3); a user-entered Classic relayer URL, a persisted "my deposits" list, Classic in languages
beyond English and Korean, and a `classic.` subdomain are follow-ups. Out of scope and the owner's: the legal and
sanctions review (the switches stay off until it is recorded), external audits, the production ceremony, the testnet
and mainnet broadcasts, a real-funds route rehearsal, the real-device run, and any further change to `PrivacyCore`, the vaults,
the circuits, the swap escrow, `ProtectRouter` or `ShieldReceiver` (the third review round's two periphery fixes, noted in the
preamble, excepted).
