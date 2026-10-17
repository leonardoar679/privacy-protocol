// Chain access for the wallet: the deployment it talks to (env), viem public clients over the
// configured RPC endpoints, a mirror of the shielded tree rebuilt from NoteInserted events (checked
// against the core's current root AND across endpoints), the core/chain binding (txDomain) and
// submission through the injected wallet.
//
// Env: VITE_RPC_URLS (comma-separated; or VITE_RPC_URL for one), VITE_CORE, VITE_ETH_VAULT,
// VITE_CHAIN_ID (default 31337), VITE_FROM_BLOCK (0), VITE_ERC20_VAULTS (SYMBOL:0xtoken:0xvault:decimals, comma-separated; plan §36),
// VITE_SWAP_FACTORY (the SwapOrderFactory every swap escrow is checked against).
import { publicClientFor } from "@privacy-wallet/privacy-engine/transport/chain";
import { activeProvider } from "@privacy-wallet/wallet-engine/injected";
import { getAddress, keccak256, parseAbiItem, parseEventLogs, toHex, type Address, type Hex, type PublicClient } from "viem";
import { ZERO_LEAF, type MerkleLayers } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { txDomain } from "@privacy-wallet/protocol/payload";
import { coreAbi, type TxRequest } from "./privacyProtocol";
import { treeLayers } from "./core";

export interface Erc20VaultSpec { symbol: string; token: Address; vault: Address; decimals: number }
export interface Deployment { chainId: number; core: Address; ethVault: Address; rpcUrl: string; rpcUrls: string[]; fromBlock: bigint; erc20Vaults: Erc20VaultSpec[]; /** SwapOrderFactory: the wallet recomputes every escrow address from it (VITE_SWAP_FACTORY) */ swapFactory?: Address; /** V6 (spec v2.0 §11.1): ProtectRouter — a protect pays its 1 % through it (VITE_PROTECT_ROUTER) */ protectRouter?: Address; /** V6 Stage 12 (spec v2.0 §11.2): ShieldReceiverFactory — a same-chain swap delivers into the protected balance through a receiver it predicts (VITE_SHIELD_FACTORY) */ shieldFactory?: Address }

// V6 Stage 16: the parser lives in ./env.ts (the configuration reads it before the first screen, without this module)
export { deploymentFromEnv } from "./env";

/**
 * The wallet's RPC policy (plan §38, §64, Rule 6 on the wallet side): no API key anywhere (URLs come
 * from env), JSON-RPC batching so a sync is few round trips, no cookies and no cross-host redirects,
 * and — when more than one endpoint is configured — every view the wallet proves against is read
 * from ALL of them and must agree (a lying or stale endpoint cannot hand the wallet a wrong tree).
 * Reads are "fetch everything" (all NoteInserted events), never address-specific queries, so no
 * endpoint learns which notes are ours. Light-client verification is the native-host upgrade.
 */
// V5 (spec §7): the one transport policy, announced to the leakage gate; V6 Stage 4 (doc §65): the clients come from the
// privacy engine's transport, the wallet's only constructor of one
export const clientFor = (d: Deployment): PublicClient => publicClientFor(d.rpcUrl);
export const clientsFor = (d: Deployment): PublicClient[] => (d.rpcUrls?.length ? d.rpcUrls : [d.rpcUrl]).map((u) => publicClientFor(u));

export const txDomainOf = (d: Deployment): bigint => txDomain(BigInt(d.chainId), BigInt(d.core));

const noteInserted = parseAbiItem("event NoteInserted(uint32 indexed leafIndex, uint256 commitment, bytes noteData)");

export interface TreeState { leaves: bigint[]; root: bigint; nextLeafIndex: number; /** NoteInserted events = notes in the pool (the anonymity set) */ notes: number; /** every layer over `leaves`: authentication paths are lookups */ layers: MerkleLayers }

/**
 * Rebuild the tree the core holds: every NoteInserted commitment at its leaf index, ZERO_LEAF in the
 * gaps (deposits are one commitment + three empty leaves, transactions three + one), grouped by four
 * exactly as MerkleAccumulator inserts them. The result must reproduce the core's current root, or
 * the view is stale / reorged and the caller must retry (packages/protocol/src/indexer.ts is the
 * reorg-aware incremental version).
 */
export interface NoteInsertedLog { leafIndex: number; commitment: bigint; noteData: Hex; transactionHash: Hex; blockNumber: bigint }

/** The block range a fetch-all read falls back to when an endpoint refuses one request for the whole history. */
export const LOG_WINDOW_BLOCKS = 10_000n;
/** An endpoint's refusal of a range too large (a result or response cap, a block-range limit), in the words providers use. */
const RANGE_REFUSED = /more than \d+ results|response size|block range|range (is )?too (large|wide|big)|exceed(s|ed)? (the )?max(imum)?|too many (results|logs)|query timeout|limited to an? \d/i; // never a rate limit: that is a retry
const refusedForSize = (e: unknown): boolean => {
  for (let x: unknown = e, i = 0; x && i < 6; x = (x as { cause?: unknown }).cause, i++) if (RANGE_REFUSED.test(String((x as Error)?.message ?? x))) return true;
  return false;
};

