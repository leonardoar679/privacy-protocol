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
| `GET /info` | `{ chainId, core, feeVault, relayer (gas EOA), privacyAddress (pp1…: where fee notes go), minFeeWei, gasPriceWei, gasEstimate, feeMarginBps, requireReadableFeePayload, inflight, feeVaults: [{ vault, symbol, decimals, minFee }] }` — the ERC-20 vaults it takes fee notes in, each with a fixed minimum in token units (`FEE_VAULTS`, plan §36) |
| `POST /submit` | `{ proof (abi.encode(a,b,c)), publicInputs (14 decimal strings), noteData[3], fee: { outputIndex, amount, noteSecret, vault? } }` → `{ txHash, feeWei, feeVault, gas, feePayloadReadable }` — `fee.vault` names the vault of the fee note (default: the ETH vault); a transaction is single-asset, so a USDC withdrawal pays in USDC |
| `GET /status/:txHash` | the job (`submitted` / `mined` / `reverted`) |

The wallet includes the fee note's opening so the relayer can verify it is really paid before it
spends gas; the payload of that output is encrypted to the relayer's view key (its privacy address),
so the relayer can also rediscover the note from chain like any wallet.

## What is checked before gas is spent (test/ — 30 tests across the service against forge fixtures on a mock chain)
1. shapes: 256-byte proof, 14 public inputs, three 169-byte payloads;
2. `txDomain` == this chain / core (no replay across deployments);
3. every payload hashes to its proven `noteDataHash`;
4. the fee output is `noteBody(feeVault, amount, relayer's ownerCommitment, noteSecret)`;
5. `amount ≥` the vault's minimum: in the ETH vault max(floor, gasEstimate × gasPrice × (1 + margin)) — live; in an ERC-20 vault the fixed `FEE_VAULTS` minimum (no oracle: the operator reprices by config); an unlisted vault is refused (`fee_vault_not_accepted`);
6. the nullifiers are not already in flight here;
7. `eth_estimateGas` from the relayer's address succeeds (proof, root and nullifier set are checked by
   the contract; a reverting call never reaches the chain);
8. optionally (`REQUIRE_READABLE_FEE_PAYLOAD=1`) the fee payload decrypts with the relayer's view key.

## Swap-order executor (private-swap spec v1.1 §11)
The same service runs the on-chain half of a private swap for the committed tip. The wallet hands it
`POST /swap/execute { factory, params, execution, refundNoteData }` after signing the provider call
and funding the escrow; the executor checks locally that the refund payload hashes to the committed
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
dropped with the reason, never blocking the rest.
`SWAP_POLL_MS` (15 s) sets the cadence. `test/executorMore.test.ts` covers replacement, ERC-20, journals,
late refunds and foreign tokens.

## Run
`.env.example` lists every setting (copy to `.env`); `npm run typecheck` runs `tsc --noEmit`.
```
cd services/relayer && npm install && npm test
RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337 CORE=0x… FEE_VAULT=0x… \
RELAYER_PRIVATE_KEY=0x… RELAYER_SEED="relayer wallet seed" npm run serve      # http://127.0.0.1:8790
```
The gas key only ever holds gas. The seed is the relayer's own wallet (it spends fee notes with the
same wallet software as any user: rescan with the view key, withdraw with a proof). **Journals are
durable**: `RELAYER_JOURNAL_DIR` (default `journal/`, gitignored) holds `submissions.json` and
`swap-jobs.json`, written atomically on every change; a restarted relayer resumes open swap jobs and
keeps the in-flight nullifiers of unmined submissions (tested). Not verified here: a live chain run
(this machine cannot run a node — `docs/testnet.md`).

## Abuse limits
Per-caller token bucket (`RATE_PER_MINUTE`, default 60, burst ≤ 20; `429` + `retry-after`), a cap on
open swap jobs (`MAX_SWAP_JOBS`, default 1000; `503`), 1 MB bodies, JSON only on POST (`415`). Nothing
about a caller is logged. A public relayer should still sit behind its own front proxy.

## Trust
Sees: the transaction (public anyway) and the submitter's IP. Cannot: change any field, redirect
funds, steal the fee without submitting (the fee note exists only if the transaction is mined),
or stop a user who switches relayer or self-submits. Can: refuse, delay, or front-run nothing of value.
