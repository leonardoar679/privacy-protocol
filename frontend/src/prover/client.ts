// Main-thread client of the proving worker (src/prover/worker.ts). One worker per proof, terminated
// afterwards. Artifacts: /artifacts/* served by the Vite plugin from ../circuits in dev, or
// VITE_ARTIFACT_BASE in a deployed build.
import { secureFetch } from "../api/transport";
import type { Hex } from "viem";
import { publicInputsFromSignals, type PublicInputs } from "@ref/prover";
import type { CircuitInputs } from "@ref/txInputs";
import type { ProveRequest, ProveResponse } from "./worker";

const base: string = (import.meta as any).env?.VITE_ARTIFACT_BASE ?? "/artifacts";
export const ARTIFACT_URLS = {
  wasm: `${base}/transaction.wasm`,
  zkey: `${base}/transaction_final.zkey`,
  verificationKey: `${base}/verification_key.json`,
};

export type ProveStatus = (message: string) => void;
export interface BrowserProof { proof: Hex; publicInputs: PublicInputs; publicSignals: bigint[]; ms: number; verifiedLocally: boolean }

let seq = 0;

/** Prove `inputs` in a Web Worker; verifies locally first when the verification key is served. */
export async function proveInBrowser(inputs: CircuitInputs, onStatus?: ProveStatus): Promise<BrowserProof> {
  let verificationKey: unknown;
  try {
    const r = await secureFetch(ARTIFACT_URLS.verificationKey, {}, "artifacts");
    if (r.ok) verificationKey = await r.json();
  } catch { /* no local verification; the chain verifies anyway */ }
  onStatus?.(verificationKey ? "Proving locally in a Web Worker (the proof is verified locally before submission)…" : "Proving locally in a Web Worker…");
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const id = ++seq;
  const req: ProveRequest = { id, inputs, wasmUrl: ARTIFACT_URLS.wasm, zkeyUrl: ARTIFACT_URLS.zkey, verificationKey };
  return new Promise<BrowserProof>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<ProveResponse>) => {
      if (e.data.id !== id) return;
      worker.terminate();
      if (!e.data.ok) return reject(new Error(e.data.error));
      const publicSignals = e.data.publicSignals.map(BigInt);
      resolve({ proof: e.data.proof as Hex, publicInputs: publicInputsFromSignals(publicSignals), publicSignals, ms: e.data.ms, verifiedLocally: verificationKey !== undefined });
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(`proving worker failed: ${e.message}`)); };
    worker.postMessage(req);
  });
}
