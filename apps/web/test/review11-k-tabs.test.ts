// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), slice 2a after its diff critique (T6/C2): one unlocked tab at a time with three tabs
// (apps/web/src/platform/activeTab.ts, H11-3). The lock's queue decides: a withdrawal cancels the holder's step aside only once nobody waits —
// the tab that withdrew need not be the only one in line, nor the one the holder heard from last — and a tab granted the lock steps aside only
// for a tab still in the queue, never for one that asked while it waited and closed since. And the page's wiring: startPlatform hands the
// coordinator the auto-lock's cancelStepAside, without which a withdrawal reached no controller. The tabs are review11-platform.test.ts's fake
// session, Web Locks and channel, with the SDK's own auto-lock deciding when a step aside locks.
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { ACTIVE_LOCK, ASK_SETTLE_MS, startActiveTab, STEP_ASIDE_WATCH_MS, TabStateStore } from "../src/platform/activeTab";
import { AutoLock, type LockTrigger } from "@privacy-wallet/sdk/session/autoLock";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { startPlatform } from "../src/platform";
import { cancelStepAside, lockedElsewhere, stepAside } from "../src/platform/autoLock";

// the coordinator as it is, its calls recorded: the tabs below run it, and startPlatform's own call is read for what it is handed
vi.mock("../src/platform/activeTab", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/platform/activeTab")>();
  return { ...orig, startActiveTab: vi.fn(orig.startActiveTab) };
});

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------ the harness of review11-platform.test.ts (not exported)
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
/** The tab's view of the lock manager with its waiting request reaching the queue `ms` after it is made — after its message to step aside. */
const lateQueue = (locks: FakeLocks, ms: number) => ({
  request: (n: string, o: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (l: unknown) => unknown): Promise<unknown> =>
    o.ifAvailable ? locks.request(n, o, cb) : new Promise((res, rej) => setTimeout(() => void locks.request(n, o, cb).then(res, rej), ms)),
  query: () => locks.query(),
});
function tab(locks: FakeLocks, hub: Hub, manager: unknown = locks) {
  const session = new FakeSession();
  const triggers: LockTrigger[] = [];
  const auto = new AutoLock({ session: session as never, minutes: () => 15, onLock: (t) => triggers.push(t) });
  const stopAuto = auto.start();
  const store = new TabStateStore();
  const stopTab = startActiveTab({
    session: session as never,
    stepAside: () => auto.stepAside(),
    cancelStepAside: () => auto.cancelStepAside(),
    locks: manager as LockManager,
    channel: () => hub.channel(),
    store,
    flushWaitMs: 5,
    takeoverWaitMs: 1000,
  });
  // a closed tab's auto-lock goes with it (here, unlike the original harness, its timer too)
  const stop = () => {
    stopTab();
    stopAuto();
  };
  return { session, store, triggers, stop };
}

/**
 * A holds the wallet inside a signature prompt; B, unlocked next, waits; C, unlocked last, waits behind B — each asked A to step aside, and B
 * heard C ask too (C is the last asker of both). `closeC` closes C: its queued request goes with it, and a closed tab sends no message.
 */
async function threeTabs() {
  const locks = new FakeLocks();
  const hub = new Hub();
  const [A, B, C] = [tab(locks, hub), tab(locks, hub), tab(locks, hub)];
  A.session.unlock();
  await settle();
  const releaseA = A.session.hold("signature");
  const beforeB = Date.now(); // A's watch of the queue starts after this, at B's request
  B.session.unlock();
  await settle();
  C.session.unlock();
  await settle();
  expect([A.store.get(), B.store.get(), C.store.get()]).toEqual(["active", "waiting", "waiting"]);
  expect(A.session.isUnlocked(), "the prompt defers A's step aside").toBe(true);
  expect(locks.queue).toHaveLength(2);
  const cInLine = locks.queue[1]; // the queue is in order: C's request is behind B's
  const closeC = () => {
    locks.queue.splice(locks.queue.indexOf(cInLine), 1);
    C.stop();
  };
  return { locks, A, B, C, releaseA, closeC, beforeB };
}

