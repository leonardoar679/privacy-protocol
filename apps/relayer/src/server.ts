// HTTP front of the relayer: GET /info (fee, privacy address), POST /submit (a proven transact +
// the fee note's opening), GET /status/:txHash, GET /jobs; swap orders: POST /swap/execute
// (factory, params, signed execution, refund payload), POST /swap/refund (factory, params, refund payload:
// return a funded order to the pool without executing it), GET /swap/:orderId, GET /swap; V6 Stage 12 (spec v2.0 §11.2) shield
// receipts: POST /shield (factory, receiver params, payload, deliverBy), GET /shield/:receiptId. Loopback by default; CORS for the Vite
// dev origins. Env: RPC_URL, CORE, FEE_VAULT, CHAIN_ID, RELAYER_PRIVATE_KEY (gas EOA), RELAYER_SEED
// (fee-note wallet seed: utf8 or 0x-hex), MIN_FEE_WEI, GAS_ESTIMATE, FEE_MARGIN_BPS,
// FEE_VAULTS (JSON: ERC-20 vault -> {symbol, decimals, minFee}; plan §36), REQUIRE_READABLE_FEE_PAYLOAD (1),
// RELAYER_JOURNAL_DIR (journal/: durable submissions + swap jobs + shield jobs), SHIELD_FACTORY (the ShieldReceiverFactory
// this relayer shields for; unset: no shield jobs), LATE_DELIVERY_WATCH_SECONDS, MAX_UNPAID_SHIELDS,
// RATE_PER_MINUTE (60 per caller, burst 20), MAX_SWAP_JOBS (1000 open, swap and shield jobs each), PORT (8790), HOST (127.0.0.1).
import { createServer } from "node:http";
import type { Hex } from "viem";
import { Relayer, RelayerError, type RelayerConfig } from "./relayer";
import { SwapExecutor, SwapJobError, loadEscrowCreationCode } from "./swapExecutor";
import { ShieldExecutor, ShieldJobError } from "./shieldExecutor";
import { FileJournal } from "./journal";
import { RateLimiter } from "@privacy-wallet/server-kit/rateLimit";
import { originsFrom } from "@privacy-wallet/server-kit/http";
import { edge } from "./edge";
import { adminAuthorized } from "./admin";
import { join } from "node:path";

