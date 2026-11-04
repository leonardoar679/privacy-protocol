// The Classic app's content security policy and response headers (spec v3.0 §7.8): written into the built index.html
// as a <meta http-equiv> by the Vite plugin below and sent as a header by the host (docs/deployment.md). Every host the
// app may talk to comes from the build's VITE_CLASSIC_* environment — the RPC endpoints, extra relayers, where the
// history snapshots and the proving artifacts are served — plus the curated relayers of classic/relayers.json (the list
// scripts/relayers.mjs writes from the registry), and nothing else. No inline script, no eval (the circuit's
// templates are precompiled at build time, spec §7.3), WASM through 'wasm-unsafe-eval' (websnark), the prover's workers
// same-origin or Blob URLs (websnark spawns its sub-workers from a Blob).
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

export const LIST_VARS = ["VITE_CLASSIC_RPC_URLS", "VITE_CLASSIC_RELAYER_URLS", "VITE_CLASSIC_DATA_BASE", "VITE_CLASSIC_ARTIFACT_BASE"];

/** `https://host[:port]` of an absolute URL, or null for a relative path or garbage. */
export function originOf(value) {
  try {
    const u = new URL(String(value).trim());
    if (!/^(https?|wss?):$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** The curated relayers' origins (classic/relayers.json), or none when the list is absent. */
export function curatedRelayerOrigins(file = new URL("../relayers.json", import.meta.url)) {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    // a hostname without a public suffix (registry garbage: "https://livetobecomeavillain") names nothing a policy should allow (the sixth review round, 2026-11-03)
    return (list.relayers ?? []).map((r) => originOf(r.url)).filter((o) => o && /\.[a-z0-9-]+$/i.test(new URL(o).hostname));
  } catch {
    return [];
  }
}

/** The connect-src entries of a build: the environment's hosts and the extra origins, deduplicated; a relative base adds nothing. */
export function connectHosts(env = {}, extra = [], o = {}) {
  const out = new Set();
  for (const x of extra) if (originOf(x)) out.add(originOf(x));
  for (const name of LIST_VARS) {
    // operator-named relayers are a development setting the app refuses in a production build (src/config.ts): a .env left from
    // development must not widen the production policy (the sixth review round, 2026-11-03)
    if (o.production && name === "VITE_CLASSIC_RELAYER_URLS") continue;
    for (const part of String(env[name] ?? "").split(",")) {
      const o = originOf(part);
      if (o) out.add(o);
    }
  }
  return [...out];
}

/** The policy string. */
export function buildCsp(env = {}, extra = [], o = {}) {
  const connect = ["'self'", ...connectHosts(env, extra, o)];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    `connect-src ${connect.join(" ")}`,
    "img-src 'self' data: blob:",
    "style-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** The meta tag the built index.html carries, first in <head>. */
export function cspMeta(env = {}, extra = [], o = {}) {
  return { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: buildCsp(env, extra, o) }, injectTo: "head-prepend" };
}

/** The Vite plugin: build only (the dev server needs its own inline scripts and websocket). */
export function cspPlugin(env = {}, extra = [], o = {}) {
  return {
    name: "classic-csp-meta",
    apply: "build",
    transformIndexHtml() {
      return [cspMeta(env, extra, o)];
    },
  };
}

/** Reads the policy back from a built index.html. */
export function cspOfHtml(html) {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&") : null;
}

/** The policy of a built index.html on disk, or null. */
export function cspOfBuild(indexHtml) {
  return existsSync(indexHtml) ? cspOfHtml(readFileSync(indexHtml, "utf8")) : null;
}
