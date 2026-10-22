// The order runner (spec v2.0 §7.6; doc §26, §31; the owner's decision of 2026-10-13: one confirmation): after the Review a
// swap order is committed and this runner takes it the rest of the way — the private withdrawal that funds its one-time
// escrow (at once; when the user asked to delay for more privacy, at once from older notes only, or else at a random time
// in 1–24 h — an order whose older notes no longer cover it is stopped unfunded, never paid from younger ones), the hard quote prepared,
// checked and signed by this wallet while its minimum is at least the one the user approved, the hand-over to the
// executor in the same tick (the signature never waits in memory across ticks), then the tracking until it settles. A
// worse minimum pauses the order (QUOTE_EXPIRED, `minimum_moved`) for the user's choice — accept the new minimum or
// return the funds; nothing is ever signed at a lower minimum without it, and an accepted minimum signs the very call it
// was read from while that call stays valid (audit gap 43: a fresh quote in a trending market would only move again). Every tick first RECONCILES from what the wallet
// can observe — the journal, the escrow's balance, the executor's job by orderId — so a reload or a crash between a send
// and its journal entry never funds or hands over twice; a failure before anything was sent is thrown to the scheduler's
// backoff, one after a send started pauses the order until the escrow or the executor says what happened. The ticks run
// from the App-level scheduler on any tab while the wallet is unlocked (`order-tick:<orderId>`); a campaign's tranches
// are never run here (wallet/campaignRunner.ts runs them). V6 Stage 12 (spec v2.0 §11.2): a same-chain swap into the
// protected balance also has a shield job — registered before the hand-over, asked again while the order is tracked (and
// registered again if the executor forgot it), and once it reports a shield the delivered note is looked for in the pool.
import type { Hex } from "viem";
import type { Deployment } from "../chain";
import { ProviderCallUnverified, type MinimumMoved } from "../providerCall";
import { trackOrder, type Tracked } from "../orderTracker";
import { RelayerRefusal, relayerShieldRegister, relayerShieldStatus, relayerSwapStatus, type ShieldJob, type SwapJob } from "../relayer";
import {
  commitOrder,
  handOverSigned,
  prepareAndSign,
  resumeOrder,
  returnOrderToBalance,
  shieldJobView,
  type CommitInput,
  type Committed,
  type Signed,
} from "../swapExecute";
import { shieldJobRequest } from "../shieldReceiver";
import { recoverShieldDelivery } from "../privateTx";
import { abandonSwap, fundEscrow, fundingFate, fundingReads, FUNDING_MARGIN_MS, isOpenSwap, patchSwap, windowEndOf, type FundingFate } from "../swapFunding";
import type { Prepared, ServiceOrder } from "../swapService";
import { escrowBalance } from "../orderTracker";
import { syncSwapRecord } from "../operations/swapRecords";
import type { ScheduledAction, StoredSwap } from "./journal";
import { cancelAction, kickScheduler, sampleDueAt, scheduleAction, schedulerStatus } from "./schedule";
import { scheduleDiscovery } from "./discovery";
import { session as defaultSession, type WalletSession } from "./session";
import { settings as defaultSettings, type Settings } from "./settings";

/** The tracking cadence once an order is handed over. */
export const ORDER_TRACK_MS = 15_000;
/** "Delay for more privacy" (spec v2.0 §14.1): when no older notes cover the order, the funding at a random time in 1–24 h. */
export const DELAY_FOR_PRIVACY: [number, number] = [3600, 24 * 3600];
/** The execute window of an order funded at once (the plan's 1800 s): the escrow refunds after it, unexecuted. */
export const ONE_CONFIRM_EXECUTE_WINDOW_SECONDS = 1800;
/** Audit gap 43: an accepted minimum's call is signed only with at least this long left before its deadline; else a fresh quote. */
export const ACCEPTED_CALL_MARGIN_MS = 120_000;
/** A withdrawal's status line once its submission started: after it, a failure's outcome is unknown (the reconcile boundary). */
export const SENT_LINE = /handing it to the relayer|submitting through the connected wallet|Waiting for the transaction/i;
const TERMINAL_TRACK = ["COMPLETED", "REFUNDED", "CANCELLED", "EXPIRED"];
const TERMINAL_JOB = ["completed", "refunded"];

