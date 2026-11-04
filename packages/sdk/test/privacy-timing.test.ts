// The timing facts of a swap's funding (spec v2.0 §14.1): the youngest note the withdrawal would spend — the same
// selection it makes — with its age when this wallet created it, and the deposits since its leaf from the pool's sync.
// "Delay for more privacy" spends older notes first: the best bound whose notes cover the amount, only when it is better.
import { afterEach, describe, expect, it } from "vitest";
import { timingOfFunding } from "@privacy-wallet/protocol/wallet/privacyAssessment";
import { noteStore } from "../src/wallet/notes";
import { poolStats } from "../src/wallet/poolStats";
import { fundingTiming, olderFunding, olderNotes } from "../src/wallet/privacyTiming";

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

describe("olderFunding ('Delay for more privacy' spends older notes first)", () => {
  const HALF = 5n * 10n ** 17n;
  it("the default selection spends a note protected a minute ago; an older note covers the swap: funded from it at once", () => {
    note(3, 2n * 10n ** 18n, T0 - 3 * 86400_000); // three days, 96 deposits since: timing 0
    note(98, 10n ** 18n, T0 - 60_000); // a minute ago: the smallest sufficient note, timing 1
    poolStats.set({ notes: 100, leaves: 100 });
    expect(timingOfFunding(fundingTiming(VAULT, HALF, T0))).toBe(1);
    expect(olderFunding(VAULT, HALF, T0)).toEqual({ maxTiming: 0, timing: { ageSeconds: 3 * 86400, depositsSince: 96 } });
    expect(olderNotes(VAULT, 0, T0).map((n) => n.leafIndex)).toEqual([3]);
    expect(olderNotes(VAULT, 1, T0).map((n) => n.leafIndex)).toEqual([3, 98]);
  });
  it("the best bound whose notes cover it: seven hours old (0.3) when the oldest is too small", () => {
    note(1, 10n ** 17n, T0 - 3 * 86400_000); // timing 0, too small
    note(40, 10n ** 18n, T0 - 7 * 3600_000); // seven hours, 59 deposits since: timing 0.3
    note(98, 10n ** 18n, T0 - 60_000);
    poolStats.set({ notes: 100, leaves: 100 });
    expect(olderFunding(VAULT, HALF, T0)).toEqual({ maxTiming: 0.3, timing: { ageSeconds: 7 * 3600, depositsSince: 59 } });
  });
  it("two older notes together (the younger of them is the timing); never a merge", () => {
    note(1, 4n * 10n ** 17n, T0 - 3 * 86400_000);
    note(2, 4n * 10n ** 17n, T0 - 3 * 86400_000);
    note(98, 10n ** 18n, T0 - 60_000);
    poolStats.set({ notes: 100, leaves: 100 });
    expect(olderFunding(VAULT, 7n * 10n ** 17n, T0)).toEqual({ maxTiming: 0, timing: { ageSeconds: 3 * 86400, depositsSince: 97 } });
    note(3, 4n * 10n ** 17n, T0 - 3 * 86400_000);
    expect(olderFunding(VAULT, 11n * 10n ** 17n, T0), "three old notes would need a merge (a note made just then)").toBeNull();
  });
  it("a note a scan found counts by the deposits since its leaf", () => {
    note(2, 2n * 10n ** 18n); // no addedAt: found by a scan
    note(98, 10n ** 18n, T0 - 60_000);
    poolStats.set({ notes: 100, leaves: 100 });
    expect(olderFunding(VAULT, HALF, T0)).toEqual({ maxTiming: 0, timing: { ageSeconds: null, depositsSince: 97 } });
  });
  it("the wallet's own fresh deposit floors the timing: older notes cannot hide a Protect made minutes ago, the funding waits for the draw (the sixth review round, 2026-11-03)", () => {
    poolStats.set({ notes: 100, leaves: 100 });
    note(3, 5n * 10n ** 18n, T0 - 3 * 86400_000); // an old note that covers 1 ETH
    // a Protect of this wallet a minute ago: what a chain observer times the exit against, whichever notes it spends
    noteStore.add({
      note: { vaultId: VAULT, amount: 10n ** 17n, ownerCommitment: 1n, noteSecret: 99n },
      leafIndex: 98,
      noteData: "0x",
      spent: false,
      addedAt: T0 - 60_000,
      label: "shield",
    }); // too small for the order: the old note is spent, the deposit still times it
    expect(fundingTiming(VAULT, 10n ** 18n, T0), "the selection spends the old note; the fact reads the fresh deposit").toEqual({
      ageSeconds: 60,
      depositsSince: 1,
    });
    expect(olderFunding(VAULT, 10n ** 18n, T0), "older notes first cannot beat the deposit's own timing: the draw").toBeNull();
    // a note the scan found is no Protect of this wallet's making (its age unknown): no floor
    noteStore.clear();
    note(3, 5n * 10n ** 18n, T0 - 3 * 86400_000);
    noteStore.add({
      note: { vaultId: VAULT, amount: 10n ** 17n, ownerCommitment: 1n, noteSecret: 98n },
      leafIndex: 97,
      noteData: "0x",
      spent: false,
      label: "discovered",
    });
    expect(fundingTiming(VAULT, 10n ** 18n, T0)).toEqual({ ageSeconds: 3 * 86400, depositsSince: 96 });
  });
  it("null when no older notes cover it or nothing would be better: the funding waits a random 1–24 h instead", () => {
    note(1, 10n ** 17n, T0 - 3 * 86400_000);
    note(98, 10n ** 18n, T0 - 60_000);
    poolStats.set({ notes: 100, leaves: 100 });
    expect(olderFunding(VAULT, HALF, T0), "the old note is too small").toBeNull();
    noteStore.clear();
    note(3, 2n * 10n ** 18n, T0 - 3 * 86400_000);
    note(98, 10n ** 18n, T0 - 60_000);
    expect(olderFunding(VAULT, 15n * 10n ** 17n, T0), "the default selection already spends the old note").toBeNull();
    expect(olderFunding(VAULT, 0n, T0)).toBeNull();
    expect(olderFunding(VAULT, 10n ** 19n, T0), "more than the balance").toBeNull();
  });
});
