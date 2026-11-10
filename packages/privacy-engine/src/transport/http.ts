// The one place the wallet talks to a network (Privacy Wallet Web spec §7; plan §50): every request leaves with
// no credentials, follows no cross-host redirect, carries no referrer and is never cached; a production build refuses
// a host that is not on the allowlist (the deployment's RPC endpoints, relayers, the swap service, the beacon APIs,
// the THORNode gateways, the artefact host, the zkAPI deployment — all from the environment or registered by the
// module that needs them); every request is announced to the listeners, which is how the privacy-leakage gate sees
// it. The viem transport carries the same policy. A private read transport (Tor, a mixnet, a native light client)
// plugs in here and nowhere else.
import { createTransport, http, ResponseBodyTooLargeError, type HttpTransport, type HttpTransportConfig } from "viem";
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

/**
 * A third party's answer larger than its reader's bound (the eleventh review round, 2026-11-04): the read is cancelled, never a truncated answer
 * parsed.
 */
export class AnswerTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`the answer is larger than ${maxBytes} bytes: not read`);
    this.name = "AnswerTooLarge";
  }
}
/** The default bound of an answer read whole (8 MiB: far past any answer this wallet reads, far below what exhausts a phone's tab). */
export const ANSWER_MAX_BYTES = 8 * 1024 * 1024;

/**
 * An answer's body read to at most `maxBytes` (the eleventh review round, 2026-11-04, the completeness critic): a declared length past it is not
 * read at all; a stream past it is cancelled there.
 */
export async function readCapped(r: Response, maxBytes: number = ANSWER_MAX_BYTES): Promise<string> {
  const declared = Number(r.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await r.body?.cancel().catch(() => undefined);
    throw new AnswerTooLarge(maxBytes);
  }
  if (!r.body) return r.text();
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AnswerTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export interface JsonResult<T> { ok: boolean; status: number; json: T | null; text: string }

/** A JSON request: the body serialized, the answer parsed when it parses (the raw text kept for an error line). */
export async function fetchJson<T>(url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}, purpose: Purpose = "other"): Promise<JsonResult<T>> {
  const init: RequestInit = {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: { accept: "application/json", ...(opts.body === undefined ? {} : { "content-type": "application/json" }), ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal ?? (opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined),
  };
  const r = await secureFetch(url, init, purpose);
  const text = await readCapped(r, opts.maxBytes ?? ANSWER_MAX_BYTES);
  let json: T | null = null;
  try { json = JSON.parse(text) as T; } catch { json = null; }
  return { ok: r.ok, status: r.status, json, text };
}

/**
 * The bound of an RPC answer (the twelfth review round, C12-2): viem's own default made explicit. A log read (`eth_getLogs`) goes alone, so
 * the bound is its answer's: past it, the windowed log reader (sdk chain.ts `logsInWindows`) reads that endpoint's history in windows —
 * viem's refusal had been no refusal for its size to that reader, and an endpoint without a cap of its own below this one failed every sync
 * once the pool's events passed it (some ten thousand). Every other request is batched, the bound then the batch's answer's.
 */
export const RPC_ANSWER_MAX_BYTES = 10 * 1024 * 1024;
/**
 * The code a log read's answer past the bound carries (an HTTP 413's): viem retries an error with no code three more times — three more
 * downloads of the same answer, each to the bound — and none whose code it does not list. That answer is the endpoint's for this range: the
 * windowed reader asks smaller ones instead.
 */
export const ANSWER_TOO_LARGE_CODE = 413;
const notRetried = (e: unknown): unknown => {
  if (e instanceof ResponseBodyTooLargeError && !("code" in e)) Object.defineProperty(e, "code", { value: ANSWER_TOO_LARGE_CODE, enumerable: true, configurable: true });
  return e;
};

/**
 * viem's HTTP transport under the same policy, announcing its requests as `rpc`: batched, but a log read alone — its answer past
 * RPC_ANSWER_MAX_BYTES refused, never asked again by viem's retry.
 */
export function viemTransport(url: string): HttpTransport {
  allowHosts(url);
  const options = (batch: boolean): HttpTransportConfig => ({
    batch,
    maxResponseBodySize: RPC_ANSWER_MAX_BYTES,
    fetchOptions: { credentials: POLICY.credentials, redirect: POLICY.redirect, referrerPolicy: POLICY.referrerPolicy },
    onFetchRequest: (request) => { announce(request.url, request.method, "rpc"); },
    fetchFn: (input, init) => observed(fetch(input, init), { abortIsTimeout: true }), // the only abort here is viem's timeout
  });
  const batched = http(url, options(true));
  const alone = http(url, options(false));
  return ((config: Parameters<HttpTransport>[0]) => {
    const t = batched(config);
    // the requests before viem's retry, which createTransport wraps around them. A log read goes alone, so its answer is its own: batched, an
    // answer past the bound had failed the reads beside it, unretried — readView's leaf count and root, every sync of a dense first window
    // (ZI's critique); its refusal is marked, never retried. The caller's options (its signal) go with every request
    const many = t.config.request;
    const one = alone(config).config.request;
    const request = (async (args: Parameters<typeof many>[0], opts?: Parameters<typeof many>[1]) => {
      if (args.method !== "eth_getLogs") return many(args, opts);
      try {
        return await one(args, opts);
      } catch (e) {
        throw notRetried(e);
      }
    }) as typeof many;
    return createTransport({ ...t.config, request }, t.value);
  }) as HttpTransport;
}

// the deployment's own endpoints come from the configuration (apps/web/src/config.ts applyConfig; spec §7), and nothing
// else is allowed in strict mode (audit round 2, n77): the loopback hosts had been, on any port, so a production build's
// relayer or swap service set in Advanced could reach a service on the user's own machine, with only the content security
// policy in the way. A build whose endpoints are on loopback (the local stack's) names them, and the development build is
// not strict.
