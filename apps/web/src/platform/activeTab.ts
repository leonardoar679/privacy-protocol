// One unlocked tab at a time (a V6 follow-up of 2026-10-14). Each tab keeps its own decrypted journal and writes it
// whole, so two unlocked tabs erased each other's changes — a swap journaled in one was gone once the other wrote — and
// both would have run the same funding and signing ticks.
// - The unlocked tab holds the Web Lock `privacy-wallet:active`; any lock (automatic or explicit) gives it back.
// - A tab unlocked while another holds it waits (the Gate shows why), and asks the other to step aside over the
//   BroadcastChannel `privacy-wallet`. The other's auto-lock locks it as soon as nothing is in progress — never inside a
//   signature prompt, a proof, a submission or a hand-over (the session's holds) — which releases the lock; only then
//   does this tab show the wallet and run its scheduler.
// - The tab unlocked last wins: a tab granted the lock after another asked steps aside in turn.
// - A tab that asked and then locked withdraws its request (the eleventh review round, 2026-11-04, H11-3); one that closed cannot, so the
//   tab asked confirms by the lock's queue that someone still waits — the step aside had been carried out for nobody at the next release.
//   The queue decides with three tabs and more (the round's critique): a withdrawal cancels the step aside only once nobody waits, and a tab
//   granted the lock steps aside only for a tab still in the queue — not for one that asked while it waited and closed since.
// - A tab granted the lock reads the journal again before anything of it runs (a V6 follow-up of 2026-10-16, audit c40):
//   it opened the journal at its unlock, and the other tab kept writing until it stepped aside. A tab gives the lock back
//   only once its writes have reached the store, waiting 5 s at most (audit round 2, r17): a put still queued was read
//   past, then overwritten.
// - Without Web Locks (an old browser) nothing changes; without BroadcastChannel a waiting tab waits for the other to lock.
import { useSyncExternalStore } from "react";
import type { WalletSession } from "@privacy-wallet/sdk/wallet/session";

/** `checking`: unlocked, the lock not answered yet (nothing runs); `waiting`: another tab holds it. */
export type TabState = "active" | "checking" | "waiting";
export const ACTIVE_LOCK = "privacy-wallet:active";
export const TAB_CHANNEL = "privacy-wallet";
/** the longest a locked tab waits for its writes before it gives the lock back anyway: a store that never answers holds no tab out */
export const FLUSH_WAIT_MS = 5_000;
/**
 * How long a takeover waits for its reads — the journal, the preferences — before it gives the lock back and locks its tab
 * (audit round 2, n23): a read that never answered kept the tab on the Splash with the lock held, and no tab could open the
 * wallet. An unlock tries again.
 */
export const TAKEOVER_READ_MS = 15_000;
/** How often a tab asked to step aside confirms that the asker still waits in the lock's queue (H11-3). */
export const STEP_ASIDE_WATCH_MS = 2_000;
/** A queue read this soon after a request to step aside does not count as "nobody waits" — at the watch, a withdrawal and a grant alike: the
 *  asker's request may not be queued yet. */
export const ASK_SETTLE_MS = 1_000;

interface Channel {
  postMessage(m: unknown): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", fn: (e: MessageEvent) => void): void;
  close(): void;
}

