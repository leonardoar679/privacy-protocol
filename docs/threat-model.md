# Threat Model — V1

Adversary ladder A1–A12 (from `research/12-new-protocol/threat-model.md`). V1's key win is a
**smaller trusted computing base**: by choosing Ethereum L1 + an immutable, asset-free core, two of
Tornado Nova's worst adversaries are removed from scope entirely (§114).

| # | Adversary | V1 status / defense |
|---|-----------|----------------------|
| A1 | Blockchain observer | ZK at L2 + minimal events (`NoteInserted`, `ShieldedTransaction`); amount/timing hardening in the wallet |
| A2 | RPC provider | wallet should use a light client / private RPC (L4); live "RPC exposure" indicator |
| A3 | Honest-but-curious relayer | shielded fee note; recipient is in the proof, not disclosed to the relayer (L3) |
| A4 | Malicious relayer | proof-bound recipient/amount/vault — a relayer can't redirect or over-charge (tests in `adversarial/`) |
| A5–A7 | MEV searcher / builder / validator | private submission (L3) denies the pre-inclusion signal |
| A8 | Malicious frontend | frontend-independent client; raw secret never persisted (TC-01 guard in `frontend/src/keys`) |
| A9 | Compromised device | OS/hardware keystore for keys (wallet responsibility) |
| **A10** | **Governance** | **REMOVED from the core TCB** — the core is immutable; no owner/upgrade/pause (fixes TC-02) |
| **A11** | **Bridge** | **REMOVED from V1** — Ethereum L1 only; no AMB/omnibridge (fixes TC-03/12/18) |
| A12 | Network observer | mixnet/Tor transport for RPC + submission (wallet) |

## What V1 still trusts
Ethereum consensus, the ZK assumptions + the (one-time, public) trusted setup if Groth16 is chosen
(TC-09), one audited Poseidon2 instance (spec §2, pinned by the nargo vectors in four independent
implementations), and — per asset — that token's issuer. Issuer risk is **isolated**
to that asset's vault (see `vault-spec.md`); it is disclosed, not eliminated (§39, §67).

## Explicitly NOT trusted
Protocol admin, governance, bridge validators, any official relayer, any official frontend, a single
RPC, or a single company. The same immutable contracts are usable from any client (direct fix for
TC-01's "mutable frontend = full break").
