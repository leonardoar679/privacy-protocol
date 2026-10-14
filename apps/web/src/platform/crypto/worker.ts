// The crypto worker (V6 Stage 15; spec v2.0 §14.3): one long-lived worker per unlocked session, terminated at every lock.
// What it does lives in ./engine.ts (the core, the circuit inputs from the spend plan, the proof, the artifact cache);
// this file only wires it to the worker's messages, with the origin's WASM core, the Cache API and snarkjs.
import type { SnarkjsLike } from "@privacy-wallet/protocol/prover";
import { createCryptoEngine, originCore } from "./engine";
import type { CryptoRequest, CryptoResponse } from "./protocol";

// typed without the WebWorker lib so the app's DOM lib can stay (the two conflict in one program)
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<CryptoRequest>) => void) | null;
  postMessage: (m: CryptoResponse, transfer?: Transferable[]) => void;
};

const engine = createCryptoEngine({
  loadCore: originCore(),
  caches: async () => (typeof caches === "undefined" ? null : caches),
  snarkjs: async () => (await import("snarkjs")) as unknown as SnarkjsLike,
});

ctx.onmessage = (e) => void engine.handle(e.data, (m, transfer) => ctx.postMessage(m, transfer));
