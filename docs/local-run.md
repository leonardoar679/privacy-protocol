# Running the whole stack on a workstation

Order of operations, with what each step proves. The automated form of steps 1–5 lives in
[`scripts/local-stack`](../scripts/local-stack/README.md): a Hardhat devnet as chain id 1 (Foundry's `anvil`
segfaults on this machine, a Winsock LSP; a JavaScript node survives it), the contracts deployed from the forge
artifacts, mock Chainlink feeds and the mainnet bytecode of the pinned provider contracts at their addresses, the three
services from one script, and a Playwright-driven browser clicking through the flows below on the V6 screens (spec v2.0:
Welcome → the experience → Create, Protect 5,000 USDC, Send 2,500 USDC, the large Reviews, ETH → BTC with one confirmation,
USDC → ETH into the protected balance, the $80,000 protected steps, the $10M campaign, Activity, More), then the viewport
matrix — the shell screens with no horizontal scroll and 44 px controls, once more under the pseudo-locale —, section 9b
(pagehide, an idle minute, a wallet disconnected mid-Protect, a tab closed, the browser restarted on its profile, a Send
whose answer is lost as the network drops) and the leakage twin (every request body read for the phrase and the password,
localStorage and sessionStorage empty, the two ciphertext blobs in IndexedDB). The V2–V4 run: 35 checks (36 when the hard
quote asks for consent), last run 2026-10-08 (`results/report-2026-10-08.json`); the V5 run: **166/166** checks on
2026-10-08 (`results/report-2026-10-08-v5.json`), the follow-up of 2026-10-13: **167/167** (`results/report-2026-10-13-v5.json`);
V6, at each stage that changed the flows (`results/report-2026-10-13-v6-stage1.json` … `results/report-2026-10-14-v6-stage16.json`),
and the final run on the V6 code: `results/report-2026-10-14-v6.json`. Live providers come and go — a price trending one
way asks for the new minimum again, a provider without a quote pauses the steps, "No route available right now" — and the
run does what a person would (accepts, resumes, types the amount again) and says so in its log. A swap that stops for any
other reason (neither a reconcile under way nor a refused quote it can try again) fails its check at once, with the
record's state, its reason's code and the words the user reads: the progress view carries `data-code`. Before (a V6
follow-up of 2026-10-15), the run waited out its timeouts and named nothing. The one difference from a testnet: there the light client
stays on; on the devnet the run switches it off under More → Advanced (no beacon chain to follow).
`VIEWPORTS=360x800,1280x800` narrows the matrix; `SKIP_CAMPAIGN=1` leaves out the $10M protected swap.

```
cd scripts/local-stack && npm install
npm run chain      # the devnet            (terminal 1)
npm run deploy     # run/stack.json        (terminal 2)
npm run services   # 8787 / 8790 / 5173   (terminal 2, keeps running)
BROWSER_CHANNEL=chrome npm run e2e        # terminal 3; or open http://127.0.0.1:5173 by hand
```

## 0. Verify the tree first
```
node scripts/verify-all.mjs --forge <path-to-solc-0.8.24> --rust   # every offline step: type checks, every suite, the gates, the build + budget, forge, the Rust core
node scripts/verify-all.mjs --live --browser                 # + the provider suites (network) and the screenshot harness (Chrome)
```

