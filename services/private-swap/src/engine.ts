// PrivateSwap engine (spec §2, §6, §8, §9): quote every capable provider, score by policy, build the
// order (one-time escrow endpoint + refund note), and produce the signed execution once the ingress is
// known. The engine never holds keys for money: the order key is a per-order wallet-derived key.
import { randomBytes } from "crypto";
import type { Order, OrderParams, Policy, ProviderAdapter, ProviderId, Quote, QuoteRequest, Health, Execution, Ingress } from "./types";
import { CATEGORY_PREFERENCE, categoryOf } from "./types";
import { chooseRoute, priceGuard, scoreRoutes, type RouteScore } from "./scoring";
import { privacyScore } from "./privacyScore";
import { isBucket } from "../../../reference/typescript/src/wallet/amounts";
import { executionDigest, orderSignerAddress, predictEscrow, recoverExecutionSigner, signExecution } from "./endpoints";
import { encodeCall } from "./abi";

export interface EngineConfig {
  adapters: ProviderAdapter[];
  factory: string; // SwapOrderFactory address
  escrowCreationCode: string; // from contracts/abi/periphery/SwapOrderEscrow.json
  chainId: bigint;
  refundVaults: Record<string, string>; // asset ("native" or token address) -> canonical vault
  tipBps: number; // executor tip in bps of amount (<= 100)
  refundWindowSeconds: number; // refundAfter = executeDeadline + this
  /** cover traffic per provider (swaps/hour on a typical pair) for the cross-chain privacy term; a live volume feed should replace these estimates */
  providerThroughput?: Partial<Record<ProviderId, number>>;
}

/** Conservative static estimates until a volume feed exists (docs/privacy-lab.md, cross-chain section). */
export const DEFAULT_PROVIDER_THROUGHPUT: Record<ProviderId, number> = { thorchain: 60, chainflip: 30, mayan: 60, "near-intents": 40, lifi: 100, "uniswap-across": 100 };

export interface PreparedExecution {
  quote: Quote;
  ingress: Ingress;
  provider: string;
  value: bigint;
  calldata: `0x${string}`;
  deadline: number;
  digest: `0x${string}`;
}

export interface QuoteSet {
  quotes: Quote[];
  errors: Partial<Record<ProviderId, string>>;
  health: Record<ProviderId, Health>;
  scores: RouteScore[];
  chosen?: RouteScore;
}

export const DELAY_BUDGET: Record<Policy, [number, number]> = {
  "best-privacy": [6 * 3600, 72 * 3600],
  "best-price": [3600, 24 * 3600],
  fastest: [0, 0],
};

/**
 * The one call the escrow makes for an ingress (spec §5, §6). The escrow forwards what is left after the
 * executor tip: an ETH order sends it as value (a plain deposit address gets a bare transfer); an ERC-20
 * order forwards no ETH — a contract-call provider pulls the tokens it was approved for, and a plain
 * deposit address is paid with the token's own `transfer(depositAddress, amount − tip)`, so the
 * provider call the order key signs is the token contract itself.
 */
export function escrowCall(p: OrderParams, ingress: Ingress): { provider: string; value: bigint; calldata: `0x${string}` } {
  const net = p.amount - p.executorTip;
  const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
  if (p.assetType === 1) {
    if (ingress.value !== 0n) throw new Error("an ERC-20 order forwards no ETH value");
    if (ingress.kind === "plain-address") {
      if (!isAddress(ingress.to) || !isAddress(p.asset)) throw new Error("an ERC-20 deposit needs an EVM deposit address and token");
      return { provider: p.asset, value: 0n, calldata: encodeCall("transfer(address,uint256)", [{ t: "address", v: ingress.to }, { t: "uint", v: net }]) };
    }
    return { provider: ingress.to, value: 0n, calldata: ingress.calldata };
  }
  if (ingress.kind === "plain-address") return { provider: ingress.to, value: net, calldata: "0x" };
  if (ingress.value > net) throw new Error("ingress value exceeds the escrow's spendable balance");
  return { provider: ingress.to, value: ingress.value, calldata: ingress.calldata };
}

export class PrivateSwapEngine {
  constructor(readonly cfg: EngineConfig) {}

  /** The executor tip comes out of the escrow balance, so providers are quoted for the net amount. */
  tip(amount: bigint): bigint {
    return (amount * BigInt(Math.min(this.cfg.tipBps, 100))) / 10000n;
  }
  net(req: QuoteRequest): QuoteRequest {
    return { ...req, amount: req.amount - this.tip(req.amount) };
  }