/** Everything the runner reads or moves, behind one interface: the wallet's modules by default, fakes in the tests. */
export interface OrderIo {
  fund(stored: StoredSwap, onStatus: (line: string) => void): Promise<{ txHash: string }>;
  /** what became of the order's journaled funding (swapFunding.ts `fundingFate`); absent: unknown, so nothing is sent */
  fundingFate?(stored: StoredSwap): Promise<FundingFate>;
  escrowBalance(stored: StoredSwap): Promise<bigint | null>;
  /** `reuse`: the call whose moved minimum the user accepted, checked again and signed instead of a fresh quote */
  sign(stored: StoredSwap, reuse?: Prepared): Promise<Signed | { moved: MinimumMoved; prepared?: Prepared }>;
  handOver(stored: StoredSwap, signed: Signed): Promise<{ job?: SwapJob }>;
  /** the executor's job for this order, if it has one (keyed by orderId) */
  job(stored: StoredSwap): Promise<SwapJob | null>;
  track(stored: StoredSwap): Promise<{ tracked: Tracked; job: SwapJob | null }>;
  refund(stored: StoredSwap): Promise<SwapJob>;
  /** V6 Stage 12: the executor's shield job of a same-chain swap into the protected balance (null: it knows none) */
  shieldStatus(stored: StoredSwap): Promise<ShieldJob | null>;
  registerShield(stored: StoredSwap): Promise<ShieldJob>;
  /** the delivered note(s) looked for in the pool and journaled on the receipt; how many were found */
  recoverShield(stored: StoredSwap): Promise<number>;
}

export interface OrderDeps {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  session?: WalletSession;
  io?: OrderIo;
  now?: () => number;
  settings?: () => Settings;
}

/** The service forgets orders at a restart: the runner keeps the ones it saw and rebuilds the others from the journal. */
const orders = new Map<string, ServiceOrder>();
/** Audit gap 43: the call behind a `minimum_moved` pause, with its minimum — signed if the user accepts that minimum in time. */
const movedCalls = new Map<string, { prepared: Prepared; minOut: bigint }>();
/** V6 Stage 15 (spec v2.0 §8): commit → hand-over is a critical section — the auto-lock waits for it (at most 30 minutes). */
const handOverHolds = new Map<string, () => void>();
function holdUntilHandedOver(orderId: string, s: WalletSession, now: number): void {
  const k = orderId.toLowerCase();
  if (!handOverHolds.has(k)) handOverHolds.set(k, s.hold("hand-over", now));
}
function releaseHandOver(orderId: string): void {
  const k = orderId.toLowerCase();
  handOverHolds.get(k)?.();
  handOverHolds.delete(k);
}
/** Tests, and every lock: forget what the runner keeps in memory (a lock already ended the holds). */
export function resetOrderRunnerMemory(): void {
  orders.clear();
  movedCalls.clear();
  handOverHolds.clear();
}
// V6 Stages 15–16 (spec v2.0 §8, §19): a lock forgets this memory. The hook is registered when this module loads, so
// nothing has to load the module just to wipe it (the first route stays light).
defaultSession.onLock(resetOrderRunnerMemory);

