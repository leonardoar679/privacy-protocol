// Wallet-wide settings. In memory, mirrored into the encrypted journal while the wallet is unlocked.
import { TIER_DEFAULTS, checkThresholds, fillThresholds, type TierThresholds } from "@privacy-wallet/protocol/wallet/valuation";
import { defaultRelayerUrl } from "../relayer";
import type { ProtectionMode, Sizing } from "@privacy-wallet/protocol/wallet/campaign";
import { EXPOSURE_POLICY } from "@privacy-wallet/protocol/wallet/exposurePolicy";

/** Private by default: a relayer submits and is paid by a private fee note; the connected wallet is the public fallback. */
export type Submission = { kind: "relayer"; url: string } | { kind: "wallet" };
/** The saved trade preference (whale spec §4, plan V2 §97, §109): the policy is derived from it and the tier; never written on chain. */
export type Preference = "balanced" | "best-privacy" | "best-price" | "fastest" | "native";
export const PREFERENCES: readonly Preference[] = ["balanced", "best-privacy", "best-price", "fastest", "native"];

export interface Settings {
  submission: Submission;
  /** plan §76–§77: the default screens hide Merkle / nullifier / proof / relayer detail; advanced users switch it on */
  advanced: boolean;
  /** plan §38: check every synced tree against the pool root an Ethereum light client proves (on chains it serves) */
  verifyReads: boolean;
  /** whale spec §13: the USD thresholds of the value tiers (plan V2 §13: configurable) */
  tiers: TierThresholds;
  /** whale spec §4: the default is balanced; privacy-execution applies from the high-value tier */
  preference: Preference;
  /** whale spec §25 / Stage 8: note housekeeping (split / merge / rebalance as private self-transfers), bounded by a daily fee cap in wei of ETH */
  housekeeping: { enabled: boolean; dailyFeeCapWei: string };
  /** whale spec §24 / Stage 6: the WebAuthn second factor above the high-value-secondary threshold */
  secondFactor: { enabled: boolean; credentialId?: string };
  /** High-Value Protection spec §14: how a large order is protected (tranches under an in-flight cap) */
  protection: ProtectionSettings;
}

export type { ProtectionMode };
export const PROTECTION_MODES: readonly ProtectionMode[] = ["balanced", "max-privacy", "max-safety", "best-execution"];
export interface ProtectionSettings {
  mode: ProtectionMode;
  /** the in-flight cap the user chose, bps of the order, inside CAP_BPS_RANGE; absent: the mode's default (3 % only where the risk engine permits, §14) */
  capBps?: number;
  /** the global switch "Pause large operations" (plan V3 §59): every campaign's automation pauses; the protocol never does */
  pauseLargeOperations: boolean;
  /** a route change below the high-value-secondary tier is adopted without a new Review (§8) */
  autoReroute: boolean;
  /** in-app always; the browser Notification API only when enabled and the tab is hidden; generic text unless amounts are allowed (plan V3 §145–§146) */
  notifications: { inApp: boolean; system: boolean; generic: boolean };
  /** institutional: the second factor on a separate device (a WebAuthn cross-platform credential, §14) */
  secondDevice: { enabled: boolean; credentialId?: string };
  // V4 (contract §2; plan §62, §92, §127–§128)
  /** the protection layer itself; turning it off is deliberate and warned (a large order then runs as one execution) */
  enabled: boolean;
  /** $100K–$1M: run every order as a protected execution (the plan's "Protected" row), not only a staged one */
  protectFromEnhanced: boolean;
  /** the share of the order one provider may carry when two or more venues quote the size, bps (the service recommends 30 %) */
  providerShareCapBps?: number;
  /** the velocity limit: hand-overs in any trailing 24 h, USD; absent: none */
  velocity?: { maxUsdPer24h: number };
  /** when the first-time explanation of protected execution was shown (plan §127) */
  introSeenAt?: number;
}
/** The exposure fraction the user may choose, bps (plan V3 §72, §74; V4 contract §2.1: 1–5 %, the band and the route set the ceiling at order time). */
export const CAP_BPS_RANGE: [number, number] = [100, 500];
/** The range the value band allows (contract §2.1): the enhanced row below $1M, the band's row above. */
export const capRangeFor = (tier: "standard" | "enhanced" | "high-value" | "high-value-secondary" | "institutional"): [number, number] => EXPOSURE_POLICY[tier].range ?? EXPOSURE_POLICY.enhanced.range!;
/** What each mode means, lab-calibrated in Stage 2 (benchmarks/whale/campaign.md) and mirrored by the service's recommendation. */
export const PROTECTION_DEFAULTS: Record<ProtectionMode, { capBps: number; sizing: Sizing; cadenceSeconds: [number, number]; label: string; words: string }> = {
  balanced: { capBps: 250, sizing: "varied", cadenceSeconds: [600, 5400], label: "Balanced", words: "At most 2.5 % of the order is exposed at a time; pieces of varied common sizes, a random 10 min – 1.5 h between them; the recommended default." },
  "max-privacy": { capBps: 250, sizing: "bucket", cadenceSeconds: [1800, 21600], label: "Maximum privacy", words: "Every piece the same common size, a random 30 min – 6 h between them: the slowest and the hardest to read." },
  "max-safety": { capBps: 100, sizing: "varied", cadenceSeconds: [600, 3600], label: "Maximum safety", words: "At most 1 % exposed, one piece at a time, every piece final at the destination before the next starts." },
  "best-execution": { capBps: 250, sizing: "varied", cadenceSeconds: [600, 3600], label: "Best execution", words: "The same exposure as Balanced; routes scored for net output first, pieces released in parallel where the route allows, the shortest pauses between them." },
};
export const DEFAULT_PROTECTION: ProtectionSettings = { mode: "balanced", pauseLargeOperations: false, autoReroute: false, notifications: { inApp: true, system: false, generic: true }, secondDevice: { enabled: false }, enabled: true, protectFromEnhanced: false };

