// The Rust core inside the wallet (src/sdk/core.ts, plan §43 "one core"): a sync hashes every tree
// layer in one call and a rescan opens every payload in one call when the WASM package is there, and
// the TypeScript reference does the same work when it is not. Both paths against the same mock
// core (loopback JSON-RPC, synthetic events, one real envelope): same tree, same proofs, same witness,
// same discovered notes. The WASM half is skipped (with the build hint) when the package has not been
// built; the TypeScript half always runs.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { utf8ToBytes } from "@noble/hashes/utils";
import { MerkleLayers, MerkleTree, ZERO_LEAF } from "@ref/merkle";
import { hash2 } from "@ref/poseidon";
import { TX_LEVELS, buildTxInputs } from "@ref/txInputs";
import { deriveKeys, deriveNoteSecret } from "@ref/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@ref/note";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@ref/envelope";
import { txDomain } from "@ref/payload";
import { coreStatus, discoverNotes, treeLayers, useCoreModule, wordsToBigInts, bigIntsToWords, be32 } from "../src/sdk/core";
import { syncTreeQuorum } from "../src/sdk/chain";
import { planWithdrawal, placeholderNoteData, scanNotes } from "../src/sdk/privateTx";
import { noteStore } from "../src/wallet/notes";
import { startMockCore } from "./helpers/mockRpc";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../../core/rust/pkg/node/privacy_core_wasm.js");
const wasm: any = existsSync(pkg) ? createRequire(import.meta.url)(pkg) : null;

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9";
const VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";
const seed = utf8ToBytes("core-wasm-test-seed");
const keys = deriveKeys(seed);
const view = viewKeyPair(keys.viewKey);
const oc = ownerCommitmentOf(keys.spendKey);
const toHex = (b: Uint8Array) => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

