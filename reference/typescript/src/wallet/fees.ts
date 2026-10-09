// The fee formulas (Privacy Wallet Web spec §10): one fee note pays the relayer's minimum and the privacy fee at
// once — `fee = max(F, ⌈R·b / 10000⌉)` for a delivered amount R, a minimum F (the relayer's live minimum with the
// wallet's margin) and the percentage b in basis points. Exact-output ("Recipient receives" is typed) adds the fee
// to what leaves the balance; exact-input ("You send" is typed) takes it out of what leaves. Pure, in base units;
// the wallet and the relayer compute the same figures from the same terms.

export interface FeeTerms {
  /** the relayer's minimum for the vault, with the wallet's margin (F), base units */
  minimum: bigint;
  /** the privacy fee, basis points of the delivered amount (b); 0 = none */
  feePercentBps: number;
}

export interface FeeSplit { delivered: bigint; fee: bigint; total: bigint }

/** ⌈amount · bps / 10000⌉, 0 for a non-positive percentage. */
export const percentOf = (amount: bigint, bps: number): bigint => (bps > 0 && amount > 0n ? (amount * BigInt(Math.floor(bps)) + 9999n) / 10000n : 0n);

/** The one fee note for a delivered amount: the larger of the minimum and the percentage. */
export function feeForDelivered(delivered: bigint, t: FeeTerms): bigint {
  const p = percentOf(delivered, t.feePercentBps);
  return p > t.minimum ? p : t.minimum;
}

/** Exact-output: the recipient gets `delivered`; `total` leaves the balance. */
export function exactOutput(delivered: bigint, t: FeeTerms): FeeSplit {
  const fee = feeForDelivered(delivered, t);
  return { delivered, fee, total: delivered + fee };
}

/** Exact-input: `total` leaves the balance; R = min(total − F, ⌊total · 10000 / (10000 + b)⌋), the fee is the rest; nothing is delivered when the total does not cover the minimum. */
export function exactInput(total: bigint, t: FeeTerms): FeeSplit {
  const bps = BigInt(Math.max(0, Math.floor(t.feePercentBps)));
  const byPercent = (total * 10000n) / (10000n + bps);
  const byMinimum = total - t.minimum;
  let delivered = byPercent < byMinimum ? byPercent : byMinimum;
  if (delivered < 0n) delivered = 0n;
  return { delivered, fee: total - delivered, total };
}

export interface FeeBreakdown { privacy: bigint; relayer: bigint; /** the percentage already covers the relayer's minimum */ relayerIncluded: boolean; total: bigint }

/** The lines of spec §10 for a delivered amount: the privacy part, the relayer part and whether one covers the other. */
export function feeBreakdown(delivered: bigint, t: FeeTerms): FeeBreakdown {
  const privacy = percentOf(delivered, t.feePercentBps);
  return { privacy, relayer: t.minimum, relayerIncluded: privacy >= t.minimum, total: feeForDelivered(delivered, t) };
}

/** "1.00 %" for 100 bps. */
export const bpsLabel = (bps: number): string => `${(bps / 100).toFixed(2)} %`;
