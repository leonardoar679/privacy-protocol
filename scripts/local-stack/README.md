# The whole stack on one workstation

The automated form of `docs/local-run.md`: a devnet, the pool and the swap periphery deployed from the forge
artifacts, the swap service, the relayer, the wallet, and a real browser clicking through the flows the plan's
verification lists — first launch with no network, a wallet created, deposits, a $1K withdrawal, a $120K withdrawal
through the enhanced Review, an $850K swap through the Review, the scheduled funding, the hard quote, the wallet's
own check of the provider call, the simulation, the execute Review, the executor and the tracker, a reload and the
Activity list, and (V3) a $10M protected swap: the separate device, the wizard, the campaign Review, the runner taking
the first step through the executor while the second waits, the dashboard, the global switch, Return the rest.
Provider quotes are live (THORChain, Chainflip, …); nothing here holds funds.

```
cd scripts/local-stack && npm install          # hardhat 2, playwright, viem — only here, not in the workspaces
(cd ../../contracts && forge build)            # the artifacts deploy.mjs reads (contracts/out)

npm run chain                                   # 1. the devnet: Hardhat as chain id 1 on 127.0.0.1:8546 (keep it running)
npm run deploy                                  # 2. the pool, the ETH vault, the SwapOrderFactory, the mainnet pins, the feeds → run/stack.json
npm run services                                # 3. the swap service (8787), the relayer (8790), the wallet (5173); logs in run/
BROWSER_CHANNEL=chrome npm run e2e              # 4. the browser run → run/e2e/NN-step.png + report.json (HEADED=1 to watch)
```

The browser opens the wallet at `http://localhost:5173/` (a hostname, not the IP: WebAuthn refuses an IP origin as its
RP ID, and the V3 run registers a separate device). `BROWSER_CHANNEL` is `chrome` or `msedge` for the browsers already on the machine; unset, Playwright's own Chromium
(`npx playwright install chromium`). The wallet can also be used by hand at http://127.0.0.1:5173 while step 3 runs;
the funding wallet in the browser is the devnet's account #1 (the e2e injects it; by hand, any injected wallet pointed
at http://127.0.0.1:8546 with chain id 1 works).

## Why chain id 1

The wallet signs a provider call only on Ethereum mainnet, where the contracts it pins exist (`providerCall.ts`
`PINNED`). The devnet therefore answers chain id 1, and `deploy.mjs` places the **mainnet runtime bytecode** of
THORChain's router, Chainflip's vault and WETH9 at their mainnet addresses (`hardhat_setCode`; `mainnet/*.hex`, fetched
with `eth_getCode` on 2026-10-08 and refetched from a public RPC when missing), so the pre-trade simulation runs the
real provider code. Chainlink's mainnet proxies get a mock feed (`contracts/MockFeed.sol`: the answer in slot 0, the
description in slot 1; BTC / USD through a mock Feed Registry) at $4,250 / ETH and $118,000 / BTC (`ETH_USD`,
`BTC_USD` override). The dev-setup Groth16 verifier is the real circuit's key under an insecure setup (`circuits/setup/dev`):
every proof the wallet makes in the browser is verified on chain.

One consequence: chain id 1 has an Ethereum light client, and the devnet has no beacon chain, so the run switches
"Verify the pool with the Ethereum light client" off under More → Advanced (the wallet then says reads rest on the RPC quorum).
On Sepolia or mainnet leave it on.

## What a run checks (166/166 checks on the V5 run, `results/report-2026-10-08-v5.json`; the V4 run: `results/report-2026-10-08-v4.json`, 48/48; the V3 run: `results/report-2026-10-08-v3.json`)

V5 (`docs/privacy-wallet-web-spec-v1.0.md`): the same money flow on the rebuilt screens — Welcome → the experience → Create → the phrase;
More → Advanced for the light client and More → Wallet for the connection; Protect through the connected wallet's own provider; Send (public),
exact-input by default, so the recipient receives what you send minus the privacy fee and the relayer's; the hold from $50K; the swap through
the order panel (Fund now, the hard quote — a lower minimum asks for consent, once more when the live price drifts again before the fresh quote —, the execute Review, the hand-over, the tracker); the reload; Activity; the $10M protected swap on the
new screens (a step whose hard quote comes back below the approved minimum pauses the campaign for consent; Resume accepts it) — then the viewport matrix (1280x800, 1440x900, 360x800, 390x844, 412x915, 768x1024: no horizontal scroll, 44 px controls, a screenshot per screen; once more under
`?locale=pseudo`) and the leakage twin (every request body read for the phrase and the password; `localStorage` empty; the two ciphertext
blobs in IndexedDB). On the devnet the light client is switched off under More → Advanced.
`probes/` keeps two diagnostic scripts from the V5 pass: `probe-hold.mjs` (the hold button under three gestures on the campaign Review,
the ring's progress sampled) and `probe-layout.mjs` (the elements whose content overflows their box, the fixed elements' geometry, under
`?locale=pseudo` at 360×800); run them from this folder with the stack up.

