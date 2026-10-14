// One unlocked tab at a time (a V6 follow-up of 2026-10-14; apps/web/src/platform/activeTab.ts). Two unlocked tabs each
// wrote their whole journal — one tab's swap was gone once the other wrote — and both ran the same ticks. Against a fake
// Web Lock manager and an in-memory BroadcastChannel, with tabs sharing one store as a browser's tabs share IndexedDB:
// the tab unlocked first holds the wallet; one unlocked next waits and asks it to step aside; the tab unlocked last wins;
// a tab that locks while it waits leaves the line; without Web Locks nothing changes.
import { describe, expect, it } from "vitest";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { ACTIVE_LOCK, startActiveTab, TabStateStore } from "../src/platform/activeTab";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A Web Lock manager for one name: exclusive, a queue in order, `ifAvailable`, `signal` aborts a queued request. */
class FakeLocks {
  private held = false;
  private queue: { cb: LockGrantedCallback; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  request(name: string, options: LockOptions, cb: LockGrantedCallback): Promise<unknown> {
    expect(name).toBe(ACTIVE_LOCK);
    return new Promise((resolve, reject) => {
      if (!this.held) return this.grant(cb, resolve, reject);
      if (options.ifAvailable)
        return void Promise.resolve()
          .then(() => cb(null))
          .then(resolve, reject);
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
    const stop = startActiveTab({ session, stepAside: () => stepAsideToo && session.lock(), locks, channel, store });
    return { session, store, stop };
  };
  return { tab };
}

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
