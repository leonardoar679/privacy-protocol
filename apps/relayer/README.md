# Relayer — private submission for the shielded pool

A wallet that submits its own `PrivacyCore.transact` pays gas from a public address, which ties the
transaction to that address. The relayer submits it instead, from its own key, and is paid by one
of the transaction's three outputs: a **private note to the relayer** (plan §76, spec v1.0 e2e
`test_E2E_RelayerSpendsPrivateFeeNote`). Nothing on chain names the relayer and nothing it does can
alter the transaction — the proof binds every public input, including the payload hashes — so a
relayer can only refuse. The wallet therefore treats relayers as replaceable (plan §81, §85 rule 5):
any URL, and self-submission as the fallback.

## Protocol
| Call | Body / result |
|---|---|
| `GET /info` | `{ chainId, core, feeVault, relayer (gas EOA), privacyAddress (pp1…: where fee notes go), minFeeWei, gasPriceWei, gasEstimate, feeMarginBps, requireReadableFeePayload, inflight, feePercentBps, feeMinimumWei, feeVaults: [{ vault, symbol, decimals, minFee }] }` — `feePercentBps` / `feeMinimumWei` (V5, `FEE_PERCENT_BPS`): the privacy fee as bps of a withdrawal's public amount, never below the live minimum; — the ERC-20 vaults it takes fee notes in, each with a fixed minimum in token units (`FEE_VAULTS`, plan §36) |
| `POST /submit` | `{ proof (abi.encode(a,b,c)), publicInputs (14 decimal strings), noteData[3], fee: { outputIndex, amount, noteSecret, vault? } }` → `{ txHash, feeWei, feeVault, gas, feePayloadReadable }` — `fee.vault` names the vault of the fee note (default: the ETH vault); a transaction is single-asset, so a USDC withdrawal pays in USDC. (V5's `swap` field and its exemption are gone in V6: a swap's escrow funding pays the percentage like any withdrawal.) |
| `GET /status/:txHash` | the job (`submitted` / `mined` / `reverted` / `dropped`), with V6's `gasUsed` and `actualNetworkWei` from the receipt once mined |
| `GET /jobs` | operators only (`RELAYER_ADMIN_TOKEN` as a bearer token, as `GET /swap`; closed when unset): every submission with its fee note's opening and the time it came in. It was open to anyone until a V6 follow-up of 2026-10-15 |
| `GET /jobs/by-nullifier/:nullifier` | V6 Stage 15: the latest job that may spend this nullifier — its transaction hash and status only — so a wallet whose answer was lost finds its submission instead of sending it twice; never a dropped job; `404` `unknown_nullifier` |
| `POST /shield`, `GET /shield/:receiptId` | V6 Stage 12: the shield executor (below) |

The wallet includes the fee note's opening so the relayer can verify it is really paid before it
spends gas; the payload of that output is encrypted to the relayer's view key (its privacy address),
so the relayer can also rediscover the note from chain like any wallet.

## What is checked before gas is spent (test/ — 30 tests across the service against forge fixtures on a mock chain)
1. shapes: 256-byte proof, 14 public inputs, three 169-byte payloads;
2. `txDomain` == this chain / core (no replay across deployments);
3. every payload hashes to its proven `noteDataHash`;
4. the fee output is `noteBody(feeVault, amount, relayer's ownerCommitment, noteSecret)`;
5. the fee: the vault's minimum `m` — in the ETH vault max(floor, gasEstimate × gasPrice × (1 + margin)), live; in an ERC-20 vault the fixed `FEE_VAULTS` minimum (no oracle: the operator reprices by config); an unlisted vault is refused (`fee_vault_not_accepted`). With `FEE_PERCENT_BPS` set (V6, spec v2.0 §3), a withdrawal of W pays `f ≥ ⌈(W + f) × bps / 10000⌉ + m` — the 1 % of the input plus the minimum, a swap's escrow funding included (`fee_too_low` when `f < m`, else `fee_below_percent`; the same `feeMeetsTerms` the wallet splits by); a transfer's amount is private, so only the minimum applies there (`docs/audit-package.md` gap 31);
6. the nullifiers are not already in flight here; they are reserved in the same step as this check, before anything
   is awaited, and given back if the simulation fails. Two requests spending one note at once: one is sent, the other
   answers `nullifier_in_flight` (a V6 follow-up of 2026-10-15). Before, they were reserved after the simulation, so
   both passed the check and both were sent, the second to revert at the relayer's cost;
7. `eth_estimateGas` from the relayer's address succeeds (proof, root and nullifier set are checked by
   the contract; a reverting call never reaches the chain);
8. optionally (`REQUIRE_READABLE_FEE_PAYLOAD=1`) the fee payload decrypts with the relayer's view key.

