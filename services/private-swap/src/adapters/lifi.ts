// LI.FI adapter (plan §19): aggregation over bridges/DEXs/solvers via the public quote API. The
// quote's `transactionRequest` is the ingress (contract-call to the LI.FI diamond) and carries the
// slippage-protected `toAmountMin`; status via /v1/status. Used as infrastructure, not as the base.
//
// The API is a convenience, not a trust anchor (spec §5, plan §74 "LI.FI API malicious"): before an
// ingress is returned, the transaction is checked locally — pinned diamond address, chain id, value,
// the quote's from/to addresses, and the `BridgeData` struct every bridge facet takes first
// (receiver, destination chain, no destination call, sending asset / amount). For the Across facet
// the bridge-specific data is decoded too (receiver, refund address = our escrow, exact output
// amount), so the minimum output is verified in the signed calldata; for other facets the API's
// `toAmountMin` is a claim and the quote says so (`minOutVerified: false` → filtered under strict
// policies, spec §9).
import { hexBuf } from "../abi";
import { base58Decode } from "./chainflip";
import { WETH as ACROSS_WETH } from "./across";
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
/** Facets whose bridge-specific data this adapter decodes to confirm the minimum output in the calldata. */
export const MIN_OUT_VERIFIABLE_TOOLS = ["across"];

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
export function verifyLifiTransaction(req: QuoteRequest, q: any): { to: string; calldata: `0x${string}`; value: bigint; verified: string[] } {
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
    if (q.tool === "mayan") {
      // MayanData.nonEVMReceiver is the first word of the facet data
      const want = req.to.chain === "solana" ? base58Decode(req.destination) : null;
      if (!want || want.length !== 32) throw new Error(`LI.FI/Mayan: cannot encode a ${req.to.chain} destination for verification`);
      if (!d.facetData.subarray(0, 32).equals(want)) throw new Error("LI.FI/Mayan calldata: nonEVMReceiver is not the fresh destination");
      verified.push("receiver (mayan nonEVMReceiver)");
    } else {
      throw new Error(`LI.FI: non-EVM receiver inside the ${q.tool} facet data cannot be verified by this adapter`);
    }
  }
  if (q.tool === "across") {
    // AcrossV3Data { receiverAddress, refundAddress, sendingAssetId, receivingAssetId, outputAmount, ... } (live layout, 2026-10)
    const F = (i: number) => d.facetData.subarray(i * 32, i * 32 + 32);
    if (addr(F(0)) !== req.destination.toLowerCase()) throw new Error("LI.FI/Across calldata: receiverAddress is not the fresh destination");
    if (addr(F(1)) !== req.source.toLowerCase()) throw new Error("LI.FI/Across calldata: refundAddress is not the escrow");
    const wantReceiving = req.to.asset === "native" ? ACROSS_WETH[req.to.chain] : req.to.asset;
    if (!wantReceiving || addr(F(3)) !== wantReceiving.toLowerCase()) throw new Error(`LI.FI/Across calldata: receivingAssetId ${addr(F(3))} is not the destination asset`);
    if (u(F(4)) !== BigInt(q.estimate?.toAmountMin ?? -1)) throw new Error("LI.FI/Across calldata: outputAmount differs from the quoted minimum");
    verified.push("refund=escrow", "receiving asset", "min-out");
  }
  return { to: diamond, calldata: tr.data as `0x${string}`, value, verified };
}

export class LifiAdapter implements ProviderAdapter {
  readonly id = "lifi" as const;
  readonly implemented = true;

  capabilities(): Capabilities {
    return { routes: ["B", "C", "D", "E"], ingress: ["contract-call"], nativeAssets: false, atomic: false, chains: ["ethereum", "base", "arbitrum", "bsc", "avalanche", "optimism", "polygon", "solana", "bitcoin"] };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const fromChain = CHAIN_ID[req.from.chain], toChain = CHAIN_ID[req.to.chain];
    if (!fromChain || !toChain) throw new Error(`LI.FI does not support ${req.from.chain} -> ${req.to.chain}`);
    // fromAddress = the one-time escrow (the diamond's msg.sender); the SDK needs an address to quote
    const fromAddress = req.source ?? "0x000000000000000000000000000000000000dEaD";
    const qs = new URLSearchParams({ fromChain, toChain, fromToken: lifiToken(req.from), toToken: lifiToken(req.to), fromAmount: req.amount.toString(), fromAddress, toAddress: req.destination, slippage: (req.slippageBps / 10000).toString() });
    const { data: q } = await lifi<any>(`/quote?${qs}`);
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
      nativeAssets: !bridged, minOutEncoded: true, minOutVerified: MIN_OUT_VERIFIABLE_TOOLS.includes(String(q.tool)),
      refundTarget: q.tool === "across" ? "escrow" : undefined,
      hops: [`${q.tool}`, ...hops], raw: q, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    const v = verifyLifiTransaction(req, quote.raw);
    return { kind: "contract-call", to: v.to, calldata: v.calldata, value: v.value, expiresAt: quote.expiresAt, minOutEncoded: true, verified: v.verified };
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
