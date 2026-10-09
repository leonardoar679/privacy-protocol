// The fee engine of the screens (spec §10, §3.4–§3.6; plan §21–§22): the FeeSummary's lines and the one number per
// operation kind — a private send or withdrawal (exact-output by default, exact-input when "You send" is typed), a
// swap or cross-chain swap (the executor tip as the privacy fee, the provider's and the network's costs beside it),
// a protect (no fee note; the network cost at the live price). Every figure arrives in base units or USD from the
// engine; nothing here reads the network.
import { bpsLabel, exactInput, exactOutput, feeBreakdown, type FeeTerms } from "@ref/wallet/fees";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";

export type T = (key: MessageKey, vars?: Vars) => string;
export interface FeeLineView { label: string; value: string; hint?: string }
export interface FeeView {
  receive: { label: string; value: string };
  pay?: { label: string; value: string };
  total: string;
  lines: FeeLineView[];
  /** base units: what leaves the balance, what arrives, the fee note */
  split: { total: bigint; delivered: bigint; fee: bigint };
}

export interface SendFeeInput {
  /** "exact-output": the typed amount is what the recipient receives; "exact-input": it is what leaves the balance */
  mode: "exact-output" | "exact-input";
  amount: bigint;
  terms: FeeTerms;
  /** a withdrawal to a public address re-reads the relayer's minimum at submit: "Maximum you pay" */
  withdrawal?: boolean;
  format: (units: bigint) => string;
  t: T;
}

/** A private send or withdrawal (spec §10): one fee note, the privacy part and the relayer part shown apart. */
export function sendFees(o: SendFeeInput): FeeView {
  const split = o.mode === "exact-output" ? exactOutput(o.amount, o.terms) : exactInput(o.amount, o.terms);
  const b = feeBreakdown(split.delivered, o.terms);
  const lines: FeeLineView[] = [];
  if (o.terms.feePercentBps > 0) lines.push({ label: o.t("fees.privacy", { percent: bpsLabel(o.terms.feePercentBps) }), value: o.format(b.privacy) });
  lines.push({ label: o.t("fees.relayer"), value: o.format(b.relayer), hint: b.relayerIncluded && o.terms.feePercentBps > 0 ? o.t("fees.included") : undefined });
  return {
    receive: { label: o.t("fees.recipientReceives"), value: o.format(split.delivered) },
    pay: { label: o.t(o.withdrawal ? "fees.maximumYouPay" : "fees.youPay"), value: o.format(split.total) },
    total: o.format(split.fee),
    lines,
    split: { total: split.total, delivered: split.delivered, fee: split.fee },
  };
}

export interface SwapFeeInput {
  amount: bigint;
  tipBps: number;
  /** the service's quote, already on the amount net of the tip */
  toAmount: bigint;
  toAmountMin: bigint;
  /** the provider's and the network's costs in USD when the service valued them, else null (the units line stands in) */
  providerUsd: number | null;
  networkUsd: number | null;
  /** the provider's fee lines in asset units when unvalued ("0.0012 ETH + 0.5 USDC"), from the service's feeSummary */
  unvalued?: string | null;
  formatFrom: (units: bigint) => string;
  formatTo: (units: bigint) => string;
  formatUsd: (usd: number) => string;
  t: T;
}

/** A swap or cross-chain swap (spec §10): the executor tip is the privacy fee, the provider's and the network's costs beside it; never the tip twice. */
export function swapFees(o: SwapFeeInput): FeeView {
  const tip = (o.amount * BigInt(Math.max(0, Math.floor(o.tipBps)))) / 10000n;
  const lines: FeeLineView[] = [{ label: o.t("fees.privacy", { percent: bpsLabel(o.tipBps) }), value: o.formatFrom(tip) }];
  const swapCost = (o.providerUsd ?? 0) + (o.networkUsd ?? 0);
  if (o.providerUsd !== null || o.networkUsd !== null) lines.push({ label: o.t("fees.swap"), value: o.formatUsd(swapCost) });
  else if (o.unvalued) lines.push({ label: o.t("fees.swap"), value: o.unvalued });
  return {
    receive: { label: o.t("fees.receiveAtLeast"), value: o.formatTo(o.toAmountMin) },
    pay: { label: o.t("fees.estimatedReceive"), value: o.formatTo(o.toAmount) },
    total: o.providerUsd !== null || o.networkUsd !== null ? `${o.formatFrom(tip)} + ${o.formatUsd(swapCost)}` : o.formatFrom(tip),
    lines,
    split: { total: o.amount, delivered: o.toAmountMin, fee: tip },
  };
}

export interface ProtectFeeInput { amount: bigint; feePercentBps: number; networkUsd: number | null; format: (units: bigint) => string; formatUsd: (usd: number) => string; t: T }

/** A protect (spec §3.4): no fee note; the service fee applies later, when the user sends or swaps privately. */
export function protectFees(o: ProtectFeeInput): FeeView {
  const lines: FeeLineView[] = [
    { label: o.t("fees.service"), value: o.t("fees.serviceNone", { percent: bpsLabel(o.feePercentBps) }) },
    { label: o.t("fees.network"), value: o.networkUsd === null ? o.t("fees.networkUnknown") : `≈ ${o.formatUsd(o.networkUsd)}` },
  ];
  return {
    receive: { label: o.t("fees.youWillReceive"), value: `≈ ${o.format(o.amount)}` },
    total: o.networkUsd === null ? o.t("fees.networkUnknown") : `≈ ${o.formatUsd(o.networkUsd)}`,
    lines,
    split: { total: o.amount, delivered: o.amount, fee: 0n },
  };
}
