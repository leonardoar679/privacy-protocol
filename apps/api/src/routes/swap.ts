// The swap routes of the API (spec v2.0 §15; was packages/swap-engine/src/server.ts, the V1.1–V5 loopback service): the
// handlers over the engine and the store, each answering { status, body } so app.ts only maps them to Express. The API
// never holds money keys: the wallet sends the one-time order SIGNER (an address) and the refund note's commitment, and
// receives the digest to sign. Quotes are live. An operation (a swap or a cross-chain swap) is created at commit with an
// opaque `op_` id; its blob (the engine's Order — the destination and the refund material — and the prepared execution)
// lives in the database until finalize nulls it. The wallet's tier is a hint that can only raise the tier, the policy may
// be derived from a preference, prepare keeps the approved minimum and runs the price guard, /track reads a provider's
// status for an executed order.
import { FIELD } from "@privacy-wallet/protocol/field";
import {
  AssetMismatchError,
  MinimumMovedError,
  asProviderFailure,
  type PreparedExecution,
  type PrivateSwapEngine,
  type QuoteHint,
} from "@privacy-wallet/swap-engine/engine";
import { riskDb, routePairOf } from "@privacy-wallet/swap-engine/risk/riskDb";
import { CHAINS, assetOn } from "@privacy-wallet/config";
import type { ChainId } from "@privacy-wallet/protocol-types";
import { securityBreakdown } from "@privacy-wallet/swap-engine/risk/security";
import { fileIncidents, incidents } from "@privacy-wallet/swap-engine/health";
import { userStatus } from "@privacy-wallet/swap-engine/order";
import { maxGapBpsFor, PriceGuardError } from "@privacy-wallet/swap-engine/scoring";
import {
  isPolicy,
  isPreference,
  RefundRouteUnavailable,
  refundRouteWords,
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
import { stallAfterSeconds, type ProtectionMode } from "@privacy-wallet/protocol/wallet/campaign";
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
/**
 * The executor tip the wallet's Review showed (the seventh review round, 2026-11-03): the fresh competition had paid the escrow up
 * to three times the tip the Review said. The eighth review round (H1): the commit prices the tip all the same and builds on the
 * shown one only between half of today's price and the price (the engine's boundedTip; below half, 409 tip_moved) — the shown tip
 * had replaced the price, and the API vouched for orders at a 1-wei tip the relayer then ran at its own cost. Zero, a negative or
 * not a number is no hint (the wallet refuses an order whose tip is above the one it showed).
 */
const tipHintOf = (b: any): { shownTip?: bigint } => {
  if (!isUint256(b?.executorTip)) return {};
  const tip = BigInt(b.executorTip);
  return tip > 0n ? { shownTip: tip } : {};
};
// A V6 follow-up of 2026-10-14: every number and string a request carries is checked here, at the edge. A malformed one
// had reached the engine and the providers as NaN or a crash (a 500 logged as the API's own error), and a provider's
// error over it could have counted against the provider's health for every user.
/** a uint256 in decimal: at most 78 digits */
const UINT = /^\d{1,78}$/;
/** a uint256 (the seventh review round, 2026-11-03): 78 digits reach past 2^256, and such an order integer aliased a vouched escrow */
const isUint256 = (x: unknown): boolean => UINT.test(String(x ?? "")) && BigInt(String(x)) < 1n << 256n;
/** a field element: the refund note's owner commitment and secret are hashed into its commitment */
const isFieldElement = (x: unknown): boolean => isUint256(x) && BigInt(String(x)) < FIELD;
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
/** The request without its refund target: what an order is built on, its price guard's competition asked as an unbound one (ZC's critique). */
function withoutTarget(r: QuoteRequest): QuoteRequest {
  const u = { ...r };
  delete u.refundTarget;
  return u;
}
function request(b: any): QuoteRequest {
  // a uint256 (the eighth review round, A-L3): 78 digits reach past 2^256, and such an amount reached every provider and the planner
  if (!isUint256(b?.amount)) throw new BadRequest("amount must be base units");
  if (b.grossAmount !== undefined && !isUint256(b.grossAmount)) throw new BadRequest("grossAmount must be base units");
  if (b.grossAmount !== undefined && BigInt(b.grossAmount) < BigInt(b.amount))
    throw new BadRequest("grossAmount (what the user pays) is never below amount (the escrow's funding)");
  const slippageBps = b.slippageBps === undefined ? 50 : Number(b.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new BadRequest("slippageBps must be an integer from 0 to 10000");
  if (b.destination !== undefined && typeof b.destination !== "string") throw new BadRequest("destination must be a string");
  if (typeof b.destination === "string" && b.destination.length > 256) throw new BadRequest("destination is too long");
  // where the committed (or reviewed) route refunds a failure, when the wallet names it (the twelfth review round, F12-1, F12-2): Mayan, which
  // chooses its route type afresh, quotes only that one — the one adapter that reads it —, and a rebuild refuses any provider's quote refunding
  // elsewhere (rebuilt). Unsigned: the wallet's signing gate refuses a call refunding at the destination unless its journal names it, and an order
  // journaled at the destination is kept there by the rebuild and the prepare's binding alone
  if (b.refundTarget !== undefined && b.refundTarget !== "escrow" && b.refundTarget !== "destination")
    throw new BadRequest("refundTarget must be escrow or destination");
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
    ...(b.refundTarget === "escrow" || b.refundTarget === "destination" ? { refundTarget: b.refundTarget as "escrow" | "destination" } : {}),
  };
}
function paramsOf(p: any): OrderParams {
  const integer = (x: unknown) => (typeof x === "number" ? Number.isSafeInteger(x) && x >= 0 : typeof x === "string" && /^\d{1,15}$/.test(x));
  if (
    !p ||
    !(typeof p.orderId === "string" && HEX32.test(p.orderId)) ||
    !(p.assetType === 0 || p.assetType === 1 || p.assetType === "0" || p.assetType === "1") ||
    ![p.asset, p.orderSigner, p.refundVault].every((a) => typeof a === "string" && ADDRESS.test(a)) ||
    ![p.amount, p.executorTip].every(isUint256) ||
    ![p.refundOwnerCommitment, p.refundNoteSecret].every(isFieldElement) ||
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
/**
 * An asset a wallet's request names is the registry's (the eighth review round, 2026-11-03, D-M2): on the pool's chain one of the pool's
 * assets as the pool names it (EngineConfig.poolAssets, when set) or the registry's, elsewhere the registry's entry under its symbol and
 * decimals. A request naming Base ETH as "USDC", or decimals a token does not have, had reached every provider, and the answers the
 * adapters' own checks refused had counted as outages against them — three free quotes skipped LI.FI for every user.
 */
function assetProblem(a: AssetRef, poolChain: string, pool: Record<string, { symbol: string; decimals: number }> | undefined): string | null {
  const named = (p: { symbol: string; decimals: number }) => p.symbol.toUpperCase() === a.symbol.toUpperCase() && p.decimals === a.decimals;
  if (a.chain === poolChain && pool) {
    const p = pool[a.asset === "native" ? "native" : a.asset.toLowerCase()];
    if (p) return named(p) ? null : `${a.asset} is ${p.symbol} with ${p.decimals} decimals in this pool, not ${a.symbol} with ${a.decimals}`;
  }
  const r = assetOn(a.chain as ChainId, a.asset === "native" ? null : a.asset);
  if (!r) return `${a.symbol} (${a.asset}) on ${a.chain} is not an asset this service swaps`;
  return named(r) ? null : `${a.asset} on ${a.chain} is ${r.symbol} with ${r.decimals} decimals, not ${a.symbol} with ${a.decimals}`;
}
/** The provider a request names: one of the service's (the eighth review round, A-L3: any value had been cast and looked up). */
const providerOf = (x: unknown, known: (id: string) => boolean): ProviderId | undefined => {
  if (x === undefined) return undefined;
  if (typeof x !== "string" || !known(x)) throw new BadRequest("provider must be one of the service's providers");
  return x as ProviderId;
};
/**
 * The order as its blob keeps it (the eighth review round, A-M2): the quote's raw answer and its hops are the provider's own words,
 * read again at prepare (which re-quotes) — a LI.FI answer alone had been ~14 KB of every free commit, kept for days.
 */
const slimQuote = <Q extends { raw?: unknown; hops?: unknown }>(q: Q): Q => ({ ...q, raw: undefined, hops: [] });
const blobOf = (b: Blob): string =>
  encodeBlob({
    ...b,
    order: { ...b.order, quote: slimQuote(b.order.quote) },
    ...(b.prepared ? { prepared: { ...b.prepared, quote: slimQuote(b.prepared.quote) } } : {}),
  } satisfies Blob);
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
  /** MAX_OPEN_OPERATIONS: the operations not yet ended the service keeps at once (the eighth review round; default 50,000) */
  maxOpenOperations?: number;
}

const unknownOperation: Answer = { status: 404, body: { error: "unknown order", code: "unknown_order" } };
/** the eighth review round (A-M2): the operations not yet ended reached the service's limit — nothing was stored */
const atCapacity: Answer = {
  status: 503,
  body: { error: "the swap service holds too many open orders right now; try again shortly", code: "service_capacity" },
};
/** the eighth review round (A-L2): a re-sign's prepare that a later prepare of the same order overtook */
const superseded: Answer = { status: 409, body: { error: "a later prepare of this order was made meanwhile", code: "prepare_superseded" } };
/** the eighth review round (D-L3): the price guard's competition could not run — the check waits, it is never skipped */
const guardUnavailable: Answer = {
  status: 503,
  body: { error: "the price guard's competition could not run; try again shortly", code: "guard_unavailable" },
};
/** MAX_OPEN_OPERATIONS: the operations not yet ended the service keeps at once (the eighth review round, A-M2) */
export const MAX_OPEN_OPERATIONS = 50_000;

/** reconcile: one read per operation per this window; a caller in between gets the last answer */
export const RECONCILE_THROTTLE_MS = 5_000;

export class SwapApi {
  /** the answers the throttle serves — the read in flight too (the eighth review round, A-I1) — each kept only while it serves it */
  private readonly reconciled = new Map<string, { at: number; result: Promise<Reconciled> }>();
  /** the pool's chain, as the registry names it */
  private readonly poolChain: string;
  constructor(readonly d: SwapApiDeps) {
    this.poolChain = Object.values(CHAINS).find((c) => c.chainId === Number(d.engine.cfg.chainId))?.id ?? "ethereum";
  }
  /** A wallet's request, its assets the registry's (D-M2). */
  private request(b: unknown): QuoteRequest {
    const req = request(b);
    for (const a of [req.from, req.to]) {
      const problem = assetProblem(a, this.poolChain, this.engine.cfg.poolAssets);
      if (problem) throw new AssetMismatchError(problem);
    }
    return req;
  }

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
    const req = this.request(body);
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
      // the record's key names a chain off its asset's home (the eighth review round, D-L1): "ETH>USDC(Base)", never "ETH>USDC"
      routeLimitUsd: chosen ? (riskDb().routeRisk(routePairOf(req.from, req.to), chosen.provider)?.servedUpToUsd ?? null) : null,
      healthy: (p) =>
        set.health[p as ProviderId]?.reachable !== false &&
        !set.health[p as ProviderId]?.halted &&
        !this.engine.tracker.state(p as ProviderId, this.d.now()).open,
    });
    return { status: 200, body: { ...(wire(scrubSet(set)) as object), id, ...(quote ? { quote } : {}) } };
  }

  /** POST /v1/operations: commit (the V5 /order: the wallet chose a route and supplies the one-time signer and the refund note), or rebuild an order the wallet journaled (`params` present). */
  /** Whether a body restores an order this API already holds (by its order id; the restore itself then checks its escrow): A9-3. */
  knownRestore(body: unknown): boolean {
    const raw = (body as { params?: unknown } | null)?.params;
    const id = (raw as { orderId?: unknown } | undefined)?.orderId;
    const known = typeof id === "string" ? this.d.store.operationByOrder(id) : null;
    if (!known) return false;
    // the known row's own escrow only (the tenth review round, B10-12): an order id is public once a relayer or the chain names it, and a body
    // naming one with other params had run a whole competition outside the caller's commit budget
    try {
      return sameEscrow(known.escrow, predictEscrow(this.engine.cfg.factory, this.engine.cfg.escrowCreationCode, paramsOf(raw)));
    } catch {
      return false;
    }
  }
  private atCap(): boolean {
    return this.d.store.openOperations() >= (this.d.maxOpenOperations ?? MAX_OPEN_OPERATIONS);
  }

  async createOperation(body: unknown): Promise<Answer> {
    const b = body as Record<string, unknown>;
    // a restore is bounded by the cap only when it would add an operation the API does not hold, for an escrow not funded (the ninth review
    // round, A9-3): at the cap a restore — of a known order even — had answered 503, and a funded order whose row was gone could only refund
    if (b?.params !== undefined) return this.restore(b);
    // the operations not yet ended are bounded (the eighth review round, A-M2): free commits had grown the database without limit
    if (this.atCap()) return atCapacity;
    const req = this.request(b);
    const named = providerOf(b.provider, (id) => !!this.adapterOf(id));
    const set = await this.engine.quoteAll(req, policyOf(b), { ...hintsOf(b), ...tipHintOf(b) });
    const provider = named ?? set.chosen?.provider;
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
      !isFieldElement(b.refundOwnerCommitment) ||
      !isFieldElement(b.refundNoteSecret) ||
      typeof b.refundNoteDataHash !== "string" ||
      !HEX32.test(b.refundNoteDataHash)
    )
      throw new BadRequest(
        "the order needs orderSigner (an address), refundOwnerCommitment and refundNoteSecret (base units) and refundNoteDataHash (32 bytes)",
      );
    // built on the request without its refund target (ZC's critique): kept as the order's, it had bound the price guard's competition at every prepare,
    // and the same order rebuilt after a lock was guarded on another one
    const order = this.engine.buildOrder(
      withoutTarget(req),
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
      blobOf({ order, ...(chosen ? { chosen: true } : {}) }),
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
    const req = this.request(b);
    const order = await this.rebuilt(b, req);
    if ("status" in order) return order;
    const known = this.d.store.operationByOrder(order.orderId);
    // an order is its escrow, not its id (the audit's unverified m16, 2026-10-17): an order id is public once a relayer or the
    // chain names it, and other params under it replaced that order's stored order and were answered with its operation id
    if (known && !sameEscrow(known.escrow, order.endpoint)) return otherOrder;
    if (known) this.d.store.setBlobUnlessFinalized(known.id, blobOf({ order, ...this.chosenOf(known.id) })); // finalized: never again (one statement — the fifth review round, 2026-11-03)
    if (!known && this.atCap()) {
      const held = await this.d.reads.escrowBalance(order.endpoint, order.request.from.asset).catch(() => null);
      if (held === null || held < BigInt(order.params.amount)) return atCapacity;
    }
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
  private async rebuilt(b: Record<string, unknown>, req: QuoteRequest, committed?: "escrow" | "destination"): Promise<Order | Answer> {
    const provider = providerOf(b.provider ?? null, (id) => !!this.adapterOf(id))!; // required, and one of the service's (A-L3)
    const params = paramsOf(b.params); // checked before any provider is asked
    // never a refund time further ahead than this service sets one (the audit round of 2026-10-16, c18): a restore records
    // its operation, and one named with a refundAfter years away was never purged
    const horizon = Math.floor(this.d.now() / 1000) + RESTORE_HORIZON_SECONDS + this.engine.cfg.refundWindowSeconds;
    if (params.refundAfter > horizon) throw new BadRequest("params name a refund time further ahead than this service sets one");
    // only for the order's own key, and before any provider is asked (audit round 2, r05)
    if (!restoreSigned(this.engine.cfg.chainId, b, params, predictEscrow(this.engine.cfg.factory, this.engine.cfg.escrowCreationCode, params)))
      return restoreUnsigned;
    // the order's tip is fixed in its escrow: quoted net of it, never priced again (audit round 2, r35)
    // on the committed route type (the twelfth review round, F12-1), both ways: rebuilt on a fresh quote refunding elsewhere, the next prepare had
    // bound the new target — one refunding at the destination, and the wallet refused its call after the funding; one refunding to the escrow, and
    // a Swift refund there was read as paid at the destination, the wallet reading where a refund went from the quote it journaled at the commit
    // (its tracker's refundTargetOf; ZA's critique had the second accepted). The wallet's target, else this service's own record of the commit (the
    // blob, before its finalize); a quote naming none, where one is bound, is refused as one of another type (ZC's critique: taken, the next prepare had
    // bound nothing)
    const target = req.refundTarget ?? committed;
    const unbound = withoutTarget(req);
    const asked: QuoteRequest = target ? { ...unbound, refundTarget: target } : unbound;
    const hints = { ...hintsOf(b), executorTip: params.executorTip };
    const set = await this.engine.quoteAll(asked, policyOf(b), hints);
    const found = set.quotes.find((q) => q.provider === provider);
    // ... Mayan's own refusal — it quotes none of the committed type while it quotes the other (RefundRouteUnavailable) — answers in its own words, true of
    // a funded order too (ZA's critique: "no route; nothing left your balance" had been said of a funded step): the signing tries again, and a delayed
    // funding's check stops the order unfunded (it had funded an order held to its refund time). A provider that failed or quoted nothing is an outage,
    // no quote below: a second, unbound ask had read a one-off failure as such a route and asked every provider twice (ZB's critique)
    const refused = target && !found ? set.refundsElsewhere?.[provider] : undefined;
    if (refused) return { status: 400, body: { error: refundRouteWords(provider, refused), code: "refund_route_unavailable" } };
    // ... while a quote of another route type, or one naming none, is the provider's answer of the moment — LI.FI's facets cannot be asked for one —: its
    // failure, tried again, never stored for the next prepare to bind (ZC's critique: answered as a route refunding elsewhere, one such answer had stopped
    // a delayed order for good, where its next answer was the committed route)
    if (target && found && found.refundTarget !== target)
      return { status: 502, body: { error: refundRouteWords(provider, found.refundTarget), code: "provider_unavailable" } };
    if (!found)
      return {
        status: 400,
        body: {
          error: `no quote from ${provider} right now; retry later`,
          code: "no_quote",
          errors: redactUrlsDeep(set.errors),
          competition: redactUrlsDeep(set.competition),
        },
      };
    return this.engine.restoreOrder(unbound, set.policy, found, params, assessmentOf(set), preferenceOf(b));
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
    // the committed refund target as this service recorded it, while the blob stands: a wallet that names none is rebuilt on it (F12-1)
    const raw = this.d.store.blob(id);
    const committed = raw ? decodeBlob<Blob>(raw).order.quote.refundTarget : undefined;
    const order = await this.rebuilt(b, this.request(b), committed);
    if ("status" in order) return order;
    if (order.orderId.toLowerCase() !== row.orderId || !sameEscrow(row.escrow, order.endpoint)) return otherOrder;
    this.d.store.setBlobUnlessFinalized(id, blobOf({ order, ...this.chosenOf(id) })); // never into a finalized row (the fifth review round, 2026-11-03)
    // the engine's words keep only their URLs' hosts here too (the eighth review round, A-I2)
    return {
      status: 200,
      body: wire({
        operationId: id,
        order: scrubOrder(order),
        status: userStatus(order.state),
        tier: order.tier,
        value: redactUrlsDeep(order.value),
        policy: order.policy,
      }),
    };
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
    // the finalize a re-sign's prepare starts from (the eighth review round, A-L2): its blob is written only while that one stands
    const finalizedAt = raw ? null : (this.d.store.execution(id)?.finalizedAt ?? null);
    let blob: Blob;
    if (raw) blob = decodeBlob<Blob>(raw);
    else {
      const restore = (body as { restore?: Record<string, unknown> } | undefined)?.restore;
      if (!restore) return unknownOperation; // the wallet sends its journaled params with the prepare
      const order = await this.rebuilt(restore, this.request(restore));
      if ("status" in order) return order;
      if (order.orderId.toLowerCase() !== row.orderId || !sameEscrow(row.escrow, order.endpoint)) return otherOrder;
      blob = { order };
    }
    const adapter = this.adapterOf(blob.order.quote.provider);
    if (!adapter) return { status: 400, body: { error: "unknown provider", code: "unknown_provider" } };
    const b = body as Record<string, unknown> | undefined;
    const approvedMin = b?.approvedMin !== undefined && isUint256(b.approvedMin) ? BigInt(b.approvedMin as string) : undefined; // A-L3
    const tier = blob.order.tier;
    const guard = tier && atLeast(tier, "enhanced") ? await this.guardFor(blob.order, tier) : undefined;
    if (guard === null) return guardUnavailable;
    try {
      const prepared = await this.engine.prepareExecution(blob.order, adapter, guard, approvedMin);
      // written back only while the operation still has its blob (the fourth review round, 2026-11-03): a finalize that ran during the
      // provider's round-trip nulled it, and this write had put the destination, the refund material and the signer back for the
      // retention window — and let a second finalize follow. A blob rebuilt from a restore (none was there) is written as before
      const next = blobOf({ order: blob.order, prepared, ...(blob.chosen ? { chosen: true } : {}) });
      if (raw) {
        if (!this.d.store.setBlobIfPresent(id, next)) return unknownOperation;
      } else if (!this.d.store.setRestoredBlob(id, next, finalizedAt)) return this.operation(id)?.terminalAt ? unknownOperation : superseded;
      return {
        status: 200,
        body: wire({
          digest: prepared.digest,
          provider: prepared.provider,
          value: prepared.value,
          calldata: prepared.calldata,
          deadline: prepared.deadline,
          ingress: prepared.ingress,
          quote: scrubQuote(prepared.quote), // A-I2
          plan: prepared.quote.plan,
        }),
      };
    } catch (e) {
      if (e instanceof MinimumMovedError)
        return { status: 409, body: wire({ error: e.message, code: "minimum_moved", approvedMin: e.approvedMin, newMin: e.newMin }) };
      // a route that now refunds elsewhere than the order was committed, as a rebuild answers it (the twelfth review round, ZB's critique): with its
      // blob standing — no lock since the commit —, a delayed funding's check had read the 502 as an outage and funded the order
      if (e instanceof RefundRouteUnavailable) return { status: 400, body: { error: e.message, code: "refund_route_unavailable" } };
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
      body: wire({
        execution,
        order: scrubOrder(blob.order), // A-I2
        ...(voucher ? { vouch: { execution: voucher.execution(chainId, blob.order.endpoint, execution) } } : {}),
      }),
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
    if (last) return { status: 200, body: await last.result };
    // the read in flight is the answer too (the eighth review round, A-I1): twenty concurrent reconciles had made twenty of each read
    const result = reconcileOperation(this.d.store, row, this.d.reads, now);
    this.reconciled.set(id, { at: now, result });
    try {
      return { status: 200, body: await result };
    } catch (e) {
      this.reconciled.delete(id);
      throw e;
    }
  }

  /**
   * The price guard's alternatives (whale spec §14): the routes the engine would execute now (a V6 follow-up of 2026-10-16). Every
   * live quote had counted, those the scoring refused too (NEAR Intents' withheld ingress, a stream over 4 h, a halted route, one
   * above its limit), so a quote nobody would take refused a sound one, and counted against its provider.
   */
  /**
   * The eighth review round (2026-11-03, D-L3): the alternatives are quoted net of the order's own tip — the hard quote's units, and no
   * tip priced, whose failure (an RPC endpoint down, a token's prices unagreed) had emptied the alternatives and skipped the guard for
   * every high-value order; a competition that still cannot run is null, and the prepare waits rather than going unguarded.
   */
  private async guardFor(order: Order, tier: Tier): Promise<{ alternatives: Quote[]; maxGapBps: number } | null> {
    const set = await this.engine.quoteAll(order.request, order.policy, { tier, executorTip: order.params.executorTip }).catch(() => null);
    if (!set) return null;
    const executable = new Set(set.scores.filter((s) => !s.filtered).map((s) => s.provider));
    return { alternatives: set.quotes.filter((q) => executable.has(q.provider)), maxGapBps: maxGapBpsFor(tier) };
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
    // never under the floor (the eighth review round, D-L2): a fast route's ETA of seconds, timed from the finalize, had counted the
    // relayer's own poll and the block as a stall — two such reads opened the provider's breaker for every user
    if (!ex?.expectedSeconds || this.d.now() - ex.finalizedAt <= stallAfterSeconds(ex.expectedSeconds) * 1000) return null;
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
    // no escrow, so no executor tip (the eleventh review round's third critique of slice 4): the engine had priced one for every quote, and a
    // native source's units were read as wei — a BTC guest's satoshis held to an ETH gas cost, every guest quote refused `amount_too_small`
    const set = await this.engine.quoteAll(request(b), b?.policy === undefined ? "best-price" : policyOf(b), {
      tier: tierHint(b),
      mode: modeOf(b),
      executorTip: 0n,
    });
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
        quote: scrubQuote(quote), // A-I2
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
