// Operations whose own flow is gone (a V6 follow-up of 2026-10-14). A Protect, a Send or a withdrawal moves its record
// forward only through the events of its own flow. A reload or a closed tab during it therefore left the record open for
// good: Home's "in flight" card stayed, and so did Activity's pending row. After each note scan (../wallet/discovery.ts),
// every such record is read from the chain instead:
// - submitted, its transaction known: the receipt completes it, a revert fails it (nothing moved), and a transaction the
//   node no longer knows STALE_DROP_MS after the record last moved fails it too (the relayer drops such a transaction
//   after the same time) — both only while the record's notes are unspent, and every one of these reads is every
//   configured endpoint's (audit round 2, r23: one endpoint's word had failed a Send on its way as "nothing moved"). A
//   Protect's are never asked of the endpoints (the eleventh review round, F11-10): its note, or the wallet that sent it;
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
import { decodeFunctionData, parseEventLogs, TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from "viem";
import { clientFor, clientsFor, outcomeReads, walletTxStatus, type Deployment } from "../chain";
import { coreAbi, transactInputsDigest } from "../privacyProtocol";
import { relayerJobFor } from "../relayer";
import { noteStore, type OwnedNote } from "../wallet/notes";
import { isDraft, isOpen, recoverySince, type OperationKind, type OperationRecord } from "../wallet/operationRecord";
import type { AwaitedNote } from "../privateTx";
import { session as defaultSession, type WalletSession } from "../wallet/session";
import { spendIndexOf, type SpendIndex } from "../wallet/spends";
import { allOperations, applyEvent, isLiveOperation } from "./store";
import type { OperationEvent } from "./types";

/** The kinds one transaction finishes, which only their own flow moves forward. */
const SINGLE_TRANSACTION: ReadonlySet<OperationKind> = new Set<OperationKind>(["protect", "send", "withdraw"]);

/**
 * How long a transaction the node no longer knows is waited for before its record fails. The relayer drops its own submission after
 * ten minutes (DROP_AFTER_MS); the wallet waits an hour for a relayer-sent one too (the sixth review round, 2026-11-03): a relayer
 * whose node restarted forgets a transaction other nodes still hold, and "nothing moved" at ten minutes had the next Send pay twice.
 */
export const STALE_DROP_MS = 60 * 60_000;
/**
 * ...and one the wallet's own connection sent, no relayer named (audit round 2, n66): a wallet sending through a private
 * mempool shows the RPC nothing until it is mined, and "dropped, send it again" after ten minutes had a Send paid twice.
 */
export const STALE_DROP_WALLET_MS = 60 * 60_000;
/**
 * ...and a relayer that cannot be reached at all (the ninth review round, 2026-11-04, C-06): a day after the record last moved, the chain alone
 * decides. The relayer drops a spend its node does not know after ten minutes and never sends it again; before, the lookup threw ahead of the
 * hour's rule, and the record blocked every later Send and withdrawal as "one at a time" for good.
 */
export const RELAYER_GONE_MS = 24 * 3600_000;

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
  /** the pool's own record of the spend of exactly this pair (the scan's agreed spend index; the sixth review round, 2026-11-03), or null */
  spendOf?(nullifiers: [bigint, bigint]): Promise<{ txHash: Hex } | null>;
  /** the digest of the public inputs of the transaction's transact call (`transactInputsDigest`): null when the node does not know it
   *  or it is no direct transact of the core; throws when it cannot be read (the sixth review round, 2026-11-03) */
  txInputs?(hash: Hex): Promise<Hex | null>;
  /** the address the transaction's transact call pays (its withdrawal recipient), on the same terms (the ninth review round, C-10) */
  txRecipient?(hash: Hex): Promise<Hex | null>;
  /**
   * a Protect's transaction through the connected wallet's own provider (chain.ts walletTxStatus; the eleventh review round, F11-10): its
   * `from` is the user's public address, never asked of the privacy endpoints. Absent, or null: not known here
   */
  walletTx?(hash: Hex, sender: string | undefined): Promise<"success" | "reverted" | "pending" | "unknown" | null>;
}

