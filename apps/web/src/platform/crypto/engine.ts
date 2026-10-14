// What the crypto worker does (V6 Stage 15; spec v2.0 §14.3), apart from the worker's wiring so it can be tested on its
// own. The engine hosts:
//   - the Rust core's WASM build for the tree layers and note discovery (the TypeScript reference when the core is not
//     served, in the same byte formats);
//   - the circuit inputs, built from the spend plan the main thread sends;
//   - the proof (snarkjs, loaded at the first proof only).
// The proving key and the witness generator are kept in the Cache API under their pinned SHA-256 and hashed again on
// every read: an entry that no longer matches is dropped and fetched anew, an unpinned artifact is never cached, and a
// production build refuses one that is not its pin (../../prover/pins.ts). What it posts back is progress, bytes, a
// proof or an error — never a circuit input.
import { MerkleLayers } from "@privacy-wallet/protocol/merkle";
import { buildTxInputs, type TxSpec } from "@privacy-wallet/protocol/txInputs";
import { bytesToHex0x, proveInputs, type SnarkjsLike } from "@privacy-wallet/protocol/prover";
import { noteFromPayload, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { secureFetch } from "@privacy-wallet/privacy-engine/transport/http";
import { enforce, sha256Hex, verdictOf } from "../../prover/pins";
import { ARTIFACT_CACHE, artifactCacheKey, type ArtifactRequest, type CoreEngine, type CryptoRequest, type CryptoResponse, type PlanMessage } from "./protocol";

export interface CoreModule {
  merkle_layers(leaves: Uint8Array, levels: number): Uint8Array;
  scan_note_payloads(viewKey: Uint8Array, ownerCommitment: Uint8Array, leafIndexes: Uint32Array, commitments: Uint8Array, payloads: Uint8Array): Uint8Array;
}
export type Post = (m: CryptoResponse, transfer?: Transferable[]) => void;
export interface EngineDeps {
  /** the core's loader: the WASM package from this origin, or null for the reference */
  loadCore: (base: string) => Promise<CoreModule | null>;
  /** the Cache API (null where there is none: a private window, a denied quota, a test) */
  caches: () => Promise<CacheStorage | null>;
  /** snarkjs, imported at the first proof */
  snarkjs: () => Promise<SnarkjsLike>;
  /** an artifact's bytes from its host (the transport's policy) */
  fetchBytes?: (url: string) => Promise<Response>;
  now?: () => number;
  warn?: (message: string) => void;
}

/** The WASM package from this origin, loaded once; null when it is not served. */
export function originCore(): (base: string) => Promise<CoreModule | null> {
  let core: Promise<CoreModule | null> | null = null;
  return (base) =>
    (core ??= (async () => {
      if (typeof WebAssembly === "undefined") return null;
      try {
        const m = await import(/* @vite-ignore */ `${base}/privacy_core_wasm.js`);
        await m.default(); // instantiates privacy_core_wasm_bg.wasm from next to the module (same origin)
        return typeof m.merkle_layers === "function" && typeof m.scan_note_payloads === "function" ? (m as CoreModule) : null;
      } catch {
        return null;
      }
    })());
}

const toBig = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
};
function be32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
const words = (b: Uint8Array): bigint[] => Array.from({ length: b.length / 32 }, (_, i) => toBig(b.subarray(i * 32, i * 32 + 32)));

/** The reference's layers 1..levels in the core's format (32-byte big-endian words, layer after layer). */
export function layersTs(leaves: Uint8Array, levels: number): Uint8Array {
  const upper = MerkleLayers.build(words(leaves), levels).layers.slice(1);
  const out = new Uint8Array(upper.reduce((n, l) => n + l.length, 0) * 32);
  let off = 0;
  for (const layer of upper)
    for (const v of layer) {
      out.set(be32(v), off);
      off += 32;
    }
  return out;
}

/** The reference's discovery in the core's format: leafIndex(4) ‖ amount(32) ‖ noteSecret(32) ‖ vaultId(32) per hit. */
export function scanTs(r: Extract<CryptoRequest, { op: "scan" }>): Uint8Array {
  const view = viewKeyPair(toBig(r.viewKey));
  const oc = toBig(r.ownerCommitment);
  const size = r.leafIndexes.length ? r.payloads.length / r.leafIndexes.length : 0;
  const hits: Uint8Array[] = [];
  for (let i = 0; i < r.leafIndexes.length; i++) {
    const note = noteFromPayload(view, oc, r.leafIndexes[i], toBig(r.commitments.subarray(i * 32, i * 32 + 32)), r.payloads.subarray(i * size, (i + 1) * size));
    if (!note) continue;
    const rec = new Uint8Array(100);
    new DataView(rec.buffer).setUint32(0, r.leafIndexes[i]);
    rec.set(be32(note.amount), 4);
    rec.set(be32(note.noteSecret), 36);
    rec.set(be32(note.vaultId), 68);
    hits.push(rec);
  }
  const out = new Uint8Array(hits.length * 100);
  hits.forEach((h, i) => out.set(h, i * 100));
  return out;
}

