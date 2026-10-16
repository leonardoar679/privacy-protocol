// What the wallet checks before it trusts the swap service with money (spec v1.1 §2 "the order object is
// wallet-side and canonical", §6). The service picks routes and builds provider calls; it must never be
// able to take the funds itself. So, with nothing but the wallet's own configuration:
//  - the escrow address the private withdrawal funds is recomputed here (CREATE2, exactly as
//    SwapOrderFactory.predict) from the order params, the wallet's factory (VITE_SWAP_FACTORY) and the
//    escrow's creation code bundled from the contracts' artifact — a service that names any other
//    address, e.g. its own, is refused before a withdrawal is built;
//  - the params carry THIS wallet's one-time order signer and refund note, the amount and asset it
//    asked for, the asset's canonical vault for refunds, a tip within the contract's 1 % cap and (V6, spec v2.0 §3)
//    within three times this wallet's own estimate of the execution's gas (./executionCost.ts), and
//    deadlines that let a failed order come back within days;
//  - the digest the order key signs is recomputed from the provider call it authorizes, the call's
//    deadline is within the order's, and it forwards no more value than the escrow can spend.
// What stays with the service (and its adapters' local calldata checks): that the provider call pays the
// right receiver with an acceptable minimum. Run the service yourself or use one you trust for that.
import { concat, encodeAbiParameters, getAddress, isAddress, keccak256, slice, stringToBytes, type Address, type Hex } from "viem";
import { BYTECODE } from "@privacy-wallet/contracts";
import type { Asset } from "./assets";
import type { Prepared, ServiceOrder, ServiceOrderParams } from "./swapService";

/** SwapOrderEscrow's creation code (constructor arguments are the abi-encoded OrderParams). */
export const ESCROW_CREATION_CODE: Hex = BYTECODE.swapOrderEscrow;
export const EXECUTE_TAG = keccak256(stringToBytes("privacy-protocol/v1.1/swap-order/execute"));
export const TIP_DIVISOR = 100n; // SwapOrderTypes.TIP_DIVISOR: executorTip <= amount / 100
export const MAX_REFUND_HORIZON_SECONDS = 7 * 24 * 3600; // a failed order must be refundable within a week

export class OrderMismatch extends Error {
  constructor(public readonly field: string, detail: string) {
    super(`the swap service's order does not match what this wallet asked for (${field}: ${detail}) — not using it`);
  }
}

const ORDER_PARAMS = [
  { type: "bytes32" }, { type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint64" },
  { type: "uint64" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" },
] as const;

/** abi.encode(OrderParams): a static struct, 12 words. */
export function encodeOrderParams(p: ServiceOrderParams): Hex {
  return encodeAbiParameters(ORDER_PARAMS, [
    p.orderId, Number(p.assetType), p.asset, BigInt(p.amount), p.orderSigner, BigInt(p.executeDeadline), BigInt(p.refundAfter),
    p.refundVault, BigInt(p.refundOwnerCommitment), BigInt(p.refundNoteSecret), p.refundNoteDataHash, BigInt(p.executorTip),
  ]);
}

/** address(uint160(uint256(keccak256(0xff ‖ factory ‖ orderId ‖ keccak256(creationCode ‖ abi.encode(params)))))) */
export function predictEscrow(factory: Address, p: ServiceOrderParams, creationCode: Hex = ESCROW_CREATION_CODE): Address {
  const initCodeHash = keccak256(concat([creationCode, encodeOrderParams(p)]));
  return getAddress(slice(keccak256(concat(["0xff", factory, p.orderId, initCodeHash])), 12));
}

/** SwapOrderEscrow.executionDigest: keccak256(abi.encode(EXECUTE_TAG, chainId, escrow, orderId, provider, value, keccak256(calldata), deadline)). */
export function executionDigestFromHash(chainId: bigint, escrow: Address, orderId: Hex, provider: Address, value: bigint, calldataHash: Hex, deadline: number): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
    [EXECUTE_TAG, chainId, escrow, orderId, provider, value, calldataHash, BigInt(deadline)],
  ));
}
export const executionDigest = (chainId: bigint, escrow: Address, orderId: Hex, provider: Address, value: bigint, calldata: Hex, deadline: number): Hex =>
  executionDigestFromHash(chainId, escrow, orderId, provider, value, keccak256(calldata), deadline);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

