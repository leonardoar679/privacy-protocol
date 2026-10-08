# Whale labs (plan V2 §118–§120)

Read-only measurements behind the whale-execution spec (`docs/whale-execution-spec-v1.0.md` §2, §4,
§12, §13). Nothing here sends, signs or funds anything.

```
node research.mjs                       # §118: public swap history (THORChain Midgard, Mayan, Across) → research.json, whale-research.md
node run-execution.mjs                  # §119: live quotes at $100K…$25M per pair and provider, single vs streamed → execution.json, execution.md
node run-execution.mjs --pairs ETH>BTC --sizes 1000000,5000000 --pause 2000
node ../privacy/run-crosschain.mjs      # §120: the cross-chain observer lab, now with the streamed-settlement rows (crosschain.json)
npx tsx src/sim/whaleUtxoLab.ts         # §120 / §74: in reference/typescript — a whale's withdrawal as one piece vs K bucketed pieces
```

- `research.mjs` reads the last swap actions from Midgard (sizes in USD, the share that streamed, the
  streaming parameters of the largest, slippage), 30 days of daily volume, and records Mayan's and
  Across's public endpoints as they answer. Public data only; a label is a service or a contract as
  often as a person.
- `run-execution.mjs` quotes every adapter that serves a pair at every size exactly as the engine
  would (spec §5 placeholder destinations), plus THORChain's streaming quote (interval 1, quantity 0)
  and Chainflip's DCA quote fetched directly. Sizes come from Chainlink's mainnet feeds through public
  RPCs (the spec §13 table, verified by `description()` on the way). LI.FI gets three calls in all
  (its anonymous limit answers 429 for two hours). Refusals are rows: above its depth Chainflip answers
  400 "insufficient liquidity"; THORChain quotes any size but streams it.
- The lab-calibrated constants (`STREAM_GAIN_BPS`, `IMPACT_CAP_BPS`, `STREAM_MAX_SECONDS`, the tier
  engine rules) are set from `execution.md`; the privacy constants from the two simulators.
