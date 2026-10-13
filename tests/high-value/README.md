# tests/high-value — the plan's §116 tree

The High-Value Execution Engine plan (§116–§118) asks for one test tree per concern. Each file names the invariants of
the plan's §113 (high-value), §114 (privacy) and §115 (security) it pins — the contract's §5 lists which test executes
which. Everything here runs on the pure modules (`packages/protocol/src/wallet/*`, the service's engine and risk layer,
`packages/protocol/src/sim/campaignLab.ts`) with no browser and no network; the wallet's runner and screens are
pinned by `apps/web/test/campaign-*.test.tsx`, the live providers by `packages/swap-engine/test/*-live.test.ts`.

```
node node_modules/vitest/vitest.mjs run --root tests/high-value      # from the repository root (scripts/verify-all.mjs runs it)
```

| directory | what it pins |
|---|---|
| `order/` | the execution bounds (plan §9–§16): I-HV 3–8 — the minimum never relaxed, the fee never exceeded, the destination / chain / asset fixed after signing, an expired quote never executed |
| `quote/` | the quote lifecycle and normalization (plan §11–§12, §41–§43): the presets' weights, the policy from the mode, PAES, the eight normalized fields, the execution window |
| `exposure/` | the ledger (plan §25–§27, §65–§68): I-HV 1, 2, 10, 11 on the plan's own examples; `property.test.ts` is the plan's §117 property test — 1,000 random campaigns and event sequences, `inFlight ≤ cap` and `providerExposure ≤ limit` after every step |
| `tranche/` | the splitter (plan §22–§24): pieces in band and under the cap, common sizes, no identical consecutive pieces under varied sizing (I-P 4) |
| `rfq/` | the controlled-RFQ interface (plan §10–§12, §40): the R1 exposure tier for a signed hard quote, the hard-quote expiry rules, UniswapX as a deferred interface |
| `streaming/` | the streaming distinction (plan §3, §35): a tranche executed as a stream of parts is one exposure; the R2 tier; the step time scales with the piece |
| `routing/` | eligibility, the breaker and concentration (plan §44–§47): the filters, three failures open the breaker, 30 % per provider when venues compete, a single venue disclosed |
| `settlement/` | the states (plan §69–§70): the §70 names on the tranche machine, the order machine's legal transitions, the gate per class, the finality margins, never "atomic" in a user status |
| `recovery/` | the rules (plan §31–§33, §71–§72, §109–§111): I-HV 9 — an unknown state never auto-retries, reconcile before anything is sent, the crash resumed from the journal |
| `provider-failure/` | the scenarios (plan §105–§108): a provider incident pauses the affected routes (I-HV 12), the breaker routes around THORChain, the issuer failure stays inside its vault (R7), quote manipulation is refused by the bounds |
| `privacy/` | the assessment (plan §48–§54, §112, §114): I-P 1–7 measured, the equal-pieces-on-a-clock pattern flagged |
| `mobile/` | the journal (plan §73, §109–§110): the campaign round-trips as JSON, the reducer continues from the journaled state, an unreadable state keeps its exposure |
| `adversarial/` | chaos (plan §118): random faults at random steps across sizes and modes — every invariant held, each step funded and handed over once, the same seed gives the same run |
| `policy/` | the consumer bands (Privacy Wallet Web spec §11, V5): the ladder monotone with `large` / `large-protected` below `enhanced`, the $50K band's cap of a quarter unmoved by the exposure tier and the mode, four exact sequential quarters from the planner, the enhanced row unchanged |
