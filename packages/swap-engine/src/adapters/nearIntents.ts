// NEAR Intents adapter (plan §15, step 10) via the 1Click Swap API: solver-competition swaps between
// native assets (BTC, ETH, SOL, stables…). A quote is bound by the service to a one-time deposit
// address: amount in, `minAmountOut`, recipient, `refundTo` (our escrow, origin chain) and a deadline;
// the service signs the quote (ed25519) and the swap starts when the deposit is observed.
//
// Ingress model: plain-address — the escrow would send its balance to `depositAddress`. That means a
// transfer made by a CONTRACT (an internal transaction), and the 1Click documentation does not say
// whether its EVM deposit watcher credits internal transfers. Until that is confirmed with the
// provider (or proven with a small live deposit), `prepareIngress` refuses to produce an executable
// ingress from an escrow source, so the engine can rank NEAR Intents but the wallet cannot sign an
// execution that could strand funds at an unmonitored address. Quotes, status and health are live.
//
// Without an API key (JWT) the service adds its unauthenticated fee (`appFees`, 0.2–0.25 %); it is
// included in `amountOut`. We send no key: quotes are public, read-only requests.
import type { AssetRef, Capabilities, Fee, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { SINGLE_PLAN, categoryOf } from "../types";
import { PLACEHOLDER_BTC, PLACEHOLDER_EVM, PLACEHOLDER_SOL } from "../placeholders";

export const ONECLICK_API = process.env.ONECLICK_API ?? "https://1click.chaindefuser.com";
/** Set to "1" only after the provider has confirmed that internal-transaction deposits from a contract are credited. */
export const ONECLICK_CONTRACT_DEPOSITS_CONFIRMED = process.env.ONECLICK_CONTRACT_DEPOSITS_CONFIRMED === "1";
export const QUOTE_DEADLINE_MINUTES = 30;

const BLOCKCHAIN: Record<string, string> = { ethereum: "eth", bitcoin: "btc", solana: "sol", base: "base", arbitrum: "arb", bsc: "bsc", polygon: "pol", avalanche: "avax", optimism: "op", tron: "tron", doge: "doge", litecoin: "ltc" };

export interface OneClickToken { assetId: string; decimals: number; blockchain: string; symbol: string; contractAddress?: string; price?: number }

let tokenCache: { at: number; tokens: OneClickToken[] } | undefined;
export async function oneClickTokens(): Promise<OneClickToken[]> {
  if (tokenCache && Date.now() - tokenCache.at < 10 * 60_000) return tokenCache.tokens;
  const r = await fetch(`${ONECLICK_API}/v0/tokens`, { signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`1Click tokens: HTTP ${r.status}`);
  const tokens = (await r.json()) as OneClickToken[];
  tokenCache = { at: Date.now(), tokens };
  return tokens;
}

/** Our AssetRef → the 1Click assetId (native by symbol, tokens by contract address). */
export async function oneClickAssetId(a: AssetRef): Promise<string> {
  const chain = BLOCKCHAIN[a.chain];
  if (!chain) throw new Error(`1Click does not support chain ${a.chain}`);
  const tokens = await oneClickTokens();
  const t = tokens.find((x) => x.blockchain === chain && (a.asset === "native" ? !x.contractAddress && x.symbol.toUpperCase() === a.symbol.toUpperCase() : x.contractAddress?.toLowerCase() === a.asset.toLowerCase()));
  if (!t) throw new Error(`1Click does not list ${a.chain}:${a.asset === "native" ? a.symbol : a.asset}`);
  if (t.decimals !== a.decimals) throw new Error(`1Click decimals for ${a.symbol} are ${t.decimals}, expected ${a.decimals}`);
  return t.assetId;
}

export interface OneClickQuote {
  quote: { amountIn: string; minAmountIn?: string; amountOut: string; minAmountOut: string; timeEstimate: number; refundFee?: string; withdrawFee?: string; depositAddress?: string; depositMemo?: string; deadline?: string; timeWhenInactive?: string };
  quoteRequest: { deadline: string; refundTo: string; recipient: string; appFees?: { recipient: string; fee: number }[] };
  signature: string; timestamp: string; correlationId: string;
}

export async function oneClickQuote(body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const r = await fetch(`${ONECLICK_API}/v0/quote`, { method: "POST", signal: AbortSignal.timeout(30000), headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

/** `refundTo` must be an ORIGIN-chain address. Before the escrow exists (dry quotes) a fixed placeholder address stands in (the service rejects the 0xdEaD burn address and the Solana system program id); a binding quote requires the real escrow. */
const DRY_REFUND_PLACEHOLDER: Record<string, string> = {
  ethereum: PLACEHOLDER_EVM, base: PLACEHOLDER_EVM, arbitrum: PLACEHOLDER_EVM, bsc: PLACEHOLDER_EVM, polygon: PLACEHOLDER_EVM, avalanche: PLACEHOLDER_EVM, optimism: PLACEHOLDER_EVM,
  bitcoin: PLACEHOLDER_BTC, solana: PLACEHOLDER_SOL,
};

function quoteBody(req: QuoteRequest, originAsset: string, destinationAsset: string, dry: boolean) {
  const deadline = new Date(Date.now() + QUOTE_DEADLINE_MINUTES * 60_000).toISOString();
  const refundTo = req.source ?? (dry ? DRY_REFUND_PLACEHOLDER[req.from.chain] : undefined);
  if (!refundTo) throw new Error(dry ? `1Click: no dry-quote refund placeholder for ${req.from.chain}` : "1Click: a binding quote needs the escrow address (req.source) as refundTo");
  return {
    dry, swapType: "EXACT_INPUT", slippageTolerance: req.slippageBps, originAsset, depositType: "ORIGIN_CHAIN", destinationAsset,
    amount: req.amount.toString(), refundTo, refundType: "ORIGIN_CHAIN", recipient: req.destination, recipientType: "DESTINATION_CHAIN", deadline,
  };
}

export class NearIntentsAdapter implements ProviderAdapter {
  readonly id = "near-intents" as const;
  readonly implemented = true;

  capabilities(): Capabilities {
    return { routes: ["A", "B", "C", "D", "E"], ingress: ["plain-address"], nativeAssets: true, atomic: false, chains: ["bitcoin", "ethereum", "solana", "base", "arbitrum", "bsc", "polygon", "avalanche", "optimism", "doge", "litecoin"], contractSender: ONECLICK_CONTRACT_DEPOSITS_CONFIRMED, destinationLinkPublic: true, linkEvidence: "unverified: the payout to the destination executes on the NEAR intents contract; treated as public until shown otherwise" };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const [originAsset, destinationAsset] = await Promise.all([oneClickAssetId(req.from), oneClickAssetId(req.to)]);
    const { status, data } = await oneClickQuote(quoteBody(req, originAsset, destinationAsset, true));
    if (status !== 200 && status !== 201) throw new Error(`1Click quote: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const q = data as OneClickQuote;
    if (BigInt(q.quote.amountIn) !== req.amount) throw new Error("1Click: amountIn differs from the requested amount");
    if (BigInt(q.quote.minAmountOut) * 10000n < BigInt(q.quote.amountOut) * BigInt(10000 - req.slippageBps - 100)) throw new Error(`1Click: minAmountOut is more than ${req.slippageBps + 100} bps below amountOut`);
    const fees: Fee[] = [
      { kind: "network", amount: BigInt(q.quote.withdrawFee ?? "0"), asset: req.to.symbol, decimals: req.to.decimals },
      ...(q.quoteRequest.appFees ?? []).map((f) => ({ kind: "affiliate" as const, amount: (req.amount * BigInt(f.fee)) / 10000n, asset: req.from.symbol, decimals: req.from.decimals })),
    ];
    return {
      provider: "near-intents", category: categoryOf(req.from, req.to),
      toAmount: BigInt(q.quote.amountOut), toAmountMin: BigInt(q.quote.minAmountOut), fees, etaSeconds: q.quote.timeEstimate,
      expiresAt: Math.floor(Date.parse(q.quoteRequest.deadline) / 1000) - 120, // deposit must land before the deadline
      nativeAssets: true, minOutEncoded: true /* held and signed by the service, bound to the deposit address */, minOutVerified: false, refundTarget: "escrow",
      plan: SINGLE_PLAN(q.quote.timeEstimate, "intent"),
      hops: [`${originAsset} -> intents -> ${destinationAsset}`], raw: { ...q, originAsset, destinationAsset }, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    if (!ONECLICK_CONTRACT_DEPOSITS_CONFIRMED && req.source) {
      throw new Error("near-intents: the escrow would deposit by internal transaction; 1Click has not confirmed that contract-sent deposits are credited (set ONECLICK_CONTRACT_DEPOSITS_CONFIRMED=1 once verified)");
    }
    const raw = quote.raw as OneClickQuote & { originAsset: string; destinationAsset: string };
    // a binding quote: the service allocates the one-time deposit address for exactly these parameters
    const { status, data } = await oneClickQuote(quoteBody(req, raw.originAsset, raw.destinationAsset, false));
    if (status !== 200 && status !== 201) throw new Error(`1Click binding quote: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const q = data as OneClickQuote;
    if (!q.quote.depositAddress) throw new Error("1Click: no deposit address in the binding quote");
    if (BigInt(q.quote.minAmountOut) < quote.toAmountMin) throw new Error("1Click: binding quote's minAmountOut is below the dry quote's");
    if (q.quoteRequest.recipient !== req.destination || q.quoteRequest.refundTo !== req.source) throw new Error("1Click: recipient/refund mismatch");
    return { kind: "plain-address", to: q.quote.depositAddress, calldata: "0x", value: req.from.asset === "native" ? req.amount : 0n, memo: q.quote.depositMemo, expiresAt: Math.floor(Date.parse(q.quoteRequest.deadline) / 1000) - 120, minOutEncoded: true };
  }

  async track(ref: { providerRef?: string }): Promise<TrackStatus> {
    if (!ref.providerRef) return { state: "unknown" };
    const r = await fetch(`${ONECLICK_API}/v0/status?depositAddress=${encodeURIComponent(ref.providerRef)}`, { signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) return { state: "unknown", raw: data };
    const d = data.swapDetails ?? {};
    const dest = d.destinationChainTxHashes?.[0]?.hash;
    switch (data.status) {
      case "KNOWN_DEPOSIT_TX": case "PENDING_DEPOSIT": case "INCOMPLETE_DEPOSIT": return { state: "pending", raw: data };
      case "PROCESSING": return { state: "executing", raw: data };
      case "SUCCESS": return { state: "completed", destinationTxHash: dest, deliveredAmount: d.amountOut ? BigInt(d.amountOut) : undefined, raw: data };
      case "REFUNDED": return { state: "refunded", raw: data };
      case "FAILED": return { state: "failed", raw: data };
      default: return { state: "unknown", raw: data };
    }
  }

  async health(): Promise<Health> {
    const t0 = Date.now();
    try {
      const tokens = await oneClickTokens();
      const ok = tokens.some((t) => t.blockchain === "eth" && !t.contractAddress) && tokens.some((t) => t.blockchain === "btc");
      return { provider: "near-intents", reachable: true, apiLatencyMs: Date.now() - t0, halted: !ok, haltedChains: ok ? [] : ["eth/btc missing from token list"], checkedAt: Date.now(), note: ONECLICK_CONTRACT_DEPOSITS_CONFIRMED ? undefined : "quotes only: contract-sent deposits unconfirmed" };
    } catch (e) {
      return { provider: "near-intents", reachable: false, apiLatencyMs: Date.now() - t0, halted: true, haltedChains: [], checkedAt: Date.now(), note: String(e) };
    }
  }
}
