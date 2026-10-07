// Wallet-wide settings. In memory, mirrored into the encrypted journal while the wallet is unlocked.
import { useSyncExternalStore } from "react";
import { DEFAULT_RELAYER_URL } from "../sdk/relayer";

/** Private by default: a relayer submits and is paid by a private fee note; the connected wallet is the public fallback. */
export type Submission = { kind: "relayer"; url: string } | { kind: "wallet" };

export interface Settings {
  submission: Submission;
  /** plan §76–§77: the default screens hide Merkle / nullifier / proof / relayer detail; advanced users switch it on */
  advanced: boolean;
}

export const DEFAULT_SETTINGS: Settings = { submission: { kind: "relayer", url: DEFAULT_RELAYER_URL }, advanced: false };

class SettingsStore {
  private state: Settings = DEFAULT_SETTINGS;
  private listeners = new Set<() => void>();
  get(): Settings { return this.state; }
  set(patch: Partial<Settings>): void {
    this.state = { ...this.state, ...patch };
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
