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
import { ProviderCallMismatch, ProviderCallUnverified, type MinimumMoved } from "../providerCall";
import { ApiError } from "../api/client";
import { deriveState, journalStateOf, trackOrder, type Tracked } from "../orderTracker";
import { lateRefundHeld } from "@privacy-wallet/protocol/wallet/settlement";
import { RelayerRefusal, relayerShieldRegister, relayerShieldStatus, relayerSwapStatus, RelayerTimeout, type ShieldJob, type SwapJob } from "../relayer";
import { classify } from "../operations/errors/catalog";
import {
  commitOrder,
  handOverSigned,
  prepareAndSign,
  resumeOrder,
  RefundRefusal,
  returnOrderToBalance,
  shieldJobView,
  type CommitInput,
  type Committed,
  type Signed,
  minimumBeforeFunding,
} from "../swapExecute";
import { refundVaultsOf } from "../refundVaults";
import { refundNotesBack } from "../orderStates";
import { ShieldReceiptMismatch, shieldJobRequest } from "../shieldReceiver";
import { OrderMismatch } from "../swapGuard";
import { RecordIncomplete } from "../swapSign";
import { recoverShieldDelivery } from "../privateTx";
import {
  abandonSwap,
  fundEscrow,
  FundingAlreadySent,
  fundingFate,
  fundingReads,
  fundingUnderWay,
  FundingUnderWay,
  FUNDING_MARGIN_MS,
  isOpenSwap,
  latestBlockTime,
  patchSwap,
  windowEndOf,
  type FundingFate,
} from "../swapFunding";
import type { Prepared, ServiceOrder } from "../swapService";
import { escrowBalance, escrowExecuted, escrowLeftOf } from "../orderTracker";
import { syncSwapRecord } from "../operations/swapRecords";
import { fundedOf, type ScheduledAction, type StoredSwap } from "./journal";
import { cancelAction, kickScheduler, sampleDueAt, scheduleAction, schedulerStatus } from "./schedule";
import { scheduleDiscovery } from "./discovery";
import { session as defaultSession, type WalletSession } from "./session";
import { settings as defaultSettings, type Settings } from "./settings";

/** The tracking cadence once an order is handed over. */
export const ORDER_TRACK_MS = 15_000;
/** The execute window of an order funded at once (the plan's 1800 s): the escrow refunds after it, unexecuted. */
export const ONE_CONFIRM_EXECUTE_WINDOW_SECONDS = 1800;
/**
 * "Delay for more privacy" (spec v2.0 §14.1): when no older notes cover the order, the funding at a random time in 1–24 h — the
 * draw ends early enough that the funding's own window (`delayedExecuteWindowSeconds`) still fits the policy's 24-hour budget
 * (the engine clamps the window to it; a window ending with the funding had been refused as too short).
 */
export const DELAY_FOR_PRIVACY: [number, number] = [3600, 24 * 3600 - ONE_CONFIRM_EXECUTE_WINDOW_SECONDS - 600];
/**
 * The execute window of a delayed order (the sixth review round, 2026-11-03): the delay itself plus the one-confirm window, so that
 * the escrow's public `executeDeadline` (quote expiry + window) encodes the planned funding time — public once funded anyway —
 * and not the commit. Before, a delayed order took the policy's whole budget as its window, which put the commit's time on
 * chain as deadline − 24 h and re-linked the deposit to the exit the delay was meant to separate.
 */
export const delayedExecuteWindowSeconds = (delayUntil: number, now: number): number =>
  Math.max(0, Math.ceil((delayUntil - now) / 1000)) + ONE_CONFIRM_EXECUTE_WINDOW_SECONDS;
/** Audit gap 43: an accepted minimum's call is signed only with at least this long left before its deadline; else a fresh quote. */
export const ACCEPTED_CALL_MARGIN_MS = 120_000;
/** A withdrawal's status line once its submission started: after it, a failure's outcome is unknown (the reconcile boundary). */
export const SENT_LINE = /handing it to the relayer|submitting through the connected wallet|Waiting for the transaction/i;
/** An order the executor no longer watches, not settled yet, is read this often: for the provider's word, or a late refund. */
export const ORDER_LATE_TRACK_MS = 10 * 60_000;
/** A hand-over whose outcome is not known past the window's end: the executor is asked again this often (the ninth review round, C-09). */
export const HANDOVER_RECHECK_MS = 60_000;
/**
 * Past the execution window, an escrow that still holds the whole order is conclusive once the endpoints had this long to see an execution of
 * the window's last minutes (the tenth review round, A10-3): nothing executes past the deadline, attempt journaled or not.
 */
export const HANDOVER_SETTLE_MS = 10 * 60_000;
/** ...and the chain's own latest block this far past the deadline (B11-4): the endpoints' view of a last-block execution has had time to land. */
export const CHAIN_SETTLE_MS = 2 * 60_000;

