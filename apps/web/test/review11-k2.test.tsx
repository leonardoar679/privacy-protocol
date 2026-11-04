// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), slice 2a after its second diff critique: the published phrase's warning where the user sees it —
// inside the Shell, over every screen (T2-6: the component had been tested alone); a Forget while another page holds WalletConnect writes the
// database's name kept for a later start before it resolves (T2-1: the preferences had been flushed before the lock's answer, and the
// restart raced the write); the Forget names the second device's passkey where it lives when only that one is registered (T2-7).
import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { createKeystore } from "@privacy-wallet/sdk/wallet/keystore";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { configureWalletConnect, resetWalletConnect, WALLET_CONNECT_DB, WALLET_CONNECT_LOCK } from "@privacy-wallet/wallet-engine/walletConnect";
import { prefs, resetPrefsStore } from "../src/storage/prefs";
import { resetDbCache } from "../src/storage/idb";
import { secureStore } from "../src/storage/secureStore";
import { KEYSTORE_KEY } from "../src/storage/keys";
import { deferDeletion } from "../src/platform/pendingWipe";
import { forgetEverything } from "../src/platform/forget";
import { SecuritySection } from "../src/features/more/Security";
import { renderApp } from "./helpers/render";

const LAZY = { timeout: 15_000 };
beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
});
beforeEach(() => {
  resetPrefsStore();
  resetDbCache();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  resetWalletConnect();
  configureWalletConnect(undefined);
  session.forget();
  settings.reset();
  connection.reset();
});

describe("a published phrase's wallet, inside the Shell (the second critique, T2-6)", () => {
  it("unlocked, the warning is over the screen the user lands on; an ordinary wallet shows none", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    await renderApp("/");
    await screen.findByTestId("home", {}, LAZY);
    expect(screen.queryByTestId("public-wallet-notice"), "an ordinary wallet").toBeNull();
    cleanup();
    session.lock();
    await secureStore().flush();
    secureStore().set(KEYSTORE_KEY, JSON.stringify(await createKeystore(new Uint8Array(32).fill(0xff), "pw", { N: 1 << 12, r: 8, p: 1 })));
    expect(await session.unlock("pw")).toBe(true);
    await renderApp("/");
    await screen.findByTestId("home", {}, LAZY);
    expect(screen.getByTestId("public-wallet-notice").textContent).toMatch(/Anyone can spend what this wallet holds/);
  });
});

describe("a Forget while another page holds WalletConnect (the second critique, T2-1)", () => {
  it("the database's name, kept for a later start once the lock answers, is written before the Forget resolves — the restart cannot cut it off", async () => {
    configureWalletConnect("pid", { deferDeletion });
    await session.create("a strong password");
    session.acknowledgePhrase();
    await prefs().ready;
    const events: string[] = [];
    const realPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "prefs") events.push(String(value).includes(WALLET_CONNECT_DB) ? "prefs with the name" : "prefs");
      return realPut.call(this, value, key);
    } as typeof realPut;
    // another page holds WalletConnect's lock shared, and the lock manager answers late (after the rest of the Forget)
    const locks = {
      request: (name: string, opts: { ifAvailable?: boolean }, cb: (l: unknown) => unknown) =>
        name === WALLET_CONNECT_LOCK && opts.ifAvailable ? new Promise((r) => setTimeout(r, 40)).then(() => cb(null)) : Promise.resolve(cb({ name })),
      query: async () => ({ held: [{ name: WALLET_CONNECT_LOCK, mode: "shared" }], pending: [] }),
    };
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    const dropped: string[] = [];
    const idb = {
      deleteDatabase: (name: string) => {
        dropped.push(name);
        const req = {} as { onsuccess?: () => void };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    } as unknown as IDBFactory;
    try {
      await forgetEverything({ caches: null, indexedDB: idb, localStorage });
      events.push("the Forget resolved");
    } finally {
      IDBObjectStore.prototype.put = realPut;
      delete (navigator as unknown as Record<string, unknown>).locks;
    }
    expect(dropped, "held by the other page: never deleted from here").not.toContain(WALLET_CONNECT_DB);
    const written = events.indexOf("prefs with the name");
    expect(written, "the name was written").toBeGreaterThanOrEqual(0);
    expect(written, "and before the Forget resolved").toBeLessThan(events.indexOf("the Forget resolved"));
    expect(prefs().get().pendingWipe).toEqual([WALLET_CONNECT_DB]);
  });
});

describe("the Forget's passkey words (the second critique, T2-7)", () => {
  it("only the second device registered: its passkey named where it lives, nothing said of a password-manager passkey", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    settings.set({ protection: { ...settings.get().protection, secondDevice: { enabled: true, credentialId: "cred-device" } } });
    render(<SecuritySection />);
    fireEvent.click(screen.getByTestId("forget-section-toggle"));
    fireEvent.click(screen.getByTestId("forget-open"));
    expect((await screen.findByTestId("forget-passkey-device")).textContent).toMatch(/“privacy-wallet-second-device” stays on your separate device/);
    expect(screen.queryByTestId("forget-passkey-factor")).toBeNull();
  });
});
