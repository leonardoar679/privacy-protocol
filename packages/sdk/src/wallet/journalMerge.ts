// A backup's journal merged into this device's journal of the same wallet (the tenth review round, D-4; the twelfth, E12-1 and NF-1: by
// lineage). The device's journal is the base — what this device did last, kept as the phrase restore keeps it (n45) —, the backup's records
// the device does not hold are added, and an order, a campaign or an address-book entry both hold is merged by what each copy saw: the copy that
// saw everything the other saw, and more, wins; a fact is never undone (notes, Activity lines and other operation records both hold stay the
// device's, but for a success only the backup saw). Until the twelfth round a campaign, an order's state, a scheduled action and an address-book entry both
// held were the device's whole: a step the backup's installation committed and funded was committed again here (a second order for one
// piece, the first orphaned with its escrow), and a Pause, a Return the rest, an abandon or a retirement made there was undone (E12-1, NF-1).
import { OPEN, exposure, swappedInFull, withCampaignState, withTrancheState, type Campaign, type Tranche, type TrancheState } from "@privacy-wallet/protocol/wallet/campaign";
import type { AddressBookEntry, AddressLifecycle } from "@privacy-wallet/protocol/wallet/addressBook";
import { SWAP_CLOSED_STATES } from "../orderStates";
import { ADDRESS_INDEX_RESERVE, AI_FUNDING_RESERVE, fundedOf, fundingAttemptKey, fundingSeenOf, resumePast, type JournalData, type ScheduledAction, type StoredSwap } from "./journal";
import type { OperationRecord } from "./operationRecord";

/** A campaign's own end (wallet/campaigns.ts TERMINAL_STATES, which this module does not import: its session and runners come with it). */
export const CAMPAIGN_ENDED: readonly Campaign["state"][] = ["completed", "cancelled"];

type Entry = { state: string; at: number };
const entryKey = (h: Entry): string => `${h.state}|${h.at}`;

/** Every entry of `b`'s history is in `a`'s, by its state and its time: `a` saw everything `b` saw. */
export const covers = (a: readonly Entry[] | undefined, b: readonly Entry[] | undefined): boolean => {
  const have = new Set((a ?? []).map(entryKey));
  return (b ?? []).every((h) => have.has(entryKey(h)));
};

/**
 * Which copy saw everything the other saw: `device`, `backup`, `equal` (each saw what the other saw), or `diverged` — each saw something the
 * other did not: both copies ran it after their common point (one wallet used on two installations at once, gap 51). A history is compared
 * by containment, not by prefix: a tick's write merges an answer the user gave meanwhile in time order (campaigns.ts keepDecisions), so an
 * entry can land before the last one an older copy holds.
 */
export type Lineage = "device" | "backup" | "equal" | "diverged";
export function lineageOf(device: readonly Entry[] | undefined, backup: readonly Entry[] | undefined): Lineage {
  const d = covers(device, backup);
  const b = covers(backup, device);
  return d && b ? "equal" : d ? "device" : b ? "backup" : "diverged";
}

/** Both histories, each entry once (its state and its time), in time order — the first copy's (the block's) first among entries of one time. */
function unionHistory<T extends Entry>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const h of [...(a ?? []), ...(b ?? [])]) {
    const k = entryKey(h);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out.sort((x, y) => x.at - y.at);
}

const union = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined, key: (x: T) => string): T[] => {
  const have = new Set((a ?? []).map(key));
  return [...(a ?? []), ...(b ?? []).filter((x) => !have.has(key(x)))];
};

// ---- orders ----------------------------------------------------------------------------------------------------------------------------

/** An order's funding facts (A11-1): each one the copy taken lacks comes from the other, never undone (the funding sent has its own rule: mergeOrder). */
const FUNDING_FACTS = ["fundedTx", "fundedAt", "fundedFee", "jobId", "handedOverAt", "handOverAttempt", "executionTx", "executionRef", "relayerUrl"] as const;
/** The closed states a late refund reopens (gap 91): `abandoned` has its own rule. */
const REOPENABLE: readonly string[] = ["completed", "refunded", "lapsed"];

/**
 * Whether an order carries a funding: one seen land, a hand-over, a job — or a funding sent on an order not closed. An order is given up with a
 * funding sent only once that funding was read dead (swapFunding.ts abandonSwap's `fundingDead`; it keeps the attempt), and a closed order's
 * attempt with no funding seen is no funding: read as one, the runner had taken up an order its own route change gave up, given it up again at
 * the next tick, and so on for good (the critique of 12e1, YR).
 */
export const hasFunding = (o: StoredSwap): boolean => fundedOf(o) || (!!o.fundingAttempt && !SWAP_CLOSED_STATES.includes(o.state));

/** The funding an abandoned copy holds was read dead (abandonSwap gives up an order with a funding sent only with `fundingDead`): its key. */
const deadAttemptOf = (o: StoredSwap): string | null => (o.state === "abandoned" && o.fundingAttempt && !fundedOf(o) ? fundingAttemptKey(o.fundingAttempt) : null);

const lastReading = (o: StoredSwap): number => Math.max(o.track?.at ?? 0, o.history?.[o.history.length - 1]?.at ?? 0, o.paused?.at ?? 0);