  /** Quote all capable providers in parallel; failures are recorded, never fatal (plan §57). */
  async quoteAll(gross: QuoteRequest, policy: Policy): Promise<QuoteSet> {
    const req = this.net(gross);
    const category = categoryOf(req.from, req.to);
    const capable = this.cfg.adapters.filter((a) => a.capabilities().routes.includes(category) && a.capabilities().chains.includes(req.from.chain) && a.capabilities().chains.includes(req.to.chain));
    const ordered = [...capable].sort((a, b) => CATEGORY_PREFERENCE[category].indexOf(a.id) - CATEGORY_PREFERENCE[category].indexOf(b.id));
    const results = await Promise.all(ordered.map(async (a) => {
      const health = await a.health();
      try {
        const quote = a.implemented ? await a.quote(req) : undefined;
        return { id: a.id, health, quote, error: a.implemented ? undefined : "not implemented" };
      } catch (e) {
        return { id: a.id, health, quote: undefined, error: String((e as Error).message ?? e) };
      }
    }));
    const quotes = results.flatMap((r) => (r.quote ? [r.quote] : []));
    const health = Object.fromEntries(results.map((r) => [r.id, r.health])) as Record<ProviderId, Health>;
    const errors = Object.fromEntries(results.filter((r) => r.error).map((r) => [r.id, r.error])) as Partial<Record<ProviderId, string>>;
    const unexecutable = Object.fromEntries(ordered.filter((a) => a.capabilities().contractSender === false).map((a) => [a.id, "ingress from a contract sender unconfirmed by the provider"])) as Partial<Record<ProviderId, string>>;
    const scores = scoreRoutes(quotes, health, policy, Date.now(), unexecutable);
    return { quotes, errors, health, scores, chosen: chooseRoute(scores) };
  }

  /** Build the order object + on-chain params for a chosen quote (spec §2, §6). */
  buildOrder(req: QuoteRequest, policy: Policy, quote: Quote, keys: { orderPrivateKey?: Uint8Array; orderSigner?: string; refundOwnerCommitment: bigint; refundNoteSecret: bigint; refundNoteDataHash: `0x${string}` }): Order {
    const orderSigner = keys.orderSigner ?? (keys.orderPrivateKey ? orderSignerAddress(keys.orderPrivateKey) : undefined);
    if (!orderSigner) throw new Error("buildOrder needs the one-time order signer (address) or its key");
    const orderId = ("0x" + randomBytes(32).toString("hex")) as `0x${string}`;
    const amount = req.amount; // gross: what the private withdrawal funds
    const executorTip = this.tip(amount);
    const [dMin, dMax] = DELAY_BUDGET[policy];
    const executeDeadline = quote.expiresAt + dMax; // the quote will be refreshed at submission; cap generously
    const params: OrderParams = {
      orderId, assetType: req.from.asset === "native" ? 0 : 1, asset: req.from.asset === "native" ? "0x0000000000000000000000000000000000000000" : req.from.asset,
      amount, orderSigner, executeDeadline, refundAfter: executeDeadline + this.cfg.refundWindowSeconds,
      refundVault: this.cfg.refundVaults[req.from.asset], refundOwnerCommitment: keys.refundOwnerCommitment, refundNoteSecret: keys.refundNoteSecret,
      refundNoteDataHash: keys.refundNoteDataHash, executorTip,
    };
    if (!params.refundVault) throw new Error(`no canonical vault configured for ${req.from.asset}`);
    const endpoint = predictEscrow(this.cfg.factory, this.cfg.escrowCreationCode, params);
    const score = privacyScore({
      sourceIsPool: true, destinationFresh: true, amountIsBucket: isBucket(amount), amountUniqueness: 0.5, delaySeconds: dMin,
      providerKind: quote.provider === "thorchain" || quote.provider === "chainflip" || quote.provider === "near-intents" ? "deposit-address" : quote.provider === "mayan" ? "signed-intent" : "aggregator-api",
      nativeAssets: quote.nativeAssets, oneTimeEndpoints: true, privateSubmission: policy !== "fastest",
      crossChain: { throughputPerHour: this.cfg.providerThroughput?.[quote.provider] ?? DEFAULT_PROVIDER_THROUGHPUT[quote.provider], etaSeconds: quote.etaSeconds },
    });
    return {
      orderId, request: req, policy, quote, ingress: { kind: "contract-call", to: "", calldata: "0x", value: 0n, expiresAt: quote.expiresAt, minOutEncoded: quote.minOutEncoded },
      params, endpoint, privacy: { delaySeconds: [dMin, dMax], amountNormalized: isBucket(amount), score }, state: "QUOTED", history: [{ state: "QUOTED", at: Date.now() }],
    };
  }

