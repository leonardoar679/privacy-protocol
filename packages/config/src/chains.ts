// The chains (doc §72; spec v2.0 §9): one source of truth for a network's family, how the wallet reads it, its explorer
// and how many confirmations a settlement leg counts. Components never hard-code a network.
import type { ChainConfig, ChainId } from "@privacy-wallet/protocol-types";

const evmReads = { quorum: 2, endpoints: "config", privateTransport: false } as const;
const notRead = { quorum: 0, endpoints: "none", privateTransport: false } as const;
const etherscan = (host: string, name: string) => ({ name, tx: `https://${host}/tx/{hash}`, address: `https://${host}/address/{address}` });

export const CHAINS: Record<ChainId, ChainConfig> = {
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    family: "evm",
    chainId: 1,
    rpcPolicy: evmReads,
    explorer: etherscan("etherscan.io", "Etherscan"),
    confirmations: 12,
  },
  sepolia: {
    id: "sepolia",
    name: "Sepolia",
    family: "evm",
    chainId: 11155111,
    rpcPolicy: evmReads,
    explorer: etherscan("sepolia.etherscan.io", "Etherscan"),
    confirmations: 3,
  },
  base: { id: "base", name: "Base", family: "evm", chainId: 8453, rpcPolicy: notRead, explorer: etherscan("basescan.org", "Basescan"), confirmations: 10 },
  arbitrum: {
    id: "arbitrum",
    name: "Arbitrum",
    family: "evm",
    chainId: 42161,
    rpcPolicy: notRead,
    explorer: etherscan("arbiscan.io", "Arbiscan"),
    confirmations: 10,
  },
  optimism: {
    id: "optimism",
    name: "Optimism",
    family: "evm",
    chainId: 10,
    rpcPolicy: notRead,
    explorer: etherscan("optimistic.etherscan.io", "Etherscan"),
    confirmations: 10,
  },
  bitcoin: {
    id: "bitcoin",
    name: "Bitcoin",
    family: "bitcoin",
    rpcPolicy: notRead,
    explorer: { name: "mempool.space", tx: "https://mempool.space/tx/{hash}", address: "https://mempool.space/address/{address}" },
    confirmations: 2,
  },
  solana: {
    id: "solana",
    name: "Solana",
    family: "solana",
    rpcPolicy: notRead,
    explorer: { name: "Solscan", tx: "https://solscan.io/tx/{hash}", address: "https://solscan.io/account/{address}" },
    confirmations: 32,
  },
  // a devnet (Hardhat's default chain id; the local stack answers chain id 1 to run the mainnet pins)
  local: {
    id: "local",
    name: "Local devnet",
    family: "evm",
    chainId: 31337,
    rpcPolicy: { quorum: 1, endpoints: "config", privateTransport: false },
    explorer: null,
    confirmations: 1,
  },
};

export const chainById = (id: ChainId): ChainConfig => CHAINS[id];

/** The chain of an EVM chain id (the pool's), or undefined. */
export const chainOfEvmId = (chainId: number): ChainConfig | undefined => Object.values(CHAINS).find((c) => c.chainId === chainId);

/** An explorer link, or null on a chain without one. */
export function explorerLink(chain: ChainId, kind: "tx" | "address", value: string): string | null {
  const e = CHAINS[chain].explorer;
  if (!e) return null;
  return kind === "tx" ? e.tx.replace("{hash}", value) : e.address.replace("{address}", value);
}
