// The fee formulas (Privacy Wallet Web spec v2.0 §3): the privacy fee is 1 % of what the user puts in,
// p(A) = ⌈A·b / 10000⌉, and the relayer/network cost F rides on top; one fee note pays both. Exact input (a send's
// default): f = p(A) + F leaves with A and R = A − f arrives. Exact output: A* = ⌈(R + F)·10000 / (10000 − b)⌉ is the
// least input that delivers exactly R — A − ⌈Ab/10000⌉ = ⌊A(10000 − b)/10000⌋ is non-decreasing in steps of at most
// one. A swap's escrow is funded the same way: W = A − p(A) − F. The relayer accepts a withdrawal's fee note f when
// f ≥ ⌈(W + f)·b/10000⌉ + m with its own minimum m ≤ F (feeMeetsTerms; a swap's escrow funding included). A protect
// pays p(A) to ProtectRouter's fee recipient and keeps A − p(A) as its note (protectSplit, the contract's feeOf).
// Bigint only — a source scan refuses floating point here — so the wallet, the relayer and the contract compute the
// same figures (contracts/test/periphery/vectors/protect-fee.json is the contract's).

export interface FeeTerms {
  /** F: the relayer/network cost the wallet pays, base units — the relayer's live minimum with the wallet's margin */
  minimum: bigint;
  /** b: the privacy fee in basis points of the input (the product's: 100, i.e. 1.00 %); 0 = none */
  feePercentBps: number;
}

export interface FeeSplit {
  /** A: what leaves the protected balance */
  total: bigint;
  /** R (a send) or W (a swap's escrow, a withdrawal): what arrives */
  delivered: bigint;
  /** f = privacy + network: the one fee note */
  fee: bigint;
  /** p(A) */
  privacy: bigint;
  /** F */
  network: bigint;
  /** the input does not cover the fees: nothing would arrive */
  tooSmall: boolean;
}

/** The product's privacy fee, and ProtectRouter's constant FEE_BPS. */
export const PRIVACY_FEE_BPS = 100;

const BPS = 10_000n;

/** b as a bigint: an integer in [0, 10000) — a fee of 100 % would leave nothing to deliver. */
export function bpsOf(bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new RangeError(`a fee is an integer number of basis points in [0, 10000), not ${bps}`);
  return BigInt(bps);
}

/** The privacy fee of an input: p(A) = ⌈A·b / 10000⌉; nothing for a non-positive input. */
export function privacyFee(input: bigint, bps: number): bigint {
  const b = bpsOf(bps);
  return input > 0n && b > 0n ? (input * b + BPS - 1n) / BPS : 0n;
}

/** Exact input: A leaves, the fee note p(A) + F goes to the relayer, R = A − f arrives; tooSmall when R < 1. */
export function exactInput(total: bigint, t: FeeTerms): FeeSplit {
  const privacy = privacyFee(total, t.feePercentBps);
  const fee = privacy + t.minimum;
  const delivered = total - fee;
  return { total, delivered: delivered >= 1n ? delivered : 0n, fee, privacy, network: t.minimum, tooSmall: delivered < 1n };
}

/** Exact output: exactly R arrives from the least input A* = ⌈(R + F)·10000 / (10000 − b)⌉ (R < 1 delivers nothing). */
export function exactOutput(delivered: bigint, t: FeeTerms): FeeSplit {
  const b = bpsOf(t.feePercentBps);
  if (delivered < 1n) return { total: 0n, delivered: 0n, fee: 0n, privacy: 0n, network: t.minimum, tooSmall: true };
  const total = ((delivered + t.minimum) * BPS + (BPS - b) - 1n) / (BPS - b);
  const privacy = privacyFee(total, t.feePercentBps);
  return { total, delivered, fee: privacy + t.minimum, privacy, network: t.minimum, tooSmall: false };
}

/** A swap's escrow from the user's input: W = A − p(A) − F funds it (exactly exact input's R), the fee note is p(A) + F. */
export const swapFunding = exactInput;

/** The one fee note for a withdrawal of W (a public exit, a swap's escrow): exact output's f, so W + f = A*. */
export const feeForWithdrawal = (withdrawal: bigint, t: FeeTerms): bigint => exactOutput(withdrawal, t).fee;

export type FeeVerdict = { ok: true; required: bigint } | { ok: false; code: "fee_too_low" | "fee_below_percent"; required: bigint };

/** The relayer's rule for a withdrawal of W paying the fee note f: f ≥ ⌈(W + f)·b / 10000⌉ + m (m its own minimum). */
export function feeMeetsTerms(withdrawal: bigint, fee: bigint, bps: number, minimum: bigint): FeeVerdict {
  const required = privacyFee(withdrawal + fee, bps) + minimum;
  if (fee < minimum) return { ok: false, code: "fee_too_low", required };
  if (fee < required) return { ok: false, code: "fee_below_percent", required };
  return { ok: true, required };
}

/** A protect through ProtectRouter: the fee p(gross) to its recipient, the note built for net = gross − fee. */
export function protectSplit(gross: bigint, bps = PRIVACY_FEE_BPS): { gross: bigint; fee: bigint; net: bigint } {
  const fee = privacyFee(gross, bps);
  return { gross, fee, net: gross - fee };
}

/** "1.00 %" for 100 bps. */
export function bpsLabel(bps: number): string {
  const b = bpsOf(bps);
  return `${b / 100n}.${(b % 100n).toString().padStart(2, "0")} %`;
}