export function orderIo(d: { masterSeed: Uint8Array; deployment: Deployment | null; session: WalletSession; submission: Settings["submission"] }): OrderIo {
  const relayerUrl = d.submission.kind === "relayer" ? d.submission.url : null;
  const orderFor = async (stored: StoredSwap): Promise<ServiceOrder> => {
    const hit = orders.get(stored.orderId.toLowerCase());
    if (hit) return hit;
    const order = await resumeOrder(d.deployment, stored, d.session);
    orders.set(stored.orderId.toLowerCase(), order);
    return order;
  };
  return {
    fund: (stored, onStatus) => fundEscrow({ masterSeed: d.masterSeed, deployment: d.deployment, stored, session: d.session, onStatus, relayerUrl }),
    fundingFate: async (stored) => (d.deployment && stored.fundingAttempt ? fundingFate(stored.fundingAttempt, fundingReads(d.deployment)) : "unknown"),
    escrowBalance: async (stored) => {
      if (!d.deployment) return null;
      const token = (stored.request as { from?: { asset?: string } })?.from?.asset;
      return escrowBalance(d.deployment, stored.endpoint as Hex, token && token !== "native" ? (token as Hex) : null).catch(() => null);
    },
    sign: async (stored, reuse) =>
      prepareAndSign({
        masterSeed: d.masterSeed,
        deployment: d.deployment,
        session: d.session,
        stored,
        order: await orderFor(stored),
        submission: d.submission,
        ...(reuse ? { reuse } : {}),
        onStatus: (l) => schedulerStatus.progress(l),
      }),
    handOver: async (stored, signed) =>
      handOverSigned({ deployment: d.deployment, session: d.session, stored, order: await orderFor(stored), signed, submission: d.submission }),
    job: (stored) => (relayerUrl ? relayerSwapStatus(relayerUrl, stored.orderId).catch(() => null) : Promise.resolve(null)),
    track: (stored) => trackOrder(stored, { deployment: d.deployment, relayerUrl, session: d.session }),
    refund: (stored) => returnOrderToBalance({ deployment: d.deployment, session: d.session, stored, submission: d.submission }),
    shieldStatus: (stored) =>
      relayerUrl && stored.shield
        ? relayerShieldStatus(relayerUrl, stored.shield.params.receiptId).catch((e) => {
            if (e instanceof RelayerRefusal && e.status === 404) return null;
            throw e;
          })
        : Promise.resolve(null),
    registerShield: async (stored) => {
      if (!relayerUrl) throw new Error("a swap into the protected balance needs a relayer to shield its delivery");
      return relayerShieldRegister(relayerUrl, shieldJobRequest(stored));
    },
    recoverShield: async (stored) =>
      d.deployment && stored.shield
        ? (await recoverShieldDelivery({ masterSeed: d.masterSeed, deployment: d.deployment, orderId: stored.orderId, shield: stored.shield })).length
        : 0,
  };
}

/**
 * V6 Stage 12: the shield job's last state journaled — registered again when the executor does not know it (a restart
 * without its journal) — and, once it reports a shield the journal has no note for, the delivered note looked for in the
 * pool. A failed read changes nothing: the next tick asks again.
 */
async function refreshShield(orderId: string, stored: StoredSwap, io: OrderIo, s: WalletSession, now: number): Promise<StoredSwap> {
  try {
    const job = (await io.shieldStatus(stored)) ?? (await io.registerShield(stored));
    const sh = journaled(orderId, s)?.shield ?? stored.shield!;
    patchSwap(orderId, { shield: { ...sh, registeredAt: sh.registeredAt ?? now, job: shieldJobView(job, now) } }, s);
    const reported = job.shields?.filter((x) => x.leafIndex !== undefined).length ?? 0;
    if (reported > (sh.leaves?.length ?? 0)) await io.recoverShield(journaled(orderId, s) ?? stored);
  } catch {
    // the executor or the pool could not be read: asked again at the next tick
  }
  return journaled(orderId, s) ?? stored;
}

const actionId = (orderId: string) => `order-tick:${orderId}`;
const journaled = (orderId: string, s: WalletSession): StoredSwap | undefined =>
  s.isUnlocked() ? s.journal().swaps.find((x) => x.orderId.toLowerCase() === orderId.toLowerCase()) : undefined;

/** Plan the order's next tick (re-scheduling replaces it) and wake the scheduler when it is due now. */
function tickAt(orderId: string, dueAt: number, s: WalletSession, now: number): void {
  scheduleAction({ kind: "order-tick", orderId, dueAt }, s);
  if (dueAt <= now) kickScheduler();
}

/**
 * The one confirmation (spec v2.0 §7.6): commit the order with the minimum the user approved, journal that this runner
 * runs it, and plan its first tick — now, or for more privacy (`delay`, §14.1) now from the older notes the Review found
 * (`maxTiming`, from `olderFunding`), else at a random time in 1–24 h. No `fund-escrow` action.
 */
