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
// transfer received: it gets its Activity line. Past the pool the light client proved, it is pending — out of the balance
// — until a scan proves its leaf; one the proven leaf does not hold reads failed (audit round 2, r24).
import type { Deployment } from "../chain";
import { assetByVault } from "../assets";
import { scanNotes } from "../privateTx";
import { reconcileStaleOperations, staleReads } from "../operations/stale";
import { activityId, recordActivity, updateActivity } from "./activity";
import { noteStore } from "./notes";
import type { ScheduledAction } from "./journal";
import { kickScheduler, scheduleAction, schedulerStatus } from "./schedule";
import { session as defaultSession, type WalletSession } from "./session";

export const DISCOVERY_ID = "discovery:pool";
/** While unlocked, the next scan this long after the last. */
export const DISCOVERY_INTERVAL_MS = 10 * 60_000;
/** A received transfer's line that the proven pool contradicts (audit round 2, r24). */
export const NOT_IN_POOL =
  "not received: the pool proven at the latest finalized block does not hold this transfer — an RPC endpoint showed a note the chain does not have";
/** Activity's opening asks for a scan at most this often. */
export const DISCOVERY_MIN_GAP_MS = 60_000;
/**
 * A scan that failed while the counters are held (after a restore) is tried again this soon (audit round 2, r06): every new
 * note waits for one complete scan, and the scheduler's backoff — 10 minutes doubling to 6 hours — had refused every Protect,
 * swap and Send with change that long, the words saying "try again in a moment".
 */
export const HELD_SCAN_RETRY_MS = 60_000;

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
    let r: Awaited<ReturnType<typeof scanNotes>>;
    try {
      r = await scanNotes({ masterSeed: o.masterSeed, deployment: o.deployment, onStatus: (line) => schedulerStatus.progress(line) });
    } catch (e) {
      if (!noteStore.countersHeld() || !s.isUnlocked()) throw e; // the scheduler's backoff
      schedulerStatus.progress(`The pool could not be read (${(e as Error)?.message ?? String(e)}); looking again in a minute…`);
      scheduleAction({ kind: "discovery", orderId: "pool", dueAt: now() + HELD_SCAN_RETRY_MS }, s); // the same id: kept pending
      return;
    }
    lastRunAt = now();
    if (!s.isUnlocked()) return; // locked during the scan: the next unlock scans again
    // the operations whose own flow is gone (a reload, a closed tab): the chain moves them now (../operations/stale.ts)
    await reconcileStaleOperations(staleReads(o.deployment), now(), s).catch(() => 0);
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
    // received past the proven pool: pending, out of the balance, until a scan proves its leaf (audit round 2, r24)
    for (const n of r.pending ?? []) {
      const a = assetByVault(o.deployment, n.vaultId);
      recordActivity(
        {
          id: activityId("receive", String(n.leafIndex)),
          kind: "receive",
          asset: a?.symbol ?? "units",
          decimals: a?.decimals ?? 0,
          amount: n.amount.toString(),
          status: "pending",
          ref: n.txHash,
        },
        s,
      );
    }
    // a receive whose leaf is proven now and holds no note of this wallet: the chain does not hold that transfer — nor one still pending
    // that the pool no longer shows past its proven part (the ninth review round, 2026-11-04, D-1: a lying quorum's far leaf had stayed
    // "pending" for good once the endpoints were honest again)
    const proven = r.proven ?? null;
    const stillPending = new Set((r.pending ?? []).map((n) => n.leafIndex));
    for (const x of s.journal().activity ?? []) {
      const leaf = x.kind === "receive" && x.status !== "failed" ? Number(x.id.slice("receive:".length)) : NaN;
      if (!Number.isInteger(leaf) || noteStore.all().some((n) => n.leafIndex === leaf)) continue;
      if ((proven !== null && leaf < proven) || (x.status === "pending" && !stillPending.has(leaf)))
        updateActivity(x.id, { status: "failed", note: NOT_IN_POOL }, s);
    }
  } finally {
    schedulerStatus.finish();
  }
  // the next pass, under the same id: the scheduler keeps it pending instead of marking this one done
  scheduleAction({ kind: "discovery", orderId: "pool", dueAt: now() + DISCOVERY_INTERVAL_MS }, s);
}
