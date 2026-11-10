// Note discovery (spec v2.0 §7.2, §11.2; a V6 follow-up of 2026-10-14): the wallet finds its notes in the pool by itself.
// V6 Stage 6 unmounted the V5 "Rescan the chain for my notes" button and nothing else scanned. So a phrase restore, a
// private transfer received, or a swap refunded outside the V3–V5 screen never reached the balance; the notes were safe
// on chain, but this wallet never looked. Now a scan runs:
// - after every unlock;
// - again every DISCOVERY_INTERVAL_MS while the wallet is unlocked;
// - when Activity or Receive opens, at most once a minute;
// - as soon as a runner sees a swap refunded — unless a scan failing in a row keeps its backoff (`scheduleDiscovery`);
// - when a flow needs a note's counter while the counters wait for a scan: at once, or at the end of the minute after the last attempt's
//   start (a demand: `demandScan`).
// A scan that fails while the counters are held, or while a deposit waits on it, is tried again sooner than the scheduler's backoff, but
// less often each time (`heldRetryMs`, its own count `heldFailures`; the twelfth review round, W6 §5): an unlock, a demand or a deposit's own
// scan (`scanForDeposit`) starts the count again; a success, or a failure handed to the scheduler's backoff, ends it; a scan failing otherwise
// keeps the scheduler's backoff. A scan that releases the counters wakes the campaign steps waiting on it.
// It is a scheduled action (`discovery:pool`): the scheduler runs one action at a time, so a scan never interleaves with a
// spend, and nothing runs offline. A first launch stays request-free (spec v2.0 §10): the session that created the wallet
// on this device scans only once the wallet holds something; a restore scans at once.
// A note found that this wallet's seed did not make (no counter) and that is not a swap's refund or delivery is a private
// transfer received: it gets its Activity line. Past the pool the light client proved, it is pending — out of the balance
// — until a scan proves its leaf; one the proven leaf does not hold reads failed (audit round 2, r24).
import type { Deployment } from "../chain";
import { assetByVault } from "../assets";
import { PAST_POOL_GRACE_MS, scanNotes } from "../privateTx";
import { awaitedDeposits, depositAwaited, reconcileStaleOperations, staleReads } from "../operations/stale";
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
/** Activity's opening, and a demand, ask for a scan at most this often after the last attempt. */
export const DISCOVERY_MIN_GAP_MS = 60_000;
/**
 * A deposit the connected wallet reported nothing for (`deposit_unconfirmed`; the eleventh review round, F11-10) is looked for in the pool
 * this soon — time for it to be mined — rather than at the next interval, and then each minute while it is young and its reads succeed — a
 * failed read is tried again after 1, 2, 4, then 8 minutes (heldRetryMs) — (operations/stale.ts DEPOSIT_RESCAN_WINDOW_MS): the scan records
 * its note from the endpoints' agreed view, the record awaiting it (privateTx.ts scanNotes
 * `awaited`: never held for finality, which takes half an hour on mainnet), and its stale pass completes the Protect.
 */
export const DEPOSIT_SCAN_DELAY_MS = 30_000;
/**
 * A scan that failed while the counters are held (after an unlock or a restore) is first tried again this soon (audit round 2, r06), then less often
 * (`heldRetryMs`): every new note waits for one complete scan, and the scheduler's backoff — 10 minutes doubling to 6 hours — had refused
 * every Protect, swap and Send with change that long, the words saying "try again in a moment".
 */
export const HELD_SCAN_RETRY_MS = 60_000;
/**
 * The retry after the `n`th such failure in a row (the twelfth review round, W6 §5): 1, 2, 4, 8 minutes, then the interval a working wallet
 * scans at. Each attempt reads the pool's whole history from every endpoint: at a minute for good, a persistent failure had cost the
 * endpoints sixty whole-history reads an hour for as long as the wallet stayed unlocked.
 */
export const heldRetryMs = (n: number): number => Math.min(HELD_SCAN_RETRY_MS * 2 ** Math.max(0, n - 1), DISCOVERY_INTERVAL_MS);

/** When the last scan attempt started, failed or not (a demand is spaced from it). */
let lastAttemptAt = 0;
/**
 * When the last scan attempt ended, failed or not: Activity's opening waits a minute after the later of the two (ZM's critique: from the start
 * alone, a scan longer than the minute — a light client's on mainnet — had been read again as soon as it ended).
 */
let lastAttemptEndedAt = 0;
/** Tests: forget when the last scan ran. */
export function resetDiscoveryMemory(): void {
  lastAttemptAt = 0;
  lastAttemptEndedAt = 0;
}

