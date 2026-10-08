# Whale execution lab — 2026-10-08T00:04:06.557Z

Prices (Chainlink via public RPC): ETH $2568 (2922 s old) · BTC $83279 (311 s old) · SOL $117 (41427 s old) · USDC $0.9998 (26320 s old)

> Read-only quotes; nothing was sent, signed or funded. Impact = output per unit against the same provider's smallest-size quote; cost = output per unit against the Chainlink oracle rate (fees + impact).
> A refusal at a size is this order's size, not a health incident (spec §2): Chainflip answers 400 'insufficient liquidity' above its depth; THORChain quotes any size but streams it.

## ETH>BTC

| size | provider | plan | output / unit | impact bps | cost vs oracle bps | provider bps | ETA | parts | notes |
|---|---|---|---|---|---|---|---|---|---|
| $100K | thorchain | single | refused: THORChain refused: emit asset 114158568 less than price limit 119765371 | — | — | — | — | — |  |
| $100K | thorchain | streaming | 0.0308054 | 0 | 10 | 20 | 17 min | 19 | max parts 20 |
| $100K | chainflip | single | 0.0308559 | 0 | -7 | — | 8 min | — | rec. slippage 2.5 % |
| $100K | chainflip | dca | 0.0308559 | 0 | -7 | — | 9 min | 11 | rec. slippage 2.5 % |
| $100K | near-intents | single | 0.0307879 | 0 | 16 | — | 8 min | — |  |
| $1M | thorchain | single | refused: THORChain refused: emit asset 759665435 less than price limit 1197653883 | — | — | — | — | — |  |
| $1M | thorchain | streaming | 0.0308078 | -1 | 9 | 20 | 23 min | 205 | max parts 206 |
| $1M | chainflip | dca | 0.0308529 | 1 | -6 | — | 18 min | 101 | rec. slippage 2.5 % |
| $1M | near-intents | single | 0.0307578 | 10 | 25 | — | 8 min | — |  |
| $2M | thorchain | single | refused: THORChain refused: emit asset 1066749901 less than price limit 2395307768 | — | — | — | — | — |  |
| $2M | thorchain | streaming | 0.0308078 | -1 | 9 | 20 | 44 min | 411 | max parts 412 |
| $2M | chainflip | dca | 0.0308560 | 0 | -7 | — | 28 min | 201 | rec. slippage 2.5 % |
| $2M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"9d8975f9-fafe-4a2e-8790-b76682df2dc9","timestamp":"2026-10-07T23:57:10.255Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $5M | thorchain | single | refused: THORChain refused: emit asset 1257690476 less than price limit 5988356954 | — | — | — | — | — |  |
| $5M | thorchain | streaming | 0.0308084 | -1 | 9 | 19 | 106 min | 1031 | max parts 1032 |
| $5M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $5M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"81c2e487-a0d2-424d-8b99-05029166ac91","timestamp":"2026-10-07T23:57:24.343Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $10M | thorchain | single | refused: THORChain refused: emit asset 1125351814 less than price limit 11976713906 | — | — | — | — | — |  |
| $10M | thorchain | streaming | 0.0308084 | -1 | 9 | 19 | 209 min | 2063 | max parts 2064 |
| $10M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $10M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"f7c5209f-49cf-41ea-8e15-4b903c8f5d18","timestamp":"2026-10-07T23:57:38.558Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $25M | thorchain | single | refused: THORChain refused: emit asset 730684454 less than price limit 29942478537 | — | — | — | — | — |  |
| $25M | thorchain | streaming | 0.0308091 | -1 | 9 | 19 | 519 min | 5160 | max parts 5161 |
| $25M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $25M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"3b8ef463-0315-4a5d-8af5-a5d71b136a5b","timestamp":"2026-10-07T23:57:52.756Z","path":"/v0/quote"} | — | — | — | — | — |  |

## BTC>ETH

