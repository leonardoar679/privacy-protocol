// The swap routes of the API (spec v2.0 §15; was packages/swap-engine/src/server.ts, the V1.1–V5 loopback service): the
// handlers over the engine and the store, each answering { status, body } so app.ts only maps them to Express. The API
// never holds money keys: the wallet sends the one-time order SIGNER (an address) and the refund note's commitment, and
// receives the digest to sign. Quotes are live. An operation (a swap or a cross-chain swap) is created at commit with an
// opaque `op_` id; its blob (the engine's Order — the destination and the refund material — and the prepared execution)
// lives in the database until finalize nulls it. The wallet's tier is a hint that can only raise the tier, the policy may
// be derived from a preference, prepare keeps the approved minimum and runs the price guard, /track reads a provider's
// status for an executed order.
import { MinimumMovedError, asProviderFailure, type PreparedExecution, type PrivateSwapEngine, type QuoteHint } from "@privacy-wallet/swap-engine/engine";
import { riskDb } from "@privacy-wallet/swap-engine/risk/riskDb";
import { securityBreakdown } from "@privacy-wallet/swap-engine/risk/security";
import { fileIncidents, incidents } from "@privacy-wallet/swap-engine/health";
import { userStatus } from "@privacy-wallet/swap-engine/order";
import { maxGapBpsFor, PriceGuardError } from "@privacy-wallet/swap-engine/scoring";
import {
  isPolicy,
  isPreference,
  type AssetRef,
  type Order,
  type OrderParams,
  type Policy,
  type Preference,
  type ProviderId,
  type Quote,
  type QuoteRequest,
  type Tier,
  type TrackStatus,
  type UserStatus,
} from "@privacy-wallet/swap-engine/types";
import { isTier } from "@privacy-wallet/swap-engine/valuation";
import { gatewayHealth, gatewayQuote, type GatewayConfig } from "@privacy-wallet/swap-engine/gateway";
import { STALL_FACTOR, type ProtectionMode } from "@privacy-wallet/protocol/wallet/campaign";
import { riskModelOf } from "@privacy-wallet/protocol/wallet/riskClasses";
import { atLeast } from "@privacy-wallet/protocol/wallet/valuation";
import { redactUrls, redactUrlsDeep } from "@privacy-wallet/server-kit/redact";
import { predictEscrow, recoverExecutionSigner, restoreDigest, restoreRequestText } from "@privacy-wallet/swap-engine/endpoints";
import type { Voucher } from "../vouch";
import { predictReceiver, receiverParamsOf, receiverParamsProblem, type ReceiverParams, type ReceiverParamsJson } from "@privacy-wallet/contracts";
import { decodeBlob, encodeBlob, wire } from "../blob";
import { newId, OPERATION_ID, QUOTE_ID } from "../ids";
import { quoteOf, type RelayerTerms } from "../quote";
import { reconcileOperation, type ReconcileReads, type Reconciled } from "../reconcile";
import type { Store } from "../store";

export type Answer = { status: number; body: unknown };

/** What a guest sees for a provider's tracking state (plan §33: never "atomic", always one of these). */
export function guestStatus(s: TrackStatus["state"]): UserStatus {
  switch (s) {
    case "completed":
      return "Completed";
    case "partial":
      return "Partial";
    case "refunded":
      return "Refunded";
    case "failed":
      return "Failed";
    case "executing":
    case "destination-submitted":
    case "destination-final":
      return "Executing";
    default:
      return "Pending";
  }
}

export class BadRequest extends Error {}

const otherOrder: Answer = { status: 409, body: { error: "these params are another order's", code: "order_mismatch" } };
const restoreUnsigned: Answer = {
  status: 403,
  body: { error: "an order is rebuilt only for its own key: sign the request with it", code: "restore_unsigned" },
};

/**
 * Whether the order's one-time key signed this restore's request (audit round 2, r05; `restoreDigest`). The escrow commits to
 * the params only, and they are public once an execution is tried (its calldata, the relayer's job): a restore under them
 * with another destination or provider was answered with the operation's id, then stored a prepared call paying that party,
 * which the wallet's re-sign met for good. The text is built from the body as sent, the wallet's own journaled request.
 */
function restoreSigned(chainId: bigint, b: Record<string, unknown>, params: OrderParams, escrow: string): boolean {
  const sig = b.restoreSignature;
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
  const side = (x: unknown) => ({
    chain: String((x as { chain?: unknown } | null)?.chain ?? ""),
    asset: String((x as { asset?: unknown } | null)?.asset ?? ""),
  });
  const text = restoreRequestText({ from: side(b.from), to: side(b.to), destination: String(b.destination ?? ""), provider: String(b.provider ?? "") });
  try {
    return recoverExecutionSigner(restoreDigest(chainId, escrow, text), sig as `0x${string}`).toLowerCase() === params.orderSigner.toLowerCase();
  } catch {
    return false;
  }
}
const sameEscrow = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** How far ahead a restored order's refund may be, besides the refund window: the longest delay budget (72 h) and a day. */
export const RESTORE_HORIZON_SECONDS = 4 * 86_400;

/* eslint-disable @typescript-eslint/no-explicit-any -- the request bodies are read field by field and checked */
const tierHint = (b: any): Tier | undefined => (isTier(b?.tier) ? b.tier : undefined);
const preferenceOf = (b: any): Preference | undefined => (isPreference(b?.preference) ? b.preference : undefined);
/** A policy given explicitly must be one of the five; absent, it is derived from the preference and the tier (whale spec §4). */
function policyOf(b: any): Policy | { preference: Preference } {
  if (b?.policy !== undefined) {
    if (!isPolicy(b.policy)) throw new BadRequest(`unknown policy ${JSON.stringify(b.policy)}`);
    return b.policy;
  }
  return { preference: preferenceOf(b) ?? "balanced" };
}
/** V3 (High-Value Protection spec §3, §14): the protection mode and a tranche's execution window. */
const modeOf = (b: any): ProtectionMode | undefined =>
  b?.mode === "balanced" || b?.mode === "max-privacy" || b?.mode === "max-safety" || b?.mode === "best-execution" ? b.mode : undefined;
