# Private AI — plan step 04 (§4, §5, §12, §63), built on zkAPI as service credit

Status (2026-10-06): **integrated and verified up to the funded flow.** The wallet's "Private AI" tab
runs the zkAPI browser SDK in runtime-key mode against the pinned Sepolia (or mainnet) deployment:
the SDK assets are built and hash-verified here, the deployment-pin check (`docs/zkapi-integration-spec.md`
§3) passes against chain and the live manifest, and the frontend builds. What could not run on this
machine: a browser session with testnet ETH (no browser, no funds, and the Sepolia server needs its
shared testnet password) — that is the first thing to do on a workstation.

## What the user sees (plan §4)
Model · Ask anything · Send · **Private balance** — plus two things the plan's mock-up does not show
and the spec requires: the deployment-pin status ("checked at build: N checks + lab 23 ✔") and the
funding-address choice, defaulting to a **fresh wallet-derived address** funded from the pool.

## What happens underneath (plan §4, §5, §12)
```
wallet tab ──(1) private withdrawal, bucket + fee reserve──▶ fresh funding address (derived from the seed, index i)
          ──(2) ZkApiVault.deposit from that address (SDK, signed by the local key)──▶ private credit note (gwei, expires in 30 d)
          ──(3) acquireInferenceAccess(session, cap $tier): proof → lease → short-lived OpenRouter key (OA org key)
          ──(4) chat/completions straight to openrouter.ai with that key; stream back; release() → settlement of actual usage
          ──(5) withdraw("mutual", destination = the fresh address) before expiry; next note → index i+1
```
- **Runtime-key mode only.** The SDK's `transport` is `privateTransport` (`frontend/src/zkapi/sdk.ts`):
  it refuses the `preferProxy` hint, sends with `credentials: "omit"` and `redirect: "error"`. The
  billing server sees proofs and leases; the provider sees the prompt and a key tied to OA's org
  (`require_oa_key_source: true`), never the funding address. Proxy mode does not exist in this wallet.
- **Fresh funding address (spec §4, §6).** `frontend/src/zkapi/freshAccountProvider.ts` derives key
  #i from the master seed (`keccak(seed ‖ "/zkapi/funding/i")`) and exposes it to the SDK as an
  EIP-1193 provider: accounts/chain, `eth_sendTransaction` signed locally with viem, every read
  forwarded to the pinned RPC. The pool funds it with an ordinary private withdrawal
  (`privateWithdrawal`, proved in the wallet's own worker) of a credit bucket (0.005 / 0.01 / 0.02 ETH,
  spec §4 caps) plus a 0.0005 ETH fee reserve. No contract couples the pool and zkAPI (plan §55).
  The "connected wallet" option exists but is labelled as not private.
- **Spending cap per session**: `CHAT_SPENDING_TIER_USD` (1 / 2 / 3 / 4.5 / 6 USD); only actual
  usage is charged; the quote (Chainlink round) is frozen into the lease.
- **Credit expires, money does not** (plan §11): the tab says so and offers mutual-close withdrawal.

## Build and verify (what ran here)
```
cd frontend
ZKAPI_NETWORK=sepolia npm run zkapi:assets   # buildBrowserSdkAssets → public/zkapi (config, worker, wasm, 2 proving keys; hashes verified by the helper)
ZKAPI_NETWORK=sepolia npm run zkapi:pins     # spec §3: 12 local checks + services/zkapi-lab/verify-mainnet.mjs (23 chain/manifest/bytecode/key/feed checks) → public/zkapi/pin-check.json
npm run build                                # tsc -b + vite build (522 modules; the SDK is bundled, its worker/wasm/keys stay static)
npm run dev                                  # /zkapi-deployment/* is proxied to the pinned protocol server of ZKAPI_NETWORK
```
Results on 2026-10-06 (Sepolia): assets emitted with the pinned hashes (`request.pk c894b261…`,
`withdrawal.pk 8e41398…`, wasm `1fc6a862…`); pin check **12 pass + lab 23 pass, 0 fail**; mainnet
and Sepolia `/health`, `/v2/billing/quote` and `/config.json` reachable and consistent with the pins;
OpenRouter's public catalog lists 465 models. The wallet enables zkAPI only when `pin-check.json`
reports zero failures and is less than a week old (`zkapiEnabled`), never silently (plan §87).

