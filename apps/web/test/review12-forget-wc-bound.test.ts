// @vitest-environment happy-dom
// The twelfth review round (B12-3; audit gap 71): a Forget in the page that loaded WalletConnect waits for its session's end — 5 s at most
// (WALLET_CONNECT_END_MS). An end its relay never answers holds no Forget past that bound: the Forget goes on, its deletes written, and the
// production build restarts; the end is not sent again (gap 112).
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@privacy-wallet/wallet-engine/walletConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/wallet-engine/walletConnect")>()),
  walletConnectLoadedHere: () => true,
  // a session's end its relay never answers
  endWalletConnect: () => new Promise<void>(() => undefined),
}));

import { session } from "@privacy-wallet/sdk/wallet/session";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { markWalletConnectLoaded, resetWalletConnect, WALLET_CONNECT_DB } from "@privacy-wallet/wallet-engine/walletConnect";
import { resetPrefsStore } from "../src/storage/prefs";
import { forgetEverything, WALLET_CONNECT_END_MS, ZKAPI_DB } from "../src/platform/forget";

/** the databases the Forget deleted from this page */
const deleted: string[] = [];
const idb = { deleteDatabase: (name: string) => {
  deleted.push(name);
  const req = {} as { onsuccess?: () => void };
  queueMicrotask(() => req.onsuccess?.());
  return req;
} } as unknown as IDBFactory;
const caches = { delete: async () => true } as unknown as CacheStorage;

afterEach(() => {
  session.forget();
  connection.reset();
  resetPrefsStore();
  resetWalletConnect();
  localStorage.clear();
  deleted.length = 0;
});

describe("a Forget and WalletConnect's end (audit gap 71)", () => {
  it("waits for the end — and 5 s at most: an end that never settles holds the Forget no longer, and its deletes are written", async () => {
    expect(WALLET_CONNECT_END_MS, "the bound gap 71 states").toBe(5_000);
    markWalletConnectLoaded(); // the page that loaded WalletConnect, as the mock says: its own database kept for the next page start there
    let settled = false;
    const forget = forgetEverything({ caches, indexedDB: idb, localStorage }).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 4_000));
    expect(settled, "still waiting for the end").toBe(false);
    expect(deleted, "nothing deleted while it waits").toEqual([]);
    await new Promise((r) => setTimeout(r, 4_000));
    expect(settled, "past the bound: the Forget went on").toBe(true);
    await forget;
    expect(deleted, "its deletes written: the credit wallet's store among them").toContain(ZKAPI_DB);
    expect(deleted, "WalletConnect's own database kept for the next page start (A11-3/H11-4)").not.toContain(WALLET_CONNECT_DB);
  }, 20_000);
});
