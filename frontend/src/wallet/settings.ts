// Wallet-wide settings. In memory, mirrored into the encrypted journal while the wallet is unlocked.
import { useSyncExternalStore } from "react";
import { TIER_DEFAULTS, checkThresholds, type TierThresholds } from "@ref/wallet/valuation";
import { DEFAULT_RELAYER_URL } from "../sdk/relayer";

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
}

export const DEFAULT_SETTINGS: Settings = {
  submission: { kind: "relayer", url: DEFAULT_RELAYER_URL }, advanced: false, verifyReads: true,
  tiers: { ...TIER_DEFAULTS }, preference: "balanced", housekeeping: { enabled: true, dailyFeeCapWei: (5n * 10n ** 15n).toString() }, secondFactor: { enabled: false },
};

/** A journal written by an earlier wallet lacks the newer fields: fill them with the defaults (and refuse nonsense thresholds). */
export function healSettings(stored: Partial<Settings> | undefined): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  s.tiers = { ...TIER_DEFAULTS, ...(stored?.tiers ?? {}) };
  try { checkThresholds(s.tiers); } catch { s.tiers = { ...TIER_DEFAULTS }; }
  if (!PREFERENCES.includes(s.preference)) s.preference = "balanced";
  s.housekeeping = { ...DEFAULT_SETTINGS.housekeeping, ...(stored?.housekeeping ?? {}) };
  s.secondFactor = { ...DEFAULT_SETTINGS.secondFactor, ...(stored?.secondFactor ?? {}) };
  return s;
}

class SettingsStore {
  private state: Settings = DEFAULT_SETTINGS;
  private listeners = new Set<() => void>();
  get(): Settings { return this.state; }
  set(patch: Partial<Settings>): void {
    this.state = healSettings({ ...this.state, ...patch });
    for (const l of this.listeners) l();
  }
  reset(): void { this.set(DEFAULT_SETTINGS); }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const settings = new SettingsStore();
export const useSettings = (): Settings => useSyncExternalStore((l) => settings.subscribe(l), () => settings.get());
