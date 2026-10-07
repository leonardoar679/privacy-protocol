# Running the whole stack on a workstation

What this machine could not do (no browser, no node that survives the Winsock LSP) is exactly the
first thing to do elsewhere. Order of operations, with what each step proves.

## 0. Verify the tree first
```
node scripts/verify-all.mjs --forge <path-to-solc-0.8.24>     # 8 offline steps: type checks, every suite, builds, forge
node scripts/verify-all.mjs --live                           # + the provider suites (network)
```

## 1. A chain with the contracts
Either a local node (`anvil`) with the dev verifier, or Sepolia (`docs/testnet.md`):
```
cd contracts
DEV_VERIFIER=true forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil key 0> --broadcast
forge script script/DeploySwapPeriphery.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil key 0> --broadcast
```
Note the five core addresses, the ETH vault and the `SwapOrderFactory` from the logs.

## 2. Services
```
cd services/private-swap && cp .env.example .env    # CHAIN_ID, SWAP_FACTORY, NATIVE_VAULT from step 1
npm install && npm run serve                        # http://127.0.0.1:8787 (live provider quotes)

cd services/relayer && cp .env.example .env         # RPC_URL, CHAIN_ID, CORE, FEE_VAULT, a funded RELAYER_PRIVATE_KEY, RELAYER_SEED
npm install && npm run serve                        # http://127.0.0.1:8790 (private submission + swap executor)
curl -s http://127.0.0.1:8790/info                  # minFeeWei, the relayer's pp1… address
```

## 3. Wallet
```
cd frontend && cp .env.example .env.local           # VITE_RPC_URL / VITE_CHAIN_ID / VITE_CORE / VITE_ETH_VAULT from step 1
ZKAPI_NETWORK=sepolia npm run zkapi:assets && npm run zkapi:pins   # only for the Private AI tab (Sepolia zkAPI)
npm install && npm run dev                          # http://localhost:5173
```
Then, in the browser, in this order — each step is one of the flows the node tests and the forge
suites already cover, so what is being checked is the glue in a real browser on a real chain:
1. **Shield** 1 ETH with the injected wallet → the note appears with its leaf index.
2. **Rescan the chain for my notes** → the same note is rediscovered from its encrypted payload.
3. **Withdraw** 0.4 ETH to a fresh address with submission = *Relayer* → the proof is produced in the
   Web Worker (≈ 1–3 s on a laptop), the relayer submits from its own key, the change note and the
   relayer's fee note are on chain; the relayer's `GET /jobs` shows the submission mined.
4. **Send privately** to a second wallet's `pp1…` address → the recipient rescans and finds the note.
5. **Swap privately**: quote → Use → 1 · Withdraw privately to the escrow → 2 · Sign provider call &
   hand to relayer → the executor's state goes Pending → Executing (`deployAndExecute` from the relayer
   key); on Sepolia the provider call is a mock, so let the window pass and watch Refunding → Refunded
   (`deployAndRefund` re-shields the pre-committed note; rescan to see it).
6. **Private AI** (Sepolia zkAPI, needs Sepolia ETH and the server's shared password): fund the fresh
   address from the pool, deposit credit, start a private chat, end it, withdraw unused credit.

## What to expect to break first
- Provider quotes: live APIs rate-limit and change shapes; the adversarial suite is the reference.
- The swap on Sepolia cannot reach a real provider (mainnet pins); only the escrow / executor / refund
  mechanics are exercised there.
- The relayer needs a gas balance; it refuses anything below its live minimum fee.
- Wallet state is per session (notes rediscovered by rescanning; the seed is in memory by design).
