// The Rust core compiled to WASM (core/rust/privacy-core-wasm, built by core/rust/scripts/build-wasm.mjs)
// against this TypeScript reference: the same hashes, commitments, nullifiers, keys, envelopes, roots,
// addresses, phrases and chain keys from the same inputs — plan §69 "one core". Skipped (with the
// build hint) when the package has not been built; never silently green.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { mnemonicToSeedSync, entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { hash } from "../src/poseidon2";
import { deriveKeys, deriveNoteSecret } from "../src/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "../src/note";
import { nullifier, phantomNullifier } from "../src/nullifier";
import { decryptNoteData, dummyNoteData, encryptNoteData, noteFromPayload, viewKeyPair } from "../src/envelope";
import { noteDataHash, txDomain } from "../src/payload";
import { MerkleLayers, MerkleTree, ZERO_LEAF } from "../src/merkle";
import { encodePrivacyAddress, decodePrivacyAddress } from "../src/address";
import { bip39Seed, bitcoinAccount, evmAccount, solanaAccount } from "../src/wallet/chainKeys";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "../../../core/rust/pkg/node/privacy_core_wasm.js");
const require = createRequire(import.meta.url);
const wasm: any = existsSync(pkg) ? require(pkg) : null;
const be32 = (v: bigint): Uint8Array => { const b = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const fromBe = (b: Uint8Array): bigint => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
const concat = (...xs: Uint8Array[]) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };

describe.skipIf(!wasm)("WASM core == TypeScript reference (build: node core/rust/scripts/build-wasm.mjs)", () => {
  const seed = utf8ToBytes("privacy-protocol/example-master-seed");
  const keys = deriveKeys(seed);
  const vectors = JSON.parse(readFileSync(join(here, "../../../circuits/vectors/primitives.json"), "utf8"));

  it("Poseidon2 on the nargo vectors and on random inputs", () => {
    const cases: [string, bigint[]][] = [["hash([1])", [1n]], ["hash([1,2])", [1n, 2n]], ["hash([1,2,3])", [1n, 2n, 3n]], ["hash([1,2,3,4])", [1n, 2n, 3n, 4n]]];
    for (const [name, input] of cases) {
      expect(fromBe(wasm.poseidon2_hash(concat(...input.map(be32))))).toBe(BigInt(vectors.poseidon2[name]));
      expect(fromBe(wasm.poseidon2_hash(concat(...input.map(be32))))).toBe(hash(input));
    }
    for (let i = 0; i < 20; i++) {
      const n = 1 + (i % 6);
      const input = Array.from({ length: n }, () => fromBe(crypto.getRandomValues(new Uint8Array(32))) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n);
      expect(fromBe(wasm.poseidon2_hash(concat(...input.map(be32))))).toBe(hash(input));
    }
    expect(() => wasm.poseidon2_hash(new Uint8Array(31))).toThrow();
  });

  it("keys, note, commitment, nullifiers", () => {
    const k = wasm.derive_keys(seed);
    expect(fromBe(k.slice(0, 32))).toBe(keys.spendKey);
    expect(fromBe(k.slice(32, 64))).toBe(keys.viewKey);
    expect(fromBe(k.slice(64, 96))).toBe(keys.noteKey);
    expect(fromBe(wasm.derive_note_secret(be32(keys.noteKey), 7))).toBe(deriveNoteSecret(keys.noteKey, 7));
    const oc = ownerCommitmentOf(keys.spendKey);
    expect(fromBe(wasm.owner_commitment(be32(keys.spendKey)))).toBe(oc);
    const note: Note = { vaultId: 171n, amount: 10n ** 18n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
    const body = noteBody(note);
    expect(fromBe(wasm.note_body(be32(note.vaultId), be32(note.amount), be32(oc), be32(note.noteSecret)))).toBe(body);
    const c = noteCommitment(body, 5n);
    expect(fromBe(wasm.note_commitment(be32(body), 5))).toBe(c);
    const nf = nullifier(c, keys.spendKey);
    expect(fromBe(wasm.nullifier(be32(c), be32(keys.spendKey)))).toBe(nf);
    expect(fromBe(wasm.phantom_nullifier(be32(nf), 1, be32(keys.spendKey)))).toBe(phantomNullifier(nf, 1, keys.spendKey));
  });

  it("envelope both ways, payload hash, tx domain, privacy address", () => {
    const view = viewKeyPair(keys.viewKey);
    expect(bytesToHex(wasm.view_public_key(be32(keys.viewKey)))).toBe(bytesToHex(view.publicKey));
    const eph = hexToBytes("11".repeat(32)), nonce = hexToBytes("22".repeat(24));
    const plain = { amount: 6n * 10n ** 17n, noteSecret: 12345n, vaultId: 171n };
    const ts = encryptNoteData(view.publicKey, plain, { ephemeralSecret: eph, nonce });
    const rs = wasm.encrypt_note_data(view.publicKey, be32(plain.amount), be32(plain.noteSecret), be32(plain.vaultId), eph, nonce);
    expect(bytesToHex(rs)).toBe(bytesToHex(ts));
    const opened = wasm.decrypt_note_data(be32(keys.viewKey), ts);
    expect(fromBe(opened.slice(0, 32))).toBe(plain.amount);
    expect(fromBe(opened.slice(32, 64))).toBe(plain.noteSecret);
    expect(fromBe(opened.slice(64, 96))).toBe(plain.vaultId);
    expect(decryptNoteData(view, rs)).toEqual(plain);
    expect(wasm.decrypt_note_data(be32(deriveKeys(utf8ToBytes("someone else")).viewKey), ts)).toBeUndefined();
    expect(fromBe(wasm.note_data_hash(ts))).toBe(noteDataHash(ts));
    const core = hexToBytes("000000000000000000000000000000000000cafe");
    expect(fromBe(wasm.tx_domain(31337, core))).toBe(txDomain(31337n, 0xcafen));
    const oc = ownerCommitmentOf(keys.spendKey);
    const addr = encodePrivacyAddress(oc, view.publicKey);
    expect(wasm.privacy_address(be32(oc), view.publicKey)).toBe(addr);
    const parsed = wasm.parse_privacy_address(addr);
    expect(parsed[0]).toBe(1);
    expect(fromBe(parsed.slice(1, 33))).toBe(decodePrivacyAddress(addr).ownerCommitment);
    expect(() => wasm.parse_privacy_address(addr.slice(0, -1) + "x")).toThrow();
  });

  it("Merkle root of the 4-aligned accumulator", () => {
    const tree = new MerkleTree(10);
    tree.insertLeaf(123n);
    tree.insertGroup([4n, 5n, 6n, ZERO_LEAF]);
    const leaves = concat(...tree.leaves.map(be32));
    expect(fromBe(wasm.merkle_root(leaves, 10))).toBe(tree.root);
    expect(fromBe(wasm.merkle_root(new Uint8Array(0), 10))).toBe(new MerkleTree(10).root);
  });

  it("builds every tree layer in one call (the sync batch) with the reference's layers and paths", () => {
    const leaves = Array.from({ length: 1000 }, (_, i) => BigInt(i + 1) * 7919n);
    const ts = MerkleLayers.build(leaves, 32);
    const out: Uint8Array = wasm.merkle_layers(concat(...leaves.map(be32)), 32);
    const upper: bigint[][] = [];
    let size = leaves.length, off = 0;
    for (let l = 0; l < 32; l++) {
      size = Math.ceil(size / 2);
      const layer: bigint[] = [];
      for (let i = 0; i < size; i++, off += 32) layer.push(fromBe(out.subarray(off, off + 32)));
      upper.push(layer);
    }
    expect(off).toBe(out.length);
    const rs = MerkleLayers.fromLayers(leaves, upper, 32);
    expect(rs.root).toBe(ts.root);
    expect(rs.layers).toEqual(ts.layers);
    for (const i of [0, 1, 2, 511, 998, 999]) expect(rs.proof(i)).toEqual(ts.proof(i));
    expect(wasm.merkle_layers(new Uint8Array(0), 32).length).toBe(0);
    expect(() => wasm.merkle_layers(new Uint8Array(33), 32)).toThrow();
    expect(() => wasm.merkle_layers(new Uint8Array(32), 2)).toThrow();
  });

  it("scans a payload set for our notes in one call (the rescan batch) exactly like noteFromPayload", () => {
    const view = viewKeyPair(keys.viewKey);
    const other = deriveKeys(utf8ToBytes("someone else"));
    const oc = ownerCommitmentOf(keys.spendKey);
    const mine: Note = { vaultId: 171n, amount: 5n * 10n ** 17n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, 3) };
    const again: Note = { ...mine, amount: 9n };
    const plain = (n: Note) => ({ amount: n.amount, noteSecret: n.noteSecret, vaultId: n.vaultId });
    // leaf 4 ours; 5 someone else's; 6 decrypts for us but the leaf holds another commitment; 7 a dummy; 8 ours; 9 ours but tampered
    const tampered = encryptNoteData(view.publicKey, plain(mine));
    tampered[100] ^= 1;
    const items = [
      { leafIndex: 4, commitment: noteCommitment(noteBody(mine), 4n), noteData: encryptNoteData(view.publicKey, plain(mine)) },
      { leafIndex: 5, commitment: noteCommitment(noteBody({ ...mine, ownerCommitment: ownerCommitmentOf(other.spendKey) }), 5n), noteData: encryptNoteData(viewKeyPair(other.viewKey).publicKey, plain(mine)) },
      { leafIndex: 6, commitment: 123456n, noteData: encryptNoteData(view.publicKey, plain(mine)) },
      { leafIndex: 7, commitment: 7n, noteData: dummyNoteData() },
      { leafIndex: 8, commitment: noteCommitment(noteBody(again), 8n), noteData: encryptNoteData(view.publicKey, plain(again)) },
      { leafIndex: 9, commitment: noteCommitment(noteBody(mine), 9n), noteData: tampered },
    ];
    const idx = new Uint32Array(items.map((i) => i.leafIndex));
    const out: Uint8Array = wasm.scan_note_payloads(be32(keys.viewKey), be32(oc), idx, concat(...items.map((i) => be32(i.commitment))), concat(...items.map((i) => i.noteData)));
    expect(out.length % 100).toBe(0);
    const hits = [];
    for (let off = 0; off < out.length; off += 100) {
      const leafIndex = new DataView(out.buffer, out.byteOffset + off, 4).getUint32(0);
      hits.push({ leafIndex, note: { vaultId: fromBe(out.subarray(off + 68, off + 100)), amount: fromBe(out.subarray(off + 4, off + 36)), ownerCommitment: oc, noteSecret: fromBe(out.subarray(off + 36, off + 68)) } });
    }
    const expected = items.flatMap((i) => { const n = noteFromPayload(view, oc, i.leafIndex, i.commitment, i.noteData); return n ? [{ leafIndex: i.leafIndex, note: n }] : []; });
    expect(hits).toEqual(expected);
    expect(hits.map((h) => h.leafIndex)).toEqual([4, 8]);
    expect(wasm.scan_note_payloads(be32(keys.viewKey), be32(oc), new Uint32Array(0), new Uint8Array(0), new Uint8Array(0)).length).toBe(0);
    expect(() => wasm.scan_note_payloads(be32(keys.viewKey), be32(oc), idx, new Uint8Array(32), new Uint8Array(169))).toThrow(/same count/);
  });

  it("recovery phrase, BIP-39 seed and chain keys", () => {
    const entropy = new Uint8Array(32).map((_, i) => (i * 11 + 3) & 0xff);
    const phrase = entropyToMnemonic(entropy, wordlist);
    expect(wasm.seed_to_phrase(entropy)).toBe(phrase);
    expect(bytesToHex(wasm.mnemonic_to_seed(phrase, ""))).toBe(bytesToHex(mnemonicToSeedSync(phrase)));
    const s64 = bip39Seed(phrase);
    for (const i of [0, 1, 7]) {
      expect(wasm.evm_address(s64, i)).toBe(evmAccount(s64, i).address);
      expect(wasm.bitcoin_address(s64, i)).toBe(bitcoinAccount(s64, i).address);
      expect(wasm.solana_address(s64, i)).toBe(solanaAccount(s64, i).address);
    }
  });

  it("opens the web wallet's keystore vector", () => {
    const w = JSON.parse(readFileSync(join(here, "vectors/wallet.json"), "utf8"));
    expect(bytesToHex(wasm.unlock_keystore(JSON.stringify(w.keystore.keystore), w.keystore.password))).toBe(w.keystore.seed);
    expect(wasm.unlock_keystore(JSON.stringify(w.keystore.keystore), "wrong")).toBeUndefined();
  });

  it("is faster than the BigInt implementation at Poseidon2 (informational)", () => {
    const a = be32(1n), b = be32(2n);
    const N = 2000;
    let t0 = performance.now();
    for (let i = 0; i < N; i++) wasm.poseidon2_hash(concat(a, b));
    const wasmMs = performance.now() - t0;
    t0 = performance.now();
    for (let i = 0; i < N; i++) hash([1n, 2n]);
    const tsMs = performance.now() - t0;
    console.log(`Poseidon2 hash2 × ${N}: wasm ${wasmMs.toFixed(0)} ms, TypeScript ${tsMs.toFixed(0)} ms (×${(tsMs / wasmMs).toFixed(1)})`);
    expect(wasmMs).toBeLessThan(tsMs * 2); // never dramatically slower, whatever the machine
    // the batches a sync is made of: every layer of a 4096-leaf tree, and discovery over 300 payloads
    const leaves = Array.from({ length: 4096 }, (_, i) => BigInt(i + 1));
    const packed = concat(...leaves.map(be32));
    t0 = performance.now();
    wasm.merkle_layers(packed, 32);
    const layersWasm = performance.now() - t0;
    t0 = performance.now();
    MerkleLayers.build(leaves, 32);
    const layersTs = performance.now() - t0;
    const view = viewKeyPair(keys.viewKey);
    const payloads = Array.from({ length: 300 }, () => encryptNoteData(view.publicKey, { amount: 1n, noteSecret: 2n, vaultId: 3n }));
    const cms = concat(...payloads.map(() => be32(1n)));
    t0 = performance.now();
    wasm.scan_note_payloads(be32(keys.viewKey), be32(ownerCommitmentOf(keys.spendKey)), new Uint32Array(300), cms, concat(...payloads));
    const scanWasm = performance.now() - t0;
    t0 = performance.now();
    for (const p of payloads) decryptNoteData(view, p);
    const scanTs = performance.now() - t0;
    console.log(`tree layers x 4096 leaves: wasm ${layersWasm.toFixed(0)} ms, TypeScript ${layersTs.toFixed(0)} ms (x${(layersTs / layersWasm).toFixed(1)}); discovery x 300 payloads: wasm ${scanWasm.toFixed(0)} ms, TypeScript ${scanTs.toFixed(0)} ms (x${(scanTs / scanWasm).toFixed(1)})`);
    expect(layersWasm).toBeLessThan(layersTs);
  });
});
