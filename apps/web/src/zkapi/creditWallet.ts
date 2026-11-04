// The EIP-1193 provider Private AI's credit is funded through (docs/zkapi-integration-spec.md §4, §6): a fresh wallet-derived
// account, or the connected wallet — the provider the connection chose, EIP-6963 or WalletConnect (audit round 2, n56: the
// SDK had been handed none and read window.ethereum, another wallet than the one connected, or none with WalletConnect).
import { activeProvider, type Eip1193Provider } from "@privacy-wallet/wallet-engine/injected";
import type { FreshAccountProvider } from "./freshAccountProvider";

export type FundingMode = "fresh" | "connected";

export function creditWalletProvider(mode: FundingMode, fresh: () => FreshAccountProvider): FreshAccountProvider | Eip1193Provider | null {
  return mode === "fresh" ? fresh() : activeProvider();
}

type Requesting = { request(args: { method: string; params?: unknown }): Promise<unknown> };

/**
 * The provider the zkAPI SDK is handed, answering only while `live()` (the ninth review round, 2026-11-04, B-F2/F3): the session that enabled
 * Private AI still open. After a lock every request is refused, reads and signatures alike. The lock hook had handed the SDK `null` — which
 * the SDK reads as the user's public wallet, so its 15-second background pass asked the public wallet about the fresh address's deposit,
 * withdrawals and expiry claims — and a lock during any SDK call had been refused as busy, the fresh key's provider staying in place.
 */
export function revocableProvider<P extends Requesting>(inner: P, live: () => boolean): P {
  return new Proxy(inner, {
    get(target, key) {
      if (key === "request")
        return (args: { method: string; params?: unknown }) =>
          live() ? target.request(args) : Promise.reject(Object.assign(new Error("Private AI ended with the wallet's lock"), { code: 4100 }));
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** A provider that answers nothing (B-F2): what the SDK holds when no wallet is connected, never the browser's default one. */
export const refusingProvider: Requesting = {
  request: async () => Promise.reject(Object.assign(new Error("no wallet is connected for Private AI"), { code: 4100 })),
};

/**
 * Whether the pool may fund the credit's fresh address (audit round 2, p03): the zkAPI deployment must be on the pool's own
 * chain. A mainnet pool had sent real ETH to a fresh address bound to a Sepolia credit (the assets' default network),
 * where no wallet of this app reads it again.
 */
export function fundingChainOk(poolChainId: number, cfg: { trusted_deployment: { chain_id: number | string } } | null): boolean {
  return !!cfg && Number(cfg.trusted_deployment.chain_id) === poolChainId;
}
