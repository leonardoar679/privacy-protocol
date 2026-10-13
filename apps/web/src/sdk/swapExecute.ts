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
import { swapService, type CompetitionEntry, type ExecutionPlan, type Policy, type Prepared, type Preference, type ServiceOrder, type ServiceOrderParams, type ServiceQuote, type SwapRequest, type Tier as ServiceTier } from "./swapService";
import { checkOrder, OrderMismatch, predictEscrow } from "./swapGuard";
import { checkBeforeSigning, type JournaledOrder } from "./swapSign";
import type { CheckedCall, MinimumMoved } from "./providerCall";
import { deriveOrderKey, deriveRefundNote, signExecutionDigest, type RefundNote } from "../keys/swapKeys";
import { relayerInfo, relayerSwapExecute, relayerSwapRefund, type SwapJob } from "./relayer";
import { patchSwap, swapFactoryOf } from "./swapFunding";
import { DELAY_WINDOW } from "./policy";
import { noteStore } from "../wallet/notes";
import { session as defaultSession, type WalletSession } from "../wallet/session";
import type { Submission } from "../wallet/settings";
import type { StoredSwap } from "../wallet/journal";
import { activityId, recordActivity } from "../wallet/activity";
import { markAddressUsed } from "../wallet/addressBook";
import { chainKindOf } from "../keys/chainKeys";
import { sampleDueAt, scheduleAction } from "../wallet/schedule";

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
  now?: number;
}
export interface Committed { stored: StoredSwap; order: ServiceOrder; key: { privateKey: Hex; address: Hex }; refund: RefundNote; response: Awaited<ReturnType<typeof swapService.order>> }

/** Commit an order: the one-time key and the refund note fixed first, `/order`, the escrow checked, the order journaled (and, for a plain order, its funding scheduled). */
export async function commitOrder(i: CommitInput): Promise<Committed> {
  const s = i.session ?? defaultSession;
  const now = i.now ?? Date.now();
  const factory = swapFactoryOf(i.deployment);
  // the signer must be fixed at commit time, before the service chooses the orderId, so a one-time key is derived per attempt from a random attempt id (never reused: a new attempt, a new key)
  const attemptId = randomHex32();
  const key = deriveOrderKey(i.masterSeed, attemptId);
  const refundCounter = noteStore.allocateCounter();
  const refund = deriveRefundNote(i.masterSeed, refundCounter);
  const req = i.request;
  const response = await swapService.order({ ...req, policy: i.policy, provider: i.provider, orderSigner: key.address, refundOwnerCommitment: refund.ownerCommitment.toString(), refundNoteSecret: refund.noteSecret.toString(), refundNoteDataHash: refund.noteDataHash });
  // the escrow is recomputed here from OUR factory and the params; every field we chose is checked
  checkOrder(response.order, { factory, orderSigner: key.address as Address, refund, amount: BigInt(req.amount), asset: i.fromAsset });
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
    orderId: order.orderId, attemptId, refundCounter, provider: order.quote.provider, policy: orderPolicy, request: { from: req.from, to: req.to, amount: req.amount, destination: req.destination, slippageBps: req.slippageBps },
    params: order.params, endpoint: order.endpoint, quote: order.quote, approvedMin: (i.shown ?? order.quote).toAmountMin, createdAt: now, dueAt, state: "committed", refundNoteData: refund.noteData, // the random payload is journaled (encrypted); the key is re-derived from attemptId
    preference: i.preference, tier: journaledTier, value: order.value ?? response.value, plan: order.plan ?? i.shown?.plan, ...(i.competition ? { competition: i.competition } : {}), ...(reviewHoldUntil !== undefined ? { reviewHoldUntil } : {}),
    ...(i.campaign ? { campaign: i.campaign } : {}),
  };
  if (i.lint) stored.lint = { items: i.lint, at: now };
  s.update((j) => { j.swaps = [...j.swaps.filter((x) => x.orderId !== stored.orderId), stored]; });
  recordActivity({ id: activityId("swap", stored.orderId), kind: "swap", asset: i.fromAsset.symbol, decimals: i.fromAsset.decimals, amount: req.amount, status: "committed", ref: stored.orderId, note: `→ ${req.to.symbol}${i.campaign ? ` · step ${i.campaign.index + 1}` : ""}` }, s);
  if (dueAt !== undefined) scheduleAction({ kind: "fund-escrow", orderId: stored.orderId, dueAt }, s);
  return { stored, order, key, refund, response };
}

