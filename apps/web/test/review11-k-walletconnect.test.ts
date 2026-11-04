// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), slice 2a after its diff critique (T7, T8): WalletConnect's database is deleted only while no page holds
// WalletConnect (A11-3, H11-4; the round's critique). A page that loads it holds the Web Lock WALLET_CONNECT_LOCK shared for its life, taken
// before the library is imported; a deletion asks for the lock exclusive, if available, and while another page holds it the name stays in the
// preferences' pendingWipe for a later start — the page start's wipePending and a Disconnect's or a Forget's clearWalletConnectStorage alike. A
// Disconnect in the page that loaded it removes its keys through the core's own store, and applyConfig wires the platform's deferDeletion (T8).
// The critics' gaps T7 and T8 became these cases, over a scripted LockManager as navigator.locks (happy-dom has none) and a scripted
// WalletConnect provider: no relay, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyConfig, testConfig } from "../src/config";
import { prefs, resetPrefsStore } from "../src/storage/prefs";
import { deferDeletion, wipePending } from "../src/platform/pendingWipe";
import {
  clearWalletConnectStorage,
  configureWalletConnect,
  deleteWalletConnectDatabase,
  endWalletConnect,
  markWalletConnectLoaded,
  resetWalletConnect,
  WALLET_CONNECT_DB,
  WALLET_CONNECT_LOCK,
  walletConnectLoadedHere,
  walletConnectProvider,
} from "@privacy-wallet/wallet-engine/walletConnect";

// WalletConnect's provider, scripted (as the wallet engine's own test does): the core under it keeps its keys in a store of its own — the
// key-value store over WALLET_CONNECT_V2_INDEXED_DB, reached as EthereumProvider → UniversalProvider → SignClient → Core
const wc = vi.hoisted(() => ({ inits: 0, log: [] as string[], keys: new Map<string, string>(), provider: null as unknown }));
vi.mock("@walletconnect/ethereum-provider", () => ({
  EthereumProvider: {
    init: async () => {
      wc.inits++;
      wc.log.push("init");
      wc.provider = {
        request: async () => null,
        on: () => undefined,
        removeListener: () => undefined,
        disconnect: async () => void wc.log.push("disconnect"),
        signer: {
          client: {
            core: {
              storage: {
                getKeys: async () => (wc.log.push("getKeys"), [...wc.keys.keys()]),
                removeItem: async (key: string) => {
                  wc.log.push(`removeItem ${key}`);
                  wc.keys.delete(key);
                },
              },
            },
          },
        },
      };
      return wc.provider;
    },
  },
}));

type Mode = "shared" | "exclusive";
interface HeldLock {
  name: string;
  mode: Mode;
}
/**
 * One origin's Web Locks across its pages, as the Web Locks API grants them: shared holders together, an exclusive one alone, the requests of a
 * name granted in order, `ifAvailable` answered with null at once — and a query that names what is held and what waits.
 */
