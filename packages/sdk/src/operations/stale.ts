// Operations whose own flow is gone (a V6 follow-up of 2026-10-14). A Protect, a Send or a withdrawal moves its record
// forward only through the events of its own flow. A reload or a closed tab during it therefore left the record open for
// good: Home's "in flight" card stayed, and so did Activity's pending row. After each note scan (../wallet/discovery.ts),
// every such record is read from the chain instead:
// - submitted, its transaction known: the receipt completes it, a revert fails it (nothing moved), and a transaction the
//   node no longer knows STALE_DROP_MS after the record last moved fails it too (the relayer drops such a transaction
//   after the same time);
// - stopped before "submitting" (in the proof, say): nothing was sent, so it fails, nothing moved;
// - "submitting" with no answer yet: left as it is, since the record cannot tell whether it was sent.
// A record a flow of this page still drives (store.ts `isLiveOperation`) and a swap (its runner moves it) are never
// touched here.
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from "viem";
import { clientFor, type Deployment } from "../chain";
import { isDraft, isOpen, type OperationKind } from "../wallet/operationRecord";
import { session as defaultSession, type WalletSession } from "../wallet/session";
import { allOperations, applyEvent, isLiveOperation } from "./store";

/** The kinds one transaction finishes, which only their own flow moves forward. */
const SINGLE_TRANSACTION: ReadonlySet<OperationKind> = new Set<OperationKind>(["protect", "send", "withdraw"]);

/** How long a transaction the node no longer knows is waited for before its record fails (the relayer's DROP_AFTER_MS). */
export const STALE_DROP_MS = 10 * 60_000;

export interface StaleReads {
  /** the receipt's status, or null while the transaction is not mined; throws when it cannot be read */
  receipt(hash: Hex): Promise<"success" | "reverted" | null>;
  /** the node knows the transaction (pending or mined); throws when it cannot be read */
  txKnown(hash: Hex): Promise<boolean>;
}

/** The reads through the wallet's own RPC. */
export function staleReads(d: Deployment): StaleReads {
  const client = clientFor(d);
  return {
    receipt: async (hash) => {
      try {
        return (await client.getTransactionReceipt({ hash })).status;
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    txKnown: async (hash) => {
      try {
        await client.getTransaction({ hash });
        return true;
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return false;
        throw e;
      }
    },
  };
}

/** Move every open record whose flow is gone as the chain says; returns how many moved. */
export async function reconcileStaleOperations(reads: StaleReads, now = Date.now(), s: WalletSession = defaultSession): Promise<number> {
  let moved = 0;
  for (const r of allOperations(s)) {
    if (!SINGLE_TRANSACTION.has(r.kind) || !isOpen(r.state) || isDraft(r.state) || isLiveOperation(r.id)) continue;
    const hash = r.refs.txHashes[r.refs.txHashes.length - 1] as Hex | undefined;
    try {
      if (hash) {
        const status = await reads.receipt(hash);
        if (status === "success") applyEvent(r.id, { type: "completed", ref: { txHash: hash } }, s, now);
        else if (status === "reverted")
          applyEvent(r.id, { type: "submission-failed", code: "receipt_reverted", detail: `transaction ${hash} reverted` }, s, now);
        else if (now - r.updatedAt > STALE_DROP_MS && !(await reads.txKnown(hash)))
          applyEvent(r.id, { type: "submission-failed", code: "transaction_dropped", detail: `transaction ${hash} was dropped before it was mined` }, s, now);
        else continue;
      } else if (r.progress?.step !== "submitting") {
        applyEvent(r.id, { type: "submission-failed", code: "interrupted", detail: "the page was closed or reloaded before anything was sent" }, s, now);
      } else continue;
      moved++;
    } catch {
      // the chain could not be read: the next scan tries again
    }
  }
  return moved;
}
