// What the verified history says about a note (spec v3.0 §7.4): its deposit (by commitment), how many came after it,
// and whether the Withdrawal history holds its nullifier hash — answered from the device, disclosing nothing. The
// on-chain `isSpent` read is a separate, explicit act: it tells the endpoint the note's nullifier hash, and the screen
// that asks for it says so.
import type { DepositFacts } from "../model/types";
import type { DepositEvent, Hex, WithdrawalEvent } from "./events.ts";
import type { Rpc } from "./sync.ts";
import { call, SELECTORS, wordOf } from "./verify.ts";

/** Deposits by commitment, for many lookups. */
export const indexDeposits = (deposits: readonly DepositEvent[]): Map<string, DepositEvent> => new Map(deposits.map((d) => [d.commitment.toLowerCase(), d]));
/** Withdrawals by nullifier hash. */
export const indexWithdrawals = (withdrawals: readonly WithdrawalEvent[]): Map<string, WithdrawalEvent> =>
  new Map(withdrawals.map((w) => [w.nullifierHash.toLowerCase(), w]));

export interface HistoryIndex {
  deposits: Map<string, DepositEvent>;
  withdrawals: Map<string, WithdrawalEvent>;
  /** the leaf count: deposits since = leaves − 1 − leafIndex */
  leaves: number;
}

export const indexHistory = (deposits: readonly DepositEvent[], withdrawals: readonly WithdrawalEvent[]): HistoryIndex => ({
  deposits: indexDeposits(deposits),
  withdrawals: indexWithdrawals(withdrawals),
  leaves: deposits.length,
});

/** The note's deposit facts from the history, or null when no deposit carries its commitment. */
export function depositFacts(index: HistoryIndex, commitment: Hex, nullifierHash: Hex): DepositFacts | null {
  const d = index.deposits.get(commitment.toLowerCase());
  if (!d) return null;
  return {
    leafIndex: d.leafIndex,
    timestamp: d.timestamp,
    blockNumber: d.blockNumber,
    txHash: d.transactionHash,
    depositsSince: index.leaves - 1 - d.leafIndex,
    spent: index.withdrawals.has(nullifierHash.toLowerCase()),
  };
}

/** The withdrawal that spent a nullifier hash, from the history. */
export const withdrawalOf = (index: HistoryIndex, nullifierHash: Hex): WithdrawalEvent | null => index.withdrawals.get(nullifierHash.toLowerCase()) ?? null;

/** `isSpent(nullifierHash)` on chain — discloses the nullifier hash to the endpoint (the caller says so on screen). */
export async function isSpentOnChain(rpc: Rpc, address: Hex, nullifierHash: Hex): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(nullifierHash)) throw new Error("a nullifier hash is 32 bytes");
  return wordOf(await call(rpc, address, SELECTORS.isSpent + nullifierHash.slice(2).toLowerCase())) === 1n;
}
