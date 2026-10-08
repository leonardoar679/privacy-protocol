// The encrypted note journal (plan §44): everything the wallet must remember between sessions that
// is not recoverable from the seed alone — its notes with their leaf indexes and spent state, the
// per-chain fresh-address counters, open swap orders and scheduled actions, settings. Encrypted with
// a key derived from the seed (never the password), so it is readable only while the wallet is
// unlocked; chain rescan (scanNotes) remains the fallback when the journal is lost.
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, bytesToUtf8, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { SerializedNote } from "./notes";

export interface StoredSwap {
  orderId: string;
  attemptId: string; // the one-time order key is re-derived from the seed + attemptId; never stored
  refundCounter: number;
  /** the 169-byte refund payload committed in the order (random, so it cannot be re-derived); hex */
  refundNoteData?: string;
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
}

/**
 * A scheduled action (plan §30; V2 Stage 4): `attempts` and `nextAttemptAt` are the runner's backoff after a
 * failure (10 min, doubling, at most 6 h); an abandoned order's action is removed, never retried.
 */
export interface ScheduledAction { id: string; kind: "fund-escrow" | "housekeeping"; orderId: string; dueAt: number; done?: boolean; error?: string; attempts?: number; nextAttemptAt?: number }

/** One line of the Activity screen (whale spec §25, plan V2 §49–§50): local only, never sent anywhere. */
export interface ActivityRecord {
  id: string;
  kind: "shield" | "transfer" | "withdraw" | "swap" | "refund" | "housekeeping";
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
}

export interface EncryptedJournal { v: 1; nonce: string; ct: string }

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
    return data?.v === 1 && Array.isArray(data.notes) ? { ...emptyJournal(), ...data } : null;
  } catch {
    return null;
  }
}
