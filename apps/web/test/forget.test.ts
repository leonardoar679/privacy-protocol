// @vitest-environment happy-dom
// Forget this wallet (the fifth review round, 2026-11-03): everything of the wallet's under the origin goes — the records, the
// public wallet's connection and WalletConnect's store, the preferences, the artifacts' cache and, with Tornado Classic served
// on this origin, its database, its cache and its locale. Before, the session's three records and the backup dates went and the
// rest stayed: the next wallet created on the device started attached to the previous owner's public account.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyConfig, testConfig } from "../src/config";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { prefs, resetPrefsStore } from "../src/storage/prefs";
import { ARTIFACT_CACHE } from "../src/platform/crypto/protocol";
import { CLASSIC_CACHE, CLASSIC_DB, CLASSIC_LOCALE_KEY, ZKAPI_DB, ZKAPI_DEPLOYMENT_KEY, classicOnThisOrigin, DELETE_WAIT_MS, deleteDatabase, forgetEverything } from "../src/platform/forget";
import { WALLET_CONNECT_DB } from "@privacy-wallet/wallet-engine/walletConnect";
import { JOURNAL_KEY, KEYSTORE_KEY } from "../src/storage/keys";

const fakeCaches = () => {
  const deleted: string[] = [];
  return { deleted, caches: { delete: async (name: string) => (deleted.push(name), true) } as unknown as CacheStorage };
};
// a deletion that completes, as a browser's does once no tab holds the database: the Forget awaits each (the tenth review round, D-9)
const fakeIdb = (answer: "success" | "error" | "never" = "success") => {
  const dropped: string[] = [];
  const deleting = () => {
    const req = {} as { onsuccess?: () => void; onerror?: () => void };
    if (answer !== "never") queueMicrotask(() => (answer === "success" ? req.onsuccess?.() : req.onerror?.()));
    return req;
  };
  return { dropped, idb: { deleteDatabase: (name: string) => (dropped.push(name), deleting()) } as unknown as IDBFactory };
};

beforeEach(() => {
  resetPrefsStore();
  localStorage.clear();
});
afterEach(() => {
  session.forget();
  connection.reset();
  localStorage.clear();
});

describe("Forget this wallet", () => {
  it("clears the records, the connection, WalletConnect's store, the preferences, the artifacts' cache and Classic's stores on this origin", async () => {
    await session.create("pw");
    expect(session.state().status).toBe("unlocked");
    localStorage.setItem("wc@2:client:0.3//session", "[]");
    localStorage.setItem("@appkit/connection_status", "connected");
    localStorage.setItem(CLASSIC_LOCALE_KEY, "ko");
    localStorage.setItem("unrelated", "stays");
    localStorage.setItem(ZKAPI_DEPLOYMENT_KEY, "{}"); // what the zkAPI SDK caches of its deployment
    // a legacy copy of the records a migration left in place (D-9): the next load had moved a forgotten keystore back
    localStorage.setItem(KEYSTORE_KEY, "{}");
    localStorage.setItem(JOURNAL_KEY, "{}");
    await prefs().ready;
    prefs().update({ lastConnector: "io.metamask", backup: { exportedAt: 1_700_000_000_000 } });
    const { deleted, caches } = fakeCaches();
    const { dropped, idb } = fakeIdb();
    await forgetEverything({ caches, indexedDB: idb, localStorage });
    expect(session.state().status).toBe("none");
    expect(connection.get().status).toBe("disconnected");
    expect(localStorage.getItem("wc@2:client:0.3//session")).toBeNull();
    expect(localStorage.getItem("@appkit/connection_status")).toBeNull();
    expect(localStorage.getItem(CLASSIC_LOCALE_KEY)).toBeNull();
    expect(localStorage.getItem("unrelated"), "nothing of anyone else's").toBe("stays");
    expect(prefs().get().lastConnector).toBeUndefined();
    expect(prefs().get().backup).toBeUndefined();
    expect(deleted.sort()).toEqual([ARTIFACT_CACHE, CLASSIC_CACHE].sort());
    // Private AI's credit wallet too (the eighth review round, C-M2): its secret, its blinding and its funding address, per origin; and
    // WalletConnect's own database — the session, its account, its keychain (the tenth review round, D-3)
    expect(dropped.sort()).toEqual([CLASSIC_DB, WALLET_CONNECT_DB, ZKAPI_DB].sort());
    expect(localStorage.getItem(ZKAPI_DEPLOYMENT_KEY)).toBeNull();
    expect(localStorage.getItem(KEYSTORE_KEY), "the legacy copies too").toBeNull();
    expect(localStorage.getItem(JOURNAL_KEY)).toBeNull();
  });

  it("with Classic on its own origin, its stores are not this origin's: left alone", async () => {
    applyConfig(testConfig({ classicUrl: "https://classic.example/" }));
    expect(classicOnThisOrigin()).toBe(false);
    expect(classicOnThisOrigin("/classic/")).toBe(true);
    await session.create("pw");
    localStorage.setItem(CLASSIC_LOCALE_KEY, "ko");
    const { deleted, caches } = fakeCaches();
    const { dropped, idb } = fakeIdb();
    await forgetEverything({ caches, indexedDB: idb, localStorage });
    expect(session.state().status).toBe("none");
    expect(deleted).toEqual([ARTIFACT_CACHE]);
    expect(dropped.sort(), "the credit wallet and WalletConnect's store are this origin's whatever Classic's origin").toEqual([WALLET_CONNECT_DB, ZKAPI_DB].sort());
    expect(localStorage.getItem(CLASSIC_LOCALE_KEY)).toBe("ko");
    applyConfig(testConfig());
  });

  it("waits for its deletions — a restart follows it in a production build — and a deletion another tab blocks ends it after a bounded wait (D-9)", async () => {
    vi.useFakeTimers();
    try {
      const deletion = deleteDatabase(fakeIdb("never").idb, CLASSIC_DB);
      let settled = false;
      void deletion.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(DELETE_WAIT_MS - 1);
      expect(settled, "still waiting").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await deletion).toBe("blocked");
    } finally {
      vi.useRealTimers();
    }
    expect(await deleteDatabase(fakeIdb("success").idb, ZKAPI_DB)).toBe("deleted");
    expect(await deleteDatabase(fakeIdb("error").idb, ZKAPI_DB)).toBe("failed");
    expect(await deleteDatabase(null, ZKAPI_DB)).toBe("failed");
  });

  it("without the Cache API or IndexedDB (an old browser, a test) the rest still goes", async () => {
    await session.create("pw");
    await forgetEverything({ caches: null, indexedDB: null, localStorage: null });
    expect(session.state().status).toBe("none");
  });
});
