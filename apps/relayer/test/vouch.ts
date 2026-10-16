// The swap service's vouches in the relayer's tests (a V6 follow-up of 2026-10-16, audit gap 47): a test key stands for
// API_VOUCH_KEY, its address for API_VOUCHER.
import type { Hex } from "viem";
import { executionVouchDigest, orderSignerAddress, orderVouchDigest, predictEscrow, signExecution } from "@privacy-wallet/swap-engine/endpoints";
import { toEngineParams, type SwapJobRequest, type SwapRefundRequest } from "../src/swapExecutor";

export const VOUCH_KEY = new Uint8Array(32).fill(0x5a);
export const VOUCHER = orderSignerAddress(VOUCH_KEY);

/** `r` with the vouch the API gives it: the call's for an execution, the order's for a refund; `key` another's to forge one */
export function vouched<R extends SwapJobRequest | SwapRefundRequest>(
  r: R,
  chainId: number,
  creationCode: Hex,
  key: Uint8Array = VOUCH_KEY,
): R & { vouch: { execution?: Hex; order?: Hex } } {
  const escrow = predictEscrow(r.factory, creationCode, toEngineParams(r.params));
  const x = (r as Partial<SwapJobRequest>).execution;
  const vouch = x
    ? { execution: signExecution(key, executionVouchDigest(BigInt(chainId), escrow, x.provider, BigInt(x.value), x.providerCalldata, Number(x.deadline))) }
    : { order: signExecution(key, orderVouchDigest(BigInt(chainId), escrow)) };
  return { ...r, vouch };
}
