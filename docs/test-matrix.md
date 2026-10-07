# Cross-chain test matrix — plan §71 / §72 / §74 (steps 17–18)

Every row of plan §71 for every provider, with the test that executes it. Three kinds of test:
**forge** — `contracts/test/periphery/SwapOrderEscrow.t.sol` and `contracts/test/e2e/RealProofE2E.t.sol`
(the on-chain half: what the escrow accepts, refunds and forwards); **live** —
`services/private-swap/test/*.test.ts` against the providers' real public APIs (read-only, no funds,
no keys; user decision 2026-10-06); **tampered** — live, with the provider's API response rewritten
by `test/helpers/tamper.ts` (outage, status, body) so that the engine's local verification is what
is under test, not the provider's honesty. Pure state-machine checks are marked **pure**.

Run: `cd services/private-swap && npm test` (≈ 2 min, network) · `cd contracts && FOUNDRY_OFFLINE=true forge test --use $SOLC`.

## §71 rows × providers

| §71 row | THORChain | Chainflip | Mayan | NEAR Intents | LI.FI | Uniswap/Across | on-chain (any provider) |
|---|---|---|---|---|---|---|---|
| quote | live `adapters-live` (quote ETH→BTC, memo + router calldata) | live (vault-swap quote, `encodeVaultSwapData` decoded) | live (Fast-MCTP quote, createOrder built) | live (dry quote; signed by the service) | live (quote + `transactionRequest`) | live (`suggested-fees`, exact fill) | — |
| execution | live `privacy-flow` (prepareExecution: quorum-confirmed router, memo, digest) | live `privacy-flow` (ingress verified, digest) | live `adapters-live` (createOrder fields decoded) | **withheld** until 1Click confirms contract-sent deposits (`contractSender:false` → never chosen; `engine-core` "never chosen") | live `privacy-flow` (diamond + BridgeData + facet verified) | live `privacy-flow` (depositV3 decoded) | forge `test_PrivateWithdrawal_FundsCounterfactualEscrow_RelayerExecutes`, e2e `test_E2E_PrivateNoteExitsToSwapOrder_RealProof` |
| timeout | pure `adversarial` "provider timeout" (PROVIDER_EXECUTING → REFUND_PENDING only after `refundAfter`); tampered status → `executing` | tampered `/v2/swaps` SENDING/FAILED | tampered explorer status | tampered `/v0/status` PROCESSING | tampered `/status` PENDING | tampered `deposit/status` pending | forge `test_QuoteExpires_RefundReShieldsAsFreshNote_ThenSpendable`, `test_ProviderRevert_FundsStayAndRefundLater` |
| partial | n/a (THORChain refunds or fills) | n/a (fill-or-kill: refund) | n/a (order fills or refunds) | n/a | tampered `DONE/PARTIAL` → `partial` → PARTIAL → REFUNDED | n/a (exact fill) | forge `test_ProviderRefundsToEscrow_ThenReShield` (remainder re-shielded) |
| refund | tampered status mapping; refund path = inbound refund to the escrow (memo has no refund address: THORChain refunds the sender) | tampered `FAILED + refundEgress` → `refunded`; refund address in cfParameters = escrow (verified) | tampered `REFUNDED`; refunds land in USDC at the destination (`refundTarget: "destination"`, spec §7) | tampered `REFUNDED`; `refundTo` = escrow in the quote | tampered `DONE/REFUNDED`; Across facet `refundAddress` = escrow (verified) | tampered `expired` → `refunded`; `depositor` = escrow | forge refund tests above + `test_ERC20Order_ExecuteAndRefund`; e2e `test_E2E_SwapOrderRefund_ReShieldsAndIsSpendableWithRealProof` |
| wrong destination | tampered API memo ignored: memo built from the request | tampered `dstAddress` → refused | destination from the request (createOrder `destAddr` decoded, `adapters-live`) | binding quote `recipient` compared (`prepareIngress`) | tampered `BridgeData.receiver` / `action.toAddress` / Mayan `nonEVMReceiver` → refused | recipient from the request (decoded) | forge `test_TamperedCalldata_Rejected` (a different calldata is a different signature) |
| wrong token | memo asset from the request | tampered `dstToken` (unit test `chainflip-unit`) | tokenOut from the request | asset ids resolved from the token list | `sendingAssetId` / first-swap asset + Across `receivingAssetId` → refused | tokens mapped locally | forge `test_ERC20Order_ExecuteAndRefund` |
| wrong chain | memo chain from the request | tampered `dstChain` → refused | CCTP domain from the request | asset ids carry the chain | tampered `destinationChainId` + tx `chainId` → refused | `destinationChainId` from the request | — (chain id is in the execution digest: `endpoints.test.ts`) |
| insufficient liquidity | tampered `error` → per-provider error | tampered HTTP 400 → error | tampered HTTP 400 → error | tampered HTTP 400 → error | tampered HTTP 404 → error | tampered `isAmountTooLow` → error | — |
| provider outage | tampered gateway failure (`quoteAll` degrades); quorum needs ≥ 2 gateways | tampered outage → unreachable | tampered outage | tampered outage (token list cached in-process) | tampered outage → unreachable, others still chosen | tampered outage | forge: a never-executed order refunds after the window |
| chain reorg | pure: SOURCE_SUBMITTED → SOURCE_FAILED → resubmitted; recovery from an unfunded escrow | same | same | same | same | same | the escrow is counterfactual: a reorged funding tx leaves nothing to execute (`test_UnfundedEscrow_CannotExecute`) |
| destination congestion | tampered `SENDING` → DESTINATION_SUBMITTED: never refunded while in flight, late delivery still COMPLETED (pure) | same | same | same | same | same | — |