## 1. A chain with the contracts
Either a local node (`anvil`) with the dev verifier, or Sepolia (`docs/testnet.md`):
```
cd contracts
DEV_VERIFIER=true forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil key 0> --broadcast
forge script script/DeploySwapPeriphery.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil key 0> --broadcast
forge script script/DeployProtectRouter.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil key 0> --broadcast   # V6: the 1 % protect
forge script script/DeployShieldReceiver.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil key 0> --broadcast  # V6: same-chain swaps into the protected balance
```
Note the five core addresses, the ETH vault, the `SwapOrderFactory`, the `ProtectRouter` and the `ShieldReceiverFactory`
from the logs (the local stack's `npm run deploy` does all of it and writes `run/stack.json`).

## 2. Services
```
cd apps/api                                          # V6: the API (Express 5 + node:sqlite) over the swap engine
CHAIN_ID=1 SWAP_FACTORY=<factory> NATIVE_VAULT=<ethVault> RPC_URLS=<rpc> RELAYER_URL=http://127.0.0.1:8790 \
  DB_PATH=api.sqlite npm start                       # http://127.0.0.1:8787/v1 (live provider quotes, swap records)

cd apps/relayer && cp .env.example .env         # RPC_URL, CHAIN_ID, CORE, FEE_VAULT, a funded RELAYER_PRIVATE_KEY, RELAYER_SEED (+ FEE_VAULTS for ERC-20 fee notes, SHIELD_FACTORY for same-chain swaps)
npm install && npm run serve                        # http://127.0.0.1:8790 (private submission + swap executor)
curl -s http://127.0.0.1:8790/info                  # minFeeWei, the relayer's pp1… address
```
V3 (`docs/high-value-protection-spec-v1.0.md`): the API reads its risk database from `packages/swap-engine/risk/`
(`RISK_DB_DIR` to point elsewhere; `INCIDENTS_FILE` for an operator's incident list, re-read every minute) and answers
`GET /v1/risk/:provider`; the relayer's `GET /swap` and `GET /jobs` (the whole job lists) open only to `RELAYER_ADMIN_TOKEN`. V6 (spec
v2.0 §15): the API keeps swap records in `DB_PATH` (WAL), purges them on its retention schedule and logs one JSON line
per event, never an address, a hash or an amount; `scripts/local-stack/start-services.mjs service` starts it on 8787
with `run/api.sqlite`.

## 3. Wallet
```
cd apps/web && cp .env.example .env.local           # VITE_RPC_URLS (two or more endpoints) / VITE_CHAIN_ID / VITE_CORE / VITE_ETH_VAULT / VITE_SWAP_FACTORY / VITE_PROTECT_ROUTER / VITE_SHIELD_FACTORY from step 1 (+ VITE_ERC20_VAULTS, VITE_RELAYER_URLS)
ZKAPI_NETWORK=sepolia npm run zkapi:assets && npm run zkapi:pins   # only for the Private AI tab (Sepolia zkAPI)
npm install && npm run dev                          # http://localhost:5173  (VITE_REVIEW_HOLD_MINUTES=1 shortens the institutional review hold for a local run)
(cd ../privacy-core && node scripts/build-wasm.mjs)   # optional: the Rust core as WASM; dev serves it at /core/, a build needs `npm run core:assets` (docs/mobile.md); without it the wallet runs the TypeScript reference
```
Then, in the browser, in this order — each step is one of the flows the node tests and the forge
suites already cover, so what is being checked is the glue in a real browser on a real chain. V6 (spec v2.0 §7), as a
first-time user would:
- **Welcome → the experience → Create** (password, the 24 words, Continue); Home reads $0 with "Protect your assets".
- **Protect 5,000 USDC** (a test USDC in `VITE_ERC20_VAULTS`, through `VITE_PROTECT_ROUTER`): "You receive 4,950 USDC",
  "Privacy fee 50 USDC", the relayer / network in dollars → Review (a tap below $50K) → "Added 4,950 USDC to your protected
  balance." The router pays the 50 USDC to its fee recipient.
- **Send 2,500 USDC** to a fresh address of another wallet: "Recipient receives 2,470.90 USDC" (the largest line), the
  privacy fee 25, the relayer ≈ 4.10 → the recipient receives exactly 2,470.90.
- **Swap ETH → BTC**: the quote as you type, "You'll receive at least", the expiry; one confirmation, then the progress — no
  second tap. On a devnet the order executes against the pinned THORChain router and never delivers.
- **Swap USDC → ETH** (`SHIELD_FACTORY` at the relayer): "Your protected balance" as the destination; THORChain pays the
  one-time ShieldReceiver, the relayer shields it, and the note appears ("Added to your protected balance: … ETH").
- **$80,000**: no mode to choose — "Protected execution" with its four checks, Hold to Confirm (or "Confirm without
  holding", a dialog), then the steps in amounts only (Completed / Executing / Remaining).
- **Reload, close the tab, go offline, lock** in the middle of any of them: the wallet comes back to the operation and
  sends nothing twice. Then Activity, the detail, More → Privacy Center, More → Language (한국어), and the desktop at 1440 px.

The V1.1–V5 walk-through, on the V6 screens (the engines underneath are the same):
0. **Create a wallet** (password → write the 24 words down → Continue), then **Lock** and **Unlock** it; **More →
   Security** downloads the backup (the keystore and the journal); on a second browser, **Restore** from the phrase: the
   notes are found again from their encrypted payloads by themselves (a restore scans the pool at once; there is no
   rescan button since V6).
1. **Protect** 1 ETH with the injected wallet (the 1 % through ProtectRouter) → "Added … ETH to your protected balance".
1b. With a test token in `VITE_ERC20_VAULTS`: **Protect** 100 USDC → the approval, then the protect; a **Send** in USDC
   pays the relayer in USDC (its `FEE_VAULTS`).
2. **Send** 0.4 ETH to a fresh public address with the relayer submission (a withdrawal) → on Sepolia the wallet first
   proves the pool with the Ethereum light client ("Verifying the pool…": a few seconds the first time;
   *Advanced* then shows the finalized block and how many leaves are proven; a local `anvil` has no light
   client and says so; the RPC endpoints must serve `eth_getProof` at the finalized block), the proof is
   produced in the Web Worker (≈ 1–3 s on a laptop), the relayer submits from its own key, the change
   note and the relayer's fee note are on chain; the relayer's `GET /jobs` (with its operator token) shows the
   submission mined.
   A note shielded in the last ~13 minutes is newer than finality: it is spendable, but proven only once
   its block is final.
3. **Send** to a second wallet's `pp1…` address (its **Receive** screen shows it with a QR) → the transfer stays inside
   the pool; the recipient's wallet finds the note by itself — within ten minutes while unlocked, at once when it opens
   Activity or Receive, or at its next unlock — and Activity shows it as `Private Receive`.
3b. **Receive** → Bitcoin / Solana / ETH-public → "New address" gives a fresh address each time; the index survives Lock / Unlock.
4. **Swap**: the V6 flow above (one confirmation). From $100K the V3–V5 screen under `/swap/protected` still takes a
   staged or a single order. A single order there has its order panel: **1 · Fund now** (with the *Best privacy*
   preference, under More → Wallet, the funding waits a random time in its window; reload, unlock: the order is still
   under "Your open swaps") → **2 · Confirm the swap**. Both screens read the provider call before signing and say what
   they checked; the executor's state goes Pending → Executing (`deployAndExecute` from the relayer key).
   - On a testnet the wallet refuses to sign (the pinned provider contracts exist on mainnet only): **Return funds**
     (V6) or **Return to my private balance** (the V3–V5 screen), let the window pass and watch Refunding → Refunded
     (`deployAndRefund` re-shields the pre-committed note).
   - If the price moved since the quote, the V6 order pauses with **Accept new minimum** and then signs the very call
     that minimum was read from; the V3–V5 panel signs only after *Confirm at the new minimum*.
4b. **Swap without a wallet** (the lock screen's link, `/guest`): BTC → ETH quote → deposit instruction (THORChain inbound address
   + memo; the browser checks both against three public THORNode gateways and your inputs before showing
   them) → paste a txid → status.
5. **Private AI** (More → Private AI; Sepolia zkAPI, needs Sepolia ETH and the server's shared password): fund the fresh
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

V4 (`docs/high-value-execution-contract-v1.0.md`): the panel says "Executing in protected steps" (the step counter under
Advanced); the Review's verdict carries the EXECUTION line and, on a cross-chain route, "Cross-chain settlement is not
atomic"; the wizard's first step shows the one-time explanation. Between $100K and $1M the quote offers "Protect this
order" (the Protected policy, 5 %) unless Settings → Protected execution already protects every order from $100K; the same
panel holds the deliberate opt-out (a warned second step), the fraction (1–5 %, the route and the size set the ceiling),
the provider concentration and the velocity limit. An entered destination, once verified and out of its cooling-off, needs
"Approve for large payments" (in the address book or under the typed address); an approval unused for 90 days asks for a
re-check. Home shows "🔒 Protection: Balanced ✓" beside the privacy badge; Activity's row carries execution, protection,
privacy and duration.

## What to expect to break first
- Provider quotes: live APIs rate-limit and change shapes; the adversarial suite is the reference.
- The swap on Sepolia cannot reach a real provider (mainnet pins): the wallet refuses the provider call
  there, so only the escrow / executor / refund mechanics are exercised (Return funds).
- The relayer needs a gas balance; it refuses anything below its live minimum fee.
- Wallet state lives in the encrypted journal (IndexedDB); clearing site data means Restore from phrase + rescan, or the backup file.
- Live providers: a moving price asks for the new minimum again (nothing is signed below an approved one), a provider without
  a quote pauses the large steps ("Liquidity dropped": Resume), and a pair can have no route for a while.
