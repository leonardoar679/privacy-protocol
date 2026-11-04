// The encrypted note journal (plan §44): everything the wallet must remember between sessions that
// is not recoverable from the seed alone — its notes with their leaf indexes and spent state, the
// per-chain fresh-address counters, open swap orders and scheduled actions, settings. Encrypted with
// a key derived from the seed (never the password), so it is readable only while the wallet is
// unlocked; chain rescan (scanNotes) remains the fallback when the journal is lost.
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, bytesToUtf8, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { SerializedNote } from "./notes";
import type { Campaign } from "@privacy-wallet/protocol/wallet/campaign";
import type { AddressBookEntry } from "@privacy-wallet/protocol/wallet/addressBook";
import type { OperationRecord } from "./operationRecord";
import { upgradeOperations } from "../operations/upgrade";

export interface StoredSwap {
  orderId: string;
  /** V6 (spec v2.0 §15): the API's operation id (`op_`) of this order, from its commit or its first resume; optional */
  operationId?: string;
  attemptId: string; // the one-time order key is re-derived from the seed + attemptId; never stored
  refundCounter: number;
  /** the 169-byte refund payload committed in the order (random, so it cannot be re-derived); hex */
  refundNoteData?: string;
  /** the API's vouch for this order from its commit (a V6 follow-up of 2026-10-16, audit gap 47): 65 bytes of hex. The relayer
   *  refunds only an order the API vouched for, and executes only a call the API vouched for, which it does on seeing this */
  orderVouch?: string;
  provider: string;
  policy: string;
  request: unknown; // the service's SwapRequest (strings only)
  params: unknown; // the on-chain OrderParams as the service serialises them
  endpoint: string;
  quote?: unknown;
  /** the minimum output the user approved (destination base units); a provider call guaranteeing less is signed only with fresh consent */
  approvedMin?: string;
  /** the relayer's fee for the funding the Review showed (base units of the source asset; the audit round of 2026-10-16, c46):
   *  a funding that would pay more is stopped (`fee_moved`), never paid whatever the fee had become; optional */
  reviewedFee?: string;
  /** each merge the funding needs first pays at most this (base units; the review round of 2026-11-03, E3): the relayer's minimum the
   *  Review showed — a merge is a self-transfer, F alone; optional (an order from before, or one whose Review saw no merges) */
  reviewedMergeFee?: string;
  /** the merges the funding's Review named (the eighth review round, B-2): more is `merges_moved`, the order stopped unfunded; optional */
  reviewedMerges?: number;
  /** the fee note the funding paid (base units of the source asset; audit round 2, n25): at most `reviewedFee` — a relayer
   *  asking less, hours later or as a fallback, paid less; optional (a funding from before, or one read landed after a reload) */
  fundedFee?: string;
  createdAt: number;
  dueAt?: number; // scheduled funding time (plan §30), unix ms
  fundedTx?: string;
  /** when the escrow was read holding the order, its funding's transaction not known (unix ms; the ninth review round, 2026-11-04, C-01):
   *  a funding that landed while its answer was lost or its page was gone. Optional */
  fundedAt?: number;
  /** the funding's own submission, journaled before it is sent (a V6 follow-up of 2026-10-14): its two nullifiers
   *  (decimal), who sent it, the relayer, the transaction once known. Until its fate is known (swapFunding.ts
   *  `fundingFate`) no runner sends another: a reload or a Resume had funded an escrow twice when the notes differed. */
  fundingAttempt?: FundingAttempt;
  jobId?: string;
  /** when the order was handed to its executor, unix ms (the seventh review round): the velocity limit counts every hand-over of the wallet */
  handedOverAt?: number;
  /** when this wallet last handed the signed execution to its executor, before the answer (unix ms; the ninth review round, C-09): a
   *  hand-over whose answer was lost is never read "nothing was swapped" at the window's end. Optional */
  handOverAttempt?: number;
  /** tokens other than the order's asset the signed provider call may pay back to the escrow (handed to the executor) */
  refundTokens?: string[];
  /** with them, the least balance of each worth a re-shield after execution (PP-S12) */
  refundFloors?: Record<string, string>;
  /** refund notes found in the pool for this order (PP-S09): refund() may re-shield more than once */
  refunds?: { leafIndex: number; vault: string; amount: string }[];
  state: string;
  /** V2 (whale spec §25): the saved preference the order was quoted under, the service's tier and valuation, the execution plan — all optional */
  preference?: string;
  tier?: string;
  value?: unknown;
  plan?: unknown;
  /** the privacy lint at commit (spec §18) and the last pre-trade simulation (spec §24) */
  lint?: { items: unknown[]; at: number };
  simulation?: { ok: boolean; gas?: string; error?: string; reason?: string; at: number };
  /** what every provider answered at commit (spec §2), kept for the route details and the export */
  competition?: unknown[];
  /** institutional (spec §24): the funding is scheduled no earlier than this, and the order can be cancelled until then */
  reviewHoldUntil?: number;
  /** settlement tracking (spec §19, Stage 7): the deployAndExecute transaction, journaled the first time the executor reports it (never overwritten) */
  executionTx?: string;
  /** the provider's own reference for tracking (NEAR Intents: the deposit address the escrow paid), journaled at hand-over */
  executionRef?: string;
  /** the relayer the order was handed to (audit round 2, r38): tracked, refunded and its shield job asked there, whatever Settings name since */
  relayerUrl?: string;
  /** the last derived settlement state (sdk/orderTracker.ts) and what the tracker read; V6 (spec v2.0 §12.4): `settlement`, where the money is (optional) */
  track?: { state: string; label: string; destinationTxHash?: string; deliveredAmount?: string; refundedAmount?: string; progress?: { parts: number; done: number }; settlement?: string; at: number };
  /** every settlement transition with its time (spec §25) */
  history?: { state: string; at: number; note?: string }[];
  /** V3 (High-Value Protection spec §7, §17): the campaign this order is a tranche of; such an order is funded and handed over by the campaign runner, never by a fund-escrow action */
  campaign?: { id: string; index: number };
  /** V6 Stage 11 (spec v2.0 §7.6): the order runner runs this order after its one confirmation — funded at once, or not before `delayUntil` (unix ms) for more privacy;
   *  V6 follow-up (spec v2.0 §14.1): `maxTiming`, funded at once from older notes only — each with its own timing at most it (0, 0.3 or 0.7) */
  runner?: { confirmedAt: number; delayUntil?: number; maxTiming?: number };
  /** V6 Stage 11: why the runner stopped and what it waits for — `minimum_moved` (the user's choice: `minOut` vs the `approved` one), `execution_unavailable`, `unsafe_contract_call`, `reconcile`;
   *  on an order it gave up before funding, `older_notes_unavailable` (the older notes no longer covered it), `relayer_not_ready` (the
   *  relayer that would execute it names another factory or not the swap service's key; a V6 follow-up of 2026-10-16), `service_key_changed`
   *  (the swap service no longer takes the key the order was confirmed under; the same follow-up), `order_outdated` (an older
   *  build committed it under the privacy address's owner commitment; the audit round of 2026-10-16, c18), `fee_moved` (the
   *  relayer's fee rose above the one the Review showed; c46) or `order_expired` (its
   *  execution window closed, or was about to); on a funded one whose window closed before its hand-over, `execution_window_closed` */
  paused?: { code: string; detail?: string; minOut?: string; approved?: string; at: number };
  /** V6 Stage 12 (spec v2.0 §11.2): a same-chain swap into the protected balance — the shield receiver this wallet named as
   *  the destination (its factory and parameters, the counter its note derives from, the payload), whether the executor
   *  has its shield job, what the executor last reported, and the note once it is found in the pool */
  shield?: StoredShield;
}