/** Everything the runner reads or moves, behind one interface: the wallet's modules by default, fakes in the tests. */
export interface OrderIo {
  fund(stored: StoredSwap, onStatus: (line: string) => void): Promise<{ txHash: string }>;
  /** what became of the order's journaled funding (swapFunding.ts `fundingFate`); absent: unknown, so nothing is sent */
  fundingFate?(stored: StoredSwap): Promise<FundingFate>;
  escrowBalance(stored: StoredSwap): Promise<bigint | null>;
  /**
   * the escrow's own `executed` flag (orderTracker.ts escrowExecuted): null when it cannot be read; absent (the tests' fakes), not read. Once the
   * order's refund is found it is final — a refund is made only past the execute deadline (the eleventh review round's K4 critique)
   */
  escrowExecuted?(stored: StoredSwap): Promise<boolean | null>;
  /** the chain's latest block time (ms), or null when it cannot be read; absent, the device's clock alone (the eleventh review round, B11-4) */
  chainTime?(): Promise<number | null>;
  /** `reuse`: the call whose moved minimum the user accepted, checked again and signed instead of a fresh quote */
  sign(stored: StoredSwap, reuse?: Prepared): Promise<Signed | { moved: MinimumMoved; prepared?: Prepared }>;
  /** `onSending`: called right before the executor is asked, with its relayer (the tenth review round, A10-3) */
  handOver(stored: StoredSwap, signed: Signed, onSending?: (relayerUrl: string) => void): Promise<{ job?: SwapJob }>;
  /**
   * the executor's job for this order, if it has one (keyed by orderId); `at`: the relayer that answered, journaled as the order's (K4: one found
   * at the relayer Settings name had been read at the order's own from then on, unknown there for good)
   */
  job(stored: StoredSwap): Promise<(SwapJob & { at?: string }) | null>;
  /** `journal`: the journal state the tracker gave the reading (`null`: as it is); a reader of its own leaves it out (XB's critique of the twelfth round) */
  track(stored: StoredSwap): Promise<{ tracked: Tracked; job: SwapJob | null; journal?: string | null }>;
  refund(stored: StoredSwap): Promise<SwapJob>;
  /** a delayed funding's fresh minimum, nothing signed (audit round 2, n58): null when it holds; absent, nothing is asked */
  precheck?(stored: StoredSwap): Promise<MinimumMoved | null>;
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

/**
 * A job found by orderId, for the journal: its state while the job is open; an ended one — refunded, completed — closes the order on a settled
 * reading only (the eleventh review round's fifth critique: journaled as found, it had closed the order before any reading — a partial fill's
 * delivered part lost, a provider failure recorded "Swap complete"). Until the tracker reads it, the order is funded: a job exists only for a
 * funded escrow
 */
const foundState = (j: { state: string }): string => (isOpenSwap({ state: j.state }) ? j.state : "funded");

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

/** The escrow's balance in the order's asset, every endpoint agreeing; null when it was not read. */
const escrowOf = async (deployment: Deployment | null, stored: StoredSwap): Promise<bigint | null> => {
  if (!deployment) return null;
  const token = (stored.request as { from?: { asset?: string } })?.from?.asset;
  return escrowBalance(deployment, stored.endpoint as Hex, token && token !== "native" ? (token as Hex) : null).catch(() => null);
};

/** What the escrow still holds to return — "asset", "token" or false (orderTracker escrowLeftOf) —, every endpoint agreeing; null when not read. */
const leftIn = (deployment: Deployment | null, stored: StoredSwap): Promise<"asset" | "token" | false | null> =>
  deployment
    ? escrowLeftOf(stored, deployment.chainId, (token) => escrowBalance(deployment, stored.endpoint as Hex, token).catch(() => null))
    : Promise.resolve(null);

export function orderIo(d: { masterSeed: Uint8Array; deployment: Deployment | null; session: WalletSession; submission: Settings["submission"] }): OrderIo {
  const relayerUrl = d.submission.kind === "relayer" ? d.submission.url : null;
  // the relayer an order was handed to, else the one Settings name (audit round 2, r38): an order handed to another relayer
  // than today's was read from today's — unknown there, so a handed-over, executed order fell back to "Waiting for source"
  // and was polled every 15 s for good, its refund and its shield job asked of a relayer that never had them
  const relayerOf = (stored: StoredSwap): string | null => stored.relayerUrl ?? relayerUrl;
  const orderFor = async (stored: StoredSwap): Promise<ServiceOrder> => {
    const hit = orders.get(stored.orderId.toLowerCase());
    if (hit) return hit;
    const order = await resumeOrder(d.deployment, stored, d.session);
    orders.set(stored.orderId.toLowerCase(), order);
    return order;
  };
  return {
    fund: (stored, onStatus) => fundEscrow({ masterSeed: d.masterSeed, deployment: d.deployment, stored, session: d.session, onStatus, relayerUrl }),
    fundingFate: async (stored) =>
      d.deployment && stored.fundingAttempt ? fundingFate(stored.fundingAttempt, fundingReads(d.deployment), undefined, stored.endpoint) : "unknown",
    // ms, or null when the block time cannot be read (the critique: a failed read had answered -1000, a time in 1969)
    chainTime: async () => {
      if (!d.deployment) return null;
      const t = await latestBlockTime(d.deployment).catch(() => null);
      return t === null ? null : Number(t) * 1000;
    },
    escrowBalance: (stored) => escrowOf(d.deployment, stored),
    escrowExecuted: async (stored) => (d.deployment ? escrowExecuted(d.deployment, stored.endpoint as Hex).catch(() => null) : null),
    precheck: async (stored) =>
      minimumBeforeFunding({
        masterSeed: d.masterSeed,
        deployment: d.deployment,
        session: d.session,
        stored,
        order: await orderFor(stored),
        submission: d.submission,
      }),
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
    handOver: async (stored, signed, onSending) =>
      handOverSigned({
        deployment: d.deployment,
        session: d.session,
        stored,
        order: await orderFor(stored),
        signed,
        submission: d.submission,
        ...(onSending ? { onSending } : {}),
      }),
    job: async (stored) => {
      const own = relayerOf(stored);
      if (!own) return null;
      const found = await relayerSwapStatus(own, stored.orderId).catch(() => null);
      if (found) return { ...found, at: own };
      // unknown at the order's own relayer: the one Settings name now may hold it (a hand-over whose answer was lost) — and is the order's from then on
      if (!relayerUrl || relayerUrl === own) return null;
      const there = await relayerSwapStatus(relayerUrl, stored.orderId).catch(() => null);
      return there ? { ...there, at: relayerUrl } : null;
    },
    track: (stored) => trackOrder(stored, { deployment: d.deployment, relayerUrl: relayerOf(stored), session: d.session }),
    // the relayer it was handed to takes its refund; when that one cannot be reached, or answers that it runs no swaps now (a relayer
    // restarted without its executor had kept an order's funds from coming back: the eleventh review round's third critique of slice 4),
    // the one Settings name now does (the escrow pays its refund to this wallet's own note, whoever asks, and only once). A lost answer is
    // no such case: the first may hold the job
    refund: async (stored) => {
      const own = stored.relayerUrl;
      // every job the relayer keeps is checked against what the escrow still holds (swapExecute returnOrderToBalance)
      const escrowLeft = () => leftIn(d.deployment, stored);
      if (!own || (d.submission.kind === "relayer" && own === d.submission.url))
        return returnOrderToBalance({ deployment: d.deployment, session: d.session, stored, submission: d.submission, escrowLeft });
      try {
        return await returnOrderToBalance({ deployment: d.deployment, session: d.session, stored, submission: { kind: "relayer", url: own }, escrowLeft });
      } catch (e) {
        const code = classify(e).code;
        // ... and when it answers with a job it will not reopen (refund_not_watched: completed, refund-failed, or "refunded" over an escrow that still holds
        // something to return — the twelfth review round, XH's and XI's critiques: a relayer that dropped the order had been asked for good, the one
        // Settings name never). An escrow not read is no such answer: nothing is asked elsewhere
        const kept = e instanceof RefundRefusal && e.code === "refund_not_watched";
        if (d.submission.kind !== "relayer" || e instanceof RelayerTimeout || (!kept && code !== "relayer_unreachable" && code !== "swap_unavailable")) throw e;
        return returnOrderToBalance({ deployment: d.deployment, session: d.session, stored, submission: d.submission, escrowLeft });
      }
    },
    shieldStatus: (stored) =>
      relayerOf(stored) && stored.shield
        ? relayerShieldStatus(relayerOf(stored)!, stored.shield.params.receiptId).catch((e) => {
            if (e instanceof RelayerRefusal && e.status === 404) return null;
            throw e;
          })
        : Promise.resolve(null),
    registerShield: async (stored) => {
      const own = relayerOf(stored);
      if (!own) throw new Error("a swap into the protected balance needs a relayer to shield its delivery");
      return relayerShieldRegister(own, shieldJobRequest(stored));
    },
    recoverShield: async (stored) =>
      d.deployment && stored.shield
        ? (await recoverShieldDelivery({ masterSeed: d.masterSeed, deployment: d.deployment, orderId: stored.orderId, shield: stored.shield })).length
        : 0,
  };
}

/**
 * A delivery the executor reported and the pool's proven part does not hold yet is looked for at most this often (the tenth review round,
 * B10-5): it waits for the proof that covers its leaf, minutes after it is mined, and every 15-second tick had read the whole pool again.
 */
export const SHIELD_RECHECK_MS = 120_000;
const shieldLookedAt = new Map<string, number>();

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
    const looked = shieldLookedAt.get(orderId);
    if (reported > (sh.leaves?.length ?? 0) && (looked === undefined || now - looked >= SHIELD_RECHECK_MS || now < looked)) {
      const found = await io.recoverShield(journaled(orderId, s) ?? stored);
      if (found > 0) shieldLookedAt.delete(orderId);
      else shieldLookedAt.set(orderId, now);
    }
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
    executeWindowSeconds:
      i.request.executeWindowSeconds ?? (delayUntil !== undefined ? delayedExecuteWindowSeconds(delayUntil, now) : ONE_CONFIRM_EXECUTE_WINDOW_SECONDS),
  };
  const committed = await commitOrder({ ...i, request, schedule: null });
  orders.set(committed.order.orderId.toLowerCase(), committed.order);
  patchSwap(
    committed.stored.orderId,
    { runner: { confirmedAt: now, ...(delayUntil !== undefined ? { delayUntil } : {}), ...(maxTiming !== undefined ? { maxTiming } : {}) } },
    s,
  );
  const stored = journaled(committed.stored.orderId, s) ?? committed.stored;
  syncSwapRecord(stored, null, null, now, s);
  if (delayUntil === undefined) holdUntilHandedOver(stored.orderId, s, now); // a privacy delay holds nothing
  tickAt(stored.orderId, delayUntil ?? now, s, now);
  return { ...committed, stored };
}

