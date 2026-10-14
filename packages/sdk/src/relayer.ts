// Client of a relayer (apps/relayer): private submission of a proven transact, paid by a
// private fee note to the relayer's privacy address, the swap-order executor (deploy + execute
// a funded escrow, refund after the window) and (V6 Stage 12) the shield executor (deploy a same-chain swap's
// receiver and shield its delivery). Any URL works; the wallet keeps a list of relayers and
// self-submission as fallbacks (plan §85 rule 5). The relayer never receives keys — only proofs,
// public inputs, payloads, the fee note's opening (its own note), signed executions and refund payloads.
import { feeForWithdrawal } from "@privacy-wallet/protocol/wallet/fees";
import { fetchFor } from "@privacy-wallet/privacy-engine/transport/http"; // V5 (spec §7): the policy fetch is the default implementation
const relayerFetch: typeof fetch = fetchFor("relayer");
import type { Address, Hex } from "viem";
import type { ReceiverParamsJson } from "@privacy-wallet/contracts";
import { config } from "./config";

export const defaultRelayerUrl = (): string => config().relayer.url;
/** Further relayers to try when the first is unreachable (VITE_RELAYER_URLS, comma-separated; the first entry is the default). */
export const relayerFallbacks = (): string[] => config().relayer.fallbacks.filter((u) => u !== defaultRelayerUrl());

export interface RelayerFeeVault { vault: Address; symbol: string; decimals: number; minFee: string }
export interface RelayerInfo {
  chainId: number; core: Address; feeVault: Address; relayer: Address; privacyAddress: string;
  minFeeWei: string; gasPriceWei: string; gasEstimate: string; feeMarginBps: number; requireReadableFeePayload: boolean; inflight: number;
  /** ERC-20 vaults the relayer takes fee notes in, with fixed minimums (plan §36) */
  feeVaults?: RelayerFeeVault[];
  /** V5 (spec §10): the privacy fee in basis points of a delivered amount (absent or 0: none) and the floor it never goes below */
  feePercentBps?: number;
  feeMinimumWei?: string;
  /** V6 Stage 12: the ShieldReceiverFactory this relayer shields for (absent: no shield executor) */
  shieldFactory?: Address;
}
export interface RelayerSubmitRequest { proof: Hex; publicInputs: string[]; noteData: [Hex, Hex, Hex]; fee: { outputIndex: 0 | 1 | 2; amount: string; noteSecret: string; vault?: Address } }
export interface RelayerSubmitResult { txHash: Hex; feeWei: string; feeVault?: Address; gas: string; feePayloadReadable: boolean }

/** A swap order handed to the executor: the escrow's params, the one-time key's signed execution, the committed refund payload. */
export interface SwapExecuteRequest {
  factory: Address;
  params: { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string };
  execution: { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex };
  refundNoteData: Hex;
  /** tokens other than the order's asset the provider call may pay back to the escrow: the executor re-shields them through refundToken */
  refundTokens?: Address[];
  /** per listed token (lowercase), the least balance worth a re-shield after execution, in base units (PP-S12) */
  refundFloors?: Record<string, string>;
}
/** A funded order the wallet will not execute: the executor re-shields it after the window (no execution needed). */
export type SwapRefundRequest = Omit<SwapExecuteRequest, "execution">;
export type SwapJobState = "waiting-funding" | "expired" | "refund-only" | "executing" | "executed" | "execute-failed" | "refunding" | "refunded" | "refund-failed" | "completed";
/** `executionTx`: the deployAndExecute transaction (whale spec §19), set once; `txHash` is reused by the executor's refund transactions. */
export interface SwapJob { id: string; escrow: Address; state: SwapJobState; txHash?: Hex; executionTx?: Hex; error?: string; balance?: string; updatedAt: number }
/** V6 Stage 12 (spec v2.0 §11.2): a same-chain swap's receipt for the shield executor; `deliverBy` the order's refundAfter. */
export interface ShieldRegisterRequest { factory: Address; params: ReceiverParamsJson; noteData: Hex; deliverBy: number }
export type ShieldJobState = "waiting-delivery" | "shielding" | "shielded" | "shield-failed" | "expired";
/** Each mined shield: the deposit's leaf, the amount deposited and the tip paid (the receipt asset's base units). */
export interface ShieldJob { id: string; receiver: Address; state: ShieldJobState; paid?: boolean; shields?: { txHash: Hex; leafIndex?: number; amount?: string; tip?: string; at: number }[]; error?: string; balance?: string; updatedAt: number }

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

