// The swap routes of the API (spec v2.0 §15; was packages/swap-engine/src/server.ts, the V1.1–V5 loopback service): the
// handlers over the engine and the store, each answering { status, body } so app.ts only maps them to Express. The API
// never holds money keys: the wallet sends the one-time order SIGNER (an address) and the refund note's commitment, and
// receives the digest to sign. Quotes are live. An operation (a swap or a cross-chain swap) is created at commit with an
// opaque `op_` id; its blob (the engine's Order — the destination and the refund material — and the prepared execution)
// lives in the database until finalize nulls it. The wallet's tier is a hint that can only raise the tier, the policy may
// be derived from a preference, prepare keeps the approved minimum and runs the price guard, /track reads a provider's
// status for an executed order.
import { MinimumMovedError, type PreparedExecution, type PrivateSwapEngine, type QuoteHint } from "@privacy-wallet/swap-engine/engine";
import { riskDb } from "@privacy-wallet/swap-engine/risk/riskDb";
import { securityBreakdown } from "@privacy-wallet/swap-engine/risk/security";
import { incidents } from "@privacy-wallet/swap-engine/health";
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
import { decodeBlob, encodeBlob, wire } from "../blob";
import { newId, OPERATION_ID } from "../ids";
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
function asset(a: any): AssetRef {
  if (!a || typeof a.chain !== "string" || typeof a.asset !== "string" || typeof a.symbol !== "string" || !Number.isInteger(Number(a.decimals)))
    throw new BadRequest("an asset is { chain, asset, decimals, symbol }");
  return { chain: a.chain, asset: a.asset, decimals: Number(a.decimals), symbol: a.symbol };
}
function request(b: any): QuoteRequest {
  if (!/^\d+$/.test(String(b?.amount ?? ""))) throw new BadRequest("amount must be base units");
  return {
    from: asset(b.from),
    to: asset(b.to),
    amount: BigInt(b.amount),
    destination: String(b.destination ?? ""),
    slippageBps: Number(b.slippageBps ?? 50),
    ...(b.destinationKind === "entered" ? { destinationKind: "entered" as const } : {}),
    ...(b.preferNative === true ? { preferNative: true } : {}),
    ...(b.destinationType === "protected" ? { destinationType: "protected" as const } : {}),
  };
}
function paramsOf(p: any): OrderParams {
  if (!p || typeof p.orderId !== "string") throw new BadRequest("params must be the order's on-chain parameters");
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
}

export interface SwapApiDeps {
  engine: PrivateSwapEngine;
  store: Store;
  gateway: GatewayConfig;
  reads: ReconcileReads;
  relayerTerms(): Promise<RelayerTerms | null>;
  now(): number;
}

const unknownOperation: Answer = { status: 404, body: { error: "unknown order", code: "unknown_order" } };

