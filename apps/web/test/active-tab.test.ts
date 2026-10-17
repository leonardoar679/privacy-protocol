// One unlocked tab at a time (a V6 follow-up of 2026-10-14; apps/web/src/platform/activeTab.ts). Two unlocked tabs each
// wrote their whole journal — one tab's swap was gone once the other wrote — and both ran the same ticks. Against a fake
// Web Lock manager and an in-memory BroadcastChannel, with tabs sharing one store as a browser's tabs share IndexedDB:
// the tab unlocked first holds the wallet; one unlocked next waits and asks it to step aside; the tab unlocked last wins;
// a tab that locks while it waits leaves the line; without Web Locks nothing changes.
import { describe, expect, it } from "vitest";
import { memoryStorage, type KeyValueStorage } from "@privacy-wallet/sdk/wallet/storage";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { ACTIVE_LOCK, startActiveTab, TabStateStore } from "../src/platform/activeTab";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A Web Lock manager for one name: exclusive, a queue in order, `ifAvailable`, `signal` aborts a queued request. */
class FakeLocks {
  /** `answerMs`: how late an `ifAvailable` request held elsewhere hears so (a browser answers in a later task) */
  constructor(private readonly answerMs = 0) {}
  private held = false;
  private queue: { cb: LockGrantedCallback; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  request(name: string, options: LockOptions, cb: LockGrantedCallback): Promise<unknown> {
    expect(name).toBe(ACTIVE_LOCK);
    return new Promise((resolve, reject) => {
      if (!this.held) return this.grant(cb, resolve, reject);
      if (options.ifAvailable)
        return void (this.answerMs ? new Promise((r) => setTimeout(r, this.answerMs)) : Promise.resolve()).then(() => cb(null)).then(resolve, reject);
      const entry = { cb, resolve, reject };
      this.queue.push(entry);
      options.signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          reject(new DOMException("aborted", "AbortError"));
        }
      });
    });
  }
  private grant(cb: LockGrantedCallback, resolve: (v: unknown) => void, reject: (e: unknown) => void) {
    this.held = true;
    const free = () => {
      this.held = false;
      const next = this.queue.shift();
      if (next) this.grant(next.cb, next.resolve, next.reject);
    };
    void Promise.resolve()
      .then(() => cb({ name: ACTIVE_LOCK, mode: "exclusive" } as Lock))
      .then(
        (v) => {
          free();
          resolve(v);
        },
        (e) => {
          free();
          reject(e);
        },
      );
  }
}

/** One BroadcastChannel name: a message reaches every other member, never its sender. */
function bus() {
  const members = new Set<Set<(e: MessageEvent) => void>>();
  return () => {
    const fns = new Set<(e: MessageEvent) => void>();
    members.add(fns);
    return {
      postMessage: (data: unknown) => {
        for (const m of members) if (m !== fns) for (const fn of m) queueMicrotask(() => fn({ data } as MessageEvent));
      },
      addEventListener: (_t: "message", fn: (e: MessageEvent) => void) => void fns.add(fn),
      removeEventListener: (_t: "message", fn: (e: MessageEvent) => void) => void fns.delete(fn),
      close: () => void members.delete(fns),
    };
  };
}

/** A browser profile: one store, one lock manager, one channel name; `tab()` opens a tab of the same wallet. */
async function browser() {
  const storage = memoryStorage();
  const locks = new FakeLocks() as unknown as LockManager;
  const channel = bus();
  const first = new WalletSession(storage, KDF);
  await first.create("pw");
  first.acknowledgePhrase();
  first.lock();
  const tab = (stepAsideToo = true) => {
    const session = new WalletSession(storage, KDF);
    const store = new TabStateStore();
    const seen = { refreshes: 0, stateAtRefresh: [] as string[] };
    const refresh = async () => {
      seen.refreshes++;
      seen.stateAtRefresh.push(store.get());
    };
    const stop = startActiveTab({ session, stepAside: () => stepAsideToo && session.lock(), locks, channel, store, refresh });
    return { session, store, stop, seen };
  };
  return { tab };
}

