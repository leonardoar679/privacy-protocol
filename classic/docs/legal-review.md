# Tornado Classic — the legal review record

**Status:** not started. The owner's item (decision 9 of 2026-10-26: live deposits and withdrawals only after the legal
review is recorded **and** the per-pool technical gates pass; the original interface's sanctions-oracle check and
geofence implemented behind switches, off by default). This file is the record the release gate reads
(`release-gate.md`, the Legal column): until it is filled in — the table and the block under it — every build keeps every
pool function off.

This document does not assess legality and the engineering pass made no legal determination. It lists what the review
has to answer and where its answers take effect.

## What the review decides

| Question | Where it takes effect |
|---|---|
| Whether the interface may be offered at all, and where (regions, residency, the hosting origin) | `VITE_CLASSIC_LIVE` per pool and function; the host's geofence (`VITE_CLASSIC_GEOFENCE`: the host answers 451 at `/classic/geo` for a blocked region, the app shows the notice and nothing else) |
| Whether the connected account must be screened | `VITE_CLASSIC_COMPLIANCE_ORACLE`: Chainalysis' sanctions oracle (`0x40c57923924b5c5c5455c48d93317139addac8fb`) asked at connect, as the original did; a listed account is disconnected with the notice |
| Which relayers may be listed, and what the interface's relationship to them is | `classic/relayers.json` (the curated list from the registry); the IP notice under the relayer choice |
| The words: the statistics labels ("Anonymity set"), the disclosures, the notices, the Korean catalog | `classic/src/app/i18n/{en,ko}.ts` under the word policy (`classic/scripts/words.mjs`) |
| Whether the original's donation address may be offered | `VITE_CLASSIC_DONATION_ADDRESS` (none hides the button) |
| Record-keeping: the interface keeps no note, no account, no IP, no log; what, if anything, the review requires | `classic/docs/security-review.md` §2; nothing is collected today |
| Recipient screening: the application refuses a withdrawal to the zero address, a burn address or the pools' own contracts — funds lost or stuck, not a compliance rule (the fourth review round, 2026-11-03); no sanctions screening of recipients exists (the oracle switch, off by default, screens the connecting account) | whether the review requires more than the switch |

## The record

| Field | Entry |
|---|---|
| Reviewer (name, qualification, jurisdiction) | — |
| Date concluded | — |
| Scope (pools, functions, regions, relayers, wording) | — |
| Outcome | — |
| Conditions (switches, wording changes, regions, screening) | — |
| Compliance switches decided | `VITE_CLASSIC_COMPLIANCE_ORACLE`: — · `VITE_CLASSIC_GEOFENCE`: — |
| Pool functions cleared | — |
| Owner's sign-off | — |

A filled-in record is committed with the build hash it applies to; `release-gate.md` and `docs/roadmap.md` cite it.

The build reads the block below and holds the table to it (the eleventh review round, 2026-11-04): `outcome` is one of none, cleared,
refused; `cleared` lists exact `pool:function` pairs (pools eth-0.1, eth-1, eth-10, eth-100; functions deposit, withdraw), separated by
spaces. A block that clears pool functions needs the table's reviewer, date, outcome (beginning "Cleared"), pool functions cleared (the
same pairs) and owner's sign-off filled in: the block sits in an HTML comment, which the rendered page does not show.

<!-- classic-live-gate
outcome: none
cleared:
-->

The build reads this record (the tenth review round, 2026-11-04: `classic/scripts/live-gate.mjs`, called by `vite.config.ts`; its block since
the eleventh): any build whose `VITE_CLASSIC_LIVE` switches a pool function on is refused unless the block's `outcome` is `cleared`, its
`cleared` line lists every switched-on function as `pool:function` (for example `eth-1:withdraw eth-10:withdraw`), and the table above
says the same.