export class SwapApi {
  /** reconcile: one read per operation per 5 s; a caller in between gets the last answer */
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
      healthy: (p) =>
        set.health[p as ProviderId]?.reachable !== false &&
        !set.health[p as ProviderId]?.halted &&
        !this.engine.tracker.state(p as ProviderId, this.d.now()).open,
    });
    return { status: 200, body: { ...(wire(set) as object), id, ...(quote ? { quote } : {}) } };
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
        body: { error: `no quote from ${provider ?? "any provider"}`, code: "no_quote", errors: set.errors, competition: set.competition },
      };
    const filtered = set.scores.find((s) => s.provider === provider)?.filtered;
    if (filtered) return { status: 400, body: { error: `route filtered: ${filtered}`, code: "route_filtered", competition: set.competition } };
    if (
      typeof b.orderSigner !== "string" ||
      !/^\d+$/.test(String(b.refundOwnerCommitment)) ||
      !/^\d+$/.test(String(b.refundNoteSecret)) ||
      typeof b.refundNoteDataHash !== "string"
    )
      throw new BadRequest("the order needs orderSigner, refundOwnerCommitment, refundNoteSecret and refundNoteDataHash");
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
    const operationId = this.record(order, typeof b.quoteId === "string" ? b.quoteId : null);
    return {
      status: 200,
      body: wire({
        operationId,
        order,
        scores: set.scores,
        status: userStatus(order.state),
        tier: order.tier,
        value: order.value,
        policy: set.policy,
        competition: set.competition,
        ...(set.protection ? { protection: set.protection } : {}),
        ...(set.risk ? { risk: set.risk } : {}),
      }),
    };
  }

  private record(order: Order, quoteId: string | null): string {
    const id = newId("op");
    const req = order.request;
    this.d.store.createOperation(
      {
        id,
        kind: req.from.chain === req.to.chain ? "swap" : "cross-chain",
        state: "AWAITING_SIGNATURE",
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
      encodeBlob({ order } satisfies Blob),
    );
    this.d.store.event({ event: "operation.created", operationId: id, provider: order.quote.provider, state: "AWAITING_SIGNATURE", network: req.from.chain });
    return id;
  }

  /** Rebuild an order from the on-chain params the wallet journaled (same params, same escrow); its operation is found by the order or created. */
  private async restore(b: Record<string, unknown>): Promise<Answer> {
    const req = request(b);
    const order = await this.rebuilt(b, req);
    if ("status" in order) return order;
    const known = this.d.store.operationByOrder(order.orderId);
    if (known && !this.d.store.execution(known.id)) this.d.store.setBlob(known.id, encodeBlob({ order } satisfies Blob)); // finalized: never again
    const operationId = known?.id ?? this.record(order, null);
    return { status: 200, body: wire({ operationId, order, status: userStatus(order.state), tier: order.tier, value: order.value, policy: order.policy }) };
  }
  private async rebuilt(b: Record<string, unknown>, req: QuoteRequest): Promise<Order | Answer> {
    const provider = b.provider as ProviderId;
    const set = await this.engine.quoteAll(req, policyOf(b), hintsOf(b));
    const quote = set.quotes.find((q) => q.provider === provider);
    if (!quote)
      return {
        status: 400,
        body: { error: `no quote from ${provider} right now; retry later`, code: "no_quote", errors: set.errors, competition: set.competition },
      };
    return this.engine.restoreOrder(req, set.policy, quote, paramsOf(b.params), assessmentOf(set), preferenceOf(b));
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
    if (order.orderId.toLowerCase() !== row.orderId) return { status: 409, body: { error: "these params are another order's", code: "order_mismatch" } };
    if (!this.d.store.execution(id)) this.d.store.setBlob(id, encodeBlob({ order } satisfies Blob));
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
      if (order.orderId.toLowerCase() !== row.orderId) return { status: 409, body: { error: "these params are another order's", code: "order_mismatch" } };
      blob = { order };
    }
    const adapter = this.adapterOf(blob.order.quote.provider);
    if (!adapter) return { status: 400, body: { error: "unknown provider", code: "unknown_provider" } };
    const b = body as Record<string, unknown> | undefined;
    const approvedMin = b?.approvedMin !== undefined && /^\d+$/.test(String(b.approvedMin)) ? BigInt(b.approvedMin as string) : undefined;
    const tier = blob.order.tier;
    const guard =
      tier && atLeast(tier, "enhanced")
        ? {
            alternatives: (await this.engine.quoteAll(blob.order.request, blob.order.policy, { tier }).catch(() => ({ quotes: [] }))).quotes,
            maxGapBps: maxGapBpsFor(tier),
          }
        : undefined;
    try {
      const prepared = await this.engine.prepareExecution(blob.order, adapter, guard, approvedMin);
      this.d.store.setBlob(id, encodeBlob({ order: blob.order, prepared } satisfies Blob));
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
        this.engine.tracker.recordQuoteDivergence(e.provider as ProviderId, e.gapBps); // V3 §10: repeated divergence opens the breaker
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
    let execution;
    try {
      execution = this.engine.attachSignature(blob.order, blob.prepared, signature as `0x${string}`);
    } catch {
      throw new BadRequest("the signature is not the order signer's over the prepared digest");
    }
    this.d.store.finalize(id, { providerRef: blob.prepared.provider });
    this.d.store.event({ event: "operation.finalized", operationId: id, provider: row.provider, state: row.state, network: row.network });
    return { status: 200, body: wire({ execution, order: blob.order }) };
  }

  /** POST /v1/operations/:id/reconcile: the API's reads (relayer job, escrow, provider) → { state, settlement, refs, checkedAt, sources }. */
  async reconcile(id: string): Promise<Answer> {
    const row = this.operation(id);
    if (!row) return unknownOperation;
    const last = this.reconciled.get(id);
    if (last && this.d.now() - last.at < 5_000) return { status: 200, body: last.result };
    const result = await reconcileOperation(this.d.store, row, this.d.reads, this.d.now());
    this.reconciled.set(id, { at: this.d.now(), result });
    return { status: 200, body: result };
  }

  /** GET /v1/track/:provider: the destination side of an executed order, stateless, from the execution transaction (NEAR: the deposit address as ref). */
  async track(provider: string, query: URLSearchParams): Promise<Answer> {
    const adapter = this.adapterOf(provider);
    if (!adapter) return { status: 404, body: { error: "unknown provider", code: "unknown_provider" } };
    const tx = query.get("tx") ?? undefined,
      ref = query.get("ref") ?? undefined;
    if (!tx && !ref) throw new BadRequest("tx (the execution transaction) or ref (the provider's reference) is required");
    const t = await adapter.track({ sourceTxHash: tx, providerRef: ref });
    // V3 §10: `since` (unix s, the hand-over) and `expected` (the plan's seconds) let the API count a settlement stall
    const since = Number(query.get("since")),
      expected = Number(query.get("expected"));
    const open = !["completed", "refunded", "failed"].includes(t.state);
    const stalled =
      open && Number.isFinite(since) && since > 0 && Number.isFinite(expected) && expected > 0 && this.d.now() / 1000 - since > STALL_FACTOR * expected;
    if (stalled) this.engine.tracker.recordSettlementStall(provider as ProviderId, `${provider}:${tx ?? ref}`);
    return { status: 200, body: wire({ track: t, status: guestStatus(t.state), ...(stalled ? { stalled: true } : {}) }) };
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
        security: securityBreakdown(id, now, db),
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
    const providers = Object.fromEntries(await Promise.all(this.engine.cfg.adapters.map(async (a) => [a.id, await a.health()])));
    const db = riskDb(),
      inc = incidents();
    const byProvider: Record<string, number> = {};
    for (const i of inc) byProvider[i.provider] = (byProvider[i.provider] ?? 0) + 1;
    return {
      status: 200,
      body: wire({
        deployment: { chainId: this.engine.cfg.chainId, factory: this.engine.cfg.factory, nativeVault: this.engine.cfg.refundVaults.native },
        providers,
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
    return { status: 200, body: wire(set) };
  }
  /** Only providers whose deposit address and memo the browser verifies against an independent gateway quorum (THORChain). */
  async guestIngress(body: unknown): Promise<Answer> {
    const req = { ...request(body), plan: "single" as const }; // a UTXO deposit carries one memo of at most 80 bytes: never streamed
    const adapter = this.adapterOf("thorchain");
    if (!adapter) return { status: 503, body: { error: "THORChain adapter unavailable", code: "capacity" } };
    if (!["bitcoin", "litecoin", "doge"].includes(req.from.chain))
      throw new BadRequest("guest deposits are for native-chain sources (BTC, LTC, DOGE); use the wallet for EVM sources");
    const quote = await adapter.quote(req);
    const ingress = await adapter.prepareIngress(req, quote);
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
    const t = await adapter.track({ sourceTxHash: txid });
    return { status: 200, body: wire({ track: t, status: guestStatus(t.state) }) };
  }

  // ---- the metered zkAPI quote gateway (whale spec §22): runtime-key auth, 503 with the reason while no upstream exists
  gatewayHealth(): Answer {
    return { status: 200, body: gatewayHealth(this.d.gateway) };
  }
  async gatewayQuote(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<Answer> {
    return gatewayQuote(this.d.gateway, headers, body, async (b: unknown) => this.engine.quoteAll(request(b), policyOf(b), hintsOf(b)));
  }
}
