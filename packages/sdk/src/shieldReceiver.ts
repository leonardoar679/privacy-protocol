// A same-chain swap into the protected balance (spec v2.0 §11.2; V6 Stage 12). The order's destination is a one-time
// shield receiver: a CREATE2 address of this deployment's ShieldReceiverFactory, out of which only the note this wallet
// commits can come — its owner commitment, a secret and a payload derived from the seed by a fresh note counter (so a
// wallet restored from its phrase finds the note: sdk/refunds.ts), the tip the relayer gets for shielding (the shield's
// gas at quote time, in the output asset), the delivery that pays it (a hundred tips), and a fresh address of this wallet
// for a token the pool cannot hold. Everything is fixed before the order is committed and journaled with it; the
// receiver is recomputed from the journal and this wallet's own factory before the provider call is signed, and the
// executor's shield job is registered before the execution is handed over.
import type { Address, Hex } from "viem";
import { predictReceiver, receiverParamsJson, receiverParamsOf, receiverParamsProblem, shieldMinAmount, type ReceiverParams } from "@privacy-wallet/contracts";
import type { Deployment } from "./chain";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { deriveShieldNote } from "./keys/swapKeys";
import { mainOwnerCommitment } from "./keys/ownerKeys";
import type { StoredShield, StoredSwap } from "./wallet/journal";
import type { ShieldJob, ShieldRegisterRequest } from "./relayer";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const randomHex32 = (): Hex => ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Thrown when a journaled receipt does not recompute to the receiver the order pays (a wallet never signs then). */
export class ShieldReceiptMismatch extends Error {
  constructor(detail: string) {
    super(`the shield receiver is not the one this wallet committed (${detail}) — not signing it`);
    this.name = "ShieldReceiptMismatch";
  }
}

/** Whether this deployment can receive `asset` (the registry's token address, or "native") into the protected balance. */
export function protectable(deployment: Deployment | null, asset: string): boolean {
  if (!deployment?.shieldFactory) return false;
  return asset === "native" || (deployment.erc20Vaults ?? []).some((v) => same(v.token, asset));
}

export interface ReceiptInput {
  masterSeed: Uint8Array;
  deployment: Deployment;
  /** a fresh note counter (noteStore.allocateCounter()): the note's secret and payload derive from it */
  counter: number;
  /** the output asset: "native" (ETH) or its token address */
  asset: string;
  /** the quote's shield tip, in the output asset's base units */
  shieldTip: bigint;
  /** a fresh address of this wallet: where a token the pool has no vault for can only go */
  fallbackRecipient: Address;
  receiptId?: Hex;
}

/** The receipt a same-chain swap names as its destination, ready to journal (StoredSwap.shield). */
export function buildShieldReceipt(i: ReceiptInput): StoredShield {
  const factory = i.deployment.shieldFactory;
  if (!factory) throw new Error("this deployment names no shield receiver factory (VITE_SHIELD_FACTORY): a swap cannot deliver into the protected balance");
  if (!protectable(i.deployment, i.asset)) throw new Error(`the pool cannot hold ${i.asset}: it cannot be received into the protected balance`);
  const note = deriveShieldNote(i.masterSeed, i.counter); // made out to its own owner commitment (swapKeys.ts committedNote)
  const params: ReceiverParams = {
    receiptId: i.receiptId ?? randomHex32(),
    asset: i.asset === "native" ? ZERO : (i.asset as Address),
    minAmount: shieldMinAmount(i.shieldTip),
    shieldTip: i.shieldTip,
    ownerCommitment: note.ownerCommitment,
    noteSecret: note.noteSecret,
    noteDataHash: note.noteDataHash,
    fallbackRecipient: i.fallbackRecipient,
  };
  const problem = receiverParamsProblem(params);
  if (problem) throw new Error(`the shield receiver cannot be built: ${problem}`);
  return { factory, receiver: predictReceiver(factory, params), params: receiverParamsJson(params), counter: i.counter, noteData: note.noteData };
}

/**
 * The receiver a journaled order pays, recomputed from this wallet's own factory and the journaled parameters: it must be
 * the order's destination, and the note it deposits must be this seed's for the journaled counter — made out to its own
 * owner commitment, or (an order an older build committed, whose refund is made out to it too) the privacy address's.
 */
export function checkShieldReceipt(stored: Pick<StoredSwap, "shield" | "request" | "params">, deployment: Deployment, masterSeed?: Uint8Array): Address {
  const sh = stored.shield;
  if (!sh) throw new ShieldReceiptMismatch("the order journals no receipt");
  if (!deployment.shieldFactory || !same(sh.factory, deployment.shieldFactory))
    throw new ShieldReceiptMismatch(`its factory ${sh.factory} is not this deployment's`);
  const params = receiverParamsOf(sh.params as StoredShield["params"] & { receiptId: Hex; asset: Address; noteDataHash: Hex; fallbackRecipient: Address });
  const receiver = predictReceiver(deployment.shieldFactory, params);
  if (!same(receiver, sh.receiver)) throw new ShieldReceiptMismatch(`the parameters give ${receiver}, the journal names ${sh.receiver}`);
  const destination = (stored.request as { destination?: string } | undefined)?.destination ?? "";
  if (!same(receiver, destination)) throw new ShieldReceiptMismatch(`the order pays ${destination}, not the receiver ${receiver}`);
  if (masterSeed) {
    const note = deriveShieldNote(masterSeed, sh.counter);
    // the audit round of 2026-10-16 (c18): a receipt journaled before deposits had their own owner commitments names the
    // privacy address's, as its order's refund does; accepted for such an order only, never for one made out to its own
    const main = mainOwnerCommitment(deriveKeys(masterSeed));
    const refundOc = (stored.params as { refundOwnerCommitment?: unknown } | undefined)?.refundOwnerCommitment;
    const olderOrder = params.ownerCommitment === main && typeof refundOc === "string" && /^[0-9]+$/.test(refundOc) && BigInt(refundOc) === main;
    if (
      (note.ownerCommitment !== params.ownerCommitment && !olderOrder) ||
      note.noteSecret !== params.noteSecret ||
      !same(note.noteDataHash, params.noteDataHash) ||
      !same(note.noteData, sh.noteData)
    )
      throw new ShieldReceiptMismatch("its note is not this wallet's");
  }
  return receiver;
}

/** What the journal keeps of the executor's shield job: its state, the last shield's leaf, deposit and tip. */
export function shieldJobView(job: ShieldJob, now = Date.now()): NonNullable<StoredShield["job"]> {
  const last = job.shields?.[job.shields.length - 1];
  return {
    state: job.state,
    at: now,
    ...(last?.leafIndex !== undefined ? { leafIndex: last.leafIndex } : {}),
    ...(last?.txHash ? { txHash: last.txHash } : {}),
    ...(last?.amount ? { amount: last.amount } : {}),
    ...(last?.tip ? { tip: last.tip } : {}),
    ...(job.error ? { error: job.error.slice(0, 200) } : {}),
  };
}

/** The shield job an executor watches: the receipt, and until when the swap can still deliver (the order's refundAfter). */
export function shieldJobRequest(stored: StoredSwap): ShieldRegisterRequest {
  const sh = stored.shield;
  if (!sh) throw new Error("this order journals no shield receipt");
  return {
    factory: sh.factory as Address,
    params: sh.params as ShieldRegisterRequest["params"],
    noteData: sh.noteData as Hex,
    deliverBy: Number((stored.params as { refundAfter: number }).refundAfter),
    ...(sh.vouch ? { vouch: sh.vouch as Hex } : {}), // the swap service's, from the commit: the executor shields only a vouched receipt
  };
}