/**
 * Whether an order was funded, whatever its `state` says now (the ninth review round, 2026-11-04, C-01): its funding's transaction
 * journaled, its landing journaled without one (`fundedAt`), the order journaled funded, or handed over or executed (this wallet hands
 * an order over only once it is funded). The hand-over writes the executor's job state over `state`, and an order reconciled from the
 * escrow's balance kept no transaction: such an order had read "never funded" at its first failed job read — "nothing left your
 * protected balance" past its window, its ticks stopped for good, "Get a new quote" its only action.
 */
export const fundedOf = (s: Pick<StoredSwap, "fundedTx" | "fundedAt" | "state" | "jobId" | "handedOverAt" | "executionTx">): boolean => fundingSeenOf(s) || !!s.jobId;
/**
 * The funding as this wallet saw it land — its transaction, its landing in the escrow, the funded state, its own hand-over (made only once
 * funded) or an execution —, without the executor's job: an executor that let a job lapse with its escrow empty never saw the funds, and a
 * job alone is no funding there (orderTracker.ts, the `lapsed` job).
 */
export const fundingSeenOf = (s: Pick<StoredSwap, "fundedTx" | "fundedAt" | "state" | "handedOverAt" | "executionTx">): boolean =>
  !!s.fundedTx || s.fundedAt !== undefined || s.state === "funded" || s.handedOverAt !== undefined || !!s.executionTx;