V4 (`docs/high-value-execution-contract-v1.0.md`): the same run against the V4 service and wallet — the progress panel says
"Executing in protected steps" and the run reads the step from its `data-step` attribute (the counter shows under Advanced);
the campaign Review carries the EXECUTION verdict line and "Cross-chain settlement is not atomic"; the wizard shows the
first-time explanation. What a devnet cannot show stays with the vitest flows and the tests tree (`tests/high-value`).

- first launch: the lock screen, 24 words, Home without a USD figure, every tab and sheet — no request left the page's
  origin;
- two 500 ETH deposits land in the vault; Home values the balance at ≈ $4,250,000 through both RPC endpoints;
- a 0.2 ETH ($850) withdrawal is the plain flow: a proof in the Web Worker, the relayer submits, the fresh recipient is paid;
- a 28 ETH ($119,000) withdrawal goes through the enhanced Review (the numeral, the lint, a tap) to the next fresh address;
- a 200 ETH ($850,000) swap to a fresh Bitcoin address (the enhanced tier — from $1M every order is a protected
  execution, below): one route in words with fees in asset units; the commit Review with the five lines; a tap; the
  funding scheduled inside the policy window; Fund now; the hard quote (a lower minimum asks for consent; a hard quote
  the price guard refuses is retried, else the order returns to the pool); the execute Review with the simulation on
  2 RPC endpoints and the guaranteed minimum; the hand-over; the executor's `deployAndExecute` mined; the escrow empty;
  the settlement line "Executing";
- after a reload and unlock the order and its line come back from the encrypted journal; Activity has a row per flow and
  never a bare "failed";
- **V3** (`docs/high-value-protection-spec-v1.0.md`): Settings → Protected execution with a separate device registered
  through a virtual cross-platform authenticator (CDP `WebAuthn.addVirtualAuthenticator`); five more 500 ETH deposits;
  a $10M ETH → BTC order: the protection line under the quote, the wizard (risk analysis → privacy analysis →
  destination check), the campaign Review (the maximum-loss model, the paired SECURITY + PRIVACY verdict, the Exposure
  and Security lines, the review hold of `VITE_REVIEW_HOLD_MINUTES=1`), a hold, the password fallback for the second
  factor and the separate device; the campaign journaled (Step 1 of ~N, ✓ Protected, Completed 0 / In progress 0 /
  Protected); the App-level runner takes step 1 through commit → fund → sign → hand-over against live quotes —
  `deployAndExecute` mined, the escrow empty — while step 2 waits (In progress = one step ≤ the cap, ● Processing); the
  exposure dashboard under Advanced; Pause large operations on Home pauses on the next tick (⚠ Review); Return the rest
  winds down (the planned steps skipped, the executed step tracked); the campaign comes back after a reload; Activity
  has one row for it. The devnet never delivers: settlement, multi-step progression and partial fills are pinned by
  the vitest suites (`campaign-runner`, `campaign-flow`), not here.

The devnet keeps state across runs (each run makes a new wallet and new deposits); restart `npm run chain` and
`npm run deploy` for a clean chain. The relayer's journal lives in `run/relayer-journal`.

## Found by this run (fixed in the tree)

- the fee line showed base units with raw asset ids ("2047477191 Ethereum.USDC"): fees now carry `decimals` (spec §2);
- the price guard's refusal was a 500: it is 409 `price_guard` (spec §14);
- Vite discovered `snarkjs` at the first proof and reloaded the page mid-transaction: it is pre-bundled now.
- (V3) the service's price guard compares a step's provider at the step's own size: for a 20 ETH step of a $10M order
  Chainflip beat THORChain by more than 50 bps and the guard refused the campaign's whole-order provider, and the
  runner fell into the scheduler's ten-minute backoff — every step is now routed by the competition at its size, a
  provider change goes through the reroute Review, and the guard's refusal pauses `route-degraded` (spec §8);
- (V3) WebAuthn refuses an IP-address origin as its RP ID ("This is an invalid domain"): the run opens the wallet at
  `http://localhost:5173/`, where the separate device registers through the virtual authenticator;
- (V3) with Advanced on, the Shield screen names the leaf ("Shielded 500 ETH — note at leaf N") instead of "Added …":
  the run accepts either.

## Notes for this machine

`anvil` (Foundry) segfaults here (a Winsock LSP; see `docs/local-run.md`), which is why the devnet is Hardhat's. Playwright
1.64 drives the installed Chrome 154 with its old headless shell (`--headless=old`, set by `e2e.mjs` for
`BROWSER_CHANNEL=chrome`; the new headless mode does not come up) or headed. Edge 152 ran two full passes headless and
then began answering every external request with `ERR_NETWORK_ACCESS_DENIED` (the THORNode gateways the wallet asks
for THORChain's inbound vault), while node and Chrome on the same machine still reached them: an Edge-side network
policy, not the wallet.
