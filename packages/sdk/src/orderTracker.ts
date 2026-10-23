// Settlement tracking in the wallet (whale spec §19, §25; plan V2 §49, §60–§61, §96): the wallet runs
// the spec's state machine itself, from facts it can observe — its journal, the relayer's job (with the
// execution transaction it records once), the escrow's balance read through the RPC quorum, and the
// service's stateless GET /track/:provider for the destination side — and journals every transition
// with its time. The user sees the labels of plan §61 and the four-step line of plan §60; a funded order
// is never a bare "failed": the label says where the money is. Nothing here says "atomic". V6 Stage 12 (spec v2.0
// §11.2): a same-chain swap into the protected balance is complete when its delivered note is in the pool (the shield
// receipt's leaves), whatever the provider's own tracking says.
import type { Address } from "viem";
import { STALL_FACTOR } from "@privacy-wallet/protocol/wallet/campaign";
import { clientsFor, type Deployment } from "./chain";
import { erc20Abi } from "./privacyProtocol";
import { relayerSwapStatus, type SwapJob } from "./relayer";
import { swapService, type TrackResult } from "./swapService";
import type { StoredSwap } from "./wallet/journal";
import { session as defaultSession, type WalletSession } from "./wallet/session";
import { activityId, updateActivity } from "./wallet/activity";
import { markAddressSettled } from "./wallet/addressBook";
import { chainKindOf } from "./keys/chainKeys";
import { legsFrom, nextSettlement, type SettlementLegs } from "@privacy-wallet/protocol/wallet/settlement";
import type { SettlementState } from "@privacy-wallet/protocol-types";

/** The spec's states (packages/swap-engine/src/order.ts), as the wallet derives them. */
export type OrderState = "COMMITTED" | "SOURCE_SUBMITTED" | "SOURCE_FINAL" | "PROVIDER_EXECUTING" | "DESTINATION_SUBMITTED" | "DESTINATION_FINAL" | "COMPLETED" | "PARTIAL" | "REFUND_PENDING" | "PROVIDER_TIMEOUT" | "DESTINATION_FAILED" | "REFUNDED" | "EXPIRED" | "CANCELLED" | "FAILED";
/** Plan §61. */
export type SettlementLabel = "Preparing" | "Waiting for source" | "Executing" | "Waiting for destination" | "Partial" | "Refunding" | "Refunded" | "Completed" | "Not started" | "Needs attention";
export const STEPS = ["Quote locked", "Source confirmed", "Destination sent", "Destination finalized"] as const;

export interface TrackFacts {
  now: number;
  job: SwapJob | null;
  /** the escrow's balance in the order's asset, agreed by every endpoint; null when unknown */
  escrowBalance: bigint | null;
  track: TrackResult["track"] | null;
  /** the refund note of this order was found in the pool (PP-S09) */
  refundFound: boolean;
}
export interface Tracked {
  state: OrderState;
  label: SettlementLabel;
  /** the four steps of plan §60, done or not */
  steps: [boolean, boolean, boolean, boolean];
  /** one sentence: where the money is, what came back, what happens next */
  detail: string;
  deliveredAmount?: string;
  /** the delivered amount in the output's base units (the record's `delivered`; deliveredAmount is its words) */
  deliveredUnits?: string;
  refundedAmount?: string;
  destinationTxHash?: string;
  progress?: { parts: number; done: number };
  /** V6 (spec v2.0 §12.4): where the money is — kept from the last read when this one could not tell */
  settlement?: SettlementState;
}

const fmtUnits = (units: string | bigint | undefined, decimals: number): string => {
  if (units === undefined) return "?";
  const u = BigInt(units), base = 10n ** BigInt(decimals);
  const frac = (u % base).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return `${u / base}${frac ? `.${frac}` : ""}`;
};
const params = (s: StoredSwap) => s.params as { amount: string; executeDeadline: number; refundAfter: number };
/** The order's output and input decimals, for the track (a provider that tracks in its own units: audit c25). */
const decimalsOf = (s: StoredSwap): { outDecimals?: number; inDecimals?: number } => {
  const r = req(s);
  return { ...(Number.isInteger(r.to?.decimals) ? { outDecimals: r.to!.decimals } : {}), ...(Number.isInteger(r.from?.decimals) ? { inDecimals: r.from!.decimals } : {}) };
};
/** A tracker's base-unit amount, or 0 when it is not one. */
const unitsOf = (x: string | undefined): bigint => { try { return x === undefined ? 0n : BigInt(x); } catch { return 0n; } };
const req = (s: StoredSwap) => s.request as { from?: { symbol?: string; decimals?: number }; to?: { symbol?: string; decimals?: number } };