/**
 * Logs from `fromBlock` to now (the audit round of 2026-10-16, c32). One request for the whole history, as before; an
 * endpoint that refuses it for its size — once the pool passes the providers' caps — is read in windows instead, each
 * halved again on a refusal, up to the block the first read saw. Before, a large pool left no spend, funding or scan able
 * to run.
 */
export async function logsInWindows<T>(client: Pick<PublicClient, "getBlockNumber">, fromBlock: bigint, read: (from: bigint, to: bigint | "latest") => Promise<T[]>, window = LOG_WINDOW_BLOCKS): Promise<T[]> {
  try {
    return await read(fromBlock, "latest");
  } catch (e) {
    if (!refusedForSize(e)) throw e;
  }
  const last = await client.getBlockNumber();
  const out: T[] = [];
  let from = fromBlock;
  let size = window;
  while (from <= last) {
    const to = from + size - 1n < last ? from + size - 1n : last;
    try {
      out.push(...(await read(from, to)));
      from = to + 1n;
    } catch (e) {
      if (!refusedForSize(e) || size <= 1n) throw e;
      size /= 2n;
    }
  }
  return out;
}

/** Every NoteInserted event the core emitted (leaf index, commitment, the 169-byte payload). */
export async function noteInsertedLogs(client: PublicClient, d: Deployment): Promise<NoteInsertedLog[]> {
  const logs = await logsInWindows(client, d.fromBlock, (fromBlock, toBlock) => client.getLogs({ address: d.core, event: noteInserted, fromBlock, toBlock }));
  return logs.map((l) => ({ leafIndex: Number(l.args.leafIndex), commitment: l.args.commitment!, noteData: l.args.noteData!, transactionHash: l.transactionHash, blockNumber: l.blockNumber }));
}

/** One endpoint's view: the events, the core's leaf count and its current root — not yet hashed. */
export interface RawView { logs: NoteInsertedLog[]; nextLeafIndex: number; onChainRoot: bigint }

export async function readView(client: PublicClient, d: Deployment): Promise<RawView> {
  const [logs, next, onChainRoot] = await Promise.all([
    noteInsertedLogs(client, d),
    client.readContract({ address: d.core, abi: coreAbi, functionName: "nextLeafIndex" }),
    client.readContract({ address: d.core, abi: coreAbi, functionName: "currentRoot" }),
  ]);
  return { logs, nextLeafIndex: Number(next), onChainRoot: BigInt(onChainRoot as Hex) };
}

/**
 * Hash a view into the tree (every layer in one pass — the Rust core's WASM build when it is served,
 * the TypeScript reference otherwise) and check it reproduces the core's current root.
 */
export async function buildTree(view: RawView): Promise<TreeState> {
  const { logs, nextLeafIndex, onChainRoot } = view;
  const leaves: bigint[] = Array(nextLeafIndex).fill(ZERO_LEAF);
  for (const l of logs) {
    if (l.leafIndex >= nextLeafIndex) throw new Error(`NoteInserted at ${l.leafIndex} beyond nextLeafIndex ${nextLeafIndex}: stale view`);
    leaves[l.leafIndex] = l.commitment;
  }
  const layers = await treeLayers(leaves, TX_LEVELS);
  if (layers.root !== onChainRoot) throw new Error("the rebuilt tree does not match the core's current root (missing events or a reorg) — retry");
  return { leaves, root: layers.root, nextLeafIndex, notes: logs.length, layers };
}

export const syncTree = async (client: PublicClient, d: Deployment): Promise<TreeState> => buildTree(await readView(client, d));

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

const deposited = parseAbiItem("event Deposited(bytes32 indexed ownerCommitment, uint256 amount, uint32 leafIndex)");

/** A vault deposit: the vault, the owner commitment it was made out to, the amount and the leaf it took. */
export interface DepositedLog { vault: Address; ownerCommitment: bigint; amount: bigint; leafIndex: number; transactionHash: Hex }

/** The pool's vaults this wallet knows: ETH and every configured ERC-20. */
export const poolVaults = (d: Deployment): Address[] => [d.ethVault, ...(d.erc20Vaults ?? []).map((v) => v.vault)];

/** Every Deposited event of the pool's vaults: fetch-all like the note events, never filtered by owner. */
export async function depositedLogs(client: PublicClient, d: Deployment): Promise<DepositedLog[]> {
  const logs = await logsInWindows(client, d.fromBlock, (fromBlock, toBlock) => client.getLogs({ address: poolVaults(d), event: deposited, fromBlock, toBlock }));
  return logs.map((l) => ({ vault: getAddress(l.address), ownerCommitment: BigInt(l.args.ownerCommitment!), amount: l.args.amount!, leafIndex: Number(l.args.leafIndex), transactionHash: l.transactionHash }));
}

