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
const WALLETCONNECT = ["https://relay.walletconnect.com", "wss://relay.walletconnect.com", "https://relay.walletconnect.org", "wss://relay.walletconnect.org", "https://*.walletconnect.com", "https://*.walletconnect.org", "https://*.reown.com", "wss://*.reown.com"];

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
  if (env.VITE_WC_PROJECT_ID) for (const h of WALLETCONNECT) out.add(h);
  for (const e of extra) { const o = originOf(e); if (o) out.add(o); }
  return [...out];
}

/** The hosts of the zkAPI profile a build ships (public/zkapi/browser-config.json), when the assets were built. */
export function zkapiHosts(configPath) {
  if (!configPath || !existsSync(configPath)) return [];
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    const T = cfg.trusted_deployment ?? {};
    return [cfg.deployment_manifest_url, ...(cfg.allowed_deployment_manifest_urls ?? []), T.protocol_server_url, T.openrouter_inference_base].filter(Boolean);
  } catch { return []; }
}

/** The policy string. */
export function buildCsp(env = {}, extra = []) {
  const connect = ["'self'", ...connectHosts(env, extra)];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data: blob:",
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
