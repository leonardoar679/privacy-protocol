// The wallet's chain access (doc §64–§65; spec v2.0 §14.2): one PrivacyTransport per endpoint, over the HTTP transport's
// policy (./http.ts — no credentials, no cross-host redirect, no referrer, every request announced to the leakage gate).
// This is the only module of the wallet that makes a viem client (scripts/check-boundaries.mjs): a private read transport
// — Tor, a mixnet, a native light client — replaces this one and nothing else. Reads are whole events and contract views,
// never a query that names the user's address (doc §64).
import { createPublicClient, type Abi, type AbiEvent, type Address, type BlockTag, type Hex, type Log, type PublicClient } from "viem";
import { viemTransport } from "./http";

export interface ChainBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  baseFeePerGas: bigint | null;
}

export interface ContractRead {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
}

export interface LogQuery {
  address: Address | Address[];
  /** the event to decode (its topic filters the logs); without one every log of the address comes back raw */
  event?: AbiEvent;
  fromBlock: bigint;
  toBlock?: bigint | BlockTag;
}

export interface PrivacyTransport {
  /** the endpoint; its host joins the allowlist with the first client */
  readonly url: string;
  /** a contract view (eth_call) */
  read<T = unknown>(call: ContractRead): Promise<T>;
  /** a signed transaction to the network (eth_sendRawTransaction); resolves to its hash */
  broadcast(serialized: Hex): Promise<Hex>;
  /** a block by number or tag (the latest when omitted) */
  getBlock(at?: bigint | BlockTag): Promise<ChainBlock>;
  /** the logs of contracts over a block range (to the latest block when `toBlock` is omitted) */
  getLogs(q: LogQuery): Promise<Log[]>;
  /** the viem client underneath, for the engine's typed reads (the tree sync, the simulations) */
  readonly client: PublicClient;
}

/** A viem public client over the transport's policy: the one constructor of the wallet's RPC clients. */
export const publicClientFor = (url: string): PublicClient => createPublicClient({ transport: viemTransport(url) });

export function privacyTransport(url: string): PrivacyTransport {
  const client = publicClientFor(url);
  return {
    url,
    client,
    read: <T>(call: ContractRead) => client.readContract(call as Parameters<PublicClient["readContract"]>[0]) as Promise<T>,
    broadcast: (serialized) => client.sendRawTransaction({ serializedTransaction: serialized }),
    async getBlock(at) {
      const b =
        at === undefined
          ? await client.getBlock()
          : typeof at === "bigint"
            ? await client.getBlock({ blockNumber: at })
            : await client.getBlock({ blockTag: at });
      if (b.number === null || b.hash === null) throw new Error("the endpoint answered a pending block");
      return { number: b.number, hash: b.hash, timestamp: b.timestamp, baseFeePerGas: b.baseFeePerGas ?? null };
    },
    getLogs: (q) =>
      client.getLogs({ address: q.address, fromBlock: q.fromBlock, toBlock: q.toBlock ?? "latest", ...(q.event ? { event: q.event } : {}) } as Parameters<
        PublicClient["getLogs"]
      >[0]) as Promise<Log[]>,
  };
}
