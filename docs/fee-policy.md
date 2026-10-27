# Fees and refunds — the published policy

**Status:** V7 Stage 12, 2026-10-27. Privacy Wallet Web spec v3.0 §3 (the owner's decision 2 of 2026-10-26: "1 % on every
operation, disclosed") over the formulas of spec v2.0 §3. The wallet links here from the Privacy Center and from Settings
as **Fees & refunds**; the in-app page says the same things in the same words (`apps/web/src/features/privacy-center/FeesAndRefunds.tsx`,
English and Korean). Tornado Classic has its own fee lines and none of this (§6).

## 1. The privacy fee

- **1 % of what you put in**, rounded up to the next base unit: `p(A) = ⌈A × 100 / 10000⌉`. For a round amount it is
  exactly 1 % ($1,000 → $10; $10,000 → $100); otherwise at most one base unit more. The figure is computed in integers
  (base units, and cents for the dollar lines), never in floating point — the wallet, the relayer and the contract
  compute the same number.
- **Charged once per operation you confirm**: a Protect, a Send, a withdrawal, a Swap (same-chain or cross-chain). A
  swap's internal steps — proving, funding the escrow, the relayer's submission, the provider's execution, the
  settlement — are one operation and pay one `p(A)`.
- **A protected execution** (a large swap run in pieces) pays `p(A)` of the whole: each piece's note carries its share,
  rounded up by at most one base unit a piece.
- **Merges, splits, refunds and re-shields pay no privacy fee.** They pay the relayer's cost `F` where a relayer acts.
- **A Protect followed later by a Swap are two operations, and each pays its 1 %.** Protecting funds costs 1 % of the
  deposit; swapping them later costs 1 % of the swap. The Swap Review says so in one sentence: *Your funds paid 1 % when
  they were protected; this swap pays 1 % again.*
- Every Review states it before you confirm: **Privacy fee (1 %) — charged on each protect, send and swap.**

## 2. The relayer's cost and the network

- A Send, a withdrawal and a swap's funding go through a relayer, which pays the gas. The wallet pays it `F`: the
  relayer's live minimum plus the wallet's 10 % margin, read from the relayer right before the Review.
- **The fee shown is a bound.** The wallet reads the relayer's terms again when it is about to prove and submit; if the
  fee is above the one the Review showed, nothing is proved or sent — the Review is shown again (`fee_moved`). A swap
  journals the fee it reviewed (`reviewedFee`) and its funding, now or after a delay for privacy, never pays more.
- **A protected execution's pieces are bound too** (V7): each piece carries the `F` the Review showed; the Review shows
  `Relayer/network (n steps)` as `F × n`; a piece whose relayer asks more waits rather than pays.
- On chain, the privacy fee and the relayer's cost ride **one fee note** (`p(A) + F`): the relayer is paid that note and
  owes the protocol the 1 %. A relayer whose terms ask more than the 1 % (`feePercentBps` above 100) is not used. There is
  no other relayer percentage.
- **The executor tip** of a swap is the execution's gas cost, estimated from the chain's fee history — never a
  percentage and never a fixed gas price; the escrow caps it at 1 % of the funding.
- A Protect pays its own network cost from the connected wallet, in the chain's coin, as any transaction does.

## 3. When nothing is charged

- An operation that never leaves the Review costs nothing.
- An operation stopped before anything is sent — a fee that moved above the reviewed bound (`fee_moved`), a tip the
  wallet could not check (`cost_unknown`), a stale tip (`tip_stale`), an order whose execution window closed
  (`order_window_closed`), a relayer that is not ready — costs nothing: no note left the protected balance.
- A funding is never sent twice: a submission whose answer was lost is found again by its nullifier before anything
  else is sent (spec v2.0 §12.5).

## 4. Refunds

- **The privacy fee of a swap is earned when the escrow is funded.** The fee note is paid to the relayer with the
  funding; the escrow's code (frozen on chain) does not hold it, so it cannot be returned by the escrow.
- **A swap the provider does not deliver returns the swapped amount, not the fee.** The escrow's refund path returns
  what was funded (less the executor tip already spent on the attempt, as the escrow's rules say) to a fresh note of
  the protected balance; the refund screen's funds line names the amount that comes back. The 1 % is not returned.
- A protected execution's piece that is refunded and planned again pays its share of the privacy fee again, and the
  relayer's `F` again — the progress screen says so before it happens, under the Review's `F × n` bound.
- Retries and reconciliations follow the signed terms: the wallet reads what happened on chain before it acts again,
  and a second 1 % is never charged silently.

## 5. Where the figures come from

| Line | Formula | Where it is computed |
|---|---|---|
| Privacy fee | `p(A) = ⌈A·b/10000⌉`, `b = 100` | `packages/protocol/src/wallet/fees.ts` (`privacyFee`), the relayer (`feeMeetsTerms`), ProtectRouter (`feeOf`) |
| Relayer / network | `F` = the relayer's minimum × 1.1, re-read at submit and bounded by the Review | `packages/sdk/src/relayer.ts`, `packages/sdk/src/privateTx.ts` (`feeWithinReview`) |
| Executor tip | `T = ⌈units × (2·baseFee + priorityFee) × 1.2⌉` from `eth_feeHistory`; `T ≤ W/100` | `packages/swap-engine/src/tips.ts`, `SwapOrderEscrow.sol` |
| Swap / provider | the provider's own fees in the source asset; a fee taken in another asset is in the rate | the provider's quote, `apps/api/src/quote.ts` |
| The quote's fee terms | `feeTerms { privacyFeeBps, relayerFee, executorTip, maxFee, termsAt }` beside `expiresAt` and `minimumOutput` | `apps/api/src/quote.ts`, `packages/protocol-types/src/quotes.ts` |
| Dollar lines | integer cents from the Chainlink price; an unpriced asset shows its own units | `apps/web/src/features/swap/model.ts`, `features/amounts.ts` |

The display identity holds on every screen: `input − privacy fee − relayer/network − swap/provider − market rate & impact
= estimated receive` (the last term the residual, possibly negative).

## 6. Tornado Classic

The Classic application charges **no privacy fee**. A withdrawal through a relayer pays the relayer's own percentage of
the denomination (shown as *Relayer fee*, from the relayer's status) plus the network fee (`550,000 gas × the live gas
price`, shown as *Network fee*), both read live and shown apart before the proof; wallet mode pays the gas from the
connected account and no relayer fee. Nothing of this policy applies there (spec v3.0 §7.5).

## 7. The rules of the owner's document (§6) and their status

| Rule | Status |
|---|---|
| 1 Integer / exact decimal math | the fee code is bigint-only (a source scan refuses floating point); the dollar lines are integer cents |
| 2 Quotes bound to input / output asset, network, minimum receive, expiry and fee terms | the §46 quote carries `feeTerms` beside `expiresAt` and `minimumOutput`, and states `p(A)` of what the user pays |
| 3 Privacy fee shown apart from relayer / network / provider fees | the Review's lines; on chain `p + F` ride one fee note (§2) |
| 4 No hidden extra relayer percentage | the relayer's `feePercentBps` is the privacy fee itself; its margin on gas is §2's 10 % |
| 5 Bounded relayer fee with an agreed maximum | single operations since V6; a protected execution's pieces since V7 |
| 6 No fee when the service was not delivered, per a published refund policy | §3 and §4: nothing charged for an operation that never leaves the Review or is stopped before anything is sent; the privacy fee of a funded swap is earned at funding and the swapped amount comes back |
| 7 Retries, reconciliations and refunds follow the signed terms, never a silent second 1 % | §4 |
| 8 Classic fees distinct | §6 |