/**
 * The copy an order's state block comes from — its `state`, its `track` and its `paused` (W6 §1):
 * - the copy whose history holds the other's, and more; equal histories, the device's; diverged, the later last reading;
 * - an abandon writes no history: an `abandoned` copy beside an open one wins only while the order carries no funding — with one, the other
 *   copy's block stands (never an abandoned order whose escrow holds money: no tick, no Return funds);
 * - a close by a refund or a settle writes no history either: an open block beside a closed copy (completed, refunded, lapsed) stands only when
 *   its history holds a LATE_REFUND reading later than the closed copy's last one (gap 91's reopen, its Return funds) — a closed copy whose last
 *   reading is that very reopen was closed after it (its refund came back: it stays closed); any other open block yields to the closed one
 *   (C12-3: a reading that did not settle never reopens a closed order — nor does a merge, from a backup an older build wrote).
 */
export function orderBlockFrom(device: StoredSwap, backup: StoredSwap, funded: boolean): "device" | "backup" {
  const l = lineageOf(device.history, backup.history);
  let from: "device" | "backup" = l === "backup" ? "backup" : l === "diverged" && lastReading(backup) > lastReading(device) ? "backup" : "device";
  const dAbandoned = device.state === "abandoned";
  const bAbandoned = backup.state === "abandoned";
  if (dAbandoned !== bAbandoned) from = (dAbandoned ? !funded : funded) ? "device" : "backup";
  const chosen = from === "device" ? device : backup;
  const other = from === "device" ? backup : device;
  if (!SWAP_CLOSED_STATES.includes(chosen.state) && REOPENABLE.includes(other.state)) {
    const closedAt = other.history?.[other.history.length - 1]?.at ?? 0;
    const reopened = (chosen.history ?? []).some((h) => h.state === "LATE_REFUND" && h.at > closedAt);
    if (!reopened) from = from === "device" ? "backup" : "device";
  }
  return from;
}

/**
 * An order both journals hold: the block's copy, with every fact of the other it lacks and both histories. `abandonOverridden: true` when one copy
 * gave the order up and the merge keeps the other's block for its funding — that copy's record (Cancelled at the abandon) is no longer this
 * order's. A funding one copy read dead and gave the order up for is no funding (the critique of 12e1, YR: the abandon had been undone by the
 * very attempt it was read dead for, the order back open on the Swap screen with no Abandon button).
 */
export function mergeOrder(device: StoredSwap, backup: StoredSwap): { swap: StoredSwap; from: "device" | "backup"; abandonOverridden: boolean } {
  // ... and every attempt either copy read dead and cleared to fund again (the critique of 12e1, YT: the give-up that followed held no attempt, and an
  // older backup holding that one in flight had brought the order back open)
  const dead = new Set([deadAttemptOf(device), deadAttemptOf(backup), ...(device.deadAttempts ?? []), ...(backup.deadAttempts ?? [])].filter((k): k is string => k !== null));
  const live = (o: StoredSwap): boolean => !!o.fundingAttempt && !dead.has(fundingAttemptKey(o.fundingAttempt));
  const funded = fundedOf(device) || fundedOf(backup) || live(device) || live(backup);
  const from = orderBlockFrom(device, backup, funded);
  const abandonOverridden = (device.state === "abandoned") !== (backup.state === "abandoned") && funded;
  const base = from === "device" ? device : backup;
  const other = from === "device" ? backup : device;
  const out = { ...base } as StoredSwap;
  const write = out as unknown as Record<string, unknown>;
  const read = other as unknown as Record<string, unknown>;
  for (const k of FUNDING_FACTS) {
    if (write[k] !== undefined || read[k] === undefined) continue;
    write[k] = read[k];
    // the mark that the transaction is the escrow's own Executed event's comes with it (orderTracker.ts, XB's critique)
    if (k === "executionTx" && other.executionFromEvent) out.executionFromEvent = true;
  }
  // the escrow's `executed` flag once read true never goes back but by a unanimous read that says otherwise (XV's critique): the next read decides
  if (other.escrowExecutedSeen && !out.escrowExecutedSeen) out.escrowExecutedSeen = true;
  // the funding sent (one per order): the live one, the base's or else the other's — a copy that read an attempt dead and sent a new one keeps the
  // new one whichever copy's block is taken (pass 4's mutants of 12e1: the base's dead attempt had stood over the other's new one, then been
  // dropped as dead, the new funding lost and a third one sent). None live, an open order holds none (the runner would wait on a dead
  // attempt's fate again) and an abandoned one keeps its own (it tells why it was given up)
  const attempt = live(base) ? base.fundingAttempt : live(other) ? other.fundingAttempt : out.state === "abandoned" ? base.fundingAttempt : undefined;
  // ... with its transaction from either copy: journaled after the send, a copy taken before it holds the attempt without it
  const twin = attempt && other.fundingAttempt && fundingAttemptKey(other.fundingAttempt) === fundingAttemptKey(attempt) ? other.fundingAttempt : undefined;
  if (attempt) out.fundingAttempt = !attempt.txHash && twin?.txHash ? { ...attempt, txHash: twin.txHash } : attempt;
  else delete out.fundingAttempt;
  if (dead.size) out.deadAttempts = [...dead];
  if (base.refunds || other.refunds) out.refunds = union(base.refunds, other.refunds, (r) => `${r.leafIndex}`);
  if (base.shield && other.shield) {
    const job = !base.shield.job ? other.shield.job : !other.shield.job ? base.shield.job : other.shield.job.at > base.shield.job.at ? other.shield.job : base.shield.job;
    out.shield = {
      ...base.shield,
      ...(base.shield.registeredAt === undefined && other.shield.registeredAt !== undefined ? { registeredAt: other.shield.registeredAt } : {}),
      ...(job ? { job } : {}),
      ...(base.shield.leaves || other.shield.leaves ? { leaves: union(base.shield.leaves, other.shield.leaves, (x) => `${x.leafIndex}`) } : {}),
    };
  } else if (!base.shield && other.shield) out.shield = other.shield;
  if (base.history || other.history) out.history = unionHistory(base.history, other.history);
  return { swap: out, from, abandonOverridden };
}

