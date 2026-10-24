// A fresh, wallet-derived funding address for zkAPI credit (docs/zkapi-integration-spec.md §4 and §6:
// deposit from a FRESH address, never the permanent one; fund it with a private withdrawal from the
// pool). The zkAPI SDK talks to "the connected wallet" through EIP-1193; this is a minimal provider
// over a locally derived key: it answers accounts / chain, signs and broadcasts transactions with
// viem's local account, and forwards every read to the pinned public RPC. No extension involved.
import { createPublicClient, createWalletClient, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { viemTransport } from "@privacy-wallet/privacy-engine/transport/http";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const enc = new TextEncoder();

/** Funding key #`index` for zkAPI credit: keccak(seed ‖ "/zkapi/funding/" ‖ index) in [1, n−1]. A new index per credit note. */
export function deriveFundingKey(masterSeed: Uint8Array, index: number): { privateKey: Hex; address: Address } {
  const label = enc.encode(`/zkapi/funding/${index}`);
  const buf = new Uint8Array(masterSeed.length + label.length);
  buf.set(masterSeed, 0);
  buf.set(label, masterSeed.length);
  const k = (BigInt(keccak256(buf)) % (SECP256K1_N - 1n)) + 1n;
  const privateKey = ("0x" + k.toString(16).padStart(64, "0")) as Hex;
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export interface FreshAccountProvider {
  address: Address;
  isFreshFundingAddress: true;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...a: unknown[]) => void): void;
  removeListener(event: string, listener: (...a: unknown[]) => void): void;
}

export function freshAccountProvider(privateKey: Hex, rpcUrl: string, chainId: number): FreshAccountProvider {
  const account = privateKeyToAccount(privateKey);
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  // the privacy engine's transport (audit round 2, n51): viem's plain http transport had read and broadcast outside the
  // policy — no allowlist, no announcement, no no-referrer
  const transport = viemTransport(rpcUrl);
  const reads = createPublicClient({ chain, transport });
  const signer = createWalletClient({ account, chain, transport });
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    address: account.address,
    isFreshFundingAddress: true,
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return "0x" + chainId.toString(16);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null; // this provider lives on the pinned chain only
        case "eth_sendTransaction": {
          const [tx] = params as [{ from?: Address; to: Address; data?: Hex; value?: Hex | bigint; gas?: Hex | bigint }];
          if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) throw new Error("eth_sendTransaction: not the fresh funding address");
          return signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value === undefined ? undefined : BigInt(tx.value), gas: tx.gas === undefined ? undefined : BigInt(tx.gas) });
        }
        case "personal_sign":
        case "eth_sign":
        case "eth_signTypedData_v4":
          throw new Error(`${method}: the fresh funding address signs transactions only`);
        default:
          return reads.request({ method, params } as never); // eth_call, eth_getBalance, eth_estimateGas, receipts, logs, blocks, fees …
      }
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
}
