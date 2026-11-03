// The three money-moving steps of a swap order, as the Swap screen runs them (spec v1.1 §2, §5, §8; whale spec
// §3, §14, §24), extracted so a campaign's runner (High-Value Protection spec §7) executes a tranche with
// EXACTLY the machinery a single order uses: commit (the one-time signer and the refund note fixed before the
// service chooses the orderId, the escrow recomputed from this wallet's factory, the order journaled), prepare and
// sign (the hard quote with the escrow as sender, the wallet's own read of the provider call, the signature kept
// here, the simulation on every endpoint), the hand-over (finalize, the executor), and the refund-only return.
// Nothing here renders; the screen keeps its state in sync from the journal.
import type { Address, Hex } from "viem";
import { higherTier, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import type { LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import type { Deployment } from "./chain";
import type { Asset } from "./assets";
import { simulateExecution, type Simulation } from "./simulate";
import { swapService, type CompetitionEntry, type ExecutionPlan, type Policy, type Prepared, type Preference, type ResumeRequest, type ServiceOrder, type ServiceOrderParams, type ServiceQuote, type SwapRequest, type Tier as ServiceTier } from "./swapService";
import { ApiError } from "./api/client";
import { checkOrder, OrderMismatch, predictEscrow, restoreDigest, restoreRequestText } from "./swapGuard";
import { CostUnknown, shieldTipCeiling, tipCeiling } from "./executionCost";
import { buildShieldReceipt, shieldJobRequest, shieldJobView } from "./shieldReceiver";
import { checkBeforeSigning, type JournaledOrder, type SignCheck } from "./swapSign";
import { ProviderCallMismatch, type CheckedCall, type MinimumMoved } from "./providerCall";
import { deriveOrderKey, deriveRefundNote, signExecutionDigest, type RefundNote } from "./keys/swapKeys";
import { relayerInfo, relayerShieldRegister, relayerSwapExecute, relayerSwapRefund, type SwapJob } from "./relayer";
import { patchSwap, swapFactoryOf } from "./swapFunding";
import { DELAY_WINDOW } from "./policy";
import { noteStore } from "./wallet/notes";
import { assertJournalSaved, session as defaultSession, type WalletSession } from "./wallet/session";
import type { Submission } from "./wallet/settings";
import type { StoredShield, StoredSwap } from "./wallet/journal";
import { activityId, recordActivity } from "./wallet/activity";
import { markAddressUsed } from "./wallet/addressBook";
import { chainKindOf } from "./keys/chainKeys";
import { sampleDueAt, scheduleAction } from "./wallet/schedule";

/** A provider call this wallet checked, signed and simulated — kept in memory until it is handed over (never journaled). */
export interface Signed { prepared: Prepared; params: ServiceOrderParams; call: CheckedCall; signature: Hex; sim: Simulation; label: string }

const TIERS: Tier[] = ["standard", "enhanced", "high-value", "high-value-secondary", "institutional"];
const asTier = (t: unknown): Tier | null => (TIERS.includes(t as Tier) ? (t as Tier) : null);
const fmtEth = (units: string): string => { const u = BigInt(units), base = 10n ** 18n; const frac = (u % base).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, ""); return `${u / base}${frac ? `.${frac}` : ""}`; };
const randomHex32 = (): Hex => ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;

export interface CommitInput {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  session?: WalletSession;
  /** the request with its final destination (a fresh address already reserved, or the entered one) */
  request: SwapRequest;
  policy: Policy;
  provider?: string;
  fromAsset: Asset;
  /** the quote the user saw: its minimum is the one approved (whale spec §3) */
  shown?: ServiceQuote;
  competition?: CompetitionEntry[] | null;
  lint?: LintItem[] | null;
  preference: Preference;
  /** this wallet's own tier of the order (null without a price); the journaled tier is the higher of the service's and this */
  walletTier: Tier | null;
  /** a plain order: the funding is scheduled inside the policy's window (no earlier than the review hold); a tranche passes nothing — its campaign funds it */
  schedule?: { reviewHoldUntil?: number } | null;
  campaign?: { id: string; index: number };
  /** V6 Stage 12 (spec v2.0 §11.2): into the protected balance — the quote's shield tip and a fresh address of this wallet
   *  for a token the pool cannot hold; the order's destination becomes the shield receiver built here */
  shield?: { shieldTip: bigint; fallbackRecipient: Address };
  /** the relayer's fee for the funding the Review showed: the funding never pays more (the audit round of 2026-10-16, c46) */
  reviewedFee?: bigint;
  /** each merge the funding needs first pays at most this: the Review's F (the review round of 2026-11-03, E3) */
  reviewedMergeFee?: bigint;
  now?: number;
}
export interface Committed { stored: StoredSwap; order: ServiceOrder; key: { privateKey: Hex; address: Hex }; refund: RefundNote; response: Awaited<ReturnType<typeof swapService.order>> }

/** Commit an order: the one-time key and the refund note fixed first, `/order`, the escrow checked, the order journaled (and, for a plain order, its funding scheduled). */
export async function commitOrder(i: CommitInput): Promise<Committed> {
  const s = i.session ?? defaultSession;
  assertJournalSaved(s); // its record would be lost at the next lock (audit round 2, r47)
  const now = i.now ?? Date.now();
  const factory = swapFactoryOf(i.deployment);
  // the tips are checked against this wallet's own estimate of the gas they pay for, never left to the escrow's 1 % cap
  // alone (audit round 2, critic gap 4: a failed fee read or price read had let the service set any tip up to 1 %). Without
  // an estimate nothing is committed: no note counter is taken, the service is not asked
  const maxTip = i.deployment ? await tipCeiling(i.deployment, i.fromAsset) : null;
  const maxShieldTip = i.deployment && i.shield ? await shieldTipCeiling(i.deployment, i.request.to) : null;
  if (i.deployment && (maxTip === null || (i.shield && maxShieldTip === null))) throw new CostUnknown();
  // the signer must be fixed at commit time, before the service chooses the orderId, so a one-time key is derived per attempt from a random attempt id (never reused: a new attempt, a new key)
  const attemptId = randomHex32();
  const key = deriveOrderKey(i.masterSeed, attemptId);
  const refundCounter = noteStore.allocateCounter();
  const refund = deriveRefundNote(i.masterSeed, refundCounter);
  // a same-chain swap into the protected balance pays a one-time shield receiver: its note, tip and fallback fixed now
  let req = i.request;
  let shield: StoredShield | undefined;
  if (i.shield) {
    if (!i.deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
    if (maxShieldTip !== null && i.shield.shieldTip > maxShieldTip) throw new OrderMismatch("shieldTip", `${i.shield.shieldTip} is more than three times this wallet's own estimate of the shield's gas`);
    shield = buildShieldReceipt({ masterSeed: i.masterSeed, deployment: i.deployment, counter: noteStore.allocateCounter(), asset: req.to.asset, shieldTip: i.shield.shieldTip, fallbackRecipient: i.shield.fallbackRecipient });
    req = { ...req, destination: shield.receiver, destinationType: "protected" };
  }
  // a receipt goes with its commit: the service vouches for it once it is this order's (audit gap 47)
  const response = await swapService.order({ ...req, policy: i.policy, provider: i.provider, orderSigner: key.address, refundOwnerCommitment: refund.ownerCommitment.toString(), refundNoteSecret: refund.noteSecret.toString(), refundNoteDataHash: refund.noteDataHash, ...(shield ? { shield: shield.params } : {}) });
  // the escrow is recomputed here from OUR factory and the params; every field we chose is checked, and the tip against
  // this wallet's own estimate of the execution's gas (V6, spec v2.0 §3), read before the service was asked
  checkOrder(response.order, { factory, orderSigner: key.address as Address, refund, amount: BigInt(req.amount), asset: i.fromAsset, maxTip });
  const order = response.order;
  // the journaled tier is the higher of the service's and this wallet's (spec §1): a user's lower thresholds raise their own controls
  const serviceTier = asTier(order.tier ?? response.tier);
  const journaledTier: Tier | undefined = serviceTier && i.walletTier ? higherTier(serviceTier, i.walletTier) : serviceTier ?? (i.walletTier ?? undefined);
  const orderPolicy: Policy = order.policy ?? response.policy ?? i.policy;
  // institutional (spec §24): the funding is scheduled no earlier than the review hold, whatever the policy's window drew
  const reviewHoldUntil = i.schedule?.reviewHoldUntil;
  const sampled = i.schedule ? (orderPolicy === "fastest" ? undefined : sampleDueAt(DELAY_WINDOW[orderPolicy], now)) : undefined;
  const dueAt = i.schedule ? (reviewHoldUntil !== undefined ? Math.max(sampled ?? 0, reviewHoldUntil) : sampled) : undefined;
  const stored: StoredSwap = {
    orderId: order.orderId, operationId: response.operationId, attemptId, refundCounter, provider: order.quote.provider, policy: orderPolicy, request: { from: req.from, to: req.to, amount: req.amount, destination: req.destination, slippageBps: req.slippageBps, ...(req.destinationType ? { destinationType: req.destinationType } : {}), ...(req.destinationKind ? { destinationKind: req.destinationKind } : {}) },
    params: order.params, endpoint: order.endpoint, quote: order.quote, approvedMin: (i.shown ?? order.quote).toAmountMin, createdAt: now, dueAt, state: "committed", refundNoteData: refund.noteData, // the random payload is journaled (encrypted); the key is re-derived from attemptId
    ...(response.vouch?.order ? { orderVouch: response.vouch.order } : {}), // the API's vouch for this order (audit gap 47)
    preference: i.preference, tier: journaledTier, value: order.value ?? response.value, plan: order.plan ?? i.shown?.plan, ...(i.competition ? { competition: i.competition } : {}), ...(reviewHoldUntil !== undefined ? { reviewHoldUntil } : {}),
    ...(i.campaign ? { campaign: i.campaign } : {}),
    ...(shield ? { shield: { ...shield, ...(response.vouch?.shield ? { vouch: response.vouch.shield } : {}) } } : {}),
    ...(i.reviewedFee !== undefined ? { reviewedFee: i.reviewedFee.toString() } : {}),
    ...(i.reviewedMergeFee !== undefined ? { reviewedMergeFee: i.reviewedMergeFee.toString() } : {}),
  };
  if (i.lint) stored.lint = { items: i.lint, at: now };
  s.update((j) => { j.swaps = [...j.swaps.filter((x) => x.orderId !== stored.orderId), stored]; });
  // the shield receiver's fallback is published with the commit (sent to the swap service and the relayer, the receiver's
  // immutable, its deployment's calldata): never offered again as an unused fresh address (audit round 2, r32)
  if (i.shield) markAddressUsed("evm", i.shield.fallbackRecipient, stored.orderId, s, now);
  // the destination goes to the swap service with this commit (audit round 2, n54): used from here, never offered again as an
  // unused fresh address should the order stop before its hand-over — the service has it already
  if (req.to?.chain && req.destination && !shield) markAddressUsed(chainKindOf(req.to.chain), req.destination, stored.orderId, s, now);
  recordActivity({ id: activityId("swap", stored.orderId), kind: "swap", asset: i.fromAsset.symbol, decimals: i.fromAsset.decimals, amount: req.amount, status: "committed", ref: stored.orderId, note: `→ ${req.to.symbol}${i.campaign ? ` · step ${i.campaign.index + 1}` : ""}` }, s);
  if (dueAt !== undefined) scheduleAction({ kind: "fund-escrow", orderId: stored.orderId, dueAt }, s);
  return { stored, order, key, refund, response };
}

/**
 * Rebuild an order from the journaled params into its operation (V6: the API keeps it, but forgets a finalized order's blob
 * and purges after its retention): the same params give the same escrow, checked here; the operation id is journaled.
 */
export async function resumeOrder(deployment: Deployment | null, stored: StoredSwap, session: WalletSession = defaultSession): Promise<ServiceOrder> {
  const out = await swapService.resume(await resumeRequestOf(stored, session, deployment), operationIdOf(stored, session));
  const predicted = predictEscrow(swapFactoryOf(deployment), stored.params as any);
  if (out.order.endpoint.toLowerCase() !== predicted.toLowerCase() || out.order.orderId.toLowerCase() !== stored.orderId.toLowerCase()) throw new OrderMismatch("endpoint", "the resumed order is not the one this wallet committed");
  if (out.operationId && out.operationId !== operationIdOf(stored, session)) patchSwap(stored.orderId, { operationId: out.operationId }, session);
  return out.order;
}

/** The operation id the journal holds for an order now (a resume may have given it one since `stored` was read). */
function operationIdOf(stored: StoredSwap, s: WalletSession): string | undefined {
  const now = s.isUnlocked() ? s.journal().swaps.find((x) => x.orderId.toLowerCase() === stored.orderId.toLowerCase()) : undefined;
  return now?.operationId ?? stored.operationId;
}

/**
 * The journaled order as the API rebuilds it, signed by the order's one-time key over the request it names (audit round 2,
 * r05): the API rebuilds an order and answers its operation only for that key — the params are public once an execution is
 * tried, and anyone had named them with another destination, planting a call the wallet's re-sign met for good.
 */
async function resumeRequestOf(stored: StoredSwap, s: WalletSession, deployment: Deployment | null): Promise<ResumeRequest> {
  const seed = s.state().seed;
  if (!seed) throw new Error("the wallet is locked: an order is restored only with its own key");
  if (!deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
  const request = stored.request as ResumeRequest["request"];
  const text = restoreRequestText({ from: request.from, to: request.to, destination: String(request.destination ?? ""), provider: stored.provider });
  const key = deriveOrderKey(seed, stored.attemptId as Hex);
  return {
    request, policy: stored.policy as Policy, provider: stored.provider, params: stored.params as any,
    ...(stored.tier ? { tier: stored.tier as ServiceTier } : {}), ...(stored.preference ? { preference: stored.preference as Preference } : {}),
    restoreSignature: await signExecutionDigest(key.privateKey, restoreDigest(BigInt(deployment.chainId), stored.endpoint as Address, text)),
  };
}

/**
 * A call on the order's operation. An order without an operation (journaled before the API, or purged) is resumed first;
 * a 404 — the API holds no destination (finalized, then signed again) or no operation — is answered by `onMissing` (the
 * prepare sends its journaled params) or by a resume and one retry.
 */
async function onOperation<T>(deployment: Deployment | null, stored: StoredSwap, s: WalletSession, call: (operationId: string) => Promise<T>, onMissing?: (operationId: string) => Promise<T>): Promise<T> {
  let id = operationIdOf(stored, s);
  if (!id) {
    await resumeOrder(deployment, stored, s);
    id = operationIdOf(stored, s);
  }
  if (!id) throw new Error("the API named no operation for this order");
  try {
    return await call(id);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
    if (e.code === "unknown_order" && onMissing) {
      try {
        return await onMissing(id);
      } catch (e2) {
        if (!(e2 instanceof ApiError && e2.status === 404)) throw e2;
      }
    }
    await resumeOrder(deployment, stored, s); // the operation itself is gone: the order is restored into a new one
    const fresh = operationIdOf(stored, s) ?? id;
    return onMissing ? onMissing(fresh) : call(fresh);
  }
}

export interface PrepareInput {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  session?: WalletSession;
  stored: StoredSwap;
  order: ServiceOrder;
  submission: Submission;
  /** the user consented to a lower minimum than approved (MinimumMoved) */
  acceptMin?: bigint;
  /** audit gap 43: the call prepared before, whose moved minimum the user accepted — checked and signed instead of a fresh quote */
  reuse?: Prepared;
  onStatus?: (line: string) => void;
}

/**
 * Re-quote with the escrow as sender, check the provider call against the journal, sign it locally and simulate the
 * execution on every RPC endpoint (whale spec §24). The signature stays in memory until it is handed over.
 */
export async function prepareAndSign(i: PrepareInput): Promise<Signed | { moved: MinimumMoved; prepared: Prepared }> {
  const s = i.session ?? defaultSession;
  const { stored, order } = i;
  if (!i.deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
  const journaled = stored as unknown as JournaledOrder; // the wallet's own record: what it asked for, the params it committed, the minimum approved
  const orderKey = deriveOrderKey(i.masterSeed, stored.attemptId as Hex);
  const deployment = i.deployment;
  i.onStatus?.(i.reuse ? "Checking the call whose minimum you accepted…" : "Re-quoting with the escrow as sender, then checking the call…");
  const fresh = () => onOperation(deployment, stored, s, (id) => swapService.prepare(id), async (id) => swapService.prepare(id, undefined, await resumeRequestOf(stored, s, deployment)));
  // the swap service builds for this wallet's factory, read before the prepare (audit round 2, r02): a call can be valid for a
  // minute only (LI.FI), and this status read can take the providers' 25-s health budget — read between the prepare and the
  // hand-over, it left the relayer a call too close to its deadline to send. A reused call's order was read at its first signing
  if (!i.reuse) {
    const health = await swapService.health();
    const factory = swapFactoryOf(deployment);
    if (health.deployment.factory.toLowerCase() !== factory.toLowerCase()) throw new OrderMismatch("factory", `the swap service builds for ${health.deployment.factory}, this wallet for ${factory}`);
  }
  let prepared = i.reuse ?? (await fresh());
  // the digest is of exactly the call shown; the call pays your fresh address from a pinned provider, refunds to the escrow, and guarantees the approved minimum
  const check = (p: Prepared) =>
    checkBeforeSigning({ prepared: p, order, journaled, factory: swapFactoryOf(deployment), chainId: BigInt(deployment.chainId), acceptMin: i.acceptMin, pooled: (deployment.erc20Vaults ?? []).map((v) => ({ token: v.token, symbol: v.symbol, decimals: v.decimals })), deployment, masterSeed: i.masterSeed });
  let gate: SignCheck;
  try {
    gate = await check(prepared);
  } catch (e) {
    // the call whose minimum the user accepted names a vault THORChain no longer lists as active (it retires its vaults
    // at each churn): outdated, not unsafe — a fresh call is prepared and checked in full, and a lower minimum is asked again
    if (!(i.reuse && e instanceof ProviderCallMismatch && e.field === "vault")) throw e;
    i.onStatus?.("Re-quoting with the escrow as sender, then checking the call…");
    prepared = await fresh();
    gate = await check(prepared);
  }
  if (!gate.ok) return { moved: gate.moved, prepared }; // the call whose minimum the user is asked to accept
  const { params, call } = gate;
  i.onStatus?.("Signing locally…");
  const signature = await signExecutionDigest(orderKey.privateKey, prepared.digest); // the key never leaves this tab
  // the signed execution is simulated on every RPC endpoint before it leaves this wallet (whale spec §24): a revert keeps the signature here
  i.onStatus?.("Simulating the execution through your RPC endpoints…");
  const tipRecipient = i.submission.kind === "relayer" ? await relayerInfo(i.submission.url).then((x) => x.relayer).catch(() => undefined) : undefined;
  const sim = await simulateExecution({ deployment: i.deployment, factory: swapFactoryOf(i.deployment), params, execution: { provider: prepared.provider, value: BigInt(prepared.value), providerCalldata: prepared.calldata, deadline: prepared.deadline, signature }, account: tipRecipient });
  patchSwap(order.orderId, { simulation: { ok: sim.ok, at: Date.now(), ...(sim.ok ? { gas: sim.gas.toString() } : { error: sim.error, reason: sim.reason }) } }, s);
  const token = (stored.request as { from?: { asset?: string } })?.from?.asset;
  const label = `${token && token !== "native" ? "" : fmtEth(prepared.value) + " ETH · "}valid until ${new Date(prepared.deadline * 1000).toLocaleTimeString()}`;
  return { prepared, params, call, signature, sim, label };
}

/**
 * A fresh hard quote's minimum against the approved one before a delayed funding (audit round 2, n58): nothing is signed and
 * nothing has moved yet. Null when the minimum holds, the moved one otherwise. The call is checked as a signing would check
 * it, and not kept: the signing after the funding prepares its own.
 */
export async function minimumBeforeFunding(i: PrepareInput): Promise<MinimumMoved | null> {
  const s = i.session ?? defaultSession;
  const { stored, order } = i;
  if (!i.deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
  const deployment = i.deployment;
  const prepared = await onOperation(deployment, stored, s, (id) => swapService.prepare(id), async (id) => swapService.prepare(id, undefined, await resumeRequestOf(stored, s, deployment)));
  const gate = await checkBeforeSigning({ prepared, order, journaled: stored as unknown as JournaledOrder, factory: swapFactoryOf(deployment), chainId: BigInt(deployment.chainId), acceptMin: i.acceptMin, pooled: (deployment.erc20Vaults ?? []).map((v) => ({ token: v.token, symbol: v.symbol, decimals: v.decimals })), deployment, masterSeed: i.masterSeed });
  return gate.ok ? null : gate.moved;
}

/**
 * No signed call is handed over closer than this to its deadline (audit round 2, r02): the relayer sends no execution in the
 * last EXECUTE_MARGIN_SECONDS (36 s) before it and refuses to take one, and the hand-over itself takes a few round trips.
 */
export const HAND_OVER_MARGIN_SECONDS = 48;

/** The signed call is too close to its deadline to be handed over: the runners prepare and sign a fresh one. */
export class CallTooClose extends Error {
  readonly code = "deadline_too_close";
  constructor(readonly deadline: number) {
    super(`the signed call's deadline is less than ${HAND_OVER_MARGIN_SECONDS} s away: a fresh call is prepared and signed`);
  }
}

export interface HandOverInput { deployment: Deployment | null; session?: WalletSession; stored: StoredSwap; order: ServiceOrder; signed: Signed; submission: Submission }

/** Hand a checked, signed and simulated execution to the service (finalize) and the relayer's executor. */
export async function handOverSigned(i: HandOverInput): Promise<{ job?: SwapJob }> {
  const s = i.session ?? defaultSession;
  const { stored, order, signed } = i;
  if (!signed.sim.ok) throw new Error(`Not handed over: ${signed.sim.reason}. The signature stays in this wallet; confirm again later against a fresh quote, or return the order to your private balance.`);
  // before anything is registered or finalized: a call this close to its deadline would never be sent (audit round 2, r02)
  if (signed.prepared.deadline - Date.now() / 1000 < HAND_OVER_MARGIN_SECONDS) throw new CallTooClose(signed.prepared.deadline);
  const refundNoteData = stored.refundNoteData as Hex | undefined;
  if (!refundNoteData) throw new Error("this order has no refund payload in the journal; it is not handed over");
  // V6 Stage 12: the executor watches the shield receiver before the order can deliver into it (idempotent by receipt)
  if (stored.shield) {
    if (i.submission.kind !== "relayer") throw new Error("Not handed over: a swap into the protected balance needs a relayer to shield its delivery (Settings → relayer submission).");
    const job = await relayerShieldRegister(i.submission.url, shieldJobRequest(stored));
    patchSwap(order.orderId, { shield: { ...stored.shield, registeredAt: Date.now(), job: shieldJobView(job) } }, s);
  }
  // the order's vouch from its commit, for the API's vouch for this call (audit gap 47); a resumed operation is the same order
  const fin = await onOperation(i.deployment, stored, s, (id) => swapService.finalize(id, signed.signature, stored.orderVouch));
  if (i.submission.kind !== "relayer") return {};
  const factory = swapFactoryOf(i.deployment); // the swap service's own was read before the call was prepared (prepareAndSign)
  const { refundTokens, refundFloors } = signed.call;
  if (refundTokens?.length) patchSwap(order.orderId, { refundTokens, refundFloors }, s);
  const job = await relayerSwapExecute(i.submission.url, {
    factory,
    params: signed.params,
    execution: fin.execution,
    refundNoteData,
    ...(refundTokens?.length ? { refundTokens, refundFloors } : {}),
    ...(fin.vouch?.execution ? { vouch: { execution: fin.vouch.execution as Hex } } : {}), // the relayer executes only a vouched call
  });
  patchSwap(order.orderId, { jobId: job.id, state: job.state, executionRef: signed.prepared.provider, relayerUrl: i.submission.url }, s); // the provider's reference for tracking (NEAR Intents: the deposit address); the relayer it went to (r38)
  const r = stored.request as { to?: { chain?: string }; destination?: string };
  if (r.to?.chain && r.destination && !stored.shield) markAddressUsed(chainKindOf(r.to.chain), r.destination, order.orderId, s); // High-Value Protection spec §12: the destination is in use
  return { job };
}

export { shieldJobView };

/**
 * Return a funded order to the private balance without executing it: a refund-only job (the journaled params and
 * refund payload, no signature) re-shields the escrow's balance as the committed note once the window opens.
 */
export async function returnOrderToBalance(i: { deployment: Deployment | null; session?: WalletSession; stored: StoredSwap; submission: Submission }): Promise<SwapJob> {
  const s = i.session ?? defaultSession;
  const { stored } = i;
  if (i.submission.kind !== "relayer") throw new Error(`Switch to relayer submission (Settings), or call deployAndRefund on the factory yourself after ${new Date((stored.params as { refundAfter: number }).refundAfter * 1000).toLocaleString()}.`);
  const refundNoteData = stored.refundNoteData as Hex | undefined;
  if (!refundNoteData) throw new Error("this order has no refund payload in the journal");
  const job = await relayerSwapRefund(i.submission.url, {
    factory: swapFactoryOf(i.deployment),
    params: stored.params as any,
    refundNoteData,
    ...(stored.refundTokens?.length ? { refundTokens: stored.refundTokens as Address[], refundFloors: stored.refundFloors } : {}),
    ...(stored.orderVouch ? { vouch: { order: stored.orderVouch as Hex } } : {}), // the relayer refunds only a vouched order
  });
  // a relayer that keeps a completed job closed (one from before audit round 2, r36) re-shields nothing: said, never journaled
  // as closed — the order stays open, its escrow read
  if (job.state === "completed")
    throw new Error("The executor no longer watches this order's escrow and re-shields nothing there now. Anyone can call deployAndRefund on the factory to return it to your private balance; the wallet keeps reading the escrow.");
  patchSwap(stored.orderId, { jobId: job.id, state: job.state, relayerUrl: i.submission.url }, s);
  return job;
}

export type { ExecutionPlan };