// ---- campaigns -------------------------------------------------------------------------------------------------------------------------

/** A step of the plan alone — planned or ready, with no order: a resize or a re-plan rewrites it (W6 §1), and nothing left the private balance for it. */
const unordered = (t: Tranche): boolean => (t.state === "planned" || t.state === "ready") && !t.orderId;
const stepAt = (c: Campaign, index: number): Tranche | undefined => c.tranches.find((t) => t.index === index);

/**
 * `x` holds `y`'s step `t` (descends): by its history held at its index in `x`; else, a step committed to an order the merged journal holds given up
 * — `x` gave it up and went on, whatever its step there holds now (the critique of 12e1, YV: a re-size after the give-up had
 * rewritten it, and a sequential A → B → A read as both copies running it); else, a step of the plan alone (planned or ready) unless `x`'s step
 * there still holds a commit `y`'s step gave up, without the give-up (YT: counted as plan, the device's step had kept the order the backup's copy
 * gave up — refused at every funding until its window closed) — a fresh piece of a resize or a re-plan undoes nothing (YU: read as two copies
 * running it, the funded step unsigned until a Resume).
 */
function holds(x: Campaign, t: Tranche, givenUp: (orderId: string) => boolean): boolean {
  const there = stepAt(x, t.index)?.history;
  if (covers(there, t.history)) return true;
  if (t.state === "committed" && t.orderId && givenUp(t.orderId)) return true;
  if (!unordered(t)) return false;
  return !t.history.some((g) => g.state === "committed" && covers(there, [g]));
}

/**
 * `x` descends from `y`: `x`'s history holds `y`'s, and `x` holds every step of `y` (`holds`, by the merged orders `swaps`) — the copy that saw
 * everything the other saw (a newer backup over an older copy, A → B → A, E12-1; or an older backup over a newer copy, gap 118).
 */
export function descends(x: Campaign, y: Campaign, swaps: readonly StoredSwap[] = []): boolean {
  if (!covers(x.history, y.history)) return false;
  // (an abandon stands only while nothing funded the order: mergeOrder)
  const givenUp = (orderId: string): boolean => swaps.some((o) => o.orderId.toLowerCase() === orderId.toLowerCase() && o.state === "abandoned");
  return y.tranches.every((t) => holds(x, t, givenUp));
}

/** How far a step has come: every end ranks above every open state, so a terminal step never yields to an open one. */
const STEP_RANK: Record<TrancheState, number> = {
  planned: 0, ready: 1, committed: 2, funded: 3, signed: 4, failed: 5, executing: 5, "source-confirmed": 6, "destination-submitted": 7,
  "destination-confirmed": 8, partial: 9, refunding: 10, settled: 11, refunded: 11, undelivered: 11, skipped: 11,
};

/** One step both diverged copies hold in the common plan: the one whose history holds the other's; else the further along (an end over an open state). */
function mergeStep(base: Tranche, other: Tranche): Tranche {
  if (covers(base.history, other.history)) return base;
  if (covers(other.history, base.history)) return other;
  return STEP_RANK[other.state] > STEP_RANK[base.state] ? other : base;
}

const lastEvent = (c: Campaign): number =>
  Math.max(c.decidedAt ?? 0, c.history[c.history.length - 1]?.at ?? 0, ...c.tranches.map((t) => t.history[t.history.length - 1]?.at ?? 0));

/** The pause a campaign both copies ran on their own takes: nothing continues before every open step is read again. */
export const DIVERGED_DETAIL = "This protected execution ran on two copies of the wallet: every open step is read again from the chain and the executor before anything continues.";
/** The pause of a campaign whose steps a merge changed: a step one copy holds that the other did not know, or gave up, is taken up. */
export const TAKEN_UP_DETAIL = "One copy of this wallet holds a step the other did not know or gave up: it is taken up, and every open step is read again from the chain and the executor before anything continues.";
/** ... or two of its steps named one order (a journal an earlier merge wrote): the one further along is kept. */
export const ONE_ORDER_DETAIL = "Two steps of this protected execution named one order: the one further along is kept, and every open step is read again from the chain and the executor before anything continues.";

const stopped = (c: Campaign): boolean => c.state === "winding-down" || c.state === "cancelled";
/** A step's own ends (protocol campaign.ts TERMINAL): settled, refunded, skipped, undelivered. */
const STEP_ENDS: readonly TrancheState[] = ["settled", "refunded", "skipped", "undelivered"];

/** The steps whose money left the private balance and is not back (the commit's amount bound counts them): funded, or further along. */
export const ON_CHAIN_STEPS: readonly TrancheState[] = ["funded", "signed", "failed", "executing", "source-confirmed", "destination-submitted", "destination-confirmed", "partial", "refunding", "settled"];

