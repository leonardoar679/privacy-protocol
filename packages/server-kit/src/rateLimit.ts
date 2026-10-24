// Abuse limits for a public relayer: a token bucket per caller (requests per minute with a burst),
// and a cap on open swap jobs. Pure, clock-injectable, no dependencies. Keys are whatever the
// server chooses (the remote address here); nothing is logged.
export interface RateLimiterOptions {
  perMinute: number;
  burst?: number;
  now?: () => number;
  maxKeys?: number;
  /**
   * A key's wider allocation, and how many times the key's rate and burst all of it may use (audit round 2, n04): by
   * default an IPv6 /64's /48 at 16 times. A /48, free from tunnel brokers, holds 65,536 /64s, each its own fresh bucket.
   * `null` for none.
   */
  wider?: { of: (key: string) => string | null; factor: number } | null;
}

/** An IPv6 /64 bucket's /48 ("2001:db8:1:2::/64" is in "2001:db8:1::/48"); null for any other key (an IPv4 address is its own). */
export function widerOf(key: string): string | null {
  const m = key.match(/^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/i);
  return m ? `${m[1]}::/48` : null;
}

/** One table of token buckets. */
class Buckets {
  private map = new Map<string, { tokens: number; updated: number }>();
  constructor(
    private readonly perMs: number,
    private readonly burst: number,
    private readonly maxKeys: number,
  ) {}
  private current(b: { tokens: number; updated: number }, t: number): number {
    return Math.min(this.burst, b.tokens + (t - b.updated) * this.perMs);
  }
  /** The key's bucket, refilled to `t` (a new key's is full). */
  refill(key: string, t: number): { tokens: number; updated: number } {
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.maxKeys) this.evict(t);
      b = { tokens: this.burst, updated: t };
      this.map.set(key, b);
    }
    b.tokens = this.current(b, t);
    b.updated = t;
    return b;
  }
  /** Seconds until `key` has a token again (0 when it has one, or none was taken). */
  wait(key: string, t: number): number {
    const b = this.map.get(key);
    if (!b) return 0;
    const tokens = this.current(b, t);
    return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / this.perMs / 1000);
  }
  /**
   * Room for a new key, losing no caller's debt (audit round 2, n04): the buckets full again go first — one that comes back
   * gets what it had — then the fullest. The oldest insertion had gone, an active caller drained to nothing, and came back
   * with a full burst; and a bucket idle a minute had gone at any level.
   */
  private evict(t: number): void {
    for (const [k, b] of this.map) if (this.current(b, t) >= this.burst) this.map.delete(k);
    if (this.map.size < this.maxKeys) return;
    let fullest: string | null = null;
    let most = -1;
    for (const [k, b] of this.map) {
      const tokens = this.current(b, t);
      if (tokens > most) {
        most = tokens;
        fullest = k;
      }
    }
    if (fullest !== null) this.map.delete(fullest);
  }
  get size(): number {
    return this.map.size;
  }
}

export class RateLimiter {
  private readonly own: Buckets;
  private readonly all: Buckets | null;
  private readonly wider: { of: (key: string) => string | null; factor: number } | null;
  private readonly now: () => number;
  constructor(o: RateLimiterOptions) {
    if (!(o.perMinute > 0)) throw new Error("perMinute must be positive");
    const perMs = o.perMinute / 60_000;
    const burst = o.burst ?? o.perMinute;
    const maxKeys = o.maxKeys ?? 10_000;
    this.now = o.now ?? (() => Date.now());
    this.own = new Buckets(perMs, burst, maxKeys);
    this.wider = o.wider === undefined ? { of: widerOf, factor: 16 } : o.wider;
    this.all = this.wider ? new Buckets(perMs * this.wider.factor, burst * this.wider.factor, maxKeys) : null;
  }
  /** Take one token for `key`, and one of its wider allocation's; false when the caller must wait. */
  allow(key: string): boolean {
    const t = this.now();
    const own = this.own.refill(key, t);
    const wide = this.wider?.of(key) ?? null;
    const all = wide !== null && this.all ? this.all.refill(wide, t) : null;
    if (own.tokens < 1 || (all && all.tokens < 1)) return false;
    own.tokens -= 1;
    if (all) all.tokens -= 1;
    return true;
  }
  /** Seconds until `key` has a token again (0 when it has one). */
  retryAfterSeconds(key: string): number {
    const t = this.now();
    const wide = this.wider?.of(key) ?? null;
    return Math.max(this.own.wait(key, t), wide !== null && this.all ? this.all.wait(wide, t) : 0);
  }
  get size(): number {
    return this.own.size;
  }
}
