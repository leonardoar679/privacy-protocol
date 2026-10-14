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
npm run deploy                                  # 2. the pool, the ETH vault, the SwapOrderFactory, ProtectRouter + USDC, the ShieldReceiverFactory, the mainnet pins, the feeds → run/stack.json
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

## What a run checks (V6 Stage 15: 197/197 checks on the quick pass, `results/report-2026-10-14-v6-stage15.json`; 165/165 checks after the V6 monorepo move, `results/report-2026-10-13-v6-stage1.json` — the two price-consent checks fire only when the live price moves between a consent and the hard quote; 167/167 checks on the V5 follow-up run of 2026-10-13, `results/report-2026-10-13-v5.json`, after the executor fix below; 166/166 on the V5 run, `results/report-2026-10-08-v5.json`; the V4 run: `results/report-2026-10-08-v4.json`, 48/48; the V3 run: `results/report-2026-10-08-v3.json`)

V5 (`docs/privacy-wallet-web-spec-v1.0.md`): the same money flow on the rebuilt screens — Welcome → the experience → Create → the phrase;
More → Advanced for the light client and More → Wallet for the connection; Protect through the connected wallet's own provider; Send (public),
exact-input by default, so the recipient receives what you send minus the privacy fee and the relayer's; the hold from $50K; the swap through
the order panel (Fund now, the hard quote — a lower minimum asks for consent, once more when the live price drifts again before the fresh quote —, the execute Review, the hand-over, the tracker); the reload; Activity; the $10M protected swap on the
new screens (a step whose hard quote comes back below the approved minimum pauses the campaign for consent; Resume accepts it) — then the viewport matrix (1280x800, 1440x900, 360x800, 390x844, 412x915, 768x1024: no horizontal scroll, 44 px controls, a screenshot per screen; once more under
`?locale=pseudo`) and the leakage twin (every request body read for the phrase and the password; `localStorage` empty; the two ciphertext
blobs in IndexedDB). On the devnet the light client is switched off under More → Advanced.
V6 Stage 15 (`docs/privacy-wallet-web-spec-v2.0.md` §7.11, §8, §12.5, §14.3): section 9b, the hardening in the browser.

- `pagehide` locks the wallet, and the unlock returns to the screen it interrupted.
- With the auto-lock at one minute under Security, a minute without activity locks it. The run then sets 60 minutes
  again: from section 0 on, it keeps 60, since some of its screens wait longer than the default 15.
- A wallet that disconnects between a USDC Protect's approval and its deposit moves nothing; the retry deposits once.
- A tab closed and opened again keeps every Activity row; so does the browser restarted on its profile. The run uses a
  persistent profile at `run/<dir>/profile`, made fresh at its start.
- A Send whose answer is lost as the network drops: `context.route` lets the submission reach the relayer, then goes
  offline and drops the answer. The wallet then:
  - shows the banner;
  - submits nothing while offline;
  - once back online, finds its one transaction by nullifier (`GET /jobs/by-nullifier/<n>`): one relayer job, the
    recipient paid once.
- The proving key is downloaded once for the whole run — reloads, the tab and the restart included — and kept in the
  Cache API under its pin.

The dev server runs without its websocket for the run (`PW_NO_HMR=1`, set by `start-services.mjs`): going offline would
drop it, and Vite reloads the page when it comes back.

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
`npm run deploy` for a clean chain. The relayer's journal lives in `run/relayer-journal` (`swap-jobs.json`, and V6 Stage 12's
`shield-jobs.json`, which the run reads for the receiver it watches: the relayer has no shield job list).