/** A funding sent for an order (StoredSwap.fundingAttempt). */
export interface FundingAttempt {
  nullifiers: [string, string];
  by: "relayer" | "wallet";
  relayerUrl?: string;
  txHash?: string;
  /** the funding call's public inputs digest (the eighth review round, B-4): its notes spent by another call make it a funding that never lands */
  inputsDigest?: string;
  at: number;
}

/** A same-chain swap's shield receipt (sdk/shieldReceiver.ts); the integers are decimal strings. */
export interface StoredShield {
  factory: string;
  receiver: string;
  params: { receiptId: string; asset: string; minAmount: string; shieldTip: string; ownerCommitment: string; noteSecret: string; noteDataHash: string; fallbackRecipient: string };
  counter: number;
  noteData: string;
  /** when the executor accepted the shield job (unix ms) */
  registeredAt?: number;
  /** the executor's last report: `waiting-delivery`, `shielding`, `shielded`, `shield-failed` */
  job?: { state: string; leafIndex?: number; txHash?: string; amount?: string; tip?: string; error?: string; at: number };
  /** the delivered note(s) found in the pool, each proven by its commitment (a late second delivery is shielded again) */
  leaves?: { leafIndex: number; vault: string; amount: string }[];
  /** the swap service's vouch for this receipt from the commit (a V6 follow-up of 2026-10-16, audit gap 47), handed to the
   *  shield executor, which shields only a vouched receipt; 65 bytes of hex, optional */
  vouch?: string;
}

/**
 * A scheduled action (plan §30; V2 Stage 4): `attempts` and `nextAttemptAt` are the runner's backoff after a
 * failure (10 min, doubling, at most 6 h); an abandoned order's action is removed, never retried.
 */
export interface ScheduledAction { id: string; kind: "fund-escrow" | "housekeeping" | "campaign-tick" | "campaign-shape" | "order-tick" | "discovery"; orderId: string; dueAt: number; done?: boolean; error?: string; /** the catalog's code of that error when it had one (a V7 follow-up, audit gap 59: the operation's detail names it) */ errorCode?: string; attempts?: number; nextAttemptAt?: number }

/** One line of the Activity screen (whale spec §25, plan V2 §49–§50): local only, never sent anywhere. */
export interface ActivityRecord {
  id: string;
  /** V6 follow-up (note discovery): `receive`, a private transfer this wallet received */
  kind: "shield" | "transfer" | "withdraw" | "swap" | "refund" | "housekeeping" | "campaign" | "receive";
  at: number;
  /** the asset's symbol and decimals, so the row renders without the deployment */
  asset: string;
  decimals: number;
  /** base units, decimal string */
  amount: string;
  status: string;
  /** the private reference: order id, transaction hash or leaf index */
  ref: string;
  note?: string;
}