export async function confirmOrder(i: Omit<CommitInput, "schedule"> & { delay?: boolean; maxTiming?: number; rng?: () => number }): Promise<Committed> {
  const s = i.session ?? defaultSession;
  const now = i.now ?? Date.now();
  const maxTiming = i.delay ? i.maxTiming : undefined;
  const delayUntil = i.delay && maxTiming === undefined ? sampleDueAt(DELAY_FOR_PRIVACY, now, i.rng) : undefined;
  const request = {
    ...i.request,
    executeWindowSeconds: i.request.executeWindowSeconds ?? (delayUntil !== undefined ? undefined : ONE_CONFIRM_EXECUTE_WINDOW_SECONDS),
  };
  const committed = await commitOrder({ ...i, request, schedule: null });
  orders.set(committed.order.orderId.toLowerCase(), committed.order);
  patchSwap(
    committed.stored.orderId,
    { runner: { confirmedAt: now, ...(delayUntil !== undefined ? { delayUntil } : {}), ...(maxTiming !== undefined ? { maxTiming } : {}) } },
    s,
  );
  const stored = journaled(committed.stored.orderId, s) ?? committed.stored;
  syncSwapRecord(stored, null, null, now);
  if (delayUntil === undefined) holdUntilHandedOver(stored.orderId, s, now); // a privacy delay holds nothing
  tickAt(stored.orderId, delayUntil ?? now, s, now);
  return { ...committed, stored };
}

/** "Accept new minimum": the paused order's minimum becomes the approved one and the runner signs at once. */
export function acceptNewMinimum(orderId: string, s: WalletSession = defaultSession, now = Date.now()): boolean {
  const stored = journaled(orderId, s);
  if (!stored?.paused || stored.paused.code !== "minimum_moved" || !stored.paused.minOut) return false;
  patchSwap(orderId, { approvedMin: stored.paused.minOut, paused: undefined }, s);
  syncSwapRecord(journaled(orderId, s)!, null, null, now);
  tickAt(orderId, now, s, now);
  return true;
}

/** Try again after a pause that waits on nothing but the user (an unexecutable route): a fresh hard quote is prepared. */
export function retryOrder(orderId: string, s: WalletSession = defaultSession, now = Date.now()): boolean {
  const stored = journaled(orderId, s);
  if (!stored || !isOpenSwap(stored)) return false;
  patchSwap(orderId, { paused: undefined }, s);
  tickAt(orderId, now, s, now);
  return true;
}

/**
 * "Return funds": a funded order goes back to the protected balance through its refund-only job (nothing executes); an
 * order not funded yet is abandoned — nothing left the protected balance.
 */
export async function returnFunds(orderId: string, deps: OrderDeps): Promise<"refunding" | "abandoned"> {
  const s = deps.session ?? defaultSession;
  const now = deps.now?.() ?? Date.now();
  const stored = journaled(orderId, s);
  if (!stored) throw new Error("this order is not in the journal");
  const io =
    deps.io ??
    orderIo({
      masterSeed: deps.masterSeed,
      deployment: deps.deployment,
      session: s,
      submission: (deps.settings ?? (() => defaultSettings.get()))().submission,
    });
  const bal = stored.fundedTx || stored.state === "funded" ? 1n : await io.escrowBalance(stored);
  if (bal === null) throw new Error("The order's escrow could not be read; nothing was changed. Try again in a moment.");
  if (bal <= 0n) {
    abandonSwap(orderId, s);
    cancelAction(actionId(orderId), s);
    syncSwapRecord(journaled(orderId, s)!, null, null, now);
    return "abandoned";
  }
  const job = await io.refund(stored);
  patchSwap(orderId, { paused: undefined, jobId: job.id, state: job.state }, s);
  syncSwapRecord(journaled(orderId, s)!, null, job, now);
  tickAt(orderId, now + ORDER_TRACK_MS, s, now);
  return "refunding";
}

export interface OrderTickResult {
  step: "track" | "settled" | "waiting" | "funded" | "paused" | "handed-over" | "delayed" | "stopped";
  stored: StoredSwap;
}

/** One tick of an order: reconcile, then the one next step (fund, or sign and hand over, or track). */
/** A funded order whose signing failed for a passing reason is tried again this soon, inside its window (unverified m40). */
export const SIGN_RETRY_MS = 60_000;

