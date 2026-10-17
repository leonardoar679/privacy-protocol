// Spending notes with their own owner keys (the audit round of 2026-10-16, c18; packages/sdk/src/keys/ownerKeys.ts): a
// deposited note made out to its own owner commitment is spent with the key derived from its secret, a note of the privacy
// address with the spend key — chosen by owner-commitment equality, input by input, in withdrawals, merges and splits —
// and the unchanged circuit's inputs build (buildTxInputs checks each key against its note). A note neither key opens is
// left out of the choice, and refused before anything is proved when it is named.
import { beforeEach, describe, expect, it } from "vitest";
import { utf8ToBytes } from "@noble/hashes/utils";
import { MerkleLayers, MerkleTree } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS, buildTxInputs } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret, deriveOwnerKey } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { txDomain } from "@privacy-wallet/protocol/payload";
import { NoOwnerKey, ownerKeyOf } from "@privacy-wallet/sdk/keys/ownerKeys";
import { placeholderNoteData, planMerge, planSplit, planWithdrawal } from "@privacy-wallet/sdk/privateTx";
import { noteStore, type OwnedNote } from "@privacy-wallet/sdk/wallet/notes";

const VAULT = BigInt("0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469");
const seed = utf8ToBytes("owner-keys-spend-test-seed");
const keys = deriveKeys(seed);
const main = ownerCommitmentOf(keys.spendKey);
const domain = txDomain(31337n, BigInt("0x5FbDB2315678afecb367f032d93F642f64180aa3"));
const ONE = 10n ** 18n;

const secret3 = deriveNoteSecret(keys.noteKey, 3);
const key3 = deriveOwnerKey(keys.spendKey, secret3);
// leaf 0: a protect made out to its own owner commitment (counter 3); leaf 4: a change note of the privacy address (counter 4,
// a counter too); leaf 8: a note made out to an owner commitment neither key opens, larger than both
const deposited: Note = { vaultId: VAULT, amount: ONE, ownerCommitment: ownerCommitmentOf(key3), noteSecret: secret3 };
const change: Note = { vaultId: VAULT, amount: 6n * 10n ** 17n, ownerCommitment: main, noteSecret: deriveNoteSecret(keys.noteKey, 4) };
const foreign: Note = { vaultId: VAULT, amount: 50n * ONE, ownerCommitment: 0x0badn, noteSecret: deriveNoteSecret(keys.noteKey, 5) };
const owned = (note: Note, leafIndex: number, counter: number): OwnedNote => ({
  note,
  leafIndex,
  noteData: placeholderNoteData(),
  counter,
  spent: false,
  label: "shield",
});
const tree = new MerkleTree(TX_LEVELS);
tree.insertLeaf(noteCommitment(noteBody(deposited), 0n));
tree.insertLeaf(noteCommitment(noteBody(change), 4n));
tree.insertLeaf(noteCommitment(noteBody(foreign), 8n));
const layers = MerkleLayers.build(tree.leaves, TX_LEVELS);

beforeEach(() => {
  noteStore.clear();
  noteStore.add(owned(deposited, 0, 3));
  noteStore.add(owned(change, 4, 4));
  noteStore.add(owned(foreign, 8, 5));
  noteStore.observeCounter(5);
});

describe("a note's owner key", () => {
  it("is chosen by owner-commitment equality: the spend key for the privacy address's, the derived key for a deposited note's, none otherwise", () => {
    expect(ownerKeyOf(keys, change)).toBe(keys.spendKey);
    expect(ownerKeyOf(keys, deposited)).toBe(key3);
    expect(ownerKeyOf(keys, foreign)).toBeNull();
    // a deposited note's secret under the privacy address's commitment is spent with the spend key, as every older note is
    expect(ownerKeyOf(keys, { ...deposited, ownerCommitment: main })).toBe(keys.spendKey);
    expect(ownerKeyOf(deriveKeys(utf8ToBytes("another seed")), deposited)).toBeNull();
  });
});

describe("spending with each note's own key", () => {
  it("a withdrawal over both notes: each input with its key, the circuit's inputs build; the note no key opens is never chosen", () => {
    const plan = planWithdrawal(seed, layers, VAULT, 15n * 10n ** 17n, 0xb0bn, domain);
    expect(plan.spent.map((n) => n.leafIndex).sort()).toEqual([0, 4]);
    const byLeaf = new Map(plan.spec.inputs.filter((i) => i !== null).map((i) => [i!.leafIndex, i!.spendKey]));
    expect(byLeaf.get(0)).toBe(key3);
    expect(byLeaf.get(4)).toBe(keys.spendKey);
    const inputs = buildTxInputs(plan.spec);
    expect(inputs.inOwnerKey).toContain(key3.toString());
    // 2 ETH: only the note no key opens would cover it, and it is not this wallet's to spend
    expect(() => planWithdrawal(seed, layers, VAULT, 2n * ONE, 0xb0bn, domain)).toThrow();
  });

  it("a merge and a split spend a deposited note with its own key; a note no key opens is refused before anything is proved", () => {
    const [d, c, f] = noteStore.all();
    const merge = planMerge(seed, layers, VAULT, d, c, domain);
    expect(merge.spec.inputs.map((i) => i!.spendKey)).toEqual([key3, keys.spendKey]);
    expect(() => buildTxInputs(merge.spec)).not.toThrow();
    const split = planSplit(seed, layers, d, 4n * 10n ** 17n, domain);
    expect(split.spec.inputs[0]!.spendKey).toBe(key3);
    expect(() => buildTxInputs(split.spec)).not.toThrow();
    let err: unknown;
    try {
      planMerge(seed, layers, VAULT, f, c, domain);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoOwnerKey);
    expect((err as NoOwnerKey).code).toBe("no_owner_key");
    expect(() => planSplit(seed, layers, f, ONE, domain)).toThrow(NoOwnerKey);
  });
});
