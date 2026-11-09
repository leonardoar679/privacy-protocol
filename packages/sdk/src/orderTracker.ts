// Settlement tracking in the wallet (whale spec §19, §25; plan V2 §49, §60–§61, §96): the wallet runs
// the spec's state machine itself, from facts it can observe — its journal, the relayer's job (with the
// execution transaction it records once), the escrow's balance read through the RPC quorum, and the
// service's stateless GET /track/:provider for the destination side — and journals every transition
// with its time. The user sees the labels of plan §61 and the four-step line of plan §60; a funded order
// is never a bare "failed": the label says where the money is. Nothing here says "atomic". V6 Stage 12 (spec v2.0
// §11.2): a same-chain swap into the protected balance is complete when its delivered note is in the pool (the shield
// receipt's leaves), whatever the provider's own tracking says.
import { parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { STALL_FACTOR } from "@privacy-wallet/protocol/wallet/campaign";
import { clientsFor, logsInWindows, type Deployment } from "./chain";
import { erc20Abi } from "./privacyProtocol";
import { relayerSwapStatus, type SwapJob } from "./relayer";
import { swapService, type TrackResult } from "./swapService";
import { fundedOf, fundingSeenOf, type StoredSwap } from "./wallet/journal";
import { session as defaultSession, type WalletSession } from "./wallet/session";
import { activityId, updateActivity } from "./wallet/activity";
import { markAddressSettled } from "./wallet/addressBook";
import { chainKindOf } from "./keys/chainKeys";
import { EXECUTOR_LATE_REFUND_WATCH_SECONDS, lateRefundHeld, legsFrom, nextSettlement, type SettlementLegs } from "@privacy-wallet/protocol/wallet/settlement";
import type { SettlementState } from "@privacy-wallet/protocol-types";
import { DELAY_WINDOW } from "./policy";
import { scheduleAction } from "./wallet/schedule";
import { getOperation } from "./operations/store";
import { isTerminal } from "./wallet/operationRecord";
import { WRAPPED_NATIVE_OF } from "@privacy-wallet/contracts/deployments";
import { CLOSING_READINGS, refundNotesBack, SWAP_CLOSED_STATES } from "./orderStates";
import { refundTokensOf } from "./refundVaults";

/**
 * The spec's states (packages/swap-engine/src/order.ts), as the wallet derives them. LATE_REFUND (audit round 2, r36): the
 * escrow of an executed order holds a refund that came back after the executor stopped watching it — the wallet's to return.
 */
export type OrderState = "COMMITTED" | "SOURCE_SUBMITTED" | "SOURCE_FINAL" | "PROVIDER_EXECUTING" | "DESTINATION_SUBMITTED" | "DESTINATION_FINAL" | "COMPLETED" | "PARTIAL" | "REFUND_PENDING" | "PROVIDER_TIMEOUT" | "DESTINATION_FAILED" | "REFUNDED" | "EXPIRED" | "CANCELLED" | "FAILED" | "LATE_REFUND" | "REFUNDED_AT_DESTINATION" | "PROVIDER_FAILED" | "DROPPED";
/**
 * The two states of the sixth review round (2026-11-03). REFUNDED_AT_DESTINATION: the provider paid its refund at the fresh destination
 * address (Mayan Fast-MCTP refunds USDC there, never to the escrow) — final, the order closes, nothing is left to return.
 * PROVIDER_FAILED: the provider's last word is a failure, or a refund to the escrow that never arrived, and the executor's watch
 * ended with nothing above dust in the escrow — the order closes with its reason; before, both read "a refund on its way to the
 * escrow; once it arrives, return it" for good, held the band's in-flight slot and kept a campaign step from settling.
 */
export const CLOSED_BY_TRACK: readonly OrderState[] = ["COMPLETED", "PARTIAL", "REFUNDED_AT_DESTINATION", "PROVIDER_FAILED"];
/** Where the provider refunds an unfilled order: the quote's word at commit, or the track's. */
export const refundTargetOf = (s: Pick<StoredSwap, "quote">, t: { refundedTo?: string } | null | undefined): "escrow" | "destination" =>
  (s.quote as { refundTarget?: string } | undefined)?.refundTarget === "destination" || t?.refundedTo === "destination" ? "destination" : "escrow";
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
  /** the provider was asked about the execution and gave no track: its read failed, or its answer carried none (the eleventh review round's K4) */
  providerUnread?: boolean;
  /**
   * The escrow's own `executed` flag, read once its funds came back (the eleventh review round's K4 critique): a refund is made only past the
   * execute deadline, so the flag is final then — the word over a job not read and over the transaction a relayer keeps of a reverted
   * execution —, and for a job that names no execution (the twelfth review round, C12-6). trackOrder passes true on a read that could not read it
   * when a read before found it true (escrowExecutedSeen; XW's critique); the order runner's own read passes it as read. Null: read and not agreed
   * on, with no such earlier read; absent: not read.
   */
  escrowExecuted?: boolean | null;
  /**
   * The escrow holds a refund in one of the route's refund tokens (`refundTokens`, a swap-first route: Mayan swap-and-lock, LI.FI with a source
   * swap, the Across swap leg) at or above that token's floor, or — an ETH order — in the chain's wrapped ETH at the order's 1 % floor (an
   * unfilled Across ETH deposit's refund), every endpoint agreeing (the twelfth review round, VC12-N1): a late refund the provider paid in such a
   * token had never been seen — the order closed and Return funds was never offered. Null: one of them could not be read this time — a refund, a
   * refund at the destination, is read again before it settles (XI's critique: one failed read had closed it, the token held since never offered
   * back); absent: not read.
   */
  refundTokensHeld?: boolean | null;
  /** ... what the escrow holds of them, in their units ("3,400 USDC", "0.5 WETH"), when this wallet knows their decimals */
  refundTokensHeldAs?: string;
  /**
   * ... every one held is an ETH order's own wrapped ETH, which the escrow's refund() re-shields as the order's own — refundToken refuses it (the
   * twelfth review round, XU's critique)
   */
  refundTokensHeldOwn?: boolean;
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
  /** the seventh review round: the asset delivered when it is not the order's (LI.FI's PARTIAL: a bridge's alternative token) — no amount of the output exists */
  deliveredAsset?: string;
  /** the order's asset did not arrive, another token did (LI.FI's PARTIAL) — whether or not its symbol is one to show (B11-13's critique) */
  otherToken?: boolean;
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
  // a refund token not read this time: what the escrow holds is not known (XI's critique), the last settlement kept — unless the order's own asset
  // holds a late refund: the legs are read then (XJ's critique: its Return funds had waited for the token's read), the token not read passed on as
  // refundTokensUnread, which keeps a refund paid at the destination pending (the twelfth review round, XV's critique)
  if (f.refundTokensHeld === null && (f.escrowBalance === null || !lateRefundHeld(f.escrowBalance, BigInt(p.amount)))) return null;
  // the delivery is in the protected balance: the destination is final — once the escrow no longer holds the order (the twelfth review round,
  // C12-1: a deposit with the receipt's payload is anyone's to make who holds it)
  const shielded = (s.shield?.leaves?.length ?? 0) > 0 && f.escrowBalance !== null && !lateRefundHeld(f.escrowBalance, BigInt(p.amount));
  return legsFrom({
    fundingSent: fundedOf(s), abandoned: s.state === "abandoned", refundFound: f.refundFound || refundNotesBack(s),
    ...(f.refundTokensHeld ? { refundTokensHeld: true } : {}),
    // ... or not read this time (the twelfth review round, XV's critique: read as none held, a refund paid at the destination had settled its legs
    // beside a reading still open)
    ...(f.refundTokensHeld === null ? { refundTokensUnread: true } : {}),
    // a transaction the escrow's own flag says did not execute it is no execution (XF's critique: a relayer keeps a reverted execution's hash, and a
    // refund token sent to the escrow after it had read as a late refund of an execution that never was)
    job: f.job ? { state: f.job.state, ...(f.job.executionTx && f.escrowExecuted !== false ? { executionTx: f.job.executionTx } : {}) } : null, jobUnread: !!s.jobId && !f.job,
    ...(s.executionTx && f.escrowExecuted !== false ? { executionTx: s.executionTx } : {}), track: shielded ? { state: "destination-final" } : f.track, escrowBalance: f.escrowBalance, amount: BigInt(p.amount), executeDeadline: p.executeDeadline, refundAfter: p.refundAfter, now: Math.floor(f.now / 1000),
    refundTarget: refundTargetOf(s, f.track),
  });
}

