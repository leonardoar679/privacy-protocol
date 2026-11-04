// start-services.mjs — runs the three processes of docs/local-run.md against the devnet described by run/stack.json:
// the API (8787; V6 Stage 9: apps/api with its database run/api.sqlite), the relayer (8790) and the wallet's Vite dev
// server (5173) — and, V7 Stage 10, the Classic app's dev server (5174, behind the wallet's /classic proxy) with the
// relayer stand-in it submits through (8791, classic-relayer.mjs). Every setting goes in
// through the environment (no .env file is written into the tree). Logs land in run/<name>.log; the relayer's journal
// in run/relayer-journal. Ctrl-C stops all three.
//
//   node start-services.mjs                 all three
//   node start-services.mjs service relayer just those
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PP_ROOT ?? resolve(HERE, "../..");
const RUN = join(HERE, "run");
mkdirSync(RUN, { recursive: true });
const stack = JSON.parse(readFileSync(join(RUN, "stack.json"), "utf8"));
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const only = process.argv.slice(2);
const wanted = (name) => only.length === 0 || only.includes(name);

const procs = [];
// a V6 follow-up of 2026-10-16 (audit gap 47): the API's vouch key on the devnet, and its address for the relayer — never a
// production key (deployment.md: generate one and keep it with the API's secrets)
const LOCAL_VOUCH_KEY = "0x6c6f63616c2d737461636b2061706920766f756368206b657920286465766e65";
const LOCAL_VOUCHER = "0xd311b8bb3670cf035826c73a2c8286ad8bacc94e";

function start(name, cwd, args, env, cmd = npx) {
  if (!wanted(name)) return;
  const log = openSync(join(RUN, `${name}.log`), "w");
  const p = spawn(cmd, args, { cwd: join(ROOT, cwd), env: { ...process.env, ...env }, stdio: ["ignore", log, log], shell: true });
  p.on("exit", (code) => console.log(`[${name}] exited with ${code}`));
  procs.push({ name, p });
  console.log(`[${name}] pid ${p.pid} in ${cwd}: ${args.join(" ")}`);
}

// the process keeps its V5 name ("service") so a restart reads the same: node start-services.mjs service
start("service", "apps/api", ["tsx", "src/server.ts"], {
  PORT: "8787",
  DB_PATH: join(RUN, "api.sqlite"),
  RELAYER_URL: "http://127.0.0.1:8790",
  ALLOWED_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
  CHAIN_ID: "1",
  SWAP_FACTORY: stack.swapFactory,
  NATIVE_VAULT: stack.ethVault,
  RPC_URLS: stack.rpc, // V6: also the fee history the executor tip is priced from (packages/swap-engine/src/tips.ts)
  THORCHAIN_ROUTER: stack.pins.thorchainRouter,
  ...(stack.usdc ? { ERC20_VAULTS: `${stack.usdc.token}:${stack.usdc.vault}:USDC:6` } : {}), // the test USDC as the wallet names it: orders in it are built only so
  API_VOUCH_KEY: LOCAL_VOUCH_KEY, // devnet only: the API vouches for the orders it commits and the calls it prepares
  COMMITS_PER_MINUTE: "600", // the browser run commits from one address far faster than a person (the API's default is 4 a minute)
  ...(stack.shieldFactory ? { SHIELD_FACTORY: stack.shieldFactory } : {}), // and for the shield receipts of its protected orders
});

start("relayer", "apps/relayer", ["tsx", "src/server.ts"], {
  RPC_URL: stack.rpc,
  CHAIN_ID: "1",
  CORE: stack.core,
  FEE_VAULT: stack.ethVault,
  RELAYER_PRIVATE_KEY: stack.keys.relayer,
  RELAYER_SEED: "0xd68e7498939594f9a669d65fa70ce4891b6b4c2703b3eae29268438e9e8cd28d", // keccak256("local stack relayer seed (devnet only)"): 32 bytes, as the relayer requires
  MIN_FEE_WEI: "0",
  GAS_ESTIMATE: "1800000",
  FEE_MARGIN_BPS: "2000",
  REQUIRE_READABLE_FEE_PAYLOAD: "1",
  FEE_PERCENT_BPS: "100", // V5 (spec §10): the product default
  // V6 (spec v2.0 §3): the USDC vault's minimum 3.727273 USDC — with the wallet's 10 % margin F = 4.10 USDC, the document's example
  ...(stack.usdc ? { FEE_VAULTS: JSON.stringify({ [stack.usdc.vault]: { symbol: "USDC", decimals: 6, minFee: "3727273" } }) } : {}),
  RELAYER_JOURNAL_DIR: join(RUN, "relayer-journal"),
  SWAP_FACTORY: stack.swapFactory, // the deployment's SwapOrderFactory: the executor admits orders for it only
  API_VOUCHER: LOCAL_VOUCHER, // the API's signing address: the executor runs only what the API vouched for
  ...(stack.shieldFactory ? { SHIELD_FACTORY: stack.shieldFactory } : {}), // V6 Stage 12 (spec v2.0 §11.2): the shield executor
  SWAP_POLL_MS: "5000",
  LATE_REFUND_WATCH_SECONDS: "86400",
  MAX_UNPAID_REFUNDS: "3",
  RATE_PER_MINUTE: "600",
  RELAYER_ADMIN_TOKEN: "local-stack-admin-token-devnet-only-0001", // 32+ characters (the fourth review round, 2026-11-03); opens GET /swap and GET /jobs (the whole job lists) to the browser run; operator data otherwise
  PORT: "8790",
  HOST: "127.0.0.1",
});