export interface JournalData {
  v: 1;
  notes: SerializedNote[];
  noteCounter: number;
  chainIndexes: Record<string, number>; // next fresh-address index per chain (plan §27–§28, §46)
  swaps: StoredSwap[];
  schedule: ScheduledAction[];
  settings?: Record<string, unknown>;
  /** the light client's last verified store (plan §38), so the next sync resumes from it instead of trusting a beacon API again */
  lightClient?: { chainId: string; snapshot: unknown };
  /**
   * V2 (whale spec §13, §25): the last good Chainlink read (`sdk/prices.ts`), the memory of the valuation fail-safe.
   * Optional and never written by emptyJournal(): the pinned at-rest vectors and older journals stay valid.
   */
  prices?: unknown;
  /**
   * The note counters are held (wallet/notes.ts holdCounters; PP-P03, the audit round of 2026-10-16): this journal began
   * without the whole of an earlier one — a restore from the phrase or a backup — and no complete scan has run since.
   * Optional, never written by emptyJournal(): every earlier journal stays valid.
   */
  countersHeld?: true;
  /** V2 (whale spec §25, Stage 4): the Activity list. Optional, never written by emptyJournal(); readers default it to []. */
  activity?: ActivityRecord[];
  /** V2 (Stage 8): what private balance maintenance spent on relayer fees today (the daily cap of settings.housekeeping) */
  housekeeping?: { day: string; feeWei: string; steps: number };
  /** V2 (Stage 9): the next fresh funding address index of Private AI (a credit note withdrawn moves to the next) */
  /** the fresh funding address's index, and the index already funded from the pool (the eighth review round, C-L2: never twice) */
  aiFunding?: { index: number; funded?: number };
  /** V3 (High-Value Protection spec §17): the campaigns (tranches under an in-flight cap) and the address book. Optional, never written by emptyJournal(): the pinned at-rest vectors and V2 journals stay valid. */
  campaigns?: Campaign[];
  addressBook?: AddressBookEntry[];
  /** V5 (Privacy Wallet Web spec §12): the operation records from the signature on. Optional, never written by emptyJournal(): every earlier journal stays valid. V6 (spec v2.0 §12.2): a V5 record is upgraded when the journal is decrypted (`v: 2`). */
  operations?: OperationRecord[];
  // V5–V6 kept an optional `classic` field here for the in-app Classic Privacy module; V7 Stage 11 removed the module with the
  // field. A journal written with it still parses (unknown fields are carried, never read), as the pinned vectors show.
  /** V6 Stage 15 (spec v2.0 §14.3): this device's last proof — the key's fetch (or cache read) and the proving, in ms */
  proofStats?: ProofStats;
  /** V6 Stage 10 (doc §71; spec v2.0 §10): the deployment fingerprint first seen per chain id (deploymentGuard.ts) — a different one blocks every operation until it is forgotten under Advanced. Optional, never written by emptyJournal(). */
  deploymentFingerprints?: Record<string, string>;
  /**
   * The eleventh review round (2026-11-04, NF-1): a journal a restore began holds the indexes its source knew (a phrase restore's are none),
   * past which it resumed. A backup merged into it later compares its own indexes with these, not with the resume point — a guess, not what
   * this device handed out. Optional, never written by emptyJournal(): every earlier journal stays valid.
   */
  resumedPast?: { chainIndexes: Record<string, number>; aiFunding: number };
}

export interface EncryptedJournal { v: 1; nonce: string; ct: string }

/** How long this device's last proof took (V6 Stage 15): the progress estimates the next one from it. */
export interface ProofStats {
  /** fetching and checking the proving key and the witness generator (a few ms from the Cache API) */
  keyMs: number;
  /** building the circuit inputs, the witness and the proof */
  proveMs: number;
  /** the key came from the cache */
  keyCached: boolean;
  at: number;
}

const AAD = utf8ToBytes("privacy-protocol/v1/journal");

export const emptyJournal = (): JournalData => ({ v: 1, notes: [], noteCounter: 0, chainIndexes: {}, swaps: [], schedule: [] });

/**
 * After a start without the whole journal — a restore from the phrase, or from a backup that may be older —, the fresh-address indexes
 * resume this far past what is known, and Private AI's funding index past AI_FUNDING_RESERVE (the tenth review round, 2026-11-04, D-2): they
 * live in the journal only, and a restore had handed out again the addresses the earlier installation gave to payers or used as
 * destinations, linking the new activity to the old. The note counters have their own hold (countersHeld).
 */
export const ADDRESS_INDEX_RESERVE = 1000;
export const AI_FUNDING_RESERVE = 100;
/**
 * Where an index resumes past what a journal knows (the eleventh review round, 2026-11-04, F11-7): the reserve past it, plus a draw of up to
 * another reserve — two restores from one source (the phrase twice, one backup on two devices) had resumed at the same index and handed out
 * the first one's addresses again. One rule for a restore and a merge alike; the draw is journaled with the restore's first write. `rng`: tests.
 */