// Whether the order's funding was sent (wallet/journal.ts `fundedOf`): its transaction journaled, its landing journaled without one,
// the order journaled funded — or handed over or executed (the ninth review round, 2026-11-04, C-01: the hand-over writes the job's
// state over `state`, and an order reconciled from the escrow's balance, then handed over, read "expired before it was funded:
// nothing left your private balance" at the first job read that failed, its ticks stopped for good). Audit round 2, r10: an order
// funded while its page was gone had read "Funding is scheduled", then "nothing left", while its amount sat in the escrow.

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
  // the delivered units of this read, else of the last read that had them (the seventh review round, 2026-11-03): a read without them — the
  // provider's answer failed, or said "refunded" alone — had turned a partial fill into a refund in full, and a campaign swapped the
  // delivered part again
  const units = t?.deliveredAmount !== undefined ? String(t.deliveredAmount) : s.track?.deliveredAmount;
  const delivered = units !== undefined ? `${fmtUnits(units, to.decimals ?? 0)} ${to.symbol ?? ""}`.trim() : undefined;
  const refunded = t?.refundedAmount !== undefined ? `${fmtUnits(t.refundedAmount, from.decimals ?? 18)} ${from.symbol ?? ""}`.trim() : undefined;
  // another token at the destination (LI.FI's PARTIAL: a bridge's alternative token; the audit's unverified m60): no amount of the output
  // ... or, this read without the provider's answer — none, or one that tells nothing (unknown, pending, executing: the fourth critique) —, as
  // the journal's last reading had it (the second critique, as the units are)
  const fromJournal = (!t || t.state === "unknown" || t.state === "pending" || t.state === "executing") && s.track?.otherToken === true;
  const otherToken = (t?.state === "partial" && t.deliveredAmount === undefined && !!t.deliveredAsset && t.deliveredAsset.toUpperCase() !== String(to.symbol ?? "").toUpperCase()) || fromJournal;
  // a provider's token symbol only as a symbol (the eleventh review round, B11-13): the screen's own sentence carried any words it sent. The
  // classification stays apart (the critique): a symbol refused is still another token — "another token" in the words
  const symbol = !otherToken ? undefined : t && !fromJournal ? (/^[A-Za-z0-9.+_-]{1,16}$/.test(String(t.deliveredAsset)) ? t.deliveredAsset : undefined) : s.track?.deliveredAsset;
  const otherName = symbol ?? "another token";
  const extras = { deliveredAmount: delivered, ...(units !== undefined ? { deliveredUnits: units } : {}), ...(symbol ? { deliveredAsset: symbol } : {}), ...(otherToken ? { otherToken: true } : {}), refundedAmount: refunded, destinationTxHash: t?.destinationTxHash, progress: t?.progress };

  if (s.state === "abandoned") return out("CANCELLED", "Not started", [true, false, false, false], "Abandoned before funding: nothing left your private balance.");
  // a refund note counts above dust only (refundNotesBack; the twelfth review round, XG's critique): a note anyone holding the payload can make
  // had turned a delivered order Partial and closed an executed one Refunded for good
  const refundedToo = f.refundFound || refundNotesBack(s);
  // ... and is said to have come back only then (XF's critique: a 1-wei note had read "what else came back")
  const backToo = refundNotesBack(s);
  // V6 Stage 12: the delivered note found in the pool is the destination's settlement
  const leaves = s.shield?.leaves ?? [];
  // ... once the escrow no longer holds the order (the twelfth review round, C12-1): a deposit with the receipt's payload is anyone's to make who
  // holds it — the shield executor it was registered with among them —, and a 1-wei one had closed an order the escrow still held Completed.
  // Unread, the order is read again; still holding the order, the leaves are set aside and the order reads as its job and its balance say
  if (leaves.length && f.escrowBalance === null)
    return out("DESTINATION_FINAL", "Waiting for destination", [true, true, true, false], "A delivery to your protected balance was found; the escrow's balance could not be read this time, so the order is read again before it settles.", extras);
  if (leaves.length && !lateRefundHeld(f.escrowBalance!, amount)) {
    const units = leaves.reduce((a, l) => a + BigInt(l.amount), 0n);
    const got = `${fmtUnits(units, to.decimals ?? 18)} ${to.symbol ?? ""}`.trim();
    const into = { ...extras, deliveredAmount: got, deliveredUnits: units.toString() };
    if (refundedToo) return out("PARTIAL", "Partial", [true, true, true, true], `${got} added to your protected balance; the rest came back to the escrow and was re-shielded.`, into);
    return out("COMPLETED", "Completed", [true, true, true, true], `${got} added to your protected balance.`, into);
  }
  // a partial fill whose rest came back (a V6 follow-up of 2026-10-16, audit c32): the refund note is the remainder, not the order —
  // read as Refunded, a campaign re-planned and swapped again what was already delivered. The escrow's own flag, read once its funds came
  // back or for a job that names no execution (C12-6) — true on a failed read after one found it true (escrowExecutedSeen, XW) —, over every
  // other word (K4): a relayer keeps a reverted execution's transaction as its executionTx
  const execTx = f.job?.executionTx ?? s.executionTx;
  const executed = f.escrowExecuted === false ? false : f.escrowExecuted === true || !!execTx || f.job?.state === "executed" || f.job?.state === "completed";
  // a refund the provider paid at the DESTINATION (the sixth review round, 2026-11-03; Mayan Fast-MCTP: USDC to the fresh address): final —
  // nothing more reaches the escrow; the order closes and the fresh address is retired. Decided before what came back to the escrow (the twelfth
  // review round, C12-7): a leftover re-shielded beside it had read Refunded in full, and a campaign step booked the refund paid at the
  // destination as the step's fees
  // ... unless a refund token sits in the escrow at its floor since (the twelfth review round, XH's critique: the destination's close had come first,
  // and the surplus a facet swept there in its token was never offered back — LATE_REFUND below returns it) — nor while one could not be read this time
  // (XI's critique: one failed read had closed it for good, the token held since never offered back): read again. The refund tokens are read for a
  // completed, refunded or failed re-shield's job, and on a read where its relayer did not answer for an order an execution was seen for (XV's
  // critique): beside an executed job the close comes first, whatever they hold (stated: XU's critique)
  const atDestination = executed && t?.state === "refunded" && refundTargetOf(s, t) === "destination";
  // ... in words that never say the funds return to the balance (XJ's critique: "Refunding" had read "Returning to your balance" for a refund paid out at
  // the destination)
  if (atDestination && f.refundTokensHeld === null)
    return out("PROVIDER_EXECUTING", "Executing", [true, true, true, false], `The provider reports a refund at your fresh address on the destination chain${refunded ? ` (${refunded})` : ""}; the escrow's refund tokens could not be read this time, so the order is read again before it settles.`, extras);
  // "Nothing is left in the escrow." only once its refund tokens were read too (XI's critique: read in the order's asset alone, it was said beside a
  // refund token never read), and only of an empty escrow: dust left there is said to be dust (the twelfth review round, XS's critique; XU's: named in
  // six decimals, a stranger's wei read "(0 ETH)")
  // ... nor, for a job that no longer re-shields — completed, a failed re-shield, a refund past its watch —, while the order's own asset is held above
  // dust (the twelfth review round, XQ's critique: a source swap's leftover had closed with the destination's refund, never offered back): LATE_REFUND
  // or FAILED below returns it — nor on a read where the relayer it was handed to did not answer, whatever its job is (XU's critique: one failed read had
  // closed a completed job's late refund for good, its Return funds gone): read again, as a handed-over order its executor did not answer for
  const leftHeld =
    (f.job?.state === "completed" ||
      f.job?.state === "refund-failed" ||
      (f.job?.state === "refunded" && nowS >= p.refundAfter + EXECUTOR_LATE_REFUND_WATCH_SECONDS) ||
      (!!s.jobId && !f.job)) &&
    f.escrowBalance !== null &&
    lateRefundHeld(f.escrowBalance, amount);
  if (atDestination && f.refundTokensHeld !== true && !leftHeld)
    return out(
      "REFUNDED_AT_DESTINATION",
      "Refunded",
      [true, true, true, true],
      `The provider could not deliver ${to.symbol || "the output"} and refunded at your fresh address on the destination chain${refunded ? ` (${refunded})` : " (in its refund asset — USDC for Mayan)"}, not to the pool.${backToo ? " What else came back to the escrow was re-shielded into your private balance." : f.refundTokensHeld === false && f.escrowBalance !== null && !lateRefundHeld(f.escrowBalance, amount) ? (f.escrowBalance === 0n ? " Nothing is left in the escrow." : " Nothing above dust is left in the escrow.") : ""}`,
      extras,
    );
  // what says the escrow came back — a refund note the scan found, the relayer's "refunded" — counts only once the escrow's own balance is read and
  // holds dust at most (the twelfth review round, C12-1): a refund note is a vault deposit anyone holding the order's payload can make — the
  // relayer it was handed to holds it — and a relayer's word is its own; either had closed a funded, still executable order Refunded, its
  // Return funds gone. Unread, the order is read again before it settles; still holding the order, the evidence is set aside and the order
  // reads as its job and its balance say
  const refundSaid = refundedToo || f.job?.state === "refunded";
  if (refundSaid && f.escrowBalance === null)
    return out("REFUND_PENDING", "Refunding", [true, true, false, false], "A refund is reported; the escrow's balance could not be read this time, so the order is read again before it settles.", extras);
  // ... nor its refund tokens (XI's critique): what else the escrow may hold is read again before the refund settles — while the order's own asset holds
  // nothing back: a late refund held in it is read as one below (XJ's critique)
  if (refundSaid && f.refundTokensHeld === null && f.escrowBalance !== null && !lateRefundHeld(f.escrowBalance, amount))
    return out("REFUND_PENDING", "Refunding", [true, true, false, false], "A refund is reported; the escrow's refund tokens could not be read this time, so the order is read again before it settles.", extras);
  // ... and no refund token sits there at its floor (XD's critique: a note of the order's own asset beside a USDC refund held had read Refunded,
  // Return funds gone)
  const refundBack = refundSaid && f.escrowBalance !== null && !lateRefundHeld(f.escrowBalance, amount) && f.refundTokensHeld !== true;
  // the relayer's word that it re-shielded the rest counts as the refund note does (audit round 2, r14): read before the note
  // was found, such an order read Refunded, and the order runner settled it there — a swap that delivered, called refunded
  // another token at the destination (LI.FI's PARTIAL: a bridge's alternative token; the audit's unverified m60) is read before
  // a refund (audit round 2, n06): with a leftover re-shielded too it had read Refunded in full, and a campaign planned the
  // delivered step's whole amount again
  if (refundBack && executed && otherToken)
    return out("PARTIAL", "Partial", [true, true, true, true], `Delivered in ${otherName} at the destination instead of ${to.symbol}; ${refunded ?? "the remainder"} came back to the escrow and was re-shielded into your private balance.`, extras);
  if (refundBack && executed && unitsOf(units) > 0n)
    return out("PARTIAL", "Partial", [true, true, true, true], `${delivered ?? "Part"} delivered at the destination; ${refunded ?? "the remainder"} came back to the escrow and was re-shielded into your private balance.`, extras);
  // the provider's word of a delivery without its amount (K4; the ninth review round's A9-6 refined — Mayan's and Across's tracks never give one):
  // part was delivered, never a refund in full
  if (refundBack && executed && (t?.state === "completed" || t?.state === "destination-final" || t?.state === "partial"))
    return out("PARTIAL", "Partial", [true, true, true, true], `Delivered at the destination (the provider did not say how much); ${refunded ?? "the remainder"} came back to the escrow and was re-shielded into your private balance.`, extras);
  // ... and of one still on its way: nothing final yet, read again until the provider's last word (a refund in full is final) — waiting for its
  // destination, never "returning to your balance": what came back is in it already (K4's third critique)
  if (refundBack && executed && t?.state === "destination-submitted")
    return out("DESTINATION_SUBMITTED", "Waiting for destination", [true, true, true, false], `The provider sent the destination transaction${t.destinationTxHash ? ` ${t.destinationTxHash.slice(0, 10)}…` : ""}; ${refunded ?? "the rest"} came back to the escrow and was re-shielded into your private balance, and what the swap delivered is read again.`, extras);
  // a refund in full after an execution only on the provider's word that nothing was delivered — its refund, its failure — or, with no answer
  // this time, on a journaled reading that said so (units 0) (K4's third critique). An answer that tells nothing — unknown, pending, executing:
  // four of the adapters answer "unknown" for their own failures —, or no answer — a provider not read, no transaction to ask it about — with
  // nothing journaled of a delivery: read again, never settled as a refund in full; part may have been delivered (the API's reconcile keeps it so)
  const toldNothing = t ? !(t.state === "refunded" || t.state === "failed") : units === undefined && (f.providerUnread === true || !execTx);
  if (refundBack && executed && toldNothing)
    return out(
      "PROVIDER_EXECUTING",
      "Executing",
      [true, true, false, false],
      execTx
        ? "The escrow's remaining funds came back and were re-shielded into your private balance; what the swap delivered is read again from the provider."
        : "The escrow's remaining funds came back and were re-shielded into your private balance; the swap's execution transaction is looked for again, to read what it delivered.",
      extras,
    );
  // its funds came back and whether it executed first is not known yet (K4): the executor was asked, and neither its job (read this time) nor the
  // escrow's flag says — read again, never settled as a refund in full. Not executed is someone's word: the escrow's flag, the job read this
  // time, or no hand-over ever asked of anyone
  const asked = !!s.jobId || s.handOverAttempt !== undefined || s.handedOverAt !== undefined;
  if (refundBack && !executed && f.escrowExecuted !== false && asked && (!f.job || f.job.state === "executing"))
    return out("PROVIDER_EXECUTING", "Executing", [true, true, false, false], "Your funds came back to your private balance; whether the swap delivered part of them first is read again.", extras);
  if (refundBack) return out("REFUNDED", "Refunded", [true, true, false, false], `The escrow was re-shielded into your private balance${refunded ? ` (${refunded})` : ""}.`, extras);
  // another token at the destination (LI.FI's PARTIAL: a bridge's alternative token; the audit's unverified m60): no amount of
  // the output, and nothing said to have come back — never when a refund was said and set aside because the escrow still holds the order (C12-1's
  // critique: this reading had closed the order on a relayer's "refunded" with its funds in the escrow) — and for a completed job never before its late
  // refund is read: one held in the order's asset or a refund token is returned first, a balance or a token not read waits (XK's critique: this close had
  // come first; XL's: on an unread balance too)
  // ... and never for a failed re-shield, whose executor saw something to move: it reads as its failed re-shield until its refund note is found (the
  // Partial above; XM's and XP's critiques) — and on a read where the relayer it was handed to did not answer, as for a completed job (XV's critique:
  // the Partial had ended a campaign step beside the order's asset held)
  const lateFirst =
    f.job?.state === "refund-failed" ||
    ((f.job?.state === "completed" || (!!s.jobId && !f.job)) &&
      (f.escrowBalance === null || lateRefundHeld(f.escrowBalance, amount) || f.refundTokensHeld === true || f.refundTokensHeld === null));
  if (otherToken && !refundSaid && !lateFirst)
    return out("PARTIAL", "Partial", [true, true, true, true], `Delivered in ${otherName} at the destination instead of ${to.symbol}: the route gave another token.`, extras);
  const job = f.job?.state;
  // the executor stopped watching an executed order (`completed`: its late-refund watch ended with the escrow empty), and the
  // escrow holds a refund since (audit round 2, r36): the provider held it past the watch — a chain halt, an outbound queue —,
  // and only the wallet's "Return funds" re-shields it now; until then the order is never read as delivered. In the order's asset, or in one of
  // the route's refund tokens (the twelfth review round, VC12-N1)
  const heldInAsset = f.escrowBalance !== null && lateRefundHeld(f.escrowBalance, amount);
  // ... and a job that says it refunded, after an execution, with a refund held since — re-shielded in part inside its watch, the provider's second
  // refund landing after it (XC's critique: it had fallen to the funding's words, "Waiting for source", Return funds never offered)
  const lateHeld = heldInAsset ? `${fmtUnits(f.escrowBalance!, from.decimals ?? 18)} ${from.symbol ?? ""}`.trim() : (f.refundTokensHeldAs ?? "a refund in the route's refund token");
  // ... once the executor's watch is over for a refunded job (XD's critique): inside it, the executor re-shields what the escrow holds itself
  const watchOver = nowS >= p.refundAfter + EXECUTOR_LATE_REFUND_WATCH_SECONDS;
  if ((job === "completed" || (job === "refunded" && executed && watchOver)) && (heldInAsset || f.refundTokensHeld === true))
    return out("LATE_REFUND", "Needs attention", [true, true, false, false], `The provider paid ${lateHeld} back to the one-time escrow after the executor stopped watching it: return it to your private balance.`, extras);
  if (job === "refunded" && executed && (heldInAsset || f.refundTokensHeld === true))
    return out("REFUND_PENDING", "Refunding", [true, true, false, false], `The provider paid ${lateHeld} back to the one-time escrow; its executor re-shields it into your private balance.`, extras);
  if (s.shield && (job === "completed" || job === "executed" || job === "executing")) {
    const sj = s.shield.job?.state;
    if (sj === "shielding" || sj === "shielded" || t?.state === "completed" || t?.state === "destination-final")
      return out("DESTINATION_FINAL", "Waiting for destination", [true, true, true, false], "Delivered to the one-time receiver; adding it to your protected balance.", extras);
    // the executor's watch ending with nothing back is no delivery (r36): the provider's word or the shield job's is
    if (job === "completed") return out("DESTINATION_SUBMITTED", "Waiting for destination", [true, true, true, false], "The executor's watch ended with nothing back in the escrow; waiting for the delivery to the one-time receiver.", extras);
  }
  if (job === "completed") {
    // the provider's side as it says it, in the readings that wait (XK's critique: they had marked the destination sent for an execution the provider
    // says failed, undone at the next read)
    const sentAt = t?.state === "destination-submitted" || t?.state === "completed" || t?.state === "destination-final" || t?.state === "partial";
    // the escrow's balance was not read this time (the sixth review round, 2026-11-03): nothing settles on it — a partial fill whose
    // rest came back after the watch had settled as delivered on a failed balance read
    if (f.escrowBalance === null)
      return out("PROVIDER_EXECUTING", "Executing", [true, true, sentAt, false], "The executor's watch ended; the escrow's balance could not be read this time, so the order is read again before it settles.", extras);
    // ... nor while one of its refund tokens could not be read (the twelfth review round, XJ's critique: Partial, Completed or a provider failure had
    // closed the order on a read that could not see the escrow, the refund held in that token never offered back): read again
    if (f.refundTokensHeld === null)
      return out("PROVIDER_EXECUTING", "Executing", [true, true, sentAt, false], "The executor's watch ended; the escrow's refund tokens could not be read this time, so the order is read again before it settles.", extras);
    // what is known of the rest (the eleventh review round, B11-9): re-shielded only where its refund was found
    if (t?.state === "partial")
      return out(
        "PARTIAL",
        "Partial",
        [true, true, true, true],
        refundedToo
          ? `${delivered ?? "part"} delivered at the destination; ${refunded ?? "the remainder"} came back to the escrow and was re-shielded.`
          : `${delivered ?? "part"} delivered at the destination; the executor's watch ended with nothing back in the escrow${refunded ? ` (the provider reports ${refunded} refunded)` : ""}.`,
        extras,
      );
    // delivered on the provider's word only (r36): a provider still delivering, or refunding, keeps the order open
    if (t?.state === "completed" || t?.state === "destination-final")
      return out("COMPLETED", "Completed", [true, true, true, true], `${delivered ? `${delivered} delivered` : "Delivered"} at your fresh address; the executor's watch for a late refund ended with nothing left in the escrow.`, extras);
    // the provider's last word is a failure, or a refund to the escrow the watch never saw arrive (the sixth review round, 2026-11-03):
    // the order ends with its reason — it had read "once it arrives, return it" for good, with nothing ever arriving
    if (t?.state === "refunded" || t?.state === "failed")
      return out("PROVIDER_FAILED", "Needs attention", [true, true, false, false], `The provider reports ${t.state === "failed" ? "the execution failed" : "a refund to the escrow"}, and the executor's watch ended with nothing above dust in the escrow${f.escrowBalance > 0n ? ` (${fmtUnits(f.escrowBalance, from.decimals ?? 18)} ${from.symbol ?? ""})` : ""}. Nothing more comes back on its own: check the provider's record of the execution transaction.`, extras);
    if (t?.state === "destination-submitted")
      return out("DESTINATION_SUBMITTED", "Waiting for destination", [true, true, true, false], `The provider sent the destination transaction${t.destinationTxHash ? ` ${t.destinationTxHash.slice(0, 10)}…` : ""}; waiting for finality.`, extras);
    return out("PROVIDER_EXECUTING", "Executing", [true, true, false, false], "The provider has not confirmed the delivery yet; the executor's watch for a late refund ended with nothing in the escrow, and the wallet keeps reading both.", extras);
  }
  // the executor's job ended with nothing in the escrow a day past its window (a V6 follow-up of 2026-10-16): never funded,
  // or funded and back already — the refund note, once the scan finds it, makes it Refunded above
  if (job === "lapsed")
    return fundingSeenOf(s) // the executor never saw funds: its job alone is no funding (the ninth review round)
      ? out("REFUND_PENDING", "Refunding", [true, true, false, false], "The escrow holds nothing now and the executor's job has ended; the wallet looks for the refund in the pool.", extras)
      : out("EXPIRED", "Not started", [true, false, false, false], "The order was never funded and its window has closed: nothing left your private balance.");
  // handed over, its executor waiting to see the funding (its node behind the chain): never back to the funding phase, nor "expired
  // before it was funded" past the window — the job's own next state follows (the ninth review round, 2026-11-04, C-01)
  if (job === "waiting-funding")
    return f.escrowBalance !== null && f.escrowBalance >= amount
      ? out("SOURCE_FINAL", "Executing", [true, true, false, false], "The escrow is funded and handed over; the executor sends the provider call once its node sees the funding.", extras)
      : out("SOURCE_SUBMITTED", "Waiting for source", [true, false, false, false], "Handed over; the executor waits to see the escrow's funding before it sends the provider call.", extras);
  if (job === "refunding" || job === "refund-only" || job === "expired") return out("REFUND_PENDING", "Refunding", [true, true, false, false], job === "refund-only" ? `Returning to your private balance: the escrow re-shields after ${new Date(p.refundAfter * 1000).toLocaleString()}.` : job === "expired" ? "The signed quote expired before execution; the escrow returns to your private balance after the window, or confirm again with a fresh quote." : "The executor is re-shielding the escrow into your private balance.", extras);
  if (job === "refund-failed" || job === "execute-failed") {
    // ... what sits there named: a refund token held beside the order's asset at dust (the twelfth review round, XN's critique: "0 ETH sits in the
    // one-time escrow" over a USDC refund)
    const inToken = f.refundTokensHeld === true && (f.escrowBalance === null || !lateRefundHeld(f.escrowBalance, amount));
    const where = inToken
      ? `${f.refundTokensHeldAs ?? "a refund in the route's refund token"} sits in the one-time escrow`
      : f.escrowBalance !== null
        ? `${fmtUnits(f.escrowBalance, from.decimals ?? 18)} ${from.symbol ?? ""} sits in the one-time escrow`
        : "the funds sit in the one-time escrow";
    return out("FAILED", "Needs attention", [true, true, false, false], `${job === "execute-failed" ? "The execution failed" : "The re-shield failed"}: ${where}${f.job?.error ? ` (${f.job.error})` : ""}. ${job === "execute-failed" ? "Confirm again with a fresh quote, or return it" : "Return it"} to your private balance; anyone can call ${inToken && !f.refundTokensHeldOwn ? "refundToken on the escrow for the refund token it holds" : "deployAndRefund"} after ${new Date(p.refundAfter * 1000).toLocaleString()}.`, extras);
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
  // a relayer's "refunded" for an order its escrow still holds whole, never executed (C12-1 set the word aside; the twelfth review round, XG's and
  // XH's critiques): the relayer dropped the order. Past its window DROPPED — nothing was swapped, the funds held for it, returned through the relayer
  // Settings name when it is another one (orderRunner's refund io: its own answers a refund-only request with the job it keeps), or by anyone's
  // deployAndRefund from its refund time. Read as a closed window with no job, it had never been offered back and held the band's in-flight slot for
  // good; a campaign's step had waited "refunding" for good. Inside its window it reads as funded, in words that say so (below)
  const dropped = f.job?.state === "refunded" && !executed && f.escrowBalance !== null && f.escrowBalance >= amount;
  const refundTime = nowS < p.refundAfter ? ` after ${new Date(p.refundAfter * 1000).toLocaleString()}` : "";
  if (dropped && nowS > p.executeDeadline)
    return out(
      "DROPPED",
      "Needs attention",
      [true, true, false, false],
      `Its executor says it returned this order, but the escrow still holds it, so nothing was swapped. Return funds asks the relayer Settings name when it is another one; anyone can call deployAndRefund${refundTime}.`,
      extras,
    );
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
      return out(
        "SOURCE_FINAL",
        "Preparing",
        [true, true, false, false],
        // ... a relayer's "refunded" over it: nothing is swapped, and its return is offered once the window closes (XH's critique: "confirm … or return
        // it" had named two actions the order panel does not offer while the job says refunded)
        dropped
          ? `Its executor says it returned this order, but the escrow still holds it: nothing is swapped, and its return is offered once its execution window closes, at ${new Date(p.executeDeadline * 1000).toLocaleString()}.`
          : "The escrow is funded; confirm the swap against a fresh quote, or return it to your private balance.",
      );
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

const escrowFlagAbi = parseAbi(["function executed() view returns (bool)"]);
/**
 * The escrow's own `executed` flag from every endpoint (the API's read, A9-12; the eleventh review round's K4 critique): null unless they all answer
 * the same. An escrow with no code answers no data: null, never "not executed".
 */
export async function escrowExecuted(deployment: Deployment, escrow: Address): Promise<boolean | null> {
  const clients = clientsFor(deployment);
  const reads = await Promise.all(clients.map((c) => c.readContract({ address: escrow, abi: escrowFlagAbi, functionName: "executed" }).then((v) => v as boolean, () => null)));
  if (reads.some((r) => r === null)) return null;
  return reads.every((r) => r === reads[0]) ? (reads[0] as boolean) : null;
}

const executedEvent = parseAbiItem("event Executed(address indexed provider, uint256 value, bytes32 calldataHash, address executor)");
/**
 * The margin beyond the longest window an order can have between its commit and its execute deadline (the fourth critique's hour: a quote's
 * lifetime and a clock's drift). The escrow executes once.
 */
export const EXECUTION_SEARCH_MARGIN_S = 3600;
/**
 * How far before its execute deadline an order's execution can lie: the longest funding delay any policy allows (DELAY_WINDOW's maxima: the
 * engine's execute window is the policy's delay budget) and the margin. The search starts there, from public facts only (the twelfth review
 * round, C12-9): started from the order's creation by this device's clock, the block it converged on told every endpoint the commit time
 * beside the escrow's address — the moment "Delay for more privacy" keeps off the chain.
 */
export const EXECUTION_SEARCH_SPAN_S = Math.max(...Object.values(DELAY_WINDOW).map((w) => w[1])) + EXECUTION_SEARCH_MARGIN_S;
/** The first block at or after `t` (unix s) between `lo` and `hi`, by the blocks' own times. */
async function firstBlockAtOrAfter(c: PublicClient, t: bigint, lo: bigint, hi: bigint): Promise<bigint> {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await c.getBlock({ blockNumber: mid })).timestamp < t) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}
/**
 * The transaction that executed the escrow, from its own Executed event (the eleventh review round's K4 critique, its third pass): an escrow the
 * flag says executed, with no transaction known — the user's own deployAndExecute (submission "wallet"), a relayer that lost its job, a job that
 * named none. The execution lies in the EXECUTION_SEARCH_SPAN_S before its execute deadline (the block whose time is the deadline included:
 * execute() takes block.timestamp <= the deadline) — public facts only, the deadline being the escrow's own parameter (C12-9): those blocks' logs
 * are read as the pool's are (logsInWindows: one read, else windows halved on an endpoint's refusal), from every endpoint — a hash they all name,
 * else null (none found, or an endpoint that did not answer or disagrees). An escrow executes once.
 */
