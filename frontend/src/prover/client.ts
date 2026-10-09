// Main-thread client of the proving worker (src/prover/worker.ts). One worker per proof, terminated
// afterwards. Artifacts: /artifacts/* served by the Vite plugin from ../circuits in dev, or
// VITE_ARTIFACT_BASE in a deployed build. V5 (spec §20): the build's artifact pins (/artifacts.json, same origin)
// travel with the request; the worker refuses a proving key that does not hash to its pin in a production build.
import { secureFetch } from "../api/transport";
import type { Hex } from "viem";
import { publicInputsFromSignals, type PublicInputs } from "@ref/prover";
import type { CircuitInputs } from "@ref/txInputs";
import { pinsFromManifest, type ArtifactPins } from "./pins";
import type { ProveRequest, ProveResponse } from "./worker";

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};
const base: string = typeof env.VITE_ARTIFACT_BASE === "string" ? env.VITE_ARTIFACT_BASE : "/artifacts";
export const ARTIFACT_URLS = {
  wasm: `${base}/transaction.wasm`,
  zkey: `${base}/transaction_final.zkey`,
  verificationKey: `${base}/verification_key.json`,
};
/** The pin file ships beside the app (public/artifacts.json), whatever host serves the artifacts themselves. */
export const PIN_URL = "/artifacts.json";
const PRODUCTION = env.PROD === true;

export type ProveStatus = (message: string) => void;
export interface BrowserProof { proof: Hex; publicInputs: PublicInputs; publicSignals: bigint[]; ms: number; verifiedLocally: boolean; /** V5: what the worker found for the proving key and the witness generator */ pins?: { zkey: string; wasm: string } }

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
    const r = await secureFetch(ARTIFACT_URLS.verificationKey, {}, "artifacts");
    if (r.ok) verificationKey = await r.json();
  } catch { /* no local verification; the chain verifies anyway */ }
  const pins = await loadPins();
  onStatus?.(verificationKey ? "Proving locally in a Web Worker (the proof is verified locally before submission)…" : "Proving locally in a Web Worker…");
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const id = ++seq;
  const req: ProveRequest = { id, inputs, wasmUrl: ARTIFACT_URLS.wasm, zkeyUrl: ARTIFACT_URLS.zkey, verificationKey, pins, production: PRODUCTION };
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
