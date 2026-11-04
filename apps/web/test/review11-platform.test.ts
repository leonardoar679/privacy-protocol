// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), part H — the platform after round 10: a request to step aside is withdrawn when the tab that asked
// locks, and confirmed by the lock's queue while it waits (H11-3); the preferences are written as a patch on what the store holds (H11-7);
// WalletConnect's database is never deleted from the page whose own connection holds it — its keys removed through that connection, the
// database deleted at a later page start where no page holds WalletConnect (A11-3, H11-4); the secure store collapses consecutive writes of
// one key and writes a restore's two records in one transaction (H11-5, A11-7); the trade check's answer is held to the wallet's words (H11-6);
// the Forget signals nothing to the authenticator and says which passkeys stay (A11-11 and the round's critique); a published phrase's wallet
// opens with its warning (the critique, C5). The reviewer's probes (scratchpad review11/H) became these cases.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, get, set } from "idb-keyval";

// IndexedDB's own read-write transactions on the secure store, counted (the secure store is loaded by the test setup before any module mock would apply)
const txs = { readwrite: 0 };
const realTransaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...a: Parameters<IDBDatabase["transaction"]>) {
  if (a[1] === "readwrite" && String(a[0]) === "secure") txs.readwrite++; // the secure store's alone: the preferences write in their own
  return realTransaction.apply(this, a);
} as IDBDatabase["transaction"];

import { ACTIVE_LOCK, ASK_SETTLE_MS, startActiveTab, STEP_ASIDE_WATCH_MS, TabStateStore } from "../src/platform/activeTab";
import { AutoLock, type LockTrigger } from "@privacy-wallet/sdk/session/autoLock";
import { createPrefsStore, prefs, resetPrefsStore } from "../src/storage/prefs";
import { idbEntries, resetDbCache } from "../src/storage/idb";
import { createSecureStore, secureStore } from "../src/storage/secureStore";
import { JOURNAL_KEY, KEYSTORE_KEY } from "../src/storage/keys";
import {
  clearWalletConnectStorage,
  configureWalletConnect,
  markWalletConnectLoaded,
  resetWalletConnect,
  WALLET_CONNECT_DB,
} from "@privacy-wallet/wallet-engine/walletConnect";
import { deferDeletion, wipePending } from "../src/platform/pendingWipe";
import { holdToWords, parseTradeCheck, TRADE_CHECK_SYSTEM } from "../src/zkapi/tradeCheck";
import { forgetEverything } from "../src/platform/forget";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { SecuritySection } from "../src/features/more/Security";

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const names = async () => (await indexedDB.databases()).map((d) => d.name);

beforeEach(() => {
  resetPrefsStore();
  resetDbCache();
  localStorage.clear();
});
afterEach(() => {
  resetWalletConnect();
  configureWalletConnect(undefined);
  session.forget();
  connection.reset();
});