/** The vaults' Deposited events from every configured endpoint; they must agree. */
export async function depositedLogsQuorum(d: Deployment): Promise<DepositedLog[]> {
  const all = await Promise.all(clientsFor(d).map((c) => depositedLogs(c, d)));
  const digests = all.map((ls) => keccak256(toHex(ls.map((l) => `${l.vault.toLowerCase()}:${l.leafIndex}:${l.amount}:${l.ownerCommitment.toString(16)}`).join("|"))));
  if (new Set(digests).size !== 1) throw new RpcDisagreement("the vault deposits", digests.map((x) => x.slice(0, 10)));
  return all[0];
}

/**
 * The synced tree, read from every configured endpoint (plan §38): the views must agree on the leaf
 * count, the root and every event byte for byte; the agreed view is hashed once.
 */
export async function syncTreeQuorum(d: Deployment): Promise<TreeState> {
  return (await syncPoolQuorum(d)).tree;
}

/** The tree and the note events it was built from, both agreed by every configured endpoint (a rescan needs the payloads too). */
export async function syncPoolQuorum(d: Deployment): Promise<{ tree: TreeState; logs: NoteInsertedLog[] }> {
  const views = await Promise.all(clientsFor(d).map((c) => readView(c, d)));
  const keys = views.map((v) => `${v.nextLeafIndex}/${v.onChainRoot.toString(16).slice(0, 10)}`);
  if (new Set(keys).size !== 1) throw new RpcDisagreement("the tree", keys);
  const digests = views.map((v) => logsDigest(v.logs));
  if (new Set(digests).size !== 1) throw new RpcDisagreement("the note events", digests.map((x) => x.slice(0, 10)));
  return { tree: await buildTree(views[0]), logs: views[0].logs };
}

/** Submit through the injected wallet (public submission — a relayer / private channel is the L3 upgrade). */
/** Thrown before anything is sent: the connected wallet is on another network than the deployment's (the catalog's `chain_mismatch`). */
export class WalletOnOtherChain extends Error {
  readonly code = "chain_mismatch";
  constructor(
    readonly expected: number,
    readonly actual: number | null,
  ) {
    super(`the connected wallet is on chain ${actual ?? "unknown"}, not this deployment's chain ${expected}; nothing was sent`);
    this.name = "WalletOnOtherChain";
  }
}

/**
 * A transaction through the connected wallet, on the deployment's chain only (a V6 follow-up of 2026-10-16): the wallet's
 * network is read just before every send, and the transaction names its chain, which a wallet that checks it holds to
 * even if the network is switched in between. Before, a wallet left on another network (or switched there between a
 * protect's approval and its deposit) sent the deposit's value to the same address on that chain.
 */
export async function sendViaInjectedWallet(tx: TxRequest, chainId: number): Promise<Hex> {
  const eth = activeProvider();
  if (!eth) throw new Error("no injected wallet to submit with");
  const [from] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const raw = await eth.request({ method: "eth_chainId" });
  const actual = typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw) ? parseInt(raw, 16) : typeof raw === "number" ? raw : null;
  if (actual !== chainId) throw new WalletOnOtherChain(chainId, actual);
  return (await eth.request({
    method: "eth_sendTransaction",
    params: [{ from, to: tx.to, data: tx.data, chainId: `0x${chainId.toString(16)}`, ...(tx.value ? { value: "0x" + tx.value.toString(16) } : {}) }],
  })) as Hex;
}

/** Wait for a transaction and return the leaves it inserted (leaf index + commitment). */
export async function noteInsertions(client: PublicClient, hash: Hex): Promise<{ leafIndex: number; commitment: bigint }[]> {
  return (await minedTx(client, hash)).inserted;
}

/** A mined transaction of ours: the notes it inserted and what it really cost (V6, spec v2.0 §3: gasUsed × effectiveGasPrice). */
export async function minedTx(
  client: PublicClient,
  hash: Hex,
  /** the core: only its own events count (a V6 follow-up of 2026-10-17, audit c31) */
  core?: Address,
): Promise<{ inserted: { leafIndex: number; commitment: bigint }[]; costWei: bigint; /** the nullifier pairs its transact calls spent */ spends: [bigint, bigint][] }> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  const logs = core ? receipt.logs.filter((l) => l.address.toLowerCase() === core.toLowerCase()) : receipt.logs;
  const inserted = parseEventLogs({ abi: coreAbi, logs, eventName: "NoteInserted" }).map((l) => ({ leafIndex: Number(l.args.leafIndex), commitment: l.args.commitment }));
  const spends = parseEventLogs({ abi: coreAbi, logs, eventName: "ShieldedTransaction" }).map((l) => [l.args.nullifier0, l.args.nullifier1] as [bigint, bigint]);
  return { inserted, costWei: receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n), spends }; // an RPC that omits the price: no cost known
}

/** The connected account's public balance, read through the injected wallet's OWN provider (never our RPCs: no address ↔ endpoint link). */
export async function publicBalanceViaInjectedWallet(account: string): Promise<bigint | null> {
  const eth = activeProvider();
  if (!eth) return null;
  const hex = await eth.request({ method: "eth_getBalance", params: [account, "latest"] });
  return typeof hex === "string" ? BigInt(hex) : null;
}
