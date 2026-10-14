// The prices' state apart from the code that reads them (V6 Stage 16, spec v2.0 §19's budget): Home renders from it
// before the chain client loads; ./prices.ts's PriceStore reads the feeds and writes here.
import type { Prices } from "@privacy-wallet/protocol/wallet/valuation";

export type PriceStatus = "idle" | "not-configured" | "loading" | "ready" | "unavailable";
export interface PriceState {
  status: PriceStatus;
  prices: Prices | null;
  reason?: string;
  at?: number;
}

export class PriceStateStore {
  private st: PriceState = { status: "idle", prices: null };
  private listeners = new Set<() => void>();
  get(): PriceState {
    return this.st;
  }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  set(st: PriceState): void {
    this.st = st;
    for (const l of this.listeners) l();
  }
}

/** The wallet's prices, as the default PriceStore last read them. */
export const priceState = new PriceStateStore();
