// The history on the device (spec v3.0 §7.4, §7.8; V7 Stage 7): the Classic app's own IndexedDB `tornado-classic`
// round-trips a pool's snapshot, state and layers, forgets a pool on request, is read by a second opener; the memory
// store stands in where IndexedDB is absent (Node here, a refused browser store).
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DepositEvent, WithdrawalEvent } from "../src/history/events";
import type { SnapshotManifest, TreeFile } from "../src/history/snapshot";
import { HISTORY_DB, historyStore, indexedDbHistoryStore, memoryHistoryStore, type StoredHistory } from "../src/storage/historyDb";

const FIXTURE = join(__dirname, "fixtures", "history", "first-1024", "eth-100");
const read = (name: string) => readFileSync(join(FIXTURE, name), "utf8");
const manifest = JSON.parse(read("manifest.json")) as SnapshotManifest;
const history: StoredHistory = {
  manifest,
  state: {
    pool: "eth-100",
    address: manifest.address,
    toBlock: manifest.toBlock,
    blockHash: manifest.blockHash,
    leaves: manifest.leaves,
    checkpoints: [{ blockNumber: manifest.toBlock, blockHash: manifest.blockHash! }],
    window: 500_000,
  },
  deposits: JSON.parse(read("deposits.json")) as DepositEvent[],
  withdrawals: JSON.parse(read("withdrawals.json")) as WithdrawalEvent[],
  layers: (JSON.parse(read("tree.json")) as TreeFile).layers,
};

describe("the history store", () => {
  it("IndexedDB: a pool's history round-trips, another pool is apart, a second opener reads it, clear forgets it", async () => {
    const store = indexedDbHistoryStore(indexedDB);
    expect(await store.read("eth-100")).toBeNull();
    await store.write("eth-100", history);
    const back = await store.read("eth-100");
    expect(back?.state).toEqual(history.state);
    expect(back?.manifest?.root).toBe(manifest.root);
    expect(back?.deposits.length).toBe(1024);
    expect(back?.withdrawals.length).toBe(history.withdrawals.length);
    expect(back?.layers.length).toBe(21);
    expect(back?.layers[0][1023]).toBe(history.layers[0][1023]);
    expect(await store.read("eth-1")).toBeNull();
    const again = indexedDbHistoryStore(indexedDB);
    expect((await again.read("eth-100"))?.state.toBlock).toBe(manifest.toBlock);
    // an update replaces every part
    await store.write("eth-100", { ...history, state: { ...history.state, toBlock: manifest.toBlock + 1 }, deposits: history.deposits.slice(0, 10) });
    const updated = await store.read("eth-100");
    expect(updated?.state.toBlock).toBe(manifest.toBlock + 1);
    expect(updated?.deposits.length).toBe(10);
    await store.clear("eth-100");
    expect(await store.read("eth-100")).toBeNull();
    expect(HISTORY_DB).toBe("tornado-classic");
  });

  it("the memory store behaves the same and is what historyStore() gives where IndexedDB is absent", async () => {
    const mem = memoryHistoryStore();
    expect(await mem.read("eth-100")).toBeNull();
    await mem.write("eth-100", history);
    expect((await mem.read("eth-100"))?.state.leaves).toBe(1024);
    await mem.clear("eth-100");
    expect(await mem.read("eth-100")).toBeNull();
    // with fake-indexeddb installed on the global, historyStore() picks IndexedDB
    const picked = historyStore();
    await picked.write("eth-10", history);
    expect((await indexedDbHistoryStore(indexedDB).read("eth-10"))?.state.pool).toBe("eth-100");
    await picked.clear("eth-10");
  });
});
