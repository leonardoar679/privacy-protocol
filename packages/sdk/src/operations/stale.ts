// Operations whose own flow is gone (a V6 follow-up of 2026-10-14). A Protect, a Send or a withdrawal moves its record
// forward only through the events of its own flow. A reload or a closed tab during it therefore left the record open for
// good: Home's "in flight" card stayed, and so did Activity's pending row. After each note scan (../wallet/discovery.ts),
// every such record is read from the chain instead:
// - submitted, its transaction known: the receipt completes it, a revert fails it (nothing moved), and a transaction the
//   node no longer knows STALE_DROP_MS after the record last moved fails it too (the relayer drops such a transaction
//   after the same time) — both only while the record's notes are unspent, and every one of these reads is every
//   configured endpoint's (audit round 2, r23: one endpoint's word had failed a Send on its way as "nothing moved");
// - stopped before "submitting" (in the proof, say): nothing was sent, so it fails, nothing moved;
// - "submitting" with no answer yet: what it kept at that step decides. A Protect's note, once the scan found it, completes
//   it. A Send's relayer, asked by the spend's nullifiers, supplies the transaction the page never got. Nullifiers still
//   unspent with no job past STALE_DROP_MS mean nothing moved; spent ones without a known transaction leave it as it is.
// - the transaction of a record that kept its nullifiers must be a call of the core spending them (the audit round of
//   2026-10-16, c42): the relayer's word alone named any mined transaction, and the Send read as completed. One that
//   spends other notes is not this record's: never adopted, and a record already carrying it needs recovery
//   (`not_this_spend`). What this module moves stays its own to move (c43).
// A record a flow of this page still drives (store.ts `isLiveOperation`) and a swap (its runner moves it) are never
// touched here — but one its own page left in RECOVERY_REQUIRED is (audit round 2, r41): that flow is over, and the record
// read "We are checking where your funds are" for good. A record that reached its submission is settled from what it kept
// there (its nullifiers, its relayer, its note) whatever its state: a failure state drops its step, and such a record —
// a lost answer, a retry refused — was failed as "nothing moved: start it again" at the next reload while the relayer had
// sent it.
import { decodeFunctionData, TransactionNotFoundError, type Hex } from "viem";
import { clientFor, outcomeReads, type Deployment } from "../chain";
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
/**
 * ...and one the wallet's own connection sent, no relayer named (audit round 2, n66): a wallet sending through a private
 * mempool shows the RPC nothing until it is mined, and "dropped, send it again" after ten minutes had a Send paid twice.
 */
export const STALE_DROP_WALLET_MS = 60 * 60_000;

export interface StaleReads {
  /** the receipt's status, or null while the transaction is not mined; throws when it cannot be read */
  receipt(hash: Hex): Promise<"success" | "reverted" | null>;
  /** the node knows the transaction (pending or mined); throws when it cannot be read */
  txKnown(hash: Hex): Promise<boolean>;
  /** PrivacyCore's nullifier set; throws when it cannot be read */
  spent(nullifier: bigint): Promise<boolean>;
  /** the relayer's job spending these nullifiers, or null; throws when it cannot be read */
  relayerJob(url: string, nullifiers: [bigint, bigint]): Promise<{ txHash: Hex } | null>;
  /** the nullifiers the transaction's core call spends: null when the node does not know it, [] when it is no transact of
   *  the core; throws when it cannot be read */
  txSpends(hash: Hex): Promise<[bigint, bigint][] | null>;
}

/** The reads through the wallet's own RPC, and the relayer the spend went to. */
export function staleReads(d: Deployment): StaleReads {
  const client = clientFor(d);
  const outcome = outcomeReads(d); // every configured endpoint (audit round 2, r23)
  return {
    receipt: outcome.receipt,
    txKnown: outcome.txKnown,
    spent: outcome.spent,
    relayerJob: (url, nullifiers) => relayerJobFor(url, nullifiers),
    txSpends: async (hash) => {
      let tx;
      try {
        tx = await client.getTransaction({ hash });
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return null;
        throw e;
      }
      if (!tx.to || tx.to.toLowerCase() !== d.core.toLowerCase()) return [];
      try {
        const call = decodeFunctionData({ abi: coreAbi, data: tx.input });
        if (call.functionName !== "transact") return [];
        const pi = call.args[1] as { nullifier0: bigint; nullifier1: bigint };
        return [[pi.nullifier0, pi.nullifier1]];
      } catch {
        return [];
      }
    },
  };
}