describe("three tabs: the lock's queue decides (H11-3; the critique of slice 2a, T6/C2)", () => {
  it("A holds the wallet inside a prompt, B and C wait, C locks: B still waits, so A steps aside at its release and B gets the wallet and keeps it", async () => {
    const { locks, A, B, C, releaseA } = await threeTabs();
    C.session.lock(); // "Lock this tab": C's request withdrawn — but B is still in line
    await settle();
    expect(locks.queue, "B alone waits").toHaveLength(1);
    releaseA();
    await settle(100);
    expect(A.session.isUnlocked(), "B still waits: A stepped aside").toBe(false);
    expect(A.triggers).toEqual(["elsewhere"]);
    expect(B.store.get(), "B got the wallet").toBe("active");
    expect(B.session.isUnlocked()).toBe(true);
    expect(B.triggers, "and keeps it: nobody waits behind it").toEqual([]);
    expect({ held: locks.holder, waiting: locks.queue.length }).toEqual({ held: true, waiting: 0 });
    for (const t of [A, B, C]) t.stop();
  });

  it("C closes instead (its place in the queue gone, no message): A steps aside to B at its release, and B, whose last asker was C, keeps the wallet — its grant reads nobody in the queue", async () => {
    const { locks, A, B, releaseA, closeC } = await threeTabs();
    closeC();
    await settle();
    expect(locks.queue, "B alone waits").toHaveLength(1);
    releaseA();
    await settle(100);
    expect(A.session.isUnlocked(), "B still waits: A stepped aside").toBe(false);
    expect(A.triggers).toEqual(["elsewhere"]);
    expect(B.store.get()).toBe("active");
    expect(B.session.isUnlocked(), "B stays: the tab that asked it closed").toBe(true);
    expect(B.triggers, "no step aside for nobody").toEqual([]);
    expect({ held: locks.holder, waiting: locks.queue.length }).toEqual({ held: true, waiting: 0 });
    A.stop();
    B.stop();
  });

  it("C closes, then B locks: nobody is left in the queue, and once the last request has settled A's read of it withdraws the step aside — A stays at its release, though the tab it heard from last was C", async () => {
    const { locks, A, B, releaseA, closeC } = await threeTabs();
    closeC();
    await settle();
    B.session.lock(); // B's request withdrawn: now nobody waits
    await settle();
    expect(locks.queue).toHaveLength(0);
    // too soon after C's request to call the queue empty (the second critique: a request may not be queued yet) — the watch reads it again
    await settle(STEP_ASIDE_WATCH_MS + ASK_SETTLE_MS);
    releaseA();
    await settle(100);
    expect(A.session.isUnlocked(), "nobody waits: A stays").toBe(true);
    expect(A.triggers).toEqual([]);
    expect(A.store.get()).toBe("active");
    expect({ held: locks.holder, waiting: locks.queue.length }).toEqual({ held: true, waiting: 0 });
    A.stop();
    B.stop();
  });

  it("control: C still waits when B is granted — B, with nothing in progress, steps aside to C at once, and C gets the wallet", async () => {
    const { locks, A, B, C, releaseA } = await threeTabs();
    releaseA();
    await settle(100);
    expect(A.triggers).toEqual(["elsewhere"]);
    expect(B.session.isUnlocked(), "the tab unlocked last wins").toBe(false);
    expect(B.triggers).toEqual(["elsewhere"]);
    expect(C.store.get()).toBe("active");
    expect(C.session.isUnlocked()).toBe(true);
    expect(C.triggers).toEqual([]);
    expect({ held: locks.holder, waiting: locks.queue.length }).toEqual({ held: true, waiting: 0 });
    for (const t of [A, B, C]) t.stop();
  });
});

