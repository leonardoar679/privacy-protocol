// The API's process (spec v2.0 §15): the engine (packages/swap-engine defaultEngine), the database, the reads, the
// retention purge every 10 minutes, the providers' health every 5, the chain's block with it, and the HTTP edge.
//   npx tsx src/server.ts     # http://127.0.0.1:8787
// Env: PORT (8787), HOST (127.0.0.1), DB_PATH (api.sqlite), ALLOWED_ORIGINS, RELAYER_URL, RPC_URLS (also the engine's tip
// and valuation reads), TLS (1 when the API terminates TLS itself: HSTS), RATE_PER_MINUTE (120), TRUST_PROXY_HOPS (the proxies in front of it; default none), API_VOUCH_KEY (the key that
// vouches for the orders it commits and the calls it prepares, for the relayers; unset: none), SHIELD_FACTORY (the receipts
// it vouches for), EXPOSURE_POLICY_FILE (a JSON override of the exposure-policy table, V7 Stage 13), and the engine's own
// (CHAIN_ID, SWAP_FACTORY, NATIVE_VAULT, ERC20_VAULTS, REFUND_WINDOW_SECONDS).
import { readFileSync } from "node:fs";
import { ASSETS, CHAINS } from "@privacy-wallet/config";
import { exposurePolicyFrom, useExposurePolicy } from "@privacy-wallet/protocol/wallet/exposurePolicy";
import { addressListSetting, createLogger, intSetting, originsFrom, proxyHopsFrom } from "@privacy-wallet/server-kit";
import { voucherFrom } from "./vouch";

/** SHIELD_FACTORY: the ShieldReceiverFactory whose receipts the API vouches for; unset, none (a malformed one stops the start). */
function shieldFactoryFrom(raw: string | undefined): string | null {
  const f = raw?.trim();
  if (!f) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(f)) throw new Error(`SHIELD_FACTORY must be the ShieldReceiverFactory's address, not ${JSON.stringify(raw)}`);
  return f;
}
import { defaultEngine } from "@privacy-wallet/swap-engine/config";
import { gatewayConfigFromEnv } from "@privacy-wallet/swap-engine/gateway";
import { createApp } from "./app";
import { openDb } from "./db";
import { makeReads } from "./reads";
import { Store } from "./store";

const env = process.env;
// V7 Stage 13 (spec v3.0 §4): the exposure-policy table is configurable — EXPOSURE_POLICY_FILE names a JSON object keyed by
// tier whose rows replace the compiled ones field by field; a malformed file stops the start, naming the field
if (env.EXPOSURE_POLICY_FILE) useExposurePolicy(exposurePolicyFrom(JSON.parse(readFileSync(env.EXPOSURE_POLICY_FILE, "utf8"))));
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
  {
    engine,
    store,
    gateway: gatewayConfigFromEnv(),
    reads,
    relayerTerms: () => reads.relayerTerms(),
    now: Date.now,
    voucher: voucherFrom(env.API_VOUCH_KEY, addressListSetting(env, "API_VOUCHER_PREVIOUS")),
    shieldFactory: shieldFactoryFrom(env.SHIELD_FACTORY),
    maxOpenOperations: intSetting(env, "MAX_OPEN_OPERATIONS", 50_000, { min: 1, max: 100_000_000 }), // the eighth review round (A-M2)
  },
  {
    origins: originsFrom(env.ALLOWED_ORIGINS, ["http://localhost:5173", "http://127.0.0.1:5173"]),
    tls: env.TLS === "1",
    ratePerMinute: intSetting(env, "RATE_PER_MINUTE", 120, { min: 1, max: 1_000_000 }), // strict: a malformed number stops the start
    trustProxyHops: proxyHopsFrom(env.TRUST_PROXY_HOPS),
    commitsPerMinute: intSetting(env, "COMMITS_PER_MINUTE", 4, { min: 1, max: 1_000_000 }), // the eighth review round (A-M2)
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

const port = intSetting(env, "PORT", 8787, { min: 0, max: 65_535 });
app.listen(port, env.HOST ?? "127.0.0.1", () => store.event({ event: "api.started", network }));