/**
 * V6 (spec v2.0 §12.4): the legs of a journaled order for settlementOf, through the derivation shared with the API
 * (legsFrom): the funding (the escrow's balance, or a job that saw it), the execution, the provider's side, the refund.
 * Null when the answer rests on a read that failed: the caller keeps the last settlement, never a downgrade.
 */
export function legsOf(s: StoredSwap, f: TrackFacts): SettlementLegs | null {
  const p = params(s);
  const shielded = (s.shield?.leaves?.length ?? 0) > 0; // the delivery is in the protected balance: the destination is final
  return legsFrom({
    fundingSent: fundedOf(s), abandoned: s.state === "abandoned", refundFound: f.refundFound || (s.refunds?.length ?? 0) > 0,
    job: f.job ? { state: f.job.state, ...(f.job.executionTx ? { executionTx: f.job.executionTx } : {}) } : null, jobUnread: !!s.jobId && !f.job,
    ...(s.executionTx ? { executionTx: s.executionTx } : {}), track: shielded ? { state: "destination-final" } : f.track, escrowBalance: f.escrowBalance, amount: BigInt(p.amount), executeDeadline: p.executeDeadline, now: Math.floor(f.now / 1000),
  });
}

/**
 * Whether the order's funding was sent: its transaction journaled, or the order journaled funded without one — reconciled
 * from the escrow's balance, or a funding that landed while its page was gone (audit round 2, r10): such an order read
 * "Funding is scheduled", then "nothing left your private balance", while its amount sat in the escrow.
 */
const fundedOf = (s: StoredSwap): boolean => !!s.fundedTx || s.state === "funded";

/** Pure: the state a wallet should show for a journaled order given what it observed (spec §19 "recoverState"), with the V6 settlement. */
export function deriveState(s: StoredSwap, f: TrackFacts): Tracked {
  const tracked = deriveOrderState(s, f);
  const settlement = nextSettlement(s.track?.settlement as SettlementState | undefined, legsOf(s, f));
  return settlement ? { ...tracked, settlement } : tracked;
}

