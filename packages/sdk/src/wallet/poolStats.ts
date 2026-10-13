// What the wallet knows about the pool's size (the anonymity set an observer must search), learned
// from the last tree sync or rescan. Feeds the privacy scorecard; unknown until the first sync.

export interface PoolStats { notes: number; leaves: number; at: number }

class PoolStatsStore {
  private state: PoolStats | null = null;
  private listeners = new Set<() => void>();
  get(): PoolStats | null { return this.state; }
  set(s: Omit<PoolStats, "at">): void {
    this.state = { ...s, at: Date.now() };
    for (const l of this.listeners) l();
  }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

export const poolStats = new PoolStatsStore();
