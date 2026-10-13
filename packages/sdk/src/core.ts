// The Rust core's WASM build inside the web wallet (plan §43 "one core", §69; docs/mobile.md). A sync
// is two batches — every tree layer in one call, note discovery over every payload in one call — and
// both run in the core when its package is served, or in the TypeScript reference when it is not
// (the same vectors: packages/protocol/test/wasmCore.test.ts). Loaded lazily and from THIS origin
// only (/core/…: privacy-core/pkg/web through the Vite plugin in dev, public/core in a build via
// `npm run core:assets`), never at first launch (plan §39): the first sync or rescan loads it, and a
// sync already talks to the RPC endpoints. The core sees exactly what the TypeScript path sees: the
// public leaves, the payloads, and the view key for discovery — the spending key never crosses.
import { MerkleLayers } from "@privacy-wallet/protocol/merkle";
import { noteFromPayload, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { NOTE_DATA_BYTES } from "@privacy-wallet/protocol/payload";
import type { WalletKeys } from "@privacy-wallet/protocol/keys";

export interface CoreModule {
  /** layers 1..levels over k 32-byte leaves, concatenated (layer l has ceil(size(l-1)/2) words) */
  merkle_layers(leaves: Uint8Array, levels: number): Uint8Array;
  /** leafIndex(4) ‖ amount(32) ‖ noteSecret(32) ‖ vaultId(32) per payload that opens its leaf for this wallet */
  scan_note_payloads(viewKey: Uint8Array, ownerCommitment: Uint8Array, leafIndexes: Uint32Array, commitments: Uint8Array, payloads: Uint8Array): Uint8Array;
}
export type CoreStatus = "untried" | "wasm" | "typescript";
/** Same origin, fixed: the core is part of the app, never a third-party host. */
export const CORE_PATH = "/core";

let module: CoreModule | null = null;
let status: CoreStatus = "untried";
let loading: Promise<CoreModule | null> | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

/** Tests and native shells hand the module in directly (the node package, or a host binding); null forces the TypeScript path. */
export function useCoreModule(m: CoreModule | null): void {
  module = m;
  status = m ? "wasm" : "typescript";
  loading = null;
  notify();
}
export const coreStatus = (): CoreStatus => status;
export const subscribeCore = (l: () => void): (() => void) => { listeners.add(l); return () => listeners.delete(l); };

async function loadFromOrigin(): Promise<CoreModule | null> {
  if (typeof window === "undefined" || typeof WebAssembly === "undefined") return null;
  try {
    const m = await import(/* @vite-ignore */ `${CORE_PATH}/privacy_core_wasm.js`);
    await m.default(); // instantiates privacy_core_wasm_bg.wasm from next to the module (same origin)
    if (typeof m.merkle_layers !== "function" || typeof m.scan_note_payloads !== "function") throw new Error("the served core is an older build without the batch surface");
    return m as CoreModule;
  } catch (e) {
    console.info(`privacy core: no WASM package at ${CORE_PATH} — the TypeScript reference does the work (build it: node privacy-core/scripts/build-wasm.mjs, then npm run core:assets)`, e);
    return null;
  }
}

/** The core, loaded once on first use; null when the package is not served (the TypeScript path then). */
export function coreModule(): Promise<CoreModule | null> {
  if (status !== "untried") return Promise.resolve(module);
  loading ??= loadFromOrigin().then((m) => { module = m; status = m ? "wasm" : "typescript"; notify(); return m; });
  return loading;
}

// ---- bytes <-> field elements (big-endian 32-byte words, the core's only number format)
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export function be32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  const h = v.toString(16).padStart(64, "0");
  if (h.length !== 64) throw new Error("not a 256-bit value");
  for (let j = 0; j < 32; j++) b[j] = parseInt(h.substr(2 * j, 2), 16);
  return b;
}
export function bigIntsToWords(xs: bigint[]): Uint8Array {
  const out = new Uint8Array(xs.length * 32);
  for (let i = 0; i < xs.length; i++) out.set(be32(xs[i]), i * 32);
  return out;
}
export function wordsToBigInts(b: Uint8Array): bigint[] {
  if (b.length % 32 !== 0) throw new Error("not whole 32-byte words");
  const out: bigint[] = new Array(b.length / 32);
  for (let i = 0; i < out.length; i++) {
    let s = "0x";
    for (let j = 0; j < 32; j++) s += HEX[b[i * 32 + j]];
    out[i] = BigInt(s);
  }
  return out;
}

/** The layers over `leaves` (proofs are then lookups): one core call, or the TypeScript build. */
export async function treeLayers(leaves: bigint[], levels: number): Promise<MerkleLayers> {
  const core = await coreModule();
  if (!core) return MerkleLayers.build(leaves, levels);
  const out = core.merkle_layers(bigIntsToWords(leaves), levels);
  const sizes: number[] = [];
  let size = leaves.length;
  for (let l = 0; l < levels; l++) sizes.push((size = Math.ceil(size / 2)));
  if (out.length !== sizes.reduce((a, b) => a + b, 0) * 32) throw new Error("the core returned layers of an unexpected size");
  const upper: bigint[][] = [];
  let off = 0;
  for (const n of sizes) {
    upper.push(wordsToBigInts(out.subarray(off, off + n * 32)));
    off += n * 32;
  }
  return MerkleLayers.fromLayers(leaves, upper, levels);
}

export interface PayloadItem { leafIndex: number; commitment: bigint; noteData: Uint8Array }
export interface DiscoveredNote { leafIndex: number; note: Note }

/**
 * Note discovery (spec §12) over `items` for these keys: the payloads that open with the view key AND
 * reproduce their leaf with our owner commitment. One core call, or the reference loop (which yields
 * to the UI every 500 payloads). Payloads of the wrong length cannot be ours and are skipped.
 */
export async function discoverNotes(keys: WalletKeys, items: PayloadItem[], onProgress?: (done: number, total: number) => void): Promise<DiscoveredNote[]> {
  const oc = ownerCommitmentOf(keys.spendKey);
  const wellFormed = items.filter((it) => it.noteData.length === NOTE_DATA_BYTES);
  const core = await coreModule();
  if (core) {
    const idx = new Uint32Array(wellFormed.length);
    const cms = new Uint8Array(wellFormed.length * 32);
    const pls = new Uint8Array(wellFormed.length * NOTE_DATA_BYTES);
    wellFormed.forEach((it, i) => { idx[i] = it.leafIndex; cms.set(be32(it.commitment), i * 32); pls.set(it.noteData, i * NOTE_DATA_BYTES); });
    const out = core.scan_note_payloads(be32(keys.viewKey), be32(oc), idx, cms, pls);
    if (out.length % 100 !== 0) throw new Error("the core returned discovery records of an unexpected size");
    const found: DiscoveredNote[] = [];
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let off = 0; off < out.length; off += 100) {
      const [amount, noteSecret, vaultId] = wordsToBigInts(out.subarray(off + 4, off + 100));
      found.push({ leafIndex: dv.getUint32(off), note: { vaultId, amount, ownerCommitment: oc, noteSecret } });
    }
    onProgress?.(items.length, items.length);
    return found;
  }
  const view = viewKeyPair(keys.viewKey);
  const found: DiscoveredNote[] = [];
  for (let i = 0; i < wellFormed.length; i++) {
    const it = wellFormed[i];
    const note = noteFromPayload(view, oc, it.leafIndex, it.commitment, it.noteData);
    if (note) found.push({ leafIndex: it.leafIndex, note });
    if ((i + 1) % 500 === 0) { onProgress?.(i + 1, wellFormed.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  onProgress?.(items.length, items.length);
  return found;
}
