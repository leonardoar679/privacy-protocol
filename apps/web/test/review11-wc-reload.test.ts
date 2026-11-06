// @vitest-environment happy-dom
// After a reload a WalletConnect session is not taken up: audit gap 112, as stated (the eleventh review round, F11-2). The check that decides
// whether to start WalletConnect at a reload reads localStorage (hasWalletConnectSession), and the WalletConnect this build installs keeps
// its sessions in IndexedDB — its storage moves an older build's localStorage keys there at its start, and deletes them. Here through that
// storage itself, as @walletconnect/core resolves it and as a browser loads it (its browser build; the Node build keeps a file store in the
// working directory) — not a layout written by hand: wallet-engine.test.ts writes the older one.
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { configureWalletConnect, hasWalletConnectSession, resetWalletConnect } from "@privacy-wallet/wallet-engine/walletConnect";
import { connection } from "@privacy-wallet/wallet-engine/connection";

interface KeyValueStorage {
  setItem(key: string, value: unknown): Promise<void>;
  getItem(key: string): Promise<unknown>;
}
/** The storage WalletConnect's core uses — the copy it resolves, wherever the install put it — in the build a browser loads. */
async function walletConnectStorage(): Promise<KeyValueStorage> {
  const require = createRequire(import.meta.url);
  const core = dirname(require.resolve("@walletconnect/core"));
  const manifest = require.resolve("@walletconnect/keyvaluestorage/package.json", { paths: [core] });
  const { browser } = JSON.parse(readFileSync(manifest, "utf8")) as { browser?: string };
  if (!browser) throw new Error("WalletConnect's storage names no browser build");
  const mod = (await import(pathToFileURL(join(dirname(manifest), browser)).href)) as { KeyValueStorage?: new () => KeyValueStorage };
  if (!mod.KeyValueStorage) throw new Error("WalletConnect's storage has no KeyValueStorage");
  return new mod.KeyValueStorage();
}
const SESSION_KEY = "wc@2:client:0.3//session";
/** WalletConnect's own database (audit gap 112) */
const WC_DB = "WALLET_CONNECT_V2_INDEXED_DB";

afterEach(() => {
  localStorage.clear();
  connection.disconnect();
  configureWalletConnect(undefined);
  resetWalletConnect();
});

describe("WalletConnect after a reload (audit gap 112, the eleventh review round's F11-2)", () => {
  it("a session kept through WalletConnect's own storage is in its IndexedDB database: the reload check sees none, and nothing is taken up", async () => {
    const kv = await walletConnectStorage();
    await kv.setItem(SESSION_KEY, [{ topic: "a-topic", expiry: Math.floor(Date.now() / 1000) + 7 * 86400 }]);
    expect(await kv.getItem(SESSION_KEY), "WalletConnect holds the session").toHaveLength(1);
    expect((await indexedDB.databases()).map((d) => d.name), "in its own database").toContain(WC_DB);
    expect(localStorage.length, "nothing in localStorage").toBe(0);
    expect(hasWalletConnectSession()).toBe(false);
    configureWalletConnect("a-project-id");
    expect((await connection.reconnect("walletconnect")).status, "the user pairs again").toBe("disconnected");
  });
  it("an older build's localStorage session is moved to IndexedDB at WalletConnect's start: seen by the check before, never after", async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify([{ topic: "an-older-topic" }]));
    expect(hasWalletConnectSession(), "before WalletConnect starts").toBe(true);
    const kv = await walletConnectStorage();
    expect(await kv.getItem(SESSION_KEY), "moved").toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(localStorage.getItem(SESSION_KEY), "deleted from localStorage").toBeNull();
    expect(hasWalletConnectSession(), "after it, none").toBe(false);
  });
});
