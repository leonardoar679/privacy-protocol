// Amount-obfuscation engine (plan §65): the wallet never puts a distinctive amount on the public
// side of the pool. Public amounts (shields and withdrawals) are drawn from a small bucket set
// shared by everyone; arbitrary values live only in private notes (change, fees, transfers).
// Policy is a parameter so the privacy lab (src/sim) measures exactly the logic that ships.

export const WEI = 10n ** 18n;

/** 1-2-5 series from 0.001 to 500 units: {1,2,5} x 10^k. The public amount alphabet. */
export const BUCKETS: readonly bigint[] = (() => {
  const out: bigint[] = [];
  for (let k = 15; k <= 20; k++) for (const m of [1n, 2n, 5n]) out.push(m * 10n ** BigInt(k));
  return out.sort((a, b) => (a < b ? -1 : 1));
})();
export const MIN_BUCKET = BUCKETS[0];

export const isBucket = (x: bigint): boolean => BUCKETS.includes(x);

/**
 * The bucket alphabet of an asset with `decimals` (plan §31, §36): the same 1-2-5 series, from one
 * thousandth of a unit for 18-decimal assets (ETH: 0.001 … 500) and from one whole unit for
 * stablecoins and other low-decimal tokens (USDC: 1 … 500,000), so public amounts stay in a small
 * shared set whatever the asset. 18 decimals returns BUCKETS itself.
 */
export function bucketsFor(decimals: number): readonly bigint[] {
  if (decimals === 18) return BUCKETS;
  const start = decimals >= 12 ? decimals - 3 : decimals; // sub-unit buckets only for high-precision assets
  const out: bigint[] = [];
  for (let k = start; k <= start + 5; k++) for (const m of [1n, 2n, 5n]) out.push(m * 10n ** BigInt(k));
  return out.sort((a, b) => (a < b ? -1 : 1));
}
export const isBucketOf = (x: bigint, decimals: number): boolean => bucketsFor(decimals).includes(x);

export type PrivacyMode = "standard" | "high";

export interface PolicyParams {
  maxBucket: bigint; // largest public piece; smaller = more pieces, larger shared anonymity per piece
  maxPieces: number; // cap on pieces per plan (dust beyond it stays private / outside)
  minDelaySeconds: number; // never withdraw sooner than this after funds became spendable
  meanDelaySeconds: number; // randomized (exponential) delay added to minDelay
  hops: number; // private self-transfers before a withdrawal (breaks note-level graph, not timing)
  freshAddressPerPiece: boolean;
}

export const POLICY: Record<PrivacyMode, PolicyParams> = {
  standard: { maxBucket: 10n * WEI, maxPieces: 6, minDelaySeconds: 3600, meanDelaySeconds: 24 * 3600, hops: 1, freshAddressPerPiece: true },
  high: { maxBucket: 1n * WEI, maxPieces: 12, minDelaySeconds: 6 * 3600, meanDelaySeconds: 72 * 3600, hops: 2, freshAddressPerPiece: true },
};

/** Greedy decomposition of `amount` into at most `maxPieces` buckets ≤ maxBucket; the rest is `remainder`. */
export function decompose(amount: bigint, p: Pick<PolicyParams, "maxBucket" | "maxPieces">): { pieces: bigint[]; remainder: bigint } {
  const pieces: bigint[] = [];
  let left = amount;
  for (let i = BUCKETS.length - 1; i >= 0 && pieces.length < p.maxPieces; i--) {
    const b = BUCKETS[i];
    if (b > p.maxBucket) continue;
    while (left >= b && pieces.length < p.maxPieces) {
      pieces.push(b);
      left -= b;
    }
  }
  return { pieces, remainder: left };
}

/**
 * Shield plan: public deposits in buckets only. The part below the smallest bucket (or beyond the
 * piece cap) is NOT shielded as an odd amount — it stays outside, so no deposit ever carries a
 * fingerprint. Returns the pieces (each a separate public deposit) and what stays out.
 */
export function planShield(amount: bigint, mode: PrivacyMode = "standard"): { pieces: bigint[]; leftOutside: bigint } {
  const { pieces, remainder } = decompose(amount, POLICY[mode]);
  return { pieces, leftOutside: remainder };
}

/**
 * Withdrawal plan: the requested amount leaves the pool as bucket-sized pieces, each a separate
 * public withdrawal to a fresh stealth address with its own randomized delay. What cannot be
 * expressed in buckets stays shielded as change (a private note, no public trace).
 */
export function planWithdrawal(requested: bigint, balance: bigint, mode: PrivacyMode = "standard"): { pieces: bigint[]; keptPrivate: bigint } {
  if (requested > balance) throw new Error("insufficient shielded balance");
  const { pieces, remainder } = decompose(requested, POLICY[mode]);
  return { pieces, keptPrivate: remainder };
}

/** Deterministic exponential delay with a floor (the simulator passes its seeded uniform). */
export function sampleDelay(mode: PrivacyMode, uniform: () => number): number {
  const p = POLICY[mode];
  return p.minDelaySeconds + -Math.log(1 - uniform()) * p.meanDelaySeconds;
}

export interface UtxoNote {
  id: string;
  amount: bigint;
}

/**
 * UTXO selection for the 2-input circuit: pick ≤ 2 notes covering `needed`. If no pair covers it,
 * return the merges to perform first (each a private 2-in/3-out self-transfer), largest-first, so
 * the final spend has exactly one or two inputs. Change (sum − needed) becomes a private note.
 */
export function selectInputs(notes: UtxoNote[], needed: bigint): { inputs: UtxoNote[]; merges: UtxoNote[][]; change: bigint } {
  const sorted = [...notes].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  const total = sorted.reduce((s, n) => s + n.amount, 0n);
  if (total < needed) throw new Error("insufficient shielded balance");
  // single note
  const single = [...sorted].reverse().find((n) => n.amount >= needed); // smallest sufficient
  if (single) return { inputs: [single], merges: [], change: single.amount - needed };
  // best pair: largest + smallest partner that covers it
  for (let i = 0; i < sorted.length; i++) {
    for (let j = sorted.length - 1; j > i; j--) {
      if (sorted[i].amount + sorted[j].amount >= needed) {
        return { inputs: [sorted[i], sorted[j]], merges: [], change: sorted[i].amount + sorted[j].amount - needed };
      }
    }
  }
  // merge largest notes pairwise until one covers the need together with one more note
  const merges: UtxoNote[][] = [];
  const pool = [...sorted];
  let acc: UtxoNote = pool.shift()!;
  while (pool.length && acc.amount + pool[0].amount < needed) {
    const next = pool.shift()!;
    merges.push([acc, next]);
    acc = { id: `${acc.id}+${next.id}`, amount: acc.amount + next.amount };
  }
  const partner = pool.shift()!;
  return { inputs: [acc, partner], merges, change: acc.amount + partner.amount - needed };
}
