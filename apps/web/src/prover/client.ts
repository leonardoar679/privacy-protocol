// The web platform's prover entry and the circuit artifacts' places. Artifacts: /artifacts/* served by the Vite plugin
// from ../circuits in dev, or the configuration's artifactBase (VITE_ARTIFACT_BASE) in a deployed build. V5 (spec §20):
// the build's artifact pins (/artifacts.json, same origin) travel with the request; the worker refuses a proving key
// that does not hash to its pin in a production build. V6 Stage 15: the proof is made in the long-lived crypto worker
// (src/platform/crypto/) — one per unlocked session, not one per proof — from the spend plan.
import { secureFetch } from "@privacy-wallet/privacy-engine/transport/http";
import type { TxSpec } from "@privacy-wallet/protocol/txInputs";
import { pinsFromManifest, type ArtifactPins } from "./pins";
import { config, type ProofResult } from "@privacy-wallet/sdk/config";

/** Where the circuit artifacts are served from (the configuration's artifactBase; V6 Stage 3). */
export function artifactUrls(): { wasm: string; zkey: string; verificationKey: string } {
  const base = config().artifactBase;
  return { wasm: `${base}/transaction.wasm`, zkey: `${base}/transaction_final.zkey`, verificationKey: `${base}/verification_key.json` };
}
/** The pin file ships beside the app (public/artifacts.json), whatever host serves the artifacts themselves. */
export const PIN_URL = "/artifacts.json";

export type ProveStatus = (message: string) => void;
/** The engine's proof shape (packages/sdk/src/config.ts ProofResult): this module is the web platform's prover (V6 Stage 4). */
export type BrowserProof = ProofResult;

let pinsCache: Promise<ArtifactPins> | null = null;

/** The build's pins, read once; absent or unreadable → no pins (the worker then refuses in production, warns in dev). */
export function loadPins(): Promise<ArtifactPins> {
  pinsCache ??= (async () => {
    try {
      const r = await secureFetch(PIN_URL, {}, "artifacts");
      return r.ok ? pinsFromManifest(await r.json()) : {};
    } catch { return {}; }
  })();
  return pinsCache;
}
/** Tests: forget the cached pins. */
export function resetPins(): void { pinsCache = null; }

/**
 * Proves a spend plan (V6 Stage 15, spec v2.0 §14.3): the plan goes to the long-lived crypto worker
 * (src/platform/crypto/), which builds the circuit inputs, reads the proving key from its cache (checked against the pin)
 * and proves — the inputs never exist on this thread.
 */
export async function proveInBrowser(spec: TxSpec, onStatus?: ProveStatus): Promise<BrowserProof> {
  return (await import("../platform/crypto/client")).proveSpend(spec, onStatus);
}
