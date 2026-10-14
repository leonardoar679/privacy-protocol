// The timing facts of a swap's funding (spec v2.0 §14.1): the youngest note the withdrawal would spend — the same
// selection it makes — with its age when this wallet created it, and the deposits since its leaf from the pool's sync.
import { afterEach, describe, expect, it } from "vitest";
import { noteStore } from "../src/wallet/notes";
import { poolStats } from "../src/wallet/poolStats";
import { fundingTiming } from "../src/wallet/privacyTiming";

const VAULT = 0xe7n;
const T0 = Date.parse("2026-10-13T12:00:00Z");
const note = (leafIndex: number, amount: bigint, addedAt?: number) =>
  noteStore.add({
    note: { vaultId: VAULT, amount, ownerCommitment: 1n, noteSecret: BigInt(leafIndex + 2) },
    leafIndex,
    noteData: "0x",
    spent: false,
    ...(addedAt !== undefined ? { addedAt } : {}),
  });
afterEach(() => noteStore.clear());

describe("fundingTiming", () => {
  it("the note the withdrawal spends: its age from when this wallet created it, the deposits since its leaf", () => {
    note(3, 5n * 10n ** 18n, T0 - 3 * 86400_000); // old, large: the one a 1 ETH funding spends (the smallest sufficient)
    note(40, 10n ** 17n, T0 - 60_000); // new, too small for it
    poolStats.set({ notes: 100, leaves: 100 });
    expect(fundingTiming(VAULT, 10n ** 18n, T0)).toEqual({ ageSeconds: 3 * 86400, depositsSince: 96 });
  });
  it("a note a scan found has no known age; before a sync the deposits are unknown; nothing to spend, nothing known", () => {
    note(7, 10n ** 18n);
    expect(fundingTiming(VAULT, 10n ** 17n, T0).ageSeconds).toBeNull();
    noteStore.clear();
    expect(fundingTiming(VAULT, 10n ** 17n, T0)).toEqual({ ageSeconds: null, depositsSince: null });
  });
  it("two notes that need a merge first: the funding spends a note made just then", () => {
    note(1, 6n * 10n ** 17n, T0 - 86400_000);
    note(2, 6n * 10n ** 17n, T0 - 86400_000);
    note(3, 6n * 10n ** 17n, T0 - 86400_000);
    poolStats.set({ notes: 10, leaves: 10 });
    const t = fundingTiming(VAULT, 17n * 10n ** 17n, T0);
    expect(t).toEqual({ ageSeconds: 0, depositsSince: 0 });
  });
});