// leaf 0: our deposit; leaves 4..6: someone else's outputs; leaf 8: our second note (a transfer to us)
const ours: Note = { vaultId: BigInt(VAULT), amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
const ours2: Note = { vaultId: BigInt(VAULT), amount: 3n * 10n ** 17n, ownerCommitment: oc, noteSecret: 777n };
const plain = (n: Note) => ({ amount: n.amount, noteSecret: n.noteSecret, vaultId: n.vaultId });
const events: Record<number, { commitment: bigint; noteData: `0x${string}` }> = {
  0: { commitment: noteCommitment(noteBody(ours), 0n), noteData: toHex(encryptNoteData(view.publicKey, plain(ours))) },
  4: { commitment: 0x4444n, noteData: toHex(dummyNoteData()) },
  5: { commitment: 0x5555n, noteData: toHex(dummyNoteData()) },
  6: { commitment: 0x6666n, noteData: toHex(dummyNoteData()) },
  8: { commitment: noteCommitment(noteBody(ours2), 8n), noteData: toHex(encryptNoteData(view.publicKey, plain(ours2))) },
  9: { commitment: 0x9999n, noteData: toHex(dummyNoteData()) },
};
const NEXT = 12;
const tree = new MerkleTree(TX_LEVELS);
tree.insertGroup([events[0].commitment, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);
tree.insertGroup([events[4].commitment, events[5].commitment, events[6].commitment, ZERO_LEAF]);
tree.insertGroup([events[8].commitment, events[9].commitment, ZERO_LEAF, ZERO_LEAF]);

let mock: Awaited<ReturnType<typeof startMockCore>>;
beforeAll(async () => { mock = await startMockCore({ core: CORE, events, nextLeafIndex: NEXT, root: tree.root }); });
afterAll(() => mock.close());
const deployment = () => ({ chainId: 31337, core: CORE as `0x${string}`, ethVault: VAULT as `0x${string}`, rpcUrl: mock.url, rpcUrls: [mock.url, mock.url], fromBlock: 0n, erc20Vaults: [] });

async function syncPlanScan(label: string) {
  const state = await syncTreeQuorum(deployment());
  expect(state.root).toBe(tree.root);
  expect(state.leaves).toEqual(tree.leaves);
  expect(state.layers.leaves).toBe(state.leaves);
  // every path folds to the on-chain root
  for (const i of [0, 5, 8, 11]) {
    const p = state.layers.proof(i);
    let cur = state.leaves[i];
    p.pathElements.forEach((sib, k) => (cur = p.pathIndices[k] ? hash2(sib, cur) : hash2(cur, sib)));
    expect(cur).toBe(tree.root);
  }
  // discovery: both of our notes, nobody else's (the store is a session singleton: start it empty)
  noteStore.clear();
  const r = await scanNotes({ masterSeed: seed, deployment: deployment() });
  expect(r).toEqual({ scanned: 6, found: 2, added: 2, spent: 0 });
  const mine = noteStore.all();
  expect(mine.map((n) => n.leafIndex)).toEqual([0, 8]);
  expect(mine[0].note).toEqual(ours);
  expect(mine[1].note).toEqual(ours2);
  // a withdrawal plan over the synced layers: the witness builds, with paths from the layers
  const plan = planWithdrawal(seed, state.layers, BigInt(VAULT), 4n * 10n ** 17n, 0xb0bn, txDomain(31337n, BigInt(CORE)));
  expect(plan.spec.tree).toBe(state.layers);
  const inputs = buildTxInputs(plan.spec);
  expect(inputs.root).toBe(tree.root.toString());
  const viaLeaves = buildTxInputs({ ...plan.spec, tree: undefined });
  expect(inputs).toEqual(viaLeaves);
  return { state, inputs, label };
}

describe("the TypeScript path (no package)", () => {
  beforeEach(() => useCoreModule(null));
  it("syncs, discovers and plans through the reference, reporting progress", async () => {
    expect(coreStatus()).toBe("typescript");
    const r = await syncPlanScan("typescript");
    expect(r.state.layers).toBeInstanceOf(MerkleLayers);
    const items = Array.from({ length: 1200 }, (_, i) => ({ leafIndex: i, commitment: 1n, noteData: dummyNoteData() }));
    items[1100] = { leafIndex: 1100, commitment: noteCommitment(noteBody({ ...ours, noteSecret: 5n }), 1100n), noteData: encryptNoteData(view.publicKey, plain({ ...ours, noteSecret: 5n })) };
    items.push({ leafIndex: 1200, commitment: 1n, noteData: new Uint8Array(10) }); // malformed: skipped, never ours
    const progress: [number, number][] = [];
    const found = await discoverNotes(keys, items, (d, t) => progress.push([d, t]));
    expect(found).toEqual([{ leafIndex: 1100, note: { ...ours, noteSecret: 5n } }]);
    expect(progress.slice(0, 2)).toEqual([[500, 1200], [1000, 1200]]);
    expect(progress.at(-1)).toEqual([1201, 1201]);
  });
  it("round-trips field elements through the core's byte format", () => {
    const xs = [0n, 1n, 2n ** 255n - 19n, 21888242871839275222246405745257275088548364400416034343698204186575808495616n];
    expect(wordsToBigInts(bigIntsToWords(xs))).toEqual(xs);
    expect(be32(1n)[31]).toBe(1);
    expect(() => be32(2n ** 256n)).toThrow();
  });
});

describe.skipIf(!wasm)("the WASM path (core/rust/pkg built: node core/rust/scripts/build-wasm.mjs)", () => {
  beforeEach(() => useCoreModule(wasm));
  afterAll(() => useCoreModule(null));

  it("syncs, discovers and plans through the Rust core with the same tree, notes and witness", async () => {
    expect(coreStatus()).toBe("wasm");
    const r = await syncPlanScan("wasm");
    useCoreModule(null);
    const ts = await syncPlanScan("typescript");
    expect(r.state.layers.layers).toEqual(ts.state.layers.layers);
    // the two plans draw fresh dummies and counters; everything the tree decides is identical
    const treeFields = (i: Record<string, unknown>) => ({ root: i.root, inPathElements: i.inPathElements, inPathIndices: i.inPathIndices, nullifier: i.nullifier, inLeafIndex: i.inLeafIndex });
    expect(treeFields(r.inputs)).toEqual(treeFields(ts.inputs));
  });

  it("builds the layers of a larger tree exactly like the reference, faster", async () => {
    const leaves = Array.from({ length: 2048 }, (_, i) => BigInt(i + 1) * 104729n);
    let t0 = performance.now();
    const viaCore = await treeLayers(leaves, TX_LEVELS);
    const coreMs = performance.now() - t0;
    useCoreModule(null);
    t0 = performance.now();
    const viaTs = await treeLayers(leaves, TX_LEVELS);
    const tsMs = performance.now() - t0;
    expect(viaCore.root).toBe(viaTs.root);
    expect(viaCore.layers).toEqual(viaTs.layers);
    for (const i of [0, 1, 1023, 2047]) expect(viaCore.proof(i)).toEqual(viaTs.proof(i));
    console.log(`treeLayers × 2048 leaves (incl. byte conversion): core ${coreMs.toFixed(0)} ms, TypeScript ${tsMs.toFixed(0)} ms (×${(tsMs / coreMs).toFixed(1)})`);
    expect(coreMs).toBeLessThan(tsMs);
  });

  it("refuses an empty, malformed or partial core module and falls back", async () => {
    useCoreModule({ merkle_layers: () => new Uint8Array(5), scan_note_payloads: () => new Uint8Array(0) });
    await expect(treeLayers([1n, 2n, 3n, 4n], TX_LEVELS)).rejects.toThrow(/unexpected size/);
    useCoreModule({ merkle_layers: () => new Uint8Array(0), scan_note_payloads: () => new Uint8Array(7) });
    await expect(discoverNotes(keys, [{ leafIndex: 0, commitment: 1n, noteData: dummyNoteData() }])).rejects.toThrow(/unexpected size/);
  });
});
