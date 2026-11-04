// WalletConnect (spec §7; plan §11): loaded only when the user taps it — or, after a reload, when its own store holds a
// session to take up (the review round of 2026-11-02: never an idle socket to the relay for nothing) — and only when a
// project id is configured (VITE_WC_PROJECT_ID). Its relay sees the session's metadata and the IPs of both ends — said on
// the "What stays private" screen (spec §3.13), not mitigated here. The connector is an EIP-1193 provider like the others.
import type { Eip1193Provider } from "./injected";

let projectId: string | undefined;
/** The platform sets WalletConnect's project id (apps/web/src/config.ts applyConfig): the connector exists only with one. */
export function configureWalletConnect(id: string | undefined): void {
  projectId = id;
}
export const walletConnectProjectId = (): string | undefined => projectId;
export const walletConnectAvailable = (): boolean => !!walletConnectProjectId();

/**
 * WalletConnect's own session store holds a session this origin can take up: its sign client keeps a list under
 * `wc@2:client:<store version>//session` in localStorage. Nothing there (or no storage): nothing to initialize at a reload.
 */
export function hasWalletConnectSession(): boolean {
  try {
    const store = globalThis.localStorage;
    if (!store) return false;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key || !/^wc@2:client:[^/]*\/\/session$/.test(key)) continue;
      const list = JSON.parse(store.getItem(key) ?? "[]") as unknown;
      if (Array.isArray(list) && list.length) return true;
    }
  } catch {
    // no storage, or unreadable: nothing to take up
  }
  return false;
}

interface WcProvider extends Eip1193Provider { disconnect(): Promise<void> }

let cached: WcProvider | null = null;

export async function walletConnectProvider(chainId: number): Promise<WcProvider | null> {
  const projectId = walletConnectProjectId();
  if (!projectId) return null;
  if (cached) return cached;
  const mod = await import("@walletconnect/ethereum-provider");
  const origin = typeof location === "undefined" ? "https://localhost" : location.origin;
  const provider = await mod.EthereumProvider.init({
    projectId,
    chains: [chainId],
    showQrModal: true,
    metadata: {
      name: "Privacy Wallet",
      description: "A private wallet",
      url: origin,
      // V7 Stage 16 (spec v3.0 §9): the icon a wallet shows for this site, and where a phone's wallet app returns after signing
      icons: [`${origin}/icon.svg`],
      redirect: { universal: origin },
    },
  });
  cached = provider as unknown as WcProvider;
  return cached;
}

/**
 * Ends the WalletConnect session (2026-10-17, the audit's unverified m65): "Disconnect" had only forgotten the account,
 * the relay socket stayed open and the next WalletConnect connection reused the session. The provider is forgotten, so
 * the next connection is a new pairing. A session the wallet already ended is not an error.
 */
export async function endWalletConnect(): Promise<void> {
  const p = cached;
  cached = null;
  if (p) await p.disconnect().catch(() => {});
  clearWalletConnectStorage();
}

/**
 * WalletConnect's and AppKit's own localStorage entries — the session, the pairings, the keychain, the connected account's
 * record — gone with the session (the fourth review round, 2026-11-03): they stayed after a Disconnect, a link between the public
 * account and this origin's storage that the "localStorage holds nothing" rule did not count. Called by Disconnect and Forget.
 */
/** WalletConnect 2's own IndexedDB store (@walletconnect/keyvaluestorage): the pairing, the session with the account, the keychain. */
export const WALLET_CONNECT_DB = "WALLET_CONNECT_V2_INDEXED_DB";

export function clearWalletConnectStorage(): void {
  // its IndexedDB store too (the tenth review round, D-3): WalletConnect 2.26 moves every wc@ key there, and a Disconnect or a Forget that
  // cleared localStorage alone had left the session, its account and its keychain on the device
  try {
    const req = globalThis.indexedDB?.deleteDatabase(WALLET_CONNECT_DB);
    if (req) req.onerror = () => undefined;
  } catch {
    // no IndexedDB
  }
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && (/^wc@2:/.test(k) || /^(@appkit|@w3m|W3M_|WALLETCONNECT_|wagmi\.)/i.test(k) || /appkit/i.test(k))) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    // no storage, or unreadable: nothing to clear
  }
}

/** Tests: forget the cached provider. */
export function resetWalletConnect(): void { cached = null; }
