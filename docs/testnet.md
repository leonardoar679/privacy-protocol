# Testnet runbook — plan step 19

Status (2026-10-06): **scripts and dry runs ready; no broadcast yet.** Both deployment scripts run
end to end in forge's local EVM; broadcasting needs a funded Sepolia key and a machine whose network
stack lets forge/cast talk to an RPC (see "This machine" below). Nothing in this document is a
production procedure: the testnet rehearsal uses the insecure dev verifier on purpose.

## What gets deployed
| Order | Contract(s) | Script | Notes |
|---|---|---|---|
| 1 | `Groth16Verifier` (adapter) → `Poseidon2Hasher` → `PrivacyCore` (deploys its own `AssetVaultFactory`) → ETH vault (+ optional USDC/USDT vaults) | `contracts/script/Deploy.s.sol` | `SEPOLIA_DEV_VERIFIER=true` deploys the **insecure** dev verifier, hard-gated to chain id 11155111; the ceremony verifier (`INNER_VERIFIER`) is the only production path |
| 2 | `SwapOrderFactory` (periphery; the core does not know it) | `contracts/script/DeploySwapPeriphery.s.sol` | takes the chain's wrapped native token (`WRAPPED_NATIVE`, default WETH on Sepolia `0xfFf9…6B14` and mainnet `0xC02a…6Cc2`; escrows unwrap a WETH refund of an ETH order before re-shielding, and re-shield WETH or ETH paid back to an ERC-20 order as ETH); logs the factory address and the escrow creation-code hash; the hash must equal keccak256 of `contracts/abi/periphery/SwapOrderEscrow.json` `bytecode` (dry run: `0x270af79b…4e1c`, matched) |

Dry runs executed here (no network, chain id 31337):
```
cd contracts
FOUNDRY_OFFLINE=true DEV_VERIFIER=true forge script script/Deploy.s.sol --use $SOLC -vv            # 12.4M gas
FOUNDRY_OFFLINE=true forge script script/DeploySwapPeriphery.s.sol --use $SOLC -vv                 # 2.0M gas
```

## Sepolia procedure
```
export SEPOLIA=https://…            # any Sepolia RPC (QuickNode/public); the key must hold ~0.05 Sepolia ETH
export PRIVATE_KEY=0x…              # a throwaway deployer key, never a user key
cd contracts
SEPOLIA_DEV_VERIFIER=true forge script script/Deploy.s.sol --rpc-url $SEPOLIA --private-key $PRIVATE_KEY --broadcast -vv
forge script script/DeploySwapPeriphery.s.sol --rpc-url $SEPOLIA --private-key $PRIVATE_KEY --broadcast -vv
```
Then record the five core addresses + the factory in `contracts/deployments/sepolia.json` (create it:
`{ "chainId": 11155111, "core": …, "ethVault": …, "swapFactory": …, "verifier": "DEV — insecure" }`)
and point the tooling at it:
```
# engine / local service
cd packages/swap-engine
CHAIN_ID=11155111 SWAP_FACTORY=<factory> NATIVE_VAULT=<ethVault> npm run serve
# wallet (frontend): VITE_SWAP_SERVICE as usual; the shield/withdraw screens take the core address from the deployment file
```

## What a testnet rehearsal can and cannot show
- **Can**: the real-proof pipeline against deployed contracts (shield → transact → withdraw to a
  counterfactual escrow → `deployAndExecute` / `deployAndRefund` by a relayer key), gas on a live
  network, the wallet's end-to-end flow with the local service, reorg behaviour of the escrow
  recovery (`recoverState`), relayer tip accounting.
- **Cannot**: real provider execution. The six adapters are pinned to **mainnet** contracts (Chainflip
  Vault, Mayan forwarder / Fast-MCTP, Across SpokePools, LI.FI diamond) and mainnet APIs; provider
  testnets exist for some of them (THORChain stagenet, Chainflip "perseverance", Across Sepolia
  SpokePool, LI.FI staging) but with different addresses, assets and liquidity, so a testnet swap
  through them needs a testnet pin set per adapter (not written yet — tracked in `docs/roadmap.md`).
  On Sepolia the escrow's provider call is exercised with `MockSwapProvider` (as in the forge
  suites), which is enough for the core ↔ periphery ↔ relayer rehearsal.
- **Must never**: use the dev verifier anywhere but Sepolia / local; put a user key in `PRIVATE_KEY`.

## Verification after broadcast (read-only)
1. `forge verify-contract` for each address with the pinned build settings (`foundry.toml`:
   solc 0.8.24, optimizer 200, paris, no metadata hash) — the runtime code must match byte for byte.
2. `cast code <factory> | keccak` and `cast call <factory> "initCodeHash(...)"` against the TS
   prediction (`packages/swap-engine/test/endpoints.test.ts` vector) — a mismatch means the engine
   would predict wrong escrow addresses.
3. Core invariants from `docs/security-invariants.md` hold by construction; the only configuration is
   the constructor (verifier, hasher, depth), so compare `PrivacyCore.VERIFIER()/HASHER()/LEVELS()`
   with the deployment log.

## This machine
`cast` and `forge` segfault on any RPC call here (`cast chain-id --rpc-url …` → SIGSEGV): the
Winsock LSP `ASProxy64.dll` breaks every tokio/mio-based binary (`docs/zkapi/reproduction.md`,
"toolchain notes"). Everything up to broadcast runs; the broadcast itself needs a clean machine or an
elevated `netsh winsock reset`. The QuickNode MCP connector available in this workspace can serve
the read-only verification calls (`eth_getCode`, `eth_call`) once a deployment exists.