export async function runOrderTick(a: ScheduledAction, deps: OrderDeps): Promise<OrderTickResult | null> {
  const s = deps.session ?? defaultSession;
  const now = deps.now?.() ?? Date.now();
  const stored0 = journaled(a.orderId, s);
  if (!stored0 || stored0.campaign || !isOpenSwap(stored0)) {
    cancelAction(a.id, s);
    return null;
  }
  const cfg = (deps.settings ?? (() => defaultSettings.get()))();
  const io = deps.io ?? orderIo({ masterSeed: deps.masterSeed, deployment: deps.deployment, session: s, submission: cfg.submission });
  const amount = BigInt((stored0.params as { amount?: string }).amount ?? "0");
  const pause = (code: string, detail: string): OrderTickResult => {
    patchSwap(a.orderId, { paused: { code, detail, at: now } }, s);
    const st = journaled(a.orderId, s)!;
    syncSwapRecord(st, null, null, now);
    return { step: "paused", stored: st };
  };
  schedulerStatus.start(a.id, "Swap: checking the order…");
  try {
    // 1. handed over (journaled, or the executor answers by orderId — a hand-over whose answer was lost): track it
    let stored = stored0;
    if (!stored.jobId) {
      const known = stored.fundedTx || stored.state === "funded" ? await io.job(stored) : null;
      if (known) {
        patchSwap(a.orderId, { jobId: known.id, state: known.state, paused: undefined }, s);
        stored = journaled(a.orderId, s)!;
      }
    }
    if (stored.jobId) {
      if (stored.shield) stored = await refreshShield(a.orderId, stored, io, s, now);
      const r = await io.track(stored);
      const st = journaled(a.orderId, s) ?? stored;
      syncSwapRecord(st, r.tracked, r.job, now);
      if (TERMINAL_TRACK.includes(r.tracked.state) || (r.job && TERMINAL_JOB.includes(r.job.state))) {
        // a refund re-shielded the escrow: its note is looked for now, not at the next periodic scan
        if (r.tracked.state === "REFUNDED" || r.job?.state === "refunded") scheduleDiscovery(now, s);
        cancelAction(a.id, s);
        return { step: "settled", stored: st };
      }
      tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
      return { step: "track", stored: st };
    }
    // 2. a pause that waits for the user: nothing moves until they choose (the choice plans the next tick)
    if (stored.paused?.code === "minimum_moved" || stored.paused?.code === "execution_unavailable" || stored.paused?.code === "execution_window_closed") {
      syncSwapRecord(stored, null, null, now);
      cancelAction(a.id, s);
      return { step: "waiting", stored };
    }
    // 3. the funding: the escrow's balance first (a funding whose answer was lost), then the private withdrawal
    const funded = !!stored.fundedTx || stored.state === "funded";
    if (!funded) {
      if (stored.runner?.delayUntil && now < stored.runner.delayUntil && !stored.paused) {
        tickAt(a.orderId, stored.runner.delayUntil, s, now);
        return { step: "delayed", stored };
      }
      const bal = await io.escrowBalance(stored);
      // A funding already sent is never sent again on its own (plan §86: no automatic retry on money movement). It is
      // journaled before it is sent, so a reload, a lost answer or a receipt never seen still knows it, and its fate decides
      // (2026-10-14: a reload during a funding had sent a second one, and when the notes differed both landed).
      const fate =
        bal !== null && bal >= amount ? null : stored.fundingAttempt ? await (io.fundingFate?.(stored) ?? Promise.resolve<FundingFate>("unknown")) : null;
      if (bal !== null && bal >= amount) {
        patchSwap(a.orderId, { state: "funded", paused: undefined }, s);
      } else if (fate !== null || stored.paused?.code === "reconcile") {
        // A funding with an unknown outcome: the escrow is read again before anything is sent again. A dead one (its notes
        // unspent, no relayer job, past FUNDING_SETTLE_MS, or its transaction reverted) stops the order at once. One that may
        // still land keeps the order reconciling past its window: landed late, the escrow holds the funds and the order stops
        // for "Return funds" (`execution_window_closed`). Before (to 2026-10-14) the window's end stopped the order whatever
        // the funding's fate, and a funding that landed after it stayed in the escrow with no way back. Only an order
        // reconciling with no journaled funding (a journal from before those were kept) stops at the window's end, with the
        // escrow read and still short. (Before that, a funding sent and dropped had kept the order reconciling for good.)
        if (fate === "dead" || (fate === null && bal !== null && now > windowEndOf(stored))) {
          const detail = "Its funding was sent but never confirmed; a funding is never sent twice on its own.";
          patchSwap(a.orderId, { paused: { code: "funding_unconfirmed", detail, at: now } }, s);
          abandonSwap(a.orderId, s);
          cancelAction(a.id, s);
          const st = journaled(a.orderId, s)!;
          syncSwapRecord(st, null, null, now);
          return { step: "stopped", stored: st };
        }
        if (stored.paused?.code !== "reconcile") {
          const detail = "A funding was sent and is not confirmed yet; the escrow is read before anything is sent again.";
          patchSwap(a.orderId, { paused: { code: "reconcile", detail, at: now } }, s);
          syncSwapRecord(journaled(a.orderId, s)!, null, null, now);
        }
        tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
        return { step: "paused", stored: journaled(a.orderId, s)! };
      } else {
        // The executor already has this order (audit round 2, r45): another copy of this wallet — a backup restored while the
        // first device kept running — funded and handed it over, and this record never learned it. It is tracked from now
        // on, never funded again: its escrow, executed, read empty, and a second funding swapped the amount twice
        const elsewhere = await io.job(stored).catch(() => null);
        if (elsewhere) {
          patchSwap(a.orderId, { jobId: elsewhere.id, state: elsewhere.state, paused: undefined }, s);
          syncSwapRecord(journaled(a.orderId, s)!, null, elsewhere, now);
          tickAt(a.orderId, now + 1000, s, now);
          return { step: "track", stored: journaled(a.orderId, s)! };
        }
        // An order whose execution window has closed, or is about to, is never funded: its escrow could only refund, after
        // the funding's fees were paid for nothing. It stops unfunded (`order_expired`). A V6 follow-up of 2026-10-14: a
        // funding delayed for privacy runs at the next unlock, which can come after the window — it had funded such orders.
        if (now + FUNDING_MARGIN_MS >= windowEndOf(stored)) {
          const detail = "Its execution window closed before it was funded; nothing was sent.";
          patchSwap(a.orderId, { paused: { code: "order_expired", detail, at: now } }, s);
          abandonSwap(a.orderId, s);
          cancelAction(a.id, s);
          const st = journaled(a.orderId, s)!;
          syncSwapRecord(st, null, null, now);
          return { step: "stopped", stored: st };
        }
        let sent = false;
        schedulerStatus.progress("Swap: funding the order from your protected balance…");
        try {
          await io.fund(stored, (line) => {
            if (SENT_LINE.test(line)) sent = true;
            schedulerStatus.progress(line);
          });
        } catch (e) {
          const code = (e as { code?: unknown })?.code;
          if (
            !sent &&
            (code === "older_notes_unavailable" ||
              code === "relayer_not_ready" ||
              code === "service_key_changed" ||
              code === "order_outdated" ||
              code === "fee_moved")
          ) {
            // "Delay for more privacy": the older notes the Review showed no longer cover the order and nothing was sent —
            // it is stopped unfunded (its escrow's window cannot wait 1–24 h), never paid from younger notes. Or the relayer
            // that would execute it does not run it, or the swap service no longer takes its vouch (a V6 follow-up of
            // 2026-10-16), or an older build committed it under the privacy address's owner commitment (c18): stopped before
            // anything moved
            patchSwap(a.orderId, { paused: { code, detail: (e as Error).message, at: now } }, s);
            abandonSwap(a.orderId, s);
            cancelAction(a.id, s);
            const st = journaled(a.orderId, s)!;
            syncSwapRecord(st, null, null, now);
            return { step: "stopped", stored: st };
          }
          if (!sent) throw e; // nothing was sent: the scheduler's backoff retries the tick
          const r = pause(
            "reconcile",
            `The funding ended without a known outcome (${(e as Error)?.message ?? String(e)}); the escrow is read before anything is sent again.`,
          );
          tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
          return r;
        }
      }
      const st = journaled(a.orderId, s)!;
      syncSwapRecord(st, null, null, now);
      tickAt(a.orderId, now + 1000, s, now); // the next tick signs
      return { step: "funded", stored: st };
    }
    // 4. sign while the minimum holds, and hand over at once — while the order can still execute. Once its execution window
    // has closed with nothing handed over (the executor was asked above) the escrow only refunds: the order stops for the
    // user's "Return funds". A V6 follow-up of 2026-10-14: such an order — a tab closed after its funding, a moved minimum
    // left for an hour, a long outage — retried its signature on the scheduler's growing backoff for good, every attempt
    // refused as outside the window, and its screen offered no way back.
    if (now >= windowEndOf(stored))
      return pause("execution_window_closed", "Its execution window closed before it was signed and handed over; nothing was swapped.");
    if (stored.paused?.code === "reconcile") patchSwap(a.orderId, { paused: undefined }, s);
    // the minimum the user just accepted signs the call it was read from, checked again, while that call stays valid
    const key = a.orderId.toLowerCase();
    const kept = movedCalls.get(key);
    movedCalls.delete(key);
    const reuse =
      kept && stored.approvedMin !== undefined && kept.minOut >= BigInt(stored.approvedMin) && kept.prepared.deadline * 1000 - now >= ACCEPTED_CALL_MARGIN_MS
        ? kept.prepared
        : undefined;
    schedulerStatus.progress("Swap: preparing and checking the execution…");
    let r: Signed | { moved: MinimumMoved; prepared?: Prepared };
    try {
      r = await io.sign(stored, reuse);
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      if (!(e instanceof ProviderCallUnverified)) {
        // the swap service builds for another factory (read before the prepare since audit round 2, r02): it was a hand-over's pause
        if (/builds for/i.test(m)) return pause("execution_unavailable", m);
        if (/receiver|does not do what this wallet asked for|escrow|digest|not the one this wallet committed|pinned/i.test(m))
          return pause("unsafe_contract_call", m);
        // the service's price guard refused the hard quote (a route far below the best alternative): the user tries again or returns the funds
        if ((e as { code?: unknown })?.code === "price_guard" || /below the best alternative|price.?guard/i.test(m)) return pause("execution_unavailable", m);
      }
      // the gateways did not answer (an outage, never an unsafe call), or the network failed before anything was signed: the
      // funded order tries again within the minute, inside its window — never the scheduler's backoff of 10 minutes, then
      // 20, which outran a 30-minute window and left the order only its refund (2026-10-17, the audit's unverified m40)
      schedulerStatus.progress(`Swap: the execution could not be prepared yet (${m.split("\n")[0].slice(0, 120)}); trying again in a minute…`);
      tickAt(a.orderId, now + SIGN_RETRY_MS, s, now);
      return { step: "waiting", stored: journaled(a.orderId, s)! };
    }
    if ("moved" in r) {
      if (r.prepared) movedCalls.set(key, { prepared: r.prepared, minOut: r.moved.minOut });
      patchSwap(a.orderId, { paused: { code: "minimum_moved", at: now, minOut: r.moved.minOut.toString(), approved: r.moved.approved.toString() } }, s);
      const st = journaled(a.orderId, s)!;
      syncSwapRecord(st, null, null, now);
      cancelAction(a.id, s);
      return { step: "paused", stored: st };
    }
    if (!r.sim.ok) return pause("execution_unavailable", r.sim.reason ?? "the execution's simulation failed");
    // reconcile before the hand-over: the executor by orderId (another tab may have handed it over)
    const existing = await io.job(stored);
    if (existing) {
      patchSwap(a.orderId, { jobId: existing.id, state: existing.state }, s);
    } else {
      schedulerStatus.progress("Swap: handing the signed execution to the executor…");
      try {
        await io.handOver(stored, r);
      } catch (e) {
        const m = (e as Error)?.message ?? String(e);
        // the call came too close to its deadline, here or at the relayer (audit round 2, r02): nothing was handed over, and
        // the next tick prepares and signs a fresh one — no pause for the user, nor the reconcile backoff
        if ((e as { code?: unknown })?.code === "deadline_too_close") {
          tickAt(a.orderId, now + 1000, s, now);
          return { step: "waiting", stored: journaled(a.orderId, s)! };
        }
        if (/Not handed over|builds for/i.test(m)) return pause("execution_unavailable", m);
        const p = pause("reconcile", `The hand-over ended without a known outcome (${m}); the executor is asked before anything is sent again.`);
        tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
        return p;
      }
    }
    const st = journaled(a.orderId, s)!;
    syncSwapRecord(st, null, null, now);
    tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
    return { step: "handed-over", stored: st };
  } finally {
    schedulerStatus.finish();
    // handed over, paused for the user, or over: the critical section ends
    const st = journaled(a.orderId, s);
    if (!st || st.jobId || st.paused || !isOpenSwap(st)) releaseHandOver(a.orderId);
  }
}