start("wallet", "apps/web", ["vite", "--port", "5173", "--strictPort", "--host", "127.0.0.1"], {
  VITE_RPC_URLS: `${stack.rpc},${stack.rpc.replace("127.0.0.1", "localhost")}`, // two endpoints: the quorum paths run
  VITE_CHAIN_ID: "1",
  VITE_CORE: stack.core,
  VITE_ETH_VAULT: stack.ethVault,
  VITE_FROM_BLOCK: "0",
  VITE_SWAP_FACTORY: stack.swapFactory,
  ...(stack.protectRouter ? { VITE_PROTECT_ROUTER: stack.protectRouter } : {}), // V6 (spec v2.0 §11.1): a protect pays its 1 % through it
  ...(stack.shieldFactory ? { VITE_SHIELD_FACTORY: stack.shieldFactory } : {}), // V6 Stage 12 (spec v2.0 §11.2): same-chain swaps into the protected balance
  ...(stack.usdc ? { VITE_ERC20_VAULTS: `USDC:${stack.usdc.token}:${stack.usdc.vault}:6` } : {}),
  VITE_PRICE_FEEDS: JSON.stringify(stack.feeds),
  VITE_SWAP_SERVICE: "http://127.0.0.1:8787",
  VITE_RELAYER_URL: "http://127.0.0.1:8790",
  VITE_THORCHAIN_ROUTER: stack.pins.thorchainRouter,
  VITE_REVIEW_HOLD_MINUTES: "1", // the institutional review hold, shortened for the browser run (V3 Stage 7)
  PW_NO_HMR: "1", // V6 Stage 15: no HMR websocket — the offline step would drop it and Vite would reload the page on its return
  ...(stack.classic ? { CLASSIC_DEV_URL: "http://127.0.0.1:5174" } : {}), // V7 Stage 10: More → Tornado Classic reaches the Classic dev server through this one
});

// V7 Stage 10 (spec v3.0 §7.9): the Classic app against this devnet — every pool function switched live (the contracts are
// the mainnet ones at their mainnet addresses, deploy.mjs), the relayer stand-in as its one relayer, the history synced from
// the block the contracts were placed at — and the stand-in itself, submitting through the real router from account #0
if (stack.classic) {
  start("classic-relayer", "scripts/local-stack", ["classic-relayer.mjs"], { PORT: "8791", RPC: stack.rpc }, "node");
  start("classic", "classic", ["vite", "--port", "5174", "--strictPort", "--host", "127.0.0.1"], {
    VITE_CLASSIC_RPC_URLS: stack.rpc,
    VITE_CLASSIC_RELAYER_URLS: "http://127.0.0.1:8791",
    VITE_CLASSIC_LIVE: JSON.stringify(Object.fromEntries(Object.values(stack.classic.pools).map((p) => [p.id, ["deposit", "withdraw"]]))),
    VITE_CLASSIC_DEPLOYED_BLOCK: String(stack.classic.deployedBlock),
    VITE_CLASSIC_RELAYERS_CURATED: "0", // a devnet must not ask mainnet's relayers: the stand-in is the one relayer here
    VITE_CLASSIC_DATA_BASE: "/classic/devnet-data", // no snapshot is served for the devnet (the pools start empty; public/data may hold mainnet's)
    PW_NO_HMR: "1",
  });
}

const stop = () => { for (const { p } of procs) try { p.kill(); } catch {} ; process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