/**
 * Plan a scan at `dueAt`, unless one is already planned no later — or one failing in a row keeps its backoff (the twelfth review round, W6
 * §5): a runner seeing a refund at every tick had brought the scan back to now each time.
 */
export function scheduleDiscovery(dueAt = Date.now(), s: WalletSession = defaultSession): boolean {
  if (!s.isUnlocked()) return false;
  const cur = s.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done);
  if (cur && (cur.dueAt <= dueAt || (cur.heldFailures ?? 0) > 0)) return false;
  scheduleAction({ kind: "discovery", orderId: "pool", dueAt }, s);
  if (dueAt <= Date.now()) kickScheduler();
  return true;
}

/** When the scan is next attempted (its action's due time, past any backoff), or null when none is planned. */
export function nextScanAt(s: WalletSession = defaultSession): number | null {
  const a = s.journal().schedule.find((x) => x.id === DISCOVERY_ID && !x.done);
  return a ? Math.max(a.dueAt, a.nextAttemptAt ?? 0) : null;
}

/** The unlock's scan: at once, the count of failures in a row started again (the twelfth review round, W6 §5). */
export function discoverAtUnlock(now = Date.now(), s: WalletSession = defaultSession): boolean {
  if (!s.isUnlocked()) return false;
  scheduleAction({ kind: "discovery", orderId: "pool", dueAt: now }, s);
  kickScheduler();
  return true;
}

/**
 * A flow that needs a note's counter while the counters wait for a scan — a Protect's confirmation, a Send, a swap's commit or funding —
 * asks for the scan at once, past its backoff, the count of failures started again (the twelfth review round, W6 §5) — within
 * DISCOVERY_MIN_GAP_MS of an attempt's start, at that minute's end (ZL's critique: refused there, a flow's two-minute wait had ended before
 * the backed-off scan came), never later than it was already planned. Under the unlock's hold the flow then waits for it (notes.ts
 * `untilScanned`, up to SCAN_WAIT_MS); under a restore's hold alone it is refused at once (`notes_loading`) while the scan it asked for runs.
 * The screens demand, before their flow; the runners never do. False when nothing was asked.
 */
export function demandScan(now = Date.now(), s: WalletSession = defaultSession): boolean {
  if (!s.isUnlocked() || !noteStore.countersHeld() || !discoveryWanted(s)) return false;
  const cur = s.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done);
  const spaced = Math.max(now, lastAttemptAt + DISCOVERY_MIN_GAP_MS);
  const dueAt = cur && cur.nextAttemptAt === undefined && cur.dueAt < spaced ? cur.dueAt : spaced;
  scheduleAction({ kind: "discovery", orderId: "pool", dueAt }, s);
  if (dueAt <= now) kickScheduler();
  return true;
}

/**
 * The campaign steps waiting for the scan the counters waited on (campaignRunner.ts: no commit while held, the tick at the scan's next
 * attempt) tick a second after it released them (the twelfth review round, ZL's critique: freed sooner by a demand or an unlock, a step had
 * waited out the backoff's plan, up to ten minutes). A tick with nothing to do plans its own next one again.
 */
function wakeCampaigns(now: number, s: WalletSession): void {
  let woken = false;
  s.update((j) => {
    for (const a of j.schedule) {
      if (a.kind !== "campaign-tick" || a.done || a.dueAt <= now + 1000) continue;
      a.dueAt = now + 1000;
      woken = true;
    }
  });
  if (woken) kickScheduler();
}

/**
 * The scan a deposit its wallet reported nothing for needs, DEPOSIT_SCAN_DELAY_MS on (the eleventh review round, F11-10): planned past the
 * scheduler's backoff — a scan whose last read failed waits up to hours there, and the deposit's had been silently not planned (the
 * critique of F11-10). False while locked.
 */