const windowOf = (b: any): number | undefined =>
  b?.executeWindowSeconds !== undefined && Number.isFinite(Number(b.executeWindowSeconds)) && Number(b.executeWindowSeconds) > 0
    ? Number(b.executeWindowSeconds)
    : undefined;
const hintsOf = (b: any): QuoteHint => ({ tier: tierHint(b), preference: preferenceOf(b), mode: modeOf(b), executeWindowSeconds: windowOf(b) });
// A V6 follow-up of 2026-10-14: every number and string a request carries is checked here, at the edge. A malformed one
// had reached the engine and the providers as NaN or a crash (a 500 logged as the API's own error), and a provider's
// error over it could have counted against the provider's health for every user.
/** a uint256 in decimal: at most 78 digits */
const UINT = /^\d{1,78}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const short = (x: unknown, max: number): boolean => typeof x === "string" && x.length > 0 && x.length <= max;
/** a transaction id (an EVM hash, a UTXO txid): 64 hex digits, with or without 0x — nothing else reaches a provider's URL */
const TX_HASH = /^(0x)?[0-9a-fA-F]{64}$/;
/** a provider's reference (NEAR Intents: the deposit address): plain characters, bounded */
const PROVIDER_REF = /^[A-Za-z0-9._:-]{1,128}$/;
function asset(a: any): AssetRef {
  const decimals = Number(a?.decimals);
  if (!a || !short(a.chain, 32) || !short(a.asset, 64) || !short(a.symbol, 16) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new BadRequest("an asset is { chain, asset, decimals (0–36), symbol }");
  return { chain: a.chain, asset: a.asset, decimals, symbol: a.symbol };
}
function request(b: any): QuoteRequest {
  if (!UINT.test(String(b?.amount ?? ""))) throw new BadRequest("amount must be base units");
  if (b.grossAmount !== undefined && !UINT.test(String(b.grossAmount))) throw new BadRequest("grossAmount must be base units");
  if (b.grossAmount !== undefined && BigInt(b.grossAmount) < BigInt(b.amount))
    throw new BadRequest("grossAmount (what the user pays) is never below amount (the escrow's funding)");
  const slippageBps = b.slippageBps === undefined ? 50 : Number(b.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new BadRequest("slippageBps must be an integer from 0 to 10000");
  if (b.destination !== undefined && typeof b.destination !== "string") throw new BadRequest("destination must be a string");
  if (typeof b.destination === "string" && b.destination.length > 256) throw new BadRequest("destination is too long");
  return {
    from: asset(b.from),
    to: asset(b.to),
    amount: BigInt(b.amount),
    ...(b.grossAmount !== undefined ? { grossAmount: BigInt(b.grossAmount) } : {}),
    destination: String(b.destination ?? ""),
    slippageBps,
    ...(b.destinationKind === "entered" ? { destinationKind: "entered" as const } : {}),
    ...(b.preferNative === true ? { preferNative: true } : {}),
    ...(b.destinationType === "protected" ? { destinationType: "protected" as const } : {}),
  };
}
function paramsOf(p: any): OrderParams {
  const integer = (x: unknown) => (typeof x === "number" ? Number.isSafeInteger(x) && x >= 0 : typeof x === "string" && /^\d{1,15}$/.test(x));
  if (
    !p ||
    !(typeof p.orderId === "string" && HEX32.test(p.orderId)) ||
    !(p.assetType === 0 || p.assetType === 1 || p.assetType === "0" || p.assetType === "1") ||
    ![p.asset, p.orderSigner, p.refundVault].every((a) => typeof a === "string" && ADDRESS.test(a)) ||
    ![p.amount, p.refundOwnerCommitment, p.refundNoteSecret, p.executorTip].every((n) => UINT.test(String(n ?? ""))) ||
    !integer(p.executeDeadline) ||
    !integer(p.refundAfter) ||
    !(typeof p.refundNoteDataHash === "string" && HEX32.test(p.refundNoteDataHash))
  )
    throw new BadRequest("params must be the order's on-chain parameters");
  return {
    orderId: p.orderId,
    assetType: Number(p.assetType) as 0 | 1,
    asset: p.asset,
    amount: BigInt(p.amount),
    orderSigner: p.orderSigner,
    executeDeadline: Number(p.executeDeadline),
    refundAfter: Number(p.refundAfter),
    refundVault: p.refundVault,
    refundOwnerCommitment: BigInt(p.refundOwnerCommitment),
    refundNoteSecret: BigInt(p.refundNoteSecret),
    refundNoteDataHash: p.refundNoteDataHash,
    executorTip: BigInt(p.executorTip),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
const assessmentOf = (set: { value?: unknown; tier?: Tier }) => ({
  value: (set.value as never) ?? { unavailable: true as const, reason: "not valued" },
  tier: set.tier ?? ("high-value" as Tier),
  failSafe: !set.value || "unavailable" in (set.value as object),
});

interface Blob {
  order: Order;
  prepared?: PreparedExecution;
  /** the provider is the one the engine chose at the commit, not one the caller named (a V6 follow-up of 2026-10-16) */
  chosen?: boolean;
}

/**
 * The engine's words as they leave the API (a V6 follow-up of 2026-10-15): the providers' and the valuer's — the
 * competition's reasons, the errors, the health notes, the filters, the value's reason, a quote's hops and its raw
 * answer — keep only their URLs' hosts. An operator's THORNode or RPC URL may carry a key, and those words had named it
 * in every quote set. The risk records keep their sources: public audit and incident links.
 */
const QUOTE_SET_WORDS = ["errors", "competition", "health", "scores", "value"] as const;
const scrubQuote = <Q extends { hops?: unknown; raw?: unknown }>(q: Q): Q => ({ ...q, hops: redactUrlsDeep(q.hops), raw: redactUrlsDeep(q.raw) });
function scrubSet<S extends { quotes?: { hops?: unknown; raw?: unknown }[] }>(set: S): S {
  const out: Record<string, unknown> = { ...set };
  for (const k of QUOTE_SET_WORDS) if (out[k] !== undefined) out[k] = redactUrlsDeep(out[k]);
  if (Array.isArray(set.quotes)) out.quotes = set.quotes.map(scrubQuote);
  return out as S;
}
const scrubOrder = (o: Order): Order => ({ ...o, quote: scrubQuote(o.quote), ...(o.value ? { value: redactUrlsDeep(o.value) } : {}) });

export interface SwapApiDeps {
  engine: PrivateSwapEngine;
  store: Store;
  gateway: GatewayConfig;
  reads: ReconcileReads;
  relayerTerms(): Promise<RelayerTerms | null>;
  now(): number;
  /** API_VOUCH_KEY's signer: the API vouches for the orders it commits and the calls it prepares for them (audit gap 47); null, none */
  voucher?: Voucher | null;
  /** SHIELD_FACTORY: the deployment's ShieldReceiverFactory, whose receipts the API vouches for (a same-chain swap into the protected balance) */
  shieldFactory?: string | null;
}

const unknownOperation: Answer = { status: 404, body: { error: "unknown order", code: "unknown_order" } };

/** reconcile: one read per operation per this window; a caller in between gets the last answer */
export const RECONCILE_THROTTLE_MS = 5_000;

export class SwapApi {
  /** the answers the throttle serves, each kept only while it serves it */
  private readonly reconciled = new Map<string, { at: number; result: Reconciled }>();
  constructor(readonly d: SwapApiDeps) {}

  private get engine(): PrivateSwapEngine {
    return this.d.engine;
  }
  private adapterOf(id: string) {
    return this.engine.cfg.adapters.find((a) => a.id === id);
  }
  private operation(id: string) {
    return OPERATION_ID.test(id) ? this.d.store.getOperation(id) : null;
  }

  /** POST /v1/quotes: the engine's competition (the V5 quote set, unchanged) with its id and the chosen route as the §46 quote. */
  async quotes(body: unknown): Promise<Answer> {
    const req = request(body);
    const set = await this.engine.quoteAll(req, policyOf(body), hintsOf(body));
    const id = newId("qt");
    const chosen = set.quotes.find((q) => q.provider === set.chosen?.provider);
    this.d.store.putQuote({
      id,
      expiresAt: chosen?.expiresAt ?? Math.floor(this.d.now() / 1000) + 60,
      provider: chosen?.provider ?? null,
      pair: `${req.from.chain}:${req.from.symbol}>${req.to.chain}:${req.to.symbol}`,
      tier: set.tier ?? null,
    });
    const health = this.d.store.health();
    const quote = quoteOf({
      id,
      request: req,
      set,
      terms: await this.d.relayerTerms(),
      chainId: Number(this.engine.cfg.chainId),
      now: this.d.now(),
      recentFailures: (p) => health.find((h) => h.provider === p)?.recentFailures ?? 0,
      // V7 Stage 13 (spec v3.0 §4): the route's measured liquidity from the risk database; the §46 quote blocks an order above it
      routeLimitUsd: chosen ? (riskDb().routeRisk(`${req.from.symbol}>${req.to.symbol}`, chosen.provider)?.servedUpToUsd ?? null) : null,
      healthy: (p) =>
        set.health[p as ProviderId]?.reachable !== false &&
        !set.health[p as ProviderId]?.halted &&
        !this.engine.tracker.state(p as ProviderId, this.d.now()).open,
    });
    return { status: 200, body: { ...(wire(scrubSet(set)) as object), id, ...(quote ? { quote } : {}) } };
  }

  /** POST /v1/operations: commit (the V5 /order: the wallet chose a route and supplies the one-time signer and the refund note), or rebuild an order the wallet journaled (`params` present). */
  async createOperation(body: unknown): Promise<Answer> {
    const b = body as Record<string, unknown>;
    if (b?.params !== undefined) return this.restore(b);
    const req = request(b);
    const set = await this.engine.quoteAll(req, policyOf(b), hintsOf(b));
    const provider = (b.provider ?? set.chosen?.provider) as ProviderId | undefined;
    const quote = set.quotes.find((q) => q.provider === provider);
    if (!quote)
      return {
        status: 400,
        body: {
          error: `no quote from ${provider ?? "any provider"}`,
          code: "no_quote",
          errors: redactUrlsDeep(set.errors),
          competition: redactUrlsDeep(set.competition),
        },
      };
    const filtered = set.scores.find((s) => s.provider === provider)?.filtered;
    if (filtered)
      return {
        status: 400,
        body: { error: redactUrlsDeep(`route filtered: ${filtered}`), code: "route_filtered", competition: redactUrlsDeep(set.competition) },
      };
    // the shapes (the review round of 2026-11-03, F4): a signer of any string had been encoded as a word and vouched for — an
    // order no contract call could ever take, and a relayer job that erred every tick
    if (
      typeof b.orderSigner !== "string" ||
      !ADDRESS.test(b.orderSigner) ||
      !UINT.test(String(b.refundOwnerCommitment)) ||
      !UINT.test(String(b.refundNoteSecret)) ||
      typeof b.refundNoteDataHash !== "string" ||
      !HEX32.test(b.refundNoteDataHash)
    )
      throw new BadRequest(
        "the order needs orderSigner (an address), refundOwnerCommitment and refundNoteSecret (base units) and refundNoteDataHash (32 bytes)",
      );
    const order = this.engine.buildOrder(
      req,
      set.policy,
      quote,
      {
        orderSigner: b.orderSigner,
        refundOwnerCommitment: BigInt(b.refundOwnerCommitment as string),
        refundNoteSecret: BigInt(b.refundNoteSecret as string),
        refundNoteDataHash: b.refundNoteDataHash as `0x${string}`,
      },
      assessmentOf(set),
      preferenceOf(b),
      { executeWindowSeconds: windowOf(b) },
    );
    // a swap into the protected balance pays a shield receipt, which the API vouches for once it is this order's (a V6
    // follow-up of 2026-10-16, audit gap 47): the relayer shields only a receipt the API vouched for
    const shieldVouch = req.destinationType === "protected" && this.d.voucher ? this.receiptVouch(b.shield, req, set.shieldTip, quote.toAmountMin) : undefined;
    if (shieldVouch !== undefined && typeof shieldVouch !== "string") return shieldVouch;
    // a quote id of the service's own shape, or none (the review round of 2026-11-03, F5): the column had kept any string sent
    const operationId = this.record(order, typeof b.quoteId === "string" && QUOTE_ID.test(b.quoteId) ? b.quoteId : null, provider === set.chosen?.provider);
    return {
      status: 200,
      body: wire({
        operationId,
        order: scrubOrder(order),
        scores: redactUrlsDeep(set.scores),
        status: userStatus(order.state),
        tier: order.tier,
        value: redactUrlsDeep(order.value),
        policy: set.policy,
        competition: redactUrlsDeep(set.competition),
        ...(set.protection ? { protection: set.protection } : {}),
        ...(set.risk ? { risk: set.risk } : {}),
        // the order's vouch (audit gap 47): the wallet journals it, shows it at the finalize and hands it with a refund
        ...(this.d.voucher
          ? { vouch: { order: this.d.voucher.order(this.engine.cfg.chainId, order.endpoint), ...(shieldVouch ? { shield: shieldVouch } : {}) } }
          : {}),
      }),
    };
  }

  /**
   * A protected order's shield receipt, vouched for when it is this order's (a V6 follow-up of 2026-10-16, audit gap 47): its
   * receiver is the order's destination, predicted from the deployment's factory; it names the asset the swap delivers; its
   * tip is at least half of the one this service priced now (the wallet built it from its quote, and fees move); and a
   * delivery that meets the order pays that tip: the receipt's minimum is at most the order's minimum output. The relayer
   * shields only a vouched receipt: a receipt of anyone's own, for a token of no value, had cost it its gas, and an ETH one
   * whose minimum a delivery meeting the order does not reach had it shield for nothing.
   */
  private receiptVouch(raw: unknown, req: QuoteRequest, priced: bigint | undefined, orderMin: bigint): `0x${string}` | Answer {
    const refuse = (why: string): Answer => ({ status: 400, body: { error: `the shield receipt is not this order's: ${why}`, code: "bad_shield_receipt" } });
    const factory = this.d.shieldFactory;
    if (!factory) return refuse("this service names no shield receiver factory (SHIELD_FACTORY)");
    let params: ReceiverParams;
    let receiver: string;
    try {
      params = receiverParamsOf(raw as ReceiverParamsJson);
      receiver = predictReceiver(factory as `0x${string}`, params);
    } catch {
      return refuse("its parameters are malformed");
    }
    const problem = receiverParamsProblem(params);
    if (problem) return refuse(problem);
    if (receiver.toLowerCase() !== req.destination.toLowerCase()) return refuse("its receiver is not the order's destination");
    const delivered = req.to.asset === "native" ? "0x0000000000000000000000000000000000000000" : req.to.asset;
    if (params.asset.toLowerCase() !== delivered.toLowerCase()) return refuse("it names another asset than the swap delivers");
    if (priced !== undefined && params.shieldTip * 2n < priced) return refuse(`its tip ${params.shieldTip} is below half of this service's ${priced}`);
    // the receiver pays its tip only on a delivery of at least its minimum (a hundred tips at the least, so dust cannot claim
    // it): above the order's minimum output, a delivery that meets the order would leave it unpaid (a V6 follow-up of
    // 2026-10-16). The relayer shields such an ETH delivery for nothing once the swap is over; a token's stays at the receiver
    if (params.minAmount > orderMin)
      return refuse(`its minimum ${params.minAmount} is above the order's minimum output ${orderMin}: a delivery that meets the order would not pay its tip`);
    return this.d.voucher!.shield(this.engine.cfg.chainId, receiver);
  }

  private record(order: Order, quoteId: string | null, chosen = false): string {
    const id = newId("op");
    const req = order.request;
    this.d.store.createOperation(
      {
        id,
        kind: req.from.chain === req.to.chain ? "swap" : "cross-chain",
        state: "AWAITING_AUTHORIZATION",
        provider: order.quote.provider,
        network: req.from.chain,
        tier: order.tier ?? null,
        quoteId,
        orderId: order.orderId,
        escrow: order.endpoint,
        asset: req.from.asset,
        amount: order.params.amount.toString(),
        executorTip: order.params.executorTip.toString(),
        executeDeadline: order.params.executeDeadline,
        refundAfter: order.params.refundAfter,
      },
      encodeBlob({ order, ...(chosen ? { chosen: true } : {}) } satisfies Blob),
    );
    this.d.store.event({
      event: "operation.created",
      operationId: id,
      provider: order.quote.provider,
      state: "AWAITING_AUTHORIZATION",
      network: req.from.chain,
    });
    return id;
  }

  /** Rebuild an order from the on-chain params the wallet journaled (same params, same escrow); its operation is found by the order or created. */
  private async restore(b: Record<string, unknown>): Promise<Answer> {
    const req = request(b);
    const order = await this.rebuilt(b, req);
    if ("status" in order) return order;
    const known = this.d.store.operationByOrder(order.orderId);
    // an order is its escrow, not its id (the audit's unverified m16, 2026-10-17): an order id is public once a relayer or the
    // chain names it, and other params under it replaced that order's stored order and were answered with its operation id
    if (known && !sameEscrow(known.escrow, order.endpoint)) return otherOrder;
    if (known && !this.d.store.execution(known.id)) this.d.store.setBlob(known.id, encodeBlob({ order, ...this.chosenOf(known.id) } satisfies Blob)); // finalized: never again
    const operationId = known?.id ?? this.record(order, null);
    return {
      status: 200,
      body: wire({
        operationId,
        order: scrubOrder(order),
        status: userStatus(order.state),
        tier: order.tier,
        value: redactUrlsDeep(order.value),
        policy: order.policy,
      }),
    };
  }
  private async rebuilt(b: Record<string, unknown>, req: QuoteRequest): Promise<Order | Answer> {
    const provider = b.provider as ProviderId;
    const params = paramsOf(b.params); // checked before any provider is asked
    // never a refund time further ahead than this service sets one (the audit round of 2026-10-16, c18): a restore records
    // its operation, and one named with a refundAfter years away was never purged
    const horizon = Math.floor(this.d.now() / 1000) + RESTORE_HORIZON_SECONDS + this.engine.cfg.refundWindowSeconds;
    if (params.refundAfter > horizon) throw new BadRequest("params name a refund time further ahead than this service sets one");
    // only for the order's own key, and before any provider is asked (audit round 2, r05)
    if (!restoreSigned(this.engine.cfg.chainId, b, params, predictEscrow(this.engine.cfg.factory, this.engine.cfg.escrowCreationCode, params)))
      return restoreUnsigned;
    // the order's tip is fixed in its escrow: quoted net of it, never priced again (audit round 2, r35)
    const set = await this.engine.quoteAll(req, policyOf(b), { ...hintsOf(b), executorTip: params.executorTip });
    const quote = set.quotes.find((q) => q.provider === provider);
    if (!quote)
      return {
        status: 400,
        body: {
          error: `no quote from ${provider} right now; retry later`,
          code: "no_quote",
          errors: redactUrlsDeep(set.errors),
          competition: redactUrlsDeep(set.competition),
        },
      };
    return this.engine.restoreOrder(req, set.policy, quote, params, assessmentOf(set), preferenceOf(b));
  }

  /** GET /v1/operations/:id: the record's state — never the order, the escrow, an amount or a destination. */
  getOperation(id: string): Answer {
    const row = this.operation(id);
    if (!row) return unknownOperation;
    return {
      status: 200,
      body: {
        id: row.id,
        kind: row.kind,
        state: row.state,
        settlement: row.settlement,
        provider: row.provider,
        tier: row.tier,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        checkedAt: row.checkedAt,
      },
    };
  }

  /**
   * POST /v1/operations/:id/resume: the order rebuilt from the journaled params. Before its finalize the blob is refreshed;
   * after it the API keeps no destination again — a re-sign brings the params with its prepare (`restore`).
   */
  async resume(id: string, body: unknown): Promise<Answer> {
    const row = this.operation(id);
    if (!row) return unknownOperation;
    const b = body as Record<string, unknown>;
    const order = await this.rebuilt(b, request(b));
    if ("status" in order) return order;
    if (order.orderId.toLowerCase() !== row.orderId || !sameEscrow(row.escrow, order.endpoint)) return otherOrder;
    if (!this.d.store.execution(id)) this.d.store.setBlob(id, encodeBlob({ order, ...this.chosenOf(id) } satisfies Blob));
    return { status: 200, body: wire({ operationId: id, order, status: userStatus(order.state), tier: order.tier, value: order.value, policy: order.policy }) };
  }

  /**
   * POST /v1/operations/:id/prepare: re-quote with the escrow as sender; the digest to sign (the approved minimum kept, the
   * price guard from enhanced). An operation whose blob is gone (finalized, then signed again) is rebuilt from `restore`, the
   * journaled params the wallet sends with it; the blob then lives until the next finalize.
   */
  async prepare(id: string, body: unknown): Promise<Answer> {
    const row = this.operation(id);
    if (!row) return unknownOperation;
    const raw = this.d.store.blob(id);
    let blob: Blob;
    if (raw) blob = decodeBlob<Blob>(raw);
    else {
      const restore = (body as { restore?: Record<string, unknown> } | undefined)?.restore;
      if (!restore) return unknownOperation; // the wallet sends its journaled params with the prepare
      const order = await this.rebuilt(restore, request(restore));
      if ("status" in order) return order;
      if (order.orderId.toLowerCase() !== row.orderId || !sameEscrow(row.escrow, order.endpoint)) return otherOrder;
      blob = { order };
    }
    const adapter = this.adapterOf(blob.order.quote.provider);
    if (!adapter) return { status: 400, body: { error: "unknown provider", code: "unknown_provider" } };
    const b = body as Record<string, unknown> | undefined;
    const approvedMin = b?.approvedMin !== undefined && /^\d+$/.test(String(b.approvedMin)) ? BigInt(b.approvedMin as string) : undefined;
    const tier = blob.order.tier;
    const guard = tier && atLeast(tier, "enhanced") ? await this.guardFor(blob.order, tier) : undefined;
    try {
      const prepared = await this.engine.prepareExecution(blob.order, adapter, guard, approvedMin);
      // written back only while the operation still has its blob (the fourth review round, 2026-11-03): a finalize that ran during the
      // provider's round-trip nulled it, and this write had put the destination, the refund material and the signer back for the
      // retention window — and let a second finalize follow. A blob rebuilt from a restore (none was there) is written as before
      const next = encodeBlob({ order: blob.order, prepared, ...(blob.chosen ? { chosen: true } : {}) } satisfies Blob);
      if (raw) {
        if (!this.d.store.setBlobIfPresent(id, next)) return unknownOperation;
      } else this.d.store.setBlob(id, next);
      return {
        status: 200,
        body: wire({
          digest: prepared.digest,
          provider: prepared.provider,
          value: prepared.value,
          calldata: prepared.calldata,
          deadline: prepared.deadline,
          ingress: prepared.ingress,
          quote: prepared.quote,
          plan: prepared.quote.plan,
        }),
      };
    } catch (e) {
      if (e instanceof MinimumMovedError)
        return { status: 409, body: wire({ error: e.message, code: "minimum_moved", approvedMin: e.approvedMin, newMin: e.newMin }) };
      if (e instanceof PriceGuardError) {
        // V3 §10: repeated divergence opens the breaker, counted only where no caller's choice makes it (a V6 follow-up of 2026-10-16)
        if (await this.divergenceCounts(blob)) this.engine.tracker.recordQuoteDivergence(e.provider as ProviderId, e.gapBps, id);
        return {
          status: 409,
          body: wire({ error: e.message, code: "price_guard", provider: e.provider, best: e.best, gapBps: e.gapBps, maxGapBps: e.maxGapBps }),
        };
      }
      throw e;
    }
  }

  /** POST /v1/operations/:id/finalize: the wallet's signature over the prepared digest attached; the blob — destination and refund material — is gone from here on. */
  finalize(id: string, body: unknown): Answer {
    const row = this.operation(id);
    const raw = row ? this.d.store.blob(id) : null;
    if (!row || !raw) return unknownOperation;
    const blob = decodeBlob<Blob>(raw);
    if (!blob.prepared) return { status: 404, body: { error: "order not prepared", code: "order_not_prepared" } };
    const signature = (body as { signature?: unknown })?.signature;
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new BadRequest("signature must be hex");
    // the call is vouched for only on an order this API committed (audit gap 47): the wallet shows the vouch it got at the
    // commit. An order rebuilt from params (a restore, a resume) gets none of its own, so anyone's params get no call's vouch;
    // checked before anything is finalized
    const voucher = this.d.voucher;
    const chainId = this.engine.cfg.chainId;
    if (voucher && !voucher.vouched(chainId, blob.order.endpoint, (body as { vouch?: unknown })?.vouch))
      return { status: 400, body: { error: "this order carries no vouch of this API from its commit", code: "unvouched_order" } };
    let execution;
    try {
      execution = this.engine.attachSignature(blob.order, blob.prepared, signature as `0x${string}`);
    } catch {
      throw new BadRequest("the signature is not the order signer's over the prepared digest");
    }
    const q = blob.prepared.quote;
    const seconds = Math.round(Number(q.plan?.expectedSeconds ?? q.etaSeconds));
    this.d.store.finalize(id, { providerRef: blob.prepared.provider, ...(Number.isSafeInteger(seconds) && seconds > 0 ? { expectedSeconds: seconds } : {}) });
    this.d.store.event({ event: "operation.finalized", operationId: id, provider: row.provider, state: row.state, network: row.network });
    return {
      status: 200,
      body: wire({ execution, order: blob.order, ...(voucher ? { vouch: { execution: voucher.execution(chainId, blob.order.endpoint, execution) } } : {}) }),
    };
  }

  /** POST /v1/operations/:id/reconcile: the API's reads (relayer job, escrow, provider) → { state, settlement, refs, checkedAt, sources }. */
  async reconcile(id: string): Promise<Answer> {
    const row = this.operation(id);
    if (!row) return unknownOperation;
    // An answer is kept only while the throttle serves it. Before, every operation's last answer (its state and its
    // transactions) stayed in memory for the process's life, past the database's own retention.
    const now = this.d.now();
    for (const [k, v] of this.reconciled) if (now - v.at >= RECONCILE_THROTTLE_MS) this.reconciled.delete(k);
    const last = this.reconciled.get(id);
    if (last) return { status: 200, body: last.result };
    const result = await reconcileOperation(this.d.store, row, this.d.reads, now);
    this.reconciled.set(id, { at: this.d.now(), result });
    return { status: 200, body: result };
  }

  /**
   * The price guard's alternatives (whale spec §14): the routes the engine would execute now (a V6 follow-up of 2026-10-16). Every
   * live quote had counted, those the scoring refused too (NEAR Intents' withheld ingress, a stream over 4 h, a halted route, one
   * above its limit), so a quote nobody would take refused a sound one, and counted against its provider.
   */
  private async guardFor(order: Order, tier: Tier): Promise<{ alternatives: Quote[]; maxGapBps: number }> {
    const set = await this.engine.quoteAll(order.request, order.policy, { tier }).catch(() => null);
    const executable = new Set((set?.scores ?? []).filter((s) => !s.filtered).map((s) => s.provider));
    return { alternatives: (set?.quotes ?? []).filter((q) => executable.has(q.provider)), maxGapBps: maxGapBpsFor(tier) };
  }

  /**
   * Whether the guard's refusal counts against the provider (V3 §10), where no caller's choice makes it (a V6 follow-up of
   * 2026-10-16): the route the engine chose at the commit, an order the service values from the enhanced tier by its own read
   * (a caller's hint raises the tier), its escrow funded. Anyone's unfunded orders, on a provider of their choosing, had kept
   * any provider's breaker open for every user. The tracker counts each operation once.
   */
  /**
   * The stored order's `chosen` flag, kept through every rewrite of its blob (audit round 2, n05): a prepare's own write, a
   * restore's and a resume's had dropped it, and a guard refusal on any later prepare never counted against the provider.
   */
  private chosenOf(id: string): { chosen?: true } {
    const raw = this.d.store.blob(id);
    return raw && decodeBlob<Blob>(raw).chosen ? { chosen: true } : {};
  }

  private async divergenceCounts(blob: Blob): Promise<boolean> {
    if (!blob.chosen) return false;
    const own = await this.engine.assess(blob.order.request).catch(() => null);
    if (!own || !atLeast(own.tier, "enhanced")) return false;
    const balance = await this.d.reads.escrowBalance(blob.order.endpoint, blob.order.request.from.asset).catch(() => null);
    return balance !== null && balance >= BigInt(blob.order.params.amount);
  }

  /** GET /v1/track/:provider: the destination side of an executed order, stateless, from the execution transaction (NEAR: the deposit address as ref). */
  async track(provider: string, query: URLSearchParams): Promise<Answer> {
    const adapter = this.adapterOf(provider);
    if (!adapter) return { status: 404, body: { error: "unknown provider", code: "unknown_provider" } };
    const tx = query.get("tx") ?? undefined,
      ref = query.get("ref") ?? undefined;
    if (!tx && !ref) throw new BadRequest("tx (the execution transaction) or ref (the provider's reference) is required");
    if (tx !== undefined && !TX_HASH.test(tx)) throw new BadRequest("tx must be a transaction hash");
    if (ref !== undefined && !PROVIDER_REF.test(ref)) throw new BadRequest("ref must be a provider's reference");
    // the order's decimals, for a provider that tracks in its own units (THORChain's 1e8; the audit round of 2026-10-16, c25)
    const decimalsOf = (name: string): number | undefined => {
      const v = query.get(name);
      if (v === null) return undefined;
      if (!/^\d{1,2}$/.test(v) || Number(v) > 36) throw new BadRequest(`${name} must be a whole number of decimals from 0 to 36`);
      return Number(v);
    };
    const out = decimalsOf("outDecimals"),
      inn = decimalsOf("inDecimals");
    const decimals = out !== undefined || inn !== undefined ? { ...(out !== undefined ? { out } : {}), ...(inn !== undefined ? { in: inn } : {}) } : undefined;
    const t = await adapter.track({ sourceTxHash: tx, providerRef: ref, ...(decimals ? { decimals } : {}) }).catch((e: unknown) => {
      throw asProviderFailure(adapter.id, e);
    });
    // V3 §10: a settlement stall counts against the provider only for an execution the API itself knows — named by its
    // operation (an opaque id only its wallet holds), executed by the relayer as exactly this transaction, and timed by
    // the API's own records (the hand-over and the plan's seconds). A V6 follow-up of 2026-10-14: the caller's `since`
    // and `expected` had been taken on trust, and two requests about made-up transactions opened the provider's breaker,
    // which steers every user's quotes away from it.
    const open = !["completed", "refunded", "failed"].includes(t.state);
    const stalled = open && tx ? await this.stalledOperation(provider, query.get("operation"), tx) : null;
    if (stalled) this.engine.tracker.recordSettlementStall(provider as ProviderId, `${provider}:${stalled}`, this.d.now());
    return { status: 200, body: wire({ track: t, status: guestStatus(t.state), ...(stalled ? { stalled: true } : {}) }) };
  }

  /** The operation whose settlement this read shows stalled, from the API's own records; null otherwise. */
  private async stalledOperation(provider: string, operationId: string | null, tx: string): Promise<string | null> {
    const row = operationId ? this.operation(operationId) : null;
    if (!row || row.provider !== provider) return null;
    const ex = this.d.store.execution(row.id);
    if (!ex?.expectedSeconds || this.d.now() - ex.finalizedAt <= STALL_FACTOR * ex.expectedSeconds * 1000) return null;
    // the relayer's execution of this order: as a reconcile recorded it, else read now
    let executed = ex.executionTx;
    if (!executed) {
      const job = await this.d.reads.job(row.orderId);
      executed = job && job !== "none" ? (job.executionTx ?? null) : null;
    }
    return executed && executed.toLowerCase() === tx.toLowerCase() ? row.id : null;
  }

  /** GET /v1/risk[/:provider]: the record, the security breakdown, the breaker's state, the routes — stateless, nothing per user. */
  risk(provider?: string): Answer {
    const db = riskDb(),
      now = this.d.now();
    const view = (id: ProviderId) => {
      const record = db.providerRisk(id);
      const { securityEvents: _e, ...fields } = record ?? { provider: id };
      return {
        provider: id,
        model: riskModelOf(id, {}, { symbol: "" }, { symbol: "" }, "balanced", db.override(id)),
        security: securityBreakdown(id, now, db, fileIncidents(now)), // the operator's incidents too: the wallet's checks read them here (c22)
        breaker: this.engine.tracker.state(id, now),
        record: record ? fields : null,
        routes: [...db.routes.values()]
          .filter((r) => r.provider === id)
          .map((r) => ({
            pair: r.pair,
            class: r.class,
            measuredAt: r.measuredAt,
            servedUpToUsd: r.servedUpToUsd,
            gate: r.gate,
            maxTrancheBps: r.maxTrancheBps,
            providerShareCapBps: r.providerShareCapBps,
            minTrancheUsd: r.minTrancheUsd,
          })),
      };
    };
    if (provider === undefined) return { status: 200, body: wire({ providers: this.engine.cfg.adapters.map((a) => view(a.id)), problems: db.problems }) };
    if (!this.adapterOf(provider)) return { status: 404, body: { error: "unknown provider", code: "unknown_provider" } };
    return { status: 200, body: wire(view(provider as ProviderId)) };
  }

  /** GET /v1/status: the deployment every order is built for, the providers, the incidents feeding the scores, the risk database. */
  async status(): Promise<Answer> {
    const providers = await this.engine.healthAll(); // cached, each within the competition's budget: the wallet reads this before every hand-over
    const listed = this.d.voucher ? (await this.d.relayerTerms())?.vouchers : undefined; // its /info, cached 30 s (a miss too)
    const db = riskDb(),
      inc = incidents();
    const byProvider: Record<string, number> = {};
    for (const i of inc) byProvider[i.provider] = (byProvider[i.provider] ?? 0) + 1;
    return {
      status: 200,
      body: wire({
        // the voucher a relayer is configured with (API_VOUCHER): null when this API vouches for nothing
        deployment: {
          chainId: this.engine.cfg.chainId,
          factory: this.engine.cfg.factory,
          nativeVault: this.engine.cfg.refundVaults.native,
          voucher: this.d.voucher?.address ?? null,
          // while the key rotates: the former addresses whose commit vouches the finalize still honors (relayers list them too)
          previousVouchers: this.d.voucher?.previous ?? [],
          // whether the relayer this API reads (RELAYER_URL) runs what it vouches for: its /info lists the current address (a V6
          // follow-up of 2026-10-16). Null when unknown: no key, no answer, or a relayer that names no list
          relayerAcceptsVoucher: this.d.voucher && listed ? listed.includes(this.d.voucher.address.toLowerCase()) : null,
        },
        providers: redactUrlsDeep(providers),
        incidents: { total: inc.length, byProvider },
        riskDb: { providers: db.providers.size, assets: db.assets.size, routes: db.routes.size, problems: db.problems },
      }),
    };
  }

  /** GET /v1/providers/health: each provider's last sample and its recent failures, with the breaker's state now. */
  providersHealth(): Answer {
    const now = this.d.now();
    return {
      status: 200,
      body: wire({ providers: this.d.store.health().map((h) => ({ ...h, breaker: this.engine.tracker.state(h.provider as ProviderId, now) })) }),
    };
  }

  // ---- walletless / guest mode (plan §49): no pool, no escrow, no keys — a quote and a one-time deposit instruction
  async guestQuote(body: unknown): Promise<Answer> {
    const b = body as Record<string, unknown>;
    const set = await this.engine.quoteAll(request(b), b?.policy === undefined ? "best-price" : policyOf(b), { tier: tierHint(b), mode: modeOf(b) });
    return { status: 200, body: wire(scrubSet(set)) };
  }
  /** Only providers whose deposit address and memo the browser verifies against an independent gateway quorum (THORChain). */
  async guestIngress(body: unknown): Promise<Answer> {
    const req = { ...request(body), plan: "single" as const }; // a UTXO deposit carries one memo of at most 80 bytes: never streamed
    const adapter = this.adapterOf("thorchain");
    if (!adapter) return { status: 503, body: { error: "THORChain adapter unavailable", code: "capacity" } };
    if (!["bitcoin", "litecoin", "doge"].includes(req.from.chain))
      throw new BadRequest("guest deposits are for native-chain sources (BTC, LTC, DOGE); use the wallet for EVM sources");
    const failed = (e: unknown): never => {
      throw asProviderFailure(adapter.id, e);
    };
    const quote = await adapter.quote(req).catch(failed);
    const ingress = await adapter.prepareIngress(req, quote).catch(failed);
    if (ingress.kind !== "plain-address") throw new BadRequest("no plain deposit address for this route");
    return {
      status: 200,
      body: wire({
        provider: adapter.id,
        quote,
        ingress: { to: ingress.to, memo: ingress.memo, amount: req.amount, expiresAt: ingress.expiresAt, verified: ingress.verified ?? [] },
        status: "Pending",
      }),
    };
  }
  async guestTrack(provider: string, txid: string): Promise<Answer> {
    const adapter = this.adapterOf(provider);
    if (!adapter || !txid) return { status: 404, body: { error: "unknown provider or missing txid", code: "unknown_provider" } };
    if (!TX_HASH.test(txid)) throw new BadRequest("txid must be a transaction id");
    const t = await adapter.track({ sourceTxHash: txid }).catch((e: unknown) => {
      throw asProviderFailure(adapter.id, e);
    });
    return { status: 200, body: wire({ track: t, status: guestStatus(t.state) }) };
  }

  // ---- the metered zkAPI quote gateway (whale spec §22): runtime-key auth, 503 with the reason while no upstream exists
  gatewayHealth(): Answer {
    return { status: 200, body: gatewayHealth(this.d.gateway) };
  }
  /**
   * The quote set as /v1/quotes answers it: its bigints as strings (`wire`) and the engine's words with their URLs' hosts
   * only (`scrubSet`). A malformed body is the caller's 400 once the gateway read its key, and an upstream's error keeps
   * only its URLs' hosts. A V6 follow-up of 2026-10-15: the set went out raw, so `res.json` refused its bigints and every
   * metered quote was a 500 the moment ZKAPI_UPSTREAM was set, and a malformed body was a 502, the upstream's fault.
   */
  async gatewayQuote(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<Answer> {
    let req: QuoteRequest | BadRequest;
    try {
      req = request(body);
    } catch (e) {
      if (!(e instanceof BadRequest)) throw e;
      req = e;
    }
    const a = await gatewayQuote(this.d.gateway, headers, body, async (b: unknown) => {
      if (req instanceof BadRequest) throw req;
      return wire(scrubSet(await this.engine.quoteAll(req, policyOf(b), hintsOf(b))));
    });
    if (a.status !== 502) return a;
    if (req instanceof BadRequest) throw req; // the caller's 400, after its key was read
    const failed = a.body as Record<string, unknown>;
    return { status: 502, body: { ...failed, error: redactUrls(String(failed.error ?? "")), code: "provider_unavailable" } };
  }
}
