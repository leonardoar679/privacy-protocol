# zkAPI — mainnet & Sepolia deployment verification (plan V1.1 §62)

Executed 2026-10-06 with `tools/zkapi-lab/verify-mainnet.mjs` (read-only JSON-RPC via the pinned
public RPCs; no keys, no funds). **Every pin the plan lists matched**, and both contracts were rebuilt
**byte-for-byte, metadata included**, from the source commit the live manifest names.

| Pin (§62) | How it was checked | Result |
|---|---|---|
| chain ID | `eth_chainId` on the pinned RPC vs `trusted_deployment.chain_id` | mainnet 1, Sepolia 11155111 ✔ |
| vault address | `eth_getCode` non-empty; immutables read via `eth_call` | mainnet `0x4386FDbd…81fe` (8,535 B), Sepolia `0x49fA19f9…590F` ✔ |
| verifier | `proofAdapter()` from the vault == live manifest `proof_adapter_address`; adapter runtime keccak == manifest `verifier_runtime_keccak256` | ✔ (`0x5cfce41e…` mainnet) |
| circuit ID | `protocol/setup/v2/manifest.json`, SDK pins, live `proof_setup.circuit_id` | `zkapi-v2-note-bound-v1`, groth16_bn254 ✔ |
| proving-key hashes | sha256 of `sdk/assets/proofs/{request,withdrawal}.pk` == SDK pin == `protocol/setup/v2` == live manifest | `c894b261…`, `8e41398…` ✔; verifying keys `8011244c…`, `2a8ea7f0…` == live ✔ |
| WASM hash | `npm run verify:assets` (SDK asset manifest, 5 entries) | ✔ (only after an LF checkout — see note) |
| signing keys | vault immutables `stateSigningKey{X,Y}`, `clearanceSigningKey{X,Y}` == SDK pins == live manifest | ✔ (Baby-JubJub points) |
| deployment manifest | live `…/config.json` vs packaged `trusted_deployment` (id, chain, vault, cap, keys, feed, asset, circuit) and vs chain (adapter, treasury, TTL, challenge period) | ✔ |
| asset support | vault `billingToken()` == `address(0)`; pins `billing_asset: native_eth`, `billing_token_address: null` | **native ETH only** — the launch blog's "ETH or USDC" does not apply to this deployment ✔ (mismatch resolved) |
| build hash | vault + adapter compiled from commit `95b022fd` (`zkapi_ef_sha` in the live manifest) with the demo profile (solc 0.8.28, via_ir, 200 runs), external `Bn254Poseidon` linked at `0xc6B55e86…`, immutables masked | **byte-exact incl. metadata**; on-chain keccaks == manifest `deployment_evidence` ✔ |
| price feed | Chainlink aggregator `description()` = "ETH / USD", 8 decimals; `latestRoundData` age ≤ 4,500 s | ✔ ($2,703, 845 s old at run time) |

## Operator trust points (reported, not pinned — these are what the plan's §8/§10 warn about)
| | mainnet | Sepolia |
|---|---|---|
| `owner()` (can pause; Ownable) | `0x83f7ea47…c761d156` | `0xdb4279a8…ab0ff7a` |
| `treasury()` | `0x7665Af7d…21379BB` | `0xbcec4676…d18b43e` |
| `paused()` | false | false |
| `noteTtl` / `challengePeriod` | 30 d / 24 h | 30 d / 24 h |
| `requestChargeCap` | 50,000 gwei (0.00005 ETH per request) | same |
| notes on chain at run time | 72 | 9 |
| off-chain services | auth `state-anchor`, provider `native_leases`, upstream `openrouter`; ephemeral-key issuer `org-live.openanonymity.ai`; off-chain proof verifier `verifier-production-20260917.openanonymity.ai`; lease TTL 300 s | same scheme |

The operator's own stated limitations (from the live manifest): single-party development setup;
circuit/Rust/Solidity integration not production-audited; permissionless deposits with no TVL cap;
no funded inference/withdrawal/escape-challenge acceptance claimed by configuration generation;
ETH/USD oracle may lag.

## Notes
- **Clone with LF line endings.** With Windows `core.autocrlf=true` the packaged
  `sdk/wasm/zkapi_browser.js` is rewritten on checkout and the SDK's asset-integrity test fails
  (308/309). With an LF checkout: 309/309 and `verify:assets` passes. This is a property of the
  checkout, not of zkAPI.
