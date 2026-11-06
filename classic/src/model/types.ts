// The Classic app's view-model types (spec v3.0 §7.4–§7.7): what the screens show, what the data source answers.
import type { PoolId } from "./pools";

export type WithdrawMode = "relayer" | "wallet";

export interface RelayerInfo {
  id: string;
  /** the ENS name the registry lists */
  name: string;
  url: string;
  /** the relayer's service fee in percent × 10,000 (0.3 % → 3,000; 0.05 % → 500): integer arithmetic only */
  feePercentE4: number;
  status: "online" | "offline" | "unknown";
}

/** What the verified history says about a note's deposit (spec §7.4). */
export interface DepositFacts {
  leafIndex: number;
  /** the deposit's block timestamp, seconds */
  timestamp: number;
  blockNumber: number;
  txHash: string;
  /** the deposits made after this one, from the pool's own events */
  depositsSince: number;
  /** true when the verified Withdrawal history holds the note's nullifier hash */
  spent: boolean;
}

export type NoteLookup =
  | { kind: "invalid" }
  | { kind: "other-network"; netId: number }
  | { kind: "unknown-pool" }
  /** the history verified, synced again and read: no Deposit with the note's commitment up to its block (the tenth review round,
   *  C10-2: "The note is invalid" had been said of valid notes — the history failed or behind, a deposit of the last minutes) */
  | { kind: "no-deposit"; toBlock?: number }
  /** the pool's history could not be loaded, or the chain did not agree with it: the note could not be checked, it is not invalid */
  | { kind: "history-unavailable" }
  | { kind: "history-unverified" }
  | { kind: "found"; pool: PoolId; facts: DepositFacts };

/** The withdrawal's fee lines in wei (spec §7.5; the original's WithdrawTotal). */
export interface FeeLines {
  gasPriceWei: bigint;
  networkFeeWei: bigint;
  relayerFeeWei: bigint;
  totalFeeWei: bigint;
  /** the denomination less the total fee; negative when the fee exceeds the note */
  receiveWei: bigint;
}

export interface PoolStats {
  /** the pool's deposits so far (the original's "Anonymity set") */
  deposits: number;
  /** the newest deposits, newest first: their leaf index and timestamp */
  latest: readonly { leafIndex: number; timestamp: number }[];
  /** the history they come from is verified against the chain (the eleventh review round, C11-13: an unverified one is marked) */
  verified?: boolean;
}

/** What the proof pays, restated at the confirmation from its own public signals (the tenth review round, C10-1). */
export interface ConfirmTerms {
  pool: PoolId;
  /** EIP-55 */
  recipient: string;
  via: WithdrawMode;
  relayerName?: string;
  relayerAccount?: string;
  feeWei: bigint;
  receiveWei: bigint;
}

export type JobStatus = "QUEUED" | "ACCEPTED" | "SENT" | "MINED" | "RESUBMITTED" | "CONFIRMED" | "FAILED";

/** A row of the history: a deposit this device made or a withdrawal job it submitted — never a note. */
export interface HistoryRow {
  id: string;
  kind: "deposit" | "withdrawal";
  pool: PoolId;
  timestamp: number;
  txHash?: string;
  /** "reported": the relayer answered CONFIRMED and the pool does not show the withdrawal yet (the tenth review round, C10-3) */
  status: "waiting" | "deposited" | "withdrawn" | "failed" | "reported" | "unknown" | JobStatus;
  depositsSince?: number;
  spent?: boolean;
}

export type CheckState = "ok" | "warn" | "off" | "unknown";
export interface Check {
  state: CheckState;
  /** a message key of the catalog */
  text: string;
  /** the key's parameters (a block number, a count) */
  params?: Record<string, string | number>;
}

/** Per pool: the facts the availability model reports separately (spec §7.7). */
export interface Availability {
  pool: PoolId;
  contract: Check;
  router: Check;
  relayers: Check;
  history: Check;
  prover: Check;
  wallet: Check;
}

/** The CLASSIC_LIVE switch of one pool, function by function (spec §7.7). */
export interface PoolFunctionLive {
  deposit: boolean;
  withdraw: boolean;
}

export type ConnectionState =
  { status: "disconnected" } | { status: "connected"; account: string; chainId: number } | { status: "wrong-network"; account: string; chainId: number };
