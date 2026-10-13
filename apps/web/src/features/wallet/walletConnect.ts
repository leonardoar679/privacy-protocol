// WalletConnect (spec §7; plan §11): loaded only when the user taps it and only when a project id is configured
// (VITE_WC_PROJECT_ID). Its relay sees the session's metadata and the IPs of both ends — said on the "What stays
// private" screen (spec §3.13), not mitigated here. The connector is an EIP-1193 provider like the others.
import type { Eip1193Provider } from "../../sdk/injected";
import { config } from "../../sdk/config";

/** WalletConnect's project id from the configuration (V6 Stage 3): the connector exists only with one. */
export const walletConnectProjectId = (): string | undefined => config().walletConnectProjectId;
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

/** Tests: forget the cached provider. */
export function resetWalletConnect(): void { cached = null; }
