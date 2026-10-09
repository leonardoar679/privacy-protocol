// The public wallet's connection (spec §7): the only module that reads the injected provider. Stage 3 keeps the
// V1.1 path — the injected provider and eth_requestAccounts — behind a store the screens subscribe to; Stage 4
// adds EIP-6963 discovery, the chain check, the listeners and the lazy WalletConnect connector.
import { useSyncExternalStore } from "react";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "unavailable";
export interface ConnectionState { status: ConnectionStatus; account: string | null }

interface Eip1193 { request(args: { method: string; params?: unknown[] }): Promise<unknown> }

let state: ConnectionState = { status: "disconnected", account: null };
const listeners = new Set<() => void>();
const set = (next: ConnectionState) => { state = next; for (const l of listeners) l(); };

function injected(): Eip1193 | null {
  const w = typeof window === "undefined" ? null : (window as unknown as { ethereum?: Eip1193 });
  return w?.ethereum ?? null;
}

export const connection = {
  get: (): ConnectionState => state,
  subscribe: (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  /** Asks the injected wallet for its accounts; "unavailable" when the browser has none. Never throws. */
  async connect(): Promise<ConnectionState> {
    const eth = injected();
    if (!eth) { set({ status: "unavailable", account: null }); return state; }
    set({ status: "connecting", account: state.account });
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[] | undefined;
      const account = accounts?.[0] ?? null;
      set({ status: account ? "connected" : "disconnected", account });
    } catch {
      set({ status: "disconnected", account: null });
    }
    return state;
  },
  reset(): void { set({ status: "disconnected", account: null }); },
};

export const useConnection = (): ConnectionState => useSyncExternalStore(connection.subscribe, connection.get, connection.get);
export const useAccount = (): string | null => useConnection().account;
/** `0x7A…91F2` (spec §1). */
export const shortAccount = (account: string): string => `${account.slice(0, 4)}…${account.slice(-4)}`;
