// @vitest-environment node
// The worker boundary (spec v2.0 §14.3, §19; doc §83; V6 Stage 15): with Worker.prototype.postMessage intercepted, the
// secrets reach only the crypto worker — the spend plan (the spending key and the notes) and the view key for discovery
// —, one worker serves every call of a session (long-lived), its replies carry no key and no circuit input (discovery
// returns this wallet's own notes by design: the main thread keeps them), the device's proof timings land in the
// journal, and a lock ends the worker and whatever it was doing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { utf8ToBytes } from "@noble/hashes/utils";
import { MerkleLayers, MerkleTree } from "@privacy-wallet/protocol/merkle";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { expectedPublicSignals, type SnarkjsLike } from "@privacy-wallet/protocol/prover";
import { TX_LEVELS, buildTxInputs } from "@privacy-wallet/protocol/txInputs";
import { txDomain } from "@privacy-wallet/protocol/payload";
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { discoverNotes, treeLayers } from "@privacy-wallet/sdk/core";
import { planWithdrawal, placeholderNoteData } from "@privacy-wallet/sdk/privateTx";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { applyConfig, testConfig } from "../src/config";
import { createCryptoEngine } from "../src/platform/crypto/engine";
import { cryptoWorkerRunning, proveSpend, stopCryptoWorker } from "../src/platform/crypto/client";
import type { CryptoRequest, CryptoResponse } from "../src/platform/crypto/protocol";
import { fieldNames, forms, leaks, type SecretSet } from "./helpers/leakage";

const VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";

// ---- every worker the app creates, every message posted to it and every reply it posts back
const posted: { url: string; data: CryptoRequest }[] = [];
const replies: { url: string; data: CryptoResponse }[] = [];
const created: FakeWorker[] = [];
const fakeSnarkjs: SnarkjsLike = {
  groth16: {
    fullProve: async (input) => ({
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
    }),
    verify: async () => true,
  },
};
class FakeWorker {
  onmessage: ((e: { data: CryptoResponse }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  private engine = createCryptoEngine({
    loadCore: async () => null,
    caches: async () => null,
    snarkjs: async () => fakeSnarkjs,
    fetchBytes: async (url) => new Response(utf8ToBytes(url)),
    warn: () => {},
  });
  constructor(readonly url: string | URL) {
    created.push(this);
  }
  postMessage(data: CryptoRequest): void {
    posted.push({ url: String(this.url), data });
    void this.engine.handle(data, (m) => {
      replies.push({ url: String(this.url), data: m });
      queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({ data: m });
      });
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}
const g = globalThis as { Worker?: unknown };
const before = g.Worker;

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v).join(",") : v));

describe("the worker boundary (doc §83)", () => {
  let secrets: SecretSet[];
  let offLock: () => void;
  beforeAll(async () => {
    g.Worker = FakeWorker;
    applyConfig(testConfig()); // the page has workers now: the core runs in the crypto worker
    await session.create("pw");
    session.acknowledgePhrase();
    offLock = session.onLock(stopCryptoWorker);
    const seed = session.state().seed!;
    const k = deriveKeys(seed);
    secrets = [
      { name: "the seed", values: forms(seed) },
      { name: "the spending key", values: forms(k.spendKey) },
      { name: "the view key", values: forms(k.viewKey) },
      { name: "the note key", values: forms(k.noteKey) },
    ];
  });
  afterAll(() => {
    offLock();
    session.forget();
    noteStore.clear();
    connectivity.reset();
    g.Worker = before;
    applyConfig(testConfig());
  });

  it("sync, discovery and a proof: one crypto worker, the secrets only there, no key and no input in its replies", async () => {
    const seed = session.state().seed!;
    const k = deriveKeys(seed);
    const oc = ownerCommitmentOf(k.spendKey);
    const ours: Note = { vaultId: BigInt(VAULT), amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(k.noteKey, 0) };
    const commitment = noteCommitment(noteBody(ours), 0n);
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(commitment);
    tree.insertLeaf(0x2222n);

    // the tree's layers and the discovery go through the worker
    const layers = await treeLayers(tree.leaves, TX_LEVELS);
    expect(layers.root).toBe(MerkleLayers.build(tree.leaves, TX_LEVELS).root);
    const view = viewKeyPair(k.viewKey);
    const found = await discoverNotes(k, [
      { leafIndex: 0, commitment, noteData: encryptNoteData(view.publicKey, { amount: ours.amount, noteSecret: ours.noteSecret, vaultId: ours.vaultId }) },
      { leafIndex: 1, commitment: 0x2222n, noteData: dummyNoteData() },
    ]);
    expect(found.map((n) => n.leafIndex)).toEqual([0]);

    // a proof from the spend plan; the inputs are built in the worker
    noteStore.clear();
    noteStore.add({ note: ours, leafIndex: 0, noteData: placeholderNoteData(), spent: false, label: "shield" });
    const { spec } = planWithdrawal(
      seed,
      layers,
      BigInt(VAULT),
      4n * 10n ** 17n,
      0xb0b0n,
      txDomain(31337n, BigInt("0x5FbDB2315678afecb367f032d93F642f64180aa3")),
    );
    const proof = await proveSpend(spec);
    expect(proof.publicSignals).toEqual(expectedPublicSignals(buildTxInputs(spec)));
    expect(session.journal().proofStats, "the device's timings, in the encrypted journal").toMatchObject({ keyCached: false });

    // one worker, the crypto worker, for every call
    expect(created).toHaveLength(1);
    expect(String(created[0].url)).toMatch(/platform\/crypto\/worker\.ts/);
    expect(posted.map((p) => p.data.op)).toEqual(["layers", "scan", "prove"]);
    // the secrets went there and nowhere else (no other worker exists); the plan carried the spending key, the scan the view key
    expect(
      leaks(
        json(posted.find((p) => p.data.op === "prove")!.data),
        secrets.filter((s) => s.name === "the spending key"),
      ).length,
    ).toBeGreaterThan(0);
    for (const p of posted) expect(p.url).toMatch(/platform\/crypto\/worker\.ts/);
    // the replies: progress, bytes, the proof — no key, no circuit input
    const inputFields = Object.keys(buildTxInputs(spec));
    for (const r of replies) {
      expect(leaks(json(r.data), secrets), `${r.data.type} reply`).toEqual([]);
      const names = fieldNames(r.data);
      for (const f of inputFields) expect(names.has(f), `${r.data.type} reply carries the input ${f}`).toBe(false);
    }
    expect(replies.find((r) => r.data.type === "proved")!.data).not.toHaveProperty("inputs");
  });

  it("a lock ends the worker and the request it was serving", async () => {
    expect(cryptoWorkerRunning()).toBe(true);
    const pending = treeLayers([1n, 2n, 3n], TX_LEVELS);
    session.lock();
    expect(cryptoWorkerRunning()).toBe(false);
    expect(created[0].terminated).toBe(true);
    await expect(pending).rejects.toThrow(/locked/);
  });
});
