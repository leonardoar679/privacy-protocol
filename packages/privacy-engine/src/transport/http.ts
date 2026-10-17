// The one place the wallet talks to a network (Privacy Wallet Web spec §7; plan §50): every request leaves with
// no credentials, follows no cross-host redirect, carries no referrer and is never cached; a production build refuses
// a host that is not on the allowlist (the deployment's RPC endpoints, relayers, the swap service, the beacon APIs,
// the THORNode gateways, the artefact host, the zkAPI deployment — all from the environment or registered by the
// module that needs them); every request is announced to the listeners, which is how the privacy-leakage gate sees
// it. The viem transport carries the same policy. A private read transport (Tor, a mixnet, a native light client)
// plugs in here and nowhere else.
import { http, type HttpTransport } from "viem";
import { observed } from "./connectivity";

export type Purpose = "rpc" | "relayer" | "swap-service" | "beacon" | "thornode" | "artifacts" | "zkapi" | "inference" | "guest" | "other";
/** The purpose registry (V6 Stage 14, spec v2.0 §7.10): every purpose a request can carry — the Privacy Center words each
 *  one ("Data sent to services"), and a purpose added here without its words fails apps/web/test/privacy-center.test.tsx. */
export const PURPOSES: readonly Purpose[] = ["rpc", "relayer", "swap-service", "beacon", "thornode", "artifacts", "zkapi", "inference", "guest", "other"];
export interface RequestRecord { url: string; host: string; method: string; purpose: Purpose; at: number }

/** The policy every request carries; a caller's own `credentials` or `redirect` never overrides it. */
export const POLICY = { credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" } as const;

const listeners = new Set<(r: RequestRecord) => void>();
const allowed = new Set<string>();
// a production build turns strict on through the platform's configuration (apps/web/src/config.ts applyConfig, V6 Stage 3)
let strict = false;

export class TransportRefusal extends Error {
  constructor(readonly host: string) { super(`refused a request to ${host}: not an endpoint of this deployment`); }
}

/** Announces every request to the listener until the returned function is called. */
export function onRequest(l: (r: RequestRecord) => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

const OWN_ORIGIN = "own-origin.invalid";
export function hostOf(url: string): string | null {
  // resolved as fetch resolves it, against a stand-in for the page's origin (2026-10-17, the audit's unverified m66): a
  // protocol-relative "//host/…" (or "/\host/…", which the URL parser reads the same) had read as the page's own origin
  // and passed the strict allowlist; a relative path is still the page's own origin ("")
  try {
    const host = new URL(url, `https://${OWN_ORIGIN}/`).hostname.toLowerCase();
    return host === OWN_ORIGIN ? "" : host;
  } catch {
    return null;
  }
}

/** Allows hosts (plain names or URLs); a comma-separated list is accepted. */
export function allowHosts(...entries: (string | undefined | null)[]): void {
  for (const e of entries) {
    if (!e) continue;
    for (const part of e.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(part)) { const h = hostOf(part); if (h) allowed.add(h); continue; } // a URL
      const h = part.split("/")[0].split(":")[0].toLowerCase(); // a plain host, with or without a port or a path
      if (h) allowed.add(h);
    }
  }
}
export const allowedHosts = (): string[] => [...allowed].sort();
export const isStrict = (): boolean => strict;
/** Tests and dev: the allowlist is enforced only in strict mode (a production build). */
export function setStrict(on: boolean): void { strict = on; }

export function checkUrl(url: string): { host: string } {
  const host = hostOf(url);
  if (host === null) throw new TransportRefusal(url);
  if (strict && host !== "" && !allowed.has(host)) throw new TransportRefusal(host);
  return { host };
}

function announce(url: string, method: string, purpose: Purpose): void {
  const host = hostOf(url) ?? "";
  const record: RequestRecord = { url, host, method: method.toUpperCase(), purpose, at: Date.now() };
  for (const l of listeners) l(record);
}

/** `fetch` under the policy: the global fetch of the moment (tests replace it), the allowlist, the announcement. */
export async function secureFetch(url: string, init: RequestInit = {}, purpose: Purpose = "other"): Promise<Response> {
  checkUrl(url);
  announce(url, init.method ?? "GET", purpose);
  // V6 Stage 15 (doc §75): every answer and every network failure feeds the connectivity state
  return observed(fetch(url, { ...POLICY, ...init, credentials: POLICY.credentials, redirect: POLICY.redirect }));
}

/** A `fetch`-shaped function under the policy, for the modules that take a fetch implementation as a parameter. */
export function fetchFor(purpose: Purpose): typeof fetch {
  return (input, init) => secureFetch(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init ?? {}, purpose);
}

export interface JsonResult<T> { ok: boolean; status: number; json: T | null; text: string }

/** A JSON request: the body serialized, the answer parsed when it parses (the raw text kept for an error line). */
export async function fetchJson<T>(url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {}, purpose: Purpose = "other"): Promise<JsonResult<T>> {
  const init: RequestInit = {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: { accept: "application/json", ...(opts.body === undefined ? {} : { "content-type": "application/json" }), ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal ?? (opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined),
  };
  const r = await secureFetch(url, init, purpose);
  const text = await r.text();
  let json: T | null = null;
  try { json = JSON.parse(text) as T; } catch { json = null; }
  return { ok: r.ok, status: r.status, json, text };
}

/** viem's HTTP transport under the same policy, announcing its requests as `rpc`. */
export function viemTransport(url: string): HttpTransport {
  allowHosts(url);
  return http(url, {
    batch: true,
    fetchOptions: { credentials: POLICY.credentials, redirect: POLICY.redirect, referrerPolicy: POLICY.referrerPolicy },
    onFetchRequest: (request) => { announce(request.url, request.method, "rpc"); },
    fetchFn: (input, init) => observed(fetch(input, init)),
  });
}

// the deployment's own endpoints come from the configuration (apps/web/src/config.ts applyConfig; spec §7)
allowHosts("127.0.0.1", "localhost"); // the local stack's defaults (sdk/relayer.ts, sdk/swapService.ts)
