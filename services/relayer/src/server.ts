// HTTP front of the relayer: GET /info (fee, privacy address), POST /submit (a proven transact +
// the fee note's opening), GET /status/:txHash, GET /jobs; swap orders: POST /swap/execute
// (factory, params, signed execution, refund payload), POST /swap/refund (factory, params, refund payload:
// return a funded order to the pool without executing it), GET /swap/:orderId, GET /swap. Loopback by default; CORS for the Vite
// dev origins. Env: RPC_URL, CORE, FEE_VAULT, CHAIN_ID, RELAYER_PRIVATE_KEY (gas EOA), RELAYER_SEED
// (fee-note wallet seed: utf8 or 0x-hex), MIN_FEE_WEI, GAS_ESTIMATE, FEE_MARGIN_BPS,
// FEE_VAULTS (JSON: ERC-20 vault -> {symbol, decimals, minFee}; plan §36), REQUIRE_READABLE_FEE_PAYLOAD (1),
// RELAYER_JOURNAL_DIR (journal/: durable submissions + swap jobs),
// RATE_PER_MINUTE (60 per caller, burst 20), MAX_SWAP_JOBS (1000 open), PORT (8790), HOST (127.0.0.1).
import { createServer } from "node:http";
import type { Hex } from "viem";
import { Relayer, RelayerError, type RelayerConfig } from "./relayer";
import { SwapExecutor, SwapJobError, loadEscrowCreationCode } from "./swapExecutor";
import { FileJournal } from "./journal";
import { RateLimiter } from "./rateLimit";
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
};
const relayer = Relayer.fromConfig(cfg);
// swap-order executor (private-swap spec §11): deployAndExecute once an escrow is funded, deployAndRefund after the window
const executor = new SwapExecutor({ chainId: cfg.chainId, escrowCreationCode: loadEscrowCreationCode(), account: relayer.account, publicClient: relayer.clients.publicClient, walletClient: relayer.clients.walletClient, journal: new FileJournal(join(env("RELAYER_JOURNAL_DIR", "journal"), "swap-jobs.json")), lateRefundWatchSeconds: process.env.LATE_REFUND_WATCH_SECONDS ? Number(process.env.LATE_REFUND_WATCH_SECONDS) : undefined, maxUnpaidRefunds: process.env.MAX_UNPAID_REFUNDS ? Number(process.env.MAX_UNPAID_REFUNDS) : undefined });
const pollMs = Number(process.env.SWAP_POLL_MS ?? "15000");
setInterval(() => executor.tick().catch((e) => console.error("swap executor tick failed:", (e as Error).message)), pollMs).unref();
const ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const limiter = new RateLimiter({ perMinute: Number(env("RATE_PER_MINUTE", "60")), burst: Math.min(20, Number(env("RATE_PER_MINUTE", "60"))) });
const MAX_SWAP_JOBS = Number(env("MAX_SWAP_JOBS", "1000"));
const openSwapJobs = () => executor.list().filter((j) => !["refunded", "completed", "refund-failed"].includes(j.state)).length;
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) { res.setHeader("access-control-allow-origin", origin); res.setHeader("access-control-allow-headers", "content-type"); res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS"); }
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  res.setHeader("content-type", "application/json");
  const send = (status: number, body: unknown) => { res.statusCode = status; res.end(json(body)); };
  const caller = req.socket.remoteAddress ?? "unknown";
  if (!limiter.allow(caller)) { res.setHeader("retry-after", String(limiter.retryAfterSeconds(caller))); return send(429, { error: "too many requests", code: "rate_limited" }); }
  if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: "send application/json", code: "unsupported_media_type" });
  try {
    const url = new URL(req.url ?? "/", "http://relayer");
    if (req.method === "GET" && url.pathname === "/info") return send(200, await relayer.info());
    if (req.method === "GET" && url.pathname === "/jobs") return send(200, relayer.jobs_());
    if (req.method === "GET" && url.pathname.startsWith("/status/")) {
      const job = await relayer.status(url.pathname.slice("/status/".length) as Hex);
      return job ? send(200, job) : send(404, { error: "unknown transaction" });
    }
    if (req.method === "GET" && url.pathname === "/swap") return send(200, executor.list());
    if (req.method === "GET" && url.pathname.startsWith("/swap/")) {
      const job = executor.get(url.pathname.slice("/swap/".length));
      return job ? send(200, job) : send(404, { error: "unknown swap job" });
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
    if (e instanceof SwapJobError) return send(400, { error: e.message, code: e.code });
    send(500, { error: String((e as Error).message ?? e) });
  }
});
const port = Number(env("PORT", "8790")), host = env("HOST", "127.0.0.1");
server.listen(port, host, () => console.log(`relayer ${relayer.account.address} on http://${host}:${port} — chain ${cfg.chainId}, core ${cfg.core}, fee vault ${cfg.feeVault}, privacy address ${relayer.identity.privacyAddress}`));