function deriveOrderState(s: StoredSwap, f: TrackFacts): Tracked {
  const p = params(s), r = req(s);
  const nowS = Math.floor(f.now / 1000);
  const amount = BigInt(p.amount);
  const funded = fundedOf(s);
  const to = r.to ?? { symbol: "", decimals: 0 }, from = r.from ?? { symbol: "", decimals: 18 };
  const out = (state: OrderState, label: SettlementLabel, steps: Tracked["steps"], detail: string, extra: Partial<Tracked> = {}): Tracked => ({ state, label, steps, detail, ...extra });
  const t = f.track;
  const delivered = t?.deliveredAmount !== undefined ? `${fmtUnits(t.deliveredAmount, to.decimals ?? 0)} ${to.symbol ?? ""}`.trim() : undefined;
  const refunded = t?.refundedAmount !== undefined ? `${fmtUnits(t.refundedAmount, from.decimals ?? 18)} ${from.symbol ?? ""}`.trim() : undefined;
  const extras = { deliveredAmount: delivered, ...(t?.deliveredAmount !== undefined ? { deliveredUnits: String(t.deliveredAmount) } : {}), refundedAmount: refunded, destinationTxHash: t?.destinationTxHash, progress: t?.progress };

  if (s.state === "abandoned") return out("CANCELLED", "Not started", [true, false, false, false], "Abandoned before funding: nothing left your private balance.");
  const refundedToo = f.refundFound || (s.refunds?.length ?? 0) > 0;
  // V6 Stage 12: the delivered note found in the pool is the destination's settlement
  const leaves = s.shield?.leaves ?? [];
  if (leaves.length) {
    const units = leaves.reduce((a, l) => a + BigInt(l.amount), 0n);
    const got = `${fmtUnits(units, to.decimals ?? 18)} ${to.symbol ?? ""}`.trim();
    const into = { ...extras, deliveredAmount: got, deliveredUnits: units.toString() };
    if (refundedToo) return out("PARTIAL", "Partial", [true, true, true, true], `${got} added to your protected balance; the rest came back to the escrow and was re-shielded.`, into);
    return out("COMPLETED", "Completed", [true, true, true, true], `${got} added to your protected balance.`, into);
  }
  // a partial fill whose rest came back (a V6 follow-up of 2026-10-16, audit c32): the refund note is the remainder, not the order —
  // read as Refunded, a campaign re-planned and swapped again what was already delivered
  const executed = !!(f.job?.executionTx ?? s.executionTx) || f.job?.state === "executed" || f.job?.state === "completed";
  // the relayer's word that it re-shielded the rest counts as the refund note does (audit round 2, r14): read before the note
  // was found, such an order read Refunded, and the order runner settled it there — a swap that delivered, called refunded
  if ((refundedToo || f.job?.state === "refunded") && executed && unitsOf(t?.deliveredAmount) > 0n)
    return out("PARTIAL", "Partial", [true, true, true, true], `${delivered ?? "Part"} delivered at the destination; ${refunded ?? "the remainder"} came back to the escrow and was re-shielded into your private balance.`, extras);
  if (refundedToo || f.job?.state === "refunded") return out("REFUNDED", "Refunded", [true, true, false, false], `The escrow was re-shielded into your private balance${refunded ? ` (${refunded})` : ""}.`, extras);
  // another token at the destination (LI.FI's PARTIAL: a bridge's alternative token; the audit's unverified m60): no amount of
  // the output, and nothing said to have come back
  if (t?.state === "partial" && t.deliveredAmount === undefined && t.deliveredAsset && t.deliveredAsset.toUpperCase() !== String(to.symbol ?? "").toUpperCase())
    return out("PARTIAL", "Partial", [true, true, true, true], `Delivered in ${t.deliveredAsset} at the destination instead of ${to.symbol}: the route gave another token.`, extras);
  const job = f.job?.state;
  if (s.shield && (job === "completed" || job === "executed" || job === "executing")) {
    const sj = s.shield.job?.state;
    if (sj === "shielding" || sj === "shielded" || job === "completed" || t?.state === "completed" || t?.state === "destination-final")
      return out("DESTINATION_FINAL", "Waiting for destination", [true, true, true, false], "Delivered to the one-time receiver; adding it to your protected balance.", extras);
  }
  if (job === "completed") {
    if (t?.state === "partial") return out("PARTIAL", "Partial", [true, true, true, true], `${delivered ?? "part"} delivered at the destination; ${refunded ?? "the remainder"} came back to the escrow and was re-shielded.`, extras);
    return out("COMPLETED", "Completed", [true, true, true, true], `${delivered ? `${delivered} delivered` : "Delivered"} at your fresh address; the executor's watch for a late refund ended with nothing left in the escrow.`, extras);
  }
  // the executor's job ended with nothing in the escrow a day past its window (a V6 follow-up of 2026-10-16): never funded,
  // or funded and back already — the refund note, once the scan finds it, makes it Refunded above
  if (job === "lapsed")
    return funded
      ? out("REFUND_PENDING", "Refunding", [true, true, false, false], "The escrow holds nothing now and the executor's job has ended; the wallet looks for the refund in the pool.", extras)
      : out("EXPIRED", "Not started", [true, false, false, false], "The order was never funded and its window has closed: nothing left your private balance.");
  if (job === "refunding" || job === "refund-only" || job === "expired") return out("REFUND_PENDING", "Refunding", [true, true, false, false], job === "refund-only" ? `Returning to your private balance: the escrow re-shields after ${new Date(p.refundAfter * 1000).toLocaleString()}.` : job === "expired" ? "The signed quote expired before execution; the escrow returns to your private balance after the window, or confirm again with a fresh quote." : "The executor is re-shielding the escrow into your private balance.", extras);
  if (job === "refund-failed" || job === "execute-failed") {
    const where = f.escrowBalance !== null ? `${fmtUnits(f.escrowBalance, from.decimals ?? 18)} ${from.symbol ?? ""} sits in the one-time escrow` : "the funds sit in the one-time escrow";
    return out("FAILED", "Needs attention", [true, true, false, false], `${job === "execute-failed" ? "The execution failed" : "The re-shield failed"}: ${where}${f.job?.error ? ` (${f.job.error})` : ""}. Confirm again with a fresh quote, or return it to your private balance; anyone can call deployAndRefund after ${new Date(p.refundAfter * 1000).toLocaleString()}.`, extras);
  }
  if (job === "executing" || job === "executed") {
    const executionTx = f.job?.executionTx ?? s.executionTx;
    if (!executionTx && job === "executing") return out("SOURCE_FINAL", "Executing", [true, true, false, false], "The executor is sending the provider call.", extras);
    switch (t?.state) {
      case "completed": return out("DESTINATION_FINAL", "Waiting for destination", [true, true, true, true], `${delivered ? `${delivered} delivered` : "Delivered"} at your fresh address; the executor still watches the escrow for a late refund before the order is complete.`, extras);
      case "partial": return out("PARTIAL", "Partial", [true, true, true, t.progress ? t.progress.done >= t.progress.parts : false], `${delivered ?? "Part"} delivered at the destination${t.progress ? ` (${t.progress.done} of ${t.progress.parts} parts)` : ""}; ${refunded ?? "the remainder"} comes back to the escrow and is re-shielded into your private balance.`, extras);
      case "destination-final": return out("DESTINATION_FINAL", "Waiting for destination", [true, true, true, true], `${delivered ? `${delivered} delivered` : "Delivered"} at your fresh address and final there.`, extras);
      case "destination-submitted": return out("DESTINATION_SUBMITTED", "Waiting for destination", [true, true, true, false], `The provider sent the destination transaction${t.destinationTxHash ? ` ${t.destinationTxHash.slice(0, 10)}…` : ""}; waiting for finality.`, extras);
      case "refunded": return out("REFUND_PENDING", "Refunding", [true, true, false, false], `The provider paid the escrow back${refunded ? ` (${refunded})` : ""}; the executor re-shields it into your private balance.`, extras);
      case "failed": return nowS >= p.refundAfter
        ? out("REFUND_PENDING", "Refunding", [true, true, false, false], "The provider could not deliver; the escrow returns to your private balance.", extras)
        : out("DESTINATION_FAILED", "Refunding", [true, true, false, false], `The provider could not deliver; the escrow returns to your private balance after ${new Date(p.refundAfter * 1000).toLocaleString()}.`, extras);
      default: return out("PROVIDER_EXECUTING", "Executing", [true, true, false, false], `The provider call is on chain (${executionTx ? executionTx.slice(0, 10) + "…" : "sent"}); the provider is executing${t?.progress ? ` (${t.progress.done} of ${t.progress.parts} parts)` : ""}.`, extras);
    }
  }
  // handed over, its executor not read this time (down, or not the relayer it went to): never back to the funding phase
  // (audit round 2, r38); the record says it waits for the executor's word
  if (s.jobId && !f.job && funded)
    return out("PROVIDER_EXECUTING", "Executing", [true, true, false, false], "The order was handed over; its executor did not answer this time, and is asked again at the next read.", extras);
  // no executor job yet
  if (funded) {
    if (f.escrowBalance !== null && f.escrowBalance >= amount) {
      if (nowS > p.executeDeadline) return nowS >= p.refundAfter
        ? out("REFUND_PENDING", "Refunding", [true, true, false, false], "The order's execution window closed; the escrow returns to your private balance (return it, or anyone can call deployAndRefund).")
        : out("PROVIDER_TIMEOUT", "Refunding", [true, true, false, false], `The order's execution window closed; the escrow returns to your private balance after ${new Date(p.refundAfter * 1000).toLocaleString()}.`);
      return out("SOURCE_FINAL", "Preparing", [true, true, false, false], "The escrow is funded; confirm the swap against a fresh quote, or return it to your private balance.");
    }
    return out("SOURCE_SUBMITTED", "Waiting for source", [true, false, false, false], f.escrowBalance === null ? "The funding transaction was sent; waiting for the escrow's balance to be read." : "The funding transaction was sent; waiting for it to be mined.");
  }
  if (nowS > p.executeDeadline) return out("EXPIRED", "Not started", [true, false, false, false], "The order expired before it was funded: nothing left your private balance.");
  return out("COMMITTED", "Preparing", [true, false, false, false], s.dueAt ? `Funding is scheduled for ${new Date(s.dueAt).toLocaleString()} (the wallet must be unlocked).` : "Fund the swap from your private balance, then confirm it.");
}

