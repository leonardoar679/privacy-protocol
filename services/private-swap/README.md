# PrivateSwap engine

Implements [`docs/private-swap-spec-v1.1.md`](../../docs/private-swap-spec-v1.1.md): the order
object, the route state machine with recovery, the provider adapter interface, policy-weighted route
scoring with a live incident feed, the cross-chain privacy score, and the one-time EVM endpoint
(counterfactual `SwapOrderEscrow`) with the execution authorization the order key signs.

```
npm install
npm test                                   # 149 tests: 43 offline + 106 LIVE (real quote APIs, read-only, no funds)
npx tsx src/cli.ts 1 BTC best-privacy       # quote all providers, choose, derive the endpoint, sign the execution
npx tsx src/cli.ts 1 USDC_BASE best-price
```

| Module | What |
|---|---|
| `src/types.ts` | Order / Quote / Ingress / OrderParams / Execution, route categories A–E, adapter interface |
| `src/order.ts` | state machine (every transition + failure branch), user-facing statuses, journal, recovery from chain facts |
| `src/scoring.ts`, `src/health.ts` | six-component route score with policy weights; incident feed (THORChain 2026-05-15 GG20 exploit) decaying over a year |
| `src/privacyScore.ts` | the eight-factor cross-chain privacy score (spec §10) |
| `src/endpoints.ts` | `abi.encode(OrderParams)`, CREATE2 prediction (== `SwapOrderFactory.predict`, forge vector), execution digest (== `SwapOrderEscrow.executionDigest`), low-s signing |
| `src/engine.ts` | quote all → filter → score → choose; build order (net of the executor tip); authorize (re-quote with the escrow as sender, sign) |
| `src/adapters/thorchain.ts` | **implemented**: THORNode quote (endpoint list; a gateway's 4xx is reported as THORChain's reason), memo with limit and the escrow as refund address (`=:ASSET:DEST/ESCROW:LIMIT`; guest deposits from UTXO chains refund the sender and use THORChain's short asset form when the 80-byte OP_RETURN requires it), pinned Ethereum router + `depositWithExpiry` calldata, inbound vault from a gateway quorum, tx status, per-chain halts |
| `src/adapters/lifi.ts` | **implemented**: `/v1/quote` (bridges limited to the facets it reads: Across, Mayan) → `transactionRequest` ingress **decoded and verified locally** (pinned diamond, facets by selector, `BridgeData`, AcrossFacetV4's output from `minAmount × outputAmountMultiplier`, MayanFacet's sweep recipient = escrow, a source swap only into a token the escrow re-shields: `src/escrowAssets.ts`, PP-S08; for an order in a token, WETH and ETH re-shield as ETH), `/v1/status`, chains |
| `src/adapters/chainflip.ts` | **implemented**: `/v2/quote` vault-swap quotes, `POST /api/encodeVaultSwapData` → `Vault.xSwapNative/xSwapToken` calldata **decoded and verified locally** (pinned Vault address, destination chain/asset/address, refund = escrow, min price, no broker/boost/DCA), `/v2/swaps/{tx}` status, `cf_safe_mode_statuses` halts |
| `src/adapters/mayan.ts` | **implemented**: `/v3/quote` (Fast MCTP, CCTP-settled), order payload (destination, `amountOutMin`, deadline, fees) **built locally** exactly as the SDK does and wrapped in `MayanForwarder.swapAndForwardEth` / `forwardERC20`; the only API bytes are the source-chain router calldata, bounded on-chain by `minMiddleAmount`; explorer status; `refundTarget: destination`. **SWIFT** (Swift V2 auctions): `createOrderWithToken` built locally the way the SDK builds it, the escrow as trader (an unfilled order is cancelled after its deadline and refunded to the escrow: `refundTarget: escrow`), ETH as wrap & lock through the pinned EthWrapper's `wrap()` (no API router calldata), Swift V2 pinned, cancel + refund fees ≤ 1%, deadline 15 min .. 6 h; the higher guaranteed minimum of the two order types wins (`MAYAN_ORDER_TYPES`) |
| `src/adapters/nearIntents.ts` | **implemented (quotes + status)**: 1Click API dry quotes (signed by the service, `minAmountOut`, `refundTo` = escrow on the origin chain), token list, `/v0/status`. `prepareIngress` **refuses an escrow source** until 1Click confirms that deposits sent by a contract (internal transactions) are credited (`ONECLICK_CONTRACT_DEPOSITS_CONFIRMED=1`); the engine ranks it but never chooses it (`contractSender: false` → filtered) |
| `src/adapters/across.ts` | **implemented (bridge + swap leg)**: the same asset: `suggested-fees` → `SpokePool.depositV3` built locally (exact `outputAmount` fill, depositor = escrow → origin-chain refund), pinned SpokePools, `deposit/status`; an asset change: the Uniswap leg through Across's Swap API (`src/adapters/acrossSwap.ts`): `SpokePoolPeriphery.swapAndBridge` decoded and checked in full (pinned periphery and SpokePool, escrow as depositor, the swapped token re-shieldable and reported, the destination message only draining the output token to the fresh address on the pinned MulticallHandler, or for native ETH unwrapping the handler's own WETH first); ERC-20 and native destinations |
| `src/abi.ts` | tiny ABI encoder/decoder shared by the adapters (words, dynamic bytes, selectors) |

