// The chain (doc §72; spec v2.0 §9): one source of truth for a network's family, reads, explorer and finality.
import type { ChainId } from "./primitives";

export type ChainFamily = "evm" | "bitcoin" | "solana";

export interface ChainConfig {
  id: ChainId;
  name: string;
  family: ChainFamily;
  /** the EVM chain id */
  chainId?: number;
  /** how the wallet reads the chain: endpoints from the deployment's configuration and how many must agree, or none
   *  (a destination chain the wallet never reads itself: the provider's tracker reports it) */
  rpcPolicy: { quorum: number; endpoints: "config" | "none"; privateTransport: boolean };
  /** a block explorer's links (opening one is the user's choice: it tells the explorer which transaction), or none */
  explorer: { name: string; tx: string; address: string } | null;
  /** the confirmations a settlement leg on this chain counts before the wallet calls it final */
  confirmations: number;
}