| size | provider | plan | output / unit | impact bps | cost vs oracle bps | provider bps | ETA | parts | notes |
|---|---|---|---|---|---|---|---|---|---|
| $100K | thorchain | single | refused: THORChain refused: emit asset 3684768678 less than price limit 3865212450 | — | — | — | — | — |  |
| $100K | thorchain | streaming | 32.2419 | 0 | 58 | 20 | 24 min | 19 | max parts 20 |
| $100K | chainflip | single | 32.3039 | 0 | 39 | — | 17 min | — | rec. slippage 2.5 % |
| $100K | chainflip | dca | 32.3179 | 0 | 35 | — | 18 min | 10 | rec. slippage 2.5 % |
| $100K | near-intents | single | refused: 1Click: no dry-quote refund placeholder for bitcoin | — | — | — | — | — |  |
| $1M | thorchain | single | refused: THORChain refused: emit asset 24595987696 less than price limit 38649485766 | — | — | — | — | — |  |
| $1M | thorchain | streaming | 32.2418 | 0 | 58 | 20 | 40 min | 204 | max parts 205 |
| $1M | chainflip | dca | 32.3147 | 1 | 36 | — | 27 min | 100 | rec. slippage 2.5 % |
| $1M | near-intents | single | refused: 1Click: no dry-quote refund placeholder for bitcoin | — | — | — | — | — |  |
| $2M | thorchain | single | refused: THORChain refused: emit asset 34912304227 less than price limit 77299304779 | — | — | — | — | — |  |
| $2M | thorchain | streaming | 32.2419 | 0 | 58 | 20 | 61 min | 410 | max parts 411 |
| $2M | chainflip | dca | 32.3147 | 1 | 36 | — | 37 min | 200 | rec. slippage 2.5 % |
| $2M | near-intents | single | refused: 1Click: no dry-quote refund placeholder for bitcoin | — | — | — | — | — |  |
| $5M | thorchain | single | refused: THORChain refused: emit asset 44127248727 less than price limit 193248258729 (gateways differ: emit asset 44127248727 less than price limit 193248258729 | emit asset 44127360267 less than price limit 193250793710) | — | — | — | — | — |  |
| $5M | thorchain | streaming | 32.2425 | 0 | 58 | 20 | 123 min | 1028 | max parts 1029 |
| $5M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $5M | near-intents | single | refused: 1Click: no dry-quote refund placeholder for bitcoin | — | — | — | — | — |  |
| $10M | thorchain | single | refused: THORChain refused: emit asset 46400791448 less than price limit 386476966091 | — | — | — | — | — |  |
| $10M | thorchain | streaming | 32.2410 | 0 | 58 | 19 | 226 min | 2058 | max parts 2059 |
| $10M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $10M | near-intents | single | refused: 1Click: no dry-quote refund placeholder for bitcoin | — | — | — | — | — |  |
| $25M | thorchain | single | refused: THORChain refused: emit asset 46413557709 less than price limit 966216442790 | — | — | — | — | — |  |
| $25M | thorchain | streaming | 32.2413 | 0 | 58 | 19 | 535 min | 5147 | max parts 5148 |
| $25M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $25M | near-intents | single | refused: 1Click: no dry-quote refund placeholder for bitcoin | — | — | — | — | — |  |

## ETH>SOL

| size | provider | plan | output / unit | impact bps | cost vs oracle bps | provider bps | ETA | parts | notes |
|---|---|---|---|---|---|---|---|---|---|
| $100K | thorchain | single | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $100K | thorchain | streaming | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $100K | chainflip | single | 22.0984 | 0 | -39 | — | 3 min | — | rec. slippage 2.5 % |
| $100K | chainflip | dca | 22.0993 | 0 | -39 | — | 4 min | 11 | rec. slippage 2.5 % |
| $100K | mayan | single | refused: SWIFT: Mayan SWIFT: an ETH order is taken only as wrap & lock (wrapped 1:1 by the pinned wrapper, refunded as ETH) | — | — | — | — | — |  |
| $100K | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"recipient is not valid","correlationId":"bf0b7801-706e-4cb1-bdb0-8feef76cbecc","timestamp":"2026-10-07T23:59:14.481Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $1M | thorchain | single | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $1M | thorchain | streaming | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $1M | chainflip | dca | 22.0993 | 0 | -39 | — | 13 min | 101 | rec. slippage 2.5 % |
| $1M | mayan | single | refused: SWIFT: Mayan SWIFT: an ETH order is taken only as wrap & lock (wrapped 1:1 by the pinned wrapper, refunded as ETH) | — | — | — | — | — |  |
| $1M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"recipient is not valid","correlationId":"afdf65f8-6c69-4d13-a0df-1813fd672639","timestamp":"2026-10-07T23:59:29.611Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $1M | lifi | single | refused: LI.FI HTTP 422: {"message":"None of the available routes could successfully generate a tx","code":1001} | — | — | — | — | — |  |
| $2M | thorchain | single | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $2M | thorchain | streaming | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $2M | chainflip | dca | 22.0971 | 1 | -38 | — | 23 min | 201 | rec. slippage 2.5 % |
| $2M | mayan | single | 22.0669 | — | -25 | 0 | 1 min | — |  |
| $2M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"recipient is not valid","correlationId":"b6420254-e39e-47c2-b995-75d1548b6318","timestamp":"2026-10-07T23:59:50.261Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $5M | thorchain | single | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $5M | thorchain | streaming | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $5M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $5M | mayan | single | 21.9563 | — | 26 | 0 | 1 min | — |  |
| $5M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"recipient is not valid","correlationId":"bd6b73b9-f8ac-4ce9-b478-5750488a6003","timestamp":"2026-10-08T00:00:06.060Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $5M | lifi | single | refused: LI.FI HTTP 404: {"message":"No available quotes for the requested transfer","code":1002,"errors":{"filteredOut":[{"overallPath":"1:ETH~1:USDC-1:USDC-mayan-1151111081099710:USDC-1151111081099710:USDC~1151111081099710: | — | — | — | — | — |  |
| $10M | thorchain | single | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $10M | thorchain | streaming | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $10M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $10M | mayan | single | 21.7575 | — | 116 | 0 | 1 min | — |  |
| $10M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"recipient is not valid","correlationId":"f190af79-6329-4519-857a-cc8f6c975c88","timestamp":"2026-10-08T00:00:25.564Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $25M | thorchain | single | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $25M | thorchain | streaming | refused: THORChain refused: trading is halted, can't process swap | — | — | — | — | — |  |
| $25M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $25M | mayan | single | refused: Mayan quote: HTTP 406 {"code":"BRIDGE_LIMIT_EXCEEDED","msg":"CCTPv2 does not have enough capacity for this amount. Max per swap: 10000000"} | — | — | — | — | — |  |
| $25M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"recipient is not valid","correlationId":"c3f7077b-dffb-4c1b-8784-1122d662abeb","timestamp":"2026-10-08T00:00:40.887Z","path":"/v0/quote"} | — | — | — | — | — |  |

