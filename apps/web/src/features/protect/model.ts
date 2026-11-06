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
  /** the asset is the chain's own coin: the connected wallet pays the deposit's network fee out of the same balance (E11-13) */
  native?: boolean;
  /**
   * The amount is the one Max filled, unedited (the critique of E11-13): its reserve was taken from the estimate live when Max was tapped. The
   * estimate read next for that amount — its calldata priced by the byte, the note's random fields in it, the gas price a block later — is
   * often a few wei above, and the page had refused Max's own amount.
   */
  maxFilled?: boolean;
}

/**
 * What a Protect of the chain's own coin leaves in the connected wallet for the deposit's network fee (the eleventh review round,
 * 2026-11-04, E11-13): three times the live estimate — the deposit's gas × the wallet's own gas price (./estimate.ts), never a price of
 * this wallet's. The wallet that sends the deposit sets its gas limit above its estimate (MetaMask adds half again) and checks the
 * balance against that limit × its highest fee per gas, which it sets above today's price so that a rising base fee (EIP-1559: up to
 * 12.5 % a block) does not strand the transaction — commonly about twice the base fee: 1.5 × 2. What the deposit does not spend stays in
 * the connected wallet. Max had filled the whole balance, the page had let it through, and the wallet's own prompt then refused it.
 */
export const NETWORK_FEE_RESERVE = 3n;
export const networkReserveOf = (networkWei: bigint): bigint => networkWei * NETWORK_FEE_RESERVE;

/**
 * Max (E11-13): a token's whole balance (its network fee is paid in ETH); of the chain's own coin, the balance less the reserve — the
 * whole balance while no estimate is known (the page cannot know the fee: the wallet's prompt judges), or when the reserve takes it all
 * (the page then says why it cannot be protected).
 */
export function maxProtect(balance: bigint, native: boolean, networkWei: bigint | null): bigint {
  if (!native || networkWei === null) return balance;
  const reserve = networkReserveOf(networkWei);
  return balance > reserve ? balance - reserve : balance;
}

/** The one page's view-model: the source, the amount, what arrives, the fee, the network cost; an error in words' keys. */
export function protectModel(i: ProtectModelInput): ProtectModel {
  const a = i.asset;
  // an amount of the chain's own coin that leaves less than the network fee's reserve cannot be sent by the wallet (E11-13) — save the one
  // Max filled with a reserve, as filled (its critique); a balance the reserve takes whole is said as such: Max cannot leave enough (its
  // critique: "Max leaves enough" had been said of the very amount Max filled)
  const reserve = i.native && i.networkWei !== null ? networkReserveOf(i.networkWei) : 0n;
  const error =
    i.units > 0n && i.balance !== null && i.balance < i.units
      ? "insufficient"
      : i.units > 0n && i.balance !== null && i.balance - i.units < reserve && !(i.maxFilled && i.balance > i.units)
        ? i.balance > reserve
          ? "insufficient-fee"
          : "cannot-cover-fee"
        : i.units > 0n && i.split && i.split.net <= 0n
          ? "too-small"
          : null;
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
