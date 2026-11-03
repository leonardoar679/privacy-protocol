// @vitest-environment happy-dom
// Forget this wallet (the fifth review round, 2026-11-03): everything of the wallet's under the origin goes — the records, the
// public wallet's connection and WalletConnect's store, the preferences, the artifacts' cache and, with Tornado Classic served
// on this origin, its database, its cache and its locale. Before, the session's three records and the backup dates went and the
// rest stayed: the next wallet created on the device started attached to the previous owner's public account.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyConfig, testConfig } from "../src/config";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { prefs, resetPrefsStore } from "../src/storage/prefs";
import { ARTIFACT_CACHE } from "../src/platform/crypto/protocol";
import { CLASSIC_CACHE, CLASSIC_DB, CLASSIC_LOCALE_KEY, classicOnThisOrigin, forgetEverything } from "../src/platform/forget";

const fakeCaches = () => {
  const deleted: string[] = [];
  return { deleted, caches: { delete: async (name: string) => (deleted.push(name), true) } as unknown as CacheStorage };
};
const fakeIdb = () => {
  const dropped: string[] = [];
  return { dropped, idb: { deleteDatabase: (name: string) => (dropped.push(name), {} as IDBOpenDBRequest) } as unknown as IDBFactory };
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
    expect(dropped).toEqual([CLASSIC_DB]);
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
    expect(dropped).toEqual([]);
    expect(localStorage.getItem(CLASSIC_LOCALE_KEY)).toBe("ko");
    applyConfig(testConfig());
  });

  it("without the Cache API or IndexedDB (an old browser, a test) the rest still goes", async () => {
    await session.create("pw");
    await forgetEverything({ caches: null, indexedDB: null, localStorage: null });
    expect(session.state().status).toBe("none");
  });
});