The engine never holds money keys. The order key is derived per order by the wallet and used once;
`PrivacyCore` is involved only as the payer of a normal withdrawal to the predicted escrow.

## Adversarial and privacy tests (plan §71 / §72 / §74 — steps 17–18)
`test/adversarial.test.ts` runs the §71 matrix and the §74 compromise cases against the real APIs
with responses rewritten by `test/helpers/tamper.ts` (outage, status, body): every field the order
key would sign is checked locally (LI.FI diamond + facet selector + `BridgeData` + Across / Mayan
facet data; Chainflip vault + decoded `xSwapNative`; THORNode inbound vault/router confirmed by a
gateway quorum, memo refunds to the escrow; Mayan Fast-MCTP
pin + min-out consistency; 1Click min-out consistency; `priceGuard` against a changed re-quote), and
every failure row degrades or refunds. `test/privacy-flow.test.ts` records every request and asserts
the permanent wallet never appears anywhere. `src/sim/crossChainLab.ts` is the §72 observer lab
(`node ../../benchmarks/privacy/run-crosschain.mjs`). Map of rows → tests: `docs/test-matrix.md`.
Live caveats: LI.FI rate-limits bursts (HTTP 429 for ~10 min) and only two public THORNode gateways
answer from here, so the quorum tests skip with the reason when one is down.

## Configuration
`.env.example` lists every setting (all optional); `npm run typecheck` runs `tsc --noEmit` (clean).

## Local service for the wallet UI (`npm run serve`, `src/server.ts`)
Loopback HTTP on `127.0.0.1:8787` (CORS for the Vite dev origins only): `GET /health`, `POST /quote`,
`POST /order` (the wallet supplies the one-time **signer address** and the refund note's commitment /
secret / payload hash), `POST /prepare` (re-quote with the escrow as sender → final ingress + the digest
to sign), `POST /finalize` (the wallet's 65-byte signature; the service recovers the signer and refuses
anything but the order's key), `GET /order/:id`; `GET /health` also reports the deployment every order is built for (`chainId`, `factory`,
`nativeVault`) so the wallet can hand a funded order to `services/relayer`'s swap executor. The engine API behind it is `buildOrder({orderSigner})`,
`prepareExecution` and `attachSignature`; `authorize` remains for in-process keys. Verified: the
frontend's viem signature is accepted by the service's noble-based recovery; a wrong key is rejected.

Live sample (2026-10-06, after the Chainflip adapter): 1 ETH → BTC under best-privacy chose **Chainflip**
(0.03141 BTC, min 0.03126 in the fill-or-kill price, security 88 vs THORChain's incident-depressed 69);
the signed execution targets the pinned Chainflip Vault with 0.9975 ETH and refund = escrow.
Earlier sample: 1 ETH → BTC chose THORChain (0.0314 BTC, limit in memo, security score
depressed to 69 by the May 2026 incident); 1 ETH → USDC/Base chose LI.FI (via Across). Execution with
real funds is out of scope for this pass.
