// A restore of this device's own phrase keeps the journal that seed opens (audit round 2, n45/n69): the journal is
// encrypted under the seed, never the password, and the forgotten-password path — the same phrase under a new password —
// had deleted the open orders and campaigns, the address book and the fresh-address counters it still opened.
import { describe, expect, it } from "vitest";
import { WalletSession } from "../src/wallet/session";
import { memoryStorage } from "../src/wallet/storage";
import { seedToPhrase } from "../src/wallet/keystore";
import { noteStore } from "../src/wallet/notes";

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
    expect(noteStore.countersHeld(), "its counters are known: nothing held").toBe(false);
    s.lock();
    expect(await s.unlock("second password")).toBe(true);
    expect(s.journal().chainIndexes.evm).toBe(5);
    s.lock();
    // another wallet's phrase: nothing of this one, and its counters held until a scan
    await s.restoreFromPhrase(seedToPhrase(new Uint8Array(32).fill(9)), "third password", { replace: true });
    expect(s.journal().chainIndexes.evm ?? 0).toBe(0);
    expect(noteStore.countersHeld()).toBe(true);
    s.lock();
  });
});
