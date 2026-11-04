// Private balance maintenance (plan V2 §73–§74; whale spec §25): the housekeeping planner
// (packages/protocol/src/wallet/noteStrategy.ts) applied to this wallet's notes, one private
// self-transfer per scheduled step at a random time inside the policy window, each paying the relayer's
// fee note, bounded by the daily fee cap in Settings and switched off by the opt-out. The scheduler at the
// App level runs the steps on any screen while the wallet is unlocked; Home says what is planned.
import { planHousekeeping, shapeSummary, type HousekeepingAction, type ShapeReport } from "@privacy-wallet/protocol/wallet/noteStrategy";
import type { Deployment } from "../chain";
import { assetsOf, type Asset } from "../assets";
import { FeeMoved, feeTerms, mergeNotes, splitNote } from "../privateTx";
import { DELAY_WINDOW, policyFromPreference } from "../policy";
import { noteStore, type OwnedNote } from "./notes";
import { pendingActions, sampleDueAt, scheduleAction } from "./schedule";
import { session as defaultSession, type WalletSession } from "./session";
import { settings } from "./settings";

export interface AssetPlan { asset: Asset; actions: HousekeepingAction[]; shape: ShapeReport }

/** The plan per asset of the deployment from the wallet's unspent notes (a fee of 0 for the shape alone). */
export function housekeepingPlan(deployment: Deployment | null, feePerTx: bigint | ((a: Asset) => bigint) = 0n, maxActions?: number): AssetPlan[] {
  return assetsOf(deployment).map((asset) => {
    const notes = noteStore.unspent(BigInt(asset.vault)).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount }));
    const fee = typeof feePerTx === "function" ? feePerTx(asset) : feePerTx;
    const { actions, shape } = planHousekeeping(notes, { decimals: asset.decimals, feePerTx: fee, maxActions });
    return { asset, actions, shape };
  });
}

export const plannedSteps = (plans: AssetPlan[]): number => plans.reduce((s, p) => s + p.actions.length, 0);
export const housekeepingSummary = (plans: AssetPlan[]): string => {
  const first = plans.find((p) => !p.shape.ok);
  return first ? shapeSummary(first.shape, plannedSteps(plans)) : "Your private balance is kept in common-sized pieces.";
};

/** The scheduled housekeeping action, if any (one at a time; each step schedules the next under a new id). */
export const pendingHousekeeping = (s: WalletSession = defaultSession) => pendingActions(s).find((a) => a.kind === "housekeeping") ?? null;

/** The window a step is drawn in: the preference's policy window, never immediate (quiet times, plan §73). */
export function housekeepingWindow(): [number, number] {
  const w = DELAY_WINDOW[policyFromPreference(settings.get().preference)];
  return w[1] === 0 ? DELAY_WINDOW.balanced : w;
}

