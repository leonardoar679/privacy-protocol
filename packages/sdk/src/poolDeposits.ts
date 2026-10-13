// How many holders could pay a public piece (whale spec §18 `large-piece`): counted from the pool's public
// deposit sizes (every vault's Deposited events, read through the RPC quorum — the same request for every
// user, nothing address-specific). Read only when a piece exceeds the common sizes, on the user's input,
// and cached for five minutes; never at launch.
import { depositedLogsQuorum, type Deployment } from "./chain";

const cache = new Map<string, { at: number; amounts: { vault: string; amount: bigint }[] }>();
export const DEPOSITS_TTL_MS = 5 * 60_000;

async function depositSizes(d: Deployment, now = Date.now()): Promise<{ vault: string; amount: bigint }[]> {
  const key = `${d.chainId}:${d.core.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < DEPOSITS_TTL_MS) return hit.amounts;
  const logs = await depositedLogsQuorum(d);
  const amounts = logs.map((l) => ({ vault: l.vault.toLowerCase(), amount: l.amount }));
  cache.set(key, { at: now, amounts });
  return amounts;
}

/** Deposits into `vault` of at least `piece`: an upper bound on the holders who could still pay it. */
export async function holdersAbove(d: Deployment, vault: string, piece: bigint): Promise<number> {
  const sizes = await depositSizes(d);
  return sizes.filter((s) => s.vault === vault.toLowerCase() && s.amount >= piece).length;
}

export const resetDepositsCache = (): void => cache.clear();
