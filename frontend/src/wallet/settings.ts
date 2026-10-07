// Wallet-wide settings that change how private transactions reach the chain. In memory only.
import { useSyncExternalStore } from "react";
import { DEFAULT_RELAYER_URL } from "../sdk/relayer";

/** Private by default: a relayer submits and is paid by a private fee note; the connected wallet is the public fallback. */
export type Submission = { kind: "relayer"; url: string } | { kind: "wallet" };

interface Settings { submission: Submission }

class SettingsStore {
  private state: Settings = { submission: { kind: "relayer", url: DEFAULT_RELAYER_URL } };
  private listeners = new Set<() => void>();
  get(): Settings { return this.state; }
  set(patch: Partial<Settings>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const settings = new SettingsStore();
export const useSettings = (): Settings => useSyncExternalStore((l) => settings.subscribe(l), () => settings.get());