export async function executionTxOf(deployment: Deployment, escrow: Address, executeDeadlineS: number): Promise<Hex | null> {
  const found = await Promise.all(
    clientsFor(deployment).map(async (c) => {
      try {
        const latest = await c.getBlockNumber();
        const from = await firstBlockAtOrAfter(c, BigInt(executeDeadlineS - EXECUTION_SEARCH_SPAN_S), deployment.fromBlock < latest ? deployment.fromBlock : 0n, latest);
        // the last block whose time is the deadline or before it (the first after it can hold no execution; the latest when none is after it)
        const after = await firstBlockAtOrAfter(c, BigInt(executeDeadlineS) + 1n, from, latest);
        const upTo = after > from && (await c.getBlock({ blockNumber: after })).timestamp > BigInt(executeDeadlineS) ? after - 1n : after;
        const logs = await logsInWindows(c, from, (fromBlock, toBlock) => c.getLogs({ address: escrow, event: executedEvent, fromBlock, toBlock }), undefined, upTo);
        return logs[0]?.transactionHash ?? null;
      } catch {
        return null;
      }
    }),
  );
  return found[0] && found.every((h) => h === found[0]) ? found[0] : null;
}

const ZERO_TOKEN = "0x0000000000000000000000000000000000000000";
/**
 * The refund tokens an order's escrow is read in for a late refund (VC12-N1), each with the rule for a balance held: the route's (refundTokensOf —
 * with the chain's wrapped ETH beside address(0) for an ERC-20 order, XE and XF's critiques), at its floor, and an ETH order's own wrapped ETH, which a
 * route refunds an unfilled ETH deposit in (Across: the escrow's refund() unwraps it), at the order's 1 %. The tracker reads them, and Return funds
 * before it takes a relayer's "refunded" as true (escrowLeftOf; the twelfth review round, XI's critique).
 */
