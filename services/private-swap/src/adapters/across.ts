// Across adapter (plan §15, step 12 "Uniswap-Across"): EVM→EVM bridging through Across's optimistic
// relayer network. The same asset (ETH→ETH, USDC→USDC) is bridged with a deposit built here; an asset
// change takes the Uniswap leg: Across's Swap API quotes a swap on the origin chain followed by the
// bridge, as one SpokePoolPeriphery.swapAndBridge call, which acrossSwap.ts decodes and checks in full.
//
// Ingress: `SpokePool.depositV3(depositor, recipient, inputToken, outputToken, inputAmount,
// outputAmount, destinationChainId, exclusiveRelayer, quoteTimestamp, fillDeadline,
// exclusivityDeadline, message)` — built locally from the public `suggested-fees` quote. `outputAmount`
// is an exact fill amount (relayers must deliver exactly it or the deposit expires), so the minimum
// output is enforced on-chain; an unfilled deposit is refunded to `depositor` — our escrow — on the
// origin chain (`refundTarget: "escrow"`). Native ETH deposits send `msg.value` with WETH as the token.
import { encodeCall } from "../abi";
import { acrossSwapIngress, acrossSwapQuote } from "./acrossSwap";
import type { AssetRef, Capabilities, Fee, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { SINGLE_PLAN, categoryOf } from "../types";

export const ACROSS_API = process.env.ACROSS_API ?? "https://app.across.to/api";
export const CHAIN_ID: Record<string, number> = { ethereum: 1, optimism: 10, polygon: 137, base: 8453, arbitrum: 42161, bsc: 56 };
export const WETH: Record<string, string> = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", optimism: "0x4200000000000000000000000000000000000006", base: "0x4200000000000000000000000000000000000006",
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
/** Mainnet SpokePool proxies (pinned; the quote's `spokePoolAddress` must match). */
export const SPOKE_POOL: Record<string, string> = {
  ethereum: "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5", optimism: "0x6f26bf09b1c792e3228e5467807a900a503c0281", base: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64",
  arbitrum: "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a",
};
const DEPOSIT_QUOTE_TIME_BUFFER = 50 * 60; // SpokePool accepts quoteTimestamps within ~1 h; keep a margin

export interface AcrossQuote {
  outputAmount: string; totalRelayFee: { pct: string; total: string }; lpFee?: { pct: string; total: string }; relayerGasFee?: { total: string }; relayerCapitalFee?: { total: string };
  exclusiveRelayer: string; exclusivityDeadline: number; timestamp: string; spokePoolAddress: string; destinationSpokePoolAddress?: string; fillDeadline: string;
  isAmountTooLow: boolean; estimatedFillTimeSec: number; limits?: { minDeposit: string; maxDeposit: string; maxDepositInstant: string };
  inputToken: { address: string; symbol: string; decimals: number; chainId: number }; outputToken: { address: string; symbol: string; decimals: number; chainId: number };
}

/** Whether the request keeps the asset (the bridge alone) rather than changing it (the swap leg). */
function sameAsset(req: QuoteRequest): boolean {
  if (req.from.asset === "native" && req.to.asset === "native") return true;
  return req.from.asset !== "native" && req.to.asset !== "native" && req.from.symbol.toUpperCase() === req.to.symbol.toUpperCase();
}

function bridgeTokens(req: QuoteRequest): { inputToken: string; outputToken: string } {
  if (CHAIN_ID[req.from.chain] === undefined || CHAIN_ID[req.to.chain] === undefined) throw new Error(`Across: chain pair ${req.from.chain}->${req.to.chain} not supported`);
  if (req.from.asset === "native" && req.to.asset === "native") {
    const i = WETH[req.from.chain], o = WETH[req.to.chain];
    if (!i || !o) throw new Error("Across: no WETH mapping for this chain pair");
    return { inputToken: i, outputToken: o };
  }
  if (req.from.asset !== "native" && req.to.asset !== "native" && req.from.symbol.toUpperCase() === req.to.symbol.toUpperCase()) return { inputToken: req.from.asset, outputToken: req.to.asset };
  throw new Error("Across adapter bridges the same asset only (ETH->ETH, USDC->USDC); asset changes need the Uniswap leg (not implemented)");
}

async function getJson<T>(url: string, timeoutMs = 25000): Promise<{ data: T; status: number }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  const text = await r.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { data, status: r.status };
}

/** `depositV3` calldata; `message` is empty (plain transfer to an EOA / our fresh address). */
export function encodeDepositV3(p: { depositor: string; recipient: string; inputToken: string; outputToken: string; inputAmount: bigint; outputAmount: bigint; destinationChainId: number; exclusiveRelayer: string; quoteTimestamp: number; fillDeadline: number; exclusivityDeadline: number }): `0x${string}` {
  return encodeCall("depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)", [
    { t: "address", v: p.depositor }, { t: "address", v: p.recipient }, { t: "address", v: p.inputToken }, { t: "address", v: p.outputToken },
    { t: "uint", v: p.inputAmount }, { t: "uint", v: p.outputAmount }, { t: "uint", v: p.destinationChainId }, { t: "address", v: p.exclusiveRelayer },
    { t: "uint", v: p.quoteTimestamp }, { t: "uint", v: p.fillDeadline }, { t: "uint", v: p.exclusivityDeadline }, { t: "bytes", v: "0x" },
  ]);
}

export class AcrossAdapter implements ProviderAdapter {
  readonly id = "uniswap-across" as const;
  readonly implemented = true;

