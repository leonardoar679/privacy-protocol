// Randomized scheduling (plan §30, swap spec §8): under a privacy policy the wallet does not fund a
// swap's escrow the moment the order is committed — it picks a time uniformly at random inside the
// policy's delay window (the lab found uniform-like delays beat immediate / exponential ones) and
// records it in the encrypted journal, so the action survives a reload and fires when the wallet is
// next unlocked and the time has passed. "Fund now" remains available, with the timing warning.
// V2 (Stage 4): the runner lives at the App level (any tab, while unlocked), runs one action at a time
// (two due actions could otherwise spend the same notes), retries a failed action with a growing delay
// (10 min, doubling, at most 6 h) instead of every poll, and an abandoned order's action is removed.
import type { ScheduledAction } from "./journal";
import { session as defaultSession, type WalletSession } from "./session";

/** A uniform draw inside [min, max] seconds from `now` (ms), from the CSPRNG. */
export function sampleDueAt(window: [number, number], now = Date.now(), uniform = cryptoUniform): number {
  const [min, max] = window;
  if (!(min >= 0) || !(max >= min)) throw new Error("bad delay window");
  return now + Math.round((min + uniform() * (max - min)) * 1000);
}

function cryptoUniform(): number {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return u[0] / 2 ** 32;
}

export const BACKOFF_BASE_MS = 10 * 60_000;
export const BACKOFF_MAX_MS = 6 * 3600_000;
/** The wait before attempt `attempts + 1` after `attempts` failures: 10 min, 20, 40 … capped at 6 h. */
export const backoffMs = (attempts: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

export const isDue = (a: ScheduledAction, now = Date.now()): boolean => !a.done && a.dueAt <= now && (a.nextAttemptAt ?? 0) <= now;

/** V6 Stage 11: an action due now wakes the scheduler at once instead of at its next poll (the one-confirmation swap). */
const kickListeners = new Set<() => void>();
export function kickScheduler(): void {
  for (const l of kickListeners) l();
}
export function onSchedulerKick(listener: () => void): () => void {
  kickListeners.add(listener);
  return () => kickListeners.delete(listener);
}

export function scheduleAction(a: Omit<ScheduledAction, "id">, s: WalletSession = defaultSession): ScheduledAction {
  const action: ScheduledAction = { id: `${a.kind}:${a.orderId}`, ...a };
  s.update((j) => { j.schedule = [...j.schedule.filter((x) => x.id !== action.id), action]; });
  return action;
}

/**
 * An action its runner plans again behind the scan the counters wait on (the twelfth review round, 12b2d): marked `waitsOnScan`
 * (discovery.ts wakeAfterScan wakes it), its time the scan's next attempt and a second, no next attempt of its backoff, its last failure kept
 * on record and its count with it — nothing was attempted (ZU's critique: planned afresh, the failure the screens show had gone and its
 * backoff begun again). A new object in the same place, never the one the scheduler ran: after the run, useScheduler (apps/web hooks) compares
 * the journal's action under that id with the object it ran — a new object leaves the old time on the scheduler's copy, while one moved in
 * place is that copy, always equal, and every wait had been marked done and never run again (ZV's critique). A missing action is planned.
 */
export function waitBehindScan(a: Pick<ScheduledAction, "id" | "kind" | "orderId">, dueAt: number, s: WalletSession = defaultSession): void {
  s.update((j) => {
    const i = j.schedule.findIndex((y) => y.id === a.id && !y.done);
    if (i >= 0) { j.schedule[i] = { ...j.schedule[i], dueAt, nextAttemptAt: undefined, waitsOnScan: true }; return; }
    j.schedule.push({ id: a.id, kind: a.kind, orderId: a.orderId, dueAt, waitsOnScan: true });
  });
}

/**
 * Done (no error), or failed: the error is kept with the catalog's code when the thrown error had one (`code`), the attempt
 * counted and the next one scheduled with backoff.
 */
export function completeAction(id: string, error?: string, s: WalletSession = defaultSession, now = Date.now(), code?: string): void {
  s.update((j) => {
    const a = j.schedule.find((x) => x.id === id);
    if (!a) return;
    if (!error) { a.done = true; a.error = undefined; a.errorCode = undefined; a.nextAttemptAt = undefined; return; }
    a.done = false; a.error = error; a.errorCode = code; a.attempts = (a.attempts ?? 0) + 1; a.nextAttemptAt = now + backoffMs(a.attempts);
    a.waitsOnScan = undefined; // an attempt answered: it waits on its backoff, no longer on the scan
  });
}

/**
 * The scheduler's last failure for an operation (a V7 follow-up, audit gap 59): the open action of the order or campaign id
 * whose last run failed — the journal's own entry, so a screen's snapshot is stable until it changes —, or null. The
 * operation's detail names it with the next attempt, and offers the attempt now (`retryNow`) — an action waiting behind the scan the
 * counters wait on (`waitsOnScan`, 12b2d) with its next attempt once the pool is read, and no attempt now.
 */
export function failedAttempt(orderId: string, s: WalletSession = defaultSession): ScheduledAction | null {
  if (!s.isUnlocked()) return null;
  const failed = s.journal().schedule.filter((a) => a.orderId === orderId && !a.done && a.error);
  if (!failed.length) return null;
  return failed.reduce((latest, a) => ((a.nextAttemptAt ?? 0) > (latest.nextAttemptAt ?? 0) ? a : latest));
}

/**
 * The user's "Try again now": the action's backoff is dropped, it is due at once and the scheduler woken. The runners
 * reconcile before they send (never a second funding before its fate is known), so the tap is safe; the failure stays on
 * record until the next attempt answers. False when no such action exists.
 */
export function retryNow(id: string, s: WalletSession = defaultSession, now = Date.now()): boolean {
  let found = false;
  s.update((j) => {
    const a = j.schedule.find((x) => x.id === id && !x.done);
    if (!a) return;
    found = true;
    a.nextAttemptAt = undefined;
    a.dueAt = Math.min(a.dueAt, now);
  });
  if (found) kickScheduler();
  return found;
}

/** Remove an action for good (an abandoned order, a cancelled housekeeping run): it is never retried. */
export function cancelAction(id: string, s: WalletSession = defaultSession): void {
  s.update((j) => { j.schedule = j.schedule.filter((x) => x.id !== id); });
}

export function pendingActions(s: WalletSession = defaultSession): ScheduledAction[] {
  return s.isUnlocked() ? s.journal().schedule.filter((a) => !a.done) : [];
}

/** What the runner is doing now, for the screens (Home, Activity): the action and its progress line, and the last failure. */
export interface SchedulerStatus { running: { id: string; line: string } | null; lastError: { id: string; message: string; at: number } | null }
class SchedulerStatusStore {
  private st: SchedulerStatus = { running: null, lastError: null };
  private listeners = new Set<() => void>();
  get(): SchedulerStatus { return this.st; }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private set(st: SchedulerStatus): void { this.st = st; for (const l of this.listeners) l(); }
  start(id: string, line: string): void { this.set({ ...this.st, running: { id, line } }); }
  progress(line: string): void { if (this.st.running) this.set({ ...this.st, running: { ...this.st.running, line } }); }
  finish(): void { this.set({ ...this.st, running: null }); }
  failed(id: string, message: string): void { this.set({ running: null, lastError: { id, message, at: Date.now() } }); }
  reset(): void { this.set({ running: null, lastError: null }); }
}
export const schedulerStatus = new SchedulerStatusStore();

