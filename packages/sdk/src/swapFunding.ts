// Funding a committed swap order (spec v1.1 §5, §8; V2 Stage 4): the private withdrawal that pays the
// one-time escrow, run either by the user ("Fund now") or by the scheduler at the drawn time — from any
// tab, since the runner lives at the App level. Every check the Swap screen made stays here: the escrow
// is recomputed from the wallet's own factory and the journaled params before a single note is spent,
// and an order that is no longer open (abandoned, already funded) is never funded.
import { recoverAddress, type Address, type Hex } from "viem";
import { executionUnits, type GasFees } from "@privacy-wallet/contracts";
import { feesOf } from "./executionCost";
import { clientFor, outcomeReads, type Deployment } from "./chain";
import { privateWithdrawal, type Submitted } from "./privateTx";
import { RelayerRefusal, relayerInfo, relayerJobFor, relayerRunsFor, relayerShieldRegister, type RelayerInfo, type ShieldJob } from "./relayer";
import { shieldJobRequest, shieldJobView } from "./shieldReceiver";
import { swapService, type ServiceHealth } from "./swapService";
import { settings } from "./wallet/settings";
import type { OnEvent } from "./operations/engineEvents";
import { assetsOf, type Asset } from "./assets";
import { OrderMismatch, orderVouchDigest, predictEscrow } from "./swapGuard";
import { noteStore } from "./wallet/notes";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { deriveOrderKey, deriveRefundNote } from "./keys/swapKeys";
import { mainOwnerCommitment } from "./keys/ownerKeys";
import { assertJournalSaved, session as defaultSession, type WalletSession } from "./wallet/session";
import { fundedOf, type FundingAttempt, type ScheduledAction, type StoredSwap } from "./wallet/journal";
import { activityId, updateActivity } from "./wallet/activity";
import { cancelAction, schedulerStatus } from "./wallet/schedule";
import { runHousekeepingStep } from "./wallet/housekeeping";
import { staleReads } from "./operations/stale";
import { spendIndexOf } from "./wallet/spends";
import { escrowBalance } from "./orderTracker";

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

/**
 * A funding already sent whose fate is not known to be dead (the audit round of 2026-10-16, c38): it is never sent again,
 * whoever asks. The runners kept that rule, but fundEscrow trusted its caller, and the scheduled action and the V5 page's
 * "Fund now" funded an order twice after a reload or while its funding was on its way.
 */
export class FundingAlreadySent extends Error {
  readonly code = "funding_unconfirmed";
  constructor(readonly fate: FundingFate) {
    super(`Not funded again: this order's funding was already sent (${fate === "landed" ? "it landed" : fate === "dead" ? "it never landed; fund it again from the order" : "its outcome is not known yet"}). Nothing more was sent.`);
    this.name = "FundingAlreadySent";
  }
}

/**
 * The order's funding is being proved or sent in this tab (the ninth review round, 2026-11-04, C-04): it is not abandoned, nor its funds
 * returned, meanwhile. An Abandon or a Return funds tapped during the proof had abandoned the order; the funding went out anyway, the order
 * re-opened as funded and was handed over, and its record stayed "Cancelled. Nothing left your protected balance".
 */
export class FundingUnderWay extends Error {
  readonly code = "funding_under_way";
  constructor() {
    super("This order's funding is being prepared or sent right now; nothing was changed. Try again once it has finished.");
    this.name = "FundingUnderWay";
  }
}

/** The order was closed while its funding was proved (the ninth review round, C-04): read again at the send, nothing was sent. */
export class OrderClosed extends Error {
  readonly code = "order_closed";
  constructor(readonly state: string) {
    super(`Not funded: this order was ${state} while its funding was prepared. Nothing was sent.`);
    this.name = "OrderClosed";
  }
}

