// Provider health, the security incident feed (spec §9, plan §25) and, V2, the failure history and
// circuit breaker of whale spec §16.
import { readFileSync } from "fs";
import type { Health, ProviderId } from "./types";

export interface Incident {
  provider: ProviderId;
  date: string; // ISO
  title: string;
  lossUsd: number;
  class: "key-compromise" | "bridge" | "solver" | "api" | "liquidity";
  /** how long the incident keeps depressing the security score, in days (decays linearly) */
  halfLifeDays: number;
  source: string;
}

/** An operator's own incident file (INCIDENTS_FILE: a JSON array of Incident); a missing or malformed file adds nothing. */
function incidentsFromFile(path: string | undefined): Incident[] {
  if (!path) return [];
  try {
    const list = JSON.parse(readFileSync(path, "utf8")) as Incident[];
    return Array.isArray(list) ? list.filter((i) => i && typeof i.provider === "string" && typeof i.date === "string" && typeof i.halfLifeDays === "number" && typeof i.class === "string") : [];
  } catch {
    return [];
  }
}

/** Known incidents that must feed route health (plan §15, §25). Extend as events happen (in code, or through INCIDENTS_FILE). */
export const INCIDENTS: Incident[] = [
  {
    provider: "thorchain",
    date: "2026-05-15",
    title: "GG20 TSS vault key reconstructed by a malicious node; ~$10.7M drained from an Asgard vault; 5-week trading pause",
    lossUsd: 10_700_000,
    class: "key-compromise",
    halfLifeDays: 365,
    source: "https://www.quillaudits.com/blog/hack-analysis/thorchain-gg20-hack",
  },
  ...incidentsFromFile(process.env.INCIDENTS_FILE),
];

/** Static baseline security scores (0–100) by provider class, before incidents and live health. */
export const BASELINE_SECURITY: Record<ProviderId, number> = {
  thorchain: 84, // TSS vault network, native assets, no wrapping
  chainflip: 88, // MPC validator network, native assets
  mayan: 89, // intent/auction execution; settlement via Wormhole/Swift
  "near-intents": 85, // solver network; cross-chain settlement
  lifi: 86, // aggregator over bridges (inherits the chosen bridge's risk)
  "uniswap-across": 90, // optimistic bridge (Across) + Uniswap routing, EVM only
};

/** Static privacy score of the provider path itself (what the provider learns), 0–100. */
export const BASELINE_PRIVACY: Record<ProviderId, number> = {
  thorchain: 91, // deposit-address flow, no account, memo-only
  chainflip: 90, // deposit channels, no account
  mayan: 88, // signed intents from the source address
  "near-intents": 84, // solver network sees the intent
  lifi: 85, // API sees from/to addresses and the route
  "uniswap-across": 86,
};

export function securityScore(provider: ProviderId, now = Date.now()): number {
  let s = BASELINE_SECURITY[provider];
  for (const inc of INCIDENTS) {
    if (inc.provider !== provider) continue;
    const ageDays = (now - Date.parse(inc.date)) / 86_400_000;
    if (ageDays < 0) continue;
    const weight = Math.max(0, 1 - ageDays / inc.halfLifeDays); // linear decay to 0 after halfLifeDays
    const penalty = inc.class === "key-compromise" ? 25 : inc.class === "bridge" ? 20 : 10;
    s -= penalty * weight;
  }
  return Math.max(0, Math.round(s));
}

/** THORChain writes chain codes (ETH, BTC), Chainflip lowercase names (ethereum): a halt on either form of the order's chains counts. */
const CHAIN_CODE: Record<string, string> = { ethereum: "ETH", bitcoin: "BTC", solana: "SOL", base: "BASE", avalanche: "AVAX", bsc: "BSC", litecoin: "LTC", doge: "DOGE", tron: "TRON", arbitrum: "ARB", optimism: "OP", polygon: "POL" };
export function chainHalted(h: Pick<Health, "haltedChains">, chains: string[]): string | null {
  for (const c of chains) {
    const code = CHAIN_CODE[c.toLowerCase()] ?? c.toUpperCase();
    if (h.haltedChains.some((x) => x.toLowerCase() === c.toLowerCase() || x.toUpperCase() === code)) return c;
  }
  return null;
}

/** Reliability from live health (0–100): reachable, halted, latency; V2 adds the order's chains and the failure history (whale spec §16). */
export function reliabilityScore(h: Health, chains: string[] = []): number {
  if (!h.reachable) return 0;
  let s = 100;
  if (h.halted) s -= 60;
  if (h.apiLatencyMs > 2000) s -= 15;
  else if (h.apiLatencyMs > 800) s -= 5;
  if (chainHalted(h, chains)) s -= 10;
  s -= 10 * Math.min(3, h.failures?.windowCount ?? 0);
  return Math.max(0, s);
}

/**
 * The service's memory of each provider (whale spec §16): quote failures and timeouts in a rolling window,
 * a circuit breaker that skips a provider for a while after consecutive failures (any success closes it),
 * and a short health cache so a competition does not re-ask every provider's health.
 */
export class ProviderHealthTracker {
  private records = new Map<ProviderId, { consecutive: number; lastAt?: number; stamps: number[]; openedAt?: number }>();
  private cache = new Map<ProviderId, { at: number; health: Health }>();
  constructor(readonly opts: { windowMs: number; breakerAfter: number; breakerMs: number; cacheMs: number } = { windowMs: 3_600_000, breakerAfter: 3, breakerMs: 300_000, cacheMs: 30_000 }) {}
  private rec(p: ProviderId) {
    let r = this.records.get(p);
    if (!r) { r = { consecutive: 0, stamps: [] }; this.records.set(p, r); }
    return r;
  }
  recordSuccess(p: ProviderId): void {
    const r = this.rec(p);
    r.consecutive = 0; r.openedAt = undefined;
  }
  /** A failure is an outage-like answer (a timeout, a network error, a 5xx); a provider that answers "no" for this size is not one. */
  recordFailure(p: ProviderId, now = Date.now()): void {
    const r = this.rec(p);
    r.consecutive++; r.lastAt = now; r.stamps.push(now);
    r.stamps = r.stamps.filter((t) => now - t < this.opts.windowMs);
    if (r.consecutive >= this.opts.breakerAfter) r.openedAt = now;
  }
  failures(p: ProviderId, now = Date.now()): NonNullable<Health["failures"]> {
    const r = this.rec(p);
    r.stamps = r.stamps.filter((t) => now - t < this.opts.windowMs);
    return { consecutive: r.consecutive, lastAt: r.lastAt, windowCount: r.stamps.length };
  }
  /** The reason the provider is skipped right now, or null; an expired breaker closes half-open (one attempt allowed). */
  breakerOpen(p: ProviderId, now = Date.now()): string | null {
    const r = this.rec(p);
    if (r.openedAt === undefined) return null;
    const left = this.opts.breakerMs - (now - r.openedAt);
    if (left > 0) return `skipped after ${r.consecutive} consecutive failures (${Math.ceil(left / 1000)} s left)`;
    r.openedAt = undefined; r.consecutive = 0;
    return null;
  }
  cachedHealth(p: ProviderId, now = Date.now()): Health | null {
    const c = this.cache.get(p);
    return c && now - c.at < this.opts.cacheMs ? { ...c.health, failures: this.failures(p, now) } : null;
  }
  rememberHealth(p: ProviderId, h: Health, now = Date.now()): Health {
    this.cache.set(p, { at: now, health: h });
    return { ...h, failures: this.failures(p, now) };
  }
}
