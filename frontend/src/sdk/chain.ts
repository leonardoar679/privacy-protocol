// Chain access for the wallet: the deployment it talks to (env), a viem public client, a mirror of
// the shielded tree rebuilt from NoteInserted events (checked against the core's current root), the
// core/chain binding (txDomain) and submission through the injected wallet.
//
// Env: VITE_RPC_URL, VITE_CORE, VITE_ETH_VAULT, VITE_CHAIN_ID (default 31337), VITE_FROM_BLOCK (0).
import { createPublicClient, http, parseAbiItem, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { GROUP_SIZE, MerkleTree, ZERO_LEAF } from "@ref/merkle";
import { TX_LEVELS } from "@ref/txInputs";
import { txDomain } from "@ref/payload";
import { coreAbi, type TxRequest } from "./privacyProtocol";

export interface Deployment { chainId: number; core: Address; ethVault: Address; rpcUrl: string; fromBlock: bigint }

export function deploymentFromEnv(): Deployment | null {
  const env = (import.meta as any).env ?? {};
  if (!env.VITE_RPC_URL || !env.VITE_CORE || !env.VITE_ETH_VAULT) return null;
  return { chainId: Number(env.VITE_CHAIN_ID ?? 31337), core: env.VITE_CORE, ethVault: env.VITE_ETH_VAULT, rpcUrl: env.VITE_RPC_URL, fromBlock: BigInt(env.VITE_FROM_BLOCK ?? 0) };
}

/**
 * The wallet's RPC policy (plan §64, as far as a web wallet can go without a metered private RPC):
 * no API key anywhere (the URL comes from env), JSON-RPC batching so a sync is few round trips, no
 * cookies and no cross-host redirects. Light-client verification and a zkAPI-metered upstream are
 * still to come (docs/private-ai.md, step 05).
 */
export const clientFor = (d: Deployment): PublicClient => createPublicClient({ transport: http(d.rpcUrl, { batch: true, fetchOptions: { credentials: "omit", redirect: "error" } }) });

export const txDomainOf = (d: Deployment): bigint => txDomain(BigInt(d.chainId), BigInt(d.core));

const noteInserted = parseAbiItem("event NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData)");

export interface TreeState { leaves: bigint[]; root: bigint; nextLeafIndex: number }

/**
 * Rebuild the tree the core holds: every NoteInserted commitment at its leaf index, ZERO_LEAF in the
 * gaps (deposits are one commitment + three empty leaves, transactions three + one), grouped by four
 * exactly as MerkleAccumulator inserts them. The result must reproduce the core's current root, or
 * the view is stale / reorged and the caller must retry (reference/typescript/src/indexer.ts is the
 * reorg-aware incremental version).
 */
export interface NoteInsertedLog { leafIndex: number; commitment: bigint; noteData: Hex; transactionHash: Hex; blockNumber: bigint }

/** Every NoteInserted event the core emitted (leaf index, commitment, the 169-byte payload). */
export async function noteInsertedLogs(client: PublicClient, d: Deployment): Promise<NoteInsertedLog[]> {
  const logs = await client.getLogs({ address: d.core, event: noteInserted, fromBlock: d.fromBlock, toBlock: "latest" });
  return logs.map((l) => ({ leafIndex: Number(l.args.leafIndex), commitment: l.args.commitment!, noteData: l.args.noteData!, transactionHash: l.transactionHash, blockNumber: l.blockNumber }));
}

export async function syncTree(client: PublicClient, d: Deployment): Promise<TreeState> {
  const [logs, next, onChainRoot] = await Promise.all([
    noteInsertedLogs(client, d),
    client.readContract({ address: d.core, abi: coreAbi, functionName: "nextLeafIndex" }),
    client.readContract({ address: d.core, abi: coreAbi, functionName: "currentRoot" }),
  ]);
  const nextLeafIndex = Number(next);
  const leaves: bigint[] = Array(nextLeafIndex).fill(ZERO_LEAF);
  for (const l of logs) {
    if (l.leafIndex >= nextLeafIndex) throw new Error(`NoteInserted at ${l.leafIndex} beyond nextLeafIndex ${nextLeafIndex}: stale view`);
    leaves[l.leafIndex] = l.commitment;
  }
  const tree = new MerkleTree(TX_LEVELS);
  for (let i = 0; i < nextLeafIndex; i += GROUP_SIZE) tree.insertGroup(leaves.slice(i, i + GROUP_SIZE));
  if (tree.root !== BigInt(onChainRoot as Hex)) throw new Error("the rebuilt tree does not match the core's current root (missing events or a reorg) — retry");
  return { leaves: tree.leaves, root: tree.root, nextLeafIndex };
}

/** Submit through the injected wallet (public submission — a relayer / private channel is the L3 upgrade). */
export async function sendViaInjectedWallet(tx: TxRequest): Promise<Hex> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("no injected wallet to submit with");
  const [from] = await eth.request({ method: "eth_requestAccounts" });
  return eth.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data, ...(tx.value ? { value: "0x" + tx.value.toString(16) } : {}) }] });
}

/** Wait for a transaction and return the leaves it inserted (leaf index + commitment). */
export async function noteInsertions(client: PublicClient, hash: Hex): Promise<{ leafIndex: number; commitment: bigint }[]> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return parseEventLogs({ abi: coreAbi, logs: receipt.logs, eventName: "NoteInserted" }).map((l) => ({ leafIndex: Number(l.args.leafIndex), commitment: l.args.commitment }));
}
