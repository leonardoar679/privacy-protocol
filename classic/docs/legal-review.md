# Tornado Classic — the legal review record

**Status:** not started. The owner's item (decision 9 of 2026-10-26: live deposits and withdrawals only after the legal
review is recorded **and** the per-pool technical gates pass; the original interface's sanctions-oracle check and
geofence implemented behind switches, off by default). This file is the record the release gate reads
(`release-gate.md`, the Legal column): until it is filled in, every build keeps every pool function off.

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
