// WalletConnect (spec §7; plan §11): loaded only when the user taps it and only when a project id is configured
// (VITE_WC_PROJECT_ID). Its relay sees the session's metadata and the IPs of both ends — said on the "What stays
// private" screen (spec §3.13), not mitigated here. The connector is an EIP-1193 provider like the others.
import type { Eip1193Provider } from "./injected";

let projectId: string | undefined;
/** The platform sets WalletConnect's project id (apps/web/src/config.ts applyConfig): the connector exists only with one. */
export function configureWalletConnect(id: string | undefined): void {
  projectId = id;
}
export const walletConnectProjectId = (): string | undefined => projectId;
export const walletConnectAvailable = (): boolean => !!walletConnectProjectId();

interface WcProvider extends Eip1193Provider { disconnect(): Promise<void> }

let cached: WcProvider | null = null;

export async function walletConnectProvider(chainId: number): Promise<WcProvider | null> {
  const projectId = walletConnectProjectId();
  if (!projectId) return null;
  if (cached) return cached;
  const mod = await import("@walletconnect/ethereum-provider");
  const provider = await mod.EthereumProvider.init({
    projectId,
    chains: [chainId],
    showQrModal: true,
    metadata: { name: "Privacy Wallet", description: "A private wallet", url: typeof location === "undefined" ? "https://localhost" : location.origin, icons: [] },
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
}

/** Tests: forget the cached provider. */
export function resetWalletConnect(): void { cached = null; }
