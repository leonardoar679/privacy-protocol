// WalletConnect (spec §7; plan §11): loaded only when the user taps it and only when a project id is configured
// (VITE_WC_PROJECT_ID). Its relay sees the session's metadata and the IPs of both ends — said on the "What stays
// private" screen (spec §3.13), not mitigated here. The connector is an EIP-1193 provider like the others.
import type { Eip1193Provider } from "../../sdk/injected";

const env: Record<string, string | undefined> = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {});
export const WC_PROJECT_ID: string | undefined = env.VITE_WC_PROJECT_ID;
export const walletConnectAvailable = (): boolean => !!WC_PROJECT_ID;

interface WcProvider extends Eip1193Provider { disconnect(): Promise<void> }

let cached: WcProvider | null = null;

export async function walletConnectProvider(chainId: number): Promise<WcProvider | null> {
  if (!WC_PROJECT_ID) return null;
  if (cached) return cached;
  const mod = await import("@walletconnect/ethereum-provider");
  const provider = await mod.EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [chainId],
    showQrModal: true,
    metadata: { name: "Privacy Wallet", description: "A private wallet", url: typeof location === "undefined" ? "https://localhost" : location.origin, icons: [] },
  });
  cached = provider as unknown as WcProvider;
  return cached;
}

/** Tests: forget the cached provider. */
export function resetWalletConnect(): void { cached = null; }
