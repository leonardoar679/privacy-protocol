// Note discovery (spec v2.0 §7.2, §11.2; a V6 follow-up of 2026-10-14): the wallet finds its notes in the pool by itself.
// V6 Stage 6 unmounted the V5 "Rescan the chain for my notes" button and nothing else scanned. So a phrase restore, a
// private transfer received, or a swap refunded outside the V3–V5 screen never reached the balance; the notes were safe
// on chain, but this wallet never looked. Now a scan runs:
// - after every unlock;
// - again every DISCOVERY_INTERVAL_MS while the wallet is unlocked;
// - when Activity or Receive opens, at most once a minute;
// - as soon as a runner sees a swap refunded.
// It is a scheduled action (`discovery:pool`): the scheduler runs one action at a time, so a scan never interleaves with a
// spend, and nothing runs offline. A first launch stays request-free (spec v2.0 §10): the session that created the wallet
// on this device scans only once the wallet holds something; a restore scans at once.
// A note found that this wallet's seed did not make (no counter) and that is not a swap's refund or delivery is a private
// transfer received: it gets its Activity line.
import type { Deployment } from "../chain";
import { assetByVault } from "../assets";
import { scanNotes } from "../privateTx";
import { activityId, recordActivity } from "./activity";
import { noteStore } from "./notes";
import type { ScheduledAction } from "./journal";
import { kickScheduler, scheduleAction, schedulerStatus } from "./schedule";
import { session as defaultSession, type WalletSession } from "./session";

export const DISCOVERY_ID = "discovery:pool";
/** While unlocked, the next scan this long after the last. */
export const DISCOVERY_INTERVAL_MS = 10 * 60_000;
/** Activity's opening asks for a scan at most this often. */
export const DISCOVERY_MIN_GAP_MS = 60_000;

let lastRunAt = 0;
/** Tests: forget when the last scan ran. */
export function resetDiscoveryMemory(): void {
  lastRunAt = 0;
}

/** Plan a scan at `dueAt`, unless one is already planned no later. */
export function scheduleDiscovery(dueAt = Date.now(), s: WalletSession = defaultSession): boolean {
  if (!s.isUnlocked()) return false;
  const cur = s.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done);
  if (cur && cur.dueAt <= dueAt) return false;
  scheduleAction({ kind: "discovery", orderId: "pool", dueAt }, s);
  if (dueAt <= Date.now()) kickScheduler();
  return true;
}

/**
 * Whether the wallet may read the pool by itself: on any unlock but a first launch (spec v2.0 §10: request-free), and on
 * a first launch once the wallet holds something — a note, a line of activity, an order or an operation.
 */
export function discoveryWanted(s: WalletSession = defaultSession): boolean {
  if (!s.isUnlocked()) return false;
  if (!s.isFirstLaunch()) return true;
  const j = s.journal();
  return noteStore.all().length > 0 || (j.activity?.length ?? 0) > 0 || j.swaps.length > 0 || (j.operations?.length ?? 0) > 0;
}

/** Activity's or Receive's opening: a scan now, unless one ran within the last minute or a first launch has nothing to look for. */
export function discoverSoon(now = Date.now(), s: WalletSession = defaultSession): boolean {
  if (now - lastRunAt < DISCOVERY_MIN_GAP_MS || !discoveryWanted(s)) return false;
  return scheduleDiscovery(now, s);
}

/** The scheduler's runner for `discovery:pool`: one scan, the transfers received into Activity, the next scan planned. */
export async function runDiscovery(
  a: ScheduledAction,
  o: { masterSeed: Uint8Array; deployment: Deployment | null; session?: WalletSession; now?: () => number },
): Promise<void> {
  const s = o.session ?? defaultSession;
  const now = o.now ?? Date.now;
  if (!o.deployment) return; // no pool configured: nothing to look in
  schedulerStatus.start(a.id, "Looking for your notes in the pool…");
  try {
    const r = await scanNotes({ masterSeed: o.masterSeed, deployment: o.deployment, onStatus: (line) => schedulerStatus.progress(line) });
    lastRunAt = now();
    if (!s.isUnlocked()) return; // locked during the scan: the next unlock scans again
    for (const n of r.received) {
      const a = assetByVault(o.deployment, n.vaultId);
      recordActivity(
        {
          id: activityId("receive", String(n.leafIndex)),
          kind: "receive",
          asset: a?.symbol ?? "units",
          decimals: a?.decimals ?? 0,
          amount: n.amount.toString(),
          status: "completed",
          ref: n.txHash,
        },
        s,
      );
    }
  } finally {
    schedulerStatus.finish();
  }
  // the next pass, under the same id: the scheduler keeps it pending instead of marking this one done
  scheduleAction({ kind: "discovery", orderId: "pool", dueAt: now() + DISCOVERY_INTERVAL_MS }, s);
}
