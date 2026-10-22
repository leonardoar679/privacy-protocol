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
// exactly as the official SDK builds it, so a compromised API cannot change where it is paid out; the
// fees, the gas drop and the deadline it quotes are bounded as SWIFT's are (checkFastMctpQuote, audit
// 2026-10-16); the only API-supplied bytes are the router calldata, bounded by `minMiddleAmount`.
//
// Refunds: an unfulfilled order is refunded in USDC on the DESTINATION chain to `destAddr` (the user's
// fresh address), not to the escrow — flagged as `refundTarget: "destination"` so the wallet and the
// state machine treat it correctly (spec §7).
//
// SWIFT (Swift V2 auction orders): the order (`createOrderWithToken(tokenIn, amountIn, OrderParams,
// customPayload)`) is also BUILT HERE from the quote, the way the SDK builds it (`getEvmSwiftParams`),
// with the escrow as `trader`: an order no solver fills is cancelled after its deadline and refunded on
// Ethereum to the trader (SwiftSource.refundOrder, verified source), so it comes back to the escrow and
// re-shields. An ETH order is locked "wrap & lock" (tokenIn = 0): the pinned EthWrapper turns the ETH
// into WETH 1:1 (`wrap()`, no router calldata from the API) and the refund pays ETH. An ERC-20 order
// locks its own token. Referrer and protocol fees are taken on the source side from what the solver is
// released, not from what the user receives; the cancel and refund fees (charged only on a refund) are
// bounded here. With both order types allowed, the higher guaranteed minimum wins, SWIFT on a tie.
import { randomBytes } from "node:crypto";
import { encodeCall, hexBuf, padLeft32, selectorHex } from "../abi";
import { base58Decode } from "./chainflip";
import { escrowCanReshield } from "../escrowAssets";
import type { AssetRef, Capabilities, Fee, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { AdapterRefusal, SINGLE_PLAN, categoryOf } from "../types";

export const MAYAN_PRICE_API = process.env.MAYAN_PRICE_API ?? "https://price-api.mayan.finance/v3";
export const MAYAN_EXPLORER_API = process.env.MAYAN_EXPLORER_API ?? "https://explorer-api.mayan.finance/v3";
export const MAYAN_SDK_VERSION = "15_2_2"; // the price API rejects requests without a recent sdkVersion
export const MAYAN_FORWARDER = "0x337685fdab40d39bd02028545a4ffa7d287cc3e2"; // pinned (SDK 15.2.2 addresses)
export const MAYAN_SOLANA_PROGRAM = "FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf";
/** Fast-MCTP contract the forwarder may hand the order to (pinned from the price API on 2026-10-06; MAYAN_FAST_MCTP overrides). A quote naming another contract is refused. */
export const MAYAN_FAST_MCTP = (process.env.MAYAN_FAST_MCTP ?? "0xc1062b7c5dc8e4b1df9f200fe360cdc0ed6e7741").toLowerCase();
/** Swift V2 on Ethereum (pinned: Sourcify exact match, on the forwarder's whitelist; MAYAN_SWIFT_V2 overrides). A quote naming another contract is refused. */
export const MAYAN_SWIFT_V2 = (process.env.MAYAN_SWIFT_V2 ?? "0x40ffe85a28dc9993541449464d7529a922142960").toLowerCase();
/** Mayan's EthWrapper (pinned: Sourcify exact match, on the forwarder's whitelist): `wrap()` deposits the ETH sent into WETH and returns it 1:1. */
export const MAYAN_ETH_WRAPPER = "0x529863940bf6065d8c122a550c2ff37c1cfefa16";
export const WETH_ETHEREUM = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
/** USDC on Ethereum: the middle token of a SWIFT "swap & lock" order (Mayan's own routing for a small ETH order) */
export const USDC_ETHEREUM = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const SEL_WRAP = "0xd46eb119"; // wrap()
export const SWIFT_CREATE_ORDER_SIG = "createOrderWithToken(address,uint256,(uint8,bytes32,bytes32,uint16,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,uint8,uint8,bytes32),bytes)";
export const SEL_SWIFT_CREATE_ORDER = selectorHex(SWIFT_CREATE_ORDER_SIG);
/** The cancel + refund relayer fees, taken from an unfilled order's refund, may be at most this share of the order (bps). */
export const SWIFT_MAX_REFUND_FEES_BPS = 100;
/** Execution stops this long before the order deadline, so solvers still have time to fill (Mayan quotes ~25 min orders). */
export const SWIFT_FILL_MARGIN_SECONDS = 600;
/** The order deadline must lie this far ahead at quote time, and no further than the max: after it an unfilled order is cancelled and refunded inside the executor's watch. */
export const SWIFT_MIN_DEADLINE_SECONDS = 900;
export const SWIFT_MAX_DEADLINE_SECONDS = 6 * 3600;
/**
 * A Fast-MCTP order's redeem and refund fees (audit 2026-10-16): at most 1 % of the USDC it carries, or 2 USDC when that is more
 * (they pay the destination's gas: about 0.49 USDC each to Solana, under a cent to Base on 2026-10-16). Mayan's verified FastMCTP
 * pays refundFee to whoever calls refund, and for a USDC output that refund is how the order delivers. Circle's fee at most 1 %.
 */
export const FAST_MCTP_MAX_FEES_BPS = 100;
export const FAST_MCTP_MIN_FEE_CAP = 2_000_000n;
/** A Fast-MCTP order's deadline at quote time: Mayan quotes about 30 minutes; at most the SWIFT bound (an unfilled order's USDC waits for it). */
export const FAST_MCTP_MIN_DEADLINE_SECONDS = 600;
const SWIFT_PAYLOAD_TYPE_DEFAULT = 1;
export type MayanOrderType = "FAST_MCTP" | "SWIFT";
/** The order types quoted by default (MAYAN_ORDER_TYPES="FAST_MCTP,SWIFT"). */
export const MAYAN_ORDER_TYPES: MayanOrderType[] = (process.env.MAYAN_ORDER_TYPES ?? "FAST_MCTP,SWIFT").split(",").map((s) => s.trim().toUpperCase()).filter((s): s is MayanOrderType => s === "FAST_MCTP" || s === "SWIFT");
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
  // SWIFT
  swiftVersion?: string; swiftMayanContract?: string; swiftInputContract?: string; swiftInputDecimals?: number; swiftAuctionMode?: number;
  swiftWrapAndLock?: boolean; cancelRelayerFee64?: string; quoteId?: string; memoHex?: string;
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

/**
 * What a Fast-MCTP quote must say before it is ranked (audit 2026-10-16), as SWIFT's: an order from Ethereum to the asked chain and
 * asset, in its decimals; no gas drop (none is asked for); a deadline within FAST_MCTP_MIN_DEADLINE_SECONDS .. SWIFT_MAX_DEADLINE_SECONDS;
 * redeem + refund fees within FAST_MCTP_MAX_FEES_BPS of the USDC the order carries (or FAST_MCTP_MIN_FEE_CAP), Circle's fee within 1 %.
 */
export function checkFastMctpQuote(q: MayanQuote, req: Pick<QuoteRequest, "from" | "to" | "amount">, now: number): void {
  if (q.fromChain !== "ethereum") throw new Error("Mayan Fast-MCTP: only orders from Ethereum, the escrow's chain");
  if (q.toChain !== req.to.chain) throw new Error(`Mayan Fast-MCTP: delivers on ${q.toChain}, not ${req.to.chain}`);
  if (String(q.toToken.contract).toLowerCase() !== (req.to.asset === "native" ? ZERO : req.to.asset.toLowerCase()) || Number(q.toToken.decimals) !== req.to.decimals) throw new Error(`Mayan Fast-MCTP: delivers ${q.toToken.contract} (${q.toToken.decimals} decimals), not ${req.to.symbol}`);
  if (Number(q.gasDrop ?? 0) !== 0) throw new Error("Mayan Fast-MCTP: a gas drop was not asked for");
  const deadline = Number(q.deadline64);
  if (!(deadline >= now + FAST_MCTP_MIN_DEADLINE_SECONDS && deadline <= now + SWIFT_MAX_DEADLINE_SECONDS)) throw new Error(`Mayan Fast-MCTP: order deadline ${q.deadline64} is not within ${FAST_MCTP_MIN_DEADLINE_SECONDS} s .. ${SWIFT_MAX_DEADLINE_SECONDS} s from now`);
  if (!q.refundRelayerFee64 || !q.circleMaxFee64) throw new Error("Mayan Fast-MCTP: refund fee / circle fee missing from the quote");
  // the USDC the order carries: the order's own amount, or for ETH the swap's floor (the forwarder hands the order what the router produced)
  if (req.from.asset === "native" && q.minMiddleAmount === undefined) throw new Error("Mayan: minMiddleAmount missing");
  const usdc = req.from.asset === "native" ? fractionalToUnits(q.minMiddleAmount!, CCTP_TOKEN_DECIMALS) : req.amount;
  const share = (usdc * BigInt(FAST_MCTP_MAX_FEES_BPS)) / 10000n;
  const cap = share > FAST_MCTP_MIN_FEE_CAP ? share : FAST_MCTP_MIN_FEE_CAP;
  const fees = fractionalToUnits(q.redeemRelayerFee, CCTP_TOKEN_DECIMALS) + BigInt(q.refundRelayerFee64);
  if (fees > cap) throw new Error(`Mayan Fast-MCTP: redeem + refund fees (${fees}) above ${cap} USDC base units (${FAST_MCTP_MAX_FEES_BPS} bps of the order, or 2 USDC)`);
  if (BigInt(q.circleMaxFee64) * 10000n > usdc * BigInt(FAST_MCTP_MAX_FEES_BPS)) throw new Error(`Mayan Fast-MCTP: Circle's maximum fee ${q.circleMaxFee64} above ${FAST_MCTP_MAX_FEES_BPS} bps of the order`);
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

export interface SwiftOrder { payloadType: number; trader: Buffer; destAddr: Buffer; destChainId: number; referrerAddr: Buffer; tokenOut: Buffer; minAmountOut: bigint; gasDrop: bigint; cancelFee: bigint; refundFee: bigint; deadline: bigint; referrerBps: number; auctionMode: number; random: Buffer }

/**
 * What a SWIFT quote must say before it is ranked: the pinned Swift V2 contract, an order from Ethereum to the asked chain
 * and asset, an ETH order as wrap & lock (refunded as ETH) or — Mayan's own routing for a small ETH order (Stage 1: the only
 * quote below $2M) — as "swap & lock": ETH swapped into USDC by a router Mayan names, bounded on chain by the forwarder's
 * minMiddleAmount, the USDC locked in Swift and refunded to the escrow if no solver fills (so the escrow must re-shield USDC,
 * PP-S08); an ERC-20 order locks its own token. The deadline must leave solvers time and still refund inside the watch, and
 * cancel + refund fees stay within SWIFT_MAX_REFUND_FEES_BPS.
 */
export function checkSwiftQuote(q: MayanQuote, req: Pick<QuoteRequest, "from" | "to" | "amount">, now: number): { tokenIn: string; wrap: boolean; swapToMiddle: boolean } {
  if (q.type !== "SWIFT") throw new Error(`Mayan: quote type ${q.type} is not SWIFT`);
  if (q.swiftVersion !== "V2") throw new Error(`Mayan: Swift ${q.swiftVersion ?? "(no version)"} is not supported (V2 only)`);
  if (String(q.swiftMayanContract ?? "").toLowerCase() !== MAYAN_SWIFT_V2) throw new Error(`Mayan: quote names Swift contract ${q.swiftMayanContract}, not the pinned ${MAYAN_SWIFT_V2}`);
  if (q.fromChain !== "ethereum") throw new Error("Mayan SWIFT: only orders from Ethereum, the escrow's chain");
  const destChainId = WORMHOLE_CHAIN[q.toChain];
  if (destChainId === undefined || q.toChain !== req.to.chain || (q.toToken.wChainId !== undefined && Number(q.toToken.wChainId) !== destChainId)) throw new Error(`Mayan SWIFT: delivers on ${q.toChain}, not ${req.to.chain}`);
  if (String(q.toToken.contract).toLowerCase() !== (req.to.asset === "native" ? ZERO : req.to.asset.toLowerCase())) throw new Error(`Mayan SWIFT: delivers ${q.toToken.contract}, not ${req.to.symbol}`);
  const input = String(q.swiftInputContract ?? "").toLowerCase();
  let tokenIn: string, wrap: boolean, swapToMiddle = false;
  if (req.from.asset === "native") {
    if (input === WETH_ETHEREUM && q.swiftWrapAndLock) { tokenIn = ZERO; wrap = true; }
    else if (input === USDC_ETHEREUM && !q.swiftWrapAndLock && q.minMiddleAmount !== undefined && Number(q.minMiddleAmount) > 0) {
      if (!escrowCanReshield(req.from as AssetRef, USDC_ETHEREUM)) throw new Error("Mayan SWIFT: swaps the ETH into USDC first; an unfilled order would refund USDC to the escrow, which cannot re-shield it (the pool has no USDC vault): not offered");
      tokenIn = USDC_ETHEREUM; wrap = false; swapToMiddle = true;
    } else throw new Error("Mayan SWIFT: an ETH order is taken as wrap & lock (wrapped 1:1 by the pinned wrapper, refunded as ETH) or as swap & lock (into USDC, bounded by minMiddleAmount, refunded as USDC); this quote is neither");
  } else {
    if (input !== req.from.asset.toLowerCase() || q.swiftWrapAndLock) throw new Error(`Mayan SWIFT: an ERC-20 order must lock ${req.from.symbol} itself (a source swap is not read)`);
    tokenIn = input; wrap = false;
  }
  const deadline = Number(q.deadline64);
  if (!(deadline >= now + SWIFT_MIN_DEADLINE_SECONDS && deadline <= now + SWIFT_MAX_DEADLINE_SECONDS)) throw new Error(`Mayan SWIFT: order deadline ${q.deadline64} is not within ${SWIFT_MIN_DEADLINE_SECONDS} s .. ${SWIFT_MAX_DEADLINE_SECONDS} s from now`);
  if (!q.swiftAuctionMode) throw new Error("Mayan SWIFT: no auction mode in the quote");
  if (!q.cancelRelayerFee64 || !q.refundRelayerFee64) throw new Error("Mayan SWIFT: cancel / refund fees missing from the quote");
  // Swift's 8-decimal amounts; a swap & lock order is in USDC (6 decimals), at least minMiddleAmount of it
  const inDecimals = swapToMiddle ? CCTP_TOKEN_DECIMALS : req.from.asset === "native" ? 18 : req.from.decimals;
  const orderIn = swapToMiddle ? fractionalToUnits(q.minMiddleAmount!, CCTP_TOKEN_DECIMALS) : req.amount;
  const normalizedIn = inDecimals > 8 ? orderIn / 10n ** BigInt(inDecimals - 8) : orderIn;
  const fees = BigInt(q.cancelRelayerFee64) + BigInt(q.refundRelayerFee64);
  if (fees * 10000n > normalizedIn * BigInt(SWIFT_MAX_REFUND_FEES_BPS)) throw new Error(`Mayan SWIFT: cancel + refund fees (${fees}) above ${SWIFT_MAX_REFUND_FEES_BPS} bps of the order`);
  if (Number(q.gasDrop ?? 0) !== 0) throw new Error("Mayan SWIFT: a gas drop was not asked for");
  return { tokenIn, wrap, swapToMiddle };
}

/** The SDK's `createSwiftRandomKey`: the quote id (16 bytes, left-padded) then the memo or 16 random bytes; 32 random bytes without a usable id. */
export function swiftRandom(q: Pick<MayanQuote, "quoteId" | "memoHex">, tail: Buffer = randomBytes(16)): Buffer {
  const pad16 = (h: string) => { const b = hexBuf(h); return b.length <= 16 ? Buffer.concat([Buffer.alloc(16 - b.length), b]) : null; };
  const id = q.quoteId ? pad16(q.quoteId) : null;
  if (!id) return randomBytes(32);
  const memo = q.memoHex ? pad16(q.memoHex) : null;
  return Buffer.concat([id, memo ?? tail]);
}

/** Build the Swift V2 order from a quote the way the SDK does (`getEvmSwiftParams`), with the escrow as trader: where an unfilled order is refunded. */
export function swiftOrderFromQuote(q: MayanQuote, req: QuoteRequest, now = Math.floor(Date.now() / 1000), tail?: Buffer): { tokenIn: string; wrap: boolean; swapToMiddle: boolean; order: SwiftOrder } {
  if (!req.source) throw new Error("Mayan SWIFT: the escrow address (req.source) is required: it is the trader an unfilled order is refunded to");
  const { tokenIn, wrap, swapToMiddle } = checkSwiftQuote(q, req, now);
  const order: SwiftOrder = {
    payloadType: SWIFT_PAYLOAD_TYPE_DEFAULT, trader: addressHex32("ethereum", req.source), destAddr: addressHex32(q.toChain, req.destination),
    destChainId: WORMHOLE_CHAIN[q.toChain], referrerAddr: Buffer.alloc(32), tokenOut: q.toToken.contract === ZERO ? Buffer.alloc(32) /* SystemProgram id */ : addressHex32(q.toChain, q.toToken.contract),
    minAmountOut: fractionalToUnits(q.minAmountOut, Math.min(8, q.toToken.decimals)), gasDrop: 0n,
    cancelFee: BigInt(q.cancelRelayerFee64!), refundFee: BigInt(q.refundRelayerFee64!), deadline: BigInt(q.deadline64), referrerBps: 0, auctionMode: Number(q.swiftAuctionMode), random: swiftRandom(q, tail),
  };
  return { tokenIn, wrap, swapToMiddle, order };
}

/** `SwiftSource.createOrderWithToken(tokenIn, amountIn, OrderParams, customPayload)`: the static struct inline, an empty custom payload. */
export function encodeSwiftCreateOrder(tokenIn: string, amountIn: bigint, o: SwiftOrder): `0x${string}` {
  return encodeCall(SWIFT_CREATE_ORDER_SIG, [
    { t: "address", v: tokenIn }, { t: "uint", v: amountIn },
    { t: "uint", v: o.payloadType }, { t: "bytes32", v: o.trader }, { t: "bytes32", v: o.destAddr }, { t: "uint", v: o.destChainId }, { t: "bytes32", v: o.referrerAddr }, { t: "bytes32", v: o.tokenOut },
    { t: "uint", v: o.minAmountOut }, { t: "uint", v: o.gasDrop }, { t: "uint", v: o.cancelFee }, { t: "uint", v: o.refundFee }, { t: "uint", v: o.deadline },
    { t: "uint", v: o.referrerBps }, { t: "uint", v: o.auctionMode }, { t: "bytes32", v: o.random },
    { t: "bytes", v: "0x" },
  ]);
}

/** Mayan's own price impact, as it reports it (a percentage), in bps; absent when it reports none (whale spec §2, §8). */
export const impactBpsOf = (q: MayanQuote): number | undefined => (q.priceImpact === undefined || q.priceImpact === null || !Number.isFinite(Number(q.priceImpact)) ? undefined : Math.max(0, Math.round(Number(q.priceImpact) * 100)));

/** Min output in destination base units implied by the on-chain `amountOutMin` (which has min(8, decimals) decimals). */
export function minOutBaseUnits(q: MayanQuote): bigint {
  const dec = q.toToken.decimals;
  const units = fractionalToUnits(q.minAmountOut, Math.min(8, dec));
  return dec > 8 ? units * 10n ** BigInt(dec - 8) : units;
}

export class MayanAdapter implements ProviderAdapter {
  readonly id = "mayan" as const;
  readonly implemented = true;
  readonly orderTypes: MayanOrderType[];
  constructor(opts: { orderTypes?: MayanOrderType[] } = {}) {
    this.orderTypes = opts.orderTypes ?? MAYAN_ORDER_TYPES;
  }

  capabilities(): Capabilities {
    return { routes: ["B", "C", "D"], ingress: ["contract-call"], nativeAssets: true, atomic: false, chains: ["ethereum", "solana", "base", "arbitrum", "optimism", "polygon", "avalanche", "bsc"], destinationLinkPublic: true, linkEvidence: "the order payload carries destAddr (decoded locally before signing)" };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const from = mayanToken(req.from), to = mayanToken(req.to);
    const qs = new URLSearchParams({
      wormhole: "false", swift: String(this.orderTypes.includes("SWIFT")), mctp: "false", shuttle: "false", fastMctp: String(this.orderTypes.includes("FAST_MCTP")), gasless: "false", onlyDirect: "false", fullList: "false", guaranteedOutput: "true", monoChain: "true",
      solanaProgram: MAYAN_SOLANA_PROGRAM, forwarderAddress: MAYAN_FORWARDER, amountIn64: req.amount.toString(), fromToken: from.contract, fromChain: from.chain,
      toToken: to.contract, toChain: to.chain, slippageBps: String(req.slippageBps), gasDrop: "0", destinationAddress: req.destination, sdkVersion: MAYAN_SDK_VERSION,
    });
    const { data, status } = await getJson<{ quotes?: MayanQuote[]; code?: string; msg?: string }>(`${MAYAN_PRICE_API}/quote?${qs}`);
    if (status !== 200) throw new Error(`Mayan quote: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const offered = (data.quotes ?? []).filter((x) => this.orderTypes.includes(x.type as MayanOrderType));
    const built: Quote[] = [], refused: string[] = [];
    for (const q of offered) {
      try { built.push(q.type === "SWIFT" ? this.swiftQuote(req, q) : this.fastQuote(req, q)); } catch (e) { refused.push(`${q.type}: ${(e as Error).message}`); }
    }
    // every quote Mayan offered failed this adapter's own checks: a refusal for this request, never an outage (audit round 2, r03)
    if (!built.length) throw refused.length ? new AdapterRefusal(refused.join("; ")) : new Error(`Mayan: no ${this.orderTypes.join("/")} quote (${(data.quotes ?? []).map((x) => x.type).join(",") || "none"})`);
    // the higher guaranteed minimum; on a tie SWIFT, whose unfilled order is refunded to the escrow
    const swift = (x: Quote) => ((x.raw as MayanQuote).type === "SWIFT" ? 1 : 0);
    built.sort((a, b) => (a.toAmountMin === b.toAmountMin ? swift(b) - swift(a) : a.toAmountMin > b.toAmountMin ? -1 : 1));
    return built[0];
  }

  private swiftQuote(req: QuoteRequest, q: MayanQuote): Quote {
    if (BigInt(q.effectiveAmountIn64) !== req.amount) throw new Error("Mayan: effectiveAmountIn64 differs from the requested amount");
    const now = Math.floor(Date.now() / 1000);
    const { swapToMiddle } = checkSwiftQuote(q, req, now);
    const toAmount = q.expectedAmountOutBaseUnits ? BigInt(q.expectedAmountOutBaseUnits) : fractionalToUnits(q.expectedAmountOut, req.to.decimals);
    const toAmountMin = minOutBaseUnits(q);
    if (toAmountMin * 10000n < toAmount * BigInt(10000 - req.slippageBps - 200)) throw new Error(`Mayan: minAmountOut ${toAmountMin} is more than ${req.slippageBps + 200} bps below expectedAmountOut ${toAmount}`);
    if (toAmountMin > toAmount) throw new Error("Mayan: minAmountOut exceeds expectedAmountOut");
    const locked = req.from.asset !== "native" ? `${req.from.symbol} locked` : swapToMiddle ? "ETH swapped into USDC (bounded on chain) and the USDC locked" : "ETH locked as WETH";
    return {
      provider: "mayan", category: categoryOf(req.from, req.to), toAmount, toAmountMin, fees: [], etaSeconds: q.etaSeconds,
      expiresAt: Math.min(Number(q.deadline64) - SWIFT_FILL_MARGIN_SECONDS, now + 600), // execute while solvers still have time to fill
      nativeAssets: !swapToMiddle, minOutEncoded: true, minOutVerified: true, refundTarget: "escrow", plan: SINGLE_PLAN(q.etaSeconds, "auction"), impactBps: impactBpsOf(q),
      hops: [`${req.from.chain}:${req.from.symbol} -> Swift V2 auction (${locked}) -> ${req.to.chain}:${req.to.symbol}; unfilled: cancelled after the deadline, refunded to the escrow${swapToMiddle ? " in USDC" : ""}`],
      raw: q, obtainedAt: Date.now(),
    };
  }

  private fastQuote(req: QuoteRequest, q: MayanQuote): Quote {
    const to = mayanToken(req.to), from = mayanToken(req.from);
    if (BigInt(q.effectiveAmountIn64) !== req.amount) throw new Error("Mayan: effectiveAmountIn64 differs from the requested amount");
    checkFastMctpQuote(q, req, Math.floor(Date.now() / 1000));
    const toAmount = q.expectedAmountOutBaseUnits ? BigInt(q.expectedAmountOutBaseUnits) : fractionalToUnits(q.expectedAmountOut, req.to.decimals);
    const toAmountMin = minOutBaseUnits(q);
    // a lowered minimum is a changed quote (plan §71/§74): it must sit within slippage + 2 % of the expected output
    if (toAmountMin * 10000n < toAmount * BigInt(10000 - req.slippageBps - 200)) throw new Error(`Mayan: minAmountOut ${toAmountMin} is more than ${req.slippageBps + 200} bps below expectedAmountOut ${toAmount}`);
    if (toAmountMin > toAmount) throw new Error("Mayan: minAmountOut exceeds expectedAmountOut");
    if (q.fastMctpMayanContract && q.fastMctpMayanContract.toLowerCase() !== MAYAN_FAST_MCTP) throw new Error(`Mayan: quote names Fast-MCTP contract ${q.fastMctpMayanContract}, not the pinned ${MAYAN_FAST_MCTP}`);
    const fees: Fee[] = [
      { kind: "network", amount: fractionalToUnits(q.redeemRelayerFee, CCTP_TOKEN_DECIMALS), asset: "USDC", decimals: CCTP_TOKEN_DECIMALS }, // the redeem relayer fee
      { kind: "protocol", amount: BigInt(q.circleMaxFee64 ?? "0"), asset: "USDC", decimals: CCTP_TOKEN_DECIMALS }, // Circle's maximum fee
    ];
    const now = Math.floor(Date.now() / 1000);
    const deadline = Number(q.deadline64);
    return {
      provider: "mayan", category: categoryOf(req.from, req.to), toAmount, toAmountMin, fees, etaSeconds: q.etaSeconds,
      expiresAt: Math.min(deadline - 120, now + 600), // execute well before the order deadline
      nativeAssets: true, minOutEncoded: true, minOutVerified: true, refundTarget: "destination", plan: SINGLE_PLAN(q.etaSeconds), impactBps: impactBpsOf(q),
      hops: [`${from.chain}:${req.from.symbol} -> USDC (CCTP fast) -> ${to.chain}:${req.to.symbol}`],
      raw: q, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    const q = quote.raw as MayanQuote;
    if (q.type === "SWIFT") {
      const { tokenIn, wrap, swapToMiddle, order } = swiftOrderFromQuote(q, req);
      if (swapToMiddle) {
        // swap & lock: the ETH → USDC router call from Mayan, bounded on chain by the forwarder's minMiddleAmount; the forwarder then
        // overwrites the order's amountIn with the USDC the router produced (replaceMiddleAmount, verified source) and Swift locks it
        const sq = new URLSearchParams({ forwarderAddress: MAYAN_FORWARDER, fromToken: ZERO, middleToken: USDC_ETHEREUM, slippageBps: String(q.slippageBps), amountIn64: req.amount.toString(), chainName: req.from.chain, sdkVersion: MAYAN_SDK_VERSION });
        const { data: sw, status } = await getJson<{ swapRouterAddress: string; swapRouterCalldata: string }>(`${MAYAN_PRICE_API}/get-swap/evm?${sq}`);
        if (status !== 200 || !sw.swapRouterCalldata) throw new Error(`Mayan get-swap/evm: HTTP ${status} ${JSON.stringify(sw).slice(0, 200)}`);
        const minMiddle = fractionalToUnits(q.minMiddleAmount!, CCTP_TOKEN_DECIMALS);
        const createOrder = encodeSwiftCreateOrder(USDC_ETHEREUM, minMiddle, order);
        const calldata = encodeCall("swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)", [
          { t: "uint", v: req.amount }, { t: "address", v: sw.swapRouterAddress }, { t: "bytes", v: sw.swapRouterCalldata },
          { t: "address", v: USDC_ETHEREUM }, { t: "uint", v: minMiddle }, { t: "address", v: MAYAN_SWIFT_V2 }, { t: "bytes", v: createOrder },
        ]);
        return { kind: "contract-call", to: MAYAN_FORWARDER, calldata, value: req.amount, expiresAt: quote.expiresAt, minOutEncoded: true, refundTokens: [USDC_ETHEREUM], verified: ["forwarder and Swift V2 pinned; the order built locally", `the ETH → USDC leg is bounded on chain at ${minMiddle} USDC base units`, "an unfilled order refunds USDC to the escrow, re-shielded into the pool's USDC vault"] };
      }
      const createOrder = encodeSwiftCreateOrder(tokenIn, req.amount, order);
      if (wrap) {
        // ETH: the pinned wrapper wraps it 1:1, so the forwarder hands Swift exactly the order's amount (no router calldata from the API)
        const calldata = encodeCall("swapAndForwardEth(uint256,address,bytes,address,uint256,address,bytes)", [
          { t: "uint", v: req.amount }, { t: "address", v: MAYAN_ETH_WRAPPER }, { t: "bytes", v: SEL_WRAP },
          { t: "address", v: WETH_ETHEREUM }, { t: "uint", v: req.amount }, { t: "address", v: MAYAN_SWIFT_V2 }, { t: "bytes", v: createOrder },
        ]);
        return { kind: "contract-call", to: MAYAN_FORWARDER, calldata, value: req.amount, expiresAt: quote.expiresAt, minOutEncoded: true };
      }
      const calldata = encodeCall("forwardERC20(address,uint256,(uint256,uint256,uint8,bytes32,bytes32),address,bytes)", [
        { t: "address", v: tokenIn }, { t: "uint", v: req.amount },
        { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "uint", v: 0 }, { t: "bytes32", v: Buffer.alloc(32) }, { t: "bytes32", v: Buffer.alloc(32) }, // zero permit: the escrow approves instead
        { t: "address", v: MAYAN_SWIFT_V2 }, { t: "bytes", v: createOrder },
      ]);
      return { kind: "contract-call", to: MAYAN_FORWARDER, calldata, value: 0n, expiresAt: quote.expiresAt, minOutEncoded: true };
    }
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
