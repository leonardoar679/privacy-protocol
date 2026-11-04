// The pool's spend index (the sixth review round, 2026-11-03): built from the ShieldedTransaction events the scan reads with the
// note events; a note's spent bit is a lookup, the spend of exactly a record's pair is named, and the last agreed index of a pool
// is kept for the stale mover.
import { afterEach, describe, expect, it } from "vitest";
import { coreLogs, spendsDigest, type SpendLog } from "../src/chain";
import { forgetSpendIndexes, indexSpends, rememberSpendIndex, spendIndexOf } from "../src/wallet/spends";

afterEach(() => forgetSpendIndexes());

const spend = (n0: bigint, n1: bigint, tx: number): SpendLog => ({
  nullifier0: n0,
  nullifier1: n1,
  transactionHash: `0x${tx.toString(16).padStart(64, "0")}`,
  blockNumber: 10n,
});

describe("the spend index", () => {
  it("answers spent by either nullifier, the spend of exactly a pair in its order, and remembers the last index per core", () => {
    const i = indexSpends([spend(1n, 2n, 7), spend(3n, 4n, 8)], 99n);
    expect(i.size).toBe(2);
    expect(i.block).toBe(99n);
    expect([1n, 2n, 3n, 4n].map((n) => i.spent(n))).toEqual([true, true, true, true]);
    expect(i.spent(5n)).toBe(false);
    expect(i.spendOf([1n, 2n])?.transactionHash).toBe(spend(1n, 2n, 7).transactionHash);
    expect(i.spendOf([2n, 1n]), "the other order is another pair").toBeNull();
    expect(i.spendOf([1n, 4n]), "a pair of two spends is no spend").toBeNull();
    expect(i.spendOf([5n, 6n])).toBeNull();
    expect(spendIndexOf("0xCore")).toBeNull();
    rememberSpendIndex("0xCore", i);
    expect(spendIndexOf("0xcore")).toBe(i);
    expect(spendIndexOf("0xother")).toBeNull();
    expect(spendsDigest([spend(1n, 2n, 7)])).not.toBe(spendsDigest([spend(1n, 2n, 8)]));
    expect(spendsDigest([])).toBe(spendsDigest([]));
  });
  it("coreLogs reads the notes and the spends in one filter per window and tells a fake's undecoded logs apart by their fields", async () => {
    const filters: unknown[] = [];
    const client = {
      getBlockNumber: async () => 20n,
      getLogs: async (q: { events?: unknown[]; fromBlock: bigint; toBlock: bigint | "latest" }) => {
        filters.push(q.events?.length);
        return [
          { eventName: "NoteInserted", args: { leafIndex: 0, commitment: 7n, noteData: "0x" }, transactionHash: "0xaa", blockNumber: 3n },
          {
            eventName: "ShieldedTransaction",
            args: { nullifier0: 11n, nullifier1: 12n, commitment0: 0n, commitment1: 0n, commitment2: 0n },
            transactionHash: "0xbb",
            blockNumber: 4n,
          },
          { args: { leafIndex: 1, commitment: 8n, noteData: "0x01" }, transactionHash: "0xcc", blockNumber: 5n },
          { args: { nullifier0: 13n, nullifier1: 14n }, transactionHash: "0xdd", blockNumber: 6n },
          { eventName: undefined, args: {}, transactionHash: "0xee", blockNumber: 7n },
        ];
      },
    };
    const d = { core: "0x00000000000000000000000000000000000000c0", fromBlock: 0n };
    const r = await coreLogs(client as never, d as never, 20n);
    expect(filters).toEqual([2]);
    expect(r.logs.map((l) => [l.leafIndex, l.commitment, l.transactionHash])).toEqual([
      [0, 7n, "0xaa"],
      [1, 8n, "0xcc"],
    ]);
    expect(r.spends.map((s) => [s.nullifier0, s.nullifier1, s.transactionHash, s.blockNumber])).toEqual([
      [11n, 12n, "0xbb", 4n],
      [13n, 14n, "0xdd", 6n],
    ]);
  });
});
