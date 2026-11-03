// The data the screens read (spec v3.0 §7.4–§7.7), behind one interface: the pool statistics, a note looked up in the
// verified history, the relayers, the live gas price, the availability of each pool's functions, the history of this
// device. Stage 3 runs on the mock below (`mock.ts`); Stages 7–9 bring the real one (snapshots + delta sync, the curated
// relayers, the chain). Nothing here sends a transaction: a deposit or a withdrawal is a separate, switch-guarded
// operation (spec §7.7).
import type { ClassicNote } from "./notes";
import type { PoolId } from "./pools";
import type { Availability, HistoryRow, NoteLookup, PoolStats, RelayerInfo } from "./types";

export interface ClassicSource {
  stats(pool: PoolId): Promise<PoolStats>;
  /** the verified history first — nothing is disclosed to any endpoint by a lookup (spec §7.4) */
  lookup(note: ClassicNote): Promise<NoteLookup>;
  relayers(): Promise<RelayerInfo[]>;
  /** every listed relayer asked again (the review round of 2026-11-03, C2-7): when the Withdraw tab or the relayer settings open, never at page load */
  refreshRelayers(): Promise<RelayerInfo[]>;
  /** the live gas price in wei (never a constant) */
  gasPriceWei(): Promise<bigint>;
  availability(pool: PoolId): Promise<Availability>;
  history(): Promise<HistoryRow[]>;
}
