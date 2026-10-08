// Provider health, the security incident feed (spec §9, plan §25), the failure history and circuit breaker of whale
// spec §16, and (V3, High-Value Protection spec §10) the risk database as the source of incidents, the security score
// as a breakdown with separate fields, an operator incident file reloaded on an interval, and the breaker's new
// triggers: a failure-rate spike, settlement stalls, quote divergence, a fresh incident — with a real half-open probe.
import { readFileSync } from "fs";
import type { Health, ProviderId } from "./types";
import { riskDb, type Incident } from "./risk/riskDb";
import { securityBreakdown } from "./risk/security";

/** An operator's own incident file (INCIDENTS_FILE: a JSON array of Incident), re-read at most every INCIDENTS_RELOAD_MS; a missing or malformed file adds nothing. */
export const INCIDENTS_RELOAD_MS = 60_000;
let fileCache: { at: number; path: string | undefined; list: Incident[] } = { at: -Infinity, path: undefined, list: [] };
export function fileIncidents(now = Date.now(), path: string | undefined = process.env.INCIDENTS_FILE): Incident[] {
  if (fileCache.path === path && now - fileCache.at < INCIDENTS_RELOAD_MS) return fileCache.list;
  let list: Incident[] = [];
  if (path) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Incident[];
      list = Array.isArray(raw) ? raw.filter((i) => i && typeof i.provider === "string" && typeof i.date === "string" && typeof i.halfLifeDays === "number" && typeof i.class === "string") : [];
    } catch { list = []; }
  }
  fileCache = { at: now, path, list };
  return list;
}

