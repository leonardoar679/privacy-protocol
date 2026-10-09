// The active EIP-1193 provider (spec §7): the one the connection store selected (an EIP-6963 wallet, the injected
// one, WalletConnect), or the browser's injected provider when nothing was chosen yet — the single fallback the
// engine layer reads, so the lint's "window.ethereum only under features/wallet" rule has one documented exception.
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

let active: Eip1193Provider | null = null;

export function setActiveProvider(p: Eip1193Provider | null): void { active = p; }

export function injectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

/** The provider every engine call signs or reads through; null when the browser has none. */
export function activeProvider(): Eip1193Provider | null { return active ?? injectedProvider(); }