/** Rebuild an order the service forgot (a restart) from the journaled params: the same params give the same escrow, checked here. */
export async function resumeOrder(deployment: Deployment | null, stored: StoredSwap): Promise<ServiceOrder> {
  const out = await swapService.resume({ request: stored.request as any, policy: stored.policy as Policy, provider: stored.provider, params: stored.params as any, ...(stored.tier ? { tier: stored.tier as ServiceTier } : {}), ...(stored.preference ? { preference: stored.preference as Preference } : {}) });
  const predicted = predictEscrow(swapFactoryOf(deployment), stored.params as any);
  if (out.order.endpoint.toLowerCase() !== predicted.toLowerCase() || out.order.orderId.toLowerCase() !== stored.orderId.toLowerCase()) throw new OrderMismatch("endpoint", "the resumed order is not the one this wallet committed");
  return out.order;
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
  onStatus?: (line: string) => void;
}

/**
 * Re-quote with the escrow as sender, check the provider call against the journal, sign it locally and simulate the
 * execution on every RPC endpoint (whale spec §24). The signature stays in memory until it is handed over.
 */
export async function prepareAndSign(i: PrepareInput): Promise<Signed | { moved: MinimumMoved }> {
  const s = i.session ?? defaultSession;
  const { stored, order } = i;
  if (!i.deployment) throw new Error("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT).");
  const journaled = stored as unknown as JournaledOrder; // the wallet's own record: what it asked for, the params it committed, the minimum approved
  const orderKey = deriveOrderKey(i.masterSeed, stored.attemptId as Hex);
  i.onStatus?.("Re-quoting with the escrow as sender, then checking the call…");
  const prepared = await swapService.prepare(order.orderId);
  // the digest is of exactly the call shown; the call pays your fresh address from a pinned provider, refunds to the escrow, and guarantees the approved minimum
  const gate = await checkBeforeSigning({ prepared, order, journaled, factory: swapFactoryOf(i.deployment), chainId: BigInt(i.deployment.chainId), acceptMin: i.acceptMin, pooled: (i.deployment.erc20Vaults ?? []).map((v) => v.token) });
  if (!gate.ok) return { moved: gate.moved };
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

export interface HandOverInput { deployment: Deployment | null; session?: WalletSession; stored: StoredSwap; order: ServiceOrder; signed: Signed; submission: Submission }

/** Hand a checked, signed and simulated execution to the service (finalize) and the relayer's executor. */
export async function handOverSigned(i: HandOverInput): Promise<{ job?: SwapJob }> {
  const s = i.session ?? defaultSession;
  const { stored, order, signed } = i;
  if (!signed.sim.ok) throw new Error(`Not handed over: ${signed.sim.reason}. The signature stays in this wallet; confirm again later against a fresh quote, or return the order to your private balance.`);
  const refundNoteData = stored.refundNoteData as Hex | undefined;
  if (!refundNoteData) throw new Error("this order has no refund payload in the journal; it is not handed over");
  const fin = await swapService.finalize(order.orderId, signed.signature);
  if (i.submission.kind !== "relayer") return {};
  const health = await swapService.health();
  const factory = swapFactoryOf(i.deployment);
  if (health.deployment.factory.toLowerCase() !== factory.toLowerCase()) throw new OrderMismatch("factory", `the swap service builds for ${health.deployment.factory}, this wallet for ${factory}`);
  const { refundTokens, refundFloors } = signed.call;
  if (refundTokens?.length) patchSwap(order.orderId, { refundTokens, refundFloors }, s);
  const job = await relayerSwapExecute(i.submission.url, { factory, params: signed.params, execution: fin.execution, refundNoteData, ...(refundTokens?.length ? { refundTokens, refundFloors } : {}) });
  patchSwap(order.orderId, { jobId: job.id, state: job.state, executionRef: signed.prepared.provider }, s); // the provider's reference for tracking (NEAR Intents: the deposit address)
  const r = stored.request as { to?: { chain?: string }; destination?: string };
  if (r.to?.chain && r.destination) markAddressUsed(chainKindOf(r.to.chain), r.destination, order.orderId, s); // High-Value Protection spec §12: the destination is in use
  return { job };
}

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
  const job = await relayerSwapRefund(i.submission.url, { factory: swapFactoryOf(i.deployment), params: stored.params as any, refundNoteData, ...(stored.refundTokens?.length ? { refundTokens: stored.refundTokens as Address[], refundFloors: stored.refundFloors } : {}) });
  patchSwap(stored.orderId, { jobId: job.id, state: job.state }, s);
  return job;
}

export type { ExecutionPlan };
