// The engine's typed events (spec §12): sdk/privateTx.ts emits one beside each of its status strings — the strings
// are untouched — and the operation record follows them through fromEngineEvent. A merge is a nested private
// transaction (its own proof and submission): its events arrive between "merging" and the spend's own "proving".
import type { Hex } from "viem";
import type { OperationEvent } from "./types";

export type EngineEvent =
  | { type: "fee-terms" }
  | { type: "syncing" }
  | { type: "verifying" }
  | { type: "merging"; i: number; n: number }
  | { type: "proving" }
  | { type: "proved"; ms: number; verifiedLocally: boolean }
  | { type: "wallet-prompt"; step: "approve" | "deposit" | "transact"; i: number; n: number }
  | { type: "approved"; txHash: Hex }
  /** `nullifiers` (decimal) and, through a relayer, its `relayerUrl`: what an order journals before its funding is sent */
  | { type: "submitting"; by: "relayer" | "wallet"; nullifiers?: [string, string]; relayerUrl?: string }
  | { type: "relayer-retry"; attempt: number }
  | { type: "submitted"; txHash: Hex; by: "relayer" | "wallet" }
  | { type: "waiting-receipt"; txHash: Hex }
  | { type: "mined"; txHash: Hex; leafIndex?: number }
  /** V6 (spec v2.0 §3): emitted before "mined" — the estimate, the relayer's charge (its F) and the real cost */
  | { type: "costs"; estimatedWei?: bigint; actualWei: bigint; charged?: { amount: bigint; asset: string; decimals: number } };

export type OnEvent = (e: EngineEvent) => void;

/** The order a protect emits (ERC-20: the approval first); a send or withdrawal: fee terms, merges, the sync, the verification, the proof, the submission, the receipt. */
export const ENGINE_EVENT_ORDER: readonly EngineEvent["type"][] = ["fee-terms", "merging", "syncing", "verifying", "proving", "proved", "wallet-prompt", "approved", "submitting", "relayer-retry", "submitted", "waiting-receipt", "mined"];

/**
 * The record's event for an engine event. A nested merge's "submitted" / "mined" are progress, not the spend's own
 * submission: the caller passes `nested` while a merge runs (between "merging" and the next "proving" of the spend).
 */
export function fromEngineEvent(e: EngineEvent, opts: { nested?: boolean } = {}): OperationEvent | null {
  switch (e.type) {
    case "fee-terms": return { type: "progress", step: "fee-terms" };
    case "merging": return { type: "progress", step: "merging", i: e.i, n: e.n };
    case "syncing": return { type: "progress", step: "syncing" };
    case "verifying": return { type: "progress", step: "verifying" };
    case "proving": return opts.nested ? null : { type: "progress", step: "proof" };
    case "proved": return opts.nested ? null : { type: "progress", step: "local-verify" };
    case "wallet-prompt": return opts.nested ? null : { type: "progress", step: "submitting", i: e.i, n: e.n };
    case "approved": return opts.nested ? null : { type: "note", note: `approval ${e.txHash}` };
    case "submitting": return opts.nested ? null : { type: "progress", step: "submitting" };
    case "relayer-retry": return opts.nested ? null : { type: "note", note: `relayer unreachable, attempt ${e.attempt}` };
    case "submitted": return opts.nested ? null : { type: "submitted", txHash: e.txHash, by: e.by };
    case "waiting-receipt": return opts.nested ? null : { type: "confirming", txHash: e.txHash };
    case "mined": return opts.nested ? null : { type: "completed", ref: { txHash: e.txHash, ...(e.leafIndex !== undefined ? { leafIndex: e.leafIndex } : {}) } };
    case "costs":
      return opts.nested
        ? null
        : { type: "costs", costs: { ...(e.estimatedWei !== undefined ? { estimatedWei: e.estimatedWei.toString() } : {}), actualWei: e.actualWei.toString(), ...(e.charged ? { charged: { amount: e.charged.amount.toString(), asset: e.charged.asset, decimals: e.charged.decimals } } : {}) } };
    default: return null;
  }
}

/**
 * A listener that feeds a record: tracks the nesting itself (a merge's events are progress; the spend's own
 * "proving" after the merges ends the nesting) and hands the record's events to `apply`.
 */
export function engineListener(apply: (ev: OperationEvent) => void): OnEvent {
  let nested = false;
  return (e) => {
    if (e.type === "merging") nested = true; // a merge's proof and submission follow, as progress
    else if (e.type === "syncing") nested = false; // the spend's own sync comes after the merges
    const ev = fromEngineEvent(e, { nested });
    if (ev) apply(ev);
  };
}
