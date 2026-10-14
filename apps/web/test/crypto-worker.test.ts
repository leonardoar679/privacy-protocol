// The crypto worker's engine (V6 Stage 15; spec v2.0 §14.3), tested apart from the worker's wiring:
//   - the tree layers and note discovery in the core's byte formats (the TypeScript reference here equals the
//     in-thread path; a served core answers as "wasm");
//   - the proof built from the spend plan — the circuit inputs exist only inside the engine —, with the plan's Merkle
//     layers crossing as arrays;
//   - the proving key and the witness generator cached under their pinned SHA-256, read back checked, a tampered entry
//     fetched again, an unpinned artifact never cached, a production build refusing one that is not its pin.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { utf8ToBytes } from "@noble/hashes/utils";
import { MerkleLayers, MerkleTree } from "@privacy-wallet/protocol/merkle";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { expectedPublicSignals, type SnarkjsLike } from "@privacy-wallet/protocol/prover";
import { TX_LEVELS, buildTxInputs, type CircuitInputs } from "@privacy-wallet/protocol/txInputs";
import { txDomain } from "@privacy-wallet/protocol/payload";
import { be32, bigIntsToWords } from "@privacy-wallet/sdk/core";
import { planWithdrawal, placeholderNoteData } from "@privacy-wallet/sdk/privateTx";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { createCryptoEngine, type CoreModule } from "../src/platform/crypto/engine";
import { planMessage } from "../src/platform/crypto/client";
import { artifactCacheKey, type CryptoRequest, type CryptoResponse } from "../src/platform/crypto/protocol";

const VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";
const seed = utf8ToBytes("crypto-worker-test-seed");
const keys = deriveKeys(seed);
const oc = ownerCommitmentOf(keys.spendKey);
const ours: Note = { vaultId: BigInt(VAULT), amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const WASM = utf8ToBytes("the witness generator");
const ZKEY = utf8ToBytes("the proving key");

/** An in-memory Cache API. */
function memoryCaches() {
  const entries = new Map<string, Uint8Array>();
  const cache = {
    match: async (k: string) => (entries.has(k) ? new Response(entries.get(k)!) : undefined),
    put: async (k: string, r: Response) => void entries.set(k, new Uint8Array(await r.arrayBuffer())),
    delete: async (k: string | { url: string }) => entries.delete(typeof k === "string" ? k : k.url),
    keys: async () => [...entries.keys()].map((url) => ({ url })),
  };
  return { entries, storage: { open: async () => cache } as unknown as CacheStorage };
}

function run(engine: ReturnType<typeof createCryptoEngine>, r: CryptoRequest): Promise<CryptoResponse[]> {
  const out: CryptoResponse[] = [];
  return engine.handle(r, (m) => void out.push(m)).then(() => out);
}

describe("the core in the worker", () => {
  const engine = createCryptoEngine({ loadCore: async () => null, caches: async () => null, snarkjs: async () => ({}) as SnarkjsLike });
  it("tree layers in the core's format: the reference equals the in-thread build", async () => {
    const leaves = [11n, 22n, 33n, 44n, 55n];
    const [r] = await run(engine, { id: 1, op: "layers", leaves: bigIntsToWords(leaves), levels: TX_LEVELS, coreBase: "/core" });
    expect(r).toMatchObject({ id: 1, type: "bytes", engine: "typescript" });
    const expected = MerkleLayers.build(leaves, TX_LEVELS).layers.slice(1).flat();
    expect((r as { out: Uint8Array }).out).toEqual(bigIntsToWords(expected));
  });
  it("note discovery in the core's format: our payload found, the others skipped", async () => {
    const view = viewKeyPair(keys.viewKey);
    const items = [
      {
        leafIndex: 0,
        commitment: noteCommitment(noteBody(ours), 0n),
        noteData: encryptNoteData(view.publicKey, { amount: ours.amount, noteSecret: ours.noteSecret, vaultId: ours.vaultId }),
      },
      { leafIndex: 1, commitment: 0x1111n, noteData: dummyNoteData() },
    ];
    const size = items[0].noteData.length;
    const payloads = new Uint8Array(items.length * size);
    items.forEach((it, i) => payloads.set(it.noteData, i * size));
    const [r] = await run(engine, {
      id: 2,
      op: "scan",
      viewKey: be32(keys.viewKey),
      ownerCommitment: be32(oc),
      leafIndexes: Uint32Array.from(items.map((i) => i.leafIndex)),
      commitments: bigIntsToWords(items.map((i) => i.commitment)),
      payloads,
      coreBase: "/core",
    });
    const out = (r as { out: Uint8Array }).out;
    expect(out.length).toBe(100);
    expect(new DataView(out.buffer).getUint32(0)).toBe(0);
    expect(out.subarray(4, 36)).toEqual(be32(ours.amount));
    expect(out.subarray(36, 68)).toEqual(be32(ours.noteSecret));
  });
  it("a served core answers, as wasm", async () => {
    const core: CoreModule = { merkle_layers: () => new Uint8Array(32), scan_note_payloads: () => new Uint8Array(0) };
    const e = createCryptoEngine({ loadCore: async () => core, caches: async () => null, snarkjs: async () => ({}) as SnarkjsLike });
    const [r] = await run(e, { id: 3, op: "layers", leaves: new Uint8Array(32), levels: 3, coreBase: "/core" });
    expect(r).toMatchObject({ type: "bytes", engine: "wasm" });
  });
});

describe("the proof in the worker", () => {
  let spec: ReturnType<typeof planWithdrawal>["spec"];
  beforeAll(() => {
    noteStore.clear();
    noteStore.add({ note: ours, leafIndex: 0, noteData: placeholderNoteData(), spent: false, label: "shield" });
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(ours), 0n));
    const layers = MerkleLayers.build(tree.leaves, TX_LEVELS);
    spec = planWithdrawal(seed, layers, BigInt(VAULT), 4n * 10n ** 17n, 0xb0b0n, txDomain(31337n, BigInt("0x5FbDB2315678afecb367f032d93F642f64180aa3"))).spec;
  });

  function harness(o: { production?: boolean; pinned?: boolean } = {}) {
    const fetches: string[] = [];
    const caches = memoryCaches();
    const seen: CircuitInputs[] = [];
    const snarkjs: SnarkjsLike = {
      groth16: {
        fullProve: async (input) => {
          seen.push(input);
          return {
            proof: {
              pi_a: ["1", "2", "1"],
              pi_b: [
                ["1", "2"],
                ["3", "4"],
                ["1", "0"],
              ],
              pi_c: ["5", "6", "1"],
            },
            publicSignals: expectedPublicSignals(input).map(String),
          };
        },
        verify: async () => true,
      },
    };
    const engine = createCryptoEngine({
      loadCore: async () => null,
      caches: async () => caches.storage,
      snarkjs: async () => snarkjs,
      fetchBytes: async (url) => {
        fetches.push(url);
        return new Response(url.endsWith(".wasm") ? WASM : ZKEY);
      },
      warn: () => {},
    });
    const prove = (id: number) =>
      run(engine, {
        id,
        op: "prove",
        plan: planMessage(spec),
        artifacts: {
          wasmUrl: "/artifacts/transaction.wasm",
          zkeyUrl: "/artifacts/transaction_final.zkey",
          production: o.production ?? false,
          ...(o.pinned === false ? {} : { pins: { wasm: sha(WASM), zkey: sha(ZKEY) } }),
        },
      });
    return { engine, fetches, caches, seen, prove };
  }

  it("the inputs are built in the engine from the plan (its layers crossed as arrays); progress, then the proof", async () => {
    const h = harness();
    const msgs = await h.prove(10);
    expect(msgs.map((m) => (m.type === "progress" ? `progress:${m.phase}` : m.type))).toEqual(["progress:key", "progress:proving", "proved"]);
    expect(h.seen[0]).toEqual(buildTxInputs(spec));
    expect(
      JSON.stringify(msgs, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      "no input crosses back",
    ).not.toContain(String(keys.spendKey));
  });

  it("the key is cached under its pin and read back checked; a tampered entry is fetched again", async () => {
    const h = harness();
    const first = (await h.prove(11)).at(-1)!;
    expect(first).toMatchObject({ type: "proved", keyCached: false, pins: { zkey: "match", wasm: "match" } });
    expect(h.fetches).toHaveLength(2);
    expect([...h.caches.entries.keys()].sort()).toEqual(
      [artifactCacheKey("transaction.wasm", sha(WASM)), artifactCacheKey("transaction_final.zkey", sha(ZKEY))].sort(),
    );
    const second = (await h.prove(12)).at(-1)!;
    expect(second).toMatchObject({ type: "proved", keyCached: true });
    expect(h.fetches, "no download for the second proof").toHaveLength(2);
    h.caches.entries.set(artifactCacheKey("transaction_final.zkey", sha(ZKEY)), utf8ToBytes("altered at rest"));
    const third = (await h.prove(13)).at(-1)!;
    expect(third).toMatchObject({ type: "proved", keyCached: false });
    expect(h.fetches.at(-1)).toBe("/artifacts/transaction_final.zkey");
    expect(h.caches.entries.get(artifactCacheKey("transaction_final.zkey", sha(ZKEY)))).toEqual(ZKEY);
  });

  it("an unpinned artifact is never cached; a production build refuses it", async () => {
    const h = harness({ pinned: false });
    await h.prove(14);
    await h.prove(15);
    expect([h.fetches.length, h.caches.entries.size]).toEqual([4, 0]);
    const p = harness({ pinned: false, production: true });
    const last = (await p.prove(16)).at(-1)!;
    expect(last).toMatchObject({ type: "error" });
    expect((last as { error: string }).error).toMatch(/refusing to prove/);
  });

  it("an older pin of an artifact leaves the cache when a new one is stored", async () => {
    const h = harness();
    h.caches.entries.set(artifactCacheKey("transaction_final.zkey", "00".repeat(32)), utf8ToBytes("last ceremony's key"));
    await h.prove(17);
    expect(h.caches.entries.has(artifactCacheKey("transaction_final.zkey", "00".repeat(32)))).toBe(false);
  });

  it("a plan that does not hold is refused in the engine, as the builder always refused it", async () => {
    const h = harness();
    const bad = { ...spec, outputs: [{ ...spec.outputs[0], amount: spec.outputs[0].amount + 1n }, spec.outputs[1], spec.outputs[2]] as typeof spec.outputs };
    const msgs = await run(h.engine, {
      id: 18,
      op: "prove",
      plan: planMessage(bad),
      artifacts: { wasmUrl: "/w.wasm", zkeyUrl: "/z.zkey", production: false, pins: { wasm: sha(WASM), zkey: sha(ZKEY) } },
    });
    expect(msgs.at(-1)).toMatchObject({ type: "error" });
    vi.restoreAllMocks();
  });
});