  /**
   * Rebuild an order the wallet persisted (spec §3 recovery, plan §30): the same on-chain params give
   * the same escrow, so a wallet that funded its escrow hours ago can prepare / sign after a service
   * restart. `quote` is a fresh quote from the same provider (it is re-quoted again at prepare time).
   */
  restoreOrder(req: QuoteRequest, policy: Policy, quote: Quote, params: OrderParams): Order {
    if (!/^0x[0-9a-fA-F]{40}$/.test(params.orderSigner)) throw new Error("restoreOrder: params.orderSigner is not an address");
    if (params.executeDeadline >= params.refundAfter) throw new Error("restoreOrder: executeDeadline must precede refundAfter");
    const endpoint = predictEscrow(this.cfg.factory, this.cfg.escrowCreationCode, params);
    const [dMin, dMax] = DELAY_BUDGET[policy];
    const score = privacyScore({
      sourceIsPool: true, destinationFresh: true, amountIsBucket: isBucket(params.amount), amountUniqueness: 0.5, delaySeconds: dMin,
      providerKind: quote.provider === "thorchain" || quote.provider === "chainflip" || quote.provider === "near-intents" ? "deposit-address" : quote.provider === "mayan" ? "signed-intent" : "aggregator-api",
      nativeAssets: quote.nativeAssets, oneTimeEndpoints: true, privateSubmission: policy !== "fastest",
      crossChain: { throughputPerHour: this.cfg.providerThroughput?.[quote.provider] ?? DEFAULT_PROVIDER_THROUGHPUT[quote.provider], etaSeconds: quote.etaSeconds },
    });
    return {
      orderId: params.orderId, request: req, policy, quote, ingress: { kind: "contract-call", to: "", calldata: "0x", value: 0n, expiresAt: quote.expiresAt, minOutEncoded: quote.minOutEncoded },
      params, endpoint, privacy: { delaySeconds: [dMin, dMax], amountNormalized: isBucket(params.amount), score }, state: "COMMITTED", history: [{ state: "COMMITTED", at: Date.now(), note: "restored by the wallet" }],
    };
  }

  /** Once the escrow address is known: re-quote with the escrow as sender, obtain the final ingress and the digest the order key must sign. */
  async prepareExecution(order: Order, adapter: ProviderAdapter, guard?: { alternatives: Quote[]; maxGapBps: number }): Promise<PreparedExecution> {
    const req = { ...this.net(order.request), source: order.endpoint }; // net of the tip, escrow as sender
    const quote = await adapter.quote(req); // re-quote with the escrow as sender (spec §5)
    if (quote.minOutVerified === false && order.policy !== "fastest") throw new Error(`${adapter.id}: the minimum output cannot be verified locally in the calldata; refused under policy ${order.policy}`);
    if (guard) priceGuard(quote, guard.alternatives, guard.maxGapBps);
    const ingress = await adapter.prepareIngress(req, quote);
    if (ingress.expiresAt * 1000 <= Date.now()) throw new Error(`${adapter.id}: the ingress has already expired`);
    if (ingress.kind === "contract-call" && !/^0x[0-9a-fA-F]{40}$/.test(ingress.to)) throw new Error(`${adapter.id}: ingress target is not an address`);
    const deadline = Math.min(quote.expiresAt, order.params.executeDeadline);
    const { provider, value, calldata } = escrowCall(order.params, ingress);
    const digest = executionDigest(this.cfg.chainId, order.endpoint, order.orderId, provider, value, calldata, deadline);
    order.quote = quote;
    order.ingress = ingress;
    return { quote, ingress, provider, value, calldata, deadline, digest };
  }

  /** The wallet signed `prepared.digest` with the one-time order key: check it and attach the execution. */
  attachSignature(order: Order, prepared: PreparedExecution, signature: `0x${string}`): Execution {
    const signer = recoverExecutionSigner(prepared.digest, signature);
    if (signer.toLowerCase() !== order.params.orderSigner.toLowerCase()) throw new Error(`signature recovers to ${signer}, not the order signer ${order.params.orderSigner}`);
    const execution: Execution = { provider: prepared.provider, value: prepared.value, providerCalldata: prepared.calldata, deadline: prepared.deadline, signature };
    order.execution = execution;
    return execution;
  }

  /** Convenience for a wallet that holds the order key in-process: prepare + sign + attach. */
  async authorize(order: Order, adapter: ProviderAdapter, orderPrivateKey: Uint8Array, guard?: { alternatives: Quote[]; maxGapBps: number }): Promise<Execution> {
    const prepared = await this.prepareExecution(order, adapter, guard);
    return this.attachSignature(order, prepared, signExecution(orderPrivateKey, prepared.digest));
  }
}