const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing env ${k}`); return v; };
const seed = (s: string): Uint8Array => (s.startsWith("0x") ? Uint8Array.from(s.slice(2).match(/../g)!.map((x) => parseInt(x, 16))) : new TextEncoder().encode(s));

/** FEE_VAULTS='{"0xvault":{"symbol":"USDC","decimals":6,"minFee":"2000000"}}' → lowercase vault -> fixed terms */
function feeVaults(): RelayerConfig["feeVaults"] {
  const raw = process.env.FEE_VAULTS;
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, { symbol: string; decimals: number; minFee: string }>;
  return Object.fromEntries(Object.entries(parsed).map(([vault, t]) => [vault.toLowerCase(), { symbol: String(t.symbol), decimals: Number(t.decimals), minFee: BigInt(t.minFee) }]));
}

const cfg: RelayerConfig = {
  chainId: Number(env("CHAIN_ID", "31337")), core: env("CORE") as Hex, feeVault: env("FEE_VAULT") as Hex, feeVaults: feeVaults(),
  minFeeWei: BigInt(env("MIN_FEE_WEI", "0")), gasEstimate: BigInt(env("GAS_ESTIMATE", "1800000")), feeMarginBps: Number(env("FEE_MARGIN_BPS", "2000")),
  privateKey: env("RELAYER_PRIVATE_KEY") as Hex, masterSeed: seed(env("RELAYER_SEED")), rpcUrl: env("RPC_URL"),
  requireReadableFeePayload: env("REQUIRE_READABLE_FEE_PAYLOAD", "1") === "1",
  journal: new FileJournal(join(env("RELAYER_JOURNAL_DIR", "journal"), "submissions.json")),
  feePercentBps: Number(env("FEE_PERCENT_BPS", "0")), // V6 (spec v2.0 §3): the privacy fee on every withdrawal; the product default is 100
};
const relayer = Relayer.fromConfig(cfg);
// swap-order executor (private-swap spec §11): deployAndExecute once an escrow is funded, deployAndRefund after the window
const executor = new SwapExecutor({ chainId: cfg.chainId, escrowCreationCode: loadEscrowCreationCode(), account: relayer.account, publicClient: relayer.clients.publicClient, walletClient: relayer.clients.walletClient, journal: new FileJournal(join(env("RELAYER_JOURNAL_DIR", "journal"), "swap-jobs.json")), lateRefundWatchSeconds: process.env.LATE_REFUND_WATCH_SECONDS ? Number(process.env.LATE_REFUND_WATCH_SECONDS) : undefined, maxUnpaidRefunds: process.env.MAX_UNPAID_REFUNDS ? Number(process.env.MAX_UNPAID_REFUNDS) : undefined });
// shield executor (spec v2.0 §11.2): deployAndShield once a same-chain swap's receiver holds its delivery
const shieldFactory = process.env.SHIELD_FACTORY && /^0x[0-9a-fA-F]{40}$/.test(process.env.SHIELD_FACTORY) ? (process.env.SHIELD_FACTORY as Hex) : null;
const shields = shieldFactory
  ? new ShieldExecutor({ factory: shieldFactory, account: relayer.account, publicClient: relayer.clients.publicClient, walletClient: relayer.clients.walletClient, journal: new FileJournal(join(env("RELAYER_JOURNAL_DIR", "journal"), "shield-jobs.json")), lateDeliveryWatchSeconds: process.env.LATE_DELIVERY_WATCH_SECONDS ? Number(process.env.LATE_DELIVERY_WATCH_SECONDS) : undefined, maxUnpaidShields: process.env.MAX_UNPAID_SHIELDS ? Number(process.env.MAX_UNPAID_SHIELDS) : undefined })
  : null;
const pollMs = Number(process.env.SWAP_POLL_MS ?? "15000");
setInterval(() => executor.tick().catch((e) => console.error("swap executor tick failed:", (e as Error).message)), pollMs).unref();
if (shields) setInterval(() => shields.tick().catch((e) => console.error("shield executor tick failed:", (e as Error).message)), pollMs).unref();
const ORIGINS = originsFrom(process.env.ALLOWED_ORIGINS, ["http://localhost:5173", "http://127.0.0.1:5173"]);
const TLS = process.env.TLS === "1"; // the relayer terminates TLS itself: HSTS (the API's setting of the same name)
const limiter = new RateLimiter({ perMinute: Number(env("RATE_PER_MINUTE", "60")), burst: Math.min(20, Number(env("RATE_PER_MINUTE", "60"))) });
const MAX_SWAP_JOBS = Number(env("MAX_SWAP_JOBS", "1000"));
const openSwapJobs = () => executor.list().filter((j) => !["refunded", "completed", "refund-failed"].includes(j.state)).length;
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const server = createServer(async (req, res) => {
  // V6 Stage 15 (doc §68): the security headers on every answer, CORS for the allowed origins, the rate limit, JSON only
  if (edge(req, res, { origins: ORIGINS, limiter, tls: TLS })) return;
  const send = (status: number, body: unknown) => { res.statusCode = status; res.end(json(body)); };
  try {
    const url = new URL(req.url ?? "/", "http://relayer");
    if (req.method === "GET" && url.pathname === "/info") return send(200, { ...(await relayer.info()), ...(shields ? { shieldFactory: shields.cfg.factory } : {}) });
    if (req.method === "GET" && url.pathname === "/jobs") return send(200, relayer.jobs_());
    if (req.method === "GET" && url.pathname.startsWith("/jobs/by-nullifier/")) {
      const job = relayer.jobByNullifier(decodeURIComponent(url.pathname.slice("/jobs/by-nullifier/".length)));
      return job ? send(200, job) : send(404, { error: "no job spends this nullifier", code: "unknown_nullifier" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/status/")) {
      const job = await relayer.status(url.pathname.slice("/status/".length) as Hex);
      return job ? send(200, job) : send(404, { error: "unknown transaction" });
    }
    if (req.method === "GET" && url.pathname === "/swap") {
      // the whole job list is operator data (a campaign's escrows are not listable by anyone): a bearer token opens it
      const auth = adminAuthorized(req.headers.authorization, process.env.RELAYER_ADMIN_TOKEN);
      return auth.ok ? send(200, executor.list()) : send(auth.status, { error: auth.error, code: auth.code });
    }
    if (req.method === "GET" && url.pathname.startsWith("/swap/")) {
      const job = executor.get(url.pathname.slice("/swap/".length));
      return job ? send(200, job) : send(404, { error: "unknown swap job" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/shield/")) {
      const job = shields?.get(url.pathname.slice("/shield/".length));
      return job ? send(200, job) : send(404, { error: "unknown shield job", code: "unknown_shield" });
    }
    if (req.method === "POST" && url.pathname === "/shield") {
      if (!shields) return send(503, { error: "this relayer runs no shield executor", code: "shield_unavailable" });
      if (shields.open() >= MAX_SWAP_JOBS) return send(503, { error: "too many open shield jobs", code: "capacity" });
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 100_000) throw new RelayerError("too_large", "request too large"); }
      const job = await shields.add(JSON.parse(body));
      shields.tick().catch(() => {}); // shield at once if the delivery is already there
      return send(200, job);
    }
    if (req.method === "POST" && url.pathname === "/swap/refund") {
      // return a funded order to the pool after its window, without executing it (no execution needed)
      if (openSwapJobs() >= MAX_SWAP_JOBS) return send(503, { error: "too many open swap jobs", code: "capacity" });
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) throw new RelayerError("too_large", "request too large"); }
      const job = executor.addRefund(JSON.parse(body));
      executor.tick().catch(() => {}); // refund at once if the window has already passed
      return send(200, job);
    }
    if (req.method === "POST" && url.pathname === "/swap/execute") {
      if (openSwapJobs() >= MAX_SWAP_JOBS) return send(503, { error: "too many open swap jobs", code: "capacity" });
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) throw new RelayerError("too_large", "request too large"); }
      const job = executor.add(JSON.parse(body));
      executor.tick().catch(() => {}); // act immediately if the escrow is already funded
      return send(200, job);
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) throw new RelayerError("too_large", "request too large"); }
      return send(200, await relayer.submit(JSON.parse(body)));
    }
    send(404, { error: "not found" });
  } catch (e) {
    if (e instanceof RelayerError) return send(e.code === "simulation_failed" || e.code === "nullifier_in_flight" ? 409 : 400, { error: e.message, code: e.code });
    if (e instanceof SwapJobError || e instanceof ShieldJobError) return send(400, { error: e.message, code: e.code });
    send(500, { error: String((e as Error).message ?? e) });
  }
});
const port = Number(env("PORT", "8790")), host = env("HOST", "127.0.0.1");
server.listen(port, host, () => console.log(`relayer ${relayer.account.address} on http://${host}:${port} — chain ${cfg.chainId}, core ${cfg.core}, fee vault ${cfg.feeVault}, privacy address ${relayer.identity.privacyAddress}`));
