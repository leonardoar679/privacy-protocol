// Swap refunds back into the wallet (PP-S09). A refunded order re-shields through the escrow's
// refund(), which deposits into the vault with the payload the order committed to. That payload is
// random, not a spec §12 envelope, so note discovery cannot see the refund; the journal keeps it. An
// insert carrying a journaled payload is only a candidate: it is ours once its commitment recomputes
// from the vault's Deposited amount, this wallet's owner commitment and the order's refund secret. A
// lying endpoint can hide a refund, never invent or resize one. refund() re-shields whatever arrives,
// so one order can be refunded more than once: every match is kept.
import type { Hex } from "viem";
import { deriveNoteSecret, type WalletKeys } from "@ref/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@ref/note";
import type { DepositedLog, NoteInsertedLog } from "./chain";
import type { StoredSwap } from "../wallet/journal";

/** What the wallet needs to recognise an order's refund: the committed payload and the counter its secret derives from. */
export interface RefundClaim { orderId: string; noteData: Hex; counter: number }
export interface RecoveredRefund { orderId: string; leafIndex: number; note: Note; counter: number; commitment: bigint; noteData: Hex; txHash: Hex }

/** The refunds the journaled orders can receive. */
export const refundClaims = (swaps: StoredSwap[]): RefundClaim[] =>
  swaps.filter((s) => s.refundNoteData).map((s) => ({ orderId: s.orderId, noteData: s.refundNoteData as Hex, counter: s.refundCounter }));

const payloads = (claims: RefundClaim[]) => new Map(claims.map((c) => [c.noteData.toLowerCase(), c]));

/** Whether any insert carries a claimed payload: only then are the vault deposits read. */
export const hasRefundCandidates = (logs: NoteInsertedLog[], claims: RefundClaim[]): boolean => {
  const want = payloads(claims);
  return want.size > 0 && logs.some((l) => want.has(l.noteData.toLowerCase()));
};

/** The inserts that are refunds of this wallet's orders, each proven by its commitment. */
export function matchRefunds(keys: Pick<WalletKeys, "spendKey" | "noteKey">, logs: NoteInsertedLog[], deposits: DepositedLog[], claims: RefundClaim[]): RecoveredRefund[] {
  const oc = ownerCommitmentOf(keys.spendKey);
  const want = payloads(claims);
  const depositAt = new Map(deposits.map((x) => [x.leafIndex, x]));
  const out: RecoveredRefund[] = [];
  for (const l of logs) {
    const c = want.get(l.noteData.toLowerCase());
    if (!c) continue;
    // a transaction output can copy the payload once it is public; only a vault deposit made out to us counts
    const dep = depositAt.get(l.leafIndex);
    if (!dep || dep.ownerCommitment !== oc) continue;
    const note: Note = { vaultId: BigInt(dep.vault), amount: dep.amount, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, c.counter) };
    if (noteCommitment(noteBody(note), BigInt(l.leafIndex)) !== l.commitment) continue; // another amount or vault than the one inserted
    out.push({ orderId: c.orderId, leafIndex: l.leafIndex, note, counter: c.counter, commitment: l.commitment, noteData: l.noteData, txHash: l.transactionHash });
  }
  return out;
}