/** A step whose money left the private balance or is on its way there: on chain, or committed to an order whose funding was sent or seen. */
export function fundedStep(t: Tranche, orderOf: (orderId: string) => StoredSwap | undefined): boolean {
  if (ON_CHAIN_STEPS.includes(t.state)) return true;
  const o = t.state === "committed" && t.orderId ? orderOf(t.orderId) : undefined;
  return !!o && hasFunding(o);
}

/**
 * The step an order is at by its own facts (an order taken up as a step that no copy's step holds): handed over — its executor runs it or
 * returns it —, funded, or committed with its funding sent. The next pass reads it further from the chain and the executor; a funded or handed
 * over order is never `committed`, which would fund it again.
 */
export function stepStateOf(o: StoredSwap): TrancheState {
  if (o.jobId || o.handedOverAt !== undefined) return o.state === "refund-only" ? "refunding" : "executing";
  return fundingSeenOf(o) ? "funded" : "committed";
}

/** A step for an order that no copy's step holds: its own size, provider, destination and facts. */
function stepOfOrder(o: StoredSwap, index: number, now: number): Tranche {
  const request = o.request as { amount?: string; destination?: string };
  const state = stepStateOf(o);
  return {
    index,
    amount: request.amount ?? "0",
    state,
    attempt: 1,
    orderId: o.orderId,
    ...(o.provider ? { provider: o.provider } : {}),
    ...(request.destination ? { destination: request.destination } : {}),
    ...(o.jobId ? { jobId: o.jobId } : {}),
    ...(o.handedOverAt !== undefined ? { handedOverAt: o.handedOverAt } : state === "executing" || state === "refunding" ? { handedOverAt: now } : {}),
    history: [{ state, at: now, note: "its order was committed on another copy of this wallet: taken up" }],
  };
}

interface Settled { tranches: Tranche[]; changed: boolean; tookUp: number; abandon: string[]; indexOf: Map<string, number> }

/**
 * Every order of a merged campaign named by one live step, once (W6 §1, items 2–3), whichever way the campaign merged:
 * - a step one copy gave up as never funded (skipped) whose order carries a funding the other copy sent or saw does not stand — the merge keeps
 *   the order for its funding (mergeOrder), and its step comes back as the funding copy's own step of it, else as one from the order's own facts
 *   (the critique of 12e1, YS: a Return the rest on one copy had left the other copy's funding with nothing following it);
 * - a step naming an order another step names further along is dropped (two merges of copies that both ran the campaign had named one order
 *   twice: 40 ETH of steps for a 30 ETH order, YR);
 * - an order no step names that carries a funding is taken up as a step of its own after the others — a copy's own step of it, else one from
 *   its own facts —; one that carries none and is still open is given up.
 * When a step came back, was dropped or was taken up, the steps of the plan alone go (planned or ready, with no order) — the runner plans the rest
 * again once nothing is in flight, and asks first when part of it came back (the seventh review round's B1) —; the plan never passes the order's
 * amount (`limit`) with a step nothing funded: the steps committed to an order with no funding sent go, the latest first, their orders given up —
 * past the amount, only steps each funded on chain already (gap 51) —; and every step is numbered by its position again.
 */
function settleOrders(id: string, steps: readonly Tranche[], copies: readonly Campaign[], swaps: readonly StoredSwap[], now: number, limit: bigint): Settled {
  const orderOf = (orderId: string): StoredSwap | undefined => swaps.find((o) => o.orderId.toLowerCase() === orderId.toLowerCase());
  const known = copies.flatMap((c) => c.tranches);
  const liveStepOf = (o: StoredSwap, index: number): Tranche => {
    const k = o.orderId.toLowerCase();
    const own = known.find((t) => t.orderId?.toLowerCase() === k && t.state !== "skipped");
    return own ? { ...own, index } : stepOfOrder(o, index, now);
  };
  let cameBack = 0;
  const live = steps.map((t) => {
    if (t.state !== "skipped" || !t.orderId) return t;
    const o = orderOf(t.orderId);
    if (!o || !hasFunding(o)) return t;
    cameBack++;
    return liveStepOf(o, t.index);
  });
  const best = new Map<string, Tranche>();
  for (const t of live) {
    if (!t.orderId) continue;
    const k = t.orderId.toLowerCase();
    const held = best.get(k);
    if (!held || STEP_RANK[t.state] > STEP_RANK[held.state]) best.set(k, t);
  }
  const kept = live.filter((t) => !t.orderId || best.get(t.orderId.toLowerCase()) === t);
  const orphans = swaps.filter((o) => o.campaign?.id === id && !best.has(o.orderId.toLowerCase()));
  const adopted = orphans.filter(hasFunding);
  const abandon = orphans.filter((o) => !hasFunding(o) && !SWAP_CLOSED_STATES.includes(o.state)).map((o) => o.orderId);
  if (!cameBack && !adopted.length && kept.length === live.length) return { tranches: [...steps], changed: false, tookUp: 0, abandon, indexOf: new Map() };
  const money = kept.filter((t) => !unordered(t));
  for (const o of adopted) money.push(liveStepOf(o, money.length));
  // the steps nothing funded never take the plan past the order's amount (the critiques of 12e1, YU and YV): an order taken up beside the other
  // copy's order for its piece — given up unfunded there, the piece planned again and committed — had planned 40 ETH for a 30 ETH order, the second
  // order funded by this device after the merge while the first one's funding landed
  let total = money.filter((t) => fundedStep(t, orderOf) || t.state === "committed").reduce((n, t) => n + BigInt(t.amount), 0n);
  for (let i = money.length - 1; i >= 0 && total > limit; i--) {
    const t = money[i];
    const o = t.state === "committed" && t.orderId ? orderOf(t.orderId) : undefined;
    if (!o || hasFunding(o)) continue;
    money.splice(i, 1);
    total -= BigInt(t.amount);
    if (!SWAP_CLOSED_STATES.includes(o.state)) abandon.push(o.orderId);
  }
  const tranches = money.map((t, index) => (t.index === index ? t : { ...t, index }));
  const indexOf = new Map<string, number>();
  for (const t of tranches) {
    if (!t.orderId) continue;
    const o = orderOf(t.orderId);
    if (o?.campaign && o.campaign.index !== t.index) indexOf.set(t.orderId.toLowerCase(), t.index);
  }
  return { tranches, changed: true, tookUp: adopted.length + cameBack, abandon, indexOf };
}

