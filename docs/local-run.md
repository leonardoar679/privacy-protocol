# Running the whole stack on a workstation

What this machine could not do (no browser, no node that survives the Winsock LSP) is exactly the
first thing to do elsewhere. Order of operations, with what each step proves.

## 0. Verify the tree first
```
node scripts/verify-all.mjs --forge <path-to-solc-0.8.24> --rust   # 10 offline steps: type checks, every suite, builds, forge, the Rust core
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

cd services/relayer && cp .env.example .env         # RPC_URL, CHAIN_ID, CORE, FEE_VAULT, a funded RELAYER_PRIVATE_KEY, RELAYER_SEED (+ FEE_VAULTS for ERC-20 fee notes)
npm install && npm run serve                        # http://127.0.0.1:8790 (private submission + swap executor)
curl -s http://127.0.0.1:8790/info                  # minFeeWei, the relayer's pp1… address
```

## 3. Wallet
```
cd frontend && cp .env.example .env.local           # VITE_RPC_URLS (two or more endpoints) / VITE_CHAIN_ID / VITE_CORE / VITE_ETH_VAULT / VITE_SWAP_FACTORY from step 1 (+ VITE_ERC20_VAULTS, VITE_RELAYER_URLS)
ZKAPI_NETWORK=sepolia npm run zkapi:assets && npm run zkapi:pins   # only for the Private AI tab (Sepolia zkAPI)
npm install && npm run dev                          # http://localhost:5173
(cd ../core/rust && node scripts/build-wasm.mjs)   # optional: the Rust core as WASM; dev serves it at /core/, a build needs `npm run core:assets` (docs/mobile.md); without it the wallet runs the TypeScript reference
```
Then, in the browser, in this order — each step is one of the flows the node tests and the forge
suites already cover, so what is being checked is the glue in a real browser on a real chain:
0. **Create a wallet** (password → write the 24 words down → Continue), then **Lock** and **Unlock** it; **Backup** downloads the keystore + journal; on a second browser **Restore from phrase** and rescan.
1. **Shield** 1 ETH with the injected wallet → "Added 1 ETH to your private balance" (leaf index under *Advanced*).
1b. With a test token in `VITE_ERC20_VAULTS`: **Shield** 100 USDC → the approve, then the deposit; **Send / Withdraw** in USDC pay the relayer in USDC (its `FEE_VAULTS`).
2. **Rescan the chain for my notes** → the same note is rediscovered from its encrypted payload.
3. **Withdraw** 0.4 ETH to a fresh address with submission = *Relayer* → the proof is produced in the
   Web Worker (≈ 1–3 s on a laptop), the relayer submits from its own key, the change note and the
   relayer's fee note are on chain; the relayer's `GET /jobs` shows the submission mined.
4. **Send privately** to a second wallet's `pp1…` address (its **Receive** tab shows it with a QR) → the recipient rescans and finds the note.
4b. **Receive** → Bitcoin / Solana / ETH-public → "New address" gives a fresh address each time; the index survives Lock / Unlock.
5. **Swap privately**: Get a quote (one route in plain words; *View route* lists the providers) → Swap →
   under *Best privacy* the funding is scheduled at a random time in the window (reload the page, unlock:
   the order is still there under "Your open swaps"; *Fund now* skips the wait) → 2 · Confirm the swap →
   the wallet reads the provider call before signing and states what it checked; the executor's state
   goes Pending → Executing (`deployAndExecute` from the relayer key). On a testnet the wallet refuses to
   sign (the pinned provider contracts exist on mainnet only): choose **Return to my private balance**,
   let the window pass and watch Refunding → Refunded (`deployAndRefund` re-shields the pre-committed
   note; rescan to see it). If the price moved since the quote, the wallet shows the new minimum and
   signs only after *Confirm at the new minimum*.
5b. **Swap without a wallet** (lock screen): BTC → ETH quote → deposit instruction (THORChain inbound address
   + memo; the browser checks both against three public THORNode gateways and your inputs before showing
   them) → paste a txid → status.
6. **Private AI** (Sepolia zkAPI, needs Sepolia ETH and the server's shared password): fund the fresh
   address from the pool, deposit credit, start a private chat, end it, withdraw unused credit.

## What to expect to break first
- Provider quotes: live APIs rate-limit and change shapes; the adversarial suite is the reference.
- The swap on Sepolia cannot reach a real provider (mainnet pins): the wallet refuses the provider call
  there, so only the escrow / executor / refund mechanics are exercised (Return to my private balance).
- The relayer needs a gas balance; it refuses anything below its live minimum fee.
- Wallet state lives in the encrypted journal (localStorage); clearing site data means Restore from phrase + rescan, or the backup file.
