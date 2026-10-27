// The Protect flow's model (spec v2.0 §7.3; doc §22–§23): the §23 flow — SELECT_ASSET → ENTER_AMOUNT → VALIDATE_BALANCE →
// CALCULATE_FEE → PREPARE_TRANSACTION → WALLET_CONFIRM → SUBMITTED → CONFIRMED → PROTECTED_BALANCE_UPDATED — as a pure
// function of what is known, mapped onto the operation's states (spec v2.0 §12: the steps before the review are a draft),
// and the view-model of the one page: from the external wallet, what arrives in the protected balance, the 1 % privacy
// fee (ProtectRouter's), the network cost of the user's own wallet in USD.
import type { OperationRecord, OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import { amountOf, centsOf } from "../amounts";
import type { ProtectModel } from "./View";

export type ProtectStep =
  | "SELECT_ASSET"
  | "ENTER_AMOUNT"
  | "VALIDATE_BALANCE"
  | "CALCULATE_FEE"
  | "PREPARE_TRANSACTION"
  | "WALLET_CONFIRM"
  | "SUBMITTED"
  | "CONFIRMED"
  | "PROTECTED_BALANCE_UPDATED";
export const PROTECT_STEPS: readonly ProtectStep[] = [
  "SELECT_ASSET",
  "ENTER_AMOUNT",
  "VALIDATE_BALANCE",
  "CALCULATE_FEE",
  "PREPARE_TRANSACTION",
  "WALLET_CONFIRM",
  "SUBMITTED",
  "CONFIRMED",
  "PROTECTED_BALANCE_UPDATED",
];

/** Each §23 step as the operation's state (spec v3.0 §6): a draft until the review, authorized from the wallet prompt on; the hash and the receipt are one state (SOURCE_CONFIRMING). */
export const PROTECT_OPERATION_STATE: Readonly<Record<ProtectStep, OperationState>> = {
  SELECT_ASSET: "DRAFT",
  ENTER_AMOUNT: "DRAFT",
  VALIDATE_BALANCE: "DRAFT",
  CALCULATE_FEE: "QUOTING",
  PREPARE_TRANSACTION: "READY_TO_REVIEW",
  WALLET_CONFIRM: "AWAITING_AUTHORIZATION",
  SUBMITTED: "SOURCE_CONFIRMING",
  CONFIRMED: "SOURCE_CONFIRMING",
  PROTECTED_BALANCE_UPDATED: "COMPLETED",
};

export interface ProtectFacts {
  assetChosen: boolean;
  units: bigint;
  /** the external wallet's balance of the asset; null while it is read (or without a wallet) */
  balance: bigint | null;
  /** the fee is known (ProtectRouter's 1 %) and the network cost estimated (or known to be unreadable) */
  feeReady: boolean;
  /** the user opened the review */
  reviewing: boolean;
  /** the operation, once the review was confirmed */
  record: Pick<OperationRecord, "state"> | null;
}

/** The §23 step a Protect is at (pure). */
export function protectStepOf(f: ProtectFacts): ProtectStep {
  const s = f.record?.state;
  if (s === "COMPLETED") return "PROTECTED_BALANCE_UPDATED";
  if (s === "SOURCE_CONFIRMING") return "CONFIRMED"; // V7: the hash and the receipt are one state — the step list passes SUBMITTED on the way
  if (s === "AWAITING_AUTHORIZATION" || s === "PREPARING_PROOF" || s === "SUBMITTING") return "WALLET_CONFIRM";
  if (!f.assetChosen) return "SELECT_ASSET";
  if (f.units <= 0n) return "ENTER_AMOUNT";
  if (f.balance === null || f.balance < f.units) return "VALIDATE_BALANCE";
  if (!f.feeReady) return "CALCULATE_FEE";
  return f.reviewing ? "PREPARE_TRANSACTION" : "CALCULATE_FEE";
}

export interface ProtectModelInput {
  asset: { symbol: string; decimals: number };
  account: string | null;
  balance: bigint | null;
  amount: string;
  units: bigint;
  /** ProtectRouter's split of the gross: the fee and what arrives */
  split: { fee: bigint; net: bigint } | null;
  /** the network cost in wei and ETH's 8-decimal USD price, when both are known */
  networkWei: bigint | null;
  ethUsd1e8: bigint | null;
}

/** The one page's view-model: the source, the amount, what arrives, the fee, the network cost; an error in words' keys. */
export function protectModel(i: ProtectModelInput): ProtectModel {
  const a = i.asset;
  const error = i.units > 0n && i.balance !== null && i.balance < i.units ? "insufficient" : i.units > 0n && i.split && i.split.net <= 0n ? "too-small" : null;
  const networkUsdCents = i.networkWei !== null && i.ethUsd1e8 !== null ? centsOf(i.networkWei, 18, i.ethUsd1e8) : null;
  return {
    source: { account: i.account, balance: i.balance !== null ? amountOf(i.balance, a.symbol, a.decimals) : null },
    asset: a,
    amount: i.amount,
    quote:
      i.units > 0n && i.split && !error
        ? { receive: amountOf(i.split.net, a.symbol, a.decimals), privacyFee: amountOf(i.split.fee, a.symbol, a.decimals), networkUsdCents }
        : null,
    error,
  };
}
