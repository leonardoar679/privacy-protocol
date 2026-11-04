// A restore of this device's own phrase keeps the journal that seed opens (audit round 2, n45/n69): the journal is
// encrypted under the seed, never the password, and the forgotten-password path — the same phrase under a new password —
// had deleted the open orders and campaigns, the address book and the fresh-address counters it still opened.
import { describe, expect, it } from "vitest";
import { WalletSession } from "../src/wallet/session";
import { memoryStorage } from "../src/wallet/storage";
import { seedToPhrase } from "../src/wallet/keystore";
import { noteStore } from "../src/wallet/notes";
import { ADDRESS_INDEX_RESERVE } from "../src/wallet/journal";

const KDF = { N: 1 << 12, r: 8, p: 1 };

describe("a restore over this device's wallet (audit round 2, n45/n69)", () => {
  it("of its own phrase keeps the journal that seed opens, its counters known; of another phrase starts empty", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    const phrase = await s.create("first password");
    s.acknowledgePhrase();
    s.update((j) => {
      j.chainIndexes.evm = 5;
    });
    s.lock();
    // the password is forgotten: the same phrase, under a new one
    await s.restoreFromPhrase(phrase, "second password", { replace: true });
    expect(s.journal().chainIndexes.evm, "the journal that seed opens is kept").toBe(5);
    // held until the scan, as at every unlock (the eighth review round, B-7): the journal is this seed's, never proved the newest —
    // an older copy of the profile had handed out a counter the newer one had used on chain
    expect(noteStore.countersHeld(), "held until the scan after the restore").toBe(true);
    noteStore.releaseCounters(0); // the scan: a current journal resumes where it was
    expect(noteStore.countersHeld()).toBe(false);
    s.lock();
    expect(await s.unlock("second password")).toBe(true);
    expect(s.journal().chainIndexes.evm).toBe(5);
    s.lock();
    // another wallet's phrase: nothing of this one, and its counters held until a scan; its fresh addresses resume past the reserve, never
    // at the first ones its earlier installation gave out (the tenth review round, D-2)
    await s.restoreFromPhrase(seedToPhrase(new Uint8Array(32).fill(9)), "third password", { replace: true });
    expect(s.journal().chainIndexes.evm).toBe(ADDRESS_INDEX_RESERVE);
    expect(noteStore.countersHeld()).toBe(true);
    s.lock();
  });
});