/**
 * The common plan of two diverged copies (one index, one amount) merged step by step, the rest from the base alone: two re-plans of one remainder
 * draw different pieces of it — mixed index by index, they had planned 46.9 ETH for a 29.9 ETH remainder.
 */
function divergedSteps(base: Campaign, other: Campaign): Tranche[] {
  const steps: Tranche[] = [];
  let i = 0;
  for (; i < base.tranches.length && i < other.tranches.length && base.tranches[i].amount === other.tranches[i].amount; i++) steps.push(mergeStep(base.tranches[i], other.tranches[i]));
  return [...steps, ...base.tranches.slice(i)];
}

interface CampaignMerge { campaign: Campaign; abandon: string[]; indexOf: Map<string, number> }

/**
 * A campaign both journals hold (W6 §1). The copy that descends from the other comes whole (equal: the device's) — unless its steps leave an order
 * of the campaign that carries a funding with no live step (settleOrders): one copy sent or saw a funding the other never learned of, or gave the
 * step up for (the critiques of 12e1, YR and YS: that escrow had been left with nothing tracking it). When neither descends — both copies ran it
 * after their common point (gap 51) —, the base is the copy with the later last event, the common plan is merged step by step and the rest comes
 * from the base. A campaign both copies ran, or whose steps the merge changed:
 * - with no step open, planned or ready, stays ended when either copy ended it (completed; cancelled when a copy cancelled it and the order was
 *   not swapped in full) — a swap both copies finished had come back paused, its completion notified twice (YS);
 * - otherwise winds down when either copy stopped it (its planned and ready steps skipped; a cancelled one with nothing open stays cancelled; the
 *   stop's own entry is in the merged history);
 * - otherwise pauses `reconcile` while a step is still open, planned or ready, or anything is left to swap — its planned steps dropped, the rest is
 *   still to come (the critique of 12e1, YT: left in a base that had not started, the reducer's first step had completed it with 10 ETH never
 *   swapped, the B1 question never asked); with nothing left, it stays as the base is: a running base's next tick completes it, a paused one waits
 *   for a Resume.
 * B1's question asked on a copy is asked again after such a merge (`replanAskedAt` dropped): a Resume of the merge's own pause had counted as the
 * user's word to swap a returned amount again, its fees paid a second time (the critique of 12e1, YU) — at worst one question more.
 */
export function mergeCampaign(device: Campaign, backup: Campaign, swaps: readonly StoredSwap[], now: number): CampaignMerge {
  const dDescends = descends(device, backup, swaps);
  const bDescends = descends(backup, device, swaps);
  const diverged = !dDescends && !bDescends;
  const base = dDescends ? device : bDescends ? backup : lastEvent(backup) > lastEvent(device) ? backup : device;
  const other = base === device ? backup : device;
  const settled = settleOrders(base.id, diverged ? divergedSteps(base, other) : base.tranches, [base, other], swaps, now, BigInt(base.bounds.amountInLimit));
  if (!diverged && !settled.changed) return { campaign: base, abandon: settled.abandon, indexOf: settled.indexOf };
  const { replanAskedAt: _asked, ...rest } = base;
  let c: Campaign = { ...rest, tranches: settled.tranches, history: unionHistory(base.history, other.history) };
  const decidedAt = Math.max(device.decidedAt ?? -Infinity, backup.decidedAt ?? -Infinity);
  if (Number.isFinite(decidedAt)) c = { ...c, decidedAt };
  const open = c.tranches.some((t) => OPEN.includes(t.state));
  const live = open || c.tranches.some((t) => t.state === "planned" || t.state === "ready");
  const cancelled = device.state === "cancelled" || backup.state === "cancelled";
  if (!live && (CAMPAIGN_ENDED.includes(device.state) || CAMPAIGN_ENDED.includes(backup.state))) {
    c = { ...c, state: cancelled && !swappedInFull(exposure(c)) ? "cancelled" : "completed", pause: undefined, pendingReroute: undefined };
  } else if (stopped(device) || stopped(backup)) {
    c = { ...c, state: cancelled && !open ? "cancelled" : "winding-down", pendingReroute: undefined };
    for (const t of c.tranches) if (t.state === "planned" || t.state === "ready") c = withTrancheState(c, t.index, "skipped", now, {}, "cancelled before it started");
  } else if (live || exposure(c).remaining > 0n) {
    c = withCampaignState(c, "paused", now, diverged ? "ran on two copies of this wallet" : settled.tookUp ? "a step one copy held, the other did not know or gave up" : "two steps named one order", {
      pause: { reason: "reconcile", detail: diverged ? DIVERGED_DETAIL : settled.tookUp ? TAKEN_UP_DETAIL : ONE_ORDER_DETAIL, at: now },
    });
  }
  return { campaign: c, abandon: settled.abandon, indexOf: settled.indexOf };
}

