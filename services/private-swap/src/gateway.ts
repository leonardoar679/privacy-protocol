// The metered quote-service interface (whale spec §22; plan V2 §33–§37, §77–§81): the same engine behind
// a zkAPI capability — POST /gateway/quote with `Authorization: zkapi <runtime key>` (runtime-key mode
// only), a random 16-byte request id per request that is never reused and never derived from the user,
// no account, no cookie, metered per request within zkAPI's charge cap. The gateway sees the request
// (assets, amount, a placeholder destination) and the caller's IP; it keeps no user data.
//
// Status: blocked upstream. The live zkAPI deployments lease OpenRouter keys only; this gateway becomes
// live when a zkAPI deployment registers an upstream of this service's kind (ZKAPI_UPSTREAM names it). Until
// then the interface exists, health() says "not available upstream" and every quote answers 503 with the
// reason and a request id — the wallet does not pretend otherwise.
import { randomBytes } from "crypto";

export interface GatewayConfig {
  /** the zkAPI deployment that leases runtime keys for this service; null while none exists */
  upstream: string | null;
  /** zkAPI's per-request charge cap, informative */
  requestChargeCap?: number;
}

export const gatewayConfigFromEnv = (env: Record<string, string | undefined> = process.env): GatewayConfig => ({ upstream: env.ZKAPI_UPSTREAM?.trim() || null, ...(env.ZKAPI_REQUEST_CHARGE_CAP ? { requestChargeCap: Number(env.ZKAPI_REQUEST_CHARGE_CAP) } : {}) });

export const NOT_AVAILABLE = "not available upstream: the live zkAPI deployments lease OpenRouter keys only; this gateway goes live when a zkAPI deployment registers an upstream of this service's kind";

/** A random 16-byte request id: never reused, never derived from the caller (spec §22). */
export const newRequestId = (): string => randomBytes(16).toString("hex");

/** `Authorization: zkapi <runtime key>`; the key is never logged and never echoed. */
export function parseRuntimeKey(header: string | undefined): { key: string } | { error: string } {
  if (!header) return { error: "missing Authorization: zkapi <runtime key>" };
  const m = /^zkapi\s+(\S+)$/i.exec(header.trim());
  if (!m) return { error: "the Authorization scheme must be zkapi <runtime key> (runtime-key mode only)" };
  if (m[1].length < 16) return { error: "the runtime key is too short" };
  return { key: m[1] };
}

export interface GatewayHealth { capability: "zkapi"; auth: "runtime-key"; available: boolean; upstream: string | null; reason?: string; requestChargeCap?: number }

export function gatewayHealth(cfg: GatewayConfig): GatewayHealth {
  return { capability: "zkapi", auth: "runtime-key", available: cfg.upstream !== null, upstream: cfg.upstream, ...(cfg.upstream === null ? { reason: NOT_AVAILABLE } : {}), ...(cfg.requestChargeCap !== undefined ? { requestChargeCap: cfg.requestChargeCap } : {}) };
}

/**
 * The metered quote: authorize the runtime key, assign a request id, then quote through `quote` (the engine's
 * indicative competition with placeholders). While no upstream exists the answer is 503 with the reason; a
 * bad or missing key is 401. The body and the key are never kept.
 */
export async function gatewayQuote(cfg: GatewayConfig, headers: Record<string, string | string[] | undefined>, body: unknown, quote: (body: unknown, requestId: string) => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const requestId = newRequestId();
  const raw = headers.authorization ?? headers.Authorization;
  const auth = parseRuntimeKey(Array.isArray(raw) ? raw[0] : raw);
  if ("error" in auth) return { status: 401, body: { error: auth.error, requestId } };
  if (cfg.upstream === null) return { status: 503, body: { error: NOT_AVAILABLE, requestId, capability: "zkapi" } };
  try {
    return { status: 200, body: { requestId, result: await quote(body, requestId) } };
  } catch (e) {
    return { status: 502, body: { error: String((e as Error)?.message ?? e).replace(auth.key, "[key]"), requestId } };
  }
}
