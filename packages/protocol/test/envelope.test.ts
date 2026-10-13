// Output payload envelope (spec §12) + view-key binding + privacy address: round trips, rejection of
// anything not ours or tampered, dummies indistinguishable in shape, note discovery bound to the
// leaf commitment, bech32m addresses that catch typos. Deterministic vectors are pinned so another
// implementation can reproduce them (test/vectors/envelope.json).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { decryptNoteData, dummyNoteData, encryptNoteData, ENVELOPE_VERSION, noteFromPayload, viewKeyPair } from "../src/envelope";
import { bech32mDecode, bech32mEncode, decodePrivacyAddress, encodePrivacyAddress } from "../src/address";
import { deriveKeys, deriveNoteSecret } from "../src/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "../src/note";
import { NOTE_DATA_BYTES, noteDataHash } from "../src/payload";

const alice = deriveKeys(utf8ToBytes("privacy-protocol/example-master-seed"));
const bob = deriveKeys(utf8ToBytes("privacy-protocol/example-bob"));
const aliceView = viewKeyPair(alice.viewKey), bobView = viewKeyPair(bob.viewKey);
const VAULT = BigInt("0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469");

describe("view key → X25519 key pair", () => {
  it("is deterministic, clamped, and distinct per wallet", () => {
    const again = viewKeyPair(alice.viewKey);
    expect(bytesToHex(again.publicKey)).toBe(bytesToHex(aliceView.publicKey));
    expect(aliceView.secret[0] & 7).toBe(0);
    expect(aliceView.secret[31] & 0x80).toBe(0);
    expect(aliceView.secret[31] & 0x40).toBe(0x40);
    expect(bytesToHex(bobView.publicKey)).not.toBe(bytesToHex(aliceView.publicKey));
  });
});

describe("envelope", () => {
  const plain = { amount: 6n * 10n ** 17n, noteSecret: deriveNoteSecret(alice.noteKey, 7), vaultId: VAULT };
  it("encrypts to exactly 169 bytes with the pinned layout and round-trips for the recipient only", () => {
    const nd = encryptNoteData(aliceView.publicKey, plain);
    expect(nd.length).toBe(NOTE_DATA_BYTES);
    expect(nd[0]).toBe(ENVELOPE_VERSION);
    expect(decryptNoteData(aliceView, nd)).toEqual(plain);
    expect(decryptNoteData(bobView, nd)).toBeNull();
    expect(bytesToHex(encryptNoteData(aliceView.publicKey, plain))).not.toBe(bytesToHex(nd)); // fresh ephemeral key + nonce every time
  });
  it("rejects any tampering: version, ephemeral key, nonce, ciphertext, tag", () => {
    const nd = encryptNoteData(aliceView.publicKey, plain);
    for (const i of [0, 1, 20, 33, 56, 57, 100, 152, 153, 168]) {
      const t = nd.slice();
      t[i] ^= 0x01;
      expect(decryptNoteData(aliceView, t), `byte ${i}`).toBeNull();
    }
    expect(decryptNoteData(aliceView, nd.subarray(0, 168))).toBeNull();
  });
  it("dummies have the real envelope's shape and open for nobody", () => {
    const d = dummyNoteData();
    expect(d.length).toBe(NOTE_DATA_BYTES);
    expect(d[0]).toBe(ENVELOPE_VERSION);
    expect(decryptNoteData(aliceView, d)).toBeNull();
    expect(noteDataHash(d)).not.toBe(noteDataHash(dummyNoteData()));
  });
  it("note discovery accepts only a payload that opens the leaf with OUR owner commitment", () => {
    const oc = ownerCommitmentOf(alice.spendKey);
    const note: Note = { vaultId: VAULT, amount: plain.amount, ownerCommitment: oc, noteSecret: plain.noteSecret };
    const leaf = noteCommitment(noteBody(note), 5n);
    const nd = encryptNoteData(aliceView.publicKey, plain);
    expect(noteFromPayload(aliceView, oc, 5, leaf, nd)).toEqual(note);
    expect(noteFromPayload(aliceView, oc, 6, leaf, nd)).toBeNull(); // wrong leaf index
    expect(noteFromPayload(aliceView, ownerCommitmentOf(bob.spendKey), 5, leaf, nd)).toBeNull(); // not the owner
    expect(noteFromPayload(bobView, oc, 5, leaf, nd)).toBeNull(); // cannot open it
    const lying = encryptNoteData(aliceView.publicKey, { ...plain, amount: plain.amount + 1n }); // decrypts, but does not open the leaf
    expect(noteFromPayload(aliceView, oc, 5, leaf, lying)).toBeNull();
  });
  it("reproduces the pinned deterministic vectors", () => {
    const p = join(dirname(fileURLToPath(import.meta.url)), "vectors", "envelope.json");
    if (!existsSync(p)) return;
    const v = JSON.parse(readFileSync(p, "utf8"));
    for (const c of v.cases) {
      const view = viewKeyPair(BigInt(c.viewKey));
      expect(bytesToHex(view.publicKey)).toBe(c.viewPub);
      const nd = encryptNoteData(view.publicKey, { amount: BigInt(c.amount), noteSecret: BigInt(c.noteSecret), vaultId: BigInt(c.vaultId) }, { ephemeralSecret: hexToBytes(c.ephemeralSecret), nonce: hexToBytes(c.nonce) });
      expect(bytesToHex(nd)).toBe(c.noteData);
      expect(noteDataHash(nd).toString()).toBe(c.noteDataHash);
      expect(encodePrivacyAddress(BigInt(c.ownerCommitment), view.publicKey)).toBe(c.address);
    }
  });
});

describe("privacy address (bech32m, hrp pp)", () => {
  it("round-trips, is case-insensitive, and rejects typos / wrong hrp / wrong version", () => {
    const oc = ownerCommitmentOf(alice.spendKey);
    const addr = encodePrivacyAddress(oc, aliceView.publicKey);
    expect(addr.startsWith("pp1")).toBe(true);
    expect(addr.length).toBe(113);
    const d = decodePrivacyAddress(addr);
    expect(d.ownerCommitment).toBe(oc);
    expect(bytesToHex(d.viewPub)).toBe(bytesToHex(aliceView.publicKey));
    expect(decodePrivacyAddress(addr.toUpperCase()).ownerCommitment).toBe(oc);
    const typo = addr.slice(0, 50) + (addr[50] === "q" ? "p" : "q") + addr.slice(51);
    expect(() => decodePrivacyAddress(typo)).toThrow(/checksum/);
    expect(() => decodePrivacyAddress(bech32mEncode("bc", new Uint8Array(65)))).toThrow(/not a privacy address/);
    expect(() => decodePrivacyAddress(bech32mEncode("pp", new Uint8Array(64)))).toThrow(/wrong length/);
    const v2 = new Uint8Array(65); v2[0] = 2;
    expect(() => decodePrivacyAddress(bech32mEncode("pp", v2))).toThrow(/version/);
    expect(() => decodePrivacyAddress("pp1" + addr.slice(3, -1) + "Q")).toThrow(/mixed-case|checksum/);
  });
  it("bech32m matches BIP-350's reference vector", () => {
    // BIP-350 test vector: hrp "a", empty data
    expect(bech32mEncode("a", new Uint8Array(0))).toBe("a1lqfn3a");
    expect(bech32mDecode("A1LQFN3A").hrp).toBe("a");
  });
});