export function refundTokenReads(chainId: number | undefined, stored: StoredSwap): { token: Address; own: boolean; held: (balance: bigint) => boolean }[] {
  const fromToken = (stored.request as { from?: { asset?: string } })?.from?.asset;
  const route = refundTokensOf(chainId, fromToken, stored.refundTokens, stored.refundFloors);
  const weth = (!fromToken || fromToken === "native") && chainId !== undefined ? WRAPPED_NATIVE_OF[chainId] : undefined;
  const orderAmount = BigInt(params(stored).amount);
  // the call's floors are keyed by the token's lower case (providerCall.ts floorOf)
  const floorOf = (token: string): bigint => BigInt(route.refundFloors?.[token.toLowerCase()] ?? route.refundFloors?.[token] ?? "1");
  // `own`: an ETH order's wrapped ETH, which the escrow's refund() re-shields as the order's own (refundToken refuses it)
  const ownOf = (token: string): boolean => !!weth && token.toLowerCase() === weth.toLowerCase();
  return [...((route.refundTokens ?? []) as Address[]), ...(weth ? [weth as Address] : [])].map((token) => ({
    token,
    own: ownOf(token),
    held: (b: bigint) => b > 0n && (ownOf(token) ? lateRefundHeld(b, orderAmount) : b >= floorOf(token)),
  }));
}
/**
 * What an order's escrow still holds to return, by `read` (the escrow's balance of a token — address(0) and the order's ETH as null —, null when not
 * read): "asset", the order's own asset above dust (lateRefundHeld) or an ETH order's wrapped ETH held (refund() re-shields both); "token", one of the
 * route's refund tokens held (refundTokenReads; refundToken re-shields it); false, nothing; null when any of it was not read. Return funds takes a
 * relayer's "refunded" as true only on false (the twelfth review round, XI's critique: read in the order's asset alone, a refund token held after an
 * execution had been taken as returned, and the order closed Refunded with the token in the escrow), and words its refusal by what is held (XJ's).
 */
