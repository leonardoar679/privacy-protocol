// Funding a committed swap order (spec v1.1 §5, §8; V2 Stage 4): the private withdrawal that pays the
// one-time escrow, run either by the user ("Fund now") or by the scheduler at the drawn time — from any
// tab, since the runner lives at the App level. Every check the Swap screen made stays here: the escrow
// is recomputed from the wallet's own factory and the journaled params before a single note is spent,
// and an order that is no longer open (abandoned, already funded) is never funded.
import { recoverAddress, TransactionNotFoundError, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import { clientFor, type Deployment } from "./chain";
import { privateWithdrawal, type Submitted } from "./privateTx";
import { coreAbi } from "./privacyProtocol";
import { relayerInfo, relayerJobFor, relayerRunsFor, type RelayerInfo } from "./relayer";
import { swapService, type ServiceHealth } from "./swapService";
import { settings } from "./wallet/settings";
import type { OnEvent } from "./operations/engineEvents";
import { assetsOf, type Asset } from "./assets";
import { OrderMismatch, orderVouchDigest, predictEscrow } from "./swapGuard";
import { noteStore } from "./wallet/notes";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { mainOwnerCommitment } from "./keys/ownerKeys";
import { session as defaultSession, type WalletSession } from "./wallet/session";
import type { FundingAttempt, ScheduledAction, StoredSwap } from "./wallet/journal";
import { activityId, updateActivity } from "./wallet/activity";
import { cancelAction, schedulerStatus } from "./wallet/schedule";
import { runHousekeepingStep } from "./wallet/housekeeping";

export const CLOSED_STATES = ["completed", "refunded", "abandoned", "lapsed"];
export const isOpenSwap = (s: Pick<StoredSwap, "state">): boolean => !CLOSED_STATES.includes(s.state);

/** The private asset a stored order was funded from (by the request's source asset). */
export function assetOfStored(deployment: Deployment | null, s: StoredSwap): Asset {
  const assets = assetsOf(deployment);
  const src = String((s.request as { from?: { asset?: string } } | undefined)?.from?.asset ?? "native");
  return assets.find((a) => (a.token ?? "native").toLowerCase() === src.toLowerCase()) ?? assets[0];
}

/** The factory every escrow is recomputed from: the wallet's own configuration, never the service's word. */
export function swapFactoryOf(deployment: Deployment | null): Address {
  if (!deployment?.swapFactory) throw new Error("No escrow factory configured (VITE_SWAP_FACTORY): this wallet cannot check the escrow address a swap service returns, so it does not commit or fund swap orders.");
  return deployment.swapFactory;
}

/** Thrown before anything is sent: the relayer that would execute this swap does not run it (`relayerRunsFor`). */
export class RelayerNotReady extends Error {
  readonly code = "relayer_not_ready";
  constructor(reason: string) {
    super(`Not funded: ${reason}. Nothing was sent.`);
    this.name = "RelayerNotReady";
  }
}

/**
 * Thrown before anything is sent (a V6 follow-up of 2026-10-16): the swap service no longer takes the vouch this order got at
 * its commit — its key changed, and the former one is not among those it still honors — so it would vouch for no call.
 */
export class ServiceKeyChanged extends Error {
  readonly code = "service_key_changed";
  constructor(reason: string) {
    super(`Not funded: ${reason}. Nothing was sent.`);
    this.name = "ServiceKeyChanged";
  }
}

/**
 * Thrown before anything is sent (the audit round of 2026-10-16, c18): an older version of the wallet committed this order's
 * refund note to the privacy address's owner commitment. Its escrow would publish that commitment, which links the swap to
 * every protect made before; nothing of it is on chain yet, so it is never funded, and a new quote commits a new one.
 */
export class OrderOutdated extends Error {
  readonly code = "order_outdated";
  constructor() {
    super("Not funded: an older version of the wallet set this swap up under your privacy address's owner commitment. Nothing was sent.");
    this.name = "OrderOutdated";
  }
}

/** An order whose refund note an older build made out to the privacy address's owner commitment (the audit round of 2026-10-16, c18). */
export function committedToPrivacyAddress(stored: Pick<StoredSwap, "params">, masterSeed: Uint8Array): boolean {
  const oc = (stored.params as { refundOwnerCommitment?: unknown } | undefined)?.refundOwnerCommitment;
  return typeof oc === "string" && /^[0-9]+$/.test(oc) && BigInt(oc) === mainOwnerCommitment(deriveKeys(masterSeed));
}

/** n/2 of secp256k1: the swap service signs low-s, as the relayer requires (packages/swap-engine/src/endpoints.ts) */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Who signed the order's vouch from its commit; null when it is not one the swap service would have signed (r‖s‖v, v 27 or 28, low-s). */
async function vouchSigner(o: { chainId: bigint; escrow: Address; vouch?: string }): Promise<Address | null> {
  const v = o.vouch;
  if (!v || !/^0x[0-9a-fA-F]{130}$/.test(v)) return null;
  const recovery = parseInt(v.slice(130, 132), 16);
  if ((recovery !== 27 && recovery !== 28) || BigInt("0x" + v.slice(66, 130)) > HALF_N) return null;
  try {
    return await recoverAddress({ hash: orderVouchDigest(o.chainId, o.escrow), signature: v as Hex });
  } catch {
    return null;
  }
}

/**
 * Before a swap is funded (a V6 follow-up of 2026-10-16): the relayer that will execute it runs for this wallet's factory and
 * for the swap service's key, as far as its /info names them. Given the order (its escrow and the vouch from its commit), also
 * the order's own vouch: the service still honors its signer (its key, or a former one it names), and a relayer that names
 * its list holds it too, for a refund before the hand-over. The service's status is read only when one of them needs it.
 * Throws RelayerNotReady or ServiceKeyChanged. A vouch that cannot be read is not checked (the finalize decides), and a read
 * that fails is an ordinary error, nothing sent, retried by the runner.
 */
export async function checkRelayerReady(
  url: string,
  factory: Address,
  deps: {
    order?: { chainId: bigint; escrow: Address; vouch?: string };
    info?: (url: string) => Promise<Pick<RelayerInfo, "swapFactory" | "vouchers">>;
    health?: () => Promise<ServiceHealth>;
  } = {},
): Promise<void> {
  const info = await (deps.info ?? relayerInfo)(url);
  const signer = deps.order ? await vouchSigner(deps.order) : null;
  const listed = Array.isArray(info.vouchers);
  const health = listed || signer ? await (deps.health ?? swapService.health)() : null;
  const why = relayerRunsFor(info, { factory, voucher: listed ? (health!.deployment.voucher ?? null) : undefined });
  if (why) throw new RelayerNotReady(why);
  if (!signer) return;
  const isSigner = (a: string | null | undefined) => !!a && a.toLowerCase() === signer.toLowerCase();
  if (![health!.deployment.voucher, ...(health!.deployment.previousVouchers ?? [])].some(isSigner))
    throw new ServiceKeyChanged("the swap service no longer takes the key this swap was confirmed under");
  if (listed && !info.vouchers!.some(isSigner)) throw new RelayerNotReady("the relayer no longer runs swaps confirmed under the swap service's former key");
}

/** What fundEscrow checks first: the relayer that will execute the order runs it, and the order's own vouch still counts. */
export async function checkFundingReady(o: { deployment: Deployment | null; stored: Pick<StoredSwap, "endpoint" | "orderVouch">; relayerUrl?: string | null }): Promise<void> {
  if (!o.relayerUrl || !o.deployment) return;
  await checkRelayerReady(o.relayerUrl, swapFactoryOf(o.deployment), {
    order: { chainId: BigInt(o.deployment.chainId), escrow: o.stored.endpoint as Address, ...(o.stored.orderVouch ? { vouch: o.stored.orderVouch } : {}) },
  });
}

/** Patch a journaled order and mirror its state onto its Activity line. */
export function patchSwap(orderId: string, patch: Partial<StoredSwap>, s: WalletSession = defaultSession): void {
  s.update((j) => { const x = j.swaps.find((y) => y.orderId.toLowerCase() === orderId.toLowerCase()); if (x) Object.assign(x, patch); });
  if (patch.state) updateActivity(activityId("swap", orderId), { status: patch.state }, s);
}

/** Give up an order that was never funded: its scheduled funding is removed (never retried) and its line says so. */
export function abandonSwap(orderId: string, s: WalletSession = defaultSession): void {
  cancelAction(`fund-escrow:${orderId}`, s);
  patchSwap(orderId, { state: "abandoned" }, s);
}

/**
 * How long a sent funding is waited for before, its notes unspent and no relayer job for them, it counts as dead: a new
 * funding may then go. The relayer drops a transaction its node no longer knows after the same time (apps/relayer
 * `DROP_AFTER_MS`).
 */
export const FUNDING_SETTLE_MS = 10 * 60_000;

/** The end of an order's execution window (ms): after it the escrow's execute reverts, and only its refund is left. */
export const windowEndOf = (stored: Pick<StoredSwap, "params">): number => Number((stored.params as { executeDeadline?: number }).executeDeadline) * 1000;
/**
 * An order is funded only with at least this long left of its execution window, so that the funding, the signature and
 * the execution fit in it; an order with less is never funded (a V6 follow-up of 2026-10-14).
 */
export const FUNDING_MARGIN_MS = 5 * 60_000;

/**
 * What became of a journaled funding.
 * - landed: its notes are spent on chain, and the escrow's balance follows.
 * - pending: the relayer still has a job for its notes, the node still knows its transaction, or it is younger than
 *   FUNDING_SETTLE_MS.
 * - dead: its transaction was mined and reverted, or none of the above. It never lands, and its notes stay unspent; a new
 *   funding is safe, since the chain refuses a spent nullifier.
 * - unknown: the chain or the relayer could not be read.
 * A V6 follow-up of 2026-10-14: a reverted funding had read as pending for good (the relayer keeps the job, the node
 * knows the transaction).
 */
export type FundingFate = "landed" | "pending" | "dead" | "unknown";

export interface FundingReads {
  spent(nullifier: bigint): Promise<boolean>;
  relayerJob(url: string, nullifiers: [bigint, bigint]): Promise<{ txHash: Hex } | null>;
  /** the receipt's status, or null while the transaction is not mined; throws when it cannot be read */
  receipt(hash: Hex): Promise<"success" | "reverted" | null>;
  /** the node knows the transaction (pending or mined); false when it does not; throws when it cannot be read */
  txKnown(hash: Hex): Promise<boolean>;
}

/** The wallet's reads of a funding's fate: PrivacyCore through its RPC, the relayer by nullifier. */
export function fundingReads(d: Deployment): FundingReads {
  const client = clientFor(d);
  return {
    spent: async (n) => (await client.readContract({ address: d.core, abi: coreAbi, functionName: "isNullifierSpent", args: [n] })) as boolean,
    relayerJob: (url, nullifiers) => relayerJobFor(url, nullifiers),
    receipt: async (hash) => {
      try {
        return (await client.getTransactionReceipt({ hash })).status;
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    txKnown: async (hash) => {
      try {
        await client.getTransaction({ hash });
        return true;
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return false;
        throw e;
      }
    },
  };
}

export async function fundingFate(a: FundingAttempt, reads: FundingReads, now = Date.now()): Promise<FundingFate> {
  try {
    const spent = await Promise.all(a.nullifiers.map((n) => reads.spent(BigInt(n))));
    if (spent.some(Boolean)) return "landed";
    const job = a.by === "relayer" && a.relayerUrl ? await reads.relayerJob(a.relayerUrl, [BigInt(a.nullifiers[0]), BigInt(a.nullifiers[1])]) : null;
    // its transaction (the journaled one, else the one the relayer sent for these notes): mined and reverted, it never lands;
    // mined, it landed (the nullifier read lagged)
    const hash = (a.txHash as Hex | undefined) ?? job?.txHash;
    if (hash) {
      const r = await reads.receipt(hash);
      if (r === "reverted") return "dead";
      if (r === "success") return "landed";
    }
    if (job) return "pending";
    if (a.txHash && (await reads.txKnown(a.txHash as Hex))) return "pending";
  } catch {
    return "unknown";
  }
  return now - a.at < FUNDING_SETTLE_MS ? "pending" : "dead";
}

export async function fundEscrow(o: { masterSeed: Uint8Array; deployment: Deployment | null; stored: StoredSwap; onStatus?: (line: string) => void; session?: WalletSession; /** the relayer that will execute the order: checked first (checkRelayerReady) */ relayerUrl?: string | null }): Promise<Submitted> {
  const s = o.session ?? defaultSession;
  const { stored } = o;
  if (!o.deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
  if (!isOpenSwap(stored)) throw new Error(`order ${stored.orderId.slice(0, 10)}… is ${stored.state}; it is not funded`);
  if (stored.fundedTx) throw new Error(`order ${stored.orderId.slice(0, 10)}… is already funded`);
  const a = assetOfStored(o.deployment, stored);
  const params = stored.params as { amount: string };
  const gross = BigInt(params.amount); // the withdrawal funds the whole order; the escrow pays the executor tip
  if (noteStore.balance(BigInt(a.vault)) < gross) throw new Error(`Not enough ${a.symbol} in your private balance for this order.`);
  // the money goes only to the escrow these params create under our factory (recomputed again here)
  const predicted = predictEscrow(swapFactoryOf(o.deployment), stored.params as Parameters<typeof predictEscrow>[1]);
  if (predicted.toLowerCase() !== String(stored.endpoint).toLowerCase()) throw new OrderMismatch("endpoint", `${stored.endpoint} is not the escrow these params create (${predicted})`);
  // never an order an older build committed under the privacy address's owner commitment (c18): stopped before anything is sent
  if (!stored.fundingAttempt && committedToPrivacyAddress(stored, o.masterSeed)) throw new OrderOutdated();
  // the relayer that will execute it runs it, and the order's own vouch still counts (a V6 follow-up of 2026-10-16): a funded
  // escrow they refused would hold the funds until the refund time with nobody to execute or refund it
  await checkFundingReady(o);
  // the funding's own submission is journaled before it is sent, then its transaction (a merge before it is nested: from
  // "merging" to the spend's own "syncing", as engineListener reads it); no runner sends another before its fate is known
  let nested = false;
  const onEvent: OnEvent = (e) => {
    if (e.type === "merging") nested = true;
    else if (e.type === "syncing") nested = false;
    else if (!nested && e.type === "submitting" && e.nullifiers)
      patchSwap(stored.orderId, { fundingAttempt: { nullifiers: e.nullifiers, by: e.by, ...(e.relayerUrl ? { relayerUrl: e.relayerUrl } : {}), at: Date.now() } }, s);
    else if (!nested && e.type === "submitted") {
      const attempt = s.journal().swaps.find((x) => x.orderId === stored.orderId)?.fundingAttempt;
      if (attempt) patchSwap(stored.orderId, { fundingAttempt: { ...attempt, txHash: e.txHash } }, s);
    }
  };
  const w = await privateWithdrawal({
    masterSeed: o.masterSeed,
    deployment: o.deployment,
    amount: gross,
    recipient: predicted,
    vault: a.vault,
    onStatus: o.onStatus,
    onEvent,
    record: false,
    // "Delay for more privacy" (spec v2.0 §14.1): from the older notes the Review showed, or not at all
    ...(stored.runner?.maxTiming !== undefined ? { maxTiming: stored.runner.maxTiming } : {}),
  }); // V6 (spec v2.0 §3): the fee note pays the percentage like any withdrawal
  patchSwap(stored.orderId, { fundedTx: w.txHash, state: "funded" }, s);
  return w;
}

/**
 * The scheduler's runner for a `fund-escrow` action: funds the order if it is still open and unfunded;
 * an order that was abandoned or funded by hand has its action cancelled instead of failing forever.
 */
export async function runScheduledAction(a: ScheduledAction, o: { masterSeed: Uint8Array; deployment: Deployment | null; session?: WalletSession }): Promise<void> {
  const s = o.session ?? defaultSession;
  if (a.kind === "housekeeping") {
    // private balance maintenance (plan V2 §73): one step per scheduled action; the step schedules the next under a new id
    if (!o.deployment) { cancelAction(a.id, s); return; }
    schedulerStatus.start(a.id, "Private balance maintenance: planning a step…");
    try { await runHousekeepingStep({ masterSeed: o.masterSeed, deployment: o.deployment, session: s, onStatus: (line) => schedulerStatus.progress(line) }); }
    finally { schedulerStatus.finish(); }
    return;
  }
  if (a.kind !== "fund-escrow") return; // a campaign tick is dispatched by the App to wallet/campaignRunner.ts
  const stored = s.journal().swaps.find((x) => x.orderId === a.orderId);
  if (!stored || stored.fundedTx || !isOpenSwap(stored) || stored.campaign) { cancelAction(a.id, s); return; } // a tranche is funded by its campaign, never here
  const asset = assetOfStored(o.deployment, stored);
  schedulerStatus.start(a.id, `Funding the scheduled swap (${asset.symbol}) from your private balance…`);
  try {
    const sub = settings.get().submission;
    await fundEscrow({ masterSeed: o.masterSeed, deployment: o.deployment, stored, session: s, onStatus: (line) => schedulerStatus.progress(line), relayerUrl: sub.kind === "relayer" ? sub.url : null });
  } catch (e) {
    // an order an older build committed under the privacy address's owner commitment (c18): given up, never funded
    if ((e as { code?: unknown })?.code !== "order_outdated") throw e;
    patchSwap(stored.orderId, { paused: { code: "order_outdated", detail: (e as Error).message, at: Date.now() } }, s);
    abandonSwap(stored.orderId, s);
  } finally {
    schedulerStatus.finish();
  }
}