/** Whether the transaction spends the record's nullifiers: null when the node does not know it (yet). */
async function spendsRecord(r: OperationRecord, hash: Hex, reads: StaleReads): Promise<boolean | null> {
  if (!r.refs.nullifiers) return true; // a Protect: nothing of the pool spent, nothing to check
  const spends = await reads.txSpends(hash);
  if (spends === null) return null;
  const [n0, n1] = [BigInt(r.refs.nullifiers[0]), BigInt(r.refs.nullifiers[1])];
  return spends.some(([a, b]) => a === n0 && b === n1);
}

/** What the record's submission made shows: the note it makes found by the scan (a Protect's deposit, a Send's change; n66). */
const noteFound = (r: OperationRecord): boolean => r.refs.noteCounter !== undefined && noteStore.all().some((n) => n.counter === r.refs.noteCounter);

/** Whether any note the record spends is spent on chain: a record whose notes are gone never reads "nothing moved" (r23). */
async function notesSpent(r: OperationRecord, reads: StaleReads): Promise<boolean> {
  return r.refs.nullifiers ? (await Promise.all(r.refs.nullifiers.map((n) => reads.spent(BigInt(n))))).some(Boolean) : false;
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
    // the relayer names it; the transaction itself says whether it spends these notes (c42)
    if (job && (await spendsRecord(r, job.txHash, reads)) !== false) return job.txHash;
    if ((await Promise.all(nullifiers.map((n) => reads.spent(n)))).some(Boolean)) return null; // sent; its transaction is not known here
  }
  // nothing landed and nothing spent: past the limit, nothing moved; a record that kept nothing is left as it is
  return r.refs.noteCounter !== undefined || r.refs.nullifiers ? (old ? [INTERRUPTED] : null) : null;
}

/** Move every open record whose flow is gone as the chain says; returns how many moved. */
export async function reconcileStaleOperations(reads: StaleReads, now = Date.now(), s: WalletSession = defaultSession): Promise<number> {
  let moved = 0;
  for (const r of allOperations(s)) {
    if (!SINGLE_TRANSACTION.has(r.kind) || !isOpen(r.state) || isDraft(r.state) || (isLiveOperation(r.id) && r.state !== "RECOVERY_REQUIRED")) continue;
    const old = now - r.updatedAt > (r.refs.relayerUrl ? STALE_DROP_MS : STALE_DROP_WALLET_MS);
    let hash = r.refs.txHashes[r.refs.txHashes.length - 1] as Hex | undefined;
    let changed = false;
    const apply = (ev: OperationEvent) => {
      const t = applyEvent(r.id, ev, s, now, { live: false });
      if (t?.ok && t.changed) changed = true;
    };
    try {
      if (!hash) {
        const reached = r.progress?.step === "submitting" || r.refs.nullifiers !== undefined || r.refs.noteCounter !== undefined;
        const found = reached ? await fromSubmission(r, reads, old) : [INTERRUPTED];
        if (Array.isArray(found)) found.forEach(apply);
        else if (found !== null) {
          apply({ type: "submitted", txHash: found, by: "relayer" }); // the relayer's answer the page never got
          hash = found;
        }
      }
      if (hash) {
        const status = await reads.receipt(hash);
        const ours = status === null ? null : await spendsRecord(r, hash, reads);
        if (ours === false) apply({ type: "submission-failed", code: "not_this_spend", detail: `transaction ${hash} does not spend this record's notes` });
        else if (status === "success") apply({ type: "completed", ref: { txHash: hash } });
        // "nothing moved" only while its notes are unspent, as the relayer judges its own jobs (audit round 2, r23): a node
        // that never saw the relayer's pending transaction, or an endpoint's "reverted", had failed a Send on its way
        else if (status === "reverted") {
          if (!(await notesSpent(r, reads))) apply({ type: "submission-failed", code: "receipt_reverted", detail: `transaction ${hash} reverted` });
        } else if (old && !(await reads.txKnown(hash)) && !noteFound(r) && !(await notesSpent(r, reads)))
          apply({ type: "submission-failed", code: "transaction_dropped", detail: `transaction ${hash} was dropped before it was mined` });
      }
    } catch {
      // the chain or the relayer could not be read: the next scan tries again
    }
    if (changed) moved++;
  }
  return moved;
}