/**
 * While a deposit its wallet reported nothing for is this young, the scan runs each minute while its reads succeed — a failed read is tried
 * again after 1, 2, 4, then 8 minutes (../wallet/discovery.ts heldRetryMs) — (the critique of F11-10).
 */
export const DEPOSIT_RESCAN_WINDOW_MS = 15 * 60_000;
/** The live flow's deposit its wallet reported nothing for (`deposit_unconfirmed`, marked `noteAwaited` by its page: VA-N1). */
const awaitsNote = (r: OperationRecord): boolean =>
  r.kind === "protect" &&
  r.state === "RECOVERY_REQUIRED" &&
  r.reason?.code === "deposit_unconfirmed" &&
  r.refs.noteAwaited === true &&
  r.refs.noteCounter !== undefined;
/**
 * This wallet's Protects whose live flow ended with no word from the wallet that sent the deposit (`deposit_unconfirmed`, `noteAwaited`): the
 * scan records such a note from the endpoints' agreed view at once (privateTx.ts scanNotes `awaited`; the eleventh review round's critique of
 * F11-10) — the case the receipt's fallback to the endpoints had covered, never wider (the twelfth review round, VA-N1: any such record had
 * been, the stale mover's too): a page closed after its send, or a lock, leaves its note to the proof, as before (its record completes from the
 * wallet that sent it, or from the note once proven). Each with its note's body when the record kept it (A12-4): the counter alone had taken
 * another device's deposit at the same counter (gap 51) for this one.
 */
export function awaitedDeposits(s: WalletSession = defaultSession): AwaitedNote[] {
  return allOperations(s)
    .filter(awaitsNote)
    .map((r) => ({
      counter: r.refs.noteCounter!,
      ...(r.refs.noteBody ? { vaultId: BigInt(r.refs.noteBody.vault), amount: BigInt(r.refs.noteBody.amount) } : {}),
    }));
}
/**
 * Such a deposit younger than DEPOSIT_RESCAN_WINDOW_MS, from the moment its record read so (the twelfth review round, A12-3: from its creation —
 * the Review's confirmation, before the wallet's prompts and its receipt's ten minutes — a deposit confirmed a quarter hour before had had no
 * minute rescan at all).
 */
export function depositAwaited(s: WalletSession = defaultSession, now = Date.now()): boolean {
  return allOperations(s).some((r) => awaitsNote(r) && now - recoverySince(r) < DEPOSIT_RESCAN_WINDOW_MS);
}

/**
 * The reads through the wallet's own RPC, and the relayer the spend went to. The spent bits and the spend of a pair come from the
 * scan's agreed spend index (the sixth review round, 2026-11-03), never from a per-nullifier read that names the record's notes to
 * an endpoint; without an index (no scan yet) the agreed per-nullifier read remains, as before.
 */
