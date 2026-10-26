// The browser wallets this page can see (spec v3.0 §7.5): EIP-6963 announcements first, the legacy injected provider as
// a fallback — the only module that touches window.ethereum (the lint keeps it so). Nothing is connected here; the
// providers are handed to connection.ts.
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface WalletInfo {
  /** the reverse-DNS id of an announced wallet, "injected" for the legacy provider */
  id: string;
  name: string;
  icon?: string;
}

export interface DiscoveredWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

interface AnnounceDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

/** Listens for EIP-6963 announcements for `waitMs`, then adds the legacy provider when nothing announced it. */
export function discoverWallets(waitMs = 300): Promise<DiscoveredWallet[]> {
  if (typeof window === "undefined") return Promise.resolve([]);
  const found = new Map<string, DiscoveredWallet>();
  const onAnnounce = (e: Event) => {
    const detail = (e as CustomEvent<AnnounceDetail>).detail;
    if (!detail?.info?.rdns || !detail.provider) return;
    found.set(detail.info.rdns, { info: { id: detail.info.rdns, name: detail.info.name, icon: detail.info.icon }, provider: detail.provider });
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return new Promise((resolve) => {
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const legacy = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      if (legacy && found.size === 0) found.set("injected", { info: { id: "injected", name: "Browser wallet" }, provider: legacy });
      resolve([...found.values()]);
    }, waitMs);
  });
}