// ---- the address book -----------------------------------------------------------------------------------------------------------------

const STAGES: readonly AddressLifecycle[] = ["generated", "verified", "approved", "used", "settled"];
const later = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.max(a, b));

/**
 * An entry both journals hold (NF-1; ids are `chain:normalized`, so both copies of a destination share one), field by field: a retirement either
 * made stands (a protective decision a merge never undoes — the retired address had been paid again); otherwise the later stage; verified if
 * either verified it; the later approval, use, cooling-off and override; every use; the device's label, address and source; the earlier addition.
 */
export function mergeEntry(device: AddressBookEntry, backup: AddressBookEntry): AddressBookEntry {
  const lifecycle: AddressLifecycle =
    device.lifecycle === "retired" || backup.lifecycle === "retired" ? "retired" : STAGES[Math.max(STAGES.indexOf(device.lifecycle), STAGES.indexOf(backup.lifecycle))];
  const dv = device.verification;
  const bv = backup.verification;
  const verification = dv.status === "verified" && bv.status === "verified" ? ((bv.at ?? 0) > (dv.at ?? 0) ? bv : dv) : bv.status === "verified" ? bv : dv;
  const override = !device.override ? backup.override : !backup.override ? device.override : backup.override.at > device.override.at ? backup.override : device.override;
  const approvedAt = later(device.approvedAt, backup.approvedAt);
  const lastUsedAt = later(device.lastUsedAt, backup.lastUsedAt);
  const coolingUntil = later(device.coolingUntil, backup.coolingUntil);
  return {
    ...device,
    lifecycle,
    verification,
    ...(override ? { override } : {}),
    ...(approvedAt !== undefined ? { approvedAt } : {}),
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    ...(coolingUntil !== undefined ? { coolingUntil } : {}),
    usedBy: [...new Set([...device.usedBy, ...backup.usedBy])],
    addedAt: Math.min(device.addedAt, backup.addedAt),
  };
}

// ---- the schedule ---------------------------------------------------------------------------------------------------------------------

/**
 * The merged schedule follows the merged records, never either copy's entry blindly (W6 §1): one pending tick, due now, for every campaign not
 * ended (the runner reads every open step again before it acts; the counters held after the restore keep new commits waiting for a scan) — a
 * `done` tick of an unfinished campaign had stopped it for good —, none for an ended one; an order's funding or tick only while the order is
 * open, not a campaign's (the campaign runner funds those) and, for a funding, not funded; the note scan the device's own; maintenance never
 * from the backup (A11-9: a cancelled one had come back pending).
 */
export function mergeScheduleOf(device: readonly ScheduledAction[], backup: readonly ScheduledAction[], swaps: readonly StoredSwap[], campaigns: readonly Campaign[], now: number): ScheduledAction[] {
  const orders = new Map(swaps.map((o) => [o.orderId.toLowerCase(), o] as const));
  const ofCampaign = new Set(campaigns.map((c) => c.id));
  const out: ScheduledAction[] = [];
  for (const a of union(device, backup.filter((x) => x.kind !== "housekeeping" && x.kind !== "discovery"), (x) => x.id)) {
    if ((a.kind === "campaign-tick" || a.kind === "campaign-shape") && ofCampaign.has(a.orderId)) continue;
    if (a.kind === "fund-escrow" || a.kind === "order-tick") {
      const o = orders.get(a.orderId.toLowerCase());
      if (o && (SWAP_CLOSED_STATES.includes(o.state) || o.campaign || (a.kind === "fund-escrow" && fundedOf(o)))) continue;
    }
    out.push(a);
  }
  for (const c of campaigns) if (!CAMPAIGN_ENDED.includes(c.state)) out.push({ id: `campaign-tick:${c.id}`, kind: "campaign-tick", orderId: c.id, dueAt: now });
  return out;
}

// ---- the journal ----------------------------------------------------------------------------------------------------------------------

const swapRecordIdOf = (orderId: string): string => `swap:${orderId.toLowerCase()}`;
/** The ends a record reaches only by what happened (the money arrived, or came back): a copy that did not see them could not have concluded them. */
const SUCCESSES: readonly string[] = ["COMPLETED", "REFUNDED"];

/**
 * A uniform draw in [0, 1) from the CSPRNG (campaigns.ts cryptoUniform, which this module does not import): a merge's resume draws — where this
 * wallet's fresh addresses resume — are the wallet's privacy, never Math.random's (the critique of 12e1, YR).
 */
const cryptoUniform = (): number => {
  const u = new Uint32Array(1);
  crypto.getRandomValues(u);
  return u[0] / 2 ** 32;
};