export function createCryptoEngine(deps: EngineDeps): { handle(r: CryptoRequest, post: Post): Promise<void> } {
  const now = deps.now ?? (() => performance.now());
  const fetchBytes = deps.fetchBytes ?? ((url: string) => secureFetch(url, {}, "artifacts"));

  async function openCache(pin: string | undefined): Promise<Cache | null> {
    if (!pin) return null;
    try {
      const c = await deps.caches();
      return c ? await c.open(ARTIFACT_CACHE) : null;
    } catch {
      return null; // a private window or a denied quota: fetched every time, as before
    }
  }

  async function artifact(
    name: string,
    url: string,
    pin: string | undefined,
    production: boolean,
  ): Promise<{ bytes: Uint8Array; verdict: string; cached: boolean }> {
    const want = pin?.toLowerCase();
    const store = await openCache(want);
    const key = want ? artifactCacheKey(name, want) : "";
    if (store) {
      const hit = await store.match(key);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if ((await sha256Hex(bytes)) === want) return { bytes, verdict: "match", cached: true };
        await store.delete(key); // altered at rest: dropped, fetched again below
      }
    }
    const r = await fetchBytes(url);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status} from ${url}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const verdict = enforce(name, verdictOf(want, await sha256Hex(bytes)), { production, warn: deps.warn ?? ((m) => console.warn(m)) });
    if (store && verdict === "match") {
      await store.put(key, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
      // an older pin of the same artifact goes (a new circuit build or ceremony replaces the key)
      for (const k of await store.keys()) {
        const path = new URL(k.url, "http://cache.invalid").pathname;
        if (path.startsWith(`/__artifact-cache/${name}/`) && path !== key) await store.delete(k);
      }
    }
    return { bytes, verdict, cached: false };
  }

  async function prove(id: number, plan: PlanMessage, a: ArtifactRequest, post: Post): Promise<void> {
    const t0 = now();
    post({ id, type: "progress", phase: "key" });
    const wasm = await artifact("transaction.wasm", a.wasmUrl, a.pins?.wasm, a.production);
    const zkey = await artifact("transaction_final.zkey", a.zkeyUrl, a.pins?.zkey, a.production);
    const t1 = now();
    post({ id, type: "progress", phase: "proving" });
    const { layers, ...rest } = plan;
    const spec: TxSpec = { ...rest, ...(layers ? { tree: MerkleLayers.fromLayers(rest.leaves, layers.upper, layers.levels) } : {}) };
    const inputs = buildTxInputs(spec); // throws when a note does not open its leaf or the value is not conserved
    const call = await proveInputs(await deps.snarkjs(), inputs, { wasm: wasm.bytes, zkey: zkey.bytes, verificationKey: a.verificationKey });
    const t2 = now();
    post({
      id,
      type: "proved",
      proof: bytesToHex0x(call.proof),
      publicSignals: call.publicSignals.map(String),
      ms: t2 - t0,
      keyMs: t1 - t0,
      proveMs: t2 - t1,
      keyCached: wasm.cached && zkey.cached,
      pins: { zkey: zkey.verdict, wasm: wasm.verdict },
    });
  }

  return {
    async handle(r, post) {
      try {
        if (r.op === "prove") return await prove(r.id, r.plan, r.artifacts, post);
        const c = await deps.loadCore(r.coreBase);
        const engine: CoreEngine = c ? "wasm" : "typescript";
        const out =
          r.op === "layers"
            ? (c ? c.merkle_layers(r.leaves, r.levels) : layersTs(r.leaves, r.levels)).slice()
            : (c ? c.scan_note_payloads(r.viewKey, r.ownerCommitment, r.leafIndexes, r.commitments, r.payloads) : scanTs(r)).slice();
        post({ id: r.id, type: "bytes", out, engine }, [out.buffer]);
      } catch (err) {
        post({ id: r.id, type: "error", error: String((err as Error)?.message ?? err) });
      }
    },
  };
}
