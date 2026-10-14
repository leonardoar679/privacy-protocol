// The wallet's client of the API (Privacy Wallet Web spec v2.0 §15; apps/api): every /v1 route, typed, through the one
// transport policy (secureFetch). An operation is addressed by its opaque `op_` id — the order id never appears in a URL.
// The wallet stays canonical for money and for the truth of its own reads; the API's records are a second source.
import { secureFetch } from "@privacy-wallet/privacy-engine/transport/http";
import type { OperationState, Quote, SettlementState } from "@privacy-wallet/protocol-types";
import { config } from "../config";

/** The API's base URL from the configuration (the key kept its V5 name). */
export const apiUrl = (): string => config().swapService;

/** A refusal or an outage of the API: its status and catalog code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** The 409 of a hard quote below the minimum the user approved (whale spec §3, §14). */
export class ApiMinimumMoved extends ApiError {
  constructor(
    readonly approvedMin: bigint,
    readonly newMin: bigint,
  ) {
    super(409, "minimum_moved", `the route now guarantees at least ${newMin}, below the ${approvedMin} you approved`);
  }
}

/** `signal` (V6 Stage 16): a request the caller no longer needs is cancelled — a newer quote replaces it. */
export async function apiCall<T>(path: string, body?: unknown, purpose: "swap-service" | "guest" = "swap-service", signal?: AbortSignal): Promise<T> {
  const r = await secureFetch(
    apiUrl() + path,
    {
      ...(body !== undefined ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    },
    purpose,
  );
  const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string; approvedMin?: string; newMin?: string };
  if (!r.ok) {
    if (r.status === 409 && j?.code === "minimum_moved" && j.approvedMin !== undefined && j.newMin !== undefined)
      throw new ApiMinimumMoved(BigInt(j.approvedMin), BigInt(j.newMin));
    throw new ApiError(r.status, j?.code, j?.error ?? `API error ${r.status}`);
  }
  return j as T;
}

/** GET /v1/operations/:id */
export interface OperationView {
  id: string;
  kind: "swap" | "cross-chain";
  state: OperationState;
  settlement: SettlementState | null;
  provider: string;
  tier: string | null;
  createdAt: number;
  updatedAt: number;
  checkedAt: number | null;
}
/** POST /v1/operations/:id/reconcile */
export interface ReconcileView {
  state: OperationState;
  settlement: SettlementState | null;
  delayed?: { code: string };
  reason?: { code: string };
  refs: { executionTx?: string; destinationTx?: string };
  checkedAt: number;
  sources: { relayer: "ok" | "none" | "unreachable"; chain: "ok" | "none" | "unreachable"; provider: "ok" | "none" | "unreachable" };
}
/** The §46 quote the API adds to a quote set (indicative: the wallet computes its own fees). */
export type ApiQuote = Quote;

const opPath = (id: string, action?: string) => `/v1/operations/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

export const api = {
  status: <T>() => apiCall<T>("/v1/status"),
  providersHealth: <T>() => apiCall<T>("/v1/providers/health"),
  assets: <T>() => apiCall<T>("/v1/assets"),
  networks: <T>() => apiCall<T>("/v1/networks"),
  quotes: <T>(body: unknown, signal?: AbortSignal) => apiCall<T>("/v1/quotes", body, "swap-service", signal),
  createOperation: <T>(body: unknown) => apiCall<T>("/v1/operations", body),
  getOperation: (id: string) => apiCall<OperationView>(opPath(id)),
  reconcile: (id: string) => apiCall<ReconcileView>(opPath(id, "reconcile"), {}),
  prepare: <T>(id: string, body: unknown) => apiCall<T>(opPath(id, "prepare"), body),
  finalize: <T>(id: string, signature: string) => apiCall<T>(opPath(id, "finalize"), { signature }),
  resume: <T>(id: string, body: unknown) => apiCall<T>(opPath(id, "resume"), body),
  track: <T>(provider: string, query: URLSearchParams) => apiCall<T>(`/v1/track/${encodeURIComponent(provider)}?${query}`),
  risk: <T>(provider: string) => apiCall<T>(`/v1/risk/${encodeURIComponent(provider)}`),
  guestQuote: <T>(body: unknown) => apiCall<T>("/v1/guest/quote", body, "guest"),
  guestIngress: <T>(body: unknown) => apiCall<T>("/v1/guest/ingress", body, "guest"),
  guestTrack: <T>(provider: string, txid: string) =>
    apiCall<T>(`/v1/guest/track/${encodeURIComponent(provider)}/${encodeURIComponent(txid)}`, undefined, "guest"),
};