/**
 * A backup's journal merged into this device's own journal of the same wallet (the tenth review round, D-4): the device's is the base, and the
 * backup's notes, orders, campaigns, schedule, operation records and address book entries the device does not hold are added (an order funded on
 * another device and not handed over is only there: its escrow had been stranded), the note counter the higher of the two.
 *
 * The eleventh review round (2026-11-04): an index the backup knows past what this device knows resumes past the reserve, as a restore does
 * (VF-N1, NF-1) — the backup's installation may have gone on after the backup, and a journal a restore began knows only its source (its
 * `resumedPast`), never what lies between it and its resume point; the backup's settings, deployment fingerprints, light-client store and
 * maintenance spend come where this device's journal has none (A11-1 — with both, the session merges the settings, settings.ts mergeSettings);
 * a maintenance action never comes from the backup (A11-9).
 *
 * The twelfth review round (E12-1, NF-1; W6 §1): a record both journals hold is merged by lineage — an order's state block and its operation
 * record from the copy that saw more (mergeOrder), its facts from both; a campaign whole from the copy it descends to, or merged step by step when
 * both ran it (mergeCampaign); an address-book entry field by field (mergeEntry); the schedule from the merged records (mergeScheduleOf). `now`:
 * the merge's time (the campaigns' ticks, a campaign's pause); `rng`: the resume draws.
 */
export function mergeJournals(device: JournalData, backup: JournalData, rng: () => number = cryptoUniform, now: number = Date.now()): JournalData {
  const known = device.resumedPast;
  const chainIndexes: Record<string, number> = { ...device.chainIndexes };
  for (const [k, b] of Object.entries(backup.chainIndexes)) {
    const d = device.chainIndexes[k] ?? 0;
    chainIndexes[k] = b > (known ? (known.chainIndexes[k] ?? 0) : d) ? Math.max(d, resumePast(b, ADDRESS_INDEX_RESERVE, rng)) : d;
  }
  const dAi = device.aiFunding?.index ?? 0;
  const bAi = backup.aiFunding?.index ?? 0;
  const aiPast = bAi > (known ? known.aiFunding : dAi) ? resumePast(bAi, AI_FUNDING_RESERVE, rng) : undefined;
  const ai = aiPast !== undefined && aiPast > dAi ? { index: aiPast } : device.aiFunding;
  // what this merged journal knows: the restore's source and the backup, never the resume points between them
  const resumedPast = known
    ? {
        chainIndexes: Object.fromEntries([...new Set([...Object.keys(known.chainIndexes), ...Object.keys(backup.chainIndexes)])].map((k) => [k, Math.max(known.chainIndexes[k] ?? 0, backup.chainIndexes[k] ?? 0)])),
        aiFunding: Math.max(known.aiFunding, bAi),
      }
    : undefined;

  // the orders, each both hold by lineage, with the copy its state block came from
  const backupSwaps = new Map(backup.swaps.map((o) => [o.orderId.toLowerCase(), o] as const));
  const blockFrom = new Map<string, "device" | "backup">();
  const abandonOverridden = new Set<string>();
  let swaps = union(
    device.swaps.map((o) => {
      const b = backupSwaps.get(o.orderId.toLowerCase());
      if (!b) return o;
      const m = mergeOrder(o, b);
      blockFrom.set(o.orderId.toLowerCase(), m.from);
      if (m.abandonOverridden) abandonOverridden.add(swapRecordIdOf(o.orderId));
      return m.swap;
    }),
    backup.swaps,
    (o) => o.orderId.toLowerCase(),
  );

  // the campaigns, each both hold by lineage; their orphans taken up or given up in the orders
  const backupCampaigns = new Map((backup.campaigns ?? []).map((c) => [c.id, c] as const));
  const abandon = new Set<string>();
  const indexOf = new Map<string, { id: string; index: number }>();
  const campaigns =
    device.campaigns || backup.campaigns
      ? union(
          (device.campaigns ?? []).map((c) => {
            const b = backupCampaigns.get(c.id);
            if (!b) return c;
            const m = mergeCampaign(c, b, swaps, now);
            for (const id of m.abandon) abandon.add(id.toLowerCase());
            for (const [id, index] of m.indexOf) indexOf.set(id, { id: c.id, index });
            return m.campaign;
          }),
          backup.campaigns,
          (c) => c.id,
        )
      : undefined;
  if (abandon.size || indexOf.size)
    swaps = swaps.map((o) => {
      const id = o.orderId.toLowerCase();
      const moved = indexOf.get(id);
      if (moved) return { ...o, campaign: moved };
      return abandon.has(id) ? { ...o, state: "abandoned" } : o;
    });

  // the operation records (the critique of 12e1, YS): an order's from the copy its state block came from — that copy's order and record moved
  // together —, the other copy's only where that copy has none, and never the Cancelled of an abandon the merge did not keep (YR: it had won by
  // I-O1, Activity reading Cancelled for good over money in the escrow; with no record of the funded copy, none — the order's next sync writes
  // it). Any other record both hold is this device's — it acted on its own record, and a Failed or a Cancelled the other copy concluded from less
  // (a Send it never saw sent, read interrupted) had hidden a payment that landed —, unless the backup's is a success this device did not see
  // (completed, refunded) and the device's is none: a Failed or a Cancelled here concluded from less (YT: one read interrupted had stood over
  // the payment's completion)
  const backupOps = new Map((backup.operations ?? []).map((r) => [r.id, r] as const));
  const deviceOps = new Map((device.operations ?? []).map((r) => [r.id, r] as const));
  const recordFrom = new Map([...blockFrom].map(([id, from]) => [swapRecordIdOf(id), from] as const));
  const recordOf = (id: string): OperationRecord | null => {
    const d = deviceOps.get(id);
    const b = backupOps.get(id);
    const from = recordFrom.get(id);
    if (from) {
      const pick = (from === "backup" ? b : d) ?? (from === "backup" ? d : b);
      return pick && !(abandonOverridden.has(id) && pick.state === "CANCELLED") ? pick : null;
    }
    if (!d || !b) return (d ?? b)!;
    return SUCCESSES.includes(b.state) && !SUCCESSES.includes(d.state) ? b : d;
  };
  const operations =
    device.operations || backup.operations
      ? [...new Set([...(device.operations ?? []), ...(backup.operations ?? [])].map((r) => r.id))].flatMap((id) => {
          const r = recordOf(id);
          return r ? [r] : [];
        })
      : undefined;

  // the address book, each entry both hold field by field (NF-1)
  const backupBook = new Map((backup.addressBook ?? []).map((e) => [e.id, e] as const));
  const addressBook =
    device.addressBook || backup.addressBook ? union((device.addressBook ?? []).map((e) => (backupBook.has(e.id) ? mergeEntry(e, backupBook.get(e.id)!) : e)), backup.addressBook, (e) => e.id) : undefined;

  return {
    ...device,
    ...(device.settings === undefined && backup.settings !== undefined ? { settings: backup.settings } : {}),
    ...(device.deploymentFingerprints || backup.deploymentFingerprints ? { deploymentFingerprints: { ...(backup.deploymentFingerprints ?? {}), ...(device.deploymentFingerprints ?? {}) } } : {}),
    ...(device.lightClient === undefined && backup.lightClient !== undefined ? { lightClient: backup.lightClient } : {}),
    ...(device.housekeeping === undefined && backup.housekeeping !== undefined ? { housekeeping: backup.housekeeping } : {}),
    ...(resumedPast ? { resumedPast } : {}),
    notes: union(device.notes, backup.notes, (n) => String(n.leafIndex)),
    noteCounter: Math.max(device.noteCounter, backup.noteCounter),
    chainIndexes,
    swaps,
    schedule: mergeScheduleOf(device.schedule, backup.schedule, swaps, campaigns ?? [], now),
    ...(campaigns ? { campaigns } : {}),
    ...(operations ? { operations } : {}),
    ...(device.activity || backup.activity ? { activity: union(device.activity, backup.activity, (x) => x.id) } : {}),
    ...(addressBook ? { addressBook } : {}),
    ...(ai ? { aiFunding: ai } : {}),
  };
}

