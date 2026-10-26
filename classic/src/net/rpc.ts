// The Classic app's JSON-RPC transport (spec v3.0 §7.5): the configured endpoints tried in order for every call, a
// timeout per attempt, an endpoint's error answer surfaced with its code and message (the sync reads "range" refusals
// to size its windows). The only place the app reaches a chain endpoint.
import type { Rpc } from "../history/sync";

export class RpcError extends Error {
  readonly code: number | null;
  readonly endpoint: string;
  constructor(message: string, code: number | null, endpoint: string) {
    super(message);
    this.code = code;
    this.endpoint = endpoint;
  }
}

export interface RpcOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Fails over to the next endpoint on a network error, an HTTP error or an error answer; throws the last error. */
export function makeRpc(urls: readonly string[], { timeoutMs = 20_000, fetchImpl = fetch }: RpcOptions = {}): Rpc {
  if (!urls.length) throw new Error("no RPC endpoint configured");
  let id = 0;
  return async (method, params) => {
    let last: Error | null = null;
    for (const url of urls) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: ctl.signal,
          credentials: "omit",
        });
        if (!res.ok) throw new RpcError(`HTTP ${res.status}`, null, url);
        const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
        if (body.error) throw new RpcError(body.error.message ?? "the endpoint answered an error", body.error.code ?? null, url);
        return body.result;
      } catch (e) {
        last = e instanceof RpcError ? e : new RpcError(e instanceof Error ? e.message : "the endpoint did not answer", null, url);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last ?? new RpcError("no RPC endpoint", null, "");
  };
}