export interface OrderExpectation {
  factory: Address;
  orderSigner: Address;
  refund: { ownerCommitment: bigint; noteSecret: bigint; noteDataHash: Hex };
  amount: bigint;
  asset: Asset;
  /** V6 (spec v2.0 §3): three times this wallet's own estimate of the execution's gas (executionCost.tipCeiling); null or absent: no estimate, the 1 % cap alone */
  maxTip?: bigint | null;
  now?: number; // unix seconds (tests)
}

/** The swap service's vouch for an order (a V6 follow-up of 2026-10-16): the tag it signs under. */
export const ORDER_VOUCH_TAG = keccak256(stringToBytes("privacy-wallet/v6/api-vouch/order"));
/** keccak256(abi.encode(ORDER_VOUCH_TAG, chainId, escrow)): the engine's orderVouchDigest, byte for byte (both pinned by tests) */
export const orderVouchDigest = (chainId: bigint, escrow: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], [ORDER_VOUCH_TAG, chainId, escrow]));

/** Throws OrderMismatch unless the order is exactly the one this wallet asked for, at the escrow its params determine. */
export function checkOrder(order: ServiceOrder, e: OrderExpectation): void {
  const p = order.params;
  const now = e.now ?? Math.floor(Date.now() / 1000);
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.orderId) || !same(p.orderId, order.orderId)) throw new OrderMismatch("orderId", "malformed or inconsistent");
  if (!same(p.orderSigner, e.orderSigner)) throw new OrderMismatch("orderSigner", `${p.orderSigner} is not this order's one-time key`);
  if (BigInt(p.refundOwnerCommitment) !== e.refund.ownerCommitment || BigInt(p.refundNoteSecret) !== e.refund.noteSecret || !same(p.refundNoteDataHash, e.refund.noteDataHash)) {
    throw new OrderMismatch("refund note", "a failed order would not come back to this wallet");
  }
  if (BigInt(p.amount) !== e.amount) throw new OrderMismatch("amount", `${p.amount} != ${e.amount}`);
  const wantType = e.asset.token ? 1 : 0;
  if (Number(p.assetType) !== wantType || !same(p.asset, e.asset.token ?? ZERO)) throw new OrderMismatch("asset", `${p.assetType}:${p.asset} is not ${e.asset.symbol}`);
  if (!same(p.refundVault, e.asset.vault)) throw new OrderMismatch("refundVault", `${p.refundVault} is not the canonical ${e.asset.symbol} vault`);
  if (BigInt(p.executorTip) > BigInt(p.amount) / TIP_DIVISOR) throw new OrderMismatch("executorTip", "above 1 % of the amount");
  if (e.maxTip !== undefined && e.maxTip !== null && BigInt(p.executorTip) > e.maxTip) throw new OrderMismatch("executorTip", `${p.executorTip} is more than three times this wallet's own estimate of the execution's gas`);
  if (p.executeDeadline <= now) throw new OrderMismatch("executeDeadline", "already passed");
  if (p.refundAfter < p.executeDeadline || p.refundAfter - now > MAX_REFUND_HORIZON_SECONDS) throw new OrderMismatch("refundAfter", "the refund would be locked too long or before the deadline");
  const predicted = predictEscrow(e.factory, p);
  if (!isAddress(order.endpoint) || !same(order.endpoint, predicted)) throw new OrderMismatch("endpoint", `${order.endpoint} is not the escrow these params create (${predicted})`);
}

/** Throws OrderMismatch unless `prepared.digest` is the digest of exactly the call it describes, within the order's limits. */
export function checkPrepared(prepared: Prepared, order: ServiceOrder, chainId: bigint, now = Math.floor(Date.now() / 1000)): void {
  const p = order.params;
  if (!isAddress(prepared.provider) || same(prepared.provider, ZERO) || same(prepared.provider, order.endpoint)) throw new OrderMismatch("provider", `${prepared.provider} is not a provider address`);
  if (prepared.deadline > p.executeDeadline || prepared.deadline <= now) throw new OrderMismatch("deadline", "outside the order's execution window");
  const value = BigInt(prepared.value);
  const spendable = Number(p.assetType) === 0 ? BigInt(p.amount) - BigInt(p.executorTip) : 0n;
  if (value > spendable) throw new OrderMismatch("value", `${value} exceeds what the escrow may forward (${spendable})`);
  const digest = executionDigest(chainId, order.endpoint, order.orderId, prepared.provider, value, prepared.calldata, prepared.deadline);
  if (!same(digest, prepared.digest)) throw new OrderMismatch("digest", "it is not the digest of the call it describes");
}