export function staleReads(d: Deployment, index: SpendIndex | null = spendIndexOf(d.core)): StaleReads {
  const client = clientFor(d);
  const outcome = outcomeReads(d); // every configured endpoint (audit round 2, r23)
  const clients = clientsFor(d);
  /**
   * What the transaction's direct transact call of the core says, from every configured endpoint, and only when they all say the same (the
   * ninth review round, 2026-11-04, B-F1; the r23 rule): the first endpoint alone had decided whose call spent a pair — a funding that
   * landed read "dead" and its order was abandoned, a delivered Send read "spent elsewhere". Null when any endpoint does not know it, it
   * is no direct transact, or they differ; throws when one cannot be read.
   */
  const agreedCall = async (hash: Hex, read: (input: Hex) => string | null): Promise<Hex | null> => {
    const all = await Promise.all(
      clients.map(async (c) => {
        let tx;
        try {
          tx = await c.getTransaction({ hash });
        } catch (e) {
          if (e instanceof TransactionNotFoundError) return null;
          throw e;
        }
        return tx.to && tx.to.toLowerCase() === d.core.toLowerCase() ? read(tx.input) : null;
      }),
    );
    const first = all[0];
    return first && all.every((x) => x !== null && x.toLowerCase() === first.toLowerCase()) ? (first as Hex) : null;
  };
  return {
    receipt: outcome.receipt,
    txKnown: outcome.txKnown,
    walletTx: (hash, sender) => walletTxStatus(hash, d.chainId, sender),
    // never a per-nullifier read naming the record's notes (the ninth review round, 2026-11-04, D-3): without an index (no scan yet) the
    // reads throw, and the record is read again after the next scan
    spent: async (n) => {
      if (!index) throw new Error("the pool has not been scanned yet: a record's notes are never named to an endpoint");
      return index.spent(n);
    },
    spendOf: async (pair) => {
      const s = index?.spendOf(pair);
      return s ? { txHash: s.transactionHash } : null;
    },
    relayerJob: (url, nullifiers) => relayerJobFor(url, nullifiers),
    txInputs: (hash) => agreedCall(hash, (input) => transactInputsDigest(input)),
    txRecipient: (hash) =>
      agreedCall(hash, (input) => {
        try {
          const call = decodeFunctionData({ abi: coreAbi, data: input });
          if (call.functionName !== "transact") return null;
          const to = (call.args[1] as { withdrawalRecipient: bigint }).withdrawalRecipient;
          return to > 0n && to < 1n << 160n ? "0x" + to.toString(16).padStart(40, "0") : null;
        } catch {
          return null;
        }
      }),
    txSpends: async (hash) => {
      // mined: the core's own ShieldedTransaction events (audit round 2, n12) — a spend sent through a smart-contract account (a
      // 4337 bundle, a Safe) calls the core from another contract, its transaction's `to` not the core, and it had been read
      // "not this spend" after a reload. A reverted or pending one keeps its own call's reading below
      const receipt = await client.getTransactionReceipt({ hash }).catch((e: unknown) => {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      });
      if (receipt?.status === "success") {
        const logs = receipt.logs.filter((l) => l.address.toLowerCase() === d.core.toLowerCase());
        return parseEventLogs({ abi: coreAbi, logs, eventName: "ShieldedTransaction" }).map((l) => [l.args.nullifier0, l.args.nullifier1] as [bigint, bigint]);
      }
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

/**
 * Whether the transaction is this record's own call: its public inputs are the ones the record kept at its submission (the sixth
 * review round, 2026-11-03). Two Sends of one note share the nullifier pair, so the pair alone named another operation's transaction.
 * True or false when both are known; null when the record kept none (an older record) or the transaction's inputs cannot be read
 * here (a call through a smart-contract account, a node that does not know it).
 */
async function ownCall(r: OperationRecord, hash: Hex, reads: StaleReads): Promise<boolean | null> {
  if (!r.refs.inputsDigest || !reads.txInputs) return null;
  const d = await reads.txInputs(hash);
  return d === null ? null : d.toLowerCase() === r.refs.inputsDigest.toLowerCase();
}

/** The note's body is the record's when it kept one (a Protect's: the twelfth review round, A12-4); a record that kept none (a Send's change) is told by its counter. */
const ofBody = (r: OperationRecord, n: { vaultId: bigint; amount: bigint }): boolean =>
  !r.refs.noteBody || (n.vaultId === BigInt(r.refs.noteBody.vault) && n.amount === BigInt(r.refs.noteBody.amount));
/**
 * The note the record's submission made, in the store: at its counter and of its body (A12-4: the counter alone had completed a Protect from
 * another device's deposit at the same counter, gap 51, "Added" at that deposit's leaf while its own never landed).
 */
const ownNoteOf = (r: OperationRecord): OwnedNote | undefined =>
  r.refs.noteCounter === undefined ? undefined : noteStore.all().find((n) => n.counter === r.refs.noteCounter && ofBody(r, n.note));
/** What the record's submission made shows: the note it makes found by the scan (a Protect's deposit, a Send's change; n66). */
const noteFound = (r: OperationRecord): boolean => ownNoteOf(r) !== undefined;
/**
 * The latest scan's agreed view holds the record's note, recorded or waiting for the proof of its leaf (the twelfth review round, A12-1): it
 * landed — sped up in the wallet app, under another hash, which the wallet that sent it is never asked about —, and it is recorded once proven.
 */
const inScanView = (r: OperationRecord): boolean => r.refs.noteCounter !== undefined && noteStore.scanView(r.refs.noteCounter).some((n) => ofBody(r, n));

/** Whether any note the record spends is spent on chain: a record whose notes are gone never reads "nothing moved" (r23). */
async function notesSpent(r: OperationRecord, reads: StaleReads): Promise<boolean> {
  return r.refs.nullifiers ? (await Promise.all(r.refs.nullifiers.map((n) => reads.spent(BigInt(n))))).some(Boolean) : false;
}

const INTERRUPTED: OperationEvent = { type: "submission-failed", code: "interrupted", detail: "the page was closed or reloaded before it was sent" };
/** Another operation of this wallet spent the record's notes first (the sixth review round, 2026-11-03): its own call can never land. */
const SPENT_ELSEWHERE: OperationEvent = {
  type: "submission-failed",
  code: "spent_elsewhere",
  detail: "its notes were spent by another operation; this one never reached the chain",
};
/** Sent as far as the chain can tell (its notes spent), the transaction not known here: read again at every scan (the review round of 2026-11-02). */
const OUTCOME_UNKNOWN: OperationEvent = { type: "recovery-required", code: "outcome_unknown", detail: "sent; its transaction is not known here yet" };
/** A Protect past the drop limit with neither its note nor its wallet's word: its own words, never a Send's "your notes were spent" (the critique of F11-10). */
const DEPOSIT_UNCONFIRMED: OperationEvent = {
  type: "recovery-required",
  code: "deposit_unconfirmed",
  detail: "sent; neither its note nor its wallet's word has come",
};
/**
 * ... and a day after it read deposit_unconfirmed (the twelfth review round, A12-3), or after it last moved for a record that never read so: it
 * never reached the chain — nothing moved. The record stays so; a note found later enters the balance alone (the critique of F11-10).
 */
const depositNeverLanded = (hash: string): OperationEvent => ({
  type: "submission-failed",
  code: "deposit_never_landed",
  detail: `transaction ${hash}: no note of it in the pool a day on, and no word from the wallet that sent it`,
});
/**
 * A Protect past the drop limit that the wallet which sent it no longer knows, no note of it in the latest scan's view (the twelfth review round,
 * A12-1): nothing moved as far as the wallet can tell — in its own words, never a Send's "Send it again": one the wallet app replaced (sped up)
 * lands under another hash, and is never dropped once its replacement's note is in the latest scan's view (a replacement still pending at that
 * scan is not seen: stated).
 */
const depositDropped = (hash: string): OperationEvent => ({
  type: "submission-failed",
  code: "deposit_dropped",
  detail: `transaction ${hash}: the wallet that sent it no longer knows it, and no note of it is in the pool`,
});
/** Past the drop limit, its notes unspent, the transaction the record holds never landed for it: nothing moved (the tenth review round, A10-1). */
const droppedEvent = (hash: string): OperationEvent => ({
  type: "submission-failed",
  code: "transaction_dropped",
  detail: `transaction ${hash} was dropped before it was mined`,
});

/**
 * The call a transaction the wallet replaced landed as (the ninth review round, 2026-11-04, C-02: a speed-up — the same call under a new hash):
 * a Protect's note found by the scan, or a Send's pair spent in the pool's index by a call with this record's own inputs — another
 * operation's call there is "spent elsewhere". Null while nothing says.
 */
async function replacedBy(r: OperationRecord, hash: Hex, reads: StaleReads): Promise<OperationEvent[] | Hex | null> {
  if (r.refs.nullifiers) {
    const seen = (await reads.spendOf?.([BigInt(r.refs.nullifiers[0]), BigInt(r.refs.nullifiers[1])])) ?? null;
    if (!seen || seen.txHash.toLowerCase() === hash.toLowerCase()) return null;
    const own = await ownCall(r, seen.txHash, reads);
    return own === true ? seen.txHash : own === false ? [SPENT_ELSEWHERE] : null;
  }
  const note = ownNoteOf(r);
  return note ? [{ type: "completed", ref: { leafIndex: note.leafIndex, ...(note.txHash ? { txHash: note.txHash } : {}) } }] : null;
}

/** What a record that was submitting when its page went away became: its settling events, the transaction it was sent as, or nothing yet. */
async function fromSubmission(r: OperationRecord, reads: StaleReads, old: boolean, gone = false): Promise<OperationEvent[] | Hex | null> {
  // the note this submission makes for the wallet (a Protect's deposit, a Send's change): found by the scan, it landed
  if (r.refs.noteCounter !== undefined) {
    const note = ownNoteOf(r);
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
    // the pool's own record first (the sixth review round, 2026-11-03): the transact that spent exactly this pair is this record's
    // transaction — the exit of a Send whose relayer answer was lost for good (one waiting as RECOVERY_REQUIRED, outcome unknown)
    // — when that transaction's call carries the record's own public inputs: another Send of the same note spends the same pair
    const seen = (await reads.spendOf?.(nullifiers)) ?? null;
    if (seen) {
      const own = await ownCall(r, seen.txHash, reads);
      if (own === true) return seen.txHash;
      // another operation's call spent the pair: this record's own can never land — nothing of it was sent
      if (own === false) return [SPENT_ELSEWHERE];
    }
    let job: { txHash: Hex } | null = null;
    if (r.refs.relayerUrl) {
      try {
        job = await reads.relayerJob(r.refs.relayerUrl, nullifiers);
      } catch (e) {
        if (!gone) throw e; // a day without the relayer (C-06): the chain alone decides below
      }
    }
    // the relayer names it; the transaction itself says whether it spends these notes (c42) — and whether it is this record's own call (the
    // relayer files a later Send of the same note under the same nullifiers): only a call read with the record's own inputs is adopted (the
    // ninth review round, C-10 — gap 86's rule: a record kept without its call's digest had taken another Send's transaction for its own).
    // One whose inputs cannot be told — no digest kept, endpoints that do not agree yet — is sent as far as the relayer says: its outcome is
    // unknown, never "nothing moved"
    if (job && (await spendsRecord(r, job.txHash, reads)) !== false) {
      const own = await ownCall(r, job.txHash, reads);
      if (own === true) return job.txHash;
      if (own === null) {
        // a hash no endpoint knows, past the drop limit, the notes unspent: the dropped-transaction rule, as before the ninth round (the tenth
        // review round, A10-1) — a relayer that kept naming it had held this record, and every later Send behind it, for good
        if (old && !(await reads.txKnown(job.txHash)) && !(await notesSpent(r, reads))) return [droppedEvent(job.txHash)];
        return r.state === "RECOVERY_REQUIRED" ? null : [OUTCOME_UNKNOWN];
      }
    }
    // sent, its transaction not known here: never "nothing moved" (r23) — and never left where it blocks the next Send for good
    // (one at a time, V7 Stage 16): the record waits as RECOVERY_REQUIRED, its outcome unknown, and is read again at every scan
    if ((await Promise.all(nullifiers.map((n) => reads.spent(n)))).some(Boolean)) return r.state === "RECOVERY_REQUIRED" ? null : [OUTCOME_UNKNOWN];
  }
  // nothing landed and nothing spent: past the limit, nothing moved. A record that kept nothing (from before the keeping of
  // 2026-10-14) cannot be told either way: past the limit it waits as RECOVERY_REQUIRED rather than block the wallet for good
  if (r.refs.noteCounter !== undefined || r.refs.nullifiers) return old ? [INTERRUPTED] : null;
  return old && r.state !== "RECOVERY_REQUIRED" ? [OUTCOME_UNKNOWN] : null;
}

/** Move every open record whose flow is gone as the chain says; returns how many moved. */
export async function reconcileStaleOperations(reads: StaleReads, now = Date.now(), s: WalletSession = defaultSession): Promise<number> {
  let moved = 0;
  for (const r of allOperations(s)) {
    if (!SINGLE_TRANSACTION.has(r.kind) || !isOpen(r.state) || isDraft(r.state) || (isLiveOperation(r.id) && r.state !== "RECOVERY_REQUIRED")) continue;
    const old = now - r.updatedAt > (r.refs.relayerUrl ? STALE_DROP_MS : STALE_DROP_WALLET_MS);
    const gone = now - r.updatedAt > RELAYER_GONE_MS;
    let hash = r.refs.txHashes[r.refs.txHashes.length - 1] as Hex | undefined;
    let changed = false;
    const apply = (ev: OperationEvent) => {
      const t = applyEvent(r.id, ev, s, now, { live: false });
      if (t?.ok && t.changed) changed = true;
    };
    try {
      if (!hash) {
        const reached = r.progress?.step === "submitting" || r.refs.nullifiers !== undefined || r.refs.noteCounter !== undefined;
        const found = reached ? await fromSubmission(r, reads, old, gone) : [INTERRUPTED];
        if (Array.isArray(found)) found.forEach(apply);
        else if (found !== null) {
          apply({ type: "submitted", txHash: found, by: r.refs.relayerUrl ? "relayer" : "wallet" }); // the relayer's answer the page never got, or the pool's own record of the spend
          hash = found;
        }
      }
      // a Protect is settled without asking the privacy endpoints about its hash (the eleventh review round, F11-10): its transaction's `from` is
      // the user's public address, and the endpoints that serve every later private spend must never hold it beside this client (threat model
      // A2; gaps 80, 100). The scan's note at its counter says it landed; the wallet that sent it, connected with its account, may say it was
      // mined, reverted, pending (waited for) or unknown (past the drop limit: dropped). With no word at all, past the drop limit it waits as a
      // deposit not reported, and a day after it last moved it never reached the chain — nothing moved: the record stays so, and a note
      // found later enters the balance alone
      // ... A Protect's note is its own by its counter and body (the twelfth review round, A12-4). Its note in the latest scan's view, its leaf not
      // proven yet, says it landed (A12-1): the wallet's node does not know a hash the wallet app replaced (sped up), and "unknown" had failed it
      // "dropped — send it again" while its replacement landed; it waits for its note. A deposit its wallet did not report keeps one clock, the
      // moment it read so (A12-3): its "never landed" is a day from then, as its hold
      if (hash && r.kind === "protect") {
        const note = ownNoteOf(r);
        const landed = !note && inScanView(r);
        const seen = note || landed ? null : reads.walletTx ? await reads.walletTx(hash, r.refs.sender) : null;
        const goneFor = r.state === "RECOVERY_REQUIRED" && r.reason?.code === "deposit_unconfirmed" ? now - recoverySince(r) > RELAYER_GONE_MS : gone;
        if (note) apply({ type: "completed", ref: { leafIndex: note.leafIndex, txHash: (note.txHash as Hex | undefined) ?? hash } });
        else if (landed) {
          // landed, its note recorded once proven: no verdict meanwhile
        } else if (seen === "success") apply({ type: "completed", ref: { txHash: hash } });
        else if (seen === "reverted") apply({ type: "submission-failed", code: "receipt_reverted", detail: `transaction ${hash} reverted` });
        else if (old && seen === "unknown") apply(depositDropped(hash));
        else if (goneFor && seen === null) apply(depositNeverLanded(hash));
        else if (old && seen === null && r.state !== "RECOVERY_REQUIRED") apply(DEPOSIT_UNCONFIRMED);
      } else if (hash) {
        let status = await reads.receipt(hash);
        // a transaction the wallet replaced (C-02): its hash unknown everywhere while its call landed under another — it had stayed
        // "Confirming", or "We are checking where your funds are", for good
        const moved = status === null && !(await reads.txKnown(hash)) ? await replacedBy(r, hash, reads) : null;
        if (typeof moved === "string") {
          hash = moved;
          status = await reads.receipt(moved);
        }
        const ours = status === null ? null : await spendsRecord(r, hash, reads);
        if (Array.isArray(moved)) moved.forEach(apply);
        // a transaction that spends other notes is not this record's (c42); past the drop limit with the record's own notes unspent, its own call
        // never landed (the tenth review round, A10-1): nothing moved — left "unknown", it had held every later Send for good
        else if (ours === false)
          apply(
            old && !(await notesSpent(r, reads))
              ? droppedEvent(hash)
              : { type: "submission-failed", code: "not_this_spend", detail: `transaction ${hash} does not spend this record's notes` },
          );
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
