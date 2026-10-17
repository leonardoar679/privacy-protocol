// A deposited note's own owner key (a V6 follow-up of 2026-10-16, audit c18/c29/c37): keys.ts deriveOwnerKey against its
// pinned vectors (test/vectors/owner-keys.json, which the Python reference and the Rust core reproduce too), an independent
// encoding of its preimage, and the properties the wallet relies on: one key per note secret, apart from the privacy
// address's owner commitment, the note secrets and the spend key; field elements only. The derivation never changes —
// deposits, escrows and receivers fix it for good —, so the vector file itself is pinned by its SHA-256.
import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { FIELD } from "../src/field";
import { deriveKeys, deriveNoteSecret, deriveOwnerKey, OWNER_KEY_LABEL } from "../src/keys";
import { noteBody, noteCommitment, ownerCommitmentOf } from "../src/note";
import { nullifier, phantomNullifier } from "../src/nullifier";

const TEXT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors", "owner-keys.json"), "utf8").replace(/\r\n/g, "\n");
const V = JSON.parse(TEXT);
const keys = deriveKeys(utf8ToBytes(V.seed));

describe("deriveOwnerKey: a deposited note's own owner key", () => {
  it("is the frozen derivation: the vector file is the pinned one", () => {
    expect(createHash("sha256").update(TEXT).digest("hex")).toBe("14aaeec25811b4322820485e1fe863c20871a4d8aeb50a10c9c85c1b525cff24");
  });

  it("reproduces the pinned vectors", () => {
    expect(OWNER_KEY_LABEL).toBe(V.label);
    expect(keys.spendKey.toString()).toBe(V.spendKey);
    expect(keys.noteKey.toString()).toBe(V.noteKey);
    expect(ownerCommitmentOf(keys.spendKey).toString()).toBe(V.mainOwnerCommitment);
    for (const k of V.byCounter) {
      const secret = deriveNoteSecret(keys.noteKey, k.counter);
      expect(secret.toString(), `counter ${k.counter}`).toBe(k.noteSecret);
      const key = deriveOwnerKey(keys.spendKey, secret);
      expect(key.toString(), `counter ${k.counter}`).toBe(k.ownerKey);
      expect(ownerCommitmentOf(key).toString(), `counter ${k.counter}`).toBe(k.ownerCommitment);
    }
    for (const k of V.edgeSecrets) {
      const key = deriveOwnerKey(keys.spendKey, BigInt(k.noteSecret));
      expect(key.toString(), `secret ${k.noteSecret}`).toBe(k.ownerKey);
      expect(ownerCommitmentOf(key).toString(), `secret ${k.noteSecret}`).toBe(k.ownerCommitment);
    }
    const s = V.sampleSpend;
    const secret = deriveNoteSecret(keys.noteKey, s.counter);
    const key = deriveOwnerKey(keys.spendKey, secret);
    const note = { vaultId: BigInt(s.vaultId), amount: BigInt(s.amount), ownerCommitment: ownerCommitmentOf(key), noteSecret: secret };
    expect(noteBody(note).toString()).toBe(s.body);
    const cm = noteCommitment(noteBody(note), BigInt(s.leafIndex));
    expect(cm.toString()).toBe(s.commitment);
    expect(nullifier(cm, key).toString()).toBe(s.nullifier);
    expect(phantomNullifier(nullifier(cm, key), 1, key).toString()).toBe(s.phantom);
  });

  it("is keccak256 over the 75 bytes be32(spendKey) || '/owner-key/' || be32(noteSecret), mod p", () => {
    const be32 = (x: bigint) => hexToBytes(x.toString(16).padStart(64, "0"));
    const secret = deriveNoteSecret(keys.noteKey, 1);
    const pre = concatBytes(be32(keys.spendKey), utf8ToBytes("/owner-key/"), be32(secret));
    expect(pre.length).toBe(75);
    expect("0x" + bytesToHex(pre)).toBe(V.preimageCounter1);
    expect(deriveOwnerKey(keys.spendKey, secret)).toBe(BigInt("0x" + bytesToHex(keccak_256(pre))) % FIELD);
    // a leading zero byte in either word is kept, not dropped
    expect(deriveOwnerKey(1n, 2n)).toBe(BigInt("0x" + bytesToHex(keccak_256(concatBytes(be32(1n), utf8ToBytes("/owner-key/"), be32(2n))))) % FIELD);
  });

  it("is one key per note secret, apart from the privacy address's owner commitment, the secrets and the spend key", () => {
    const main = ownerCommitmentOf(keys.spendKey);
    const seen = new Set<bigint>();
    for (let c = 0; c < 64; c++) {
      const secret = deriveNoteSecret(keys.noteKey, c);
      const key = deriveOwnerKey(keys.spendKey, secret);
      const oc = ownerCommitmentOf(key);
      expect(oc).not.toBe(main);
      expect(key).not.toBe(keys.spendKey);
      expect(key).not.toBe(secret);
      expect(seen.has(oc), `counter ${c}`).toBe(false);
      seen.add(oc);
    }
    const other = deriveKeys(utf8ToBytes("another seed"));
    const secret = deriveNoteSecret(keys.noteKey, 1);
    expect(deriveOwnerKey(other.spendKey, secret)).not.toBe(deriveOwnerKey(keys.spendKey, secret));
    // the view key and the note key are no spend key: neither derives the owner key
    expect(deriveOwnerKey(keys.viewKey, secret)).not.toBe(deriveOwnerKey(keys.spendKey, secret));
    expect(deriveOwnerKey(keys.noteKey, secret)).not.toBe(deriveOwnerKey(keys.spendKey, secret));
  });

  it("takes field elements only", () => {
    for (const [k, s] of [
      [keys.spendKey, FIELD],
      [keys.spendKey, -1n],
      [FIELD, 1n],
      [-1n, 1n],
    ] as const)
      expect(() => deriveOwnerKey(k, s), `${k} ${s}`).toThrow(/field elements only/);
  });
});
