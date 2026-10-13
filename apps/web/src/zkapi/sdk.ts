// Private AI (plan §4, §5, §63; docs/zkapi-integration-spec.md): the zkAPI browser SDK as SERVICE
// CREDIT only. The SDK owns the credit wallet (deposit, proofs, leases, settlement, withdrawal) in
// its own IndexedDB journal; this wallet owns the UI, the funding address policy (§4: a fresh
// wallet-derived address) and the provider call. Runtime-key mode only: prompts go from this tab
// straight to the inference provider with a short-lived key; the billing server never sees them.
// Nothing here touches PrivacyCore, the pool notes or the swap engine (plan §85 rules 1, 11).
// The pure parts (transport policy, pin gate, streaming) live in ./policy and are unit-tested.
import { allowHosts, secureFetch } from "../api/transport";
allowHosts("openrouter.ai");
import { configureBrowserSdk, CHAT_SPENDING_TIER_USD } from "@openanonymity/zkapi-browser-sdk";
import client from "@openanonymity/zkapi-browser-sdk/client";
import { privateTransport, ZKAPI_PUBLIC_PATH, type BrowserConfig, type PinCheck } from "./policy";

export * from "./policy";

/** false when the build took the stub for the SDK (vite.config.ts zkapiSdk; src/zkapi/unavailable.ts) */
export const zkapiBundled: boolean = __ZKAPI__;

/** The SDK's Sepolia shared-password dialog contract (sdk/README.md "Sepolia shared password"). */
export interface TestnetPasswordRequest { authenticate: (value: string, o?: { signal?: AbortSignal }) => Promise<void>; signal?: AbortSignal }

let configured = false;
/** Configure once, before the first init; importing the SDK alone does nothing (no worker, no network). */
export function configureZkapi(opts: { requestTestnetPassword?: (req: TestnetPasswordRequest) => Promise<void> } = {}): void {
  if (configured) return;
  configureBrowserSdk({
    configUrl: `${ZKAPI_PUBLIC_PATH}browser-config.json`,
    workerUrl: `${ZKAPI_PUBLIC_PATH}assets/zkapiWasmWorker.js`,
    transport: privateTransport,
    requestTestnetPassword: opts.requestTestnetPassword ?? null,
  });
  configured = true;
}

export async function loadPinCheck(): Promise<PinCheck | null> {
  try {
    const r = await secureFetch(`${ZKAPI_PUBLIC_PATH}pin-check.json`, {}, "zkapi");
    return r.ok ? ((await r.json()) as PinCheck) : null;
  } catch {
    return null;
  }
}

export async function loadBrowserConfig(): Promise<BrowserConfig | null> {
  try {
    const r = await secureFetch(`${ZKAPI_PUBLIC_PATH}browser-config.json`, {}, "zkapi");
    if (!r.ok) return null;
    const cfg = (await r.json()) as BrowserConfig;
    allowHosts(cfg?.trusted_deployment?.rpc_url, cfg?.trusted_deployment?.protocol_server_url, cfg?.trusted_deployment?.openrouter_inference_base); // the deployment's own endpoints (spec §7)
    return cfg;
  } catch {
    return null;
  }
}

/** OpenRouter's public catalog (no key). The provider learns nothing from this read beyond an IP. */
export async function listModels(): Promise<{ id: string; name: string }[]> {
  const r = await secureFetch("https://openrouter.ai/api/v1/models", {}, "inference");
  if (!r.ok) throw new Error(`model catalog HTTP ${r.status}`);
  const j = await r.json();
  return (j.data ?? []).map((m: any) => ({ id: String(m.id), name: String(m.name ?? m.id) }));
}

export { client as zkapiClient, CHAT_SPENDING_TIER_USD };
