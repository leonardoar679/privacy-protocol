import { describe, it, expect } from "vitest";
import { noteBody, noteCommitment } from "../src/note";
import { nullifier, phantomNullifier } from "../src/nullifier";
import { MerkleTree } from "../src/merkle";
import { inField } from "../src/field";
import * as D from "../src/domains";

const note = (ownerCommitment: bigint, amount: bigint, vaultId: bigint, noteSecret = 7n) => ({
  ownerCommitment, amount, vaultId, noteSecret,
});

describe("domain separators", () => {
  it("are all in-field and pairwise distinct", () => {
    const tags = [D.NOTE_BODY, D.NOTE_COMMITMENT, D.OWNER_COMMITMENT, D.NULLIFIER, D.PHANTOM_NULLIFIER];
    for (const t of tags) expect(inField(t)).toBe(true);
    expect(new Set(tags.map(String)).size).toBe(tags.length);
  });
});

describe("note commitment", () => {
  it("is deterministic and in-field", () => {
    const b = noteBody(note(123n, 10n ** 18n, 456n));
    expect(noteCommitment(b, 0n)).toBe(noteCommitment(b, 0n));
    expect(inField(noteCommitment(b, 0n))).toBe(true);
  });
  it("binds the leaf index (structural uniqueness, spec §5.2)", () => {
    const b = noteBody(note(123n, 10n ** 18n, 456n));
    expect(noteCommitment(b, 0n)).not.toBe(noteCommitment(b, 1n));
  });
  it("binds the note secret (PP-P01): same owner/amount/asset, different secret -> different body", () => {
    expect(noteBody(note(123n, 5n, 7n, 1n))).not.toBe(noteBody(note(123n, 5n, 7n, 2n)));
  });
});

describe("nullifier", () => {
  it("is 1:1 — distinct notes give distinct nullifiers (fixes TC-22)", () => {
    const key = 99n;
    const nA = nullifier(noteCommitment(noteBody(note(1n, 5n, 7n)), 0n), key);
    const nB = nullifier(noteCommitment(noteBody(note(2n, 5n, 7n)), 0n), key);
    expect(nA).not.toBe(nB);
  });
  it("phantom nullifier differs from the real one and depends on the private key (PP-P02)", () => {
    const r = nullifier(noteCommitment(noteBody(note(1n, 5n, 7n)), 0n), 99n);
    expect(phantomNullifier(r, 1, 99n)).not.toBe(r);
    expect(phantomNullifier(r, 1, 99n)).not.toBe(phantomNullifier(r, 1, 98n));
  });
});

describe("merkle accumulator", () => {
  it("advances the root per group and stays in-field", () => {
    const t = new MerkleTree(10);
    const r0 = t.root;
    const idx = t.insertLeaf(noteCommitment(noteBody(note(1n, 5n, 7n)), 0n));
    expect(idx).toBe(0);
    expect(t.nextIndex).toBe(4);
    expect(t.root).not.toBe(r0);
    expect(inField(t.root)).toBe(true);
  });
});
