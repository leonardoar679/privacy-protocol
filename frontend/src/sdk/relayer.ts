// Client of a relayer (services/relayer): private submission of a proven transact, paid by a
// private fee note to the relayer's privacy address, and the swap-order executor (deploy + execute
// a funded escrow, refund after the window). Any URL works; the wallet keeps self-submission as the
// fallback (plan §85 rule 5). The relayer never receives keys — only proofs, public inputs,
// payloads, the fee note's opening (its own note), signed executions and refund payloads.
import type { Address, Hex } from "viem";

export const DEFAULT_RELAYER_URL: string = (import.meta as any).env?.VITE_RELAYER_URL ?? "http://127.0.0.1:8790";

export interface RelayerInfo {
  chainId: number; core: Address; feeVault: Address; relayer: Address; privacyAddress: string;
  minFeeWei: string; gasPriceWei: string; gasEstimate: string; feeMarginBps: number; requireReadableFeePayload: boolean; inflight: number;
}
export interface RelayerSubmitRequest { proof: Hex; publicInputs: string[]; noteData: [Hex, Hex, Hex]; fee: { outputIndex: 0 | 1 | 2; amount: string; noteSecret: string } }
export interface RelayerSubmitResult { txHash: Hex; feeWei: string; gas: string; feePayloadReadable: boolean }

/** A swap order handed to the executor: the escrow's params, the one-time key's signed execution, the committed refund payload. */
export interface SwapExecuteRequest {
  factory: Address;
  params: { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string };
  execution: { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex };
  refundNoteData: Hex;
}
export type SwapJobState = "waiting-funding" | "expired" | "executing" | "executed" | "execute-failed" | "refunding" | "refunded" | "refund-failed" | "completed";
export interface SwapJob { id: string; escrow: Address; state: SwapJobState; txHash?: Hex; error?: string; balance?: string; updatedAt: number }

async function call<T>(url: string, path: string, body: unknown | undefined, fetchImpl: typeof fetch): Promise<T> {
  const r = await fetchImpl(url.replace(/\/$/, "") + path, {
    method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit", redirect: "error",
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { j = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(`relayer: ${j.error ?? r.status}${j.code ? ` (${j.code})` : ""}`);
  return j as T;
}

export const relayerInfo = (url: string, fetchImpl: typeof fetch = fetch) => call<RelayerInfo>(url, "/info", undefined, fetchImpl);
export const relayerSubmit = (url: string, req: RelayerSubmitRequest, fetchImpl: typeof fetch = fetch) => call<RelayerSubmitResult>(url, "/submit", req, fetchImpl);
export const relayerStatus = (url: string, txHash: Hex, fetchImpl: typeof fetch = fetch) => call<{ status: string }>(url, `/status/${txHash}`, undefined, fetchImpl);
export const relayerSwapExecute = (url: string, req: SwapExecuteRequest, fetchImpl: typeof fetch = fetch) => call<SwapJob>(url, "/swap/execute", req, fetchImpl);
export const relayerSwapStatus = (url: string, orderId: string, fetchImpl: typeof fetch = fetch) => call<SwapJob>(url, `/swap/${orderId}`, undefined, fetchImpl);

/** The fee the wallet pays: the relayer's live minimum plus a margin against a gas-price move between quote and submission. */
export const feeForRelayer = (info: RelayerInfo, marginBps = 1000): bigint => (BigInt(info.minFeeWei) * BigInt(10_000 + marginBps)) / 10_000n;

/** What the user sees for a swap job (plan §33: never "atomic"). */
export function swapJobStatus(s: SwapJobState): "Pending" | "Executing" | "Completed" | "Refunding" | "Refunded" | "Failed" {
  switch (s) {
    case "waiting-funding": return "Pending";
    case "executing": case "executed": return "Executing";
    case "completed": return "Completed";
    case "expired": case "refunding": return "Refunding";
    case "refunded": return "Refunded";
    default: return "Failed";
  }
}
