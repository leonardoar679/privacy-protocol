// Client of a relayer (services/relayer): private submission of a proven transact, paid by a
// private fee note to the relayer's privacy address, and the swap-order executor (deploy + execute
// a funded escrow, refund after the window). Any URL works; the wallet keeps a list of relayers and
// self-submission as fallbacks (plan §85 rule 5). The relayer never receives keys — only proofs,
// public inputs, payloads, the fee note's opening (its own note), signed executions and refund payloads.
import type { Address, Hex } from "viem";

const envList = (v: unknown): string[] => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const DEFAULT_RELAYER_URL: string = (import.meta as any).env?.VITE_RELAYER_URL ?? envList((import.meta as any).env?.VITE_RELAYER_URLS)[0] ?? "http://127.0.0.1:8790";
/** Further relayers to try when the first is unreachable (VITE_RELAYER_URLS, comma-separated; the first entry is the default). */
export const RELAYER_FALLBACKS: string[] = envList((import.meta as any).env?.VITE_RELAYER_URLS).filter((u) => u !== DEFAULT_RELAYER_URL);

export interface RelayerFeeVault { vault: Address; symbol: string; decimals: number; minFee: string }
export interface RelayerInfo {
  chainId: number; core: Address; feeVault: Address; relayer: Address; privacyAddress: string;
  minFeeWei: string; gasPriceWei: string; gasEstimate: string; feeMarginBps: number; requireReadableFeePayload: boolean; inflight: number;
  /** ERC-20 vaults the relayer takes fee notes in, with fixed minimums (plan §36) */
  feeVaults?: RelayerFeeVault[];
}
export interface RelayerSubmitRequest { proof: Hex; publicInputs: string[]; noteData: [Hex, Hex, Hex]; fee: { outputIndex: 0 | 1 | 2; amount: string; noteSecret: string; vault?: Address } }
export interface RelayerSubmitResult { txHash: Hex; feeWei: string; feeVault?: Address; gas: string; feePayloadReadable: boolean }

/** A swap order handed to the executor: the escrow's params, the one-time key's signed execution, the committed refund payload. */
export interface SwapExecuteRequest {
  factory: Address;
  params: { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string };
  execution: { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex };
  refundNoteData: Hex;
}
/** A funded order the wallet will not execute: the executor re-shields it after the window (no execution needed). */
export type SwapRefundRequest = Omit<SwapExecuteRequest, "execution">;
export type SwapJobState = "waiting-funding" | "expired" | "refund-only" | "executing" | "executed" | "execute-failed" | "refunding" | "refunded" | "refund-failed" | "completed";
export interface SwapJob { id: string; escrow: Address; state: SwapJobState; txHash?: Hex; error?: string; balance?: string; updatedAt: number }

export class RelayerRefusal extends Error {
  constructor(message: string, public readonly code: string | undefined, public readonly status: number) { super(message); }
}

async function call<T>(url: string, path: string, body: unknown | undefined, fetchImpl: typeof fetch): Promise<T> {
  const r = await fetchImpl(url.replace(/\/$/, "") + path, {
    method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit", redirect: "error",
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new RelayerRefusal(`relayer: ${j.error ?? r.status}${j.code ? ` (${j.code})` : ""}`, j.code, r.status);
  return j as T;
}

export const relayerInfo = (url: string, fetchImpl: typeof fetch = fetch) => call<RelayerInfo>(url, "/info", undefined, fetchImpl);
export const relayerSubmit = (url: string, req: RelayerSubmitRequest, fetchImpl: typeof fetch = fetch) => call<RelayerSubmitResult>(url, "/submit", req, fetchImpl);
export const relayerStatus = (url: string, txHash: Hex, fetchImpl: typeof fetch = fetch) => call<{ status: string }>(url, `/status/${txHash}`, undefined, fetchImpl);
export const relayerSwapExecute = (url: string, req: SwapExecuteRequest, fetchImpl: typeof fetch = fetch) => call<SwapJob>(url, "/swap/execute", req, fetchImpl);
export const relayerSwapRefund = (url: string, req: SwapRefundRequest, fetchImpl: typeof fetch = fetch) => call<SwapJob>(url, "/swap/refund", req, fetchImpl);
export const relayerSwapStatus = (url: string, orderId: string, fetchImpl: typeof fetch = fetch) => call<SwapJob>(url, `/swap/${orderId}`, undefined, fetchImpl);

/** A refusal is the relayer's decision (4xx with a code); anything else (network, 5xx) is a reason to try the next relayer. */
export const isRefusal = (e: unknown): boolean => e instanceof RelayerRefusal && e.status < 500;

/**
 * Rule 5: never depend on one relayer. The first relayer in `urls` whose /info answers and serves
 * this chain / core wins; the fee note is then built for THAT relayer (its privacy address), so the
 * choice is made before proving. Returns null when none is reachable (the caller falls back to
 * self-submission or reports it).
 */
export async function pickRelayer(urls: string[], want: { chainId: number; core: Address }, fetchImpl: typeof fetch = fetch): Promise<{ url: string; info: RelayerInfo } | null> {
  const tried: string[] = [];
  for (const url of urls) {
    if (!url || tried.includes(url)) continue;
    tried.push(url);
    try {
      const info = await relayerInfo(url, fetchImpl);
      if (Number(info.chainId) === want.chainId && info.core.toLowerCase() === want.core.toLowerCase()) return { url, info };
    } catch {
      // unreachable or refusing: next
    }
  }
  return null;
}

/** The fee the wallet pays in the ETH vault: the relayer's live minimum plus a margin against a gas-price move between quote and submission. */
export const feeForRelayer = (info: RelayerInfo, marginBps = 1000): bigint => (BigInt(info.minFeeWei) * BigInt(10_000 + marginBps)) / 10_000n;

/** The fee in a given vault: live ETH pricing for the ETH vault, the relayer's fixed minimum (+ margin) for an accepted ERC-20 vault, null when the relayer takes no fees there. */
export function feeInVault(info: RelayerInfo, vault: Address, marginBps = 1000): bigint | null {
  if (vault.toLowerCase() === info.feeVault.toLowerCase()) return feeForRelayer(info, marginBps);
  const t = info.feeVaults?.find((v) => v.vault.toLowerCase() === vault.toLowerCase());
  return t ? (BigInt(t.minFee) * BigInt(10_000 + marginBps)) / 10_000n : null;
}

/** What the user sees for a swap job (plan §33: never "atomic"). */
export function swapJobStatus(s: SwapJobState): "Pending" | "Executing" | "Completed" | "Refunding" | "Refunded" | "Failed" {
  switch (s) {
    case "waiting-funding": return "Pending";
    case "executing": case "executed": return "Executing";
    case "completed": return "Completed";
    case "expired": case "refund-only": case "refunding": return "Refunding";
    case "refunded": return "Refunded";
    default: return "Failed";
  }
}
