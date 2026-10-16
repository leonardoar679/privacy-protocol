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
import type { ClassicDepositRecord } from "./classicRecord";
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
  createdAt: number;
  dueAt?: number; // scheduled funding time (plan §30), unix ms
  fundedTx?: string;
  /** the funding's own submission, journaled before it is sent (a V6 follow-up of 2026-10-14): its two nullifiers
   *  (decimal), who sent it, the relayer, the transaction once known. Until its fate is known (swapFunding.ts
   *  `fundingFate`) no runner sends another: a reload or a Resume had funded an escrow twice when the notes differed. */
  fundingAttempt?: FundingAttempt;
  jobId?: string;
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
   *  on an order it gave up before funding, `older_notes_unavailable` (the older notes no longer covered it) or `order_expired` (its
   *  execution window closed, or was about to); on a funded one whose window closed before its hand-over, `execution_window_closed` */
  paused?: { code: string; detail?: string; minOut?: string; approved?: string; at: number };
  /** V6 Stage 12 (spec v2.0 §11.2): a same-chain swap into the protected balance — the shield receiver this wallet named as
   *  the destination (its factory and parameters, the counter its note derives from, the payload), whether the executor
   *  has its shield job, what the executor last reported, and the note once it is found in the pool */
  shield?: StoredShield;
}

/** A funding sent for an order (StoredSwap.fundingAttempt). */
export interface FundingAttempt {
  nullifiers: [string, string];
  by: "relayer" | "wallet";
  relayerUrl?: string;
  txHash?: string;
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
export interface ScheduledAction { id: string; kind: "fund-escrow" | "housekeeping" | "campaign-tick" | "campaign-shape" | "order-tick" | "discovery"; orderId: string; dueAt: number; done?: boolean; error?: string; attempts?: number; nextAttemptAt?: number }

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
  /** V2 (whale spec §25, Stage 4): the Activity list. Optional, never written by emptyJournal(); readers default it to []. */
  activity?: ActivityRecord[];
  /** V2 (Stage 8): what private balance maintenance spent on relayer fees today (the daily cap of settings.housekeeping) */
  housekeeping?: { day: string; feeWei: string; steps: number };
  /** V2 (Stage 9): the next fresh funding address index of Private AI (a credit note withdrawn moves to the next) */
  aiFunding?: { index: number };
  /** V3 (High-Value Protection spec §17): the campaigns (tranches under an in-flight cap) and the address book. Optional, never written by emptyJournal(): the pinned at-rest vectors and V2 journals stay valid. */
  campaigns?: Campaign[];
  addressBook?: AddressBookEntry[];
  /** V5 (Privacy Wallet Web spec §12): the operation records from the signature on. Optional, never written by emptyJournal(): every earlier journal stays valid. V6 (spec v2.0 §12.2): a V5 record is upgraded when the journal is decrypted (`v: 2`). */
  operations?: OperationRecord[];
  /** V5 (spec §16): the Classic Privacy module's deposits — its own state, never the notes. Optional, never written by emptyJournal(). */
  classic?: { deposits: ClassicDepositRecord[]; /** V6 Stage 14: the classic relayer the user chose (its id) */ relayer?: string };
  /** V6 Stage 15 (spec v2.0 §14.3): this device's last proof — the key's fetch (or cache read) and the proving, in ms */
  proofStats?: ProofStats;
  /** V6 Stage 10 (doc §71; spec v2.0 §10): the deployment fingerprint first seen per chain id (deploymentGuard.ts) — a different one blocks every operation until it is forgotten under Advanced. Optional, never written by emptyJournal(). */
  deploymentFingerprints?: Record<string, string>;
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
