# Running the whole stack on a workstation

Order of operations, with what each step proves. The automated form of steps 1–5 lives in
[`scripts/local-stack`](../scripts/local-stack/README.md): a Hardhat devnet as chain id 1 (Foundry's `anvil`
segfaults on this machine, a Winsock LSP; a JavaScript node survives it), the contracts deployed from the forge
artifacts, mock Chainlink feeds and the mainnet bytecode of the pinned provider contracts at their addresses, the three
services from one script, and a Playwright-driven browser clicking through the flows below — 35 checks (36 when the hard quote asks for consent), last run
2026-10-08 (`results/report-2026-10-08.json`). The one difference from a testnet: there the light client stays on; on
the devnet the run switches it off under Settings (no beacon chain to follow).

```
cd scripts/local-stack && npm install
npm run chain      # the devnet            (terminal 1)
npm run deploy     # run/stack.json        (terminal 2)
npm run services   # 8787 / 8790 / 5173   (terminal 2, keeps running)
BROWSER_CHANNEL=chrome npm run e2e        # terminal 3; or open http://127.0.0.1:5173 by hand
```

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
V3 (`docs/high-value-protection-spec-v1.0.md`): the service reads its risk database from `services/private-swap/risk/`
(`RISK_DB_DIR` to point elsewhere; `INCIDENTS_FILE` for an operator's incident list, re-read every minute) and answers
`GET /risk/:provider`; the relayer's `GET /swap` (the whole job list) opens only to `RELAYER_ADMIN_TOKEN`.

## 3. Wallet
```
cd frontend && cp .env.example .env.local           # VITE_RPC_URLS (two or more endpoints) / VITE_CHAIN_ID / VITE_CORE / VITE_ETH_VAULT / VITE_SWAP_FACTORY from step 1 (+ VITE_ERC20_VAULTS, VITE_RELAYER_URLS)
ZKAPI_NETWORK=sepolia npm run zkapi:assets && npm run zkapi:pins   # only for the Private AI tab (Sepolia zkAPI)
npm install && npm run dev                          # http://localhost:5173  (VITE_REVIEW_HOLD_MINUTES=1 shortens the institutional review hold for a local run)
(cd ../core/rust && node scripts/build-wasm.mjs)   # optional: the Rust core as WASM; dev serves it at /core/, a build needs `npm run core:assets` (docs/mobile.md); without it the wallet runs the TypeScript reference
```
Then, in the browser, in this order — each step is one of the flows the node tests and the forge
suites already cover, so what is being checked is the glue in a real browser on a real chain:
0. **Create a wallet** (password → write the 24 words down → Continue), then **Lock** and **Unlock** it; **Backup** downloads the keystore + journal; on a second browser **Restore from phrase** and rescan.
1. **Shield** 1 ETH with the injected wallet → "Added 1 ETH to your private balance" (leaf index under *Advanced*).
1b. With a test token in `VITE_ERC20_VAULTS`: **Shield** 100 USDC → the approve, then the deposit; **Send / Withdraw** in USDC pay the relayer in USDC (its `FEE_VAULTS`).
2. **Rescan the chain for my notes** → the same note is rediscovered from its encrypted payload.
3. **Withdraw** 0.4 ETH to a fresh address with submission = *Relayer* → on Sepolia the wallet first
   proves the pool with the Ethereum light client ("Verifying the pool…": a few seconds the first time;
   *Advanced* then shows the finalized block and how many leaves are proven; a local `anvil` has no light
   client and says so; the RPC endpoints must serve `eth_getProof` at the finalized block), the proof is
   produced in the Web Worker (≈ 1–3 s on a laptop), the relayer submits from its own key, the change
   note and the relayer's fee note are on chain; the relayer's `GET /jobs` shows the submission mined.
   A note shielded in the last ~13 minutes is newer than finality: it is spendable, but proven only once
   its block is final.
4. **Send → Privately** to a second wallet's `pp1…` address (its **Home → Receive** sheet shows it with a QR) → the recipient rescans (Home → Details) and finds the note.
4b. **Home → Receive** → Bitcoin / Solana / ETH-public → "New address" gives a fresh address each time; the index survives Lock / Unlock.
5. **Swap**: Get a quote (one route in plain words; *Route details* lists the providers; the trade preference lives under Settings) → Swap →
   with the *Best privacy* preference (Settings) the funding is scheduled at a random time in the window (reload the page, unlock:
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

## 4. A protected swap (V3, `docs/high-value-protection-spec-v1.0.md`)
With a private balance worth $1M or more (on a devnet, the mock feeds set the price), **Swap** an amount from $1M up: the quote
carries the protection line ("Protected execution: about N steps …"), **Review** opens the wizard (risk analysis → privacy
analysis → destination check) and then the campaign Review with the maximum-loss model and the paired SECURITY + PRIVACY
verdict; the hold confirms, the second factor from $5M, the separate device at $10M (register one under Settings → Protected
execution first; WebAuthn needs the wallet opened at a hostname such as `localhost`, not an IP). The steps then run from any
screen while the wallet is unlocked (Home shows the line and the "Pause large operations" switch; the Swap screen's
"Your protected swaps" reopens the progress panel, the dashboard under Advanced). A route change at a step's size asks for
the reroute Review. A devnet never delivers, so the first step stays "executing": Return the rest winds the campaign down.

## What to expect to break first
- Provider quotes: live APIs rate-limit and change shapes; the adversarial suite is the reference.
- The swap on Sepolia cannot reach a real provider (mainnet pins): the wallet refuses the provider call
  there, so only the escrow / executor / refund mechanics are exercised (Return to my private balance).
- The relayer needs a gas balance; it refuses anything below its live minimum fee.
- Wallet state lives in the encrypted journal (localStorage); clearing site data means Restore from phrase + rescan, or the backup file.
