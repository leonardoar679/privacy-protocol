// Note management for large balances (plan V2 §73–§74; whale spec §12, §13; the whale UTXO lab in
// docs/privacy-lab.md): a large balance is kept as standard-bucket notes — no note above 100 units
// (100 ETH / 100,000 USDC), ideally 10-unit pieces — so a withdrawal to the user's own addresses can
// leave as pieces over the policy window when privacy is preferred over speed. The extended alphabet
// (1,000 / 2,000 / 5,000 ETH) is not adopted: a piece nobody else withdraws has no cover. Housekeeping is
// private self-transfers: a split spends one note into two of ours (2-in/3-out with the relayer's fee
// note), a merge spends two into one. This planner is pure and fee-aware: every action costs one fee,
// the budget bounds a run, and the plan is simulated on a working copy so each action is consistent
// with the ones before it.
import { bucketsFor } from "./amounts";

export interface ShapePolicy {
  /** no note above this (the lab: 100 units) */
  maxPiece: bigint;
  /** the ideal piece (the lab: 10 units), split down to while the note count allows */
  targetPiece: bigint;
  /** notes below this are dust, merged into their neighbour */
  dustFloor: bigint;
  /** the most notes a balance is kept in (bounds the gas a withdrawal campaign needs) */
  maxNotes: number;
}
export interface NoteRef { id: string; amount: bigint }
export type HousekeepingAction =
  | { kind: "split"; input: NoteRef; outputs: [bigint, bigint]; /** the planner's ids of the two outputs (later actions refer to them) */ outputIds: [string, string]; fee: bigint; reason: string }
  | { kind: "merge"; inputs: [NoteRef, NoteRef]; outputId: string; fee: bigint; reason: string };
export interface ShapeReport {
  /** nothing to do */
  ok: boolean;
  count: number;
  oversized: number;
  dust: number;
  /** what the planner could not do within the budget or the action cap */
  deferred: number;
  reasons: string[];
}

/**
 * The shape policy of an asset from its bucket alphabet, by position in the series so that it follows value, not
 * unit count: the 16th bucket (100 ETH; 100,000 USDC) is the largest piece, the 13th (10 ETH; 10,000 USDC) the
 * ideal one, the first the dust floor; at most 64 notes.
 */
export function shapeFor(decimals: number, over: Partial<ShapePolicy> = {}): ShapePolicy {
  const a = bucketsFor(decimals);
  return { maxPiece: a[15] ?? a[a.length - 1], targetPiece: a[12] ?? a[a.length - 1], dustFloor: a[0], maxNotes: 64, ...over };
}

const largestBucketAtMost = (alphabet: readonly bigint[], cap: bigint): bigint | null => { let best: bigint | null = null; for (const b of alphabet) if (b <= cap && (best === null || b > best)) best = b; return best; };

/**
 * The next housekeeping actions for `notes` of one asset, in order: dust merges, splits of notes above
 * maxPiece (largest first), merges when there are too many notes, then splits towards the target piece
 * while the note count allows. Each action pays `feePerTx` out of the notes it touches.
 */
export function planHousekeeping(notes: NoteRef[], o: { decimals: number; feePerTx: bigint; feeBudget?: bigint; maxActions?: number; policy?: Partial<ShapePolicy> }): { actions: HousekeepingAction[]; shape: ShapeReport } {
  const p = shapeFor(o.decimals, o.policy);
  const alphabet = bucketsFor(o.decimals);
  const fee = o.feePerTx;
  const maxActions = o.maxActions ?? 1000;
  let budget = o.feeBudget;
  const pool: NoteRef[] = notes.map((n) => ({ ...n }));
  const actions: HousekeepingAction[] = [];
  let seq = 0;
  const reasons: string[] = [];
  let stopped = false; // the budget or the action cap ended the run with work left
  const canAfford = () => { if (actions.length < maxActions && (budget === undefined || budget >= fee)) return true; stopped = true; return false; };
  const pay = () => { if (budget !== undefined) budget -= fee; };
  const smallest = (except?: string) => pool.filter((n) => n.id !== except).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0];
  const remove = (...ids: string[]) => { for (const id of ids) pool.splice(pool.findIndex((n) => n.id === id), 1); };
  const merge = (a: NoteRef, b: NoteRef, reason: string) => { const id = `m${seq++}`; actions.push({ kind: "merge", inputs: [a, b], outputId: id, fee, reason }); pay(); remove(a.id, b.id); pool.push({ id, amount: a.amount + b.amount - fee }); };

  // 1. dust: merge each dust note into the smallest other note (a dust note worth less than the fee is left alone)
  while (!stopped) {
    const dust = pool.find((n) => n.amount < p.dustFloor);
    if (!dust || pool.length < 2) break;
    if (dust.amount <= fee) { remove(dust.id); reasons.push(`a note of ${dust.amount} is worth less than a fee and is left as it is`); continue; }
    if (!canAfford()) break;
    merge(dust, smallest(dust.id), "dust merged into its neighbour");
  }

  // 2. oversized notes: split off the largest bucket at most maxPiece, largest note first
  const splitDown = (cap: bigint, why: string, stopAtMax: boolean) => {
    while (!stopped) {
      const big = [...pool].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0)).find((n) => n.amount > cap);
      if (!big) return;
      if (stopAtMax && pool.length >= p.maxNotes) { reasons.push(`${p.maxNotes} notes already; no further splits`); return; }
      const piece = largestBucketAtMost(alphabet, cap);
      if (piece === null) return;
      const rest = big.amount - piece - fee;
      if (rest <= 0n) { remove(big.id); continue; } // a note barely above the cap: left as it is (the fee would eat the rest)
      if (!canAfford()) return;
      const ids: [string, string] = [`s${seq}a`, `s${seq}b`];
      seq++;
      actions.push({ kind: "split", input: big, outputs: [piece, rest], outputIds: ids, fee, reason: why });
      pay();
      remove(big.id);
      pool.push({ id: ids[0], amount: piece }, { id: ids[1], amount: rest });
    }
  };
  splitDown(p.maxPiece, "a note above the largest common size is split", false);

  // 3. too many notes: merge the two smallest until within the cap
  while (!stopped && pool.length > p.maxNotes) {
    const a = smallest(), b = smallest(a.id);
    if (a.amount + b.amount <= fee) break;
    if (!canAfford()) break;
    merge(a, b, "too many notes: the two smallest merged");
  }

  // 4. towards the ideal piece, while the count allows
  splitDown(p.targetPiece, "a note above the ideal piece is split", true);

  const oversized = notes.filter((n) => n.amount > p.maxPiece).length;
  const dustCount = notes.filter((n) => n.amount < p.dustFloor).length;
  const deferred = stopped ? 1 : 0;
  return { actions, shape: { ok: actions.length === 0 && deferred === 0, count: notes.length, oversized, dust: dustCount, deferred, reasons } };
}

/** One sentence for the Home screen. */
export function shapeSummary(r: ShapeReport, planned: number): string {
  if (r.ok) return "Your private balance is kept in common-sized pieces.";
  const parts = [...(r.oversized ? [`${r.oversized} note${r.oversized === 1 ? "" : "s"} above the largest common size`] : []), ...(r.dust ? [`${r.dust} dust note${r.dust === 1 ? "" : "s"}`] : [])];
  return `${planned} maintenance step${planned === 1 ? "" : "s"} planned${parts.length ? ` (${parts.join(", ")})` : ""}; each is a private self-transfer at a quiet time.`;
}