/** The escrow's balance in the order's asset from every endpoint; null unless they all answer the same. */
export async function escrowBalance(deployment: Deployment, escrow: Address, token: Address | null): Promise<bigint | null> {
  const clients = clientsFor(deployment);
  const reads = await Promise.all(clients.map((c) => (token ? c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [escrow] }) : c.getBalance({ address: escrow })).then((v) => v as bigint, () => null)));
  if (reads.some((r) => r === null)) return null;
  return reads.every((r) => r === reads[0]) ? (reads[0] as bigint) : null;
}

export interface TrackDeps {
  deployment: Deployment | null;
  relayerUrl?: string | null;
  now?: number;
  session?: WalletSession;
  /** tests: replace the readers */
  readers?: { job?: (s: StoredSwap) => Promise<SwapJob | null>; balance?: (s: StoredSwap) => Promise<bigint | null>; track?: (s: StoredSwap, tx: string) => Promise<TrackResult["track"] | null> };
  /**
   * High-Value Protection spec §10: the hand-over time (unix s) and the plan's seconds, by which the wallet suspects a
   * stalled settlement. The read then names the order's operation, and the service decides from its own records (the
   * hand-over, the plan, the relayer's execution); a V6 follow-up of 2026-10-14 — the service had taken a caller's
   * timing on trust, and anyone could open a provider's breaker for every user.
   */
  stall?: { since: number; expected: number };
}