export const relayerInfo = (url: string, fetchImpl: typeof fetch = relayerFetch) => call<RelayerInfo>(url, "/info", undefined, fetchImpl);
export const relayerSubmit = (url: string, req: RelayerSubmitRequest, fetchImpl: typeof fetch = relayerFetch) => call<RelayerSubmitResult>(url, "/submit", req, fetchImpl);
export const relayerStatus = (url: string, txHash: Hex, fetchImpl: typeof fetch = relayerFetch) => call<{ status: string }>(url, `/status/${txHash}`, undefined, fetchImpl);
export const relayerSwapExecute = (url: string, req: SwapExecuteRequest, fetchImpl: typeof fetch = relayerFetch) => call<SwapJob>(url, "/swap/execute", req, fetchImpl);
export const relayerSwapRefund = (url: string, req: SwapRefundRequest, fetchImpl: typeof fetch = relayerFetch) => call<SwapJob>(url, "/swap/refund", req, fetchImpl);
export const relayerSwapStatus = (url: string, orderId: string, fetchImpl: typeof fetch = relayerFetch) => call<SwapJob>(url, `/swap/${orderId}`, undefined, fetchImpl);
export const relayerShieldRegister = (url: string, req: ShieldRegisterRequest, fetchImpl: typeof fetch = relayerFetch) => call<ShieldJob>(url, "/shield", req, fetchImpl);
export const relayerShieldStatus = (url: string, receiptId: string, fetchImpl: typeof fetch = relayerFetch) => call<ShieldJob>(url, `/shield/${receiptId}`, undefined, fetchImpl);

/**
 * V6 Stage 15 (doc §75): the relayer's job spending these nullifiers, if it has one — how a submission whose answer was
 * lost is found again instead of being sent twice (the relayer refuses a second one with `nullifier_in_flight`).
 */
export async function relayerJobFor(url: string, nullifiers: [bigint, bigint], fetchImpl: typeof fetch = relayerFetch): Promise<{ txHash: Hex } | null> {
  try {
    const job = await call<{ txHash?: unknown }>(url, `/jobs/by-nullifier/${nullifiers[0].toString(10)}`, undefined, fetchImpl);
    return typeof job.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(job.txHash) ? { txHash: job.txHash as Hex } : null;
  } catch (e) {
    if (e instanceof RelayerRefusal && e.status === 404) return null;
    throw e;
  }
}

/** A refusal is the relayer's decision (4xx with a code); anything else (network, 5xx) is a reason to try the next relayer. */
export const isRefusal = (e: unknown): boolean => e instanceof RelayerRefusal && e.status < 500;

/**
 * Rule 5: never depend on one relayer. The first relayer in `urls` whose /info answers and serves
 * this chain / core wins; the fee note is then built for THAT relayer (its privacy address), so the
 * choice is made before proving. Returns null when none is reachable (the caller falls back to
 * self-submission or reports it).
 */
export async function pickRelayer(urls: string[], want: { chainId: number; core: Address }, fetchImpl: typeof fetch = relayerFetch): Promise<{ url: string; info: RelayerInfo } | null> {
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
export function feeInVault(info: RelayerInfo, vault: Address, marginBps = 1000, delivered?: bigint): bigint | null {
  let minimum: bigint | null;
  if (vault.toLowerCase() === info.feeVault.toLowerCase()) minimum = feeForRelayer(info, marginBps);
  else { const t = info.feeVaults?.find((v) => v.vault.toLowerCase() === vault.toLowerCase()); minimum = t ? (BigInt(t.minFee) * BigInt(10_000 + marginBps)) / 10_000n : null; }
  if (minimum === null) return null;
  // V6 (spec v2.0 §3): a withdrawal of W pays p(A*) + F with A* = W + f — the percentage of what leaves on top of the
  // minimum, a swap's escrow funding included; without a public amount (a merge, a transfer) the minimum alone
  return delivered === undefined ? minimum : feeForWithdrawal(delivered, { minimum, feePercentBps: info.feePercentBps ?? 0 });
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
