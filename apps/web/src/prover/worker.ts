// The proving Web Worker: receives circuit inputs (built on the main thread from the wallet's notes),
// runs snarkjs' browser build over the normative prover (packages/protocol/src/prover.ts) and
// posts back the proof bytes + public signals. The spending key and note secrets are inside the
// inputs and never leave this origin; the artifacts are fetched from the configured artifact base.
// V5 (spec §20): the proving key and the witness generator are fetched here, hashed and checked against the build's
// pins before snarkjs reads them (src/prover/pins.ts: a mismatch refuses in production, warns in dev).
import * as snarkjs from "snarkjs";
import { bytesToHex0x, proveInputs } from "@privacy-wallet/protocol/prover";
import type { CircuitInputs } from "@privacy-wallet/protocol/txInputs";
import { secureFetch } from "@privacy-wallet/privacy-engine/transport/http";
import { enforce, sha256Hex, verdictOf, type ArtifactPins } from "./pins";

export interface ProveRequest { id: number; inputs: CircuitInputs; wasmUrl: string; zkeyUrl: string; verificationKey?: unknown; /** V5: the build's pins and whether a mismatch refuses */ pins?: ArtifactPins; production?: boolean }
export type ProveResponse =
  | { id: number; ok: true; proof: string; publicSignals: string[]; ms: number; pins?: { zkey: string; wasm: string } }
  | { id: number; ok: false; error: string };

// typed without the WebWorker lib so the app's DOM lib can stay (the two conflict in one program)
const ctx = self as unknown as { onmessage: ((e: MessageEvent<ProveRequest>) => void) | null; postMessage: (m: ProveResponse) => void };

/** Fetches an artifact and checks it against its pin; returns the bytes snarkjs reads from memory. */
async function pinned(name: string, url: string, pin: string | undefined, production: boolean): Promise<{ bytes: Uint8Array; verdict: string }> {
  const r = await secureFetch(url, {}, "artifacts");
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} from ${url}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const verdict = enforce(name, verdictOf(pin, await sha256Hex(bytes)), { production, warn: (m) => console.warn(m) });
  return { bytes, verdict };
}

ctx.onmessage = async (e) => {
  const { id, inputs, wasmUrl, zkeyUrl, verificationKey, pins, production = false } = e.data;
  const t0 = performance.now();
  try {
    const wasm = await pinned("transaction.wasm", wasmUrl, pins?.wasm, production);
    const zkey = await pinned("transaction_final.zkey", zkeyUrl, pins?.zkey, production);
    const call = await proveInputs(snarkjs, inputs, { wasm: wasm.bytes, zkey: zkey.bytes, verificationKey });
    ctx.postMessage({ id, ok: true, proof: bytesToHex0x(call.proof), publicSignals: call.publicSignals.map(String), ms: performance.now() - t0, pins: { zkey: zkey.verdict, wasm: wasm.verdict } });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
