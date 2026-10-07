// Provider health and the security incident feed (spec §9, plan §25).
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

/** Known incidents that must feed route health (plan §15, §25). Extend as events happen. */
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

/** Reliability from live health (0–100). */
export function reliabilityScore(h: Health): number {
  if (!h.reachable) return 0;
  let s = 100;
  if (h.halted) s -= 60;
  if (h.apiLatencyMs > 2000) s -= 15;
  else if (h.apiLatencyMs > 800) s -= 5;
  return Math.max(0, s);
}
