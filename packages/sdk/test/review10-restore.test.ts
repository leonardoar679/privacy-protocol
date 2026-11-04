// The tenth review round (2026-11-04), part D — the wallet at rest: a restore resumes the fresh addresses past a reserve (D-2); a backup
// restored over this device's own wallet merges into its newer journal (D-4); over another wallet its settings go (D-5); the journal it
// writes holds the counters before the unlock (D-6); a backup whose journal is not a wallet journal changes nothing (D-7). The reviewer's
// probes (scratchpad review10/D P3, P4, P5, P6, P8) became these cases.
import { describe, expect, it } from "vitest";
import { WalletSession } from "../src/wallet/session";
import { memoryStorage, JOURNAL_KEY, KEYSTORE_KEY, type KeyValueStorage } from "../src/wallet/storage";
import { seedToPhrase } from "../src/wallet/keystore";
import { ADDRESS_INDEX_RESERVE, AI_FUNDING_RESERVE, decryptJournal, journalKey, type EncryptedJournal } from "../src/wallet/journal";
import { configure, defaultConfig } from "../src/config";
import { settings } from "../src/wallet/settings";
import type { StoredSwap } from "../src/wallet/journal";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const swap = (orderId: string) => ({ orderId, state: "funded", params: {}, request: {}, createdAt: 0 }) as unknown as StoredSwap;

describe("fresh addresses after a restore (D-2)", () => {
  it("a phrase restore without the journal resumes every chain's fresh-address index and Private AI's funding index past their reserves", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await s.restoreFromPhrase(seedToPhrase(new Uint8Array(32).fill(4)), "a password");
    expect(s.journal().chainIndexes).toMatchObject({ evm: ADDRESS_INDEX_RESERVE, bitcoin: ADDRESS_INDEX_RESERVE, solana: ADDRESS_INDEX_RESERVE });
    expect(s.journal().aiFunding?.index).toBe(AI_FUNDING_RESERVE);
    expect(s.journal().countersHeld).toBe(true);
    s.lock();
  });
});

describe("an unlock without its journal (D-2)", () => {
  it("a keystore whose journal is gone — a tab closed between the two writes — opens past the reserve, never at the first addresses", async () => {
    const store = memoryStorage();
    const s = new WalletSession(store, KDF);
    await s.create("a password");
    s.acknowledgePhrase();
    s.update((j) => {
      j.chainIndexes.evm = 3;
    });
    s.lock();
    store.remove(JOURNAL_KEY);
    expect(await s.unlock("a password")).toBe(true);
    expect(s.journal().chainIndexes.evm).toBe(ADDRESS_INDEX_RESERVE);
    s.lock();
  });
});

describe("a backup restored over this device's own wallet (D-4, D-6)", () => {
  it("merges into the device's newer journal — an order funded since stays, the backup's too — every counter the higher; the journal written before the unlock holds the counters", async () => {
    const base = memoryStorage();
    const writes: { key: string; value: string }[] = [];
    const store: KeyValueStorage = {
      ...base,
      get: (k) => base.get(k),
      set: (k, v) => {
        writes.push({ key: k, value: v });
        base.set(k, v);
      },
      remove: (k) => base.remove(k),
    };
    const s = new WalletSession(store, KDF);
    await s.create("a password");
    s.acknowledgePhrase();
    s.update((j) => {
      j.chainIndexes.evm = 3;
      j.chainIndexes.bitcoin = 12;
      j.swaps = [swap("0x0a")]; // the backup's alone: an order this device's journal no longer holds (another device's, say)
    });
    const backup = s.exportBackup();
    s.update((j) => {
      j.chainIndexes.evm = 7;
      j.chainIndexes.bitcoin = 2;
      j.swaps = [swap("0x0b")]; // funded after the backup: only this device's journal holds it
    });
    s.lock();
    writes.length = 0;
    expect(await s.restoreFromBackup(backup, "a password", { replace: true })).toBe(true);
    expect(
      s
        .journal()
        .swaps.map((x) => x.orderId)
        .sort(),
    ).toEqual(["0x0a", "0x0b"]);
    expect(s.journal().chainIndexes, "every counter the higher of the two").toMatchObject({ evm: 7, bitcoin: 12 });
    // the first journal the restore wrote, before its unlock: the counters held in it (a reload during the unlock found them free before)
    const first = writes.find((w) => w.key === JOURNAL_KEY)!;
    const seed = s.state().seed!;
    expect(decryptJournal(journalKey(seed), JSON.parse(first.value) as EncryptedJournal)?.countersHeld).toBe(true);
    s.lock();
  });
});

describe("a backup restored over another wallet (D-5, D-7)", () => {
  it("resets the replaced wallet's settings, and a backup whose journal is not a wallet journal changes nothing", async () => {
    const store = memoryStorage();
    configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
    const other = new WalletSession(memoryStorage(), KDF);
    await other.create("its password");
    other.acknowledgePhrase();
    const backup = other.exportBackup();
    other.lock();
    const s = new WalletSession(store, KDF);
    await s.create("a password");
    s.acknowledgePhrase();
    settings.set({ autoLockMinutes: 60 });
    s.lock();
    const keystoreBefore = store.get(KEYSTORE_KEY);
    // one extra field in the journal: refused before anything is written
    const bad = JSON.parse(backup) as { journal: Record<string, unknown> };
    bad.journal = { ...bad.journal, extra: "x" };
    await expect(s.restoreFromBackup(JSON.stringify(bad), "its password", { replace: true })).rejects.toThrow(/not a wallet journal/);
    expect(store.get(KEYSTORE_KEY), "the device's keystore untouched").toBe(keystoreBefore);
    // the backup as it is: the replaced wallet's settings are not the restored one's
    expect(await s.restoreFromBackup(backup, "its password", { replace: true })).toBe(true);
    expect(settings.get().autoLockMinutes).not.toBe(60);
    s.lock();
  });
});
