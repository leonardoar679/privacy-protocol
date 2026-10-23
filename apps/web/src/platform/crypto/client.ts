// The crypto worker's client (V6 Stage 15; spec v2.0 §14.3): one long-lived worker, started by the first core call or
// proof — never at first launch — and terminated at every lock (whatever it was doing then fails with "locked"). It
// builds the SDK's two ports:
//   - `workerCore`: the tree layers and note discovery;
//   - `proveSpend`: a spend plan in, a proof out (the circuit inputs are built in the worker).
// Each proof's timings go to the encrypted journal (`proofStats`), so the progress can estimate the next one. Secrets
// cross only into this worker: the spend plan (the spending key and the notes) and the view key for discovery.
import type { Hex } from "viem";
import { publicInputsFromSignals } from "@privacy-wallet/protocol/prover";
import type { TxSpec } from "@privacy-wallet/protocol/txInputs";
import { config, type CoreBackend, type ProofResult, type ProveStatus } from "@privacy-wallet/sdk/config";
import { CORE_PATH } from "@privacy-wallet/sdk/core";
import { recordProof } from "@privacy-wallet/sdk/wallet/proofStats";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { artifactUrls, loadPins } from "../../prover/client";
import { allowedHosts, isStrict } from "@privacy-wallet/privacy-engine/transport/http";
import type { CryptoRequest, CryptoResponse, PlanMessage, ProvePhase } from "./protocol";

type Req = CryptoRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;
interface Pending {
  resolve: (r: CryptoResponse) => void;
  reject: (e: Error) => void;
  onProgress?: (phase: ProvePhase) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
/** The locks so far: a proof that waited on a request of its own across one never goes on (audit round 2, r19). */
let locks = 0;

/** A lock ended it before anything was sent: nothing moved (the catalog's `interrupted`). */
const interrupted = (): Error => Object.assign(new Error("the wallet locked before anything was sent"), { code: "interrupted" });

function failAll(error: () => Error): void {
  for (const p of pending.values()) p.reject(error());
  pending.clear();
}

function spawn(): Worker {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<CryptoResponse>) => {
    const r = e.data;
    const p = pending.get(r.id);
    if (!p) return;
    if (r.type === "progress") return p.onProgress?.(r.phase);
    pending.delete(r.id);
    if (r.type === "error") p.reject(new Error(r.error));
    else p.resolve(r);
  };
  w.onerror = (e) => {
    failAll(() => new Error(`the crypto worker failed: ${e.message}`));
    w.terminate();
    if (worker === w) worker = null;
  };
  return w;
}

/** Ends the worker and everything it was doing (every lock does this: the spend plan and the keys it held go with it). */
export function stopCryptoWorker(): void {
  locks++;
  worker?.terminate();
  worker = null;
  failAll(interrupted);
}

// a lock ends the worker: the spend plans and the view key it held go with it (spec v2.0 §8); registered when this
// module loads, which is before any worker exists
session.onLock(stopCryptoWorker);

/** Is the worker running (tests, the leakage gate). */
export const cryptoWorkerRunning = (): boolean => worker !== null;

function call(req: Req, transfer: Transferable[] = [], onProgress?: (phase: ProvePhase) => void): Promise<CryptoResponse> {
  // never a worker while the wallet is locked (audit round 2, r19): one started after a lock was handed the spend plan and the
  // keys that a proof waiting out the lock still held — proved, sent and mined, then recorded "Nothing moved"
  if (!session.isUnlocked()) return Promise.reject(interrupted());
  worker ??= spawn();
  const id = ++seq;
  return new Promise<CryptoResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker!.postMessage({ ...req, id } as CryptoRequest, transfer);
  });
}

function bytesOf(r: CryptoResponse): { out: Uint8Array; engine: "wasm" | "typescript" } {
  if (r.type !== "bytes") throw new Error("the crypto worker answered out of turn");
  return { out: r.out, engine: r.engine };
}

/** The SDK's core port: each argument is transferred (the view key leaves this thread with the call). */
export const workerCore: CoreBackend = {
  async merkleLayers(leaves, levels) {
    return bytesOf(await call({ op: "layers", leaves, levels, coreBase: CORE_PATH }, [leaves.buffer]));
  },
  async scanNotePayloads(viewKey, ownerCommitment, leafIndexes, commitments, payloads) {
    const r = await call({ op: "scan", viewKey, ownerCommitment, leafIndexes, commitments, payloads, coreBase: CORE_PATH }, [
      viewKey.buffer,
      ownerCommitment.buffer,
      leafIndexes.buffer,
      commitments.buffer,
      payloads.buffer,
    ]);
    return bytesOf(r);
  },
  async openNotePayloads(viewKey, ownerCommitment, leafIndexes, commitments, payloads) {
    const r = await call({ op: "open", viewKey, ownerCommitment, leafIndexes, commitments, payloads, coreBase: CORE_PATH }, [
      viewKey.buffer,
      ownerCommitment.buffer,
      leafIndexes.buffer,
      commitments.buffer,
      payloads.buffer,
    ]);
    return bytesOf(r);
  },
};

/** The plan as it crosses: the MerkleLayers instance as its arrays. */
export function planMessage(spec: TxSpec): PlanMessage {
  const { tree, ...rest } = spec;
  return { ...rest, ...(tree ? { layers: { levels: tree.levels, upper: tree.layers.slice(1) } } : {}) };
}

/** The SDK's prover port: the plan to the worker; the device's timings to the journal. */
export async function proveSpend(spec: TxSpec, onStatus?: ProveStatus): Promise<ProofResult> {
  const at = locks; // a lock while this waits for its own requests ends it (audit round 2, r19)
  const pins = await loadPins();
  if (locks !== at) throw interrupted();
  const urls = artifactUrls();
  // the verification key is the worker's to fetch, from the pinned cache (audit round 2, r21): never a request per proof
  const r = await call(
    {
      op: "prove",
      plan: planMessage(spec),
      artifacts: {
        wasmUrl: urls.wasm,
        zkeyUrl: urls.zkey,
        vkeyUrl: urls.verificationKey,
        pins,
        production: config().production,
        transport: { strict: isStrict(), hosts: allowedHosts() }, // the page's policy, held in the worker too (audit round 2, n34)
      },
    },
    [],
    (phase) => onStatus?.(phase === "key" ? "Fetching the proving key (kept on this device after the first time)…" : "Proving locally in a Web Worker…"),
  );
  if (r.type !== "proved") throw new Error("the crypto worker answered out of turn");
  recordProof({ keyMs: r.keyMs, proveMs: r.proveMs, keyCached: r.keyCached });
  const publicSignals = r.publicSignals.map(BigInt);
  return {
    proof: r.proof as Hex,
    publicInputs: publicInputsFromSignals(publicSignals),
    publicSignals,
    ms: r.ms,
    verifiedLocally: r.verifiedLocally,
    pins: r.pins,
  };
}
