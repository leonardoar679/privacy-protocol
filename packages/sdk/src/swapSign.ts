// The last gate before the one-time order key signs (spec v1.1 §2, §5). The wallet's own journal is the
// reference, not the service's echo of it: the escrow is recomputed from the journaled params and this
// wallet's factory; the digest must be the digest of exactly the call shown, within the order's limits
// (swapGuard.checkPrepared); the call must do what the wallet asked for (providerCall); and it must
// guarantee at least the minimum the user approved, or the user is asked again. V6 Stage 12: a same-chain swap into the
// protected balance pays a shield receiver, recomputed here from the journal and this wallet's factory (sdk/shieldReceiver.ts).
import type { Address } from "viem";
import type { Deployment } from "./chain";
import { checkShieldReceipt } from "./shieldReceiver";
import type { StoredShield } from "./wallet/journal";
import { checkPrepared, predictEscrow } from "./swapGuard";
import { checkMinimum, checkProviderCall, MinimumMoved, ProviderCallMismatch, type ActiveVaultLookup, type CallExpectation, type CheckedCall, type InboundLookup, type ProviderName } from "./providerCall";
import type { AssetRef, Policy, Prepared, ServiceOrder, ServiceOrderParams } from "./swapService";

/** What the wallet journaled when it committed the order (wallet/journal.ts StoredSwap). */
export interface JournaledOrder {
  request: { from: AssetRef; to: AssetRef; destination: string };
  params: ServiceOrderParams;
  policy: Policy;
  approvedMin?: string;
  quote?: { toAmountMin?: string; refundTarget?: string };
  /** the route the order was committed on (the quote's provider, checked at the commit against the one reviewed) */
  provider?: string;
  /** V6 Stage 12: the shield receiver a same-chain swap into the protected balance pays */
  shield?: StoredShield;
}

/** The provider contract a quote's route calls (the eleventh review round, D11-4): Across's swap leg is quoted as "uniswap-across". */
export const ROUTE_CALLS: Record<string, ProviderName> = { thorchain: "thorchain", chainflip: "chainflip", mayan: "mayan", lifi: "lifi", across: "across", "uniswap-across": "across" };

/** The order's record lacks what signing needs — the minimum it approved: never signed, and before its funding never funded (D11-7). */
export class RecordIncomplete extends Error {
  readonly code = "call_refused";
  constructor(detail: string) {
    super(detail);
    this.name = "RecordIncomplete";
  }
}

export type SignCheck =
  | { ok: true; escrow: Address; params: ServiceOrderParams; call: CheckedCall }
  | { ok: false; moved: MinimumMoved };

export async function checkBeforeSigning(a: {
  prepared: Prepared; order: ServiceOrder; journaled: JournaledOrder; factory: Address; chainId: bigint;
  /** the user consented to this lower minimum after a MinimumMoved */
  acceptMin?: bigint; inbound?: InboundLookup; active?: ActiveVaultLookup; now?: number;
  /** tokens the pool has a vault for (the wallet's configured ERC-20 assets, with their symbols and decimals) */
  pooled?: CallExpectation["pooled"];
  /** V6 Stage 12: the deployment whose shield receiver factory a protected destination must recompute from, and the seed its note derives from */
  deployment?: Deployment;
  masterSeed?: Uint8Array;
  /** this wallet's own agreed, fresh prices by symbol (prices.ts agreedUsd): a swap-first Mayan leg is bounded against them (the third review round, 2026-11-03) */
  usd?: Record<string, bigint>;
}): Promise<SignCheck> {
  const { params, request, policy } = a.journaled;
  if (a.journaled.shield) {
    if (!a.deployment) throw new Error("the shield receiver cannot be recomputed without the deployment — not signing it");
    checkShieldReceipt(a.journaled, a.deployment, a.masterSeed); // the destination is this wallet's receiver, or nothing is signed
  }
  const escrow = predictEscrow(a.factory, params);
  checkPrepared(a.prepared, { ...a.order, orderId: params.orderId, endpoint: escrow, params }, a.chainId, a.now);
  const call = await checkProviderCall(
    { provider: a.prepared.provider, value: BigInt(a.prepared.value), calldata: a.prepared.calldata },
    { escrow, from: request.from, to: request.to, destination: request.destination, net: BigInt(params.amount) - BigInt(params.executorTip), policy, chainId: a.chainId, now: a.now, pooled: a.pooled, usd: a.usd },
    { inbound: a.inbound, active: a.active },
  );
  // the route the user reviewed (the eleventh review round, D11-4): the call is the committed provider's, and it refunds at the destination only
  // where the reviewed quote said so — a service had prepared a Mayan Fast-MCTP call for an order reviewed on THORChain, whose refund then
  // landed as USDC at the fresh address, outside the pool, while the record went on tracking THORChain
  const route = a.journaled.provider;
  if (route !== undefined && ROUTE_CALLS[route] !== call.provider)
    throw new ProviderCallMismatch(call.provider, "provider", `the call is ${call.provider}'s, while the order you reviewed and committed runs on ${route}`);
  if (call.refundTo === "destination" && a.journaled.quote?.refundTarget !== "destination")
    throw new ProviderCallMismatch(call.provider, "refund", "a failure would refund at your destination address, outside the pool, while the order you committed refunds to your protected balance");
  // never a default of zero (the third review round, 2026-11-03): a record without the minimum it approved signs nothing
  const recorded = a.journaled.approvedMin ?? a.journaled.quote?.toAmountMin;
  if (a.acceptMin === undefined && recorded === undefined) throw new RecordIncomplete("the minimum you approved is not in this order's record: not signing it");
  const approved = a.acceptMin ?? BigInt(recorded!);
  try { checkMinimum(call, approved); } catch (e) { if (e instanceof MinimumMoved) return { ok: false, moved: e }; throw e; }
  return { ok: true, escrow, params, call };
}
