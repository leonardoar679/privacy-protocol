// The four Classic pools (spec v3.0 §7.2): Ethereum mainnet, the addresses, denominations and deployed blocks read from
// the pins the deployment verification wrote (src/config/deployment.json — scripts/verify-deployment.mjs, V7 Stage 5:
// each pool's runtime code held against its Sourcify record and a rebuild with the pinned compiler, its verifier,
// levels, denomination, the operator renounced, ROOT_HISTORY_SIZE 100). Stage 9 verifies the pins against the chain
// at start; until then nothing here sends a transaction (spec §7.7, CLASSIC_LIVE).
import type { PoolId } from "../config";
import deployment from "../config/deployment.json";

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

/** The pins, as the verification wrote them (the shape the app reads; the rest of the file is the report's). */
export interface DeploymentPins {
  chainId: number;
  readAt: { block: number; date: string };
  pools: Record<
    PoolId,
    {
      address: string;
      amount: string;
      deployedBlock: number;
      denominationWei: string;
      verifier: string;
      levels: number;
      rootHistorySize: number;
      runtime: { sha256: string; bytes: number };
    }
  >;
  verifier: { address: string; runtime: { sha256: string; bytes: number } };
  router: { address: string; governance: string; instanceRegistry: string; relayerRegistry: string };
}
export const DEPLOYMENT = deployment as unknown as DeploymentPins;

/** The order of the original's slider. */
const ORDER: readonly PoolId[] = ["eth-0.1", "eth-1", "eth-10", "eth-100"];

export const POOLS: readonly Pool[] = ORDER.map((id) => {
  const p = DEPLOYMENT.pools[id];
  return {
    id,
    currency: "eth",
    amount: p.amount as PoolAmount,
    denominationWei: BigInt(p.denominationWei),
    address: p.address as `0x${string}`,
    deployedBlock: p.deployedBlock,
  };
});

/** Ethereum mainnet: the only network the pools exist on. */
export const NET_ID = DEPLOYMENT.chainId;

export const poolOf = (id: PoolId): Pool => POOLS.find((p) => p.id === id)!;
/** The pool a note names, or null (another currency, another amount, another network). */
export function poolFor(currency: string, amount: string, netId: number): Pool | null {
  if (netId !== NET_ID) return null;
  return POOLS.find((p) => p.currency === currency.toLowerCase() && p.amount === amount) ?? null;
}
