// Randomized scheduling (plan §30, swap spec §8): under a privacy policy the wallet does not fund a
// swap's escrow the moment the order is committed — it picks a time uniformly at random inside the
// policy's delay window (the lab found uniform-like delays beat immediate / exponential ones) and
// records it in the encrypted journal, so the action survives a reload and fires when the wallet is
// next unlocked and the time has passed. "Fund now" remains available, with the timing warning.
import { useEffect, useRef } from "react";
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

export const isDue = (a: ScheduledAction, now = Date.now()): boolean => !a.done && a.dueAt <= now;

export function scheduleAction(a: Omit<ScheduledAction, "id">, s: WalletSession = defaultSession): ScheduledAction {
  const action: ScheduledAction = { id: `${a.kind}:${a.orderId}`, ...a };
  s.update((j) => { j.schedule = [...j.schedule.filter((x) => x.id !== action.id), action]; });
  return action;
}

export function completeAction(id: string, error?: string, s: WalletSession = defaultSession): void {
  s.update((j) => { const a = j.schedule.find((x) => x.id === id); if (a) { a.done = !error; a.error = error; } });
}

export function pendingActions(s: WalletSession = defaultSession): ScheduledAction[] {
  return s.isUnlocked() ? s.journal().schedule.filter((a) => !a.done) : [];
}

/** Runs due actions while the wallet is unlocked (checked every `pollMs`); one attempt at a time per action. */
export function useScheduler(run: (a: ScheduledAction) => Promise<void>, pollMs = 10_000, s: WalletSession = defaultSession): void {
  const st = useSession();
  const running = useRef(new Set<string>());
  useEffect(() => {
    if (st.status !== "unlocked") return;
    const tick = async () => {
      for (const a of pendingActions(s)) {
        if (!isDue(a) || running.current.has(a.id)) continue;
        running.current.add(a.id);
        try { await run(a); completeAction(a.id, undefined, s); }
        catch (e: any) { completeAction(a.id, e?.message ?? String(e), s); }
        finally { running.current.delete(a.id); }
      }
    };
    void tick();
    const t = setInterval(tick, pollMs);
    return () => clearInterval(t);
  }, [st.status, run, pollMs, s]);
}