/** Schedule the next step if maintenance is on, something is planned and nothing is pending. `now` for an immediate first step (the user asked). */
export function scheduleHousekeeping(deployment: Deployment | null, o: { now?: boolean; session?: WalletSession } = {}): boolean {
  const s = o.session ?? defaultSession;
  if (!s.isUnlocked() || !deployment) return false;
  if (!o.now && !settings.get().housekeeping.enabled) return false;
  if (pendingHousekeeping(s)) return false;
  if (plannedSteps(housekeepingPlan(deployment)) === 0) return false;
  const dueAt = o.now ? Date.now() : sampleDueAt(housekeepingWindow());
  scheduleAction({ kind: "housekeeping", orderId: `balance:${Date.now()}`, dueAt }, s);
  return true;
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
/** What today's steps have spent on fees, from the journal. */
export function spentToday(s: WalletSession = defaultSession, now = Date.now()): { feeWei: bigint; steps: number } {
  const h = s.isUnlocked() ? s.journal().housekeeping : undefined;
  return h && h.day === dayOf(now) ? { feeWei: BigInt(h.feeWei), steps: h.steps } : { feeWei: 0n, steps: 0 };
}

export interface StepDeps {
  masterSeed: Uint8Array; deployment: Deployment; session?: WalletSession; now?: number; onStatus?: (line: string) => void;
  /** tests: the fee per step and the executors (an executor may answer the fee it paid) */
  fee?: (asset: Asset) => Promise<bigint>;
  exec?: { split: (asset: Asset, note: OwnedNote, piece: bigint) => Promise<void | bigint>; merge: (asset: Asset, a: OwnedNote, b: OwnedNote) => Promise<void | bigint> };
}

/**
 * One maintenance step: plan on the current notes with the live fee, run the first action within today's
 * fee cap, record the fee, and schedule the next step (or the next day's) if anything remains.
 */
export async function runHousekeepingStep(d: StepDeps): Promise<{ ran: HousekeepingAction | null; remaining: number; waitedForCap: boolean }> {
  const s = d.session ?? defaultSession;
  const now = d.now ?? Date.now();
  const cfg = settings.get().housekeeping;
  if (!cfg.enabled) return { ran: null, remaining: 0, waitedForCap: false };
  const feeOf = d.fee ?? (async (asset: Asset) => (await feeTerms(d.deployment, settings.get().submission, asset.vault))?.fee.amount ?? 0n);
  const fees = new Map<string, bigint>();
  for (const a of assetsOf(d.deployment)) if (noteStore.unspent(BigInt(a.vault)).length) fees.set(a.vault, await feeOf(a));
  const plans = housekeepingPlan(d.deployment, (a) => fees.get(a.vault) ?? 0n);
  const plan = plans.find((p) => p.actions.length);
  if (!plan) return { ran: null, remaining: 0, waitedForCap: false };
  const action = plan.actions[0];
  const remaining = plannedSteps(plans) - 1;
  // the daily cap: measured in ETH-vault wei; a token fee counts by its own units against the same figure (a coarse bound, stated in Settings)
  const cap = BigInt(cfg.dailyFeeCapWei);
  const today = spentToday(s, now);
  if (today.feeWei + action.fee > cap) {
    const tomorrow = new Date(now); tomorrow.setUTCHours(24, 0, 0, 0);
    scheduleAction({ kind: "housekeeping", orderId: `balance:${now}`, dueAt: sampleDueAt(housekeepingWindow(), tomorrow.getTime()) }, s);
    d.onStatus?.(`Private balance maintenance: today's fee cap is reached; the next step is tomorrow.`);
    return { ran: null, remaining: remaining + 1, waitedForCap: true };
  }
  const notes = noteStore.unspent(BigInt(plan.asset.vault));
  const byId = (id: string) => notes.find((n) => String(n.leafIndex) === id)!;
  d.onStatus?.(`Private balance maintenance: ${action.reason} (${plan.asset.symbol})…`);
  // the step pays at most the fee its cap was checked against (the eighth review round, 2026-11-03, B-1): the split and the merge read
  // the relayer again when their turn comes, and had paid that second read whatever it said — up to the note less the piece
  const split = d.exec?.split ?? (async (_asset: Asset, note: OwnedNote, piece: bigint) => (await splitNote({ masterSeed: d.masterSeed, deployment: d.deployment, note, piece, maxFee: action.fee, onStatus: d.onStatus })).feeWei ?? 0n);
  const merge = d.exec?.merge ?? (async (_asset: Asset, a: OwnedNote, b: OwnedNote) => (await mergeNotes({ masterSeed: d.masterSeed, deployment: d.deployment, a, b, mergeFee: action.fee, onStatus: d.onStatus })).feeWei ?? 0n);
  let paid: bigint;
  try {
    const r = action.kind === "split" ? await split(plan.asset, byId(action.input.id), action.outputs[0]) : await merge(plan.asset, byId(action.inputs[0].id), byId(action.inputs[1].id));
    paid = typeof r === "bigint" ? r : action.fee;
  } catch (e) {
    if (!(e instanceof FeeMoved)) throw e;
    // the relayer now asks more than the step was checked against: nothing was sent, and the step waits for a later window
    scheduleAction({ kind: "housekeeping", orderId: `balance:${now}`, dueAt: sampleDueAt(housekeepingWindow(), now) }, s);
    d.onStatus?.("Private balance maintenance: the relayer's fee rose since this step was planned; it runs later.");
    return { ran: null, remaining: remaining + 1, waitedForCap: false };
  }
  // the fee paid is what is booked, never the planned one: the cap holds for what left (B-1)
  s.update((j) => { j.housekeeping = { day: dayOf(now), feeWei: (today.feeWei + paid).toString(), steps: today.steps + 1 }; });
  if (remaining > 0) scheduleAction({ kind: "housekeeping", orderId: `balance:${now}`, dueAt: sampleDueAt(housekeepingWindow(), now) }, s);
  return { ran: action, remaining, waitedForCap: false };
}