describe("four tabs, and a request the queue does not hold yet (the second critique, T2-2, T2-3, T2-4)", () => {
  it("A holds, B, C and D wait, D locks: B is granted at A's release and its grant reads C still waiting — B steps aside to C, unlocked after it", async () => {
    const locks = new FakeLocks();
    const hub = new Hub();
    const [A, B, C, D] = [tab(locks, hub), tab(locks, hub), tab(locks, hub), tab(locks, hub)];
    A.session.unlock();
    await settle();
    const releaseA = A.session.hold("signature");
    for (const t of [B, C, D]) {
      t.session.unlock();
      await settle();
    }
    expect(locks.queue).toHaveLength(3);
    D.session.lock(); // D withdraws; B heard D ask last — before, B forgot every ask at D's withdrawal and kept the wallet from C
    await settle(STEP_ASIDE_WATCH_MS + ASK_SETTLE_MS);
    releaseA();
    await settle(200);
    expect(A.triggers).toEqual(["elsewhere"]);
    expect(B.triggers, "B steps aside: C waits behind it").toEqual(["elsewhere"]);
    expect(C.store.get()).toBe("active");
    expect(C.session.isUnlocked()).toBe(true);
    expect({ held: locks.holder, waiting: locks.queue.length }).toEqual({ held: true, waiting: 0 });
    for (const t of [A, B, C, D]) t.stop();
  });

  it("a withdrawal read moments after another tab asked does not cancel the step aside: that tab's request is queued after its message, and gets the wallet at the release", async () => {
    const locks = new FakeLocks();
    const hub = new Hub();
    const A = tab(locks, hub);
    const B = tab(locks, hub);
    const C = tab(locks, hub, lateQueue(locks, 60));
    A.session.unlock();
    await settle();
    const releaseA = A.session.hold("signature");
    B.session.unlock();
    await settle();
    C.session.unlock(); // its message goes out; its request reaches the queue 60 ms later
    await settle(10);
    B.session.lock(); // B withdraws while C's request is not queued yet: the queue reads empty
    await settle(150);
    expect(locks.queue, "C queued by now").toHaveLength(1);
    releaseA();
    await settle(150);
    expect(A.triggers, "the step aside stood: C waits").toEqual(["elsewhere"]);
    expect(C.store.get()).toBe("active");
    expect(C.session.isUnlocked()).toBe(true);
    for (const t of [A, B, C]) t.stop();
  });

  it("a grant read moments after another tab asked reads the queue again once that settles: B, granted before C's request is queued, steps aside to C", async () => {
    const locks = new FakeLocks();
    const hub = new Hub();
    const A = tab(locks, hub);
    const B = tab(locks, hub);
    const C = tab(locks, hub, lateQueue(locks, 60));
    A.session.unlock();
    await settle();
    const releaseA = A.session.hold("signature");
    B.session.unlock();
    await settle();
    C.session.unlock();
    await settle(10); // C's message reached A and B; its request is not queued yet
    releaseA(); // A steps aside, B is granted with C asking and nothing of C in the queue
    await settle(30);
    expect(B.session.isUnlocked(), "B holds the wallet for now").toBe(true);
    await settle(ASK_SETTLE_MS + 300);
    expect(B.triggers, "the read again finds C: B steps aside").toEqual(["elsewhere"]);
    expect(C.store.get()).toBe("active");
    expect(C.session.isUnlocked()).toBe(true);
    for (const t of [A, B, C]) t.stop();
  });

  it("the watch's read moments after a request does not withdraw it: B closes just before a tick as C asks, C's request queued after the tick — A steps aside to C", async () => {
    const locks = new FakeLocks();
    const hub = new Hub();
    const A = tab(locks, hub);
    const B = tab(locks, hub);
    A.session.unlock();
    await settle();
    const releaseA = A.session.hold("signature");
    B.session.unlock();
    const asked = Date.now(); // A's watch starts when B's message arrives: its first tick about STEP_ASIDE_WATCH_MS from here
    await settle();
    await settle(Math.max(0, STEP_ASIDE_WATCH_MS - 120 - (Date.now() - asked)));
    locks.queue.length = 0; // B closes: its request gone, no message
    B.stop();
    const C = tab(locks, hub, lateQueue(locks, 300));
    C.session.unlock(); // asks now; its request is queued only after the tick
    await settle(500);
    expect(locks.queue, "C queued by now").toHaveLength(1);
    releaseA();
    await settle(150);
    expect(A.triggers, "the tick read an empty queue moments after C asked: the step aside stood").toEqual(["elsewhere"]);
    expect(C.store.get()).toBe("active");
    for (const t of [A, C]) t.stop();
  });
});

describe("the page's wiring (the critique, C2)", () => {
  it("startPlatform hands the coordinator the auto-lock's cancelStepAside next to its stepAside: a request withdrawn inside a hold leaves this page unlocked at the release", async () => {
    const start = vi.mocked(startActiveTab);
    start.mockClear();
    start.mockImplementationOnce(() => () => {}); // the page's own coordinator is not started here: what it is handed is read
    const stop = startPlatform();
    try {
      expect(start).toHaveBeenCalledTimes(1);
      const d = start.mock.calls[0][0];
      expect(d.session).toBe(session);
      expect(d.stepAside).toBe(stepAside);
      expect(d.cancelStepAside, "the auto-lock's own: the tab that asked no longer waits, this one stays (H11-3)").toBe(cancelStepAside);
      // and the pair reaches the auto-lock startPlatform started
      await session.create("a strong password");
      session.acknowledgePhrase();
      const release = session.hold("signature");
      d.stepAside(); // another tab asked
      d.cancelStepAside?.(); // and withdrew
      release();
      expect(session.isUnlocked(), "withdrawn: this page stays").toBe(true);
      expect(lockedElsewhere()).toBe(false);
      const again = session.hold("signature");
      d.stepAside();
      again();
      expect(session.isUnlocked(), "control: not withdrawn, it steps aside at the release").toBe(false);
      expect(lockedElsewhere()).toBe(true);
    } finally {
      stop();
      session.forget();
    }
  });
});