## §72 — cross-chain privacy tests (`test/privacy-flow.test.ts`, live)
| Requirement | Test |
|---|---|
| the permanent source wallet MUST NOT appear in the provider flow | every request URL / body / header, every signed calldata / memo, every order object scanned for the permanent address and the key material; only `accept` / `content-type` (/ API key) headers are ever sent |
| source endpoint | the one-time escrow is the only sender the provider sees: Chainflip refund address, Across depositor, LI.FI `fromAddress` + Across `refundAddress`, 1Click `refundTo`; two commits of the same quote give two escrows |
| destination endpoint | the fresh address is what the signed calldata carries: Chainflip `dstAddress`, THORChain memo, Across recipient, LI.FI receiver / `nonEVMReceiver`, Mayan `destAddr` |
| amount, timing vs a blockchain observer | `services/private-swap/src/sim/crossChainLab.ts` → `benchmarks/privacy/crosschain.json`, read in `docs/privacy-lab.md` (cross-chain section) |

## §74 — provider compromise (engine side, `test/adversarial.test.ts`, tampered)
| Pretend… | What the engine checks before the order key signs | Test |
|---|---|---|
| THORChain compromised (a lying THORNode gateway) | inbound vault + router must be confirmed by ≥ `THORNODE_QUORUM` (2) distinct gateways; any disagreement fails closed; the memo (destination, limit) is built locally | "one gateway lies", "only one gateway reachable", "quote's inbound address differs", "memo from the API is never used" |
| Chainflip compromised (backend) | Vault address pinned; `xSwapNative` calldata decoded: chain, asset, destination, refund = escrow, min price, retry, no broker/boost/DCA, value | "vault address swapped", "refund address swapped", "destination chain rewritten", "destination address rewritten", "minimum price zeroed" |
| Mayan compromised (API) | order payload built locally; Fast-MCTP contract pinned; `minAmountOut` within slippage + 2 % of `expectedAmountOut`; `amountIn` echoed | "minAmountOut lowered", "Fast-MCTP contract swapped", "amountIn changed" |
| NEAR solver malicious | `minAmountOut` within slippage + 1 %; ingress withheld until contract-sent deposits are confirmed; the signed quote binds recipient / refund | "1Click minAmountOut lowered"; `adapters-live` "refuse to produce an ingress" |
| LI.FI API malicious | diamond pinned; tx chain id + value; quote from/to; `BridgeData` receiver / destination chain / no destination call / spent asset + amount; Across facet receiver, refund = escrow, receiving asset, exact `outputAmount`; Mayan facet `nonEVMReceiver`; unverifiable minimum ⇒ refused under strict policies | 11 tests in "§74 LI.FI API malicious" |
| any provider re-quoting below the market at signing time | `priceGuard`: the re-quote must be within `maxGapBps` of the best live alternative | "Across outputAmount lowered → price guard" |
| **damage bound** (all of the above, on-chain) | a provider can take at most the one escrow's balance; core balance 0; vault accounting untouched | forge `test_MaliciousProvider_CanOnlyTakeTheEscrowBalance`; `NoPrivilege.t.sol::test_SwapPeripheryHasNoPrivilegedPath` |

Residual, documented: Mayan's source-chain ETH→USDC leg uses router calldata from Mayan's API bounded
only by `minMiddleAmount` (also from the API, enforced on-chain by the forwarder) — a fully malicious
Mayan API can degrade that leg within the §74 damage bound; the price guard against other providers
is the mitigation. NEAR Intents' deposit address cannot be verified independently of the service.
