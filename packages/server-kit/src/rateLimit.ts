// Abuse limits for a public relayer: a token bucket per caller (requests per minute with a burst),
// and a cap on open swap jobs. Pure, clock-injectable, no dependencies. Keys are whatever the
// server chooses (the remote address here); nothing is logged.
export interface RateLimiterOptions {
  perMinute: number;
  burst?: number;
  now?: () => number;
  maxKeys?: number;
}

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly perMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  constructor(o: RateLimiterOptions) {
    if (!(o.perMinute > 0)) throw new Error("perMinute must be positive");
    this.perMs = o.perMinute / 60_000;
    this.burst = o.burst ?? o.perMinute;
    this.now = o.now ?? (() => Date.now());
    this.maxKeys = o.maxKeys ?? 10_000;
  }
  /** Take one token for `key`; false when the caller must wait. */
  allow(key: string): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evict(t);
      b = { tokens: this.burst, updated: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (t - b.updated) * this.perMs);
    b.updated = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  /** Seconds until `key` has a token again (0 when it has one). */
  retryAfterSeconds(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const tokens = Math.min(this.burst, b.tokens + (this.now() - b.updated) * this.perMs);
    return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / this.perMs / 1000);
  }
  private evict(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.updated > 60_000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string); // oldest insertion
  }
  get size(): number {
    return this.buckets.size;
  }
}