/** "Accept new minimum": the paused order's minimum becomes the approved one and the runner signs at once. */
export function acceptNewMinimum(orderId: string, s: WalletSession = defaultSession, now = Date.now()): boolean {
  const stored = journaled(orderId, s);
  if (!stored?.paused || stored.paused.code !== "minimum_moved" || !stored.paused.minOut) return false;
  patchSwap(orderId, { approvedMin: stored.paused.minOut, paused: undefined }, s);
  syncSwapRecord(journaled(orderId, s)!, null, null, now, s);
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
  // never while this tab proves or sends the order's funding (the ninth review round, 2026-11-04, C-04): the escrow read empty, the order
  // was abandoned, and the funding went out anyway — the order re-opened funded and was handed over, its record "Cancelled"
  if (fundingUnderWay(orderId)) throw new FundingUnderWay();
  const io =
    deps.io ??
    orderIo({
      masterSeed: deps.masterSeed,
      deployment: deps.deployment,
      session: s,
      submission: (deps.settings ?? (() => defaultSettings.get()))().submission,
    });
  const bal = fundedOf(stored) ? 1n : await io.escrowBalance(stored); // the durable rule (C-01): a handed-over order is funded
  if (bal === null) throw new Error("The order's escrow could not be read; nothing was changed. Try again in a moment.");
  if (bal <= 0n) {
    // a funding on its way is never abandoned (the review round of 2026-11-03, E2): it would land in an escrow nothing reads again
    if (stored.fundingAttempt && !stored.fundedTx) {
      const fate = await (io.fundingFate?.(stored) ?? Promise.resolve<FundingFate>("unknown"));
      if (fate !== "dead") throw new FundingAlreadySent(fate);
    }
    abandonSwap(orderId, s, { fundingDead: true });
    cancelAction(actionId(orderId), s);
    syncSwapRecord(journaled(orderId, s)!, null, null, now, s);
    return "abandoned";
  }
  const job = await io.refund(stored);
  // a relayer's "refunded" taken as true (nothing left in the escrow: swapExecute returnOrderToBalance) closes nothing here: the order is read at once —
  // the escrow's flag, the provider — and closes on the tracker's own reading, its refund note looked for now (the twelfth review round, XJ's critique:
  // journaled and synced from the job, an executed order's delivery read since had never been recorded, a dropped one's live reads said executing)
  if (job.state === "refunded") {
    patchSwap(orderId, { paused: undefined, jobId: job.id }, s);
    scheduleDiscovery(now, s);
    tickAt(orderId, now, s, now);
    return "refunding";
  }
  patchSwap(orderId, { paused: undefined, jobId: job.id, state: job.state }, s);
  syncSwapRecord(journaled(orderId, s)!, null, job, now, s);
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
/** ...and never later than this: a long window's tries are spaced out (audit round 2, n17). */
export const SIGN_RETRY_MAX_MS = 10 * 60_000;
/**
 * The next try of a funded order's signing: about thirty across what is left of its window, never under a minute nor over
 * ten (audit round 2, n17). A 30-minute window keeps its minute; a window of 24–72 h ("Delay for more privacy") had tried
 * every minute for all of it — 1,400 to 4,300 prepares, each a quote of the provider, through one outage.
 */
export function signRetryMs(stored: StoredSwap, now: number): number {
  const left = windowEndOf(stored) - now;
  return Number.isFinite(left) && left > 0 ? Math.min(SIGN_RETRY_MAX_MS, Math.max(SIGN_RETRY_MS, Math.floor(left / 30))) : SIGN_RETRY_MS;
}

export async function runOrderTick(a: ScheduledAction, deps: OrderDeps): Promise<OrderTickResult | null> {
  const s = deps.session ?? defaultSession;
  const now = deps.now?.() ?? Date.now();
  // a journal from before the hand-over kept its refund tokens' vaults (the twelfth review round, XC's critique; XD's: a closed order's too, whose
  // record its refund in a refund token makes a refund): derived from the deployment, once
  const before0 = journaled(a.orderId, s);
  if (before0?.refundTokens?.length && !before0.refundVaults && deps.deployment)
    patchSwap(a.orderId, { refundVaults: refundVaultsOf(deps.deployment, before0.refundTokens, before0.refundFloors) }, s);
  const stored0 = journaled(a.orderId, s);
  if (!stored0 || stored0.campaign || !isOpenSwap(stored0)) {
    // an order closed since the last tick (a lapsed job, a refund the scan found) has its record moved once more (the tenth review round,
    // A10-6): it had stayed "Refunding", and Home said "still executing", until a Refresh by hand
    if (stored0 && !stored0.campaign) {
      try {
        syncSwapRecord(stored0, null, null, now, s);
      } catch {
        // the record's sync never keeps the closed order's tick: it is cancelled all the same
      }
    }
    cancelAction(a.id, s);
    return null;
  }
  const cfg = (deps.settings ?? (() => defaultSettings.get()))();
  const io = deps.io ?? orderIo({ masterSeed: deps.masterSeed, deployment: deps.deployment, session: s, submission: cfg.submission });
  const amount = BigInt((stored0.params as { amount?: string }).amount ?? "0");

  /** The reading an order closes on when no reading of the tracker closed it (XC's critique: the journal's last open reading had been answered as "the reading that closed it") */
  const refundedReading = (): Pick<StoredSwap, "track"> => ({ track: { state: "REFUNDED", label: "Refunded", at: now } as StoredSwap["track"] });
  const pause = (code: string, detail: string): OrderTickResult => {
    patchSwap(a.orderId, { paused: { code, detail, at: now } }, s);
    const st = journaled(a.orderId, s)!;
    syncSwapRecord(st, null, null, now, s);
    return { step: "paused", stored: st };
  };
  schedulerStatus.start(a.id, "Swap: checking the order…");
  // the critical section is taken again at every tick of an open order before its hand-over (unpaused, due): a tick that
  // threw releases it below — a dead tick had kept the lock off for the cap's thirty minutes (the review round of 2026-11-02)
  // a tick under the reconcile pause clears it and may sign and hand over (the review round of 2026-11-03, E5): held like any other
  // ... and never for an order whose refund was found (K4's third critique): nothing is signed or handed over for it, and a hold taken at every tick
  // of one left open had kept the idle lock off and the tab's close asked for good
  if ((!stored0.paused || stored0.paused.code === "reconcile") && !stored0.jobId && (stored0.runner?.delayUntil ?? 0) <= now && !refundNotesBack(stored0))
    holdUntilHandedOver(a.orderId, s, now);
  // a reading's end of the tick (the eleventh review round's K4 critique): settled once the reading closes the order — and only then — a terminal
  // reading with the order still open, its job not read or a refunded job whose provider was not read, had cancelled the tick, the order open and
  // in flight for good. The closing is the tracker's rule (orderTracker.ts journalStateOf: a `completed` job only with a settled reading — audit
  // round 2, r36 —, a provider failure with nothing back — the sixth review round —, a refunded job only once its reading settled), journaled here
  // too when the reader did not (a reader of its own). An order the executor no longer watches, or whose refund came back, is read every ten
  // minutes until then
  const settleOn = (r: { tracked: Tracked; job: SwapJob | null; journal?: string | null }, before: StoredSwap): OrderTickResult => {
    const read = journaled(a.orderId, s) ?? before;
    // the tracker's own decision when it gave one (the twelfth review round, XB's critique: a lapsed job with the escrow's flag unread — an order
    // perhaps executed elsewhere — left open by the tracker to be read again, had been closed here on the job alone, its tick cancelled); a
    // reader of its own: the tracker's rule
    const next = r.journal !== undefined ? (r.journal ?? undefined) : journalStateOf(read, r.tracked, r.job);
    if (next && isOpenSwap(read) && !isOpenSwap({ state: next })) patchSwap(a.orderId, { state: next }, s);
    const st = journaled(a.orderId, s) ?? read;
    syncSwapRecord(st, r.tracked, r.job, now, s);
    if (!isOpenSwap(st)) {
      // a refund re-shielded the escrow: its note is looked for now, not at the next periodic scan
      if (r.tracked.state === "REFUNDED" || r.job?.state === "refunded") scheduleDiscovery(now, s);
      cancelAction(a.id, s);
      return { step: "settled", stored: st };
    }
    if (r.job?.state === "refunded" && !refundNotesBack(st)) scheduleDiscovery(now, s);
    const late = r.job?.state === "completed" || r.job?.state === "refunded" || refundNotesBack(st);
    tickAt(a.orderId, now + (late ? ORDER_LATE_TRACK_MS : ORDER_TRACK_MS), s, now);
    return { step: "track", stored: st };
  };
  let threw = false;
  try {
    // 1. handed over (journaled, or the executor answers by orderId — a hand-over whose answer was lost): track it
    let stored = stored0;
    if (!stored.jobId) {
      const known = fundedOf(stored) ? await io.job(stored) : null;
      if (known) {
        // with the relayer that answered (the eleventh review round's K4 critique): found at the one Settings name, the job had been read at the
        // order's own relayer from then on — unknown there, its refund closing nothing
        patchSwap(a.orderId, { jobId: known.id, state: foundState(known), paused: undefined, ...(known.at ? { relayerUrl: known.at } : {}) }, s);
        stored = journaled(a.orderId, s)!;
      }
    }
    if (stored.jobId) {
      if (stored.shield) stored = await refreshShield(a.orderId, stored, io, s, now);
      return settleOn(await io.track(stored), stored);
    }
    // 1b. its refund found (the scan journaled it), no job known and no execution journaled: the escrow's own flag decides (the eleventh review
    // round's K4 critique) — a refund is made only past the execute deadline, so the flag is final then. Never executed, the escrow holding dust
    // at most (lateRefundHeld's rule: a transfer anyone can make to a public address): refunded — by its own Return funds, another copy of the
    // wallet, or anyone's deployAndRefund — and closed with its pause (the critique of B11-1, B11-2: an order paused after a hand-over attempt had
    // stayed "your funds wait in your one-time escrow", asked about every hour for good; with no relayer to ask, or one that did not answer, it
    // had stayed open for good). Executed — the user's own deployAndExecute (submission "wallet"), another copy's hand-over, a relayer that lost
    // its job —: journaled so, its pause cleared, and read as a handed-over order is — the tracker finds its execution transaction from the
    // escrow's Executed event and asks the provider what it delivered (K4's third critique: no job could ever come for it, and it had stayed open
    // and in flight for good) — at every tick until a reading settles it: one whose execution is journaled (the event's transaction, found at an
    // earlier read — a Refresh's too —, or the order journaled executed) goes there at once, its pause cleared (the fourth critique: the next
    // tick had skipped it, paused it "the executor is asked again" and asked the provider no more). A flag or a balance not read: read again.
    // Nothing is signed or handed over for an order whose refund came back; an escrow holding more than dust since (a funding that landed late)
    // is the steps' below to return
    // An order journaled executed is read as one, its pause ended, whatever its escrow holds (C12-1's critique: a second refund held there had
    // skipped it to the hand-over's pause)
    if (refundNotesBack(stored) && fundedOf(stored) && (stored.executionTx || stored.state === "executed")) {
      if (stored.paused) patchSwap(a.orderId, { paused: undefined }, s);
      const st = journaled(a.orderId, s)!;
      return settleOn(await io.track(st), st);
    }
    // ... and only once the escrow no longer holds the order (the twelfth review round, C12-1): still holding it, the note found is a deposit anyone
    // holding the payload could make — the relayer the order was handed to among them —, and the order goes on below as funded, its hand-over made
    // or asked about as before. Read again when the balance is not read
    const held = refundNotesBack(stored) && fundedOf(stored) ? await io.escrowBalance(stored) : null;
    if (refundNotesBack(stored) && fundedOf(stored) && (held === null || !lateRefundHeld(held, amount))) {
      // an order paused because its escrow still held the whole order past its deadline never executed — nothing executes after it —: its flag is
      // not needed (the fifth critique)
      const executed = stored.paused?.code === "execution_window_closed" ? false : io.escrowExecuted ? await io.escrowExecuted(stored).catch(() => null) : null;
      const left = executed === false ? held : null;
      if (executed === false && left !== null && !lateRefundHeld(left, amount)) {
        patchSwap(a.orderId, { state: "refunded", paused: undefined, ...refundedReading() }, s);
        const st = journaled(a.orderId, s)!;
        syncSwapRecord(st, null, null, now, s);
        cancelAction(a.id, s);
        return { step: "settled", stored: st };
      }
      if (executed === true) {
        patchSwap(a.orderId, { state: "executed", paused: undefined }, s);
        const st = journaled(a.orderId, s)!;
        return settleOn(await io.track(st), st);
      }
      if (executed === null || left === null) {
        // ... with its pause ended: its refund came back, and the pause's words — "your funds wait in your one-time escrow", Return funds — were no
        // longer true (the fifth critique); the record says the funds came back and what the swap did is read again
        if (stored.paused) patchSwap(a.orderId, { paused: undefined }, s);
        const st = journaled(a.orderId, s)!;
        syncSwapRecord(st, deriveState(st, { now, job: null, escrowBalance: held, track: null, refundFound: true, escrowExecuted: executed }), null, now, s);
        tickAt(a.orderId, now + HANDOVER_RECHECK_MS, s, now);
        return { step: "track", stored: st };
      }
    }
    // 2. a pause that waits for the user: nothing moves until they choose (the choice plans the next tick)
    if (stored.paused?.code === "minimum_moved" || stored.paused?.code === "execution_unavailable" || stored.paused?.code === "execution_window_closed") {
      syncSwapRecord(stored, null, null, now, s);
      cancelAction(a.id, s);
      return { step: "waiting", stored };
    }
    // 3. the funding: the escrow's balance first (a funding whose answer was lost), then the private withdrawal
    const funded = fundedOf(stored);
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
        // its landing journaled for good (the ninth review round, C-01): the hand-over writes the job's state over `state`
        patchSwap(a.orderId, { state: "funded", fundedAt: now, paused: undefined }, s);
      } else if (fate !== null || stored.paused?.code === "reconcile") {
        // A funding with an unknown outcome: the escrow is read again before anything is sent again. A dead one (its notes
        // unspent, no relayer job, past FUNDING_SETTLE_MS, or its transaction reverted) stops the order at once. One that may
        // still land keeps the order reconciling past its window: landed late, the escrow holds the funds and the order stops
        // for "Return funds" (`execution_window_closed`). Before (to 2026-10-14) the window's end stopped the order whatever
        // the funding's fate, and a funding that landed after it stayed in the escrow with no way back. Only an order
        // reconciling with no journaled funding (a journal from before those were kept) stops at the window's end, with the
        // escrow read and still short. (Before that, a funding sent and dropped had kept the order reconciling for good.)
        // a funding that landed into an escrow read short (the review round of 2026-11-03, E7): another copy of this wallet funded and
        // handed the order over, and the executor has it (gap 51's mechanism) — asked before the order waits as reconciling for good
        if (fate === "landed") {
          const elsewhere = await io.job(stored).catch(() => null);
          if (elsewhere) {
            patchSwap(
              a.orderId,
              { jobId: elsewhere.id, state: foundState(elsewhere), paused: undefined, ...(elsewhere.at ? { relayerUrl: elsewhere.at } : {}) },
              s,
            );
            syncSwapRecord(journaled(a.orderId, s)!, null, isOpenSwap({ state: elsewhere.state }) ? elsewhere : null, now, s);
            tickAt(a.orderId, now + 1000, s, now);
            return { step: "track", stored: journaled(a.orderId, s)! };
          }
          // ... or refunded since — another copy's Return funds through a relayer this wallet does not name, anyone's deployAndRefund past its refund
          // time (XC's critique: its refund note found, the escrow read at dust, it had stayed "a funding was sent and is not confirmed yet" for good,
          // holding the band's in-flight slot): the escrow's flag decides, as step 1b's does for a funding journaled as landed
          if (refundNotesBack(stored) && bal !== null && !lateRefundHeld(bal, amount)) {
            const executed = io.escrowExecuted ? await io.escrowExecuted(stored).catch(() => null) : null;
            if (executed === false) {
              patchSwap(a.orderId, { state: "refunded", paused: undefined, ...refundedReading() }, s);
              const st = journaled(a.orderId, s)!;
              syncSwapRecord(st, null, null, now, s);
              cancelAction(a.id, s);
              return { step: "settled", stored: st };
            }
            if (executed === true) {
              patchSwap(a.orderId, { state: "executed", paused: undefined }, s);
              const st = journaled(a.orderId, s)!;
              return settleOn(await io.track(st), st);
            }
          }
        }
        // never given up on "dead" while the escrow cannot be read (the ninth review round, 2026-11-04, B-F1): an endpoint that misread the
        // escrow and the funding's call had abandoned a funded order — its funds in the escrow, no tick, "Review again" its only action
        if ((fate === "dead" && bal !== null) || (fate === null && bal !== null && now > windowEndOf(stored))) {
          const detail = "Its funding was sent but never confirmed; a funding is never sent twice on its own.";
          patchSwap(a.orderId, { paused: { code: "funding_unconfirmed", detail, at: now } }, s);
          abandonSwap(a.orderId, s, { fundingDead: fate === "dead" });
          cancelAction(a.id, s);
          const st = journaled(a.orderId, s)!;
          syncSwapRecord(st, null, null, now, s);
          return { step: "stopped", stored: st };
        }
        if (stored.paused?.code !== "reconcile") {
          const detail = "A funding was sent and is not confirmed yet; the escrow is read before anything is sent again.";
          patchSwap(a.orderId, { paused: { code: "reconcile", detail, at: now } }, s);
          syncSwapRecord(journaled(a.orderId, s)!, null, null, now, s);
        }
        tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
        return { step: "paused", stored: journaled(a.orderId, s)! };
      } else {
        // The executor already has this order (audit round 2, r45): another copy of this wallet — a backup restored while the
        // first device kept running — funded and handed it over, and this record never learned it. It is tracked from now
        // on, never funded again: its escrow, executed, read empty, and a second funding swapped the amount twice
        const elsewhere = await io.job(stored).catch(() => null);
        if (elsewhere) {
          patchSwap(
            a.orderId,
            { jobId: elsewhere.id, state: foundState(elsewhere), paused: undefined, ...(elsewhere.at ? { relayerUrl: elsewhere.at } : {}) },
            s,
          );
          syncSwapRecord(journaled(a.orderId, s)!, null, isOpenSwap({ state: elsewhere.state }) ? elsewhere : null, now, s);
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
          syncSwapRecord(st, null, null, now, s);
          return { step: "stopped", stored: st };
        }
        // a funding delayed for privacy asks a fresh minimum first (audit round 2, n58): 1–24 h after its Review the market can
        // have moved, and a minimum found moved only once it was funded paused an escrow whose "Return funds" waited a day for
        // its refund time, the fee note and the tip spent for nothing. Moved now, the order waits for the user unfunded; a check
        // that cannot be made funds it as before, and the signing after the funding has its own pauses and retries
        if (stored.runner?.delayUntil && io.precheck) {
          schedulerStatus.progress("Swap: checking a fresh quote before funding…");
          // only a check that could not be made funds as before (the eleventh review round, D11-7): a refusal the signing would repeat — a provider
          // call or a prepared order that does not do what was asked, a receipt that is not this wallet's, a record without its minimum — stops the
          // order here, unfunded; it had been funded, and the signing then paused a funded escrow whose return waited for its refund time. A
          // prepared call's deadline is the moment's (a slow answer), never a refusal
          let refused: string | null = null;
          const moved = await io.precheck(stored).catch((e: unknown) => {
            if (
              e instanceof ProviderCallMismatch ||
              e instanceof ShieldReceiptMismatch ||
              e instanceof RecordIncomplete ||
              (e instanceof OrderMismatch && e.field !== "deadline")
            )
              refused = e.message;
            return null;
          });
          if (refused !== null) {
            patchSwap(a.orderId, { paused: { code: "call_refused", detail: refused, at: now } }, s);
            abandonSwap(a.orderId, s);
            cancelAction(a.id, s);
            const st = journaled(a.orderId, s)!;
            syncSwapRecord(st, null, null, now, s);
            return { step: "stopped", stored: st };
          }
          if (moved) {
            patchSwap(a.orderId, { paused: { code: "minimum_moved", at: now, minOut: moved.minOut.toString(), approved: moved.approved.toString() } }, s);
            const st = journaled(a.orderId, s)!;
            syncSwapRecord(st, null, null, now, s);
            cancelAction(a.id, s);
            return { step: "paused", stored: st };
          }
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
          // closed while its funding was proved (the ninth review round, C-04): read again at the send, nothing was sent; the close stands
          if (code === "order_closed") {
            cancelAction(a.id, s);
            const st = journaled(a.orderId, s)!;
            syncSwapRecord(st, null, null, now, s);
            return { step: "stopped", stored: st };
          }
          if (
            !sent &&
            (code === "older_notes_unavailable" ||
              code === "relayer_not_ready" ||
              code === "service_key_changed" ||
              code === "order_outdated" ||
              code === "order_not_ours" ||
              code === "fee_moved" ||
              code === "merges_moved" ||
              code === "tip_stale" ||
              code === "order_expired")
          ) {
            // "Delay for more privacy": the older notes the Review showed no longer cover the order and nothing was sent —
            // it is stopped unfunded (its escrow's window cannot wait 1–24 h), never paid from younger notes. Or the relayer
            // that would execute it does not run it, or the swap service no longer takes its vouch (a V6 follow-up of
            // 2026-10-16), or an older build committed it under the privacy address's owner commitment (c18), or its window
            // closed between this tick's check and the funding's own (audit round 2, n20; it waited out the scheduler's
            // backoff): stopped before anything moved
            patchSwap(a.orderId, { paused: { code, detail: (e as Error).message, at: now } }, s);
            abandonSwap(a.orderId, s);
            cancelAction(a.id, s);
            const st = journaled(a.orderId, s)!;
            syncSwapRecord(st, null, null, now, s);
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
      syncSwapRecord(st, null, null, now, s);
      tickAt(a.orderId, now + 1000, s, now); // the next tick signs
      return { step: "funded", stored: st };
    }
    // 4. sign while the minimum holds, and hand over at once — while the order can still execute. Once its execution window
    // has closed with nothing handed over (the executor was asked above) the escrow only refunds: the order stops for the
    // user's "Return funds". A V6 follow-up of 2026-10-14: such an order — a tab closed after its funding, a moved minimum
    // left for an hour, a long outage — retried its signature on the scheduler's growing backoff for good, every attempt
    // refused as outside the window, and its screen offered no way back.
    if (now >= windowEndOf(stored)) {
      // "nothing was swapped" only when it is so (the ninth review round, 2026-11-04, C-09): no hand-over attempted, and the escrow still
      // holds the order — past its deadline nothing executes it. A hand-over whose answer was lost, or an escrow read short or not at all,
      // is an outcome not known yet: the executor is asked again (step 1) until it answers, and Return funds stays offered. Before, the
      // window's end had replaced the reconcile pause with "nothing was swapped" and stopped the ticks, the swap possibly executed
      // with an attempt journaled, the escrow still holding the whole order HANDOVER_SETTLE_MS past the window settles it too (the tenth review
      // round, A10-3): nothing executes past the deadline, and a hand-over the service refused had been asked of the executor every minute for good
      // on the chain's clock too (the eleventh review round, 2026-11-04, B11-4): a device clock minutes fast had settled "nothing was swapped"
      // while the chain still accepted the execution. Its time read not at all: not settled, asked again
      const chainNow = io.chainTime ? await io.chainTime().catch(() => null) : now;
      const settled =
        stored.handOverAttempt === undefined ||
        (now >= windowEndOf(stored) + HANDOVER_SETTLE_MS && chainNow !== null && chainNow > windowEndOf(stored) + CHAIN_SETTLE_MS);
      const held = settled ? await io.escrowBalance(stored) : null;
      if (held !== null && held >= amount)
        return pause(
          "execution_window_closed",
          "Its execution window closed before it was carried out; the escrow still holds the order, so nothing was swapped.",
        );
      const unknown =
        stored.paused?.code === "handover_unknown"
          ? { step: "waiting" as const, stored }
          : pause(
              "handover_unknown",
              stored.handOverAttempt !== undefined
                ? "Its hand-over's answer was lost and its execution window has closed; the executor is asked again until it answers."
                : "Its execution window has closed and its escrow does not read as holding the order; the executor is asked again until it answers.",
            );
      // asked again soon after the window, then less often (A10-3): every minute for ten minutes, every ten for the hour, hourly after
      const past = now - windowEndOf(stored);
      tickAt(a.orderId, now + (past < 10 * 60_000 ? HANDOVER_RECHECK_MS : past < 3_600_000 ? 10 * 60_000 : 3_600_000), s, now);
      return unknown;
    }
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
        // the wallet's own checks of the call, never an answer of the swap service (audit round 2, r35): a refusal whose words
        // named the escrow ("more than the escrow may pay") had stopped a funded order for good as an unsafe call
        if (!(e instanceof ApiError) && /receiver|does not do what this wallet asked for|escrow|digest|not the one this wallet committed|pinned/i.test(m))
          return pause("unsafe_contract_call", m);
        // the service's price guard refused the hard quote (a route far below the best alternative): the user tries again or returns the funds
        // by its code only (the ninth review round, 2026-11-04, A9-5): the service's 503 `guard_unavailable` — "the price guard's competition
        // could not run" — had matched the words and paused a funded order for the user; it is an outage, tried again below
        if ((e as { code?: unknown })?.code === "price_guard") return pause("execution_unavailable", m);
      }
      // the gateways did not answer (an outage, never an unsafe call), or the network failed before anything was signed: the
      // funded order tries again within the minute, inside its window — never the scheduler's backoff of 10 minutes, then
      // 20, which outran a 30-minute window and left the order only its refund (2026-10-17, the audit's unverified m40)
      const wait = signRetryMs(stored, now);
      schedulerStatus.progress(
        `Swap: the execution could not be prepared yet (${m.split("\n")[0].slice(0, 120)}); trying again in ${Math.max(1, Math.round(wait / 60_000))} min…`,
      );
      tickAt(a.orderId, now + wait, s, now);
      return { step: "waiting", stored: journaled(a.orderId, s)! };
    }
    if ("moved" in r) {
      if (r.prepared) movedCalls.set(key, { prepared: r.prepared, minOut: r.moved.minOut });
      patchSwap(a.orderId, { paused: { code: "minimum_moved", at: now, minOut: r.moved.minOut.toString(), approved: r.moved.approved.toString() } }, s);
      const st = journaled(a.orderId, s)!;
      syncSwapRecord(st, null, null, now, s);
      cancelAction(a.id, s);
      return { step: "paused", stored: st };
    }
    if (!r.sim.ok) return pause("execution_unavailable", r.sim.reason ?? "the execution's simulation failed");
    // reconcile before the hand-over: the executor by orderId (another tab may have handed it over)
    const existing = await io.job(stored);
    if (existing) {
      patchSwap(a.orderId, { jobId: existing.id, state: foundState(existing), ...(existing.at ? { relayerUrl: existing.at } : {}) }, s);
    } else {
      // the journal read again before the hand-over (the sixth review round, 2026-11-03): the user's Return funds, a pause or another
      // tab's hand-over may have landed while the executor was asked — a signed call handed over after a refund began raced it
      const latest = journaled(a.orderId, s);
      if (!latest || latest.jobId || latest.paused || !isOpenSwap(latest)) {
        tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
        return { step: "waiting", stored: latest ?? stored };
      }
      schedulerStatus.progress("Swap: handing the signed execution to the executor…");
      // the attempt journaled before it is sent (the ninth review round, 2026-11-04, C-09), as a funding's is: a hand-over whose answer is
      // lost is never read "nothing was swapped" at the window's end. Journaled right before the executor is asked, after the swap service's
      // finalize, with the relayer it goes to (the tenth review round, A10-3): one the service refused had reached no executor. A refusal that
      // sent nothing puts the earlier mark back
      const before = stored.handOverAttempt;
      // whether the executor was asked (the eleventh review round, 2026-11-04, B11-3): only a refusal before it puts the earlier mark back — the
      // relayer's own error text, matched as the wallet's, had erased an attempt it may have executed
      let asked = false;
      try {
        await io.handOver(stored, r, (relayerUrl) => {
          asked = true;
          patchSwap(a.orderId, { handOverAttempt: now, relayerUrl }, s);
        });
      } catch (e) {
        const m = (e as Error)?.message ?? String(e);
        // the call came too close to its deadline, here or at the relayer (audit round 2, r02): nothing was handed over, and
        // the next tick prepares and signs a fresh one — no pause for the user, nor the reconcile backoff
        if ((e as { code?: unknown })?.code === "deadline_too_close") {
          if (!asked) patchSwap(a.orderId, { handOverAttempt: before }, s);
          tickAt(a.orderId, now + 1000, s, now);
          return { step: "waiting", stored: journaled(a.orderId, s)! };
        }
        // a refusal before the executor was asked: nothing was handed over. After it (the relayer's own words — B11-3), the outcome is not known:
        // the reconcile pause below, never "nothing was handed over" (the critique)
        if (/Not handed over|builds for/i.test(m) && !asked) {
          patchSwap(a.orderId, { handOverAttempt: before }, s);
          return pause("execution_unavailable", m);
        }
        const p = pause("reconcile", `The hand-over ended without a known outcome (${m}); the executor is asked before anything is sent again.`);
        tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
        return p;
      }
    }
    const st = journaled(a.orderId, s)!;
    syncSwapRecord(st, null, null, now, s);
    tickAt(a.orderId, now + ORDER_TRACK_MS, s, now);
    return { step: "handed-over", stored: st };
  } catch (e) {
    threw = true;
    throw e;
  } finally {
    schedulerStatus.finish();
    // handed over, paused for the user, over — or thrown to the scheduler's backoff: the critical section ends (the next tick takes it again)
    const st = journaled(a.orderId, s);
    if (!st || threw || st.jobId || st.paused || !isOpenSwap(st) || refundNotesBack(st)) releaseHandOver(a.orderId);
  }
}