// ---------------------------------------------------------------------------------------------------------------- H11-3
class FakeSession {
  unlocked = false;
  ep = 0;
  private hs = new Map<number, { reason: string; since: number }>();
  private seq = 0;
  private ls = new Set<() => void>();
  private safe = new Set<() => void>();
  isUnlocked() {
    return this.unlocked;
  }
  epoch() {
    return this.ep;
  }
  subscribe(l: () => void) {
    this.ls.add(l);
    return () => {
      this.ls.delete(l);
    };
  }
  private emit() {
    for (const l of [...this.ls]) l();
  }
  unlock() {
    this.unlocked = true;
    this.ep++;
    this.emit();
  }
  lock() {
    this.unlocked = false;
    this.ep++;
    this.hs.clear();
    this.emit();
  }
  hold(reason: string) {
    const id = ++this.seq;
    this.hs.set(id, { reason, since: Date.now() });
    this.emit();
    return () => {
      if (this.hs.delete(id)) this.emit();
    };
  }
  holds() {
    return [...this.hs.values()];
  }
  onSafePoint(fn: () => void) {
    this.safe.add(fn);
    return () => {
      this.safe.delete(fn);
    };
  }
  async reload() {}
}
/** One origin's Web Locks for the wallet's name: exclusive, a queue in order, ifAvailable, an abort signal — and a query that names the queue. */
class FakeLocks {
  holder = false;
  queue: { grant: () => void }[] = [];
  request(_name: string, opts: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (l: unknown) => unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.holder = true;
        Promise.resolve()
          .then(() => cb({ name: ACTIVE_LOCK }))
          .then(
            (v) => {
              this.holder = false;
              resolve(v);
              this.next();
            },
            (e) => {
              this.holder = false;
              reject(e);
              this.next();
            },
          );
      };
      if (opts.ifAvailable) {
        if (!this.holder && this.queue.length === 0) grant();
        else
          Promise.resolve()
            .then(() => cb(null))
            .then(resolve, reject);
        return;
      }
      const entry = { grant };
      opts.signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        }
      });
      if (!this.holder && this.queue.length === 0) grant();
      else this.queue.push(entry);
    });
  }
  private next() {
    const e = this.queue.shift();
    if (e) e.grant();
  }
  async query() {
    return { held: this.holder ? [{ name: ACTIVE_LOCK }] : [], pending: this.queue.map(() => ({ name: ACTIVE_LOCK })) };
  }
}
class Hub {
  private chans = new Set<{ ls: Set<(e: MessageEvent) => void> }>();
  channel() {
    const c = { ls: new Set<(e: MessageEvent) => void>() };
    this.chans.add(c);
    return {
      postMessage: (m: unknown) => {
        for (const o of this.chans) if (o !== c) for (const l of o.ls) setTimeout(() => l({ data: m } as MessageEvent));
      },
      addEventListener: (_t: "message", fn: (e: MessageEvent) => void) => {
        c.ls.add(fn);
      },
      removeEventListener: (_t: "message", fn: (e: MessageEvent) => void) => {
        c.ls.delete(fn);
      },
      close: () => {
        this.chans.delete(c);
      },
    };
  }
}
function tab(locks: FakeLocks, hub: Hub) {
  const session = new FakeSession();
  const triggers: LockTrigger[] = [];
  const auto = new AutoLock({ session: session as never, minutes: () => 15, onLock: (t) => triggers.push(t) });
  auto.start();
  const store = new TabStateStore();
  const stop = startActiveTab({
    session: session as never,
    stepAside: () => auto.stepAside(),
    cancelStepAside: () => auto.cancelStepAside(),
    locks: locks as unknown as LockManager,
    channel: () => hub.channel(),
    store,
    flushWaitMs: 5,
    takeoverWaitMs: 1000,
  });
  return { session, store, triggers, stop };
}

describe("a request to step aside the asker gave up (H11-3)", () => {
  it("is withdrawn when the tab that asked locks: the holder stays at its next release", async () => {
    const locks = new FakeLocks();
    const hub = new Hub();
    const A = tab(locks, hub);
    const B = tab(locks, hub);
    A.session.unlock();
    await settle();
    const release = A.session.hold("signature");
    B.session.unlock();
    await settle();
    expect(B.store.get()).toBe("waiting");
    B.session.lock(); // "Lock this tab": its request withdrawn
    // the queue read once B's request has settled (the round's second critique: a read moments after a request does not call the queue empty)
    await settle(STEP_ASIDE_WATCH_MS + ASK_SETTLE_MS);
    release();
    await settle();
    expect(A.session.isUnlocked(), "nobody waits: A stays").toBe(true);
    expect(A.triggers).toEqual([]);
    A.stop();
    B.stop();
  });

  it("a tab that closed withdraws nothing: the holder reads the lock's queue, and with nobody in it stays", async () => {
    const locks = new FakeLocks();
    const hub = new Hub();
    const A = tab(locks, hub);
    const B = tab(locks, hub);
    A.session.unlock();
    await settle();
    const release = A.session.hold("signature");
    B.session.unlock();
    await settle();
    expect(locks.queue).toHaveLength(1);
    locks.queue.length = 0; // the tab closed: its queued request goes with it, and no message is sent
    B.stop();
    await settle(STEP_ASIDE_WATCH_MS + 300);
    release();
    await settle();
    expect(A.session.isUnlocked()).toBe(true);
    expect(A.triggers).toEqual([]);
    A.stop();
  });

  it("control: a tab that still waits gets the wallet at the holder's release", async () => {
    const locks = new FakeLocks();
    const hub = new Hub();
    const A = tab(locks, hub);
    const B = tab(locks, hub);
    A.session.unlock();
    await settle();
    const release = A.session.hold("signature");
    B.session.unlock();
    await settle(STEP_ASIDE_WATCH_MS + 300);
    release();
    await settle(100);
    expect(A.session.isUnlocked()).toBe(false);
    expect(A.triggers).toEqual(["elsewhere"]);
    A.stop();
    B.stop();
  });
});