class FakeLocks {
  readonly held: HeldLock[] = [];
  readonly requests: { name: string; mode: Mode; ifAvailable: boolean }[] = [];
  private queue: { lock: HeldLock; grant: () => void }[] = [];
  request(name: string, opts: { mode?: Mode; ifAvailable?: boolean }, cb: (lock: HeldLock | null) => unknown): Promise<unknown> {
    const mode = opts.mode ?? "exclusive";
    this.requests.push({ name, mode, ifAvailable: !!opts.ifAvailable });
    return new Promise((resolve, reject) => {
      const lock = { name, mode };
      if (opts.ifAvailable && !(this.waiting(name).length === 0 && this.free(lock))) {
        Promise.resolve()
          .then(() => cb(null))
          .then(resolve, reject);
        return;
      }
      const grant = () => {
        this.held.push(lock);
        Promise.resolve()
          .then(() => cb(lock))
          .then(
            (v) => {
              this.release(lock);
              resolve(v);
            },
            (e) => {
              this.release(lock);
              reject(e);
            },
          );
      };
      this.queue.push({ lock, grant });
      this.process(name);
    });
  }
  async query(): Promise<{ held: HeldLock[]; pending: HeldLock[] }> {
    return { held: this.heldNow(), pending: this.queue.map(({ lock }) => ({ name: lock.name, mode: lock.mode })) };
  }
  /** What is held at this moment (a deletion reads it as it is asked for). */
  heldNow(): HeldLock[] {
    return this.held.map(({ name, mode }) => ({ name, mode }));
  }
  private waiting(name: string) {
    return this.queue.filter((q) => q.lock.name === name);
  }
  private free(lock: HeldLock): boolean {
    const same = this.held.filter((h) => h.name === lock.name);
    return lock.mode === "exclusive" ? same.length === 0 : same.every((h) => h.mode === "shared");
  }
  private process(name: string) {
    for (let next = this.waiting(name)[0]; next && this.free(next.lock); next = this.waiting(name)[0]) {
      this.queue.splice(this.queue.indexOf(next), 1);
      next.grant();
    }
  }
  private release(lock: HeldLock) {
    const i = this.held.indexOf(lock);
    if (i >= 0) this.held.splice(i, 1);
    this.process(lock.name);
  }
}
const install = (locks = new FakeLocks()): FakeLocks => {
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  return locks;
};
/** Another page of this origin that loaded WalletConnect: it holds the lock shared for its life (its holdWhileLoaded); the release closes it. */
function anotherPageHolds(locks: FakeLocks): () => void {
  let close: (() => void) | undefined;
  void locks.request(WALLET_CONNECT_LOCK, { mode: "shared" }, () => new Promise<void>((r) => (close = r)));
  return () => close?.();
}
// a deletion that completes at once, as a browser's does once no connection holds the database — with the Web Locks held when it was asked for
const fakeIdb = (locks?: FakeLocks) => {
  const dropped: { name: string; held: HeldLock[] }[] = [];
  const deleteDatabase = (name: string) => {
    dropped.push({ name, held: locks ? locks.heldNow() : [] });
    const req = {} as { onsuccess?: () => void };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  };
  return { dropped, idb: { deleteDatabase } as unknown as IDBFactory };
};
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms = 1000) => Promise.race([p.then(() => "done" as const), settle(ms).then(() => "still waiting" as const)]);
const SHARED = { name: WALLET_CONNECT_LOCK, mode: "shared" } as const;
const EXCLUSIVE = { name: WALLET_CONNECT_LOCK, mode: "exclusive" } as const;

beforeEach(() => {
  resetPrefsStore();
  localStorage.clear();
  wc.inits = 0;
  wc.log.length = 0;
  wc.keys.clear();
  wc.provider = null;
});
afterEach(() => {
  resetWalletConnect();
  configureWalletConnect(undefined);
  delete (navigator as unknown as { locks?: unknown }).locks;
});