export async function escrowLeftOf(stored: StoredSwap, chainId: number | undefined, read: (token: Address | null) => Promise<bigint | null>): Promise<"asset" | "token" | false | null> {
  const fromToken = (stored.request as { from?: { asset?: string } })?.from?.asset;
  const reads = refundTokenReads(chainId, stored);
  const [asset, held] = await Promise.all([
    read(fromToken && fromToken !== "native" ? (fromToken as Address) : null).catch(() => null),
    Promise.all(
      reads.map(async (x) => {
        const b = await read(x.token.toLowerCase() === ZERO_TOKEN ? null : x.token).catch(() => null);
        return b === null ? null : x.held(b);
      }),
    ),
  ]);
  if (asset === null || held.some((x) => x === null)) return null;
  if (lateRefundHeld(asset, BigInt(params(stored).amount)) || reads.some((x, i) => x.own && held[i] === true)) return "asset";
  return held.some((x) => x === true) ? "token" : false;
}

export interface TrackDeps {
  deployment: Deployment | null;
  relayerUrl?: string | null;
  now?: number;
  session?: WalletSession;
  /** tests: replace the readers */
  readers?: {
    job?: (s: StoredSwap) => Promise<SwapJob | null>;
    balance?: (s: StoredSwap) => Promise<bigint | null>;
    track?: (s: StoredSwap, tx: string) => Promise<TrackResult["track"] | null>;
    executed?: (s: StoredSwap) => Promise<boolean | null>;
    executionTx?: (s: StoredSwap) => Promise<Hex | null>;
    /** the escrow's balance in one of the route's refund tokens (VC12-N1) */
    tokenBalance?: (s: StoredSwap, token: Address) => Promise<bigint | null>;
  };
  /**
   * High-Value Protection spec §10: the hand-over time (unix s) and the plan's seconds, by which the wallet suspects a
   * stalled settlement. The read then names the order's operation, and the service decides from its own records (the
   * hand-over, the plan, the relayer's execution); a V6 follow-up of 2026-10-14 — the service had taken a caller's
   * timing on trust, and anyone could open a provider's breaker for every user.
   */
  stall?: { since: number; expected: number };
}