/**
 * A browser profile whose tabs each keep their own copy of the store, as the secure store does (read at page load, written
 * through, read again by refresh()): the shape in which an older tab had brought back its old journal (audit c40).
 */
async function mirroredBrowser() {
  const backing = new Map<string, string>();
  const locks = new FakeLocks() as unknown as LockManager;
  const channel = bus();
  const mirrorOf = (): KeyValueStorage & { refresh(): Promise<void> } => {
    const m = new Map(backing);
    return {
      get: (k) => m.get(k) ?? null,
      set: (k, v) => void (m.set(k, v), backing.set(k, v)),
      remove: (k) => void (m.delete(k), backing.delete(k)),
      refresh: async () => {
        m.clear();
        for (const [k, v] of backing) m.set(k, v);
      },
    };
  };
  const first = new WalletSession(mirrorOf(), KDF);
  await first.create("pw");
  first.acknowledgePhrase();
  first.lock();
  const tab = (stepAside?: (s: WalletSession) => void) => {
    const session = new WalletSession(mirrorOf(), KDF);
    const store = new TabStateStore();
    const stop = startActiveTab({ session, stepAside: () => (stepAside ? stepAside(session) : session.lock()), locks, channel, store });
    return { session, store, stop };
  };
  return { tab };
}

describe("a tab's journal is the newest one (a V6 follow-up of 2026-10-16, audit c40)", () => {
  it("a tab opened before another tab's changes unlocks to them, and never writes its old journal back", async () => {
    const { tab } = await mirroredBrowser();
    const older = tab(); // opened now: its copy of the store is the wallet as created
    const b = tab();
    expect(await b.session.unlock("pw")).toBe(true);
    await settle();
    b.session.update((j) => {
      j.chainIndexes.evm = 7; // a fresh address handed out in the other tab
    });
    b.session.lock();
    expect(await older.session.unlock("pw")).toBe(true);
    await settle();
    expect(older.session.journal().chainIndexes.evm).toBe(7);
    older.session.lock();
    // a tab opened now reads what the store holds: the older tab wrote nothing older back
    const fresh = tab();
    expect(await fresh.session.unlock("pw")).toBe(true);
    await settle();
    expect(fresh.session.journal().chainIndexes.evm).toBe(7);
  });

  it("a tab that waited for the wallet reads what the other tab wrote until it stepped aside", async () => {
    const { tab } = await mirroredBrowser();
    // the first tab's last tick journals a change as it steps aside
    const a = tab((s) => {
      s.update((j) => {
        j.chainIndexes.evm = 3;
      });
      s.lock();
    });
    const b = tab();
    expect(await a.session.unlock("pw")).toBe(true);
    await settle();
    expect(await b.session.unlock("pw")).toBe(true); // opens the journal as it is now, then waits
    await settle();
    expect([a.session.isUnlocked(), b.store.get()]).toEqual([false, "active"]);
    expect(b.session.journal().chainIndexes.evm).toBe(3);
  });

  it("a tab that journals again while it takes the wallet over stays the one that holds it (a new wallet's first write)", async () => {
    // the local stack's run: a wallet created in its only tab showed "The wallet is open in another tab" — the second
    // journal write asked for the lock again while the tab, granted it, was still reading its journal
    // the store reads IndexedDB again (slow), and the lock manager answers a request held elsewhere in a later task
    const locks = new FakeLocks(30) as unknown as LockManager;
    const base = memoryStorage();
    const slow: KeyValueStorage = {
      get: (k) => base.get(k),
      set: (k, v) => base.set(k, v),
      remove: (k) => base.remove(k),
      refresh: () => new Promise((r) => setTimeout(r, 10)),
    };
    const session = new WalletSession(slow, KDF);
    const store = new TabStateStore();
    startActiveTab({ session, stepAside: () => session.lock(), locks, channel: bus(), store });
    await session.create("pw");
    session.update(() => {}); // journaled while the tab, granted the lock, reads its journal again
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    expect(store.get()).toBe("active");
  });
});