  capabilities(): Capabilities {
    return { routes: ["C"], ingress: ["contract-call"], nativeAssets: true, atomic: false, chains: ["ethereum", "base", "arbitrum", "optimism"], destinationLinkPublic: true, linkEvidence: "the deposit names the recipient (depositV3 recipient, emitted in FundsDeposited)" };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    if (!sameAsset(req)) return acrossSwapQuote(req, ACROSS_API, { spokePool: SPOKE_POOL, weth: WETH, chainId: CHAIN_ID });
    const { inputToken, outputToken } = bridgeTokens(req);
    const qs = new URLSearchParams({ inputToken, outputToken, originChainId: String(CHAIN_ID[req.from.chain]), destinationChainId: String(CHAIN_ID[req.to.chain]), amount: req.amount.toString(), recipient: req.destination, ...(req.source ? { depositor: req.source } : {}) });
    const { data, status } = await getJson<AcrossQuote | { message?: string }>(`${ACROSS_API}/suggested-fees?${qs}`);
    if (status !== 200 || !("outputAmount" in data)) throw new Error(`Across suggested-fees: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const q = data;
    if (q.isAmountTooLow) throw new Error("Across: amount below the minimum deposit");
    if (q.spokePoolAddress.toLowerCase() !== SPOKE_POOL[req.from.chain]) throw new Error(`Across: unexpected SpokePool ${q.spokePoolAddress}`);
    const out = BigInt(q.outputAmount);
    const fees: Fee[] = [
      { kind: "network", amount: BigInt(q.totalRelayFee.total), asset: req.from.symbol },
      ...(q.lpFee ? [{ kind: "liquidity" as const, amount: BigInt(q.lpFee.total), asset: req.from.symbol }] : []),
    ];
    const ts = Number(q.timestamp), fill = Number(q.fillDeadline);
    // the provider's stated size limits (whale spec §2): above maxDepositInstant a fill waits for the next bundle, above maxDeposit it refuses
    const limits = q.limits ? { min: BigInt(q.limits.minDeposit), max: BigInt(q.limits.maxDeposit), maxInstant: BigInt(q.limits.maxDepositInstant) } : undefined;
    const sizeSignals = limits && req.amount > limits.maxInstant! ? ["above the instant limit: the fill waits for relayer liquidity"] : [];
    return {
      provider: "uniswap-across", category: categoryOf(req.from, req.to), toAmount: out, toAmountMin: out, fees, etaSeconds: q.estimatedFillTimeSec,
      expiresAt: Math.min(ts + DEPOSIT_QUOTE_TIME_BUFFER, fill - 600), nativeAssets: true, minOutEncoded: true, minOutVerified: true, refundTarget: "escrow",
      plan: SINGLE_PLAN(q.estimatedFillTimeSec), impactBps: 0, limits, sizeSignals,
      hops: [`${req.from.chain}:${req.from.symbol} -> Across -> ${req.to.chain}:${req.to.symbol} (exact fill)`], raw: { ...q, inputToken, outputToken }, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    if ((quote.raw as { swapTx?: unknown })?.swapTx) return acrossSwapIngress(req, quote, { spokePool: SPOKE_POOL, weth: WETH, chainId: CHAIN_ID });
    const q = quote.raw as AcrossQuote & { inputToken: string; outputToken: string };
    if (!req.source) throw new Error("Across: the escrow address (req.source) is required as the depositor (refund target)");
    const calldata = encodeDepositV3({
      depositor: req.source, recipient: req.destination, inputToken: q.inputToken, outputToken: q.outputToken, inputAmount: req.amount, outputAmount: BigInt(q.outputAmount),
      destinationChainId: CHAIN_ID[req.to.chain], exclusiveRelayer: q.exclusiveRelayer, quoteTimestamp: Number(q.timestamp), fillDeadline: Number(q.fillDeadline), exclusivityDeadline: q.exclusivityDeadline,
    });
    return { kind: "contract-call", to: q.spokePoolAddress, calldata, value: req.from.asset === "native" ? req.amount : 0n, expiresAt: quote.expiresAt, minOutEncoded: true };
  }

  async track(ref: { sourceTxHash?: string; providerRef?: string }): Promise<TrackStatus> {
    if (!ref.sourceTxHash) return { state: "unknown" };
    const origin = ref.providerRef ?? "1";
    const { data, status } = await getJson<any>(`${ACROSS_API}/deposit/status?originChainId=${origin}&depositTxHash=${ref.sourceTxHash}`);
    if (status !== 200) return { state: status === 404 ? "unknown" : "unknown", raw: data };
    switch (data.status) {
      case "pending": return { state: "executing", raw: data };
      case "filled": return { state: "completed", destinationTxHash: data.fillTx, raw: data };
      case "expired": case "refunded": return { state: "refunded", raw: data };
      default: return { state: "unknown", raw: data };
    }
  }

  async health(): Promise<Health> {
    const t0 = Date.now();
    try {
      const { data, status } = await getJson<any[]>(`${ACROSS_API}/available-routes?originChainId=1&destinationChainId=8453&originToken=${WETH.ethereum}`);
      const ok = status === 200 && Array.isArray(data) && data.some((r) => r.isNative);
      return { provider: "uniswap-across", reachable: status === 200, apiLatencyMs: Date.now() - t0, halted: !ok, haltedChains: ok ? [] : ["ethereum->base native route missing"], checkedAt: Date.now() };
    } catch (e) {
      return { provider: "uniswap-across", reachable: false, apiLatencyMs: Date.now() - t0, halted: true, haltedChains: [], checkedAt: Date.now(), note: String(e) };
    }
  }
}
