// Pure policy and protocol helpers of the Private AI integration — no SDK import, so they can be
// tested in node: the transport policy (plan §5: runtime-key only, never proxy), the pin gate
// (spec §3), the OpenAI-compatible streaming call to the provider, and session ids.
import { fetchFor, secureFetch } from "../api/transport"; // V5 (spec §7): the one transport policy

export type ZkapiTransport = (url: string, init: RequestInit, hints: { preferProxy?: boolean }) => Promise<Response>;

export const ZKAPI_PUBLIC_PATH = "/zkapi/";

/** Written by scripts/check-zkapi-pins.mjs at build time (spec §3): zkAPI stays disabled unless it passed. */
export interface PinCheck {
  network: "mainnet" | "sepolia";
  checkedAt: string;
  pass: number;
  fail: number;
  deploymentId: string;
  vault: string;
  circuit: string;
  protocolServer: string;
  items: { name: string; ok: boolean; detail?: string }[];
  lab: { pass: number; fail: number };
}

export interface BrowserConfig { trusted_deployment: { chain_id: number; contract_address: string; rpc_url: string; protocol_server_url: string; openrouter_inference_base: string; deployment_id: string; request_charge_cap: number | string } }

/** Spec §5 transport policy: no proxy (plan §5), no credentials, no redirects. A native host plugs Tor / a mixnet in here. */
export const privateTransport: ZkapiTransport = (url, init, hints = {}) => {
  if (hints.preferProxy) return Promise.reject(new Error("proxy mode is disabled (plan §5): the billing server must not relay provider traffic"));
  return secureFetch(url, init ?? {}, "zkapi");
};

/** zkAPI features are enabled only by a passing, recent pin check (spec §3: never a silent fallback). */
export function zkapiEnabled(pin: PinCheck | null, maxAgeHours = 24 * 7, now = Date.now()): boolean {
  if (!pin || pin.fail !== 0 || !pin.lab || pin.lab.fail !== 0) return false;
  const t = Date.parse(pin.checkedAt);
  return Number.isFinite(t) && now - t >= 0 && now - t < maxAgeHours * 3600_000;
}

/** What `client.acquireInferenceAccess` returns: a short-lived provider key bound to a USD cap. */
export interface InferenceAccess {
  mode: "ephemeral-key";
  apiKey: string;
  baseUrl: string;
  spendingLimitUsd: number;
  headers: Record<string, string>;
  release: () => void;
}

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Content deltas of an OpenAI-compatible SSE stream (`data: {...}` lines, `[DONE]` ends it). */
export async function* parseSseDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      } catch { /* keep-alive or partial line */ }
    }
  }
}

/** OpenAI-compatible streaming completion straight to the provider with the lease's key (runtime-key mode). */
/** The policy fetch for the inference provider (the trade check imports it from here, its one value import). */
export const inferenceFetch: typeof fetch = fetchFor("inference");

export async function* chatStream(access: InferenceAccess, model: string, messages: ChatMessage[], signal?: AbortSignal, fetchImpl: typeof fetch = inferenceFetch): AsyncGenerator<string> {
  const r = await fetchImpl(`${access.baseUrl}/chat/completions`, {
    method: "POST", headers: access.headers, body: JSON.stringify({ model, messages, stream: true }), signal, credentials: "omit", redirect: "error",
  });
  if (!r.ok || !r.body) throw new Error(`provider HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  yield* parseSseDeltas(r.body);
}

export const newSessionId = (): string => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
