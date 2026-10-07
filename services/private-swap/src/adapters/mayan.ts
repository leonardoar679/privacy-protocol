// Mayan adapter (plan §15, step 09): intent-style cross-chain swaps settled through Circle CCTP
// ("Fast MCTP" orders) between EVM chains and Solana. No wrapped assets: the user receives the real
// destination token (SOL, USDC, …).
//
// Ingress model (EVM source = our escrow): one call to Mayan's forwarder contract. For a native-ETH
// source: `swapAndForwardEth(amountIn, router, routerCalldata, USDC, minMiddleAmount, fastMctp,
// createOrderCalldata)` — the forwarder swaps ETH→USDC with a whitelisted router (calldata from Mayan's
// API, guarded by `minMiddleAmount` which the forwarder enforces on-chain), then opens the order. For a
// USDC source: `forwardERC20(USDC, amount, zeroPermit, fastMctp, createOrderCalldata)`.
//
// The order payload (destination, tokenOut, amountOutMin, deadline, fees) is BUILT HERE from the quote,
// exactly as the official SDK builds it, so a compromised API cannot change where or how much is paid
// out; the only API-supplied bytes are the router calldata, bounded by `minMiddleAmount`.
//
// Refunds: an unfulfilled order is refunded in USDC on the DESTINATION chain to `destAddr` (the user's
// fresh address), not to the escrow — flagged as `refundTarget: "destination"` so the wallet and the
// state machine treat it correctly (spec §7).
import { encodeCall, hexBuf, padLeft32, selectorHex } from "../abi";
import { base58Decode } from "./chainflip";
import type { AssetRef, Capabilities, Fee, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { categoryOf } from "../types";

export const MAYAN_PRICE_API = process.env.MAYAN_PRICE_API ?? "https://price-api.mayan.finance/v3";
export const MAYAN_EXPLORER_API = process.env.MAYAN_EXPLORER_API ?? "https://explorer-api.mayan.finance/v3";
export const MAYAN_SDK_VERSION = "15_2_2"; // the price API rejects requests without a recent sdkVersion
export const MAYAN_FORWARDER = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2"; // pinned (SDK 15.2.2 addresses)
export const MAYAN_SOLANA_PROGRAM = "FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf";
/** Fast-MCTP contract the forwarder may hand the order to (pinned from the price API on 2026-10-06; MAYAN_FAST_MCTP overrides). A quote naming another contract is refused. */
export const MAYAN_FAST_MCTP = (process.env.MAYAN_FAST_MCTP ?? "0xc1062b7c5dc8e4b1df9f200fe360cdc0ed6e7741").toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";
const FAST_MCTP_PAYLOAD_TYPE_ORDER = 3;
const CCTP_TOKEN_DECIMALS = 6;

const WORMHOLE_CHAIN: Record<string, number> = { solana: 1, ethereum: 2, bsc: 4, polygon: 5, avalanche: 6, arbitrum: 23, optimism: 24, base: 30 };
const CCTP_DOMAIN: Record<string, number> = { ethereum: 0, avalanche: 1, optimism: 2, arbitrum: 3, solana: 5, base: 6, polygon: 7 };
const EVM_CHAIN_ID: Record<string, number> = { ethereum: 1, bsc: 56, polygon: 137, avalanche: 43114, arbitrum: 42161, optimism: 10, base: 8453 };

/** Our AssetRef → Mayan's chain name and token contract string. */
export function mayanToken(a: AssetRef): { chain: string; contract: string } {
  if (WORMHOLE_CHAIN[a.chain] === undefined) throw new Error(`Mayan does not support chain ${a.chain}`);
  return { chain: a.chain, contract: a.asset === "native" ? ZERO : a.asset };
}

/** `nativeAddressToHexString`: 32-byte left-padded representation of an address on a chain. */
export function addressHex32(chain: string, address: string): Buffer {
  if (chain === "solana") { const b = base58Decode(address); if (b.length !== 32) throw new Error("bad Solana address"); return b; }
  if (EVM_CHAIN_ID[chain] !== undefined) { const b = hexBuf(address); if (b.length !== 20) throw new Error("bad EVM address"); return padLeft32(b); }
  throw new Error(`address encoding for ${chain} not implemented`);
}

/** SDK `getAmountOfFractionalAmount`: decimal string → integer with `decimals`, keeping at most 8 fractional digits. */
export function fractionalToUnits(amount: string | number, decimals: number): bigint {
  const cut = Math.min(8, decimals);
  const s = typeof amount === "number" ? amount.toFixed(cut + 1) : amount;
  const m = s.match(new RegExp(`^(\\d+)(?:\\.(\\d{0,${cut}}))?`));
  if (!m) throw new Error(`bad amount ${amount}`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  return BigInt(m[1] + frac);
}

export interface MayanQuote {
  type: "FAST_MCTP" | "MCTP" | "SWIFT" | "WH" | "SHUTTLE" | string; fromChain: string; toChain: string;
  fromToken: { contract: string; decimals: number; wChainId?: number }; toToken: { contract: string; decimals: number; wChainId?: number; verifiedAddress?: string };
  effectiveAmountIn64: string; expectedAmountOut: number; expectedAmountOutBaseUnits?: string; minAmountOut: number; minAmountOutBaseUnits?: string;
  minMiddleAmount?: number; deadline64: string; etaSeconds: number; gasDrop: number; redeemRelayerFee: number; refundRelayerFee64?: string;
  circleMaxFee64?: string; fastMctpMinFinality?: string | number; fastMctpMayanContract?: string; fastMctpInputContract?: string;
  hasAuction?: boolean; slippageBps: number; referrerBps?: number; protocolBps?: number; bridgeFee?: number; priceImpact?: number;
  clientRelayerFeeSuccess?: number; clientRelayerFeeRefund?: number; onlyBridging?: boolean;
}

async function getJson<T>(url: string, timeoutMs = 25000): Promise<{ data: T; status: number; ms: number }> {
  const t0 = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  const text = await r.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { data, status: r.status, ms: Date.now() - t0 };
}

export const SEL_CREATE_ORDER = selectorHex("createOrder(address,uint256,uint256,uint32,uint32,(uint8,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,bytes32,uint8))");
export const SEL_SWAP_AND_FORWARD_ETH = selectorHex("swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)");
export const SEL_FORWARD_ERC20 = selectorHex("forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)");

export interface OrderPayload { destAddr: Buffer; tokenOut: Buffer; amountOutMin: bigint; gasDrop: bigint; redeemFee: bigint; refundFee: bigint; deadline: bigint; referrerAddr: Buffer; referrerBps: number }

/** `FastMCTP.createOrder(tokenIn, amountIn, circleMaxFee, destDomain, minFinalityThreshold, orderPayload)` — all static. */
export function encodeCreateOrder(tokenIn: string, amountIn: bigint, circleMaxFee: bigint, destDomain: number, minFinality: number, p: OrderPayload): `0x${string}` {
  return encodeCall("createOrder(address,uint256,uint256,uint32,uint32,(uint8,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,bytes32,uint8))", [
    { t: "address", v: tokenIn }, { t: "uint", v: amountIn }, { t: "uint", v: circleMaxFee }, { t: "uint", v: destDomain }, { t: "uint", v: minFinality },
    { t: "uint", v: FAST_MCTP_PAYLOAD_TYPE_ORDER }, { t: "bytes32", v: p.destAddr }, { t: "bytes32", v: p.tokenOut }, { t: "uint", v: p.amountOutMin }, { t: "uint", v: p.gasDrop },
    { t: "uint", v: p.redeemFee }, { t: "uint", v: p.refundFee }, { t: "uint", v: p.deadline }, { t: "bytes32", v: p.referrerAddr }, { t: "uint", v: p.referrerBps },
  ]);
}

/** Build the Fast-MCTP order payload from a quote the way the SDK does (`getEvmFastMctpCreateOrderParams`). */
export function orderPayloadFromQuote(q: MayanQuote, destination: string): { payload: OrderPayload; destDomain: number; minFinality: number; circleMaxFee: bigint; tokenIn: string } {
  if (q.type !== "FAST_MCTP") throw new Error(`Mayan: quote type ${q.type} is not supported by this adapter (FAST_MCTP only)`);
  if (!q.fastMctpMayanContract || !q.fastMctpInputContract) throw new Error("Mayan: Fast MCTP contract addresses missing from the quote");
  if (!q.refundRelayerFee64 || !q.circleMaxFee64 || !Number(q.deadline64)) throw new Error("Mayan: refund fee / circle fee / deadline missing from the quote");
  const toChain = q.toChain;
  const destDomain = CCTP_DOMAIN[toChain];
  if (destDomain === undefined) throw new Error(`Mayan: no CCTP domain for ${toChain}`);
  const gasDecimals = toChain === "solana" ? 9 : 18;
  const tokenOut = q.toToken.contract === ZERO ? Buffer.alloc(32) /* SystemProgram id = all zeros */ : addressHex32(toChain, q.toToken.contract);
  const payload: OrderPayload = {
    destAddr: addressHex32(toChain, destination), tokenOut,
    amountOutMin: fractionalToUnits(q.minAmountOut, Math.min(8, q.toToken.decimals)),
    gasDrop: fractionalToUnits(q.gasDrop ?? 0, Math.min(gasDecimals, 8)),
    redeemFee: fractionalToUnits(q.redeemRelayerFee, CCTP_TOKEN_DECIMALS),
    refundFee: BigInt(q.refundRelayerFee64), deadline: BigInt(q.deadline64),
    referrerAddr: Buffer.alloc(32), referrerBps: q.referrerBps || 0,
  };
  return { payload, destDomain, minFinality: Number(q.fastMctpMinFinality ?? 0), circleMaxFee: BigInt(q.circleMaxFee64), tokenIn: q.fastMctpInputContract };
}

/** Min output in destination base units implied by the on-chain `amountOutMin` (which has min(8, decimals) decimals). */
export function minOutBaseUnits(q: MayanQuote): bigint {
  const dec = q.toToken.decimals;
  const units = fractionalToUnits(q.minAmountOut, Math.min(8, dec));
  return dec > 8 ? units * 10n ** BigInt(dec - 8) : units;
}

export class MayanAdapter implements ProviderAdapter {
  readonly id = "mayan" as const;
  readonly implemented = true;

  capabilities(): Capabilities {
    return { routes: ["B", "C", "D"], ingress: ["contract-call"], nativeAssets: true, atomic: false, chains: ["ethereum", "solana", "base", "arbitrum", "optimism", "polygon", "avalanche", "bsc"], destinationLinkPublic: true, linkEvidence: "the order payload carries destAddr (decoded locally before signing)" };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const from = mayanToken(req.from), to = mayanToken(req.to);
    const qs = new URLSearchParams({
      wormhole: "false", swift: "false", mctp: "false", shuttle: "false", fastMctp: "true", gasless: "false", onlyDirect: "false", fullList: "false", guaranteedOutput: "true", monoChain: "true",
      solanaProgram: MAYAN_SOLANA_PROGRAM, forwarderAddress: MAYAN_FORWARDER, amountIn64: req.amount.toString(), fromToken: from.contract, fromChain: from.chain,
      toToken: to.contract, toChain: to.chain, slippageBps: String(req.slippageBps), gasDrop: "0", destinationAddress: req.destination, sdkVersion: MAYAN_SDK_VERSION,
    });
    const { data, status } = await getJson<{ quotes?: MayanQuote[]; code?: string; msg?: string }>(`${MAYAN_PRICE_API}/quote?${qs}`);
    if (status !== 200) throw new Error(`Mayan quote: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const q = (data.quotes ?? []).find((x) => x.type === "FAST_MCTP");
    if (!q) throw new Error(`Mayan: no FAST_MCTP quote (${(data.quotes ?? []).map((x) => x.type).join(",") || "none"})`);
    if (BigInt(q.effectiveAmountIn64) !== req.amount) throw new Error("Mayan: effectiveAmountIn64 differs from the requested amount");
    const toAmount = q.expectedAmountOutBaseUnits ? BigInt(q.expectedAmountOutBaseUnits) : fractionalToUnits(q.expectedAmountOut, req.to.decimals);
    const toAmountMin = minOutBaseUnits(q);
    // a lowered minimum is a changed quote (plan §71/§74): it must sit within slippage + 2 % of the expected output
    if (toAmountMin * 10000n < toAmount * BigInt(10000 - req.slippageBps - 200)) throw new Error(`Mayan: minAmountOut ${toAmountMin} is more than ${req.slippageBps + 200} bps below expectedAmountOut ${toAmount}`);
    if (toAmountMin > toAmount) throw new Error("Mayan: minAmountOut exceeds expectedAmountOut");
    if (q.fastMctpMayanContract && q.fastMctpMayanContract.toLowerCase() !== MAYAN_FAST_MCTP) throw new Error(`Mayan: quote names Fast-MCTP contract ${q.fastMctpMayanContract}, not the pinned ${MAYAN_FAST_MCTP}`);
    const fees: Fee[] = [
      { kind: "network", amount: fractionalToUnits(q.redeemRelayerFee, CCTP_TOKEN_DECIMALS), asset: "USDC(redeem relayer fee)" },
      { kind: "protocol", amount: BigInt(q.circleMaxFee64 ?? "0"), asset: "USDC(circle max fee)" },
    ];
    const now = Math.floor(Date.now() / 1000);
    const deadline = Number(q.deadline64);
    return {
      provider: "mayan", category: categoryOf(req.from, req.to), toAmount, toAmountMin, fees, etaSeconds: q.etaSeconds,
      expiresAt: Math.min(deadline - 120, now + 600), // execute well before the order deadline
      nativeAssets: true, minOutEncoded: true, minOutVerified: true, refundTarget: "destination", hops: [`${from.chain}:${req.from.symbol} -> USDC (CCTP fast) -> ${to.chain}:${req.to.symbol}`],
      raw: q, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    const q = quote.raw as MayanQuote;
    const { payload, destDomain, minFinality, circleMaxFee, tokenIn } = orderPayloadFromQuote(q, req.destination);
    const createOrder = encodeCreateOrder(tokenIn, req.amount, circleMaxFee, destDomain, minFinality, payload);
    const fastMctp = q.fastMctpMayanContract!;
    if (req.from.asset === "native") {
      // source-chain ETH→USDC leg: router + calldata from Mayan, enforced on-chain by the forwarder's minMiddleAmount
      if (q.minMiddleAmount === undefined) throw new Error("Mayan: minMiddleAmount missing");
      const sq = new URLSearchParams({ forwarderAddress: MAYAN_FORWARDER, fromToken: ZERO, middleToken: tokenIn, slippageBps: String(q.slippageBps), amountIn64: req.amount.toString(), chainName: req.from.chain, sdkVersion: MAYAN_SDK_VERSION });
      const { data: sw, status } = await getJson<{ swapRouterAddress: string; swapRouterCalldata: string }>(`${MAYAN_PRICE_API}/get-swap/evm?${sq}`);
      if (status !== 200 || !sw.swapRouterCalldata) throw new Error(`Mayan get-swap/evm: HTTP ${status} ${JSON.stringify(sw).slice(0, 200)}`);
      const minMiddle = fractionalToUnits(q.minMiddleAmount, CCTP_TOKEN_DECIMALS);
      const calldata = encodeCall("swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)", [
        { t: "uint", v: req.amount }, { t: "address", v: sw.swapRouterAddress }, { t: "bytes", v: sw.swapRouterCalldata },
        { t: "address", v: tokenIn }, { t: "uint", v: minMiddle }, { t: "address", v: fastMctp }, { t: "bytes", v: createOrder },
      ]);
      return { kind: "contract-call", to: MAYAN_FORWARDER, calldata, value: req.amount, expiresAt: quote.expiresAt, minOutEncoded: true };
    }
    if (req.from.asset.toLowerCase() !== tokenIn.toLowerCase()) throw new Error(`Mayan: ERC-20 sources other than ${tokenIn} need a source swap (not implemented)`);
    const calldata = encodeCall("forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)", [
      { t: "address", v: tokenIn }, { t: "uint", v: req.amount },
      { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "bytes32", v: Buffer.alloc(32) }, { t: "bytes32", v: Buffer.alloc(32) }, // zero permit: the escrow approves instead
      { t: "address", v: fastMctp }, { t: "bytes", v: createOrder },
    ]);
    return { kind: "contract-call", to: MAYAN_FORWARDER, calldata, value: 0n, expiresAt: quote.expiresAt, minOutEncoded: true };
  }

  async track(ref: { sourceTxHash?: string }): Promise<TrackStatus> {
    if (!ref.sourceTxHash) return { state: "unknown" };
    const { data, status } = await getJson<any>(`${MAYAN_EXPLORER_API}/swap/trx/${ref.sourceTxHash}`);
    if (status !== 200) return { state: "unknown", raw: data };
    const s = String(data.clientStatus ?? data.status ?? "").toUpperCase();
    if (s.includes("REFUND")) return { state: "refunded", raw: data };
    if (s === "COMPLETED" || s === "SETTLED" || s === "FULFILLED") return { state: "completed", destinationTxHash: data.fulfillTxHash ?? data.redeemTxHash, raw: data };
    if (s.includes("INPROGRESS") || s.includes("PENDING")) return { state: "executing", raw: data };
    return { state: "unknown", raw: data };
  }

  async health(): Promise<Health> {
    const t0 = Date.now();
    try {
      const { status, data } = await getJson<any>(`${MAYAN_PRICE_API}/tokens?chain=ethereum&sdkVersion=${MAYAN_SDK_VERSION}`);
      const ok = status === 200 && !!data?.ethereum?.length;
      return { provider: "mayan", reachable: ok, apiLatencyMs: Date.now() - t0, halted: !ok, haltedChains: [], checkedAt: Date.now(), note: ok ? undefined : `HTTP ${status}` };
    } catch (e) {
      return { provider: "mayan", reachable: false, apiLatencyMs: Date.now() - t0, halted: true, haltedChains: [], checkedAt: Date.now(), note: String(e) };
    }
  }
}