/** Every incident that feeds route health right now: the risk database's security events plus the operator file (plan §15, §25; V3 §10). */
export function incidents(now = Date.now()): Incident[] {
  const seen = new Set<string>();
  return [...riskDb().incidents(), ...fileIncidents(now)].filter((i) => { const k = `${i.provider}|${i.date}|${i.title}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
/** The feed as it was at import (kept for callers that read a list; `incidents()` is live). */
export const INCIDENTS: Incident[] = incidents();

/** Static baseline security scores (0–100) by provider class — the custody and bridge model — before incidents, the database's fields and live health. */
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

/** The security score with separate fields (V3 §10): the baseline, the decaying incidents, and what the risk database states. */
export function securityScore(provider: ProviderId, now = Date.now()): number {
  return securityBreakdown(provider, now, riskDb(), fileIncidents(now)).total;
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

export interface TrackerOptions {
  windowMs: number;
  /** consecutive failures that open the breaker */
  breakerAfter: number;
  breakerMs: number;
  cacheMs: number;
  /** V3 §10: failures in the window that open it as a rate spike */
  spikeAfter: number;
  /** settlement stalls in the window that open it */
  stallsAfter: number;
  /** quote divergences (the price guard's refusals) in the window that open it */
  divergencesAfter: number;
  /** an incident younger than this opens it */
  incidentMs: number;
}
export const TRACKER_DEFAULTS: TrackerOptions = { windowMs: 3_600_000, breakerAfter: 3, breakerMs: 300_000, cacheMs: 30_000, spikeAfter: 6, stallsAfter: 2, divergencesAfter: 3, incidentMs: 86_400_000 };

interface Record_ { consecutive: number; lastAt?: number; stamps: number[]; stalls: { at: number; key: string }[]; divergences: number[]; incidentAt?: number; openedAt?: number; openReason?: string; probe?: boolean }

/**
 * The service's memory of each provider (whale spec §16; V3 §10): quote failures and timeouts in a rolling window,
 * settlement stalls and quote divergences the routes report, the latest incident, a circuit breaker that skips the
 * provider for a while after consecutive failures, a failure-rate spike, repeated stalls or divergences, or a fresh
 * incident (any success closes it; after it expires one probe is allowed and a failure during the probe reopens it),
 * and a short health cache so a competition does not re-ask every provider's health.
 */
export class ProviderHealthTracker {
  readonly opts: TrackerOptions;
  private records = new Map<ProviderId, Record_>();
  private cache = new Map<ProviderId, { at: number; health: Health }>();
  constructor(opts: Partial<TrackerOptions> = {}) { this.opts = { ...TRACKER_DEFAULTS, ...opts }; }
  private rec(p: ProviderId): Record_ {
    let r = this.records.get(p);
    if (!r) { r = { consecutive: 0, stamps: [], stalls: [], divergences: [] }; this.records.set(p, r); }
    return r;
  }
  private prune(r: Record_, now: number): void {
    const keep = (t: number) => now - t < this.opts.windowMs;
    r.stamps = r.stamps.filter(keep); r.stalls = r.stalls.filter((s) => keep(s.at)); r.divergences = r.divergences.filter(keep);
  }
  private open(r: Record_, now: number, reason: string): void { r.openedAt = now; r.openReason = reason; r.probe = false; }
  recordSuccess(p: ProviderId): void {
    const r = this.rec(p);
    r.consecutive = 0; r.openedAt = undefined; r.openReason = undefined; r.probe = false;
  }
  /** A failure is an outage-like answer (a timeout, a network error, a 5xx); a provider that answers "no" for this size is not one. */
  recordFailure(p: ProviderId, now = Date.now()): void {
    const r = this.rec(p);
    r.consecutive++; r.lastAt = now; r.stamps.push(now);
    this.prune(r, now);
    if (r.probe) { this.open(r, now, "failed its probe after a breaker"); return; }
    if (r.consecutive >= this.opts.breakerAfter) this.open(r, now, `${r.consecutive} consecutive failures`);
    else if (r.stamps.length >= this.opts.spikeAfter) this.open(r, now, `${r.stamps.length} failures in the last hour`);
  }
  /** A tracked execution older than its plan allows and still unfinished (found by a /track read, V3 §10); `key` names the execution so a wallet polling it counts it once. */
  recordSettlementStall(p: ProviderId, key: string, now = Date.now()): boolean {
    const r = this.rec(p);
    this.prune(r, now);
    if (r.stalls.some((s) => s.key === key)) return false;
    r.stalls.push({ at: now, key });
    if (r.stalls.length >= this.opts.stallsAfter) this.open(r, now, `${r.stalls.length} settlement stalls in the last hour`);
    return true;
  }
  /** The price guard refused this provider's hard quote (its gap to the best alternative). */
  recordQuoteDivergence(p: ProviderId, gapBps: number, now = Date.now()): void {
    const r = this.rec(p);
    r.divergences.push(now); this.prune(r, now);
    if (r.divergences.length >= this.opts.divergencesAfter) this.open(r, now, `${r.divergences.length} hard quotes far below the alternatives (last ${gapBps} bps)`);
  }
  /** A security incident on the feed; a fresh one opens the breaker. */
  recordIncident(p: ProviderId, dateMs: number, now = Date.now()): void {
    const r = this.rec(p);
    if (r.incidentAt === undefined || dateMs > r.incidentAt) r.incidentAt = dateMs;
    if (now - dateMs < this.opts.incidentMs && dateMs <= now) this.open(r, now, "a security incident reported in the last 24 hours");
  }
  failures(p: ProviderId, now = Date.now()): NonNullable<Health["failures"]> {
    const r = this.rec(p);
    this.prune(r, now);
    return { consecutive: r.consecutive, lastAt: r.lastAt, windowCount: r.stamps.length };
  }
  /** The reason the provider is skipped right now, or null; an expired breaker closes half-open: one probe is allowed, and a failure during it reopens. */
  breakerOpen(p: ProviderId, now = Date.now()): string | null {
    const r = this.rec(p);
    if (r.openedAt === undefined) return null;
    const left = this.opts.breakerMs - (now - r.openedAt);
    if (left > 0) return `skipped after ${r.openReason ?? `${r.consecutive} consecutive failures`} (${Math.ceil(left / 1000)} s left)`;
    r.openedAt = undefined; r.openReason = undefined; r.probe = true; r.consecutive = 0;
    return null;
  }
  /** What the breaker knows, for GET /risk/:provider. */
  state(p: ProviderId, now = Date.now()): { open: string | null; failures: NonNullable<Health["failures"]>; stalls: number; divergences: number; probe: boolean; lastIncidentAt: number | null } {
    const r = this.rec(p);
    this.prune(r, now);
    return { open: this.breakerOpen(p, now), failures: this.failures(p, now), stalls: r.stalls.length, divergences: r.divergences.length, probe: !!r.probe, lastIncidentAt: r.incidentAt ?? null };
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
