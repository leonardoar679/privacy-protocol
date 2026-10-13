// Main-thread client of the proving worker (src/prover/worker.ts). One worker per proof, terminated
// afterwards. Artifacts: /artifacts/* served by the Vite plugin from ../circuits in dev, or the configuration's
// artifactBase (VITE_ARTIFACT_BASE) in a deployed build. V5 (spec §20): the build's artifact pins (/artifacts.json, same origin)
// travel with the request; the worker refuses a proving key that does not hash to its pin in a production build.
import { secureFetch } from "@privacy-wallet/privacy-engine/transport/http";
import type { Hex } from "viem";
import { publicInputsFromSignals } from "@privacy-wallet/protocol/prover";
import type { CircuitInputs } from "@privacy-wallet/protocol/txInputs";
import { pinsFromManifest, type ArtifactPins } from "./pins";
import type { ProveRequest, ProveResponse } from "./worker";
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

let seq = 0;
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

/** Prove `inputs` in a Web Worker; verifies locally first when the verification key is served. */
export async function proveInBrowser(inputs: CircuitInputs, onStatus?: ProveStatus): Promise<BrowserProof> {
  let verificationKey: unknown;
  try {
    const r = await secureFetch(artifactUrls().verificationKey, {}, "artifacts");
    if (r.ok) verificationKey = await r.json();
  } catch { /* no local verification; the chain verifies anyway */ }
  const pins = await loadPins();
  onStatus?.(verificationKey ? "Proving locally in a Web Worker (the proof is verified locally before submission)…" : "Proving locally in a Web Worker…");
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const id = ++seq;
  const req: ProveRequest = { id, inputs, wasmUrl: artifactUrls().wasm, zkeyUrl: artifactUrls().zkey, verificationKey, pins, production: config().production };
  return new Promise<BrowserProof>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ProveResponse>) => {
      if (e.data.id !== id) return;
      worker.terminate();
      if (!e.data.ok) return reject(new Error(e.data.error));
      const publicSignals = e.data.publicSignals.map(BigInt);
      resolve({ proof: e.data.proof as Hex, publicInputs: publicInputsFromSignals(publicSignals), publicSignals, ms: e.data.ms, verifiedLocally: verificationKey !== undefined, pins: e.data.pins });
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(`proving worker failed: ${e.message}`)); };
    worker.postMessage(req);
  });
}
