// The EIP-1193 provider Private AI's credit is funded through (docs/zkapi-integration-spec.md §4, §6): a fresh wallet-derived
// account, or the connected wallet — the provider the connection chose, EIP-6963 or WalletConnect (audit round 2, n56: the
// SDK had been handed none and read window.ethereum, another wallet than the one connected, or none with WalletConnect).
import { activeProvider, type Eip1193Provider } from "@privacy-wallet/wallet-engine/injected";
import type { FreshAccountProvider } from "./freshAccountProvider";

export type FundingMode = "fresh" | "connected";

export function creditWalletProvider(mode: FundingMode, fresh: () => FreshAccountProvider): FreshAccountProvider | Eip1193Provider | null {
  return mode === "fresh" ? fresh() : activeProvider();
}
