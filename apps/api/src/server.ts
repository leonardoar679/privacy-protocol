// The API's process (spec v2.0 §15): the engine (packages/swap-engine defaultEngine), the database, the reads, the
// retention purge every 10 minutes, the providers' health every 5, the chain's block with it, and the HTTP edge.
//   npx tsx src/server.ts     # http://127.0.0.1:8787
// Env: PORT (8787), HOST (127.0.0.1), DB_PATH (api.sqlite), ALLOWED_ORIGINS, RELAYER_URL, RPC_URLS (also the engine's tip
// and valuation reads), TLS (1 when the API terminates TLS itself: HSTS), RATE_PER_MINUTE (120), TRUST_PROXY_HOPS (the proxies in front of it; default none), and the engine's own
// (CHAIN_ID, SWAP_FACTORY, NATIVE_VAULT, ERC20_VAULTS, REFUND_WINDOW_SECONDS).
import { ASSETS, CHAINS } from "@privacy-wallet/config";
import { createLogger, originsFrom, proxyHopsFrom } from "@privacy-wallet/server-kit";
import { defaultEngine } from "@privacy-wallet/swap-engine/config";
import { gatewayConfigFromEnv } from "@privacy-wallet/swap-engine/gateway";
import { createApp } from "./app";
import { openDb } from "./db";
import { makeReads } from "./reads";
import { Store } from "./store";

const env = process.env;
const log = createLogger();
const engine = defaultEngine();
const store = new Store(openDb(env.DB_PATH ?? "api.sqlite"), log);
store.seedAssets(ASSETS.map((a) => ({ id: `${a.chain}:${a.id}`, chain: a.chain, symbol: a.symbol, decimals: a.decimals, status: a.status })));
store.seedProviders(engine.cfg.adapters.map((a) => a.id));
/** the pool's chain, as the registry names it */
const network = Object.values(CHAINS).find((c) => c.chainId === Number(engine.cfg.chainId))?.id ?? "ethereum";
const reads = makeReads({
  relayerUrl: env.RELAYER_URL?.replace(/\/$/, "") || null,
  rpcUrls: (env.RPC_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  engine,
});

const app = createApp(
  { engine, store, gateway: gatewayConfigFromEnv(), reads, relayerTerms: () => reads.relayerTerms(), now: Date.now },
  {
    origins: originsFrom(env.ALLOWED_ORIGINS, ["http://localhost:5173", "http://127.0.0.1:5173"]),
    tls: env.TLS === "1",
    ratePerMinute: Number(env.RATE_PER_MINUTE ?? 120),
    trustProxyHops: proxyHopsFrom(env.TRUST_PROXY_HOPS),
    log,
  },
);

const purge = () => {
  try {
    store.purge();
  } catch {
    store.event({ event: "retention.failed", level: "error", errorClass: "internal" });
  }
};
const sample = async () => {
  for (const a of engine.cfg.adapters) {
    const h = await a.health().catch(() => ({ reachable: false, halted: false }));
    store.recordHealth(a.id, { reachable: h.reachable, halted: h.halted });
  }
  const block = await reads.blockNumber().catch(() => null);
  if (block !== null) store.chainState(network, block);
};
purge();
setInterval(purge, 10 * 60_000).unref();
void sample();
setInterval(() => void sample(), 5 * 60_000).unref();

const port = Number(env.PORT ?? 8787);
app.listen(port, env.HOST ?? "127.0.0.1", () => store.event({ event: "api.started", network }));