## Swap-order executor (private-swap spec v1.1 §11)
The same service runs the on-chain half of a private swap for the committed tip. The wallet hands it
`POST /swap/execute { factory, params, execution, refundNoteData }` after signing the provider call
and funding the escrow; the executor checks locally that the factory is the deployment's (`SWAP_FACTORY`; without it the
relayer runs no swap executor and the swap routes answer `503 swap_unavailable`; another factory is
`unknown_swap_factory`), that the swap service vouched for it (`API_VOUCHER`, a V6 follow-up of 2026-10-16: an
execution carries the API's vouch for that very call, a refund its vouch for the order; `unvouched_order` otherwise,
and without the address no swaps run), that the refund vault is its pool's own for the order's asset
(`CORE.VAULT_FACTORY().vaultOf(asset)`, ETH `address(0)`; read before admission, `bad_refund_vault`), that the refund
payload hashes to the committed
value, that the execution is signed by the order's one-time key for the predicted escrow (same CREATE2
formula as `SwapOrderFactory.predict`), that the deadlines are consistent and the value is spendable —
then watches the escrow's balance:
```
waiting-funding ──(balance ≥ amount, before the signed deadline)──▶ executing ──▶ executed ──▶ completed
      │ signed deadline passed ▶ expired                                              ▲ leftover re-shielded
      └──── refundAfter reached with a balance ──▶ refunding (deployAndRefund) ──▶ refunded ◀─┘
```
Every send is simulated first (`eth_estimateGas`), so a bad signature, a passed deadline or a
reverting provider call never costs gas. `GET /swap/:orderId` reports the state; the wallet's Swap tab
polls it. `test/swapExecutor.test.ts` (8 tests) drives this against the periphery forge vector on a
mock chain: the predicted escrow equals forge's, `deployAndExecute` carries exactly the signed
execution from the relayer's key, `deployAndRefund` carries the committed payload, expiry and the
simulation gate behave. ETH and ERC-20 escrows (`balanceOf` for tokens; an ERC-20 execution forwards no ETH
value). A **re-signed execution for the same order replaces** a waiting / expired / failed one (quotes are
short-lived while the privacy delay budget is long, so the wallet funds first and signs against a fresh
quote at execution time); an order that is executing or settled ignores later executions.
A provider can pay back after `refundAfter` (Across refunds an unfilled deposit with the settlement
bundle after its fill deadline, 2 h after the quote): an **executed order stays watched** for
`LATE_REFUND_WATCH_SECONDS` (24 h) past the window, everything that arrives re-shields, and only an
escrow still empty then is `completed` (PP-S11). A route that swapped first pays back in the swapped
token: the wallet lists it (`refundTokens`, at most four, never the order's asset; `address(0)` is an
ERC-20 order's escrow ETH) and the executor calls the escrow's **`refundToken`** for each one held, before
the order's asset (an ERC-20 order's WETH and ETH re-shield as ETH); a token its vault refuses is
dropped with the reason, never blocking the rest. After execution no tip pays for a re-shield, so they
are bounded (PP-S12): at most `MAX_UNPAID_REFUNDS` (3) per order, each moving at least its floor (twice its
gas for ETH and WETH, 1% of the order for its own token, the wallet's `refundFloors` for a listed token,
which a later request can only raise), and a token only into a vault its pool already has; dust and
anything past the budget stay in the escrow, where anyone can re-shield them. A failed gas estimate
is an answer only when the call reverts: an RPC failure is retried next tick, never ends the watch
and never drops a listed token.
`SWAP_POLL_MS` (15 s) sets the cadence; a request's tick and the interval's never run at once — a tick asked for during a pass runs
one more pass after it, so a job added meanwhile is still acted on at once and a funded escrow is never executed twice. `test/executorMore.test.ts` covers replacement, ERC-20, journals,
late refunds and foreign tokens.