export function scanForDeposit(now = Date.now(), s: WalletSession = defaultSession): boolean {
  if (!s.isUnlocked()) return false;
  const dueAt = now + DEPOSIT_SCAN_DELAY_MS;
  if (!s.journal().schedule.some((a) => a.id === DISCOVERY_ID && !a.done)) {
    scheduleAction({ kind: "discovery", orderId: "pool", dueAt }, s);
    return true;
  }
  s.update((j) => {
    const a = j.schedule.find((x) => x.id === DISCOVERY_ID && !x.done);
    if (!a) return;
    a.nextAttemptAt = undefined;
    a.heldFailures = undefined; // the deposit's own retries start at a minute (ZK's critique: a count from before had made the first eight)
    a.dueAt = Math.min(a.dueAt, dueAt);
  });
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

/**
 * Activity's or Receive's opening: a scan now, unless one was attempted within the last minute or a first launch has nothing to look for. A
 * scan the counters wait on, failing in a row, is brought forward too, its count kept: one more failure waits longer (the twelfth review
 * round, W6 §5). A scan in the scheduler's own backoff stays in it (ZK's critique: each opening had read the whole history again).
 */
export function discoverSoon(now = Date.now(), s: WalletSession = defaultSession): boolean {
  if (now - Math.max(lastAttemptAt, lastAttemptEndedAt) < DISCOVERY_MIN_GAP_MS || !discoveryWanted(s)) return false;
  const cur = s.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done);
  if (!cur || (cur.heldFailures ?? 0) === 0) return scheduleDiscovery(now, s);
  if (cur.dueAt <= now) return false;
  s.update((j) => {
    const a = j.schedule.find((x) => x.id === DISCOVERY_ID && !x.done);
    if (a) a.dueAt = Math.min(a.dueAt, now);
  });
  kickScheduler();
  return true;
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
    lastAttemptAt = now();
    const heldBefore = noteStore.countersHeld();
    try {
      r = await scanNotes({
        masterSeed: o.masterSeed,
        deployment: o.deployment,
        awaited: awaitedDeposits(s),
        onStatus: (line) => schedulerStatus.progress(line),
      });
    } catch (e) {
      // the scheduler's backoff — but not while the counters are held, nor while a deposit its wallet reported nothing for waits on this
      // scan (the critique of F11-10): read again sooner, less often each time (heldRetryMs), the failures in a row counted on the action as
      // the journal has it now — an unlock or a demand during the attempt started the count again (ZK's critique: the attempt's own copy had
      // written the old count back)
      const cur = s.isUnlocked() ? s.journal().schedule.find((x) => x.id === a.id && !x.done) : undefined;
      if ((!noteStore.countersHeld() && !depositAwaited(s, now())) || !s.isUnlocked()) {
        // handed to the scheduler's own backoff, which starts at its own count: never the held one's (ZK's critique)
        if (cur?.heldFailures)
          s.update((j) => {
            const x = j.schedule.find((y) => y.id === a.id && !y.done);
            if (x) x.heldFailures = undefined;
          });
        throw e;
      }
      const failures = (cur?.heldFailures ?? 0) + 1;
      const minutes = Math.round(heldRetryMs(failures) / 60_000);
      schedulerStatus.progress(
        `The pool could not be read (${(e as Error)?.message ?? String(e)}); looking again in ${minutes} minute${minutes === 1 ? "" : "s"}…`,
      );
      scheduleAction({ kind: "discovery", orderId: "pool", dueAt: now() + heldRetryMs(failures), heldFailures: failures }, s); // the same id: kept pending
      return;
    } finally {
      lastAttemptEndedAt = now();
    }
    if (!s.isUnlocked()) return; // locked during the scan: the next unlock scans again
    if (heldBefore && !noteStore.countersHeld()) wakeCampaigns(now(), s);
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
          note: undefined, // a line once failed while the endpoints lagged says so no more (the tenth review round, B10-3)
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
    const viewLeaves = r.leaves ?? null;
    for (const x of s.journal().activity ?? []) {
      const leaf = x.kind === "receive" && x.status !== "failed" ? Number(x.id.slice("receive:".length)) : NaN;
      if (!Number.isInteger(leaf) || noteStore.all().some((n) => n.leafIndex === leaf)) continue;
      // a pending line whose leaf this scan's view does not reach is the endpoints' lag, not a lie (the tenth review round, B10-3): it fails
      // once a view holds its leaf without the note, or after the grace a recorded note gets
      if (x.status === "pending" && viewLeaves !== null && leaf >= viewLeaves && now() - x.at <= PAST_POOL_GRACE_MS) continue;
      if ((proven !== null && leaf < proven) || (x.status === "pending" && !stillPending.has(leaf)))
        updateActivity(x.id, { status: "failed", note: NOT_IN_POOL }, s);
    }
  } finally {
    schedulerStatus.finish();
  }
  // the next pass, under the same id: the scheduler keeps it pending instead of marking this one done — in a minute while a deposit its
  // wallet reported nothing for is young (the critique of F11-10), else at the interval
  scheduleAction({ kind: "discovery", orderId: "pool", dueAt: now() + (depositAwaited(s, now()) ? DISCOVERY_MIN_GAP_MS : DISCOVERY_INTERVAL_MS) }, s);
}