## ETH>USDC(Base)

| size | provider | plan | output / unit | impact bps | cost vs oracle bps | provider bps | ETA | parts | notes |
|---|---|---|---|---|---|---|---|---|---|
| $100K | thorchain | single | refused: THORChain refused: emit asset 798030420700 less than price limit 9947444370957 (gateways differ: emit asset 798030420700 less than price limit 9947444370957 | emit asset 797938112700 less than price limit 9943454868707) | — | — | — | — | — |  |
| $100K | thorchain | streaming | 2558.57 | 0 | 39 | 20 | 260 min | 2569 | max parts 2570 |
| $100K | mayan | single | refused: SWIFT: Mayan SWIFT: an ETH order is taken only as wrap & lock (wrapped 1:1 by the pinned wrapper, refunded as ETH) | — | — | — | — | — |  |
| $100K | near-intents | single | 2563.12 | 0 | 21 | — | 1 min | — |  |
| $100K | uniswap-across | single | refused: Across swap: swaps ETH into 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 before bridging; an unfilled deposit would come back to the escrow in that token, which it cannot re-shield (the pool has no vault for it) | — | — | — | — | — |  |
| $1M | thorchain | single | refused: THORChain refused: emit asset 197196313600 less than price limit 99484782107024 | — | — | — | — | — |  |
| $1M | thorchain | streaming | 2555.85 | 11 | 49 | 27 | 1443 min | 14399 | max parts 14400 |
| $1M | mayan | single | refused: SWIFT: Mayan SWIFT: an ETH order is taken only as wrap & lock (wrapped 1:1 by the pinned wrapper, refunded as ETH) | — | — | — | — | — |  |
| $1M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"e428c350-567c-4ee8-9528-4d93d179c93c","timestamp":"2026-10-08T00:01:11.798Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $1M | uniswap-across | single | refused: Across swap/approval: HTTP 400 {"type":"AcrossApiError","code":"INVALID_PARAM","status":400,"message":"Relayer Address (0x00000000000000000000000007ae8551be970cb1cca11dd7a11f47ae82e70e67) doesn't have enough funds to sup | — | — | — | — | — |  |
| $1M | lifi | single | refused: LI.FI routed ETH through a swap into 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 before bridging (mayan): an unfilled deposit or the swap surplus would come back to the escrow in that token, which it cannot re-shield (the | — | — | — | — | — |  |
| $2M | thorchain | single | refused: THORChain refused: emit asset 139774198800 less than price limit 199060478169799 (gateways differ: emit asset 139774198800 less than price limit 199060478169799 | emit asset 139680495100 less than price limit 19917991696 | — | — | — | — | — |  |
| $2M | thorchain | streaming | 2549.40 | 36 | 75 | 45 | 1443 min | 14399 | max parts 14400 |
| $2M | mayan | single | 2566.29 | — | 9 | 0 | 1 min | — |  |
| $2M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"092cd370-33c6-4239-bd05-cc0232086b2a","timestamp":"2026-10-08T00:01:34.406Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $2M | uniswap-across | single | refused: Across swap/approval: HTTP 400 {"type":"AcrossApiError","code":"INVALID_PARAM","status":400,"message":"Relayer Address (0x00000000000000000000000007ae8551be970cb1cca11dd7a11f47ae82e70e67) doesn't have enough funds to sup | — | — | — | — | — |  |
| $5M | thorchain | single | refused: THORChain refused: emit asset 117094634500 less than price limit 498539705305822 | — | — | — | — | — |  |
| $5M | thorchain | streaming | 2525.22 | 130 | 169 | 100 | 1443 min | 14399 | max parts 14400 |
| $5M | mayan | single | 2563.27 | — | 20 | 0 | 1 min | — |  |
| $5M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"bb62707a-2bf1-422d-9688-4683f73bcc8b","timestamp":"2026-10-08T00:01:54.372Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $5M | uniswap-across | single | refused: Across swap/approval: HTTP 400 {"type":"AcrossApiError","code":"INVALID_PARAM","status":400,"message":"Relayer Address (0x00000000000000000000000007ae8551be970cb1cca11dd7a11f47ae82e70e67) doesn't have enough funds to sup | — | — | — | — | — |  |
| $10M | thorchain | single | refused: THORChain refused: emit asset 132031406600 less than price limit 996689184039293 | — | — | — | — | — |  |
| $10M | thorchain | streaming | 2479.89 | 308 | 345 | 191 | 1443 min | 14399 | max parts 14400 |
| $10M | mayan | single | 2556.93 | — | 45 | 0 | 1 min | — |  |
| $10M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"73b9ba09-1d58-43ef-bca4-3c21acf2aee6","timestamp":"2026-10-08T00:02:13.519Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $10M | uniswap-across | single | refused: Across swap/approval: HTTP 400 {"type":"AcrossApiError","code":"INVALID_PARAM","status":400,"message":"Relayer Address (0x00000000000000000000000007ae8551be970cb1cca11dd7a11f47ae82e70e67) doesn't have enough funds to sup | — | — | — | — | — |  |
| $25M | thorchain | single | refused: THORChain refused: emit asset 204611683700 less than price limit 2488720229193109 | — | — | — | — | — |  |
| $25M | thorchain | streaming | 2350.08 | 815 | 851 | 473 | 1443 min | 14399 | max parts 14400 |
| $25M | mayan | single | refused: Mayan quote: HTTP 406 {"code":"BRIDGE_LIMIT_EXCEEDED","msg":"CCTPv2 does not have enough capacity for this amount. Max per swap: 10000000"} | — | — | — | — | — |  |
| $25M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"4a87b2b9-4657-48c7-976b-758941cb4505","timestamp":"2026-10-08T00:02:32.346Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $25M | uniswap-across | single | refused: Across swap/approval: HTTP 400 {"type":"AcrossApiError","code":"INVALID_PARAM","status":400,"message":"Relayer Address (0x00000000000000000000000007ae8551be970cb1cca11dd7a11f47ae82e70e67) doesn't have enough funds to sup | — | — | — | — | — |  |

## USDC>BTC

| size | provider | plan | output / unit | impact bps | cost vs oracle bps | provider bps | ETA | parts | notes |
|---|---|---|---|---|---|---|---|---|---|
| $100K | thorchain | single | refused: THORChain refused: emit asset 109549243 less than price limit 119473465 | — | — | — | — | — |  |
| $100K | thorchain | streaming | 0.0000119653 | 0 | 33 | 20 | 17 min | 39 | max parts 40 |
| $100K | chainflip | single | 0.0000119996 | 0 | 5 | — | 8 min | — | rec. slippage 2.5 % |
| $100K | chainflip | dca | 0.0000119996 | 0 | 5 | — | 9 min | 10 | rec. slippage 2.5 % |
| $100K | near-intents | single | 0.0000119817 | 0 | 20 | — | 8 min | — |  |
| $1M | thorchain | single | refused: THORChain refused: emit asset 568272232 less than price limit 1194494347 | — | — | — | — | — |  |
| $1M | thorchain | streaming | 0.0000119645 | 1 | 34 | 20 | 44 min | 407 | max parts 408 |
| $1M | chainflip | dca | 0.0000119996 | 0 | 5 | — | 18 min | 100 | rec. slippage 2.5 % |
| $1M | near-intents | single | 0.0000119798 | 2 | 21 | — | 8 min | — |  |
| $2M | thorchain | single | refused: THORChain refused: emit asset 674328244 less than price limit 2388494716 | — | — | — | — | — |  |
| $2M | thorchain | streaming | 0.0000119620 | 3 | 36 | 19 | 84 min | 816 | max parts 817 |
| $2M | chainflip | dca | 0.0000120008 | -1 | 4 | — | 28 min | 200 | rec. slippage 2.5 % |
| $2M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"46940fab-5f9d-4490-a853-0697188e14d8","timestamp":"2026-10-08T00:03:13.845Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $5M | thorchain | single | refused: THORChain refused: emit asset 605973908 less than price limit 5971250017 | — | — | — | — | — |  |
| $5M | thorchain | streaming | 0.0000119635 | 1 | 35 | 19 | 207 min | 2042 | max parts 2043 |
| $5M | chainflip | dca | 0.0000120008 | -1 | 4 | — | 58 min | 500 | rec. slippage 2.5 % |
| $5M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"4580b1a5-e4f1-4cb3-95d8-96f6df1f0eb8","timestamp":"2026-10-08T00:03:28.066Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $10M | thorchain | single | refused: THORChain refused: emit asset 442056336 less than price limit 11942584470 (gateways differ: emit asset 442056336 less than price limit 11942584470 | emit asset 442058757 less than price limit 11942918369) | — | — | — | — | — |  |
| $10M | thorchain | streaming | 0.0000119625 | 2 | 36 | 19 | 411 min | 4085 | max parts 4086 |
| $10M | chainflip | dca | 0.0000120008 | -1 | 4 | — | 108 min | 1000 | rec. slippage 2.5 % |
| $10M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"e1bf0f3e-af74-4c81-94c0-08022cb67269","timestamp":"2026-10-08T00:03:42.230Z","path":"/v0/quote"} | — | — | — | — | — |  |
| $25M | thorchain | single | refused: THORChain refused: emit asset 232616561 less than price limit 29856307234 | — | — | — | — | — |  |
| $25M | thorchain | streaming | 0.0000119621 | 3 | 36 | 19 | 1024 min | 10216 | max parts 10217 |
| $25M | chainflip | single | refused: HTTP 400 {"message":"insufficient liquidity for the requested amount"} | — | — | — | — | — |  |
| $25M | near-intents | single | refused: 1Click quote: HTTP 400 {"message":"No liquidity available","correlationId":"cca227cb-c694-45af-8bee-a4b6fbe24c9a","timestamp":"2026-10-08T00:03:56.532Z","path":"/v0/quote"} | — | — | — | — | — |  |

## ETH>ETH(Base)

| size | provider | plan | output / unit | impact bps | cost vs oracle bps | provider bps | ETA | parts | notes |
|---|---|---|---|---|---|---|---|---|---|
| $100K | uniswap-across | single | 0.999925 | 0 | 1 | — | 1 min | — | minDeposit 194284160012434, maxDeposit 1053605542412261336736, maxDepositInstant 180044495771848399853 |
| $1M | uniswap-across | single | 0.999925 | 0 | 1 | — | 15 min | — | minDeposit 194284160012434, maxDeposit 1053605542412261336736, maxDepositInstant 180044495771848399853 |
| $2M | uniswap-across | single | 0.999925 | 0 | 1 | — | 15 min | — | minDeposit 194284160012434, maxDeposit 1053605542412261336736, maxDepositInstant 180044495771848399853 |
| $5M | uniswap-across | single | refused: Across suggested-fees: HTTP 400 {"type":"AcrossApiError","code":"AMOUNT_TOO_HIGH","status":400,"message":"Amount is higher than available liquidity. Max amount is 1053.605542412261336736 WETH.","id":"6frf8-1791417844515- | — | — | — | — | — |  |
| $10M | uniswap-across | single | refused: Across suggested-fees: HTTP 400 {"type":"AcrossApiError","code":"AMOUNT_TOO_HIGH","status":400,"message":"Amount is higher than available liquidity. Max amount is 1053.605542412261336736 WETH.","id":"tgk4h-1791417846357- | — | — | — | — | — |  |
| $25M | uniswap-across | single | refused: Across suggested-fees: HTTP 400 {"type":"AcrossApiError","code":"AMOUNT_TOO_HIGH","status":400,"message":"Amount is higher than available liquidity. Max amount is 1053.605542412261336736 WETH.","id":"wkthv-1791417848245- | — | — | — | — | — |  |
