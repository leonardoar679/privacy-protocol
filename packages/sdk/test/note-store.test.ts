// One note per leaf (a V6 follow-up of 2026-10-16, audit c23/c34; packages/sdk/src/wallet/notes.ts). A note scan that ran
// while a Protect, a Send's change or a merge was waiting for its receipt recorded the leaf first, and the flow then added
// it again: the balance counted the note twice, and every spend that picked both copies failed (a duplicate input). A
// second copy now completes the first, and a journal that already holds a leaf twice loads it once.
import { beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { Note } from "@privacy-wallet/protocol/note";
import { NoteStore, type OwnedNote } from "../src/wallet/notes";

const VAULT = 0xabn;
const note = (amount: bigint, secret: bigint): Note => ({ vaultId: VAULT, amount, ownerCommitment: 5n, noteSecret: secret });
const DATA = ("0x01" + "00".repeat(168)) as Hex;
const TX = ("0x" + "77".repeat(32)) as Hex;
const owned = (n: Note, leafIndex: number, extra: Partial<OwnedNote> = {}): OwnedNote => ({ note: n, leafIndex, noteData: DATA, spent: false, ...extra });

let store: NoteStore;
beforeEach(() => {
  store = new NoteStore();
});

describe("one note per leaf", () => {
  it("a scan's copy, then the flow's: one note, counted once, with the flow's label, counter, time and transaction", () => {
    const n = note(10n ** 18n, 11n);
    store.add(owned(n, 4, { label: "discovered" }));
    store.add(owned(n, 4, { label: "shield", counter: 3, addedAt: 1_000, txHash: TX }));
    expect(store.all()).toHaveLength(1);
    expect(store.balance(VAULT)).toBe(10n ** 18n);
    expect(store.all()[0]).toMatchObject({ leafIndex: 4, label: "shield", counter: 3, addedAt: 1_000, txHash: TX, spent: false });
  });

  it("the flow's copy, then a scan's: the flow's words stay, and spent stays spent", () => {
    const n = note(7n, 12n);
    store.add(owned(n, 8, { label: "change", counter: 9, addedAt: 2_000 }));
    store.add(owned(n, 8, { label: "discovered", spent: true }));
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({ label: "change", counter: 9, addedAt: 2_000, spent: true });
    expect(store.unspent(VAULT)).toEqual([]);
  });

  it("notes at different leaves are all kept", () => {
    store.add(owned(note(1n, 1n), 0));
    store.add(owned(note(1n, 1n), 4));
    store.add(owned(note(2n, 2n), 8));
    expect(store.all().map((x) => x.leafIndex)).toEqual([0, 4, 8]);
    expect(store.balance(VAULT)).toBe(4n);
  });

  it("another note at a leaf replaces the one there: each was checked against the leaf when it came (a block the chain dropped)", () => {
    store.add(owned(note(3n, 21n), 4, { label: "shield", counter: 2, spent: true }));
    store.add(owned(note(9n, 22n), 4, { label: "discovered" }));
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]).toMatchObject({ note: note(9n, 22n), label: "discovered", spent: false });
    expect(store.all()[0].counter).toBeUndefined();
    expect(store.balance(VAULT)).toBe(9n);
  });

  it("a journal that holds a leaf twice loads it once, completed, and keeps the counter", () => {
    const s = (leafIndex: number, extra: Record<string, unknown> = {}) => ({
      vaultId: VAULT.toString(),
      amount: "5",
      ownerCommitment: "5",
      noteSecret: "13",
      leafIndex,
      noteData: DATA,
      spent: false,
      ...extra,
    });
    store.load({ notes: [s(4, { label: "discovered" }), s(4, { label: "shield", counter: 6 }), s(12)], noteCounter: 7 });
    expect(store.all().map((x) => [x.leafIndex, x.label, x.counter])).toEqual([
      [4, "shield", 6],
      [12, undefined, undefined],
    ]);
    expect(store.balance(VAULT)).toBe(10n);
    expect(store.nextCounter()).toBe(7);
    expect(store.serialize().notes).toHaveLength(2);
  });
});