- The repository HEAD (`045b444`, 2026-10-01) is newer than the deployed commit (`95b022fd`,
  2026-09-30); `protocol/contracts` at HEAD builds with `optimizer_runs = 10000`, the deployment used
  the demo profile's 200 — rebuild from the named commit with the demo profile to reproduce the bytes.
- `protocol/setup/v2/Groth16ProofAdapter.sol` and `protocol/contracts/src/adapters/Groth16ProofAdapter.sol`
  differ in formatting (brace style) only; their verifying-key constants are identical and the deployed
  adapter matches the `contracts/src` build.

## Reproduce
```
git clone https://github.com/ethereum/zkapi ../zkapi && git -C ../zkapi config core.autocrlf false && git -C ../zkapi checkout -- .
git -C ../zkapi worktree add ../zkapi-deployed 95b022fd339a391321481d31dffa4b947954b0a6
(cd ../zkapi-deployed/demo/contracts && forge build)            # solc 0.8.28, via_ir, 200 runs
cd tools/zkapi-lab && npm install && node verify-mainnet.mjs mainnet && node verify-mainnet.mjs sepolia
```
Raw output of both runs follows.

### mainnet
```
PASS  chain id  — 1 (pin 1) via https://ethereum-rpc.publicnode.com
PASS  vault has code  — 8535 bytes, keccak 0x0ccfe907122037ee…
PASS  state signing key == pin
PASS  clearance signing key == pin
PASS  request charge cap == pin  — 50000 gwei
PASS  PROTOCOL_VERSION == 2
PASS  MERKLE_DEPTH == 32
PASS  billing asset is native ETH (no USDC on this deployment)  — billingToken 0x0000000000000000000000000000000000000000; pin native_eth
INFO  note TTL / challenge period  — noteTtl 2592000s (30 d), challengePeriod 86400s (24 h)
PASS  Poseidon library (external link target) has code  — 0xc6B55e86668d8c446B3D81273AAb9CBb20F28c7f, 9449 bytes
PASS  vault runtime == forge build of deployed commit  — byte-exact incl. metadata
PASS  proof adapter runtime == forge build of deployed commit  — byte-exact incl. metadata
PASS  on-chain vault keccak == manifest deployment_evidence  — 0x0ccfe907122037ee…
PASS  on-chain adapter keccak == manifest deployment_evidence  — 0x5cfce41ec9f29c8e…
INFO  deployment source commit  — zkapi_ef_sha 95b022fd339a391321481d31dffa4b947954b0a6, protocol vendored from 8b2d4e3da921f956e1eb6b93afbf722a877c060c; vault tx 0xf753fd93c7e672f7…
PASS  Groth16ProofAdapter.sol: verifying-key constants (contracts/src) == protocol/setup/v2 copy  — same constants; the copies differ in formatting (brace style) only
PASS  setup manifest circuit id == pin  — zkapi-v2-note-bound-v1, groth16_bn254
PASS  request.pk sha256: SDK asset == pin == protocol/setup/v2 == live manifest  — c894b261a13f571d…
PASS  request.vk sha256 == live manifest  — 8011244c99fa1a85…
PASS  withdrawal.pk sha256: SDK asset == pin == protocol/setup/v2 == live manifest  — 8e41398092fdd02b…
PASS  withdrawal.vk sha256 == live manifest  — 2a8ea7f07176e369…
PASS  live manifest == packaged trusted_deployment  — zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930
PASS  live manifest == chain (adapter, treasury, ttl, challenge)
INFO  live manifest: services  — auth state-anchor, provider native_leases, upstreams ["openrouter"], issuer https://org-live.openanonymity.ai, verifier https://verifier-production-20260917.openanonymity.ai, lease ttl 300s, demo mint false
INFO  live manifest: operator-stated limitations  — Single-party development setup; circuit, Rust and Solidity integration are not production-audited. | Deposits are permissionless and no application-enforced deposit or TVL cap exists. | No funded inference, withdrawal or live escape-challenge acceptance is claimed by configuration generation. | ETH balances fluctuate in USD value; the latest finalized ETH/USD oracle round may lag the market.
PASS  price feed is Chainlink ETH/USD, 8 decimals  — ETH / USD, 8 decimals
PASS  price feed round fresh  — $2703.00, updated 947s ago (max 4500s)
INFO  operator trust points  — owner 0x83f7ea47811a288f2052bc31aaae0803c761d156, treasury 0x7665af7d8c08733a22d0ac370ee8c5e2e21379bb, paused false, notes 72, root 0x17c09d5766fc…
INFO  off-chain services (not contracts)  — verifier https://verifier2.openanonymity.ai; inference https://openrouter.ai/api/v1

mainnet: 23 pass, 0 fail, 6 informational
```