/**
 * Read the facts, derive the state, journal what changed (executionTx once, the track read, a history entry per transition, the Activity label).
 * Returns the derived state, the job it read (an ended job — lapsed, expired or a failed execution, never a failed re-shield — whose escrow's flag
 * reads executed comes back `executed` until its executor's watch would have ended, `completed` after: C12-6, XQ's critique) and the journal state
 * the reading gives (`journal`; null: as it is), which the order runner closes on. A closed order whose reading does not close it (none of
 * CLOSING_READINGS) journals no track and no history; it is answered with the journal's last reading where that reading closes an order, or is a
 * lapsed order's own refund pending (`closingOf`), and with this reading otherwise (the twelfth review round). A late refund that reopens a closed
 * order whose record is not terminal is journaled, the order journaled executed again and an order tick planned unless it is a campaign's (gap 91's
 * Return funds).
 */
export async function trackOrder(stored: StoredSwap, deps: TrackDeps): Promise<{ tracked: Tracked; job: SwapJob | null; journal: string | null }> {
  const s = deps.session ?? defaultSession;
  const now = deps.now ?? Date.now();
  const r = deps.readers ?? {};
  // the relayer the order was handed to, whatever Settings name since (audit round 2, r38 — the runner's rule, now every screen's: the
  // ninth review round, C-01): read from today's relayer, a handed-over order was unknown there and read as never funded
  const relayer = stored.relayerUrl ?? deps.relayerUrl;
  const jobRead = await (r.job ? r.job(stored) : stored.jobId && relayer ? relayerSwapStatus(relayer, stored.jobId).catch(() => null) : Promise.resolve(null));
  // the escrow's own flag once its funds came back — a refund found, or the job's word (K4): final then, the one fact that tells a refund in full from
  // the rest of an execution when the job or the provider is not read, or when a relayer keeps a reverted execution's transaction. Read before
  // the provider, whom the execution is asked about
  const refundBack = refundNotesBack(stored) || jobRead?.state === "refunded";
  // ... and when the job names no execution (the twelfth review round, C12-6): executed or completed with no transaction — a relayer whose own
  // event read failed, a copy of its call that landed first —, or ended with none named past the window, when the flag is final (lapsed,
  // expired, a failed refund or execution): such an order had never been read for what it did, polled for good or closed lapsed while it delivered
  const pastWindow = Math.floor(now / 1000) > params(stored).executeDeadline;
  const namesNone = !!jobRead && !jobRead.executionTx && (jobRead.state === "executed" || jobRead.state === "completed" || (pastWindow && ENDED_JOB_STATES.includes(jobRead.state)));
  const flag = !(refundBack || namesNone) ? undefined : r.executed ? await r.executed(stored).catch(() => null) : deps.deployment ? await escrowExecuted(deps.deployment, stored.endpoint as Address).catch(() => null) : undefined;
  // an ended job — lapsed, expired or a failed execution —, for an escrow its own flag reads executed (read for one naming no execution past the window,
  // or for any whose refund came back), reads as an executor that stopped watching it (C12-6 and its critique): its execution is looked for, its
  // provider asked, and it settles on the provider's last word with the escrow read empty — a refund held in the escrow its Return funds —, read at
  // the late pace. Read as executed for good it had never closed, polled every 15 seconds
  // ... once its executor's watch would have ended; until then as an executed job (the twelfth review round, XQ's critique): the relayer marks such a
  // job executed itself at its refund time and re-shields what comes back inside the watch (it lapses one only a day past that time), and read as a
  // completed job before, a provider's refund on its way over an escrow read empty had closed it "nothing more comes back on its own", a campaign
  // step ended lost
  // ... never a failed re-shield: its executor saw something to move, and read as a completed job over an escrow emptied since it had said "nothing comes
  // back on its own", a campaign step ended lost (XP's critique) — it reads as its failed re-shield, as before the round
  // ... and on a read where the flag could not be read, as the one that read it executed did: an escrow's executed flag never goes back, and a read that
  // found it true is journaled (escrowExecutedSeen; XU's critique: one endpoint down had turned the reading back to the job's own words — "Confirm
  // again", a campaign step paused as failed while its provider delivered; XV's: kept by the Executed event's search alone, a failed search had lost it)
  // ... the same mark read wherever the flag is: whether the escrow executed, and which tokens are asked (XW's critique: read as unknown there, a
  // relayer's refunded job naming no execution had closed Refunded in full on a failed read, and a token held had gone unread beside it)
  const executedSeen = flag === true || (flag === null && !!stored.escrowExecutedSeen);
  const watchEnded = Math.floor(now / 1000) >= params(stored).refundAfter + EXECUTOR_LATE_REFUND_WATCH_SECONDS;
  const job: SwapJob | null =
    jobRead && executedSeen && jobRead.state !== "refund-failed" && ENDED_JOB_STATES.includes(jobRead.state)
      ? { ...jobRead, state: watchEnded ? "completed" : "executed" }
      : jobRead;
  // ... and a lapsed job whose escrow's flag could not be read, for an order whose funding was seen, is never closed lapsed on the job alone: read
  // again (the critique: one endpoint down had closed it, and the later reading that it executed was refused as a reopen) — so too when a read
  // before found the flag true: its reading is not journaled on such a read either, read again (stated: XX's critique)
  const lapsedUnread = jobRead?.state === "lapsed" && flag === null && fundingSeenOf(stored);
  // the transaction asked about. The job's, once it is read (audit round 2, r01): the relayer names the transaction that executed the escrow —
  // a copy of its own call that landed first replaces the one it had sent, which reverted and which no provider saw. With no job's: the escrow's
  // flag, read once its funds came back, decides (K4's third and fourth critiques) — executed: the escrow's own Executed event names its one
  // execution, over the journal's, which may be the relayer's own call that reverted (a handed-over order's; a jobId-less order's was the
  // event's), the journal's only when the event cannot be read; not read: the journal's (another relayer's job — a Return funds answered by the
  // relayer Settings names — knows no execution, and the order had read refunded in full, its transaction deleted); never executed: none.
  // Before its funds came back (no flag read), a job that names none takes the journal's away (r01), and with no job read the journal's stands
  // ... once: the event's transaction journaled, it is not looked for again (the critique: the whole span was searched at every read)
  const eventFirst = flag === true && !job?.executionTx && (!!stored.jobId || !stored.executionTx) && !stored.executionFromEvent;
  const fromEvent = eventFirst
    ? await (r.executionTx ? r.executionTx(stored) : deps.deployment ? executionTxOf(deps.deployment, stored.endpoint as Address, params(stored).executeDeadline) : Promise.resolve(null)).catch(() => null)
    : null;
  const executionTx = job?.executionTx ?? fromEvent ?? (flag === true || flag === null || (flag === undefined && !job) ? stored.executionTx : undefined) ?? undefined;
  const fromToken = (stored.request as { from?: { asset?: string } })?.from?.asset;
  // read for a funded order, and for one a refund is reported for (C12-1: a refund counts only on the escrow's balance read empty)
  const balance = await (r.balance ? r.balance(stored) : (fundedOf(stored) || refundBack) && deps.deployment ? escrowBalance(deps.deployment, stored.endpoint as Address, fromToken && fromToken !== "native" ? (fromToken as Address) : null).catch(() => null) : Promise.resolve(null));
  // a late refund in a refund token (VC12-N1): read only for an executed order whose executor stopped watching (its job `completed`), each token
  // held once its balance reaches the floor the call named for it
  // ... and, for an ETH order, in the chain's wrapped ETH, which a route refunds an unfilled ETH deposit in (Across: the escrow's refund()
  // unwraps it and re-shields it), at the order's own floor (the critique of VC12-N1)
  // ... and for an ERC-20 order whose route refunds in ETH (a refund token of address(0): LI.FI's swap into ETH before it bridges), in wrapped ETH too, at
  // that token's floor (the fifth critique, XE: an Across leg refunds such an unfilled deposit in WETH) — as a refund token of the route's, which the
  // executor re-shields and Return funds returns (refundTokensOf; XF's critique: read but never listed, it had read a late refund nothing could return)
  // (refundTokenReads: the route's at their floors, an ETH order's wrapped ETH at its 1 %)
  // ... and for a refunded job after an execution (XD's critique: re-shielded in part inside its watch, the provider's second refund in a refund token after
  // it was never read)
  // ... never on a transaction the escrow's own flag says did not execute it (XF's critique: a relayer keeps a reverted execution's hash)
  // ... and for a failed re-shield after an execution, whose FAILED sentence names a refund token held there and refundToken for it (XL's and XO's critiques)
  // ... and on a read where the relayer it was handed to did not answer, for an order an execution was seen for (XV's critique: read as holding none, a
  // token held had closed a refund Refunded, a refund at the destination, and a campaign step's other-token Partial, for good)
  const tokensAsked =
    job?.state === "completed" ||
    ((job?.state === "refunded" || job?.state === "refund-failed") && flag !== false && (executedSeen || !!executionTx)) ||
    (!!stored.jobId && !jobRead && flag !== false && (executedSeen || !!executionTx));
  const tokenReads = tokensAsked
    ? await Promise.all(
        refundTokenReads(deps.deployment?.chainId, stored).map(async (x): Promise<{ token: string; balance: bigint; own: boolean } | "unread" | null> => {
          // a refund token of address(0) is the escrow's own ETH, read as a balance — as an ERC-20 it answered nothing, and a refund in ETH was never seen (XE)
          const asErc20 = x.token.toLowerCase() === ZERO_TOKEN ? null : x.token;
          const b = await (r.tokenBalance ? r.tokenBalance(stored, x.token) : deps.deployment ? escrowBalance(deps.deployment, stored.endpoint as Address, asErc20).catch(() => null) : Promise.resolve(null));
          if (b === null) return "unread";
          return x.held(b) ? { token: x.token, balance: b, own: x.own } : null;
        }),
      )
    : [];
  const heldTokens = tokenReads.filter((x): x is { token: string; balance: bigint; own: boolean } => x !== null && x !== "unread");
  // ... and a token not read is not known to be empty (XI's critique: one failed read had closed a refund at the destination, the token held since never
  // offered back): null, read again
  const refundTokensHeld = heldTokens.length > 0 ? true : tokenReads.includes("unread") ? null : tokensAsked ? false : undefined;
  // ... named in their own units where this wallet knows the token (XC's critique: "a refund in the route's refund token", even for wrapped ETH)
  // ... wrapped ETH named whatever the order's asset (XF's critique: an ERC-20 order's own refund token of WETH — the Across leg into WETH — had read
  // "a refund in the route's refund token")
  const wrapped = deps.deployment ? WRAPPED_NATIVE_OF[deps.deployment.chainId] : undefined;
  const tokenOf = (token: string): { symbol: string; decimals: number } | undefined =>
    wrapped && token.toLowerCase() === wrapped.toLowerCase()
      ? { symbol: "WETH", decimals: 18 }
      : token.toLowerCase() === ZERO_TOKEN
        ? { symbol: "ETH", decimals: 18 }
        : deps.deployment?.erc20Vaults?.find((v) => v.token.toLowerCase() === token.toLowerCase());
  const heldNames = heldTokens.map((x) => {
    const k = tokenOf(x.token);
    return k ? `${fmtUnits(x.balance, k.decimals)} ${k.symbol}` : null;
  });
  const refundTokensHeldAs = heldNames.length && heldNames.every((x) => x !== null) ? heldNames.join(", ") : undefined;
  // ... and whether each is an ETH order's own wrapped ETH, which refund() moves and refundToken refuses (XU's critique)
  const refundTokensHeldOwn = heldTokens.length > 0 && heldTokens.every((x) => x.own);
  const track = executionTx ? await (r.track ? r.track(stored, executionTx) : swapService.track(stored.provider, { tx: executionTx, ...decimalsOf(stored), ...(stored.executionRef ? { ref: stored.executionRef } : {}), ...(deps.stall && stored.operationId && (now / 1000 - deps.stall.since) > STALL_FACTOR * deps.stall.expected ? { operation: stored.operationId } : {}) }).then((x) => x.track, () => null)) : null;
  // the provider asked about the execution and giving no track: its read failed, or its answer carried none (K4). The order as read: with the
  // transaction asked about
  const asRead = executionTx && executionTx !== stored.executionTx && !job?.executionTx ? { ...stored, executionTx } : stored;
  const tracked = deriveState(asRead, { now, job, escrowBalance: balance, track, refundFound: refundNotesBack(stored), providerUnread: !!executionTx && track == null, ...(flag !== undefined ? { escrowExecuted: executedSeen ? true : flag } : {}), ...(refundTokensHeld !== undefined ? { refundTokensHeld, ...(refundTokensHeldAs ? { refundTokensHeldAs } : {}), ...(refundTokensHeldOwn ? { refundTokensHeldOwn } : {}) } : {}) });
  const closed = SWAP_CLOSED_STATES.includes(stored.state);
  // a late refund reopens a closed order only while its record can still offer the Return funds (I-O1: a terminal record never changes); a
  // terminal one keeps its order closed — the escrow's refund is anyone's to make past its refund time, and the scan finds it (the critique)
  const recordTerminal = closed && isTerminal(getOperation(`swap:${stored.orderId.toLowerCase()}`, s)?.state ?? "DRAFT");
  const own0 = lapsedUnread ? undefined : journalStateOf(stored, tracked, job);
  const own = own0 && closed && !SWAP_CLOSED_STATES.includes(own0) && recordTerminal ? undefined : own0;
  // a closed order the reading reopens — a late refund in its escrow (gap 91: Return funds is offered for it) — is read by its runner again (the
  // twelfth review round, C12-3): reopened with no tick planned, it had stayed open and in flight for good
  const reopened = !!own && closed && !SWAP_CLOSED_STATES.includes(own);
  // a closed order's reading that does not settle — the provider or the escrow not read, an executor still watching — leaves the reading that closed
  // it as it was, and is answered as it (C12-3's critique): written over it, a provider failure's record had read Executing on a Refresh, and the
  // next re-sync with no reading "Swap complete"
  const keepsClosed = closed && !reopened && !CLOSING_READINGS.includes(tracked.state);
  // journal: executionTx once, the read, a transition when the state changed
  if (s.isUnlocked()) {
    s.update((j) => {
      const x = j.swaps.find((y) => y.orderId.toLowerCase() === stored.orderId.toLowerCase());
      if (!x) return;
      // the transaction asked about, as above: a job naming none before the funds came back (r01), or the flag's word that the escrow never
      // executed, takes the journal's away
      const journaledTx = x.executionTx;
      if (executionTx && x.executionTx !== executionTx) x.executionTx = executionTx;
      else if (!executionTx && x.executionTx && (job || flag === false)) delete x.executionTx;
      // the mark that the journaled transaction is the escrow's own Executed event's: set with it, gone once another, or none, is journaled (the
      // second critique, XB: a refund-only job's read had taken the transaction away and kept the mark, and the order was never read for what it
      // did again — "looked for again" at every read, in flight for good)
      if (fromEvent && executionTx === fromEvent) x.executionFromEvent = true;
      else if (x.executionTx !== journaledTx) delete x.executionFromEvent;
      // the escrow's flag read true, kept until every endpoint says it did not execute (XV's critique)
      if (flag === true) x.escrowExecutedSeen = true;
      else if (flag === false) delete x.escrowExecutedSeen;
      // a pause waiting for the user's choice ends with a settled reading, or with the escrow's word that it executed (the fourth critique): read
      // by a Refresh first, an executed order had kept "nothing was swapped; your funds wait in your one-time escrow", and its runner had stopped
      if (x.paused && (own === "refunded" || own === "completed" || (flag === true && !x.jobId))) delete x.paused;
      if (!keepsClosed) {
        x.track = { state: tracked.state, label: tracked.label, at: now, ...(tracked.settlement ? { settlement: tracked.settlement } : {}), ...(track?.destinationTxHash ? { destinationTxHash: track.destinationTxHash } : {}), ...(track?.deliveredAmount !== undefined ? { deliveredAmount: String(track.deliveredAmount) } : x.track?.deliveredAmount !== undefined ? { deliveredAmount: x.track.deliveredAmount } : {}), ...(track?.refundedAmount !== undefined ? { refundedAmount: String(track.refundedAmount) } : x.track?.refundedAmount !== undefined ? { refundedAmount: x.track.refundedAmount } : {}), ...(track?.progress ? { progress: track.progress } : {}), ...(tracked.otherToken ? { otherToken: true } : {}), ...(tracked.deliveredAsset ? { deliveredAsset: tracked.deliveredAsset } : {}) };
        const last = x.history?.[x.history.length - 1];
        if (!last || last.state !== tracked.state) x.history = [...(x.history ?? []), { state: tracked.state, at: now, note: tracked.label }];
      }
      if (own && x.state !== own) x.state = own;
    });
    // High-Value Protection spec §12: a settled payment retires a fresh destination (one use) and marks an entered one paid
    const r = stored.request as { to?: { chain?: string }; destination?: string };
    if ((tracked.state === "COMPLETED" || tracked.state === "DESTINATION_FINAL" || tracked.state === "REFUNDED_AT_DESTINATION") && stored.track?.state !== tracked.state && r.to?.chain && r.destination) markAddressSettled(chainKindOf(r.to.chain), r.destination, s, now);
    updateActivity(activityId("swap", stored.orderId), { status: own ?? stored.state, note: `${(stored.request as { to?: { symbol?: string } })?.to?.symbol ? `→ ${(stored.request as { to?: { symbol?: string } }).to!.symbol} · ` : ""}${tracked.label}` }, s);
    if (reopened && !stored.campaign) scheduleAction({ kind: "order-tick", orderId: stored.orderId, dueAt: now }, s);
  }
  // ... and the journal state the reading gives, as decided here (`null`: as it is) — the runner closes on it, never on its own reading of the job (XB's
  // critique: a lapsed job with the escrow's flag unread, left open here, had been closed lapsed by the runner's settle)
  // ... the journal's last reading only where it is one that closes an order (XC's critique: a close that wrote no reading — step 1b's refund, the
  // scan's — had answered the open reading a Refresh journaled before, "Preparing" for an order refunded)
  // ... or a lapsed order's own refund pending (XF's critique: read while its relayer did not answer, a lapsed order had been answered "Executing")
  const closing =
    keepsClosed && stored.track && (CLOSING_READINGS.includes(stored.track.state as OrderState) || (stored.state === "lapsed" && stored.track.state === "REFUND_PENDING")) ? stored.track : null;
  return { tracked: closing ? closingOf(closing, tracked) : tracked, job, journal: own ?? null };
}

