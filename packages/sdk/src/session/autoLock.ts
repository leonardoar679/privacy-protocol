// Auto-lock (spec v2.0 §8; doc §18; V6 Stage 15). The protected wallet locks:
//   - after the user's idle minutes (1, 5, 15 or 60; 15 by default; More → Security; kept in the encrypted journal);
//   - 5 minutes after the tab is hidden;
//   - on an explicit Lock;
//   - on `pagehide` — at once without a hold; with a live hold (V7 Stage 16, spec v3.0 §9: a phone's wallet handoff fires it
//     mid-prompt) at the hold's release, or past the cap at the safe point; a `pageshow` before that resumes;
//   - when another tab of this wallet is unlocked (a V6 follow-up: one unlocked tab at a time, the platform's activeTab.ts),
//     as soon as nothing is in progress, like every automatic lock.
// Focus loss counts as idleness only: a wallet pop-up and the WalletConnect modal take focus. A critical section — the
// signature prompt, proving, submission, commit → hand-over — holds the lock off (`session.hold(reason)`) for at most
// 30 minutes; past that, the lock happens at the next safe point (a hold released, or the scheduler between two runner
// ticks: `session.safePoint()`), and at the latest SAFE_POINT_GRACE_MS later: a safe point may never come (2026-10-17, the
// audit's unverified m43 — a first-launch session has no due action, and offline the scheduler runs nothing, so a stuck
// prompt kept the wallet unlocked for good). The verdict is pure (`lockVerdict`); the controller keeps the clock and one timer; the
// platform (apps/web/src/platform/autoLock.ts) feeds it the page's events.
import type { Hold, WalletSession } from "../wallet/session";

export const AUTO_LOCK_MINUTES = [1, 5, 15, 60] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTES)[number];
export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 15;
export const HIDDEN_LOCK_MS = 5 * 60_000;
export const HOLD_CAP_MS = 30 * 60_000;
/** Past the cap, how long the lock waits for a safe point before it happens anyway. */
export const SAFE_POINT_GRACE_MS = 10 * 60_000;

/** A stored value as one of the four choices; anything else is the default. */
export const autoLockMinutesOf = (v: unknown): AutoLockMinutes =>
  AUTO_LOCK_MINUTES.includes(v as AutoLockMinutes) ? (v as AutoLockMinutes) : DEFAULT_AUTO_LOCK_MINUTES;

export interface AutoLockFacts {
  now: number;
  lastActivity: number;
  /** when the tab went hidden; null while it is visible */
  hiddenSince: number | null;
  idleMinutes: number;
  holds: readonly Hold[];
  /** another tab of this wallet asked this one to step aside */
  elsewhere?: boolean;
  /** the page is going away or gone (a pagehide without a pageshow since; V7 Stage 16) */
  pageHidden?: boolean;
}
export type LockCause = "idle" | "hidden" | "elsewhere" | "pagehide";
export interface LockVerdict {
  /** why a lock is due now, or null */
  due: LockCause | null;
  /** a hold younger than the cap defers the due lock until it is released */
  heldBy: string | null;
  /** every hold is past the cap: the lock happens at the next safe point (and at `nextCheck` without one) */
  atSafePoint: boolean;
  /** when the verdict can next change without an event (ms since the epoch); null when only an event can change it */
  nextCheck: number | null;
}

export function lockVerdict(f: AutoLockFacts): LockVerdict {
  const idleAt = f.lastActivity + f.idleMinutes * 60_000;
  const hiddenAt = f.hiddenSince === null ? Infinity : f.hiddenSince + HIDDEN_LOCK_MS;
  const due: LockCause | null = f.pageHidden ? "pagehide" : f.elsewhere ? "elsewhere" : f.now >= hiddenAt ? "hidden" : f.now >= idleAt ? "idle" : null;
  if (!due) return { due: null, heldBy: null, atSafePoint: false, nextCheck: Math.min(idleAt, hiddenAt) };
  const live = f.holds.filter((h) => f.now - h.since < HOLD_CAP_MS);
  if (live.length) return { due, heldBy: live[0].reason, atSafePoint: false, nextCheck: Math.min(...live.map((h) => h.since + HOLD_CAP_MS)) };
  if (!f.holds.length) return { due, heldBy: null, atSafePoint: false, nextCheck: null };
  const anyway = Math.max(...f.holds.map((h) => h.since)) + HOLD_CAP_MS + SAFE_POINT_GRACE_MS;
  return f.now >= anyway ? { due, heldBy: null, atSafePoint: false, nextCheck: null } : { due, heldBy: null, atSafePoint: true, nextCheck: anyway };
}

export interface AutoLockClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: AutoLockClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type LockTrigger = LockCause;