describe("one unlocked tab at a time", () => {
  it("the tab unlocked next waits and asks; the first steps aside and the wallet opens in the second — and back", async () => {
    const { tab } = await browser();
    const a = tab();
    const b = tab();
    expect(await a.session.unlock("pw")).toBe(true);
    await settle();
    expect(a.store.get()).toBe("active");
    expect(await b.session.unlock("pw")).toBe(true);
    await settle();
    expect([a.session.isUnlocked(), b.session.isUnlocked(), b.store.get()]).toEqual([false, true, "active"]);
    // the user goes back to the first tab and unlocks it there
    expect(await a.session.unlock("pw")).toBe(true);
    await settle();
    expect([a.session.isUnlocked(), a.store.get(), b.session.isUnlocked()]).toEqual([true, "active", false]);
  });

  it("the tab that takes the wallet over reads the preferences again before it opens (the audit's unverified m46)", async () => {
    const { tab } = await browser();
    const a = tab();
    const b = tab();
    expect(await a.session.unlock("pw")).toBe(true);
    await settle();
    expect(await b.session.unlock("pw")).toBe(true);
    await settle();
    expect(b.store.get()).toBe("active");
    expect(b.seen.refreshes, "read again once, as it took over").toBe(1);
    expect(b.seen.stateAtRefresh[0], "before the wallet opened in it").not.toBe("active");
  });

  it("three tabs: the tab unlocked last wins, and only one is ever unlocked at the end", async () => {
    const { tab } = await browser();
    const [a, b, c] = [tab(), tab(), tab()];
    expect(await a.session.unlock("pw")).toBe(true);
    await settle();
    expect(await b.session.unlock("pw")).toBe(true);
    expect(await c.session.unlock("pw")).toBe(true);
    await settle();
    expect([a.session.isUnlocked(), b.session.isUnlocked(), c.session.isUnlocked(), c.store.get()]).toEqual([false, false, true, "active"]);
  });

  it("a waiting tab shows why and runs nothing; locked while it waits, it leaves the line", async () => {
    const { tab } = await browser();
    const a = tab(false); // busy: it does not step aside yet (a hand-over in progress)
    const b = tab();
    expect(await a.session.unlock("pw")).toBe(true);
    await settle();
    expect(await b.session.unlock("pw")).toBe(true);
    await settle();
    expect([a.store.get(), b.store.get()]).toEqual(["active", "waiting"]);
    b.session.lock(); // "Lock this tab"
    await settle();
    a.session.lock();
    await settle();
    expect([b.session.isUnlocked(), b.store.get()], "nobody was granted the wallet in the locked tab").toEqual([false, "active"]);
    expect(await a.session.unlock("pw")).toBe(true);
    await settle();
    expect(a.store.get(), "the line is empty: the lock is free again").toBe("active");
  });

  it("until the lock manager answers, the tab is checking: the Gate shows the splash and nothing runs", async () => {
    const session = new WalletSession(memoryStorage(), KDF);
    await session.create("pw");
    const store = new TabStateStore();
    const silent = { request: () => new Promise(() => {}) } as unknown as LockManager;
    startActiveTab({ session, stepAside: () => session.lock(), locks: silent, store });
    await settle();
    expect(store.get()).toBe("checking");
    session.lock();
    expect(store.get(), "a locked tab waits for nothing").toBe("active");
  });

  it("without Web Locks nothing changes", async () => {
    const session = new WalletSession(memoryStorage(), KDF);
    await session.create("pw");
    const store = new TabStateStore();
    startActiveTab({ session, stepAside: () => session.lock(), locks: null, store });
    await settle();
    expect([session.isUnlocked(), store.get()]).toEqual([true, "active"]);
  });
});
