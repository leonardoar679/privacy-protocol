// A REPLACE while another tab of this browser holds the wallet is refused (the fourth review round, 2026-11-03): that tab's next
// write — a tick, a proof's result, a settings mirror — had put the old wallet's journal over the restored one, under a key the
// new wallet does not have, and the restore's journal was lost. The platform says whether another tab holds it (the Web Lock);
// the session asks before it writes, and writes nothing when the answer is a reason.
import { describe, expect, it } from "vitest";
import { ReplaceRefused, WalletExists, WalletSession } from "../src/wallet/session";
import { JOURNAL_KEY, KEYSTORE_KEY, memoryStorage } from "../src/wallet/storage";

const KDF = { N: 1 << 12, r: 8, p: 1 };

describe("a REPLACE asks the platform first", () => {
  it("refused while another tab holds the wallet — the keystore and the journal as they were —, allowed once the platform says nothing", async () => {
    const store = memoryStorage();
    const a = new WalletSession(store, KDF);
    await a.create("pw");
    const keystore = store.get(KEYSTORE_KEY);
    const journal = store.get(JOURNAL_KEY);
    const b = new WalletSession(store, KDF);
    let held = true;
    b.setReplaceGuard(async () => (held ? "another tab of this browser holds the wallet: lock it there first" : null));
    await expect(b.create("pw2")).rejects.toBeInstanceOf(WalletExists);
    await expect(b.create("pw2", undefined, { replace: true })).rejects.toBeInstanceOf(ReplaceRefused);
    await expect(b.create("pw2", undefined, { replace: true })).rejects.toThrow(/another tab of this browser holds the wallet/);
    expect([store.get(KEYSTORE_KEY), store.get(JOURNAL_KEY)], "nothing written").toEqual([keystore, journal]);
    expect(b.isUnlocked()).toBe(false);
    held = false;
    await b.create("pw2", undefined, { replace: true });
    expect(b.isUnlocked()).toBe(true);
    expect(store.get(KEYSTORE_KEY)).not.toBe(keystore);
    b.setReplaceGuard(null);
  });

  it("without a guard (an old browser, a test) a REPLACE is as it was", async () => {
    const store = memoryStorage();
    await new WalletSession(store, KDF).create("pw");
    const b = new WalletSession(store, KDF);
    await b.create("pw2", undefined, { replace: true });
    expect(b.isUnlocked()).toBe(true);
  });
});