/** An order whose execution window has closed, or is about to: never funded, its escrow could only refund (c38). */
export class OrderWindowClosed extends Error {
  readonly code = "order_expired";
  constructor() {
    super("Not funded: this order's execution window has closed. Nothing was sent.");
    this.name = "OrderWindowClosed";
  }
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
 * Thrown before anything is sent (the tenth review round, 2026-11-04, D-1): the order's refund note or its one-time signer is not what
 * this wallet's seed gives at the order's counter and attempt — an order committed while a lock zeroed the seed the commit held, or
 * one that came from anywhere but this wallet's own commit. Its refund would go to a note this wallet cannot spend: never funded.
 */
export class OrderNotOurs extends Error {
  readonly code = "order_not_ours";
  constructor() {
    super("Not funded: this order's refund is not set up for this wallet's keys. Nothing was sent.");
    this.name = "OrderNotOurs";
  }
}

/** Whether the order's refund note and one-time signer are this seed's, derived again at its counter and attempt (D-1). */
export function orderIsOurs(stored: Pick<StoredSwap, "params" | "refundCounter" | "attemptId">, masterSeed: Uint8Array): boolean {
  const p = stored.params as { refundOwnerCommitment?: unknown; refundNoteSecret?: unknown; orderSigner?: unknown } | undefined;
  if (!p || typeof stored.refundCounter !== "number" || typeof stored.attemptId !== "string" || typeof p.orderSigner !== "string") return false;
  const refund = deriveRefundNote(masterSeed, stored.refundCounter);
  const signer = deriveOrderKey(masterSeed, stored.attemptId as Hex).address;
  // as numbers, as checkOrder compares them (the eleventh review round, A11-11): a decimal string compared as text was fail-safe only by the wire format
  const big = (v: unknown): bigint | null => {
    try {
      return typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? BigInt(v) : null;
    } catch {
      return null;
    }
  };
  return big(p.refundOwnerCommitment) === refund.ownerCommitment && big(p.refundNoteSecret) === refund.noteSecret && p.orderSigner.toLowerCase() === signer.toLowerCase();
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

/** The relayer's refusals of a shield job that no retry changes: it shields nothing, for another factory, or not this receipt. */
const SHIELD_REFUSALS = ["shield_unavailable", "unknown_factory", "unvouched_order", "no_vault", "bad_params", "bad_payload", "payload_mismatch", "bad_deadline", "receipt_conflict", "bad_request"];

/**
 * A same-chain swap into the protected balance is funded only once its relayer took the shield job (the audit round of
 * 2026-10-16, c12). The job was registered at the hand-over, after the funding: a relayer that shields nothing, shields for
 * another factory or refuses the receipt left the escrow funded until its refund window. Its refusal, or no relayer at all,
 * stops the order unfunded (RelayerNotReady); a full relayer (`capacity`) or a lost answer is an ordinary error, nothing
 * sent, retried. Registering is idempotent by receipt: the hand-over's registration finds the same job.
 */
export async function registerShieldBeforeFunding(url: string | null, stored: StoredSwap, s: WalletSession, register = relayerShieldRegister): Promise<void> {
  if (!stored.shield) return;
  if (!url) throw new RelayerNotReady("a swap into the protected balance needs a relayer to shield its delivery (Settings → relayer submission)");
  let job: ShieldJob;
  try {
    job = await register(url, shieldJobRequest(stored));
  } catch (e) {
    if (e instanceof RelayerRefusal && e.code && SHIELD_REFUSALS.includes(e.code)) throw new RelayerNotReady(`the relayer does not shield this swap's delivery (${e.message})`);
    throw e;
  }
  patchSwap(stored.orderId, { shield: { ...stored.shield, registeredAt: Date.now(), job: shieldJobView(job) } }, s);
}

/** Patch a journaled order and mirror its state onto its Activity line. */
export function patchSwap(orderId: string, patch: Partial<StoredSwap>, s: WalletSession = defaultSession): void {
  s.update((j) => { const x = j.swaps.find((y) => y.orderId.toLowerCase() === orderId.toLowerCase()); if (x) Object.assign(x, patch); });
  if (patch.state) updateActivity(activityId("swap", orderId), { status: patch.state }, s);
}

/**
 * Give up an order that was never funded: its scheduled funding is removed (never retried) and its line says so. Never an
 * order whose funding is on its way (the review round of 2026-11-03, E2): abandoned, it is no longer open — no tick, no
 * Return funds — and a funding that lands then sits in the escrow with no way back in the app. A caller that has read the
 * attempt dead says so (`fundingDead`); every other one is refused with the attempt's fate.
 */
export function abandonSwap(orderId: string, s: WalletSession = defaultSession, o: { fundingDead?: boolean } = {}): void {
  if (fundingUnderWay(orderId)) throw new FundingUnderWay(); // proved or sent in this tab right now (C-04): its attempt is not journaled yet
  const stored = s.journal().swaps.find((x) => x.orderId.toLowerCase() === orderId.toLowerCase());
  if (stored?.fundingAttempt && !fundedOf(stored) && !o.fundingDead) throw new FundingAlreadySent("pending");
  cancelAction(`fund-escrow:${orderId}`, s);
  patchSwap(orderId, { state: "abandoned" }, s);
}

/**
 * How long a sent funding is waited for before, its notes unspent and no relayer job for them, it counts as dead: a new
 * funding may then go. The relayer drops a transaction its node no longer knows after ten minutes (apps/relayer
 * `DROP_AFTER_MS`); the wallet waits an hour (the sixth review round, 2026-11-03), as it does for a spend its own connection
 * sent (operations/stale.ts, n66): a relayer whose node restarted forgets a transaction other nodes still hold, and a funding
 * read dead at ten minutes and mined later had left the escrow funded with no way back in the app.
 */
export const FUNDING_SETTLE_MS = 60 * 60_000;

/** The end of an order's execution window (ms): after it the escrow's execute reverts, and only its refund is left. */
export const windowEndOf = (stored: Pick<StoredSwap, "params">): number => Number((stored.params as { executeDeadline?: number }).executeDeadline) * 1000;
/**
 * An order is funded only with at least this long left of its execution window, so that the funding, the signature and
 * the execution fit in it; an order with less is never funded (a V6 follow-up of 2026-10-14).
 */
export const FUNDING_MARGIN_MS = 5 * 60_000;

/** The chain's latest block's timestamp, in seconds. */
export type LatestBlockTime = (d: Deployment) => Promise<bigint>;
const latestBlockTime: LatestBlockTime = async (d) => (await clientFor(d).getBlock({ blockTag: "latest" })).timestamp;

/**
 * The clock a funding reads its order's window by: the later of the device's and the chain's latest block (audit round 2,
 * critic gap 5). A device clock minutes slow had funded escrows whose execution deadline had passed in chain time: the
 * execution reverted, the funds waited for the refund time, and the funding's fee was lost. The later of the two never
 * funds later than either allows (an endpoint that lies about the time can only make it refuse); a block read that fails
 * leaves the device's clock, as before.
 */
export async function fundingClock(d: Deployment, deviceNow = Date.now(), read: LatestBlockTime = latestBlockTime): Promise<number> {
  try {
    return Math.max(deviceNow, Number(await read(d)) * 1000);
  } catch {
    return deviceNow;
  }
}

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
  /** the nullifier pairs the transaction's core call spends; null while the node does not know it (absent: not read) */
  txSpends?(hash: Hex): Promise<[bigint, bigint][] | null>;
  /**
   * The pool's own record of the attempt's pair (the scan's agreed spend index; the eighth review round, B-4): the transaction that
   * spent exactly this pair, "other" when the index has one of its notes spent with another note, null when it does not know.
   */
  spendOf?(pair: [bigint, bigint]): Promise<{ txHash: Hex } | "other" | null>;
  /** the digest of a transaction's transact inputs (operations/stale.ts txInputs, agreed by every endpoint); null when it cannot tell */
  txInputs?(hash: Hex): Promise<Hex | null>;
  /** the address a transaction's transact pays (its withdrawal recipient; operations/stale.ts txRecipient, agreed); null when it cannot tell */
  txRecipient?(hash: Hex): Promise<Hex | null>;
}

/**
 * The wallet's reads of a funding's fate: PrivacyCore through every configured endpoint (audit round 2, r23: one
 * endpoint's "reverted" and "unspent" had abandoned a funded order as "nothing left your private balance" — a
 * disagreement is "unknown" now, and nothing is sent), the relayer by nullifier.
 */
export function fundingReads(d: Deployment): FundingReads {
  const outcome = outcomeReads(d);
  const index = spendIndexOf(d.core);
  const stale = staleReads(d, index);
  return {
    // the spent bits from the scan's agreed spend index (the ninth review round, 2026-11-04, D-3): a funding's two nullifiers had been
    // asked of every endpoint by name at every tick, linking this client to its notes. Without an index (no scan yet) the fate is unknown;
    // a funding that landed since the last scan is read from its receipt, and the runners read the escrow's balance before any fate
    spent: async (n) => {
      if (!index) throw new Error("the pool has not been scanned yet: a funding's notes are never named to an endpoint");
      return index.spent(n);
    },
    relayerJob: (url, nullifiers) => relayerJobFor(url, nullifiers),
    receipt: outcome.receipt,
    txKnown: outcome.txKnown,
    txSpends: stale.txSpends,
    spendOf: async (pair) => {
      if (!index) return null;
      const s = index.spendOf(pair);
      if (s) return { txHash: s.transactionHash };
      return index.spent(pair[0]) || index.spent(pair[1]) ? "other" : null;
    },
    ...(stale.txInputs ? { txInputs: stale.txInputs } : {}),
    ...(stale.txRecipient ? { txRecipient: stale.txRecipient } : {}),
  };
}

/** `escrow`: the order's escrow, which its funding's call pays (an attempt journaled before its call's digest was kept is told by it). */
export async function fundingFate(a: FundingAttempt, reads: FundingReads, now = Date.now(), escrow?: string): Promise<FundingFate> {
  try {
    const spent = await Promise.all(a.nullifiers.map((n) => reads.spent(BigInt(n))));
    if (spent.some(Boolean)) {
      // landed only by this attempt's own call (the eighth review round, 2026-11-03, B-4): its notes spent by another call — a Send, another
      // order's funding, a housekeeping step after a reload, the relayer having dropped this one — make it a funding that never lands.
      // Any spent note had read "landed": the order reconciled for good, Return funds and Abandon refused, nothing in the escrow
      const pair: [bigint, bigint] = [BigInt(a.nullifiers[0]), BigInt(a.nullifiers[1])];
      const seen = reads.spendOf ? await reads.spendOf(pair) : null;
      if (seen === "other") return "dead";
      if (seen && a.inputsDigest && reads.txInputs) {
        const digest = await reads.txInputs(seen.txHash);
        if (digest !== null && digest.toLowerCase() !== a.inputsDigest.toLowerCase()) return "dead";
      } else if (seen && !a.inputsDigest && escrow && reads.txRecipient) {
        // an attempt journaled before its call's digest was kept (the ninth review round, 2026-11-04, C-10): the call that spent its pair
        // pays this order's escrow, or it was another's — it had read "landed" for good, the order reconciling every 15 s, Return funds refused
        const to = await reads.txRecipient(seen.txHash);
        if (to !== null && to.toLowerCase() !== escrow.toLowerCase()) return "dead";
      }
      return "landed";
    }
    const job = a.by === "relayer" && a.relayerUrl ? await reads.relayerJob(a.relayerUrl, [BigInt(a.nullifiers[0]), BigInt(a.nullifiers[1])]) : null;
    // its transaction (the journaled one, else the one the relayer sent for these notes): mined and reverted, it never lands;
    // mined, it landed (the nullifier read lagged)
    const hash = (a.txHash as Hex | undefined) ?? job?.txHash;
    // its fate only from a transaction that spends this attempt's notes (audit round 2, n11 — the c31/c42 rule): a hash the
    // relayer named that spends others, mined, had read as this funding landed — the order journaled funded, nothing moved
    const spends = hash && reads.txSpends ? await reads.txSpends(hash) : null;
    const ours = !spends || spends.length === 0 || spends.some(([x, y]) => x === BigInt(a.nullifiers[0]) && y === BigInt(a.nullifiers[1])); // none read: unknown, as before
    if (hash && ours) {
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

/**
 * An ETH order whose tip no longer pays its execution at today's gas price (audit round 2, p04): the tip is fixed in the
 * escrow at the commit — hours before a delayed funding —, and a base fee risen since left the relayer waiting rather than
 * execute below cost, the call expiring and the escrow waiting for its refund time, the fees lost. Stopped before funding.
 */
export class TipStale extends Error {
  readonly code = "tip_stale";
  constructor(readonly tip: bigint, readonly cost: bigint) {
    super(`the order's executor tip (${tip} wei) no longer pays its execution at today's gas price (about ${cost} wei); it was stopped before funding`);
    this.name = "TipStale";
  }
}

/**
 * Today's cost of an ETH order's execution, with room for the base fee to rise half again before it runs, against its tip
 * (p04). An ERC-20 order's tip is in the token and never re-valued by the executor; without a fee read the relayer's own
 * check stands.
 */
async function checkTipCovers(d: Deployment, stored: StoredSwap, readFees: (d: Deployment) => Promise<GasFees>): Promise<void> {
  const p = stored.params as { assetType?: number | string; executorTip?: string };
  if (Number(p.assetType) !== 0 || p.executorTip === undefined) return;
  let fees: GasFees;
  try {
    fees = await readFees(d);
  } catch {
    return;
  }
  const cost = executionUnits(false) * ((fees.baseFeePerGas * 3n) / 2n + fees.priorityFeePerGas);
  if (BigInt(p.executorTip) < cost) throw new TipStale(BigInt(p.executorTip), cost);
}

/** The orders whose funding is under way in this tab (the review round of 2026-11-03, E1). */
const fundingInFlight = new Set<string>();
/** Whether this tab is proving or sending the order's funding right now (the ninth review round, C-04): nothing abandons it meanwhile. */
export function fundingUnderWay(orderId: string): boolean {
  return fundingInFlight.has(orderId.toLowerCase());
}

/**
 * Fund an order's escrow from the private balance — one funding of an order at a time in this tab (the review round of
 * 2026-11-03, E1): a second caller (Fund now beside the runner's tick, or the scheduler's) had passed every check below while
 * the first was still proving (no attempt journaled yet), waited its turn in the spend queue and funded the escrow a second
 * time from the notes that were left. The second is refused at once as a funding on its way; the spend's own turn reads the
 * journal again before anything is proved (`beforeSpend`).
 */
export async function fundEscrow(o: Parameters<typeof fundEscrowUnguarded>[0]): Promise<Submitted> {
  const key = String(o.stored?.orderId ?? "").toLowerCase(); // a malformed order is the checks' to refuse, not this guard's
  if (key && fundingInFlight.has(key)) throw new FundingAlreadySent("pending");
  if (key) fundingInFlight.add(key);
  try {
    return await fundEscrowUnguarded(o);
  } finally {
    if (key) fundingInFlight.delete(key);
  }
}

async function fundEscrowUnguarded(o: {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  stored: StoredSwap;
  onStatus?: (line: string) => void;
  session?: WalletSession;
  /** the relayer that will execute the order: required, and checked first (checkRelayerReady) */
  relayerUrl?: string | null;
  /** the user asked again after a funding that never landed (plan §86: never on its own) */
  replaceDead?: boolean;
  /** the reads of a journaled funding's fate (tests); the deployment's own otherwise */
  reads?: FundingReads;
  /** the escrow's balance (tests); this wallet's own RPC otherwise */
  escrowBalance?: (stored: StoredSwap) => Promise<bigint | null>;
  /** today's gas fees (tests); this wallet's own RPC otherwise */
  fees?: (d: Deployment) => Promise<GasFees>;
  /** the chain's latest block time (tests); this wallet's own RPC otherwise */
  latestBlock?: LatestBlockTime;
  /** a fixed clock (tests): the device's and the chain's are not read */
  now?: number;
}): Promise<Submitted> {
  const s = o.session ?? defaultSession;
  const { stored } = o;
  assertJournalSaved(s); // its funding attempt would be lost at the next lock, and sent again (audit round 2, r47)
  if (!o.deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
  if (!isOpenSwap(stored)) throw new Error(`order ${stored.orderId.slice(0, 10)}… is ${stored.state}; it is not funded`);
  if (fundedOf(stored)) throw new Error(`order ${stored.orderId.slice(0, 10)}… is already funded`); // the durable rule (C-01): never a second funding
  const a = assetOfStored(o.deployment, stored);
  const params = stored.params as { amount: string };
  const gross = BigInt(params.amount); // the withdrawal funds the whole order; the escrow pays the executor tip
  if (noteStore.balance(BigInt(a.vault)) < gross) throw new Error(`Not enough ${a.symbol} in your private balance for this order.`);
  // the money goes only to the escrow these params create under our factory (recomputed again here)
  const predicted = predictEscrow(swapFactoryOf(o.deployment), stored.params as Parameters<typeof predictEscrow>[1]);
  if (predicted.toLowerCase() !== String(stored.endpoint).toLowerCase()) throw new OrderMismatch("endpoint", `${stored.endpoint} is not the escrow these params create (${predicted})`);
  // the escrow itself before the journal (the fifth review round, 2026-11-03): a journal behind the chain — a profile restored from
  // an older copy, a write a lock discarded — knew no funding of this order, and this by-hand path trusted it; the scheduled
  // runner read the escrow first already (audit round 2, n36). A read that fails leaves the journal's word
  const fundedAsset = (stored.request as { from?: { asset?: string } })?.from?.asset;
  const inEscrow = await (o.escrowBalance ? o.escrowBalance(stored) : escrowBalance(o.deployment, stored.endpoint as Address, fundedAsset && fundedAsset !== "native" ? (fundedAsset as Address) : null)).catch(() => null);
  if (inEscrow !== null && inEscrow >= gross) {
    patchSwap(stored.orderId, { state: "funded", fundedAt: Date.now() }, s);
    throw new FundingAlreadySent("landed");
  }
  // never an order an older build committed under the privacy address's owner commitment (c18): stopped before anything is sent
  if (!stored.fundingAttempt && committedToPrivacyAddress(stored, o.masterSeed)) throw new OrderOutdated();
  // the relayer that will execute it runs it, and the order's own vouch still counts (a V6 follow-up of 2026-10-16): a funded
  // escrow they refused would hold the funds until the refund time with nobody to execute or refund it
  // a swap's escrow is executed by its relayer (the audit round of 2026-10-16, c37): funded through the connected wallet's
  // submission, it was never executed, and the runner signed it again on every tick until its refund window
  if (!o.relayerUrl) throw new RelayerNotReady("a swap is carried out by the relayer, and this wallet submits through the connected wallet (Settings → relayer submission)");
  // its own rules, whatever the caller checked (c38): a funding already sent is never sent again before it is known dead —
  // and a dead one only on the user's word (`replaceDead`) —, and none goes out past the order's window
  if (stored.fundingAttempt) {
    const fate = await fundingFate(stored.fundingAttempt, o.reads ?? fundingReads(o.deployment), o.now, stored.endpoint);
    // landed while its page was gone — a tab closed or reloaded while it was mined (audit round 2, r10): the order is funded,
    // and journaled so. Refused for good, its scheduled funding retried on the backoff forever, the order read "Funding is
    // scheduled", then "nothing left your private balance", and offered only Abandon — while its amount sat in the escrow
    if (fate === "landed") patchSwap(stored.orderId, { state: "funded", ...(stored.fundingAttempt.txHash ? { fundedTx: stored.fundingAttempt.txHash } : { fundedAt: Date.now() }) }, s);
    if (fate !== "dead" || !o.replaceDead) throw new FundingAlreadySent(fate);
    // a dead funding sent again is a new funding (audit round 2, n10): never one of an order an older build committed under the
    // privacy address's owner commitment (c18), which the check above lets through once a funding has been tried
    if (committedToPrivacyAddress(stored, o.masterSeed)) throw new OrderOutdated();
    patchSwap(stored.orderId, { fundingAttempt: undefined }, s);
  }
  // the window by the later of the device's clock and the chain's (critic gap 5)
  const now = o.now ?? (await fundingClock(o.deployment, Date.now(), o.latestBlock));
  if (now + FUNDING_MARGIN_MS >= windowEndOf(stored)) throw new OrderWindowClosed();
  await checkTipCovers(o.deployment, stored, o.fees ?? feesOf);
  await checkFundingReady(o);
  // a new funding goes only to an order whose refund note and signer this seed gives (the tenth review round, D-1): an order committed from
  // the seed a lock zeroed refunds to a note anyone can spend. Checked last before anything leaves the wallet — the shield job's registration
  // with the relayer included; a receipt's own note is checked again at the signature (checkShieldReceipt), its refund here
  if (!orderIsOurs(stored, o.masterSeed)) throw new OrderNotOurs();
  // a same-chain swap's shield job is accepted before anything is funded (c12)
  await registerShieldBeforeFunding(o.relayerUrl ?? null, stored, s);
  // the funding's own submission is journaled before it is sent, then its transaction (a merge before it is nested: from
  // "merging" to the spend's own "syncing", as engineListener reads it); no runner sends another before its fate is known
  let nested = false;
  const onEvent: OnEvent = (e) => {
    if (e.type === "merging") nested = true;
    else if (e.type === "syncing") nested = false;
    else if (!nested && e.type === "submitting" && e.nullifiers) {
      // the order read again at the last moment before anything is sent (the ninth review round, 2026-11-04, C-04): an order closed while
      // its funding was proved is not funded — the send had gone out over an abandon, and the order re-opened as funded and was handed over
      const latest = s.journal().swaps.find((x) => x.orderId.toLowerCase() === stored.orderId.toLowerCase());
      if (latest && !isOpenSwap(latest)) throw new OrderClosed(latest.state);
      patchSwap(
        stored.orderId,
        { fundingAttempt: { nullifiers: e.nullifiers, by: e.by, ...(e.relayerUrl ? { relayerUrl: e.relayerUrl } : {}), ...(e.inputsDigest ? { inputsDigest: e.inputsDigest } : {}), at: Date.now() } },
        s,
      ); // its call's inputs (B-4): whose call spent its notes decides its fate
    }
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
    // never a fee above the one the Review showed (c46): a higher one stops the order unfunded (fee_moved)
    ...(stored.reviewedFee !== undefined && /^[0-9]+$/.test(stored.reviewedFee) ? { maxFee: BigInt(stored.reviewedFee) } : {}),
    // nor a merge above the Review's F (the review round of 2026-11-03, E3): the merges a funding needs first had paid the live fee, unshown
    ...(stored.reviewedMergeFee !== undefined && /^[0-9]+$/.test(stored.reviewedMergeFee) ? { maxMergeFee: BigInt(stored.reviewedMergeFee) } : {}),
    // nor more merges than its Review named (the eighth review round, B-2): a funding hours later found the notes split since
    ...(Number.isSafeInteger(stored.reviewedMerges) && (stored.reviewedMerges as number) >= 0 ? { maxMerges: stored.reviewedMerges as number } : {}),
    // inside the spend's turn (E1): funded or sent meanwhile by another caller of this tab, nothing more is proved or sent
    beforeSpend: () => {
      const latest = s.journal().swaps.find((x) => x.orderId.toLowerCase() === stored.orderId.toLowerCase());
      if (!latest) return; // not journaled (a test's order): nothing to read again
      if (fundedOf(latest)) throw new FundingAlreadySent("landed");
      if (latest.fundingAttempt) throw new FundingAlreadySent("pending");
    },
  }); // V6 (spec v2.0 §3): the fee note pays the percentage like any withdrawal
  patchSwap(stored.orderId, { fundedTx: w.txHash, state: "funded", ...(w.feeWei !== undefined ? { fundedFee: w.feeWei.toString() } : {}) }, s);
  return w;
}

/**
 * The scheduler's runner for a `fund-escrow` action: funds the order if it is still open and unfunded;
 * an order that was abandoned or funded by hand has its action cancelled instead of failing forever.
 */
/** The funding refusals that stop an order unfunded (the one-confirmation runner's list; nothing was sent on any of them). */
export const PERMANENT_FUNDING_REFUSALS: readonly string[] = ["order_outdated", "order_not_ours", "order_expired", "relayer_not_ready", "service_key_changed", "tip_stale", "fee_moved", "merges_moved", "older_notes_unavailable"];

export async function runScheduledAction(
  a: ScheduledAction,
  o: { masterSeed: Uint8Array; deployment: Deployment | null; session?: WalletSession; /** the escrow's balance (tests); the deployment's endpoints otherwise */ escrowBalance?: (stored: StoredSwap) => Promise<bigint | null> },
): Promise<void> {
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
  // funded already — by hand, or a funding that landed while its page was gone (r10) —, closed, or a tranche (its campaign funds it)
  if (!stored || fundedOf(stored) || !isOpenSwap(stored) || stored.campaign) { cancelAction(a.id, s); return; }
  // an escrow that already holds the order is funded (audit round 2, n36): a funding that landed with nothing journaled — a
  // write another tab's lock discarded, a backup's copy — was sent a second time here, where the runners read the escrow first
  const token = (stored.request as { from?: { asset?: string } })?.from?.asset;
  const read = o.escrowBalance ?? ((st: StoredSwap) => (o.deployment ? escrowBalance(o.deployment, st.endpoint as Address, token && token !== "native" ? (token as Address) : null) : Promise.resolve(null)));
  const held = await read(stored).catch(() => null);
  if (held !== null && held >= BigInt((stored.params as { amount: string }).amount)) {
    patchSwap(stored.orderId, { state: "funded", fundedAt: Date.now() }, s);
    cancelAction(a.id, s);
    return;
  }
  const asset = assetOfStored(o.deployment, stored);
  schedulerStatus.start(a.id, `Funding the scheduled swap (${asset.symbol}) from your private balance…`);
  try {
    const sub = settings.get().submission;
    await fundEscrow({ masterSeed: o.masterSeed, deployment: o.deployment, stored, session: s, onStatus: (line) => schedulerStatus.progress(line), relayerUrl: sub.kind === "relayer" ? sub.url : null });
  } catch (e) {
    // its funding landed while its page was gone (r10): the order is funded and journaled so, nothing more runs here
    if (e instanceof FundingAlreadySent && e.fate === "landed") { cancelAction(a.id, s); return; }
    // the refusals the one-confirmation runner stops an order on (the review round of 2026-11-03, E6): an order an older build
    // committed under the privacy address's owner commitment (c18), its window closed, the relayer not running swaps, the swap
    // service's key changed, a stale tip, a fee above the Review's, the older notes gone, a funding read dead — here they had gone
    // to the backoff for good (six hours at most, forever), the order open and counted in flight until the user abandoned it
    const code = (e as { code?: unknown })?.code;
    const dead = e instanceof FundingAlreadySent && e.fate === "dead";
    if (!dead && !PERMANENT_FUNDING_REFUSALS.includes(String(code))) throw e;
    // never given up on "dead" while the escrow cannot be read (the ninth review round, 2026-11-04, B-F1): an endpoint that misreads it
    // and the funding's call had abandoned a funded order; the backoff reads both again
    if (dead && held === null) throw e;
    patchSwap(stored.orderId, { paused: { code: dead ? "funding_unconfirmed" : String(code), detail: (e as Error).message, at: Date.now() } }, s);
    abandonSwap(stored.orderId, s, { fundingDead: dead });
    cancelAction(a.id, s);
  } finally {
    schedulerStatus.finish();
  }
}
