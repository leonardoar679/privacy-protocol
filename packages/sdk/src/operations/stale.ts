// Operations whose own flow is gone (a V6 follow-up of 2026-10-14). A Protect, a Send or a withdrawal moves its record
// forward only through the events of its own flow. A reload or a closed tab during it therefore left the record open for
// good: Home's "in flight" card stayed, and so did Activity's pending row. After each note scan (../wallet/discovery.ts),
// every such record is read from the chain instead:
// - submitted, its transaction known: the receipt completes it, a revert fails it (nothing moved), and a transaction the
//   node no longer knows STALE_DROP_MS after the record last moved fails it too (the relayer drops such a transaction
//   after the same time);
// - stopped before "submitting" (in the proof, say): nothing was sent, so it fails, nothing moved;
// - "submitting" with no answer yet: what it kept at that step decides. A Protect's note, once the scan found it, completes
//   it. A Send's relayer, asked by the spend's nullifiers, supplies the transaction the page never got. Nullifiers still
//   unspent with no job past STALE_DROP_MS mean nothing moved; spent ones without a known transaction leave it as it is.
// A record a flow of this page still drives (store.ts `isLiveOperation`) and a swap (its runner moves it) are never
// touched here.
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from "viem";
import { clientFor, type Deployment } from "../chain";
import { coreAbi } from "../privacyProtocol";
import { relayerJobFor } from "../relayer";
import { noteStore } from "../wallet/notes";
import { isDraft, isOpen, type OperationKind, type OperationRecord } from "../wallet/operationRecord";
import { session as defaultSession, type WalletSession } from "../wallet/session";
import { allOperations, applyEvent, isLiveOperation } from "./store";
import type { OperationEvent } from "./types";

/** The kinds one transaction finishes, which only their own flow moves forward. */
const SINGLE_TRANSACTION: ReadonlySet<OperationKind> = new Set<OperationKind>(["protect", "send", "withdraw"]);

/** How long a transaction the node no longer knows is waited for before its record fails (the relayer's DROP_AFTER_MS). */
export const STALE_DROP_MS = 10 * 60_000;

export interface StaleReads {
  /** the receipt's status, or null while the transaction is not mined; throws when it cannot be read */
  receipt(hash: Hex): Promise<"success" | "reverted" | null>;
  /** the node knows the transaction (pending or mined); throws when it cannot be read */
  txKnown(hash: Hex): Promise<boolean>;
  /** PrivacyCore's nullifier set; throws when it cannot be read */
  spent(nullifier: bigint): Promise<boolean>;
  /** the relayer's job spending these nullifiers, or null; throws when it cannot be read */
  relayerJob(url: string, nullifiers: [bigint, bigint]): Promise<{ txHash: Hex } | null>;
}

/** The reads through the wallet's own RPC, and the relayer the spend went to. */
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
    spent: async (n) => (await client.readContract({ address: d.core, abi: coreAbi, functionName: "isNullifierSpent", args: [n] })) as boolean,
    relayerJob: (url, nullifiers) => relayerJobFor(url, nullifiers),
  };
}

const INTERRUPTED: OperationEvent = { type: "submission-failed", code: "interrupted", detail: "the page was closed or reloaded before it was sent" };

/** What a record that was submitting when its page went away became: its settling events, the transaction it was sent as, or nothing yet. */
async function fromSubmission(r: OperationRecord, reads: StaleReads, old: boolean): Promise<OperationEvent[] | Hex | null> {
  // the note this submission makes for the wallet (a Protect's deposit, a Send's change): found by the scan, it landed
  if (r.refs.noteCounter !== undefined) {
    const note = noteStore.all().find((n) => n.counter === r.refs.noteCounter);
    if (note) {
      const tx = note.txHash ? { txHash: note.txHash } : {};
      return [
        { type: "submitted", by: r.kind !== "protect" && r.refs.relayerUrl ? "relayer" : "wallet", ...tx },
        { type: "completed", ref: { leafIndex: note.leafIndex, ...tx } },
      ];
    }
  }
  // a Send or a withdrawal: the relayer, asked by its nullifiers, names its transaction; spent ones mean it was sent
  if (r.refs.nullifiers) {
    const nullifiers: [bigint, bigint] = [BigInt(r.refs.nullifiers[0]), BigInt(r.refs.nullifiers[1])];
    const job = r.refs.relayerUrl ? await reads.relayerJob(r.refs.relayerUrl, nullifiers) : null;
    if (job) return job.txHash;
    if ((await Promise.all(nullifiers.map((n) => reads.spent(n)))).some(Boolean)) return null; // sent; its transaction is not known here
  }
  // nothing landed and nothing spent: past the limit, nothing moved; a record that kept nothing is left as it is
  return r.refs.noteCounter !== undefined || r.refs.nullifiers ? (old ? [INTERRUPTED] : null) : null;
}

/** Move every open record whose flow is gone as the chain says; returns how many moved. */
export async function reconcileStaleOperations(reads: StaleReads, now = Date.now(), s: WalletSession = defaultSession): Promise<number> {
  let moved = 0;
  for (const r of allOperations(s)) {
    if (!SINGLE_TRANSACTION.has(r.kind) || !isOpen(r.state) || isDraft(r.state) || isLiveOperation(r.id)) continue;
    const old = now - r.updatedAt > STALE_DROP_MS;
    let hash = r.refs.txHashes[r.refs.txHashes.length - 1] as Hex | undefined;
    let changed = false;
    const apply = (ev: OperationEvent) => {
      const t = applyEvent(r.id, ev, s, now);
      if (t?.ok && t.changed) changed = true;
    };
    try {
      if (!hash) {
        const found = r.progress?.step === "submitting" ? await fromSubmission(r, reads, old) : [INTERRUPTED];
        if (Array.isArray(found)) found.forEach(apply);
        else if (found !== null) {
          apply({ type: "submitted", txHash: found, by: "relayer" }); // the relayer's answer the page never got
          hash = found;
        }
      }
      if (hash) {
        const status = await reads.receipt(hash);
        if (status === "success") apply({ type: "completed", ref: { txHash: hash } });
        else if (status === "reverted") apply({ type: "submission-failed", code: "receipt_reverted", detail: `transaction ${hash} reverted` });
        else if (old && !(await reads.txKnown(hash)))
          apply({ type: "submission-failed", code: "transaction_dropped", detail: `transaction ${hash} was dropped before it was mined` });
      }
    } catch {
      // the chain or the relayer could not be read: the next scan tries again
    }
    if (changed) moved++;
  }
  return moved;
}
