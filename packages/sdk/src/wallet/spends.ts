// The pool's spend index (the sixth review round, 2026-11-03): every ShieldedTransaction event of the core, read fetch-all with the
// note events in the same windows and agreed by every endpoint (../chain.ts `syncPoolQuorum`). A note's spent bit is a lookup in
// it — before, every scan asked `isNullifierSpent` for each nullifier of this wallet's notes, which named them to the endpoints
// and linked each later withdrawal to this client (threat-model A4). The index also names the transaction that spent exactly a
// record's pair of nullifiers, which gives a Send whose relayer answer was lost for good its exit (../operations/stale.ts).
import type { SpendLog } from "../chain";

export interface SpendIndex {
  /** the block the events were read up to: a spend in the index is at or before it */
  readonly block: bigint;
  readonly size: number;
  spent(nullifier: bigint): boolean;
  /** the spend of exactly this pair, in this order (a transact's two nullifiers), or null */
  spendOf(pair: readonly [bigint, bigint]): SpendLog | null;
}

export function indexSpends(spends: readonly SpendLog[], block: bigint): SpendIndex {
  const byNullifier = new Map<bigint, SpendLog>();
  for (const s of spends) {
    byNullifier.set(s.nullifier0, s);
    byNullifier.set(s.nullifier1, s);
  }
  return {
    block,
    size: spends.length,
    spent: (n) => byNullifier.has(n),
    spendOf: ([a, b]) => {
      const s = byNullifier.get(a);
      return s && s.nullifier0 === a && s.nullifier1 === b ? s : null;
    },
  };
}

const latest = new Map<string, SpendIndex>();
/** The last agreed index of a pool, by its core: the scan sets it, the stale mover reads it. Public chain data — kept across locks. */
export function rememberSpendIndex(core: string, index: SpendIndex): void {
  latest.set(core.toLowerCase(), index);
}
export function spendIndexOf(core: string): SpendIndex | null {
  return latest.get(core.toLowerCase()) ?? null;
}
/** Whether any pool's last agreed index has this nullifier spent (the wallet's one deployment, in practice): public chain data. */
export function spentInAnyIndex(nullifier: bigint): boolean {
  for (const index of latest.values()) if (index.spent(nullifier)) return true;
  return false;
}
export function forgetSpendIndexes(): void {
  latest.clear();
}
