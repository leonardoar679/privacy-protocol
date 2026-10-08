// Randomized scheduling (plan §30, swap spec §8): under a privacy policy the wallet does not fund a
// swap's escrow the moment the order is committed — it picks a time uniformly at random inside the
// policy's delay window (the lab found uniform-like delays beat immediate / exponential ones) and
// records it in the encrypted journal, so the action survives a reload and fires when the wallet is
// next unlocked and the time has passed. "Fund now" remains available, with the timing warning.
// V2 (Stage 4): the runner lives at the App level (any tab, while unlocked), runs one action at a time
// (two due actions could otherwise spend the same notes), retries a failed action with a growing delay
// (10 min, doubling, at most 6 h) instead of every poll, and an abandoned order's action is removed.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ScheduledAction } from "./journal";
import { session as defaultSession, useSession, type WalletSession } from "./session";

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

export function scheduleAction(a: Omit<ScheduledAction, "id">, s: WalletSession = defaultSession): ScheduledAction {
  const action: ScheduledAction = { id: `${a.kind}:${a.orderId}`, ...a };
  s.update((j) => { j.schedule = [...j.schedule.filter((x) => x.id !== action.id), action]; });
  return action;
}

/** Done (no error), or failed: the error is kept, the attempt counted and the next one scheduled with backoff. */
export function completeAction(id: string, error?: string, s: WalletSession = defaultSession, now = Date.now()): void {
  s.update((j) => {
    const a = j.schedule.find((x) => x.id === id);
    if (!a) return;
    if (!error) { a.done = true; a.error = undefined; a.nextAttemptAt = undefined; return; }
    a.done = false; a.error = error; a.attempts = (a.attempts ?? 0) + 1; a.nextAttemptAt = now + backoffMs(a.attempts);
  });
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
export const useSchedulerStatus = (): SchedulerStatus => useSyncExternalStore((l) => schedulerStatus.subscribe(l), () => schedulerStatus.get());

/**
 * Runs due actions while the wallet is unlocked (checked every `pollMs`), one at a time: a tick that
 * finds the runner busy does nothing. `run` throws to fail an action (recorded with backoff) and may
 * cancel it itself when it no longer applies.
 */
export function useScheduler(run: (a: ScheduledAction) => Promise<void>, pollMs = 10_000, s: WalletSession = defaultSession): void {
  const st = useSession();
  const busy = useRef(false);
  useEffect(() => {
    if (st.status !== "unlocked") return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        for (const a of pendingActions(s)) {
          if (!isDue(a) || !s.isUnlocked()) continue;
          // done unless the run re-scheduled the same action for later (a campaign tick plans its own next tick under its id)
          try { await run(a); const again = pendingActions(s).find((x) => x.id === a.id); if (again && again.dueAt === a.dueAt) completeAction(a.id, undefined, s); }
          catch (e: any) { const message = e?.message ?? String(e); completeAction(a.id, message, s); schedulerStatus.failed(a.id, message); }
        }
      } finally {
        busy.current = false;
      }
    };
    void tick();
    const t = setInterval(tick, pollMs);
    return () => clearInterval(t);
  }, [st.status, run, pollMs, s]);
}
