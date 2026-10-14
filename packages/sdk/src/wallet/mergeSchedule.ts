// The merge schedule (V6 Stage 16: out of ../privateTx.ts so the campaigns store and Home read it without the spend
// pipeline): which pairs of notes to merge, one private self-transfer each, so `needed` fits in at most two inputs.
import { selectInputs } from "@privacy-wallet/protocol/wallet/amounts";

/** At most `maxMerges` merges, each paying `feePerTx`; why not, when it cannot. */
export function mergeSchedule(
  notes: { id: string; amount: bigint }[],
  needed: bigint,
  feePerTx: bigint,
  maxMerges = 8,
): { pairs: [string, string][]; ok: boolean; reason?: "balance" | "fees" | "too-many-merges" } {
  let pool = notes.map((n) => ({ ...n }));
  const pairs: [string, string][] = [];
  for (let i = 0; i <= maxMerges; i++) {
    let sel: ReturnType<typeof selectInputs>;
    try {
      sel = selectInputs(pool, needed);
    } catch {
      return { pairs, ok: false, reason: "balance" };
    }
    if (!sel.merges.length) return { pairs, ok: true };
    if (i === maxMerges) break;
    const [x, y] = sel.merges[0];
    const a = pool.find((n) => n.id === x.id)!,
      b = pool.find((n) => n.id === y.id)!;
    if (a.amount + b.amount <= feePerTx) return { pairs, ok: false, reason: "fees" };
    pairs.push([a.id, b.id]);
    pool = [...pool.filter((n) => n.id !== a.id && n.id !== b.id), { id: `${a.id}+${b.id}`, amount: a.amount + b.amount - feePerTx }];
  }
  return { pairs, ok: false, reason: "too-many-merges" };
}
