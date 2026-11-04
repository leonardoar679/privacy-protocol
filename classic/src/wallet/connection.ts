// The wallet connection (spec v3.0 §7.5): one account on Ethereum mainnet or nothing — a wallet on another chain is
// "wrong network" and no transaction is built for it. Transactions are handed to the wallet to sign and sent by it; the
// receipt is read from the app's own endpoints, not the wallet's. Pure over an EIP-1193 provider and the JSON-RPC
// function; the lint keeps window.ethereum in injected.ts.
import type { Rpc } from "../history/sync";
import type { ConnectionState } from "../model/types";
import type { Eip1193Provider } from "./injected";

export const MAINNET_CHAIN_ID = 1;

const parseChainId = (x: unknown): number => {
  const n = typeof x === "string" ? Number.parseInt(x, 16) : Number(x);
  if (!Number.isFinite(n) || n <= 0) throw new Error("the wallet answered no chain id");
  return n;
};
const parseAccounts = (x: unknown): `0x${string}`[] => {
  if (!Array.isArray(x)) throw new Error("the wallet answered no accounts");
  return x.filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase() as `0x${string}`);
};

export function stateOf(accounts: readonly `0x${string}`[], chainId: number, expectedChainId = MAINNET_CHAIN_ID): ConnectionState {
  if (!accounts.length) return { status: "disconnected" };
  return chainId === expectedChainId ? { status: "connected", account: accounts[0], chainId } : { status: "wrong-network", account: accounts[0], chainId };
}

/** Asks the wallet for its accounts (the user's prompt) and its chain. */
export async function connect(provider: Eip1193Provider, expectedChainId = MAINNET_CHAIN_ID): Promise<ConnectionState> {
  const accounts = parseAccounts(await provider.request({ method: "eth_requestAccounts" }));
  const chainId = parseChainId(await provider.request({ method: "eth_chainId" }));
  return stateOf(accounts, chainId, expectedChainId);
}

/** The accounts already granted, without a prompt (a reload). */
export async function reconnect(provider: Eip1193Provider, expectedChainId = MAINNET_CHAIN_ID): Promise<ConnectionState> {
  const accounts = parseAccounts(await provider.request({ method: "eth_accounts" }));
  if (!accounts.length) return { status: "disconnected" };
  const chainId = parseChainId(await provider.request({ method: "eth_chainId" }));
  return stateOf(accounts, chainId, expectedChainId);
}

/** Follows account and chain changes; returns the unsubscribe. */
export function watch(provider: Eip1193Provider, onChange: (next: { accounts?: `0x${string}`[]; chainId?: number }) => void): () => void {
  const onAccounts = (...args: unknown[]) => onChange({ accounts: parseAccounts(args[0]) });
  const onChain = (...args: unknown[]) => onChange({ chainId: parseChainId(args[0]) });
  provider.on?.("accountsChanged", onAccounts);
  provider.on?.("chainChanged", onChain);
  return () => {
    provider.removeListener?.("accountsChanged", onAccounts);
    provider.removeListener?.("chainChanged", onChain);
  };
}

export interface TransactionRequest {
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  valueWei: bigint;
}

/**
 * Hands the transaction to the wallet; the hash back once the user signed and the wallet sent it. The wallet's chain is read again right
 * before, and named in the transaction (the tenth review round, C10-10): the page's chain was the last chainChanged event, and a wallet
 * that moved without one had been asked to sign a deposit of up to 100 ETH on whatever chain it was on.
 */
export async function sendTransaction(provider: Eip1193Provider, tx: TransactionRequest, expectedChainId = MAINNET_CHAIN_ID): Promise<`0x${string}`> {
  const chainId = parseChainId(await provider.request({ method: "eth_chainId" }));
  if (chainId !== expectedChainId) throw new Error(`the wallet is on chain ${chainId}, not ${expectedChainId}: nothing was sent`);
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: tx.from, to: tx.to, data: tx.data, value: `0x${tx.valueWei.toString(16)}`, chainId: `0x${expectedChainId.toString(16)}` }],
  });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("the wallet answered no transaction hash");
  return hash.toLowerCase() as `0x${string}`;
}

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: number;
  transactionHash: `0x${string}`;
}

/** Polls the app's endpoints for the receipt (never the wallet's); null until it is mined. */
export async function receiptOf(rpc: Rpc, hash: `0x${string}`): Promise<Receipt | null> {
  const r = (await rpc("eth_getTransactionReceipt", [hash])) as { status?: string; blockNumber?: string; transactionHash?: string } | null;
  if (!r?.blockNumber) return null;
  return { status: r.status === "0x1" ? "success" : "reverted", blockNumber: Number.parseInt(r.blockNumber, 16), transactionHash: hash };
}

export async function waitForReceipt(
  rpc: Rpc,
  hash: `0x${string}`,
  { pollMs = 4_000, maxMs = 20 * 60_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now = () => Date.now() } = {},
): Promise<Receipt> {
  const started = now();
  for (;;) {
    const receipt = await receiptOf(rpc, hash);
    if (receipt) return receipt;
    if (now() - started >= maxMs) throw new Error("the transaction was not mined in time");
    await sleep(pollMs);
  }
}