### sepolia
```
PASS  chain id  — 11155111 (pin 11155111) via https://ethereum-sepolia-rpc.publicnode.com
PASS  vault has code  — 8535 bytes, keccak 0x5fe3483dee3efce8…
PASS  state signing key == pin
PASS  clearance signing key == pin
PASS  request charge cap == pin  — 50000 gwei
PASS  PROTOCOL_VERSION == 2
PASS  MERKLE_DEPTH == 32
PASS  billing asset is native ETH (no USDC on this deployment)  — billingToken 0x0000000000000000000000000000000000000000; pin native_eth
INFO  note TTL / challenge period  — noteTtl 2592000s (30 d), challengePeriod 86400s (24 h)
PASS  Poseidon library (external link target) has code  — 0xB7170CC962E6185bA0E3B716Aeb93e89cbacaa9C, 9449 bytes
PASS  vault runtime == forge build of deployed commit  — byte-exact incl. metadata
PASS  proof adapter runtime == forge build of deployed commit  — byte-exact incl. metadata
PASS  on-chain vault keccak == manifest deployment_evidence  — 0x5fe3483dee3efce8…
PASS  on-chain adapter keccak == manifest deployment_evidence  — 0x5cfce41ec9f29c8e…
INFO  deployment source commit  — zkapi_ef_sha 95b022fd339a391321481d31dffa4b947954b0a6, protocol vendored from 8b2d4e3da921f956e1eb6b93afbf722a877c060c; vault tx 0xd7f1427d400f3cd2…
PASS  Groth16ProofAdapter.sol: verifying-key constants (contracts/src) == protocol/setup/v2 copy  — same constants; the copies differ in formatting (brace style) only
PASS  setup manifest circuit id == pin  — zkapi-v2-note-bound-v1, groth16_bn254
PASS  request.pk sha256: SDK asset == pin == protocol/setup/v2 == live manifest  — c894b261a13f571d…
PASS  request.vk sha256 == live manifest  — 8011244c99fa1a85…
PASS  withdrawal.pk sha256: SDK asset == pin == protocol/setup/v2 == live manifest  — 8e41398092fdd02b…
PASS  withdrawal.vk sha256 == live manifest  — 2a8ea7f07176e369…
PASS  live manifest == packaged trusted_deployment  — zkapi-native-eth-sepolia-note-bound-v1-fresh-20260930
PASS  live manifest == chain (adapter, treasury, ttl, challenge)
INFO  live manifest: services  — auth state-anchor, provider native_leases, upstreams ["openrouter"], issuer https://org-staging.openanonymity.ai, verifier https://verifier2.openanonymity.ai, lease ttl 300s, demo mint false
INFO  live manifest: operator-stated limitations  — Single-party development setup; circuit, Rust and Solidity integration are not production-audited. | Deposits are permissionless and no application-enforced deposit or TVL cap exists. | No funded inference, withdrawal or live escape-challenge acceptance is claimed by configuration generation. | ETH balances fluctuate in USD value; the latest finalized ETH/USD oracle round may lag the market.
PASS  price feed is Chainlink ETH/USD, 8 decimals  — ETH / USD, 8 decimals
PASS  price feed round fresh  — $2701.89, updated 3316s ago (max 4500s)
INFO  operator trust points  — owner 0xdb4279a81b00fc0e680f0e6e88a0e2d23ab0ff7a, treasury 0xbcec4676ae50e4d231c5f5933742be1e0d18b43e, paused false, notes 9, root 0x771ce71c4198…
INFO  off-chain services (not contracts)  — verifier https://verifier2.openanonymity.ai; inference https://openrouter.ai/api/v1

sepolia: 23 pass, 0 fail, 6 informational
```