export class TabStateStore {
  private state: TabState = "active";
  private listeners = new Set<() => void>();
  get = (): TabState => this.state;
  set(s: TabState): void {
    if (s === this.state) return;
    this.state = s;
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}
export const activeTab = new TabStateStore();
export const useActiveTab = (): TabState => useSyncExternalStore(activeTab.subscribe, activeTab.get, activeTab.get);

/**
 * Whether a tab of this browser holds the wallet now (the fourth review round, 2026-11-03): asked before a REPLACE — a create or
 * a restore over the wallet another tab has open, whose next write (a tick, a proof's result, a settings mirror) had put the
 * old journal over the new wallet's under a key it does not have. A locked tab holds no lock, so the one asking never counts
 * itself (a lock still on its way back after this tab's own lock, FLUSH_WAIT_MS at most, reads as held: the user tries again).
 * Without Web Locks, or without `query`, nothing is known and nothing changes.
 */
export async function anotherTabHoldsWallet(locks: LockManager | null = typeof navigator !== "undefined" ? (navigator.locks ?? null) : null): Promise<boolean> {
  if (!locks || typeof locks.query !== "function") return false;
  try {
    const { held } = await locks.query();
    return (held ?? []).some((l) => l.name === ACTIVE_LOCK);
  } catch {
    return false;
  }
}

const defaultChannel = (): Channel | null => (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(TAB_CHANNEL));
const randomId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Starts the coordination for this page; returns the stop. `stepAside` locks this tab as soon as nothing is in progress. */
export function startActiveTab(d: {
  session: WalletSession;
  stepAside: () => void;
  /** the tab that asked no longer waits: this one stays (H11-3) */
  cancelStepAside?: () => void;
  locks?: LockManager | null;
  channel?: () => Channel | null;
  store?: TabStateStore;
  /** what else is read again when this tab takes the wallet over: the preferences (the audit's unverified m46) */
  refresh?: () => Promise<void>;
  /** this tab's writes on their way to the store (the secure store's flush): awaited before the lock is given back (r17) */
  flush?: () => Promise<void>;
  /** how long at most (FLUSH_WAIT_MS) */
  flushWaitMs?: number;
  /** how long a takeover's reads may take (TAKEOVER_READ_MS) */
  takeoverWaitMs?: number;
}): () => void {
  const store = d.store ?? activeTab;
  const locks = d.locks === undefined ? (typeof navigator !== "undefined" ? (navigator.locks ?? null) : null) : d.locks;
  if (!locks) return () => {};
  const id = randomId();
  const channel = (d.channel ?? defaultChannel)();
  /** a tab that asked for the wallet after this one last did */
  let laterAsker: string | null = null;
  /** gives back the lock this tab holds */
  let release: (() => void) | null = null;
  /** this tab's place in the queue */
  let queued: AbortController | null = null;
  let checking = false;
  /** granted the lock, reading the journal again before holding it: a change of the session meanwhile asks for nothing */
  let taking = false;
  /** this tab asked another to step aside and waits in the queue: withdrawn when it locks (H11-3) */
  let asked = false;
  /** asked to step aside: the lock's queue read until the asker is gone or this tab locks (a closed tab withdraws nothing) */
  let watching: ReturnType<typeof setInterval> | null = null;
  /** when the last request to step aside came: its asker posts before its request reaches the queue */
  let askedAt = 0;
  const stopWatch = () => {
    if (watching !== null) clearInterval(watching);
    watching = null;
  };
  const withdrawn = () => {
    stopWatch();
    if (laterAsker === null) return;
    laterAsker = null;
    if (release && d.session.isUnlocked()) d.cancelStepAside?.();
  };
  /** Whether a tab waits in the lock's queue now; null where the queue cannot be read (then a message is believed, as before). */
  const someoneWaits = async (): Promise<boolean | null> => {
    if (typeof locks.query !== "function") return null;
    try {
      const { pending } = await locks.query();
      return (pending ?? []).some((l) => l.name === ACTIVE_LOCK);
    } catch {
      return null;
    }
  };
  const watchAsker = () => {
    if (watching !== null || typeof locks.query !== "function") return;
    watching = setInterval(() => {
      void someoneWaits().then((waits) => {
        if (waits === false && Date.now() - askedAt >= ASK_SETTLE_MS) withdrawn();
      });
    }, STEP_ASIDE_WATCH_MS);
  };

  const hold = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const mine = () => {
        if (release === mine) release = null;
        resolve();
      };
      release = mine;
      store.set("active");
      if (laterAsker === null) return;
      // another tab was unlocked after this one asked: it wins — while it still waits in the queue (the critique: one that asked while this tab
      // waited and closed since had this tab lock at its grant, for nobody). Every tab in the queue now was queued after this one; a read too
      // soon after the last request is read again once it settles (the second critique)
      const decide = (): void => {
        void someoneWaits().then((waits) => {
          if (release !== mine || !d.session.isUnlocked()) return;
          if (waits === false) {
            const early = ASK_SETTLE_MS - (Date.now() - askedAt);
            if (early > 0) return void setTimeout(decide, early);
            laterAsker = null;
            return;
          }
          d.stepAside();
          watchAsker();
        });
      };
      decide();
    });

  // the journal as the store holds it when this tab takes the wallet over: what the other tab wrote last
  const takeOver = async (): Promise<void> => {
    taking = true;
    let read = false;
    try {
      const reads = (async () => {
        await d.session.reload().catch(() => undefined);
        await d.refresh?.().catch(() => undefined);
        return true;
      })();
      // bounded (n23): unread in time, this tab never acts on a journal it could not read again — it locks, and the lock goes
      // back with the callback; a read answering later finds the session locked and changes nothing
      read = await Promise.race([reads, new Promise<false>((r) => setTimeout(() => r(false), d.takeoverWaitMs ?? TAKEOVER_READ_MS))]);
    } finally {
      taking = false;
    }
    if (!read) {
      d.session.lock();
      return;
    }
    if (d.session.isUnlocked()) return hold();
  };

  const acquire = () => {
    if (release || queued || checking || taking) return;
    checking = true;
    laterAsker = null; // a fresh unlock: only a tab that asks from now on comes after this one
    store.set("checking");
    void locks.request(ACTIVE_LOCK, { ifAvailable: true }, (lock) => {
      checking = false;
      if (!d.session.isUnlocked()) return; // locked again before the answer
      if (lock) return takeOver();
      // another tab holds it: ask it to step aside, and wait in line
      store.set("waiting");
      queued = new AbortController();
      asked = true;
      channel?.postMessage({ type: "step-aside", from: id });
      locks
        .request(ACTIVE_LOCK, { signal: queued.signal }, () => {
          queued = null;
          asked = false;
          return takeOver();
        })
        .catch(() => {
          // aborted: this tab locked while it waited
        });
    });
  };

  const onMessage = (e: MessageEvent) => {
    const m = e.data as { type?: unknown; from?: unknown } | null;
    if (typeof m?.from !== "string" || m.from === id) return;
    if (m.type === "step-aside-withdrawn") {
      if (laterAsker === null) return;
      // the queue decides (the critique): with three tabs the one that withdrew may not be the only one waiting — its own request, aborted
      // just before the message, may still be listed: the watch reads the queue again until it empties
      // not holding: the grant's own read of the queue decides (the second critique: with four tabs one asker's withdrawal had cleared the
      // ask of another still waiting); the message alone only where the queue cannot be read
      if (!release) {
        if (typeof locks.query !== "function" && laterAsker === m.from) laterAsker = null;
        return;
      }
      const from = m.from;
      void someoneWaits().then((waits) => {
        if (waits === true) return watchAsker();
        if (waits === null && laterAsker !== from) return;
        // too soon after the last request to say nobody waits (its request may not be queued yet): the watch reads again once it settles
        if (waits === false && Date.now() - askedAt < ASK_SETTLE_MS) return watchAsker();
        withdrawn();
      });
      return;
    }
    if (m.type !== "step-aside") return;
    laterAsker = m.from;
    askedAt = Date.now();
    if (release && d.session.isUnlocked()) {
      d.stepAside();
      watchAsker();
    }
  };
  channel?.addEventListener("message", onMessage);

  const onSession = () => {
    if (d.session.isUnlocked()) return acquire();
    // given back once this tab's writes reached the store, or after FLUSH_WAIT_MS (audit round 2, r17): the tab it goes to
    // reads the journal at its grant, and a put still queued here landed after that read — that tab's next write overwrote it
    const r = release;
    release = null;
    if (r) {
      const written = Promise.resolve(d.flush?.()).catch(() => undefined);
      const waited = new Promise((x) => setTimeout(x, d.flushWaitMs ?? FLUSH_WAIT_MS));
      void Promise.race([written, waited]).then(() => r());
    }
    stopWatch();
    queued?.abort();
    queued = null;
    // a request this tab made is withdrawn (H11-3): the tab it asked had locked for nobody
    if (asked) channel?.postMessage({ type: "step-aside-withdrawn", from: id });
    asked = false;
    store.set("active"); // a locked tab waits for nothing
  };
  const offSession = d.session.subscribe(onSession);
  onSession();
  return () => {
    offSession();
    stopWatch();
    channel?.removeEventListener("message", onMessage);
    channel?.close();
    release?.();
    queued?.abort();
  };
}