export function resumePast(known: number, reserve: number, rng: () => number = Math.random): number {
  return known + reserve + Math.min(reserve - 1, Math.floor(rng() * reserve));
}
export function reservedIndexes(from: Record<string, number> = {}, rng?: () => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const chain of ["evm", "bitcoin", "solana", ...Object.keys(from)]) out[chain] = resumePast(from[chain] ?? 0, ADDRESS_INDEX_RESERVE, rng);
  return out;
}
/** A restore's first journal: the counters held, the fresh addresses and Private AI's funding index past their reserves (D-2, D-6, F11-7). */
export const restoredJournal = (from: JournalData = emptyJournal(), rng?: () => number): JournalData => ({
  ...from,
  countersHeld: true,
  chainIndexes: reservedIndexes(from.chainIndexes, rng),
  aiFunding: { index: resumePast(from.aiFunding?.index ?? 0, AI_FUNDING_RESERVE, rng) },
  resumedPast: { chainIndexes: { ...from.chainIndexes }, aiFunding: from.aiFunding?.index ?? 0 },
});

/** The funding facts of an order a backup holds beside this device's row of it (A11-1): each one the device's row lacks comes from the backup's. */
const FUNDING_FACTS = ["fundingAttempt", "fundedTx", "fundedAt", "fundedFee", "jobId", "handedOverAt", "handOverAttempt", "executionTx", "executionRef", "relayerUrl"] as const;
const withFundingFacts = (device: StoredSwap, backup: StoredSwap): StoredSwap => {
  const out: StoredSwap = { ...device };
  const from = backup as unknown as Record<string, unknown>;
  for (const k of FUNDING_FACTS) if (out[k] === undefined && from[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = from[k];
  return out;
};

/**
 * A backup's journal merged into this device's own journal of the same wallet (the tenth review round, D-4): the device's is the base — what
 * this device did last, kept as the phrase restore keeps it (n45) —, and the backup's notes, orders, campaigns, schedule, operation records
 * and address book entries the device does not hold are added (an order funded on another device and not handed over is only there: its
 * escrow had been stranded), the note counter the higher of the two.
 *
 * The eleventh review round (2026-11-04): an index the backup knows past what this device knows resumes past the reserve, as a restore does
 * (VF-N1, NF-1) — the backup's installation may have gone on after the backup, and a journal a restore began knows only its source (its
 * `resumedPast`), never what lies between it and its resume point; an order both hold keeps the funding facts only the backup's row has
 * (A11-1: a funding sent on the other device had been dropped, and the runner could fund the order again); the backup's settings,
 * deployment fingerprints, light-client store and maintenance spend come where this device's journal has none (A11-1 — a phrase restore's
 * journal holds no settings until its first unlock mirrors the experience: the second factor, the velocity limit, the mode, the pause and
 * the relayer had been dropped silently; with both, the session merges them, settings.ts mergeSettings, which also takes the backup's whole
 * over settings that hold no choice of the user's); a maintenance action never comes from the backup (A11-9: a cancelled one had come back
 * pending beside the device's own).
 */
export function mergeJournals(device: JournalData, backup: JournalData, rng?: () => number): JournalData {
  const union = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined, key: (x: T) => string): T[] => {
    const have = new Set((a ?? []).map(key));
    return [...(a ?? []), ...(b ?? []).filter((x) => !have.has(key(x)))];
  };
  const known = device.resumedPast;
  const chainIndexes: Record<string, number> = { ...device.chainIndexes };
  for (const [k, b] of Object.entries(backup.chainIndexes)) {
    const d = device.chainIndexes[k] ?? 0;
    chainIndexes[k] = b > (known ? (known.chainIndexes[k] ?? 0) : d) ? Math.max(d, resumePast(b, ADDRESS_INDEX_RESERVE, rng)) : d;
  }
  const dAi = device.aiFunding?.index ?? 0;
  const bAi = backup.aiFunding?.index ?? 0;
  const aiPast = bAi > (known ? known.aiFunding : dAi) ? resumePast(bAi, AI_FUNDING_RESERVE, rng) : undefined;
  const ai = aiPast !== undefined && aiPast > dAi ? { index: aiPast } : device.aiFunding;
  const bySwap = new Map(backup.swaps.map((s) => [s.orderId.toLowerCase(), s] as const));
  const swaps = device.swaps.map((s) => {
    const b = bySwap.get(s.orderId.toLowerCase());
    return b ? withFundingFacts(s, b) : s;
  });
  // what this merged journal knows: the restore's source and the backup, never the resume points between them
  const resumedPast = known
    ? {
        chainIndexes: Object.fromEntries([...new Set([...Object.keys(known.chainIndexes), ...Object.keys(backup.chainIndexes)])].map((k) => [k, Math.max(known.chainIndexes[k] ?? 0, backup.chainIndexes[k] ?? 0)])),
        aiFunding: Math.max(known.aiFunding, bAi),
      }
    : undefined;
  return {
    ...device,
    ...(device.settings === undefined && backup.settings !== undefined ? { settings: backup.settings } : {}),
    ...(device.deploymentFingerprints || backup.deploymentFingerprints ? { deploymentFingerprints: { ...(backup.deploymentFingerprints ?? {}), ...(device.deploymentFingerprints ?? {}) } } : {}),
    ...(device.lightClient === undefined && backup.lightClient !== undefined ? { lightClient: backup.lightClient } : {}),
    ...(device.housekeeping === undefined && backup.housekeeping !== undefined ? { housekeeping: backup.housekeeping } : {}),
    ...(resumedPast ? { resumedPast } : {}),
    notes: union(device.notes, backup.notes, (n) => String(n.leafIndex)),
    noteCounter: Math.max(device.noteCounter, backup.noteCounter),
    chainIndexes,
    swaps: union(swaps, backup.swaps, (s) => s.orderId.toLowerCase()),
    schedule: union(device.schedule, backup.schedule.filter((a) => a.kind !== "housekeeping"), (a) => a.id),
    ...(device.campaigns || backup.campaigns ? { campaigns: union(device.campaigns, backup.campaigns, (c) => c.id) } : {}),
    ...(device.operations || backup.operations ? { operations: union(device.operations, backup.operations, (o) => o.id) } : {}),
    ...(device.activity || backup.activity ? { activity: union(device.activity, backup.activity, (x) => x.id) } : {}),
    ...(device.addressBook || backup.addressBook ? { addressBook: union(device.addressBook, backup.addressBook, (e) => e.id) } : {}),
    ...(ai ? { aiFunding: ai } : {}),
  };
}

/** Whether a stored journal blob has the exact shape the device's store accepts: {v: 1, nonce, ct}, hex (the tenth review round, D-7). */
export const isEncryptedJournal = (x: unknown): x is EncryptedJournal => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const j = x as Record<string, unknown>;
  return Object.keys(j).sort().join(",") === "ct,nonce,v" && j.v === 1 && typeof j.nonce === "string" && /^[0-9a-f]{48}$/i.test(j.nonce) && typeof j.ct === "string" && /^([0-9a-f]{2})+$/i.test(j.ct);
};

