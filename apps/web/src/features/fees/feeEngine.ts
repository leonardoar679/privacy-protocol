// The fee engine of the screens (Privacy Wallet Web spec v2.0 §3): the lines and the one number per operation — a
// send or withdrawal (exact input: "Recipient receives" R; exact output: "You pay" A*), a swap or cross-chain swap (the
// privacy fee on what the user puts in; the relayer/network cost with the executor's gas; the provider's cost; the
// market rate & impact as what is left over, so the lines add up), a protect (ProtectRouter's 1 %, the user's own
// network cost at the live price). Every figure arrives in base units or USD from the engine; the money is the shared
// formulas' (packages/protocol/src/wallet/fees.ts) and nothing here reads the network.
import { bpsLabel, exactInput, exactOutput, swapFunding, type FeeTerms } from "@privacy-wallet/protocol/wallet/fees";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";

export type T = (key: MessageKey, vars?: Vars) => string;
export interface FeeLineView {
  label: string;
  value: string;
  hint?: string;
}
export interface FeeView {
  receive: { label: string; value: string };
  pay?: { label: string; value: string };
  total: string;
  lines: FeeLineView[];
  /** base units: what leaves the balance, what arrives, the fees in the input's asset */
  split: { total: bigint; delivered: bigint; fee: bigint };
  /** the input does not cover the fees */
  tooSmall?: boolean;
}

export interface SendFeeInput {
  /** "exact-input" (the default): the typed amount leaves the balance; "exact-output": it is what the recipient receives */
  mode: "exact-output" | "exact-input";
  amount: bigint;
  terms: FeeTerms;
  /** a withdrawal to a public address re-reads the relayer's minimum at submit: "Maximum you pay" */
  withdrawal?: boolean;
  format: (units: bigint) => string;
  t: T;
}

/** A private send or withdrawal: one fee note, the privacy fee p(A) and the relayer's F shown apart; they add up. */
export function sendFees(o: SendFeeInput): FeeView {
  const s = o.mode === "exact-output" ? exactOutput(o.amount, o.terms) : exactInput(o.amount, o.terms);
  const lines: FeeLineView[] = [];
  if (o.terms.feePercentBps > 0) lines.push({ label: o.t("fees.privacy", { percent: bpsLabel(o.terms.feePercentBps) }), value: o.format(s.privacy) });
  lines.push({ label: o.t("fees.relayer"), value: o.format(s.network) });
  return {
    receive: { label: o.t("fees.recipientReceives"), value: o.format(s.delivered) },
    pay: { label: o.t(o.mode === "exact-input" ? "fees.youSend" : o.withdrawal ? "fees.maximumYouPay" : "fees.youPay"), value: o.format(s.total) },
    total: o.format(s.fee),
    lines,
    split: { total: s.total, delivered: s.delivered, fee: s.fee },
    tooSmall: s.tooSmall,
  };
}

export interface SwapFeeInput {
  /** A: what the user puts in; the escrow is funded with W = A − p(A) − F */
  amount: bigint;
  terms: FeeTerms;
  /** T: the executor tip the service quoted on — the execution's gas, in the input's asset */
  executorTip: bigint;
  /** the service's quote, on W − T */
  toAmount: bigint;
  toAmountMin: bigint;
  /** the provider's and the network's costs in USD when the service valued them, else null (the units line stands in) */
  providerUsd: number | null;
  networkUsd: number | null;
  /** the provider's fee lines in asset units when unvalued ("0.0012 ETH + 0.5 USDC"), from the service's feeSummary */
  unvalued?: string | null;
  /** the USD of one base unit of the input and of the output, for the market rate & impact; absent: no such line */
  usdPerUnit?: { from: number; to: number } | null;
  formatFrom: (units: bigint) => string;
  formatTo: (units: bigint) => string;
  formatUsd: (usd: number) => string;
  t: T;
}

/** A swap or cross-chain swap: the privacy fee on the input, the relayer/network F + T, the provider's cost, the market rate & impact. */
export function swapFees(o: SwapFeeInput): FeeView {
  const s = swapFunding(o.amount, o.terms);
  const network = s.network + o.executorTip;
  const lines: FeeLineView[] = [];
  if (o.terms.feePercentBps > 0) lines.push({ label: o.t("fees.privacy", { percent: bpsLabel(o.terms.feePercentBps) }), value: o.formatFrom(s.privacy) });
  lines.push({ label: o.t("fees.relayer"), value: o.formatFrom(network) });
  const valued = o.providerUsd !== null || o.networkUsd !== null;
  const providerUsd = (o.providerUsd ?? 0) + (o.networkUsd ?? 0);
  if (valued) lines.push({ label: o.t("fees.swap"), value: o.formatUsd(providerUsd) });
  else if (o.unvalued) lines.push({ label: o.t("fees.swap"), value: o.unvalued });
  // what is left between what the provider was given (W − T) and what it quotes, net of its own stated fees: the market
  // rate and the trade's impact (it may be negative); with it the lines add up to the input
  if (valued && o.usdPerUnit) {
    const given = Number(s.delivered - o.executorTip) * o.usdPerUnit.from;
    const expected = Number(o.toAmount) * o.usdPerUnit.to;
    lines.push({ label: o.t("fees.marketImpact"), value: o.formatUsd(given - providerUsd - expected) });
  }
  const ours = s.privacy + network;
  return {
    receive: { label: o.t("fees.receiveAtLeast"), value: o.formatTo(o.toAmountMin) },
    pay: { label: o.t("fees.estimatedReceive"), value: o.formatTo(o.toAmount) },
    total: valued ? `${o.formatFrom(ours)} + ${o.formatUsd(providerUsd)}` : o.formatFrom(ours),
    lines,
    split: { total: o.amount, delivered: s.delivered, fee: ours },
    tooSmall: s.tooSmall || s.delivered <= o.executorTip,
  };
}

export interface ProtectFeeInput {
  amount: bigint;
  /** p(A), ProtectRouter's fee (0 for a deployment without a router) */
  fee: bigint;
  feePercentBps: number;
  networkUsd: number | null;
  format: (units: bigint) => string;
  formatUsd: (usd: number) => string;
  t: T;
}

/** A protect: 1 % of the input through ProtectRouter, the note holds the rest; the user's own network cost at the live price. */
export function protectFees(o: ProtectFeeInput): FeeView {
  const network = o.networkUsd === null ? o.t("fees.networkUnknown") : `≈ ${o.formatUsd(o.networkUsd)}`;
  const lines: FeeLineView[] = [];
  if (o.fee > 0n) lines.push({ label: o.t("fees.privacy", { percent: bpsLabel(o.feePercentBps) }), value: o.format(o.fee) });
  lines.push({ label: o.t("fees.relayer"), value: network });
  return {
    receive: { label: o.t("fees.youReceive"), value: o.format(o.amount - o.fee) },
    total: o.fee > 0n ? `${o.format(o.fee)} + ${network}` : network,
    lines,
    split: { total: o.amount, delivered: o.amount - o.fee, fee: o.fee },
    tooSmall: o.amount <= o.fee,
  };
}
