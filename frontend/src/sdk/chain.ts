// Chain access for the wallet: the deployment it talks to (env), viem public clients over the
// configured RPC endpoints, a mirror of the shielded tree rebuilt from NoteInserted events (checked
// against the core's current root AND across endpoints), the core/chain binding (txDomain) and
// submission through the injected wallet.
//
// Env: VITE_RPC_URLS (comma-separated; or VITE_RPC_URL for one), VITE_CORE, VITE_ETH_VAULT,
// VITE_CHAIN_ID (default 31337), VITE_FROM_BLOCK (0), VITE_ERC20_VAULTS (SYMBOL:0xtoken:0xvault:decimals, comma-separated; plan §36).
import { createPublicClient, http, keccak256, parseAbiItem, parseEventLogs, toHex, type Address, type Hex, type PublicClient } from "viem";
import { GROUP_SIZE, MerkleTree, ZERO_LEAF } from "@ref/merkle";
import { TX_LEVELS } from "@ref/txInputs";
import { txDomain } from "@ref/payload";
import { coreAbi, type TxRequest } from "./privacyProtocol";
import { parseErc20Vaults } from "./assets";

export interface Erc20VaultSpec { symbol: string; token: Address; vault: Address; decimals: number }
export interface Deployment { chainId: number; core: Address; ethVault: Address; rpcUrl: string; rpcUrls: string[]; fromBlock: bigint; erc20Vaults: Erc20VaultSpec[] }

export function deploymentFromEnv(env: Record<string, string | undefined> = (import.meta as any).env ?? {}): Deployment | null {
  const urls = String(env.VITE_RPC_URLS ?? env.VITE_RPC_URL ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (!urls.length || !env.VITE_CORE || !env.VITE_ETH_VAULT) return null;
  return { chainId: Number(env.VITE_CHAIN_ID ?? 31337), core: env.VITE_CORE as Address, ethVault: env.VITE_ETH_VAULT as Address, rpcUrl: urls[0], rpcUrls: urls, fromBlock: BigInt(env.VITE_FROM_BLOCK ?? 0), erc20Vaults: parseErc20Vaults(env.VITE_ERC20_VAULTS) };
}

/**
 * The wallet's RPC policy (plan §38, §64, Rule 6 on the wallet side): no API key anywhere (URLs come
 * from env), JSON-RPC batching so a sync is few round trips, no cookies and no cross-host redirects,
 * and — when more than one endpoint is configured — every view the wallet proves against is read
 * from ALL of them and must agree (a lying or stale endpoint cannot hand the wallet a wrong tree).
 * Reads are "fetch everything" (all NoteInserted events), never address-specific queries, so no
 * endpoint learns which notes are ours. Light-client verification is the native-host upgrade.
 */
const transportFor = (url: string) => http(url, { batch: true, fetchOptions: { credentials: "omit", redirect: "error" } });
export const clientFor = (d: Deployment): PublicClient => createPublicClient({ transport: transportFor(d.rpcUrl) });
export const clientsFor = (d: Deployment): PublicClient[] => (d.rpcUrls?.length ? d.rpcUrls : [d.rpcUrl]).map((u) => createPublicClient({ transport: transportFor(u) }));

export const txDomainOf = (d: Deployment): bigint => txDomain(BigInt(d.chainId), BigInt(d.core));

const noteInserted = parseAbiItem("event NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData)");

export interface TreeState { leaves: bigint[]; root: bigint; nextLeafIndex: number; /** NoteInserted events = notes in the pool (the anonymity set) */ notes: number }

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
  return { leaves: tree.leaves, root: tree.root, nextLeafIndex, notes: logs.length };
}

/** A content digest of a log set: endpoints must agree on exactly these leaves and payloads. */
export const logsDigest = (logs: NoteInsertedLog[]): Hex =>
  keccak256(toHex(logs.map((l) => `${l.leafIndex}:${l.commitment.toString(16)}:${l.noteData}`).join("|")));

export class RpcDisagreement extends Error {
  constructor(public readonly what: string, public readonly views: string[]) {
    super(`RPC endpoints disagree on ${what} (${views.join(" vs ")}) — refusing to act on this view; check the endpoints`);
  }
}

/** All NoteInserted events, read from every configured endpoint; they must agree byte for byte. */
export async function noteInsertedLogsQuorum(d: Deployment): Promise<NoteInsertedLog[]> {
  const all = await Promise.all(clientsFor(d).map((c) => noteInsertedLogs(c, d)));
  const digests = all.map(logsDigest);
  if (new Set(digests).size !== 1) throw new RpcDisagreement("the note events", digests.map((x) => x.slice(0, 10)));
  return all[0];
}

/** The synced tree, read from every configured endpoint; roots and sizes must agree (plan §38). */
export async function syncTreeQuorum(d: Deployment): Promise<TreeState> {
  const views = await Promise.all(clientsFor(d).map((c) => syncTree(c, d)));
  const keys = views.map((v) => `${v.nextLeafIndex}/${v.root.toString(16).slice(0, 10)}`);
  if (new Set(keys).size !== 1) throw new RpcDisagreement("the tree", keys);
  return views[0];
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

/** The connected account's public balance, read through the injected wallet's OWN provider (never our RPCs: no address ↔ endpoint link). */
export async function publicBalanceViaInjectedWallet(account: string): Promise<bigint | null> {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  const hex = await eth.request({ method: "eth_getBalance", params: [account, "latest"] });
  return typeof hex === "string" ? BigInt(hex) : null;
}
