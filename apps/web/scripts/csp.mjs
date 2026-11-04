// The content security policy and the response headers of a deployed build (Privacy Wallet Web spec §20; Stage 11).
// The policy is written into the built index.html as a <meta http-equiv> by the Vite plugin below (a static host that
// cannot set headers still gets it) and belongs in the server's headers too (docs/deployment.md: nginx and Caddy
// snippets). Every host the wallet may talk to comes from the build's VITE_* environment — the RPC endpoints, the
// relayers, the swap service, the beacon APIs, the THORNode gateways, an artifact host, WalletConnect's relay when a
// project id is set — and from the zkAPI profile's pinned hosts; nothing else is reachable. No inline script, no
// third-party script, no remote style or font; WASM needs 'wasm-unsafe-eval' (snarkjs and the Rust core), the prover
// runs in a same-origin worker, wallet icons arrive as data: URIs.
import { existsSync, readFileSync } from "node:fs";

/** The headers a server adds beside the policy (frame-ancestors cannot live in a meta tag). */
export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cache-Control": "no-store",
});

const LIST_VARS = ["VITE_RPC_URLS", "VITE_RPC_URL", "VITE_RELAYER_URL", "VITE_RELAYER_URLS", "VITE_SWAP_SERVICE", "VITE_BEACON_URLS", "VITE_THORNODE_URLS", "VITE_ARTIFACT_BASE"];
/**
 * The hosts the wallet uses when the build names none (the audit round of 2026-10-16, c59): the THORNode gateways of
 * packages/sdk/src/config.ts DEFAULTS and the beacon APIs of packages/sdk/src/lightclient/spec.ts for mainnet and Sepolia
 * (apps/web/test/csp.test.ts keeps them equal). A build that kept them blocked them in its own policy: verified spends and
 * scans failed, no THORChain swap signed, and the refused requests turned the wallet offline.
 */
export const DEFAULT_THORNODE_GATEWAYS = ["https://gateway.liquify.com/chain/thorchain_api", "https://rest.cosmos.directory/thorchain", "https://thorchain-thornode-lb-1.thorwallet.org"];
export const DEFAULT_BEACON_APIS = {
  1: ["https://lodestar-mainnet.chainsafe.io", "https://ethereum-beacon-api.publicnode.com"],
  11155111: ["https://lodestar-sepolia.chainsafe.io", "https://ethereum-sepolia-beacon-api.publicnode.com"],
};

/** The hosts a build uses without naming them: the default gateways and, on mainnet or Sepolia, the default beacon APIs. */
export function defaultHosts(env = {}) {
  const out = [];
  if (!String(env.VITE_THORNODE_URLS ?? "").trim()) out.push(...DEFAULT_THORNODE_GATEWAYS);
  if (!String(env.VITE_BEACON_URLS ?? "").trim()) out.push(...(DEFAULT_BEACON_APIS[Number(env.VITE_CHAIN_ID ?? 31337)] ?? []));
  return out;
}
// WalletConnect's relay (the pairing's socket) by exact host — never a wildcard: `*.walletconnect.org` had let the telemetry
// host (pulse) and the provider's own RPC host through (the review round of 2026-11-02). That RPC host is absent on purpose:
// the wallet reads through its own endpoints, and a method the provider would route there fails instead of leaking
const WALLETCONNECT = ["https://relay.walletconnect.com", "wss://relay.walletconnect.com", "https://relay.walletconnect.org", "wss://relay.walletconnect.org"];
// V7 Stage 16 (spec v3.0 §9): with a project id, the modal's wallet list and logos (AppKit's API, the explorer) and the verify
// iframe; WalletConnect's telemetry host (pulse) is absent on purpose — the policy stops it
const WALLETCONNECT_MODAL = ["https://api.web3modal.org", "https://api.web3modal.com", "https://explorer-api.walletconnect.com"];
const WALLETCONNECT_VERIFY = ["https://verify.walletconnect.com", "https://verify.walletconnect.org"];

/** `https://host[:port]` of an absolute URL, or null for a relative path or garbage. */
export function originOf(value) {
  try {
    const u = new URL(String(value).trim());
    if (!/^(https?|wss?):$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}

/** The connect-src entries of a build: the environment's hosts, WalletConnect when enabled, the extra (zkAPI) hosts. */
export function connectHosts(env = {}, extra = []) {
  const out = new Set();
  for (const name of LIST_VARS) {
    for (const part of String(env[name] ?? "").split(",")) { const o = originOf(part); if (o) out.add(o); }
  }
  for (const h of defaultHosts(env)) { const o = originOf(h); if (o) out.add(o); }
  if (env.VITE_WC_PROJECT_ID) for (const h of [...WALLETCONNECT, ...WALLETCONNECT_MODAL]) out.add(h);
  for (const e of extra) { const o = originOf(e); if (o) out.add(o); }
  return [...out];
}

/** The hosts of the zkAPI profile a build ships (public/zkapi/browser-config.json), when the assets were built. */
export function zkapiHosts(configPath) {
  if (!configPath || !existsSync(configPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const T = cfg.trusted_deployment ?? {};
    // the profile's RPC (the fresh funding account, the SDK's price and vault reads), the OA verifier (the lease key's check) and the
    // indexer too (the eighth review round, 2026-11-03, C-L5): the policy had blocked hosts the code calls
    return [cfg.deployment_manifest_url, ...(cfg.allowed_deployment_manifest_urls ?? []), T.protocol_server_url, T.openrouter_inference_base, T.rpc_url, T.verifier_url, T.indexer_url].filter(Boolean);
  } catch { return []; }
}

/** The policy string. */
export function buildCsp(env = {}, extra = []) {
  const wc = !!env.VITE_WC_PROJECT_ID;
  const connect = ["'self'", ...connectHosts(env, extra)];
  const img = ["'self'", "data:", "blob:", ...(wc ? WALLETCONNECT_MODAL : [])]; // the wallets' logos from the modal's API and the explorer, by exact host
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    `img-src ${img.join(" ")}`,
    `frame-src ${wc ? WALLETCONNECT_VERIFY.join(" ") : "'none'"}`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** The meta tag the built index.html carries, first in <head>. */
export function cspMeta(env = {}, extra = []) {
  return { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: buildCsp(env, extra) }, injectTo: "head-prepend" };
}

/** The Vite plugin: build only (the dev server needs its own inline scripts and websocket). */
export function cspPlugin(env = {}, extra = []) {
  return {
    name: "csp-meta",
    apply: "build",
    transformIndexHtml() { return [cspMeta(env, extra)]; },
  };
}

/** Reads the policy back from a built index.html (the pin check and the CSP test). */
export function cspOfHtml(html) {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&") : null;
}
