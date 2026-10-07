// The proving Web Worker: receives circuit inputs (built on the main thread from the wallet's notes),
// runs snarkjs' browser build over the normative prover (reference/typescript/src/prover.ts) and
// posts back the proof bytes + public signals. The spending key and note secrets are inside the
// inputs and never leave this origin; the artifacts are fetched from the configured artifact base.
import * as snarkjs from "snarkjs";
import { bytesToHex0x, proveInputs } from "@ref/prover";
import type { CircuitInputs } from "@ref/txInputs";

export interface ProveRequest { id: number; inputs: CircuitInputs; wasmUrl: string; zkeyUrl: string; verificationKey?: unknown }
export type ProveResponse =
  | { id: number; ok: true; proof: string; publicSignals: string[]; ms: number }
  | { id: number; ok: false; error: string };

// typed without the WebWorker lib so the app's DOM lib can stay (the two conflict in one program)
const ctx = self as unknown as { onmessage: ((e: MessageEvent<ProveRequest>) => void) | null; postMessage: (m: ProveResponse) => void };

ctx.onmessage = async (e) => {
  const { id, inputs, wasmUrl, zkeyUrl, verificationKey } = e.data;
  const t0 = performance.now();
  try {
    const call = await proveInputs(snarkjs, inputs, { wasm: wasmUrl, zkey: zkeyUrl, verificationKey });
    ctx.postMessage({ id, ok: true, proof: bytesToHex0x(call.proof), publicSignals: call.publicSignals.map(String), ms: performance.now() - t0 });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