// ------------------------------------------------------------------------------------------------------------ T7
describe("WalletConnect's database while a page holds WalletConnect (A11-3, H11-4; the critique, T7)", () => {
  it("a page start while another page holds it deletes nothing of it — the lock asked for exclusive, if available, never waited for — and keeps the name for a later start", async () => {
    const locks = install();
    const closeOther = anotherPageHolds(locks); // another tab loaded WalletConnect: its connection to the database stays open
    await settle();
    deferDeletion(WALLET_CONNECT_DB); // an earlier page could not delete it
    const { dropped, idb } = fakeIdb(locks);
    expect(await within(wipePending(idb)), "the start never waits for the other page").toBe("done");
    expect(dropped, "no deletion queued behind the other page's connection").toEqual([]);
    expect(locks.requests).toEqual([
      { name: WALLET_CONNECT_LOCK, mode: "shared", ifAvailable: false },
      { name: WALLET_CONNECT_LOCK, mode: "exclusive", ifAvailable: true },
    ]);
    expect(prefs().get().pendingWipe, "kept for a later start").toEqual([WALLET_CONNECT_DB]);
    expect(await locks.query(), "the other page's hold undisturbed, nothing left waiting").toEqual({ held: [SHARED], pending: [] });
    closeOther();
  });

  it("control: with no page holding it, the start deletes it while it holds the lock exclusively, then clears the name and lets the lock go", async () => {
    const locks = install();
    deferDeletion(WALLET_CONNECT_DB);
    const { dropped, idb } = fakeIdb(locks);
    await wipePending(idb);
    expect(dropped, "deleted under the exclusive lock").toEqual([{ name: WALLET_CONNECT_DB, held: [EXCLUSIVE] }]);
    expect(prefs().get().pendingWipe).toBeUndefined();
    expect(await locks.query()).toEqual({ held: [], pending: [] });
  });

  it("a Disconnect or a Forget in a page that never loaded WalletConnect, while another page holds it, deletes nothing and keeps the name; its localStorage entries go at once", async () => {
    configureWalletConnect("a-project-id", { deferDeletion });
    const locks = install();
    const closeOther = anotherPageHolds(locks);
    await settle();
    localStorage.setItem("wc@2:client:0.3//session", JSON.stringify([{ topic: "t" }]));
    localStorage.setItem("unrelated", "stays");
    expect(walletConnectLoadedHere(), "never loaded in this page").toBe(false);
    const { dropped, idb } = fakeIdb(locks);
    const cleared = clearWalletConnectStorage(idb);
    expect(localStorage.getItem("wc@2:client:0.3//session"), "the localStorage entries at once").toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("stays");
    expect(await within(cleared), "resolves on the lock's answer").toBe("done");
    expect(dropped, "no deletion queued behind the other page's connection").toEqual([]);
    expect(locks.requests.at(-1)).toEqual({ name: WALLET_CONNECT_LOCK, mode: "exclusive", ifAvailable: true });
    expect(prefs().get().pendingWipe, "kept for a later start").toEqual([WALLET_CONNECT_DB]);
    closeOther();
  });

  it("a page loading WalletConnect waits for a deletion of its database in progress: its shared request queues behind the exclusive one, the library is initialized after the deletion ends, and the page then holds it shared", async () => {
    configureWalletConnect("a-project-id", { deferDeletion });
    const locks = install();
    let endDeletion: (() => void) | undefined;
    const deletion = deleteWalletConnectDatabase(
      () =>
        new Promise<"deleted">((resolve) => {
          endDeletion = () => {
            wc.log.push("deletion ended");
            resolve("deleted");
          };
        }),
    );
    await settle();
    expect(await locks.query(), "the deletion holds the lock alone").toEqual({ held: [EXCLUSIVE], pending: [] });
    const loading = walletConnectProvider(1); // this page takes WalletConnect up (a tap, or a stored session after a reload)
    await settle(200);
    expect(await locks.query(), "its shared request waits behind the deletion").toEqual({ held: [EXCLUSIVE], pending: [SHARED] });
    expect(wc.inits, "the library is not initialized while its database is being deleted").toBe(0);
    expect(walletConnectLoadedHere()).toBe(false);
    endDeletion!();
    expect(await deletion).toBe("deleted");
    expect(await loading).toBe(wc.provider);
    expect(wc.log, "initialized once the deletion ended").toEqual(["deletion ended", "init"]);
    expect(await locks.query(), "and held shared for the page's life").toEqual({ held: [SHARED], pending: [] });
    expect(walletConnectLoadedHere()).toBe(true);
  });

  it("a Disconnect in the page that loaded WalletConnect removes its keys through the core's own store once the session ended at the relay; the database is kept for the next start, the lock still held", async () => {
    configureWalletConnect("a-project-id", { deferDeletion });
    const locks = install();
    for (const key of ["wc@2:client:0.3//session", "wc@2:core:0.3//keychain", "wc@2:core:0.3//pairing"]) wc.keys.set(key, "{}");
    await walletConnectProvider(1);
    wc.log.length = 0;
    await endWalletConnect();
    expect(wc.log).toEqual([
      "disconnect",
      "getKeys",
      "removeItem wc@2:client:0.3//session",
      "removeItem wc@2:core:0.3//keychain",
      "removeItem wc@2:core:0.3//pairing",
    ]);
    expect([...wc.keys.keys()], "nothing of the session, the pairing or the keychain left in its store").toEqual([]);
    expect(prefs().get().pendingWipe, "the database itself at the next page start").toEqual([WALLET_CONNECT_DB]);
    expect(await locks.query(), "the library's connection stays open in this page: so does its hold").toEqual({ held: [SHARED], pending: [] });
  });
});

// ------------------------------------------------------------------------------------------------------------ T8
describe("the production wiring (the critique, T8)", () => {
  it("applyConfig hands WalletConnect the platform's deferDeletion: a Disconnect in a page that loaded it keeps the database's name in the preferences", async () => {
    configureWalletConnect(undefined); // nothing wired but by applyConfig
    applyConfig(testConfig({ walletConnectProjectId: "a-project-id" }));
    try {
      markWalletConnectLoaded();
      const { dropped, idb } = fakeIdb();
      await clearWalletConnectStorage(idb);
      expect(dropped, "never deleted from the page whose connection holds it").toEqual([]);
      expect(prefs().get().pendingWipe, "kept for the next page start").toEqual([WALLET_CONNECT_DB]);
    } finally {
      applyConfig(testConfig());
    }
  });
});