**V6 Stage 12: a same-chain swap into the protected balance** (e2e section 7b). THORChain's quote for USDC → ETH is live,
but nothing outside the devnet sees the escrow's router deposit, so the run plays THORChain's outbound itself: the real
router's `transferOut(receiver, address(0), amount, "OUT:<execution tx>")` from the devnet's funding account, which pays
the receiver with the router's own 2300-gas `send` — before the receiver exists, as on mainnet. The amount is the Review's
minimum plus the committed shield tip (the worst case the route guarantees). The relayer's shield executor (polling every
`SWAP_POLL_MS`) then deploys the receiver and shields the delivery; the wallet's order runner asks for the shield job at its
next tracking tick (15 s), finds the note in the pool and the progress ends on "Added to your protected balance".

**Expected log lines.** During the protected swap the log shows `console error: Failed to load resource: … 404` once per
ten-second tick while step 1 is funded or signed and not yet handed over (27 on the follow-up run, whose step waited through
three price consents), each preceded by the request behind it (`http 404 GET /swap/0x…`): the runner asks the relayer for a job
by the step's order id at the start of each such tick, and once more right before the hand-over, so a hand-over interrupted
before its journal entry is found instead of repeated. With no job yet the relayer answers `unknown swap job`, Chrome prints
every 404 as a console error, and no check depends on it. V6 Stage 11: the $850K swap shows the same lines — the order
runner (`packages/sdk/src/wallet/orderRunner.ts`) asks by order id at each tick once the order is funded and once more
right before the hand-over, for the same reason.

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
- (V5, 2026-10-13) the relayer's swap executor ran two passes at once — the one a hand-over request triggers and the
  interval's — and both sent `deployAndExecute` for the same funded escrow: the second was refused on the nonce and marked
  the mined execution `execute-failed`, so the order panel never reported the execution and the run stopped at 32/33.
  One pass at a time now (`apps/relayer/src/swapExecutor.ts`; `test/executorMore.test.ts` drives three ticks at once).

- (V6 Stage 15) the run's hold sometimes never started. The pointer events it dispatches are synthetic, so they cannot
  capture the pointer, while Playwright's real mouse rested where the last lint acknowledgment was clicked. The hold's
  scroll moved the button from under it, and the real pointer's `pointerleave` cancelled the hold at once (the hold
  button cancels on leave, as it should for a person's finger). The run now rests the real pointer on the button before
  pressing, and holds until the ring is full; a hold that does not fill names the pointer events the button saw.
- (V6 Stage 15) with the websocket off, the client's upgrade requests hung unanswered, and a socket reset under them (a
  browser killed mid-run) crashed the dev server on an unhandled `ECONNRESET`. Under `PW_NO_HMR` the upgrade is now
  refused at once (`apps/web/vite.config.ts`).
- (V6 Stage 15) the viewport pass found the Security screen's new auto-lock choice 412 px wide at 360 px under the
  pseudo-locale: a segmented control's options now wrap to a second row instead of scrolling the page.
- (V6 Stage 15) the live providers once answered no route for the $850K quote ("No route available right now"); the
  same request answered a minute later. That is a live dependency, not the wallet.

## Notes for this machine

The private-swap service, four days old, died during a run with exit code 3221226505 (0xC0000409, a native abort; nothing
on stderr, no Windows error report) at the moment the campaign asked it for a step's fresh quote; the wallet paused
`Liquidity dropped` on every tick until the run ended. The VPN client's Winsock layered provider is the suspect (git's
network helper crashes under it too). Restarted with `node start-services.mjs service`, the service answered the whole next run.

`anvil` (Foundry) segfaults here (a Winsock LSP; see `docs/local-run.md`), which is why the devnet is Hardhat's. Playwright
1.64 drives the installed Chrome 154 with its old headless shell (`--headless=old`, set by `e2e.mjs` for
`BROWSER_CHANNEL=chrome`; the new headless mode does not come up) or headed. Edge 152 ran two full passes headless and
then began answering every external request with `ERR_NETWORK_ACCESS_DENIED` (the THORNode gateways the wallet asks
for THORChain's inbound vault), while node and Chrome on the same machine still reached them: an Edge-side network
policy, not the wallet.