/** The controller: activity, visibility and page events in, `session.lock()` out — only while the wallet is unlocked. */
export class AutoLock {
  private lastActivity: number;
  private hiddenSince: number | null = null;
  private timer: unknown = null;
  private pendingSafePoint = false;
  private wasUnlocked = false;
  private holdCount = 0;
  private elsewhere = false;
  private pageHidden = false;
  private readonly clock: AutoLockClock;

  constructor(private readonly o: { session: WalletSession; minutes: () => number; clock?: AutoLockClock; onLock?: (trigger: LockTrigger) => void }) {
    this.clock = o.clock ?? realClock;
    this.lastActivity = this.clock.now();
  }

  /** Listens to the session (an unlock restarts the idle clock, a released hold may let a due lock happen). */
  start(): () => void {
    const offSession = this.o.session.subscribe(() => this.onSession());
    const offSafe = this.o.session.onSafePoint(() => this.safePoint());
    this.onSession();
    return () => {
      offSession();
      offSafe();
      this.cancel();
    };
  }

  /** The user did something (a pointer, a key, a wheel, a touch — a scroll is none since the eleventh review round, H11-8). */
  activity(): void {
    // a deadline that passed while no timer ran — the machine suspended with the page visible — locks before the clock restarts (the
    // eleventh review round, 2026-11-04, H11-8): the first pointer move after it had reset the idle clock and only then checked
    if (this.o.session.isUnlocked()) this.check();
    this.lastActivity = this.clock.now();
    if (this.o.session.isUnlocked()) this.check();
  }

  /** The tab's visibility changed. Coming back is checked before the clock resets: 5 minutes away locks on return. */
  visibility(hidden: boolean): void {
    if (hidden) {
      this.hiddenSince ??= this.clock.now();
      this.check();
      return;
    }
    this.check();
    this.hiddenSince = null;
    if (this.o.session.isUnlocked()) this.check();
  }

  /**
   * The page is going away (closed, navigated, put in the back-forward cache): locked at once — unless a critical section
   * holds the lock off (V7 Stage 16, spec v3.0 §9): a phone's wallet handoff fires pagehide in the middle of the prompt, and
   * the page must come back to an unlocked wallet. Then the lock waits for the hold's release (or, past the cap, the safe
   * point), and a pageshow before that resumes.
   */
  pageHide(): void {
    this.pageHidden = true;
    this.check();
  }

  /** The page is back (restored from the back-forward cache, the handoff returned): the pending pagehide lock is dropped. */
  pageShow(): void {
    this.pageHidden = false;
    if (this.o.session.isUnlocked()) this.check();
  }

  /** Another tab of this wallet was unlocked: this one locks as soon as nothing is in progress (the holds, then a safe point). */
  stepAside(): void {
    this.elsewhere = true;
    if (this.o.session.isUnlocked()) this.check();
  }

  /**
   * The tab that asked for the wallet no longer waits for it (the eleventh review round, H11-3: it locked, or closed): this one stays. The
   * step aside had been carried out for nobody at the next release, and its lock screen said the wallet was opened elsewhere.
   */
  cancelStepAside(): void {
    if (!this.elsewhere) return;
    this.elsewhere = false;
    if (this.o.session.isUnlocked()) this.check();
  }

  /** A safe point: past the hold cap, the waiting lock happens here. */
  safePoint(): void {
    if (this.pendingSafePoint) this.check(true);
  }

  /** Evaluates the verdict now; locks, waits, or schedules the next look. */
  check(atSafePoint = false): void {
    this.cancel();
    if (!this.o.session.isUnlocked()) return;
    const v = lockVerdict({
      now: this.clock.now(),
      lastActivity: this.lastActivity,
      hiddenSince: this.hiddenSince,
      idleMinutes: this.o.minutes(),
      holds: this.o.session.holds(),
      elsewhere: this.elsewhere,
      pageHidden: this.pageHidden,
    });
    if (v.due && !v.heldBy && (!v.atSafePoint || atSafePoint)) return this.lock(v.due);
    this.pendingSafePoint = v.atSafePoint;
    if (v.nextCheck !== null && Number.isFinite(v.nextCheck))
      this.timer = this.clock.setTimeout(() => this.check(), Math.max(0, v.nextCheck - this.clock.now()) + 50);
  }

  private onSession(): void {
    const unlocked = this.o.session.isUnlocked();
    if (unlocked && !this.wasUnlocked) {
      this.lastActivity = this.clock.now(); // a fresh unlock starts the idle clock
      this.elsewhere = false; // and is this tab's own
      this.pageHidden = false; // a page that unlocks is here
    }
    this.wasUnlocked = unlocked;
    const holds = this.o.session.holds().length;
    const released = holds < this.holdCount; // a released hold is a safe point
    this.holdCount = holds;
    if (unlocked) this.check(released);
    else this.cancel();
  }

  private lock(trigger: LockTrigger): void {
    this.cancel();
    this.pendingSafePoint = false;
    if (!this.o.session.isUnlocked()) return;
    this.o.session.lock();
    this.o.onLock?.(trigger);
  }

  private cancel(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
