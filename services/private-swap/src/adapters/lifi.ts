// LI.FI adapter (plan §19): aggregation over bridges/DEXs/solvers via the public quote API. The
// quote's `transactionRequest` is the ingress (contract-call to the LI.FI diamond) and carries the
// slippage-protected `toAmountMin`; status via /v1/status. Used as infrastructure, not as the base.
//
// The API is a convenience, not a trust anchor (spec §5, plan §74 "LI.FI API malicious"): before an
// ingress is returned, the transaction is checked locally — pinned diamond address, chain id, value,
// the quote's from/to addresses, and the `BridgeData` struct every bridge facet takes first
// (receiver, destination chain, no destination call, sending asset / amount). Facets are recognised
// by the SELECTOR the diamond dispatches on, never by the API's `tool` field. For AcrossFacetV4 the
// bridge-specific data is decoded too (receiver, refund address = our escrow, assets, and the output
// the facet will hand Across — in the swap variant that is re-derived ON CHAIN as swap result ×
// outputAmountMultiplier / 1e18, so the guaranteed minimum is minAmount × multiplier, not the
// outputAmount word), so the minimum output is verified in the signed calldata. For MayanFacet the
// receiver is checked (the facet itself matches it against the Mayan order on chain) and so is where
// the facet sweeps money: excess value and any source-swap surplus above `mayanAmountIn` go to
// `refundRecipient`, which must be the escrow, and `mayanAmountIn` must be the bridged amount; the
// minimum sits inside Mayan's opaque order, so `toAmountMin` stays a claim (`minOutVerified: false`
// → filtered under strict policies, spec §9). Any other facet is refused under every policy: its data
// can name recipients and amounts this adapter cannot read.
import { hexBuf, selectorHex } from "../abi";
import { base58Decode } from "./chainflip";
import { WETH as ACROSS_WETH } from "./across";
import { escrowCanReshield, foreignRefundTokens } from "../escrowAssets";
import type { AssetRef, Capabilities, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { categoryOf, isEvm } from "../types";

export const LIFI_URL = process.env.LIFI_URL ?? "https://li.quest/v1";
const CHAIN_ID: Record<string, string> = { ethereum: "1", base: "8453", arbitrum: "42161", bsc: "56", avalanche: "43114", optimism: "10", polygon: "137", solana: "1151111081099710", bitcoin: "20000000000001" };
const NATIVE: Record<string, string> = { solana: "11111111111111111111111111111111", bitcoin: "bitcoin" };
const ZERO = "0x0000000000000000000000000000000000000000";
/** LiFiDiamond (same address on every supported EVM chain; pinned, SDK `getContractAddress`). */
export const LIFI_DIAMOND: Record<string, string> = Object.fromEntries(["ethereum", "base", "arbitrum", "bsc", "avalanche", "optimism", "polygon"].map((c) => [c, "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"]));
/** LI.FI's `NON_EVM_ADDRESS` sentinel: `BridgeData.receiver` for non-EVM destinations; the real receiver is in the facet data. */
export const NON_EVM_RECEIVER = "0x11f111f111f111f111f111f111f111f111f111f1";
// The diamond runs the facet its selector names, so facet data is decoded by selector (lifinance/contracts
// src/Facets/AcrossFacetV4.sol and MayanFacet.sol as deployed, 2026-10).
const BRIDGE_DATA = "(bytes32,string,string,address,address,address,uint256,uint256,bool,bool)";
const SWAP_DATA = "(address,address,address,address,uint256,bytes,bool)[]";
const ACROSS_V4_DATA = "(bytes32,bytes32,bytes32,bytes32,uint256,uint128,bytes32,uint32,uint32,uint32,bytes)";
const MAYAN_DATA = "(bytes32,address,bytes,address,bytes,address,uint256,address,uint256)";
export const SEL_ACROSS_V4 = selectorHex(`startBridgeTokensViaAcrossV4(${BRIDGE_DATA},${ACROSS_V4_DATA})`);
export const SEL_ACROSS_V4_SWAP = selectorHex(`swapAndStartBridgeTokensViaAcrossV4(${BRIDGE_DATA},${SWAP_DATA},${ACROSS_V4_DATA})`);
export const SEL_MAYAN = selectorHex(`startBridgeTokensViaMayan(${BRIDGE_DATA},${MAYAN_DATA})`);
export const SEL_MAYAN_SWAP = selectorHex(`swapAndStartBridgeTokensViaMayan(${BRIDGE_DATA},${SWAP_DATA},${MAYAN_DATA})`);
/** Facet entry points whose data this adapter decodes to confirm the minimum output in the calldata (AcrossFacetV4). */
export const MIN_OUT_VERIFIABLE_SELECTORS = [SEL_ACROSS_V4, SEL_ACROSS_V4_SWAP];
export const isAcrossV4Call = (data: string) => MIN_OUT_VERIFIABLE_SELECTORS.includes(String(data).slice(0, 10).toLowerCase());
export const isMayanFacetCall = (data: string) => [SEL_MAYAN, SEL_MAYAN_SWAP].includes(String(data).slice(0, 10).toLowerCase());
/** AcrossFacetV4.MULTIPLIER_BASE: the swap variant hands Across (swap result) × outputAmountMultiplier / 1e18 as the output. */
export const ACROSS_MULTIPLIER_BASE = 10n ** 18n;
/** Asked of the API (`allowBridges`) so it routes only through facets this adapter can read; the call is still checked by selector. */
export const LIFI_READABLE_BRIDGES = ["across", "mayan"];

export function lifiToken(a: AssetRef): string {
  if (a.asset === "native") return NATIVE[a.chain] ?? ZERO;
  return a.asset;
}

async function lifi<T>(path: string, timeoutMs = 25000): Promise<{ data: T; ms: number }> {
  const t0 = Date.now();
  const r = await fetch(LIFI_URL + path, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", ...(process.env.LIFI_API_KEY ? { "x-lifi-api-key": process.env.LIFI_API_KEY } : {}) } });
  if (!r.ok) throw new Error(`LI.FI HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { data: (await r.json()) as T, ms: Date.now() - t0 };
}

/** `ILiFi.BridgeData` — the first parameter of every `startBridgeTokensVia*` / `swapAndStartBridgeTokensVia*` facet call. */
export interface BridgeData { transactionId: string; bridge: string; integrator: string; referrer: string; sendingAssetId: string; receiver: string; minAmount: bigint; destinationChainId: bigint; hasSourceSwaps: boolean; hasDestinationCall: boolean }
export interface DecodedLifiCall { selector: string; bridgeData: BridgeData; firstSwap?: { sendingAssetId: string; fromAmount: bigint }; facetData: Buffer }

const u = (w: Buffer) => BigInt("0x" + w.toString("hex"));
const addr = (w: Buffer) => "0x" + w.subarray(12).toString("hex");
const str = (data: Buffer, off: number) => { const len = Number(u(data.subarray(off, off + 32))); return data.subarray(off + 32, off + 32 + len).toString("utf8"); };

/** Decode a diamond call's BridgeData (+ the first source swap and the facet-specific tuple) without knowing the facet's exact signature. */
export function decodeLifiCall(calldata: string): DecodedLifiCall {
  const cd = hexBuf(calldata);
  if (cd.length < 4 + 32 * 2) throw new Error("LI.FI calldata too short");
  const selector = "0x" + cd.subarray(0, 4).toString("hex");
  const args = cd.subarray(4);
  const W = (i: number) => args.subarray(i * 32, i * 32 + 32);
  const bdOff = Number(u(W(0)));
  const bd = args.subarray(bdOff);
  const B = (i: number) => bd.subarray(i * 32, i * 32 + 32);
  const bridgeData: BridgeData = {
    transactionId: "0x" + B(0).toString("hex"), bridge: str(bd, Number(u(B(1)))), integrator: str(bd, Number(u(B(2)))), referrer: addr(B(3)), sendingAssetId: addr(B(4)),
    receiver: addr(B(5)), minAmount: u(B(6)), destinationChainId: u(B(7)), hasSourceSwaps: u(B(8)) === 1n, hasDestinationCall: u(B(9)) === 1n,
  };
  if (u(B(8)) > 1n || u(B(9)) > 1n) throw new Error("LI.FI calldata: BridgeData bool words are not 0/1");
  let firstSwap: DecodedLifiCall["firstSwap"];
  let facetIdx = 1;
  if (bridgeData.hasSourceSwaps) {
    facetIdx = 2;
    const arr = args.subarray(Number(u(W(1))));
    const n = Number(u(arr.subarray(0, 32)));
    if (n < 1) throw new Error("LI.FI calldata: hasSourceSwaps but no swaps");
    const el = arr.subarray(32 + Number(u(arr.subarray(32, 64))));
    firstSwap = { sendingAssetId: addr(el.subarray(64, 96)), fromAmount: u(el.subarray(128, 160)) };
  }
  const facetData = args.subarray(Number(u(W(facetIdx))));
  return { selector, bridgeData, firstSwap, facetData };
}

/** Everything checked locally about a LI.FI `transactionRequest` before it may be signed. Throws on the first mismatch; returns the list of verified facts. */
export function verifyLifiTransaction(req: QuoteRequest, q: any): { to: string; calldata: `0x${string}`; value: bigint; verified: string[]; refundTokens: string[] } {
  const tr = q.transactionRequest;
  if (!tr?.to || !tr?.data) throw new Error("LI.FI quote has no transactionRequest");
  if (!req.source) throw new Error("LI.FI: the escrow address (req.source) is required as the sender");
  const verified: string[] = [];
  const diamond = LIFI_DIAMOND[req.from.chain];
  if (!diamond) throw new Error(`LI.FI: no pinned diamond for ${req.from.chain}`);
  if (String(tr.to).toLowerCase() !== diamond) throw new Error(`LI.FI: transaction target ${tr.to} is not the pinned diamond ${diamond}`);
  verified.push("target=diamond");
  if (tr.chainId !== undefined && String(tr.chainId) !== CHAIN_ID[req.from.chain]) throw new Error(`LI.FI: transaction chainId ${tr.chainId} != ${CHAIN_ID[req.from.chain]}`);
  const value = BigInt(tr.value ?? 0);
  const expectValue = req.from.asset === "native" ? req.amount : 0n;
  if (value !== expectValue) throw new Error(`LI.FI: transaction value ${value} != ${expectValue}`);
  verified.push("value");
  const a = q.action ?? {};
  if (String(a.fromAddress ?? "").toLowerCase() !== req.source.toLowerCase()) throw new Error("LI.FI: quote fromAddress is not the escrow");
  const sameDest = (x: string) => (isEvm(req.to.chain) ? String(x).toLowerCase() === req.destination.toLowerCase() : String(x) === req.destination);
  if (!sameDest(a.toAddress ?? "")) throw new Error("LI.FI: quote toAddress is not the fresh destination");
  if (String(a.fromChainId) !== CHAIN_ID[req.from.chain] || String(a.toChainId) !== CHAIN_ID[req.to.chain]) throw new Error("LI.FI: quote chain ids differ from the request");
  verified.push("quote from/to");
  const d = decodeLifiCall(tr.data);
  const bd = d.bridgeData;
  const acrossV4 = isAcrossV4Call(tr.data), mayan = isMayanFacetCall(tr.data);
  if (!acrossV4 && !mayan) throw new Error(`LI.FI: the route runs facet ${String(tr.data).slice(0, 10)} (${q.tool}), which this adapter cannot read: where it refunds and how much it bridges cannot be checked`);
  if (bd.destinationChainId !== BigInt(CHAIN_ID[req.to.chain])) throw new Error(`LI.FI calldata: destinationChainId ${bd.destinationChainId} != ${CHAIN_ID[req.to.chain]}`);
  if (bd.hasDestinationCall) throw new Error("LI.FI calldata: routes with a destination call are not accepted (the bridge receiver would not be the fresh address)");
  const ourAsset = req.from.asset === "native" ? ZERO : req.from.asset.toLowerCase();
  if (d.firstSwap) {
    if (d.firstSwap.sendingAssetId !== ourAsset) throw new Error(`LI.FI calldata: first swap spends ${d.firstSwap.sendingAssetId}, not ${ourAsset}`);
    if (d.firstSwap.fromAmount !== req.amount) throw new Error(`LI.FI calldata: first swap amount ${d.firstSwap.fromAmount} != ${req.amount}`);
  } else {
    if (bd.sendingAssetId !== ourAsset) throw new Error(`LI.FI calldata: sendingAssetId ${bd.sendingAssetId} != ${ourAsset}`);
    if (bd.minAmount > req.amount) throw new Error("LI.FI calldata: minAmount exceeds the order amount");
  }
  if (bd.minAmount === 0n) throw new Error("LI.FI calldata: minAmount is zero");
  verified.push("destination chain", "no destination call", "spent asset/amount");
  if (isEvm(req.to.chain)) {
    if (bd.receiver !== req.destination.toLowerCase()) throw new Error(`LI.FI calldata: receiver ${bd.receiver} is not the fresh destination`);
    verified.push("receiver");
  } else {
    if (bd.receiver !== NON_EVM_RECEIVER) throw new Error("LI.FI calldata: non-EVM destination but BridgeData.receiver is not the NON_EVM sentinel");
    if (mayan) {
      // MayanData.nonEVMReceiver is the first word of the facet data (the facet checks it against the order's destAddr on chain)
      const want = req.to.chain === "solana" ? base58Decode(req.destination) : null;
      if (!want || want.length !== 32) throw new Error(`LI.FI/Mayan: cannot encode a ${req.to.chain} destination for verification`);
      if (!d.facetData.subarray(0, 32).equals(want)) throw new Error("LI.FI/Mayan calldata: nonEVMReceiver is not the fresh destination");
      verified.push("receiver (mayan nonEVMReceiver)");
    } else {
      throw new Error(`LI.FI: non-EVM receiver inside the ${q.tool} facet data (selector ${String(tr.data).slice(0, 10)}) cannot be verified by this adapter`);
    }
  }
  if (mayan) {
    // MayanData { nonEVMReceiver, mayanProtocol, protocolData, swapProtocol, swapData, middleToken, minMiddleAmount, refundRecipient, mayanAmountIn }:
    // the facet sends excess native value, and in the swap variant every unit above mayanAmountIn, to refundRecipient
    const M = (i: number) => d.facetData.subarray(i * 32, i * 32 + 32);
    if (addr(M(7)) !== req.source.toLowerCase()) throw new Error(`LI.FI/Mayan calldata: refundRecipient ${addr(M(7))} is not the escrow (the facet sweeps excess value and swap surplus there)`);
    if (bd.hasSourceSwaps && u(M(8)) !== bd.minAmount) throw new Error(`LI.FI/Mayan calldata: mayanAmountIn ${u(M(8))} is not the bridged amount ${bd.minAmount} (the facet hands Mayan only mayanAmountIn and sweeps the rest to refundRecipient)`);
    verified.push("refund recipient=escrow", "bridged amount");
  }
  if (acrossV4) {
    // AcrossV4Data { receiverAddress, refundAddress, sendingAssetId, receivingAssetId (bytes32 each), outputAmount, outputAmountMultiplier, exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityParameter, message }
    const F = (i: number) => d.facetData.subarray(i * 32, i * 32 + 32);
    const asAddress = (w: Buffer) => (w.subarray(0, 12).every((b) => b === 0) ? addr(w) : "0x" + w.toString("hex")); // a bytes32 that is not a left-padded address never equals one
    if (asAddress(F(0)) !== req.destination.toLowerCase()) throw new Error("LI.FI/Across calldata: receiverAddress is not the fresh destination");
    if (asAddress(F(1)) !== req.source.toLowerCase()) throw new Error("LI.FI/Across calldata: refundAddress is not the escrow");
    // an ERC-20 bridged token (our source, or what a source swap produced) is handed to the SpokePool as acrossData.sendingAssetId
    if (bd.sendingAssetId !== ZERO && asAddress(F(2)) !== bd.sendingAssetId) throw new Error(`LI.FI/Across calldata: sendingAssetId ${asAddress(F(2))} is not the bridged token ${bd.sendingAssetId}`);
    const wantReceiving = req.to.asset === "native" ? ACROSS_WETH[req.to.chain] : req.to.asset;
    if (!wantReceiving || asAddress(F(3)) !== wantReceiving.toLowerCase()) throw new Error(`LI.FI/Across calldata: receivingAssetId ${asAddress(F(3))} is not the destination asset`);
    const outputAmount = u(F(4)), multiplier = u(F(5));
    const claimed = BigInt(q.estimate?.toAmountMin ?? -1);
    if (bd.hasSourceSwaps) {
      // swapAndStartBridgeTokensViaAcrossV4 overwrites outputAmount on chain with (swap result, >= minAmount) × outputAmountMultiplier / 1e18
      // and, by LI.FI's own note, checks it no further: the minimum this call guarantees is minAmount × multiplier, whatever the word says
      const floor = (bd.minAmount * multiplier) / ACROSS_MULTIPLIER_BASE;
      if (floor < claimed) throw new Error(`LI.FI/Across calldata: minAmount × outputAmountMultiplier / 1e18 = ${floor} is below the quoted minimum ${claimed} (the swap variant re-derives the output from the multiplier on chain)`);
      if (outputAmount !== floor) throw new Error("LI.FI/Across calldata: outputAmount differs from minAmount × outputAmountMultiplier / 1e18");
    } else if (outputAmount < claimed) {
      throw new Error(`LI.FI/Across calldata: outputAmount ${outputAmount} is below the quoted minimum ${claimed}`);
    }
    verified.push("refund=escrow", "receiving asset", "min-out");
  }
  // what comes back to the escrow is the bridged token: an unfilled Across deposit refunds it, the Mayan facet
  // sweeps the swap surplus in it. A source swap into a token the escrow cannot re-shield would strand it (PP-S08)
  if (bd.hasSourceSwaps && !escrowCanReshield(req.from, bd.sendingAssetId)) throw new Error(`LI.FI: the route swaps ${req.from.symbol} into ${bd.sendingAssetId} before bridging; an unfilled deposit or the swap surplus would come back to the escrow in that token, which the escrow cannot re-shield (the pool has no vault for it)`);
  verified.push("refunds re-shieldable");
  return { to: diamond, calldata: tr.data as `0x${string}`, value, verified, refundTokens: bd.hasSourceSwaps ? foreignRefundTokens(req.from, [bd.sendingAssetId]) : [] };
}

export class LifiAdapter implements ProviderAdapter {
  readonly id = "lifi" as const;
  readonly implemented = true;

  capabilities(): Capabilities {
    return { routes: ["B", "C", "D", "E"], ingress: ["contract-call"], nativeAssets: false, atomic: false, chains: ["ethereum", "base", "arbitrum", "bsc", "avalanche", "optimism", "polygon", "solana", "bitcoin"], destinationLinkPublic: true, linkEvidence: "the bridge call carries the receiver (bridgeData.receiver, decoded locally before signing)" };
  }

  /** LI.FI's quote as it answered, unchecked: what quote() ranks and prepareIngress verifies. */
  async rawQuote(req: QuoteRequest): Promise<any> {
    const fromChain = CHAIN_ID[req.from.chain], toChain = CHAIN_ID[req.to.chain];
    if (!fromChain || !toChain) throw new Error(`LI.FI does not support ${req.from.chain} -> ${req.to.chain}`);
    // fromAddress = the one-time escrow (the diamond's msg.sender); the SDK needs an address to quote
    const fromAddress = req.source ?? "0x000000000000000000000000000000000000dEaD";
    const qs = new URLSearchParams({ fromChain, toChain, fromToken: lifiToken(req.from), toToken: lifiToken(req.to), fromAmount: req.amount.toString(), fromAddress, toAddress: req.destination, slippage: (req.slippageBps / 10000).toString(), allowBridges: LIFI_READABLE_BRIDGES.join(",") });
    return (await lifi<any>(`/quote?${qs}`)).data;
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const q = await this.rawQuote(req);
    const call = String(q.transactionRequest?.data ?? "");
    if (!isAcrossV4Call(call) && !isMayanFacetCall(call)) throw new Error(`LI.FI routed via ${q.tool} (facet ${call.slice(0, 10)}), which this adapter cannot verify: not offered`);
    // ranked only if what can come back to the escrow re-shields (PP-S08; prepareIngress checks it again with the rest)
    const bd = decodeLifiCall(call).bridgeData;
    if (bd.hasSourceSwaps && !escrowCanReshield(req.from, bd.sendingAssetId)) throw new Error(`LI.FI routed ${req.from.symbol} through a swap into ${bd.sendingAssetId} before bridging (${q.tool}): an unfilled deposit or the swap surplus would come back to the escrow in that token, which it cannot re-shield (the pool has no vault for it): not offered`);
    const est = q.estimate;
    const toAmount = BigInt(est.toAmount), toAmountMin = BigInt(est.toAmountMin);
    // the claimed minimum must be consistent with the slippage we asked for (a lowered min-out is a changed quote)
    if (toAmountMin * 10000n < toAmount * BigInt(10000 - req.slippageBps - 50)) throw new Error(`LI.FI: toAmountMin ${toAmountMin} is more than ${req.slippageBps + 50} bps below toAmount ${toAmount}`);
    if (toAmountMin > toAmount) throw new Error("LI.FI: toAmountMin exceeds toAmount");
    const fees = [
      ...(est.feeCosts ?? []).map((f: any) => ({ kind: f.name?.toLowerCase().includes("gas") ? "gas" : "protocol", amount: BigInt(f.amount ?? 0), asset: f.token?.symbol ?? "?", usd: Number(f.amountUSD ?? 0) })),
      ...(est.gasCosts ?? []).map((g: any) => ({ kind: "gas" as const, amount: BigInt(g.amount ?? 0), asset: g.token?.symbol ?? "?", usd: Number(g.amountUSD ?? 0) })),
    ];
    const hops = (q.includedSteps ?? []).map((s: any) => `${s.tool}: ${s.action?.fromToken?.symbol} -> ${s.action?.toToken?.symbol}`);
    const bridged = (q.includedSteps ?? []).some((s: any) => s.type === "cross" || s.tool?.toLowerCase().includes("bridge"));
    return {
      provider: "lifi", category: categoryOf(req.from, req.to),
      toAmount, toAmountMin, fees,
      etaSeconds: Number(est.executionDuration ?? 0), expiresAt: Math.floor(Date.now() / 1000) + 60, // LI.FI quotes are short-lived; re-quote at commit
      nativeAssets: !bridged, minOutEncoded: true, minOutVerified: isAcrossV4Call(q.transactionRequest?.data ?? ""),
      refundTarget: isAcrossV4Call(q.transactionRequest?.data ?? "") ? "escrow" : undefined,
      hops: [`${q.tool}`, ...hops], raw: q, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    const v = verifyLifiTransaction(req, quote.raw);
    return { kind: "contract-call", to: v.to, calldata: v.calldata, value: v.value, expiresAt: quote.expiresAt, minOutEncoded: true, verified: v.verified, ...(v.refundTokens.length ? { refundTokens: v.refundTokens } : {}) };
  }

  async track(ref: { sourceTxHash?: string }): Promise<TrackStatus> {
    if (!ref.sourceTxHash) return { state: "unknown" };
    const { data } = await lifi<any>(`/status?txHash=${ref.sourceTxHash}`);
    const sub = String(data.substatus ?? "");
    const state: TrackStatus["state"] =
      data.status === "DONE" ? (sub === "PARTIAL" ? "partial" : sub === "REFUNDED" ? "refunded" : "completed")
      : data.status === "FAILED" ? "failed"
      : data.status === "PENDING" ? (data.receiving?.txHash ? "destination-submitted" : "executing")
      : data.status === "NOT_FOUND" ? "pending" : "unknown";
    return { state, destinationTxHash: data.receiving?.txHash, deliveredAmount: data.receiving?.amount ? BigInt(data.receiving.amount) : undefined, deliveredAsset: data.receiving?.token?.symbol, raw: data };
  }

  async health(): Promise<Health> {
    const t0 = Date.now();
    try {
      const { data, ms } = await lifi<any>("/chains");
      return { provider: "lifi", reachable: Array.isArray(data.chains) && data.chains.length > 0, apiLatencyMs: ms, halted: false, haltedChains: [], checkedAt: Date.now() };
    } catch (e) {
      return { provider: "lifi", reachable: false, apiLatencyMs: Date.now() - t0, halted: true, haltedChains: [], checkedAt: Date.now(), note: String(e) };
    }
  }
}