/**
 * What a merged journal holds (W6 §1, item 3; test 5), as the tests read it: every campaign's steps at their own positions, no order named by two
 * steps (of one campaign or of two), every order of a campaign carrying a funding named by one of its steps — a live one, never a step given up
 * (skipped) —, no live step naming an order given up, no open step under an ended campaign, and no step not yet funded taking the plan past the
 * order's amount (past it only steps each funded on chain already: gap 51). Empty when it holds.
 */
export function mergedProblems(j: JournalData): string[] {
  const out: string[] = [];
  const namedBy = new Map<string, string>();
  const orderOf = (orderId: string): StoredSwap | undefined => j.swaps.find((x) => x.orderId.toLowerCase() === orderId.toLowerCase());
  for (const c of j.campaigns ?? []) {
    c.tranches.forEach((t, i) => {
      if (t.index !== i) out.push(`${c.id}: step ${i} carries index ${t.index}`);
    });
    const ids = c.tranches.flatMap((t) => (t.orderId ? [t.orderId.toLowerCase()] : []));
    if (new Set(ids).size !== ids.length) out.push(`${c.id}: an order named by two steps`);
    for (const id of new Set(ids)) {
      const by = namedBy.get(id);
      if (by !== undefined) out.push(`${id}: named by ${by} and by ${c.id}`);
      namedBy.set(id, c.id);
    }
    for (const o of j.swaps) if (o.campaign?.id === c.id && hasFunding(o) && !ids.includes(o.orderId.toLowerCase())) out.push(`${c.id}: funded order ${o.orderId} named by no step`);
    for (const t of c.tranches) {
      const o = t.state === "skipped" && t.orderId ? j.swaps.find((x) => x.orderId.toLowerCase() === t.orderId!.toLowerCase()) : undefined;
      if (o && hasFunding(o)) out.push(`${c.id}: funded order ${o.orderId} named only by a step given up`);
      const gone = t.orderId && !STEP_ENDS.includes(t.state) ? j.swaps.find((x) => x.orderId.toLowerCase() === t.orderId!.toLowerCase() && x.state === "abandoned") : undefined;
      if (gone) out.push(`${c.id}: step ${t.index} (${t.state}) names order ${gone.orderId}, given up`);
      if (CAMPAIGN_ENDED.includes(c.state) && !STEP_ENDS.includes(t.state)) out.push(`${c.id}: step ${t.index} (${t.state}) open under a campaign ${c.state}`);
    }
    let onChain = 0n;
    let unfunded = 0n;
    for (const t of c.tranches) {
      if (fundedStep(t, orderOf)) onChain += BigInt(t.amount);
      else if (t.state === "planned" || t.state === "ready" || t.state === "committed") unfunded += BigInt(t.amount);
    }
    if (unfunded > 0n && onChain + unfunded > BigInt(c.bounds.amountInLimit)) out.push(`${c.id}: steps not yet funded take the plan past the order's amount`);
  }
  return out;
}