/** sha256("privacy-protocol/v1/journal-key" ‖ seed): a key the seed holder can always recompute. */
export const journalKey = (seed: Uint8Array): Uint8Array => sha256(concatBytes(utf8ToBytes("privacy-protocol/v1/journal-key"), seed));

export function encryptJournal(key: Uint8Array, data: JournalData, rng: (n: number) => Uint8Array = randomBytes): EncryptedJournal {
  const nonce = rng(24);
  const ct = xchacha20poly1305(key, nonce, AAD).encrypt(utf8ToBytes(JSON.stringify(data)));
  return { v: 1, nonce: bytesToHex(nonce), ct: bytesToHex(ct) };
}

export function decryptJournal(key: Uint8Array, blob: EncryptedJournal): JournalData | null {
  if (!blob || blob.v !== 1) return null;
  try {
    const data = JSON.parse(bytesToUtf8(xchacha20poly1305(key, hexToBytes(blob.nonce), AAD).decrypt(hexToBytes(blob.ct)))) as JournalData;
    if (!(data?.v === 1 && Array.isArray(data.notes))) return null;
    // V6 (spec v2.0 §12.2): the operation records in the V6 vocabulary from the decryption on (persisted at the next write)
    return { ...emptyJournal(), ...data, ...(Array.isArray(data.operations) ? { operations: upgradeOperations(data.operations) } : {}) };
  } catch {
    return null;
  }
}
