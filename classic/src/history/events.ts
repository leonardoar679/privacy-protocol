// The pools' two events (spec v3.0 §7.4; the compatibility matrix §3): Deposit(bytes32 indexed commitment, uint32
// leafIndex, uint256 timestamp) and Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee),
// decoded from raw eth_getLogs entries. Pure; shared by the app, the tests and the snapshot generator (Node runs this
// module directly, hence the explicit extensions on this chain).
import { keccak256 } from "js-sha3";

export type Hex = `0x${string}`;

export const TOPICS = Object.freeze({
  Deposit: ("0x" + keccak256("Deposit(bytes32,uint32,uint256)")) as Hex,
  Withdrawal: ("0x" + keccak256("Withdrawal(address,bytes32,address,uint256)")) as Hex,
});

/** A raw log as eth_getLogs returns it. */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash?: string;
  transactionHash: string;
  logIndex?: string;
  removed?: boolean;
}

export interface DepositEvent {
  leafIndex: number;
  commitment: Hex;
  /** the block's timestamp, seconds */
  timestamp: number;
  blockNumber: number;
  transactionHash: Hex;
  logIndex?: number;
}

export interface WithdrawalEvent {
  nullifierHash: Hex;
  to: Hex;
  /** null when the source did not record it (the original UI's caches) */
  relayer: Hex | null;
  /** wei, decimal */
  fee: string;
  blockNumber: number;
  transactionHash: Hex;
  logIndex?: number;
}

export class LogDecodeError extends Error {}

const word = (data: string, i: number): string => {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 64 * (i + 1)) throw new LogDecodeError(`the log's data has no word ${i}`);
  return hex.slice(64 * i, 64 * (i + 1));
};
const bytes32 = (w: string): Hex => {
  if (!/^[0-9a-fA-F]{64}$/.test(w)) throw new LogDecodeError("not a 32-byte word");
  return `0x${w.toLowerCase()}`;
};
const address = (w: string): Hex => {
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(w)) throw new LogDecodeError("not an address word");
  return `0x${w.slice(24).toLowerCase()}`;
};
const uint = (w: string): bigint => BigInt("0x" + w);
const number = (hexOrNumber: string | number): number => (typeof hexOrNumber === "number" ? hexOrNumber : Number.parseInt(hexOrNumber, 16));

export function decodeDeposit(log: RawLog): DepositEvent {
  if (log.topics[0]?.toLowerCase() !== TOPICS.Deposit || log.topics.length !== 2) throw new LogDecodeError("not a Deposit log");
  const leafIndex = uint(word(log.data, 0));
  const timestamp = uint(word(log.data, 1));
  if (leafIndex >= 2n ** 32n || timestamp >= 2n ** 53n) throw new LogDecodeError("a Deposit log out of range");
  return {
    leafIndex: Number(leafIndex),
    commitment: bytes32(log.topics[1].replace(/^0x/, "")),
    timestamp: Number(timestamp),
    blockNumber: number(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase() as Hex,
    ...(log.logIndex !== undefined ? { logIndex: number(log.logIndex) } : {}),
  };
}

export function decodeWithdrawal(log: RawLog): WithdrawalEvent {
  if (log.topics[0]?.toLowerCase() !== TOPICS.Withdrawal || log.topics.length !== 2) throw new LogDecodeError("not a Withdrawal log");
  return {
    to: address(word(log.data, 0)),
    nullifierHash: bytes32(word(log.data, 1)),
    relayer: address(log.topics[1].replace(/^0x/, "")),
    fee: uint(word(log.data, 2)).toString(),
    blockNumber: number(log.blockNumber),
    transactionHash: log.transactionHash.toLowerCase() as Hex,
    ...(log.logIndex !== undefined ? { logIndex: number(log.logIndex) } : {}),
  };
}

const byPosition = <T extends { blockNumber: number; logIndex?: number }>(a: T, b: T) => a.blockNumber - b.blockNumber || (a.logIndex ?? 0) - (b.logIndex ?? 0);

/** Both kinds out of one window of logs, in chain order; removed (reorged) logs and other events skipped. */
export function decodeLogs(logs: readonly RawLog[], poolAddress?: string): { deposits: DepositEvent[]; withdrawals: WithdrawalEvent[] } {
  const deposits: DepositEvent[] = [];
  const withdrawals: WithdrawalEvent[] = [];
  for (const log of logs) {
    if (log.removed) continue;
    if (poolAddress && log.address.toLowerCase() !== poolAddress.toLowerCase()) continue;
    const topic = log.topics[0]?.toLowerCase();
    if (topic === TOPICS.Deposit) deposits.push(decodeDeposit(log));
    else if (topic === TOPICS.Withdrawal) withdrawals.push(decodeWithdrawal(log));
  }
  deposits.sort(byPosition);
  withdrawals.sort(byPosition);
  return { deposits, withdrawals };
}

/** The deposits continue the count: leaf indices `from`, `from + 1`, … with no gap and no repeat. */
export function checkContinuity(deposits: readonly DepositEvent[], from: number): void {
  deposits.forEach((d, i) => {
    if (d.leafIndex !== from + i) throw new LogDecodeError(`leaf ${from + i} expected, the events say ${d.leafIndex}`);
  });
}