/** The defaults, built at the moment of use: the configured relayer is known only after configure() (V6 Stage 3). */
export const defaultSettings = (): Settings => ({
  submission: { kind: "relayer", url: defaultRelayerUrl() }, advanced: false, verifyReads: true,
  tiers: { ...TIER_DEFAULTS }, preference: "balanced", housekeeping: { enabled: true, dailyFeeCapWei: (5n * 10n ** 15n).toString() }, secondFactor: { enabled: false },
  protection: { ...DEFAULT_PROTECTION, notifications: { ...DEFAULT_PROTECTION.notifications }, secondDevice: { ...DEFAULT_PROTECTION.secondDevice } },
});

/** A journal written by an earlier wallet lacks the newer fields: fill them with the defaults (and refuse nonsense thresholds). */
export function healSettings(stored: Partial<Settings> | undefined): Settings {
  const defaults = defaultSettings();
  const s: Settings = { ...defaults, ...(stored ?? {}) };
  // V5: the two consumer bands are filled under a stored V2–V4 object's `enhanced` (fillThresholds), never reset over it
  const { large: _l, largeProtected: _lp, ...v4Defaults } = TIER_DEFAULTS;
  s.tiers = fillThresholds({ ...v4Defaults, ...(stored?.tiers ?? {}) });
  try { checkThresholds(s.tiers); } catch { s.tiers = { ...TIER_DEFAULTS }; }
  if (!PREFERENCES.includes(s.preference)) s.preference = "balanced";
  s.housekeeping = { ...defaults.housekeeping, ...(stored?.housekeeping ?? {}) };
  s.secondFactor = { ...defaults.secondFactor, ...(stored?.secondFactor ?? {}) };
  s.protection = healProtection(stored?.protection);
  return s;
}

/** The protection settings of a V2 journal (none) or a tampered one: the mode must be one of the three, the cap inside its range, the switches booleans. */
export function healProtection(p: Partial<ProtectionSettings> | undefined): ProtectionSettings {
  const mode: ProtectionMode = PROTECTION_MODES.includes(p?.mode as ProtectionMode) ? (p!.mode as ProtectionMode) : "balanced";
  const cap = p?.capBps !== undefined && Number.isInteger(p.capBps) && p.capBps >= CAP_BPS_RANGE[0] && p.capBps <= CAP_BPS_RANGE[1] ? p.capBps : undefined;
  const n = { ...DEFAULT_PROTECTION.notifications, ...(p?.notifications ?? {}) };
  const d = { ...DEFAULT_PROTECTION.secondDevice, ...(p?.secondDevice ?? {}) };
  const share = p?.providerShareCapBps !== undefined && Number.isInteger(p.providerShareCapBps) && p.providerShareCapBps >= 1000 && p.providerShareCapBps <= 10000 ? p.providerShareCapBps : undefined;
  const velocity = p?.velocity && typeof p.velocity === "object" && Number.isFinite(p.velocity.maxUsdPer24h) && p.velocity.maxUsdPer24h > 0 ? { maxUsdPer24h: p.velocity.maxUsdPer24h } : undefined;
  return {
    mode, ...(cap !== undefined ? { capBps: cap } : {}),
    pauseLargeOperations: p?.pauseLargeOperations === true, autoReroute: p?.autoReroute === true,
    notifications: { inApp: n.inApp !== false, system: n.system === true, generic: n.generic !== false },
    secondDevice: { enabled: d.enabled === true, ...(typeof d.credentialId === "string" ? { credentialId: d.credentialId } : {}) },
    enabled: p?.enabled !== false, protectFromEnhanced: p?.protectFromEnhanced === true,
    ...(share !== undefined ? { providerShareCapBps: share } : {}), ...(velocity ? { velocity } : {}),
    ...(typeof p?.introSeenAt === "number" && Number.isFinite(p.introSeenAt) ? { introSeenAt: p.introSeenAt } : {}),
  };
}

class SettingsStore {
  private state: Settings | null = null;
  private listeners = new Set<() => void>();
  // created on first read, then stable between changes (useSyncExternalStore needs the same object)
  get(): Settings { return (this.state ??= defaultSettings()); }
  set(patch: Partial<Settings>): void {
    this.state = healSettings({ ...this.get(), ...patch });
    for (const l of this.listeners) l();
  }
  reset(): void { this.set(defaultSettings()); }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const settings = new SettingsStore();
