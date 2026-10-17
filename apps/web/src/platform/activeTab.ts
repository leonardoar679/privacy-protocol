// One unlocked tab at a time (a V6 follow-up of 2026-10-14). Each tab keeps its own decrypted journal and writes it
// whole, so two unlocked tabs erased each other's changes — a swap journaled in one was gone once the other wrote — and
// both would have run the same funding and signing ticks.
// - The unlocked tab holds the Web Lock `privacy-wallet:active`; any lock (automatic or explicit) gives it back.
// - A tab unlocked while another holds it waits (the Gate shows why), and asks the other to step aside over the
//   BroadcastChannel `privacy-wallet`. The other's auto-lock locks it as soon as nothing is in progress — never inside a
//   signature prompt, a proof, a submission or a hand-over (the session's holds) — which releases the lock; only then
//   does this tab show the wallet and run its scheduler.
// - The tab unlocked last wins: a tab granted the lock after another asked steps aside in turn.
// - A tab granted the lock reads the journal again before anything of it runs (a V6 follow-up of 2026-10-16, audit c40):
//   it opened the journal at its unlock, and the other tab kept writing until it stepped aside.
// - Without Web Locks (an old browser) nothing changes; without BroadcastChannel a waiting tab waits for the other to lock.
import { useSyncExternalStore } from "react";
import type { WalletSession } from "@privacy-wallet/sdk/wallet/session";

/** `checking`: unlocked, the lock not answered yet (nothing runs); `waiting`: another tab holds it. */
export type TabState = "active" | "checking" | "waiting";
export const ACTIVE_LOCK = "privacy-wallet:active";
export const TAB_CHANNEL = "privacy-wallet";

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

const defaultChannel = (): Channel | null => (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(TAB_CHANNEL));
const randomId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Starts the coordination for this page; returns the stop. `stepAside` locks this tab as soon as nothing is in progress. */
export function startActiveTab(d: {
  session: WalletSession;
  stepAside: () => void;
  locks?: LockManager | null;
  channel?: () => Channel | null;
  store?: TabStateStore;
  /** what else is read again when this tab takes the wallet over: the preferences (the audit's unverified m46) */
  refresh?: () => Promise<void>;
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

  const hold = (): Promise<void> =>
    new Promise<void>((resolve) => {
      release = () => {
        release = null;
        resolve();
      };
      store.set("active");
      if (laterAsker !== null) d.stepAside(); // another tab was unlocked after this one asked: it wins
    });

  // the journal as the store holds it when this tab takes the wallet over: what the other tab wrote last
  const takeOver = async (): Promise<void> => {
    taking = true;
    try {
      await d.session.reload().catch(() => undefined);
      await d.refresh?.().catch(() => undefined);
    } finally {
      taking = false;
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
      channel?.postMessage({ type: "step-aside", from: id });
      locks
        .request(ACTIVE_LOCK, { signal: queued.signal }, () => {
          queued = null;
          return takeOver();
        })
        .catch(() => {
          // aborted: this tab locked while it waited
        });
    });
  };

  const onMessage = (e: MessageEvent) => {
    const m = e.data as { type?: unknown; from?: unknown } | null;
    if (m?.type !== "step-aside" || typeof m.from !== "string" || m.from === id) return;
    laterAsker = m.from;
    if (release && d.session.isUnlocked()) d.stepAside();
  };
  channel?.addEventListener("message", onMessage);

  const onSession = () => {
    if (d.session.isUnlocked()) return acquire();
    release?.();
    queued?.abort();
    queued = null;
    store.set("active"); // a locked tab waits for nothing
  };
  const offSession = d.session.subscribe(onSession);
  onSession();
  return () => {
    offSession();
    channel?.removeEventListener("message", onMessage);
    channel?.close();
    release?.();
    queued?.abort();
  };
}
