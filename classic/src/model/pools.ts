// The four Classic pools (spec v3.0 §7.2): Ethereum mainnet, the documented addresses the owner's document names, their
// denominations and deployed blocks. Stage 5 verifies them against the chain and pins their code hashes in
// src/config/deployment.json; until then nothing here sends a transaction (spec §7.7, CLASSIC_LIVE).
import type { PoolId } from "../config";

export type { PoolId };
export type PoolAmount = "0.1" | "1" | "10" | "100";

export interface Pool {
  id: PoolId;
  currency: "eth";
  amount: PoolAmount;
  /** the fixed denomination in wei */
  denominationWei: bigint;
  address: `0x${string}`;
  deployedBlock: number;
}

const ETH = 1_000_000_000_000_000_000n;

export const POOLS: readonly Pool[] = [
  {
    id: "eth-0.1",
    currency: "eth",
    amount: "0.1",
    denominationWei: ETH / 10n,
    address: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
    deployedBlock: 9_116_966,
  },
  { id: "eth-1", currency: "eth", amount: "1", denominationWei: ETH, address: "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936", deployedBlock: 9_117_609 },
  { id: "eth-10", currency: "eth", amount: "10", denominationWei: 10n * ETH, address: "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf", deployedBlock: 9_117_720 },
  {
    id: "eth-100",
    currency: "eth",
    amount: "100",
    denominationWei: 100n * ETH,
    address: "0xa160cdab225685da1d56aa342ad8841c3b53f291",
    deployedBlock: 9_161_895,
  },
];

/** Ethereum mainnet: the only network the pools exist on. */
export const NET_ID = 1;

export const poolOf = (id: PoolId): Pool => POOLS.find((p) => p.id === id)!;
/** The pool a note names, or null (another currency, another amount, another network). */
export function poolFor(currency: string, amount: string, netId: number): Pool | null {
  if (netId !== NET_ID) return null;
  return POOLS.find((p) => p.currency === currency.toLowerCase() && p.amount === amount) ?? null;
}
