# zkAPI Integration Specification V1.1

Normative. How the Privacy Wallet uses zkAPI (`ethereum/zkapi`, mainnet vault `0x4386FDbd…81fe`)
as **service credit** for metered APIs — and the hard boundary between that and the money core
(plan V1.1 §2–§12, §52–§56, §61–§65, §73, §75, Rule 1 and Rule 11). Facts about zkAPI are from
[`zkapi/architecture.md`](zkapi/architecture.md), [`zkapi/protocol.md`](zkapi/protocol.md),
[`zkapi/security.md`](zkapi/security.md) and the executed [`zkapi/mainnet-verification.md`](zkapi/mainnet-verification.md).

## 1. Separation (Rule 1, Rule 11)
```
OUR PRIVATE POOL (PrivacyCore + vaults)      zkAPI (service credit)
  money; notes never expire; no operator       credit; notes expire (30 d); operator-run server,
  proof + immutable state + nullifier          server-signed state, pause/treasury, single-party setup
            │                                            ▲
            └── private withdrawal → fresh address ── deposit(C, gwei) ──┘   (§6, V1.x; not V1.1)
```
- `PrivacyCore` MUST NOT reference, call, trust or be configured by anything zkAPI (verified: no
  such import exists; `NoPrivilege.t.sol`).
- zkAPI failure (server down, keys withheld, pause) MUST degrade only the *services* features
  (plan §56); the wallet's private balance stays fully usable.
- Nothing from zkAPI's design listed in [`zkapi/security.md`](zkapi/security.md) "must not reach the
  core" may be introduced into `contracts/src/core`, `vault`, `factory` or the circuit.

## 2. Mode (plan §5)
- **Runtime-key mode only.** The wallet obtains a lease (`POST /v2/openrouter/leases`) and calls the
  provider directly with the issued key. This is the only active mode in zkAPI v2.
- **Proxy mode is disabled** and MUST NOT be offered by default. If a future zkAPI version adds a relay
  path, it is exposed only behind an explicit "the relay sees your traffic" warning.

## 3. Deployment-pin check before first use (plan §62) — MUST pass, every session
The wallet runs the same checks as `services/zkapi-lab/verify-mainnet.mjs` against its pinned copy of
`sdk/assets/config/<network>.json`: chain id; vault immutables (`stateSigningKey`,
`clearanceSigningKey`, `requestChargeCap`, `PROTOCOL_VERSION`, `MERKLE_DEPTH`, `billingToken == 0`);
`proofAdapter()`; sha256 of the packaged `request.pk`/`withdrawal.pk` and WASM; the live manifest
(`deployment_id`, keys, cap, feed, asset, `proof_setup`); Chainlink feed identity and freshness.
Any mismatch → zkAPI features disabled with a "deployment changed" notice; never a silent fallback
(plan §87). The wallet pins `deployment_manifest_url` and its allow-list; it MUST NOT follow redirects
to other hosts.

*Implemented:* `frontend/scripts/check-zkapi-pins.mjs` (runs at build: emitted config == pinned
profile, allow-listed manifest URL, https only, OA key source, circuit, emitted key/WASM hashes ==
pins, then `verify-mainnet.mjs` with zero failures) writes `public/zkapi/pin-check.json`; the tab
enables zkAPI only when it reports zero failures and is under a week old (`zkapiEnabled`).

## 4. Credit lifecycle in the wallet
| Step | Wallet action | Source of truth |
|---|---|---|
| fund | deposit native ETH from a **fresh wallet-derived address** (never the permanent address), amount in whole gwei, bucketed like a pool shield (§6 of the swap spec) — *implemented:* `frontend/src/zkapi/freshAccountProvider.ts` (EIP-1193 over a seed-derived key #i; a new index per note) + credit buckets 0.005 / 0.01 / 0.02 ETH | `ZkApiVault.deposit` |
| keep | note secret, blinding, signed state `(E(B), τ, σ)` and the recovery journal in the wallet's encrypted store — same rule as pool notes (TC-01: never dapp-origin storage, never a server) | SDK wallet |
| spend | quote → proof → lease → provider call → retire; the SDK's exact-retry journal is kept | server + SDK |
| cap | per-session USD budget ≤ `request_charge_cap` × N requests chosen by the user; per-note deposit SHOULD stay small (expiring credit): default ≤ 0.02 ETH, high-privacy ≤ 0.005 ETH per note | wallet policy |
| expiry | the wallet warns at T_exp − 7 d and − 1 d and offers mutual close; credit that would expire unused is withdrawn, never forfeited silently | vault `noteTtl` |
| close | mutual close by default; escape hatch after a server timeout of 10 min; destination = a fresh address or (§6) a pool re-shield | vault |

## 5. Transport (plan §7)
Every zkAPI and provider request from the wallet MUST go through the private transport layer when
the user is in standard or high privacy: Tor (fresh circuit per session and per lease), or the
configured mixnet/private relay. The SDK's `transport` option is the injection point
(`configureBrowserSdk({ transport })`). Plain network access is allowed only in the explicit
"custom" mode with a warning. IP exposure to the gateway is the limitation zkAPI itself documents.
*Implemented as a policy hook:* `frontend/src/zkapi/sdk.ts::privateTransport` (no proxy hint honoured,
`credentials: "omit"`, `redirect: "error"`); Tor / mixnet is a native-host concern, not done in the web build.

## 6. Pool → service credit (plan §55) — built in the wallet (Private AI tab: "Fund the fresh address from the pool" → "Deposit as credit")
A private withdrawal from our pool to a fresh address, followed by a zkAPI deposit from that address,
makes the credit note unlinkable to the user's public identity and to their pool history. It is an
ordinary `transact(WITHDRAW)` plus an ordinary `ZkApiVault.deposit`; no contract couples the two.
The amount SHOULD be a bucket and the timing SHOULD use the privacy budget of the swap spec §8.

## 7. Security tests (plan §73) the wallet integration MUST pass
wrong proof · wrong request ID · modified payload · changed quote · replayed nullifier · expired
capability · over-cap request · server key mismatch · deployment mismatch · stale root · provider
usage mismatch · settlement mismatch → in every case no credit is consumed without a valid, exact
authorization, and the wallet's journal recovers to a consistent state. Reference: zkAPI's own
`npm run test:e2e:v2` (real contracts, server, indexer, challenger, proofs; mocked provider/oracle)
and the 309 SDK tests; our integration tests wrap the SDK against that local stack.

## 8. Compromise model (plan §75)
A malicious or compromised zkAPI server/operator can: refuse service, withhold clearance (escape
hatch → 24 h), over-charge up to `request_charge_cap` per request, pause the vault and — after the
30-day TTL — collect expired notes. It cannot: touch `PrivacyCore`, any vault, our verifier or our
notes; learn which pool user holds which credit; forge withdrawals without the single-party setup
secrets. Our caps (§4) bound the exposure to the small, expiring credit the user chose to hold.

## 9. What we borrow into OUR service layer (plan §9) — and where
request-ID + payload-hash binding and frozen quotes → `services/private-swap` order object and the
quote gateway (§52 of the plan); short-lived capped capabilities → zkAPI leases as-is; actual-usage
settlement and durable recovery journal → the swap engine's journal; deployment pins checked before
use → §3 above and `verify-mainnet.mjs`.
