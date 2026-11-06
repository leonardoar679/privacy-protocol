// The relayer transport (spec v3.0 §7.5): JSON over fetch with a timeout, no credentials, the status code and the parsed
// body back for the client to judge. One of the two places the app reaches the network (the other is rpc.ts).
import type { RelayerAnswer, RelayerTransport } from "../relayer/client";
import { readCapped } from "./capped";

/** A relayer's status or job answer is a few hundred bytes; past this it is not read (C11-11). */
export const RELAYER_ANSWER_MAX = 64 * 1024;

export interface RelayerTransportOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function relayerTransport({ timeoutMs = 10_000, fetchImpl = fetch }: RelayerTransportOptions = {}): RelayerTransport {
  const send = async (url: string, init: RequestInit): Promise<RelayerAnswer> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: ctl.signal, credentials: "omit", headers: { accept: "application/json", ...(init.headers ?? {}) } });
      const text = await readCapped(res, RELAYER_ANSWER_MAX);
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    getJson: (url) => send(url, { method: "GET" }),
    postJson: (url, body) => send(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}