// ---------------------------------------------------------------------------------------------------------------- H11-7
describe("the preferences of two tabs (H11-7)", () => {
  it("a tab loaded before a Forget in another writes only what it changed: the reset and the new wallet's 'not backed up' stand", async () => {
    const seed = createPrefsStore();
    await seed.ready;
    seed.update({ backup: { phraseAcknowledgedAt: 1_700_000_000_000, exportedAt: 1_700_000_000_000 }, firstLaunchDone: true, lastConnector: "injected:old" });
    await seed.flush();
    const tabA = createPrefsStore();
    const tabB = createPrefsStore();
    await Promise.all([tabA.ready, tabB.ready]);
    tabA.reset(); // the Forget
    tabA.update({ backup: undefined, firstLaunchDone: true });
    await tabA.flush();
    tabB.update({ locale: "ko" }); // the stale tab changes one key
    await tabB.flush();
    const reader = createPrefsStore();
    await reader.ready;
    expect(reader.get().backup, "the new wallet reads 'not backed up'").toBeUndefined();
    expect(reader.get().lastConnector, "the forgotten wallet's connector is not brought back").toBeUndefined();
    expect(reader.get().locale, "the stale tab's own change lands").toBe("ko");
    expect(tabB.get().backup, "and the stale tab now holds what the store holds").toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------------- A11-3, H11-4
describe("WalletConnect's database from the page that holds it (A11-3, H11-4)", () => {
  it("is never deleted there: kept for the next page start, which deletes it before anything loads WalletConnect again", async () => {
    configureWalletConnect("pid", { deferDeletion });
    const first = createStore(WALLET_CONNECT_DB, "keyvaluestorage");
    await set("wc@2:client:0.3//session", JSON.stringify([{ topic: "t" }]), first);
    markWalletConnectLoaded(); // the library was loaded in this page: its core holds the database open
    clearWalletConnectStorage(); // a Disconnect, a Forget
    await settle(100);
    expect(prefs().get().pendingWipe, "kept for the next start").toEqual([WALLET_CONNECT_DB]);
    // a second WalletConnect connection in this page opens at once: no deletion waits in front of it
    const second = createStore(WALLET_CONNECT_DB, "keyvaluestorage");
    expect(await Promise.race([get("anything", second), settle(1500).then(() => "timeout")]), "no hang").toBeUndefined();
    await prefs().flush();
    // the next page start: WalletConnect not loaded, its database deleted, the wish cleared (the old connections stand for a closed page)
    resetWalletConnect();
    resetPrefsStore();
    const deleted: string[] = [];
    await wipePending({
      deleteDatabase: (name: string) => {
        deleted.push(name);
        const req = {} as { onsuccess?: () => void };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    } as unknown as IDBFactory);
    expect(deleted).toEqual([WALLET_CONNECT_DB]);
    expect(prefs().get().pendingWipe).toBeUndefined();
    await prefs().flush();
  });

  it("control: in a page where WalletConnect was never loaded it is deleted at once", () => {
    configureWalletConnect("pid", { deferDeletion });
    const spy = vi.spyOn(indexedDB, "deleteDatabase");
    clearWalletConnectStorage();
    expect(spy).toHaveBeenCalledWith(WALLET_CONNECT_DB);
    expect(prefs().get().pendingWipe).toBeUndefined();
    spy.mockRestore();
  });

  it("a Forget in such a page waits for no blocked deletion and leaves the wish for the next start", async () => {
    configureWalletConnect("pid", { deferDeletion });
    markWalletConnectLoaded();
    const dropped: string[] = [];
    const idb = {
      deleteDatabase: (name: string) => {
        dropped.push(name);
        const req = {} as { onsuccess?: () => void };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    } as unknown as IDBFactory;
    const t0 = Date.now();
    await forgetEverything({ caches: null, indexedDB: idb, localStorage });
    expect(Date.now() - t0, "no 5 s wait on a deletion its own page blocks").toBeLessThan(4000);
    expect(dropped).not.toContain(WALLET_CONNECT_DB);
    expect(prefs().get().pendingWipe).toEqual([WALLET_CONNECT_DB]);
  });
});

// ---------------------------------------------------------------------------------------------------------- H11-5, A11-7
describe("the secure store's writes (H11-5, A11-7)", () => {
  it("consecutive writes of one key collapse into the one queued behind the running write; every write's order is kept", async () => {
    const s = createSecureStore();
    await s.ready;
    await secureStore().flush(); // the shared store's queue (the clean-up of the tests before) landed first
    txs.readwrite = 0;
    for (let i = 0; i < 50; i++) s.set(JOURNAL_KEY, JSON.stringify({ v: 1, nonce: "00".repeat(24), ct: (i % 10).toString(16).repeat(2 * (i + 1)) }));
    await s.flush();
    expect(txs.readwrite, "two writes at most: the one running and the one waiting").toBeLessThanOrEqual(2);
    expect(txs.readwrite, "and at least the one").toBeGreaterThanOrEqual(1);
    expect(JSON.parse(s.get(JOURNAL_KEY)!).ct).toBe((49 % 10).toString(16).repeat(100));
    const stored = new Map(await idbEntries("secure"));
    expect(JSON.parse(stored.get(JOURNAL_KEY)!).ct, "the last value landed").toBe((49 % 10).toString(16).repeat(100));
  });

  it("a restore's records land in one transaction", async () => {
    const s = createSecureStore();
    await s.ready;
    await secureStore().flush();
    txs.readwrite = 0;
    const ks = JSON.stringify({
      v: 1,
      kdf: { name: "scrypt", N: 4096, r: 8, p: 1, dkLen: 32 },
      salt: "00".repeat(16),
      nonce: "00".repeat(24),
      ct: "ab".repeat(48),
    });
    s.setMany!([
      [KEYSTORE_KEY, ks],
      [JOURNAL_KEY, JSON.stringify({ v: 1, nonce: "11".repeat(24), ct: "cd".repeat(40) })],
    ]);
    await s.flush();
    expect(txs.readwrite, "one transaction for both records").toBe(1);
    const stored = new Map(await idbEntries("secure"));
    expect([stored.has(KEYSTORE_KEY), stored.has(JOURNAL_KEY)]).toEqual([true, true]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- H11-6
describe("the trade check's words (H11-6)", () => {
  it("the prompt names every word the wallet never says; a line of the answer that uses one is withheld", () => {
    const sys = TRADE_CHECK_SYSTEM.toLowerCase();
    for (const w of ["atomic", "anonymous", "mixer", "untraceable", "undetectable", "invisible"]) expect(sys, w).toContain(w);
    const answer = JSON.stringify({
      bestRoute: "Keep THORChain.",
      alternative: "None.",
      estimatedSavings: "None.",
      privacy: "The pool works like a mixer: the funding is untraceable.",
      execution: "Fine.",
      risk: "Anonymity set is large.",
    });
    const held = holdToWords(parseTradeCheck(answer));
    expect(held.withheld).toEqual(["privacy", "risk"]);
    expect([held.privacy, held.risk]).toEqual(["", ""]);
    expect(held.bestRoute).toBe("Keep THORChain.");
    expect(
      holdToWords(parseTradeCheck(JSON.stringify({ bestRoute: "Keep it.", privacy: "Public metadata remains." }))).withheld,
      "nothing to hold",
    ).toBeUndefined();
  });
  it("a 100 % claim of privacy or safety is held back too (spec §18; the critique, K3-6); a figure that promises nothing is not", () => {
    const claim = (privacy: string) => holdToWords(parseTradeCheck(JSON.stringify({ bestRoute: "Keep it.", privacy, risk: "Low." }))).withheld;
    expect(claim("100% private: nothing links the two sides")).toEqual(["privacy"]);
    expect(claim("It is 100 % safe.")).toEqual(["privacy"]);
    expect(claim("100 percent unlinkable")).toEqual(["privacy"]);
    expect(claim("100 % of the order arrives at the destination.")).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------- the critique, C5
describe("a wallet made from a published phrase (the critique of the eleventh round, C5)", () => {
  it("opens with the warning on every screen, so its owner can move what it holds", async () => {
    const { createKeystore } = await import("@privacy-wallet/sdk/wallet/keystore");
    const { PublicWalletNotice } = await import("../src/app/PublicWalletNotice");
    await session.create("a strong password");
    session.acknowledgePhrase();
    render(createElement(PublicWalletNotice));
    expect(screen.queryByTestId("public-wallet-notice"), "an ordinary wallet: nothing").toBeNull();
    session.lock();
    await secureStore().flush();
    secureStore().set(KEYSTORE_KEY, JSON.stringify(await createKeystore(new Uint8Array(32).fill(0xff), "pw", { N: 1 << 12, r: 8, p: 1 })));
    await act(async () => {
      expect(await session.unlock("pw")).toBe(true);
    });
    expect((await screen.findByTestId("public-wallet-notice")).textContent).toMatch(
      /Anyone can spend what this wallet holds.*send what it holds to a wallet made from a new phrase in another browser or on another device/,
    );
    act(() => session.lock());
    expect(screen.queryByTestId("public-wallet-notice"), "locked: gone").toBeNull();
    cleanup();
  });
});

// ---------------------------------------------------------------------------------------------------------------- A11-11
describe("the Forget and the passkeys (A11-11; the critique)", () => {
  it("signals nothing to the authenticator — another installation of this wallet may use the same synced passkey — and the dialog says the passkey stays", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    settings.set({
      secondFactor: { enabled: true, credentialId: "cred-factor" },
      protection: { ...settings.get().protection, secondDevice: { enabled: true, credentialId: "cred-device" } },
    });
    const view = render(createElement(SecuritySection));
    fireEvent.click(screen.getByTestId("forget-section-toggle"));
    fireEvent.click(screen.getByTestId("forget-open"));
    expect((await screen.findByTestId("forget-passkey-factor")).textContent).toMatch(
      /“privacy-wallet” this wallet registered for its second confirmation stays in your browser's or phone's password manager/,
    );
    expect(screen.getByTestId("forget-passkey-device").textContent, "the second device's passkey named where it lives (the second critique)").toMatch(
      /“privacy-wallet-second-device” stays on your separate device \(the security key or the phone you registered\)/,
    );
    view.unmount();
    const signalled: unknown[] = [];
    const saved = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = { signalUnknownCredential: async (x: unknown) => void signalled.push(x) };
    try {
      await forgetEverything({ caches: null, indexedDB: null, localStorage });
    } finally {
      (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = saved;
    }
    expect(signalled, "nothing hidden or removed at the authenticator").toEqual([]);
    // a wallet with no passkey: nothing said about one
    await session.create("another password");
    session.acknowledgePhrase();
    render(createElement(SecuritySection));
    fireEvent.click(screen.getByTestId("forget-section-toggle"));
    fireEvent.click(screen.getByTestId("forget-open"));
    await screen.findByTestId("forget-confirm");
    expect(screen.queryByTestId("forget-passkey-factor")).toBeNull();
    expect(screen.queryByTestId("forget-passkey-device")).toBeNull();
    cleanup();
  });
});