/**
 * Read the facts, derive the state, journal what changed (executionTx once, the track read, a history
 * entry per transition, the Activity label). Returns the derived state and the job it read.
 */
export async function trackOrder(stored: StoredSwap, deps: TrackDeps): Promise<{ tracked: Tracked; job: SwapJob | null }> {
  const s = deps.session ?? defaultSession;
  const now = deps.now ?? Date.now();
  const r = deps.readers ?? {};
  const job = await (r.job ? r.job(stored) : stored.jobId && deps.relayerUrl ? relayerSwapStatus(deps.relayerUrl, stored.jobId).catch(() => null) : Promise.resolve(null));
  // the job's, once it is read (audit round 2, r01): the relayer names the transaction that executed the escrow — a copy of
  // its own call that landed first replaces the one it had sent, which reverted and which no provider saw
  const executionTx = job ? job.executionTx : stored.executionTx;
  const fromToken = (stored.request as { from?: { asset?: string } })?.from?.asset;
  const balance = await (r.balance ? r.balance(stored) : fundedOf(stored) && deps.deployment ? escrowBalance(deps.deployment, stored.endpoint as Address, fromToken && fromToken !== "native" ? (fromToken as Address) : null).catch(() => null) : Promise.resolve(null));
  const track = executionTx ? await (r.track ? r.track(stored, executionTx) : swapService.track(stored.provider, { tx: executionTx, ...decimalsOf(stored), ...(stored.executionRef ? { ref: stored.executionRef } : {}), ...(deps.stall && stored.operationId && (now / 1000 - deps.stall.since) > STALL_FACTOR * deps.stall.expected ? { operation: stored.operationId } : {}) }).then((x) => x.track, () => null)) : null;
  const tracked = deriveState(stored, { now, job, escrowBalance: balance, track, refundFound: (stored.refunds?.length ?? 0) > 0 });
  // journal: executionTx once, the read, a transition when the state changed
  if (s.isUnlocked()) {
    s.update((j) => {
      const x = j.swaps.find((y) => y.orderId.toLowerCase() === stored.orderId.toLowerCase());
      if (!x) return;
      if (job && x.executionTx !== job.executionTx) {
        if (job.executionTx) x.executionTx = job.executionTx;
        else delete x.executionTx;
      }
      x.track = { state: tracked.state, label: tracked.label, at: now, ...(tracked.settlement ? { settlement: tracked.settlement } : {}), ...(track?.destinationTxHash ? { destinationTxHash: track.destinationTxHash } : {}), ...(track?.deliveredAmount !== undefined ? { deliveredAmount: String(track.deliveredAmount) } : {}), ...(track?.refundedAmount !== undefined ? { refundedAmount: String(track.refundedAmount) } : {}), ...(track?.progress ? { progress: track.progress } : {}) };
      const last = x.history?.[x.history.length - 1];
      if (!last || last.state !== tracked.state) x.history = [...(x.history ?? []), { state: tracked.state, at: now, note: tracked.label }];
      if (job && x.state !== job.state) x.state = job.state;
    });
    // High-Value Protection spec §12: a settled payment retires a fresh destination (one use) and marks an entered one paid
    const r = stored.request as { to?: { chain?: string }; destination?: string };
    if ((tracked.state === "COMPLETED" || tracked.state === "DESTINATION_FINAL") && stored.track?.state !== tracked.state && r.to?.chain && r.destination) markAddressSettled(chainKindOf(r.to.chain), r.destination, s, now);
    updateActivity(activityId("swap", stored.orderId), { status: job?.state ?? stored.state, note: `${(stored.request as { to?: { symbol?: string } })?.to?.symbol ? `→ ${(stored.request as { to?: { symbol?: string } }).to!.symbol} · ` : ""}${tracked.label}` }, s);
  }
  return { tracked, job };
}

/** The §61 label of a journaled order without a fresh read (Activity rows): the last derived one, else from the relayer state. */
export function journaledLabel(s: StoredSwap): SettlementLabel | null {
  return (s.track?.label as SettlementLabel | undefined) ?? null;
}