const CLOSED_STEPS: Partial<Record<OrderState, Tracked["steps"]>> = {
  COMPLETED: [true, true, true, true],
  PARTIAL: [true, true, true, true],
  REFUNDED_AT_DESTINATION: [true, true, true, true],
  REFUNDED: [true, true, false, false],
  PROVIDER_FAILED: [true, true, false, false],
  REFUND_PENDING: [true, true, false, false],
  EXPIRED: [true, false, false, false],
  CANCELLED: [true, false, false, false],
};
/** A closed order's last closing reading, answered for a reading that did not settle. */
function closingOf(t: NonNullable<StoredSwap["track"]>, live: Tracked): Tracked {
  const state = t.state as OrderState;
  return {
    ...live,
    state,
    label: t.label as SettlementLabel,
    steps: CLOSED_STEPS[state] ?? live.steps,
    detail: "The order closed at its last reading; this read settled nothing new, so that reading stands.",
    ...(t.settlement ? { settlement: t.settlement as SettlementState } : {}),
  };
}

/**
 * A relayer job that ended: its escrow's flag — read for one naming no execution past the window, or for any whose refund came back — decides what
 * the order did (C12-6); a failed re-shield's job is never read as another (XP's critique).
 */
const ENDED_JOB_STATES: readonly string[] = ["lapsed", "expired", "refund-failed", "execute-failed"];