## Shield executor (V6 Stage 12, spec v2.0 §11.2)
A same-chain swap into the protected balance pays a one-time `ShieldReceiver`, a CREATE2 address of the
`ShieldReceiverFactory` (`SHIELD_FACTORY`). The wallet registers the receipt in the hand-over tick, before the
execution: `POST /shield { receiptId, params, … }` (the vault read from the factory, `vaultOf`). The executor watches the
receiver: once the delivery is there, it calls `deployAndShield` (or `shield()` on a deployed receiver), which pays its tip
once — only for a delivery of at least `minAmount` — and deposits the rest as the committed note:
`waiting-delivery → shielding → shielded`, or `shield-failed`. A delivery below its minimum, or one after somebody else
claimed the tip, is shielded at the relayer's cost, at most `MAX_UNPAID_SHIELDS` (3) times per receipt. A receipt is
watched `LATE_DELIVERY_WATCH_SECONDS` (24 h) past its delivery deadline. `GET /shield/:receiptId` reports the job (the
wallet's runner reads it every track tick). Journal: `shield-jobs.json`; one pass at a time, as the swap executor.
`test/shieldExecutor.test.ts` drives it against forge's vector.

## Edge and logs (V6 Stage 15, spec v2.0 §17)
`src/edge.ts` puts the relayer behind the server kit's headers, as the API: `no-store`, `nosniff`, no referrer,
`default-src 'none'; frame-ancestors 'none'`, HSTS with `TLS=1`; CORS for `ALLOWED_ORIGINS` only; the rate limit by the
socket's address, no proxy header read, or behind the proxies `TRUST_PROXY_HOPS` names by the address the outermost of
them saw (`docs/deployment.md`); a POST that is not JSON answers `415`. Every console line is checked by
`test/logs.test.ts`: none names a request, a body, an address, a proof, a payload or a secret.

## Run
`.env.example` lists every setting (copy to `.env`); `npm run typecheck` runs `tsc --noEmit`.
```
cd apps/relayer && npm install && npm test
RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337 CORE=0x… FEE_VAULT=0x… \
RELAYER_PRIVATE_KEY=0x… RELAYER_SEED="relayer wallet seed" npm run serve      # http://127.0.0.1:8790
```
The gas key only ever holds gas. The seed is the relayer's own wallet (it spends fee notes with the
same wallet software as any user: rescan with the view key, withdraw with a proof). **Journals are
durable**: `RELAYER_JOURNAL_DIR` (default `journal/`, gitignored) holds `submissions.json`,
`swap-jobs.json` and `shield-jobs.json`, rewritten on every change: written whole to a temporary file, flushed to the
disk, then renamed over the journal, so a crash leaves the old file or the new one. A journal that cannot be read
stops the relayer at start, naming the file, and is left as it is: restore it, or move it aside to start without its
jobs. Before (a V6 follow-up of 2026-10-15) it loaded as no jobs and the next save overwrote it, every funded escrow's
execution and refund, shield and fee-note opening in it forgotten without a word (`test/journal.test.ts`). A
restarted relayer resumes open swap jobs and
keeps the in-flight nullifiers of unmined submissions (tested). The journals are never pruned, and why that waits
for a decision is `docs/audit-package.md` gap 46. Not verified here: a live chain run
(this machine cannot run a node — `docs/testnet.md`).

**The submissions are looked at again on the relayer's own tick** (`Relayer.monitor`, every `SWAP_POLL_MS`; a V6
follow-up of 2026-10-14). A receipt settles a job and takes its nullifiers out of flight. A transaction the node no
longer knows 10 minutes after it was sent, with its nullifiers unspent on chain, is `dropped`: its nullifiers are
released and the wallet's next attempt is accepted. A dropped transaction mined after all spends nothing twice, since
the chain refuses a spent nullifier; the second attempt reverts at the relayer's cost. Before, nothing settled a job
but a `GET /status` that nobody sent. Every nullifier stayed in flight (436 in the local stack's relayer, reloaded at
every restart), and a dropped transaction's notes could never be submitted here again (`test/monitor.test.ts`).

**One transaction of the account at a time** (`src/sender.ts`; a V6 follow-up of 2026-10-15). The submissions, the swap
executor and the shield executor send from one account through one `Sender`, and a send reads its nonce only once the one
before it was broadcast or refused. Before, each read the node's pending nonce on its own, and the two executors' ticks
run on the same interval. Two sends at once read one nonce, and the node refused the second, or, priced 10 % higher,
let it replace the first. The swap executor took that refusal for a failed execution (`execute-failed`) or a failed
refund (`refund-failed`, final). A transaction is signed before it is broadcast, so an error from the broadcast is
checked against the node. A transaction the node holds was sent (the answer was lost, and viem's retry was refused as
"already known"). One it does not know was refused, and the reason gives the node's own words. When the node cannot be
read, the transaction is watched until it is mined or dropped. A submission is `send_failed` only when it never left or
was refused.
An executor's call fails only on its own answer, a revert at estimation. An RPC failure or a send that never left keeps
the job as it is, with a note, and the next tick tries again. A swap, refund or shield transaction the node no longer
knows 10 minutes after it was sent (`DROP_AFTER_MS`) was dropped. Its job goes back to the state it was sent from (`sent`
on the job; an unpaid one gives its place in the budget back), and the next tick sends again with a nonce read anew.
Before, the job waited for that receipt for good. If the dropped transaction lands after all, the second call reverts at
the relayer's cost: an escrow executes once and refunds what it holds, and a receiver shields what it holds
(`test/sender.test.ts`, `test/swapExecutor.test.ts`, `test/shieldExecutor.test.ts`, `test/relayer.test.ts`).

## Abuse limits
Per-caller token bucket (`RATE_PER_MINUTE`, default 60, burst ≤ 20; `429` + `retry-after`), a cap on
open swap jobs (`MAX_SWAP_JOBS`, default 1000; `503`), 1 MB bodies, JSON only on POST (`415`). Nothing
about a caller is logged. A public relayer should still sit behind its own front proxy.

## Trust
Sees: the transaction (public anyway) and the submitter's IP. Cannot: change any field, redirect
funds, steal the fee without submitting (the fee note exists only if the transaction is mined),
or stop a user who switches relayer or self-submits. Can: refuse, delay, or front-run nothing of value.
