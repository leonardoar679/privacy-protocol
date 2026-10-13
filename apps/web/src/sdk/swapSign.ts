// The last gate before the one-time order key signs (spec v1.1 §2, §5). The wallet's own journal is the
// reference, not the service's echo of it: the escrow is recomputed from the journaled params and this
// wallet's factory; the digest must be the digest of exactly the call shown, within the order's limits
// (swapGuard.checkPrepared); the call must do what the wallet asked for (providerCall); and it must
// guarantee at least the minimum the user approved, or the user is asked again.
import type { Address } from "viem";
import { checkPrepared, predictEscrow } from "./swapGuard";
import { checkMinimum, checkProviderCall, MinimumMoved, type CheckedCall, type InboundLookup } from "./providerCall";
import type { AssetRef, Policy, Prepared, ServiceOrder, ServiceOrderParams } from "./swapService";

/** What the wallet journaled when it committed the order (wallet/journal.ts StoredSwap). */
export interface JournaledOrder {
  request: { from: AssetRef; to: AssetRef; destination: string };
  params: ServiceOrderParams;
  policy: Policy;
  approvedMin?: string;
  quote?: { toAmountMin?: string };
}

export type SignCheck =
  | { ok: true; escrow: Address; params: ServiceOrderParams; call: CheckedCall }
  | { ok: false; moved: MinimumMoved };

export async function checkBeforeSigning(a: {
  prepared: Prepared; order: ServiceOrder; journaled: JournaledOrder; factory: Address; chainId: bigint;
  /** the user consented to this lower minimum after a MinimumMoved */
  acceptMin?: bigint; inbound?: InboundLookup; now?: number;
  /** tokens the pool has a vault for (the wallet's configured ERC-20 assets) */
  pooled?: string[];
}): Promise<SignCheck> {
  const { params, request, policy } = a.journaled;
  const escrow = predictEscrow(a.factory, params);
  checkPrepared(a.prepared, { ...a.order, orderId: params.orderId, endpoint: escrow, params }, a.chainId, a.now);
  const call = await checkProviderCall(
    { provider: a.prepared.provider, value: BigInt(a.prepared.value), calldata: a.prepared.calldata },
    { escrow, from: request.from, to: request.to, destination: request.destination, net: BigInt(params.amount) - BigInt(params.executorTip), policy, chainId: a.chainId, now: a.now, pooled: a.pooled },
    { inbound: a.inbound },
  );
  const approved = a.acceptMin ?? BigInt(a.journaled.approvedMin ?? a.journaled.quote?.toAmountMin ?? "0");
  try { checkMinimum(call, approved); } catch (e) { if (e instanceof MinimumMoved) return { ok: false, moved: e }; throw e; }
  return { ok: true, escrow, params, call };
}