The SDK is the pinned sibling clone (`E:\Code\Tornado\zkapi`, commit `045b444`, LF checkout) as a
`file:` dependency; its 309 tests and the reproduction log are in `docs/zkapi/reproduction.md`.
`frontend/public/zkapi/` is generated (gitignored).

## Offline tests of the wallet's glue (`cd frontend && npm test`, 17 vitest, node)
| Suite | What it proves without a browser or funds |
|---|---|
| `test/zkapi-policy.test.ts` | the transport refuses the proxy hint, sends `credentials: omit` + `redirect: error`; the pin gate enables only a clean (local + lab), recent, sane check; the provider SSE stream is parsed across chunks and stops at `[DONE]`; `chatStream` hits `<lease base>/chat/completions` with the lease headers and surfaces non-2xx |
| `test/fresh-provider.test.ts` | the fresh funding key is deterministic per index and distinct across indexes; the EIP-1193 shim answers accounts/chain from the key, **signs locally** (the raw transaction broadcast to a local mock JSON-RPC server recovers to the fresh address: to / value / data / nonce / chain id checked), forwards reads, refuses other senders and message signing |
| `test/chain-sync.test.ts` | the tree rebuilt from `NoteInserted` events equals the reference `MerkleTree` (groups of four, zero padding) and a wrong on-chain root is refused; `txDomain` binds chain + core like the reference |
| `test/private-tx-plan.test.ts` | withdrawal planning: one or two notes, change back to us, dummies owned by nobody, payload hashes and domain bound, and the reference witness builder accepts the result; a note the store misreports is caught before proving |

## Security tests (spec §7 / plan §73) — where they live
The SDK's own suites cover wrong proof / request id / payload / quote / replayed nullifier / expired
capability / over-cap / key mismatch / deployment mismatch / stale root / usage and settlement
mismatch (`npm run test:sdk`, 309 here; `test:e2e:v2` needs the Rust services, which this machine's
Winsock LSP blocks). What this wallet adds and tests here: the pin check fails closed (any mismatch
disables the tab), the transport refuses proxying, and the fresh-address provider never signs
anything but a transaction for its own address. Still owed: an integration test that drives the SDK
against zkAPI's local stack on a clean machine.

## Open points
- A browser run with Sepolia ETH. The Sepolia server's shared password dialog is wired
  (`requestTestnetPassword` → an in-tab form that stays open on rejection, resolves after the
  SDK validated it, rejects on dismissal; never stored or logged).
- Private transport (Tor / mixnet) is a hook, not an implementation, in a web wallet (spec §5).
- Expiry warnings at T−7 d / T−1 d (spec §4) are shown as text, not scheduled.
- Shielding withdrawn credit back into the pool from the fresh address needs the local-key signer on
  the Shield screen (today Shield uses the injected wallet).

## Step 05 — Private RPC (plan §64): blocked upstream, partially covered
The live zkAPI deployments lease **OpenRouter keys only** (`upstreams: ["openrouter"]`,
`request_mode: direct_openrouter` in the manifest and SDK); there is no metered RPC upstream to
authorize. What the wallet does today (`frontend/src/sdk/chain.ts::clientFor`): no permanent API key anywhere
(public RPC URL from env), JSON-RPC **batching** (a tree sync is a handful of round trips), no
cookies and no cross-host redirects on the RPC transport, and the same `privateTransport` policy
hook. The pool reads are also checked by the wallet's own light client on mainnet and Sepolia
(`frontend/src/sdk/lightclient/`, plan §38); the metered upstream remains to do once a zkAPI RPC
upstream exists.