/**
 * The journal's state a reading gives an order — trackOrder journals it, the order runner settles on it (the eleventh review round's K4 critique) —
 * or undefined when the reading leaves it as it is. A `completed` job closes the order only once it reads settled (audit round 2, r36): until
 * then it stays open, as executed — its "Return funds" and the next reads still reach it. A refund paid at the destination closes it whatever
 * the executor's watch says (the sixth review round). A reading settled on the refund the scan found closes it whatever the job says (the
 * eleventh review round's critique of B11-1): a lapsed, refund-failed or expired job had kept it open for good, holding the band's in-flight
 * limit — refunded in full, or a partial fill whose rest came back. Only a settled reading closes it (K4): a refund in full is read only on a word
 * that nothing executed — the escrow's flag, the job read, no hand-over ever asked — or the provider's that nothing was delivered (its refund, its
 * failure); a refunded job whose reading has not settled — a delivery on its way, a provider not read or telling nothing, whether it executed not
 * known — keeps the order open, as executed, whatever the job says (a refunded job whose provider was not read had closed it, its delivered part
 * lost), and never reopens a closed one. A delivery final at the destination closes it too (the shield receipt's notes found: an order its runner
 * stopped reading had stayed open, in flight)
 */
export function journalStateOf(stored: Pick<StoredSwap, "state" | "refunds"> & Partial<Pick<StoredSwap, "params" | "refundVaults">>, tracked: Pick<Tracked, "state">, job: Pick<SwapJob, "state"> | null): string | undefined {
  const next = journalReadingOf(stored, tracked, job);
  // a closed order is never reopened by a reading that did not settle (the twelfth review round, C12-3): a read with the provider down or the
  // escrow's balance unread had moved a completed order back to executed — no tick planned for it, the band's one in-flight slot held. A late
  // refund held in its escrow, read by every endpoint, is the one reading that reopens it, for its Return funds (gap 91)
  if (next !== undefined && SWAP_CLOSED_STATES.includes(stored.state) && !SWAP_CLOSED_STATES.includes(next) && tracked.state !== "LATE_REFUND") return undefined;
  return next;
}
function journalReadingOf(stored: Pick<StoredSwap, "state" | "refunds"> & Partial<Pick<StoredSwap, "params" | "refundVaults">>, tracked: Pick<Tracked, "state">, job: Pick<SwapJob, "state"> | null): string | undefined {
  const refundFound = refundNotesBack(stored);
  if (tracked.state === "REFUNDED_AT_DESTINATION" || tracked.state === "COMPLETED") return "completed";
  if (refundFound && tracked.state === "REFUNDED") return "refunded";
  if (refundFound && tracked.state === "PARTIAL") return "completed";
  if (job?.state === "refunded" && (tracked.state === "PROVIDER_EXECUTING" || tracked.state === "DESTINATION_SUBMITTED")) return stored.state === "refunded" || stored.state === "completed" ? undefined : "executed";
  // a relayer's "refunded" closes the order only with a reading that settled on it — the escrow read empty (C12-1): with the escrow still holding
  // the order, or its balance unread, it leaves the order as it is
  if (job?.state === "refunded" && tracked.state !== "REFUNDED" && tracked.state !== "PARTIAL") return undefined;
  if (job?.state === "completed" && !CLOSED_BY_TRACK.includes(tracked.state)) return "executed";
  return job?.state;
}

/** The §61 label of a journaled order without a fresh read (Activity rows): the last derived one, else from the relayer state. */
export function journaledLabel(s: StoredSwap): SettlementLabel | null {
  return (s.track?.label as SettlementLabel | undefined) ?? null;
}
