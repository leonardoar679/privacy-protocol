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
// outputAmount word), so the minimum output is verified in the signed calldata; the facet must never ask
// Across for more than it bridges (the bridged token is the asset delivered, and in its units the
// multiplier is at most one: minAmount, the source swap's floor on chain, then backs the minimum —
// audit 2026-10-16). For MayanFacet the
// receiver is checked (the facet itself matches it against the Mayan order on chain) and so is where
// the facet sweeps money: excess value and any source-swap surplus above `mayanAmountIn` go to
// `refundRecipient`, which must be the escrow, and `mayanAmountIn` must be the bridged amount; the
// minimum sits inside Mayan's opaque order, so `toAmountMin` stays a claim (`minOutVerified: false`
// → filtered under strict policies, spec §9). Any other facet is refused under every policy: its data
// can name recipients and amounts this adapter cannot read.
import { hexBuf, selectorHex } from "../abi";
import { base58Decode } from "./chainflip";
import { boundMiddle, MAYAN_FAST_MCTP, MAYAN_SWIFT_V2, SEL_CREATE_ORDER, SEL_SWIFT_CREATE_ORDER, USDC_ETHEREUM, type LegPrice } from "./mayan";
import { availablePrice } from "@privacy-wallet/protocol/wallet/valuation";
import type { Valuer } from "../valuation";
import { WETH as ACROSS_WETH } from "./across";
import { exclusivityWindow } from "./acrossBounds";
import { covers, escrowCanReshield, foreignRefundTokens, reshieldableAsset, sameAsset } from "../escrowAssets";
import type { AssetRef, Capabilities, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { AdapterRefusal, SINGLE_PLAN, categoryOf, isEvm } from "../types";

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

/**
 * Where an unfilled order of a LI.FI route refunds (the eleventh review round, 2026-11-04, D11-4): an Across deposit and a Swift order inside the
 * Mayan facet refund the escrow, a Fast-MCTP order refunds USDC at the destination — Compare routes says so, and the wallet signs a call that
 * refunds at the destination only where the committed quote said so. Unknown for anything else.
 */
export function lifiRefundTarget(data: string): "escrow" | "destination" | undefined {
  if (isAcrossV4Call(data)) return "escrow";
  if (!isMayanFacetCall(data)) return undefined;
  try {
    const { facetData } = decodeLifiCall(data);
    const protocol = addr(facetData.subarray(32, 64)); // MayanData.mayanProtocol
    return protocol === MAYAN_FAST_MCTP ? "destination" : protocol === MAYAN_SWIFT_V2 ? "escrow" : undefined;
  } catch {
    return undefined;
  }
}
/** AcrossFacetV4.MULTIPLIER_BASE: the swap variant hands Across (swap result) × outputAmountMultiplier / 1e18 as the output. */
export const ACROSS_MULTIPLIER_BASE = 10n ** 18n;
/**
 * Asked of the API (`allowBridges`) so it routes only through facets this adapter can read; the call is still checked by selector. Both
 * at once: when LI.FI's one answer is a Mayan route the adapter refuses — every one naming LI.FI's referrer (the owner's decision,
 * 2026-11-09) — it is not asked again without Mayan, so an Across route LI.FI might have given for the pair is not asked for (stated).
 */
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
export function verifyLifiTransaction(req: QuoteRequest, q: any, leg?: LegPrice): { to: string; calldata: `0x${string}`; value: bigint; verified: string[]; refundTokens: string[]; exclusivitySeconds?: number } {
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
    // exactly the order amount (the third review round, 2026-11-03): a smaller minAmount left the rest in the escrow, below the floors
    if (bd.minAmount !== req.amount) throw new Error("LI.FI calldata: minAmount is not the order amount (a remainder would stay in the escrow)");
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
    // the order inside, as the wallet reads it at signing (the eleventh review round, 2026-11-04, after its critique — D11-3, D11-6 and the
    // verifier's NF-1): a route the wallet refuses for the swap & lock's re-shield, or for its floor through the bridge-only entry, is never offered (its floor after LI.FI's own swap before the facet only the wallet bounds: stated, YC's critique) — under Fastest it had been funded at once, and the escrow waited for its
    // refund time. A swap & lock (MayanData.swapProtocol set) refunds its middle token to the escrow, which must re-shield it, and its swap has a
    // floor; with the service's own agreed ETH price, an ETH → USDC leg and a swap into USDC before the facet are bounded at 98 % of the ETH
    if (addr(M(3)) !== ZERO) {
      const middle = addr(M(5)), minMiddle = u(M(6));
      if (!escrowCanReshield(req.from, middle)) throw new Error(`LI.FI/Mayan calldata: the order swaps into ${middle} and locks it; an unfilled order would refund it to the escrow, which cannot re-shield it (the pool has no vault for it)`);
      if (minMiddle === 0n) throw new Error("LI.FI/Mayan calldata: the swap before the lock has no floor (minMiddleAmount 0)");
      if (leg && req.from.asset === "native" && !bd.hasSourceSwaps && middle === USDC_ETHEREUM) boundMiddle(minMiddle, bd.minAmount, leg, "LI.FI/Mayan");
      verified.push("swap & lock refunds re-shieldable");
    }
    if (leg && bd.hasSourceSwaps && req.from.asset === "native" && bd.sendingAssetId === USDC_ETHEREUM) boundMiddle(bd.minAmount, req.amount, leg, "LI.FI source swap");
    // the order inside locks what the forwarder hands Mayan (the twelfth review round, VZ-2), as the wallet checks at signing: the leg's middle
    // token, or the bridged ERC-20 — LI.FI's MayanFacet checks the order's receiver and, for an ERC-20, its amount, but never its tokenIn, and Swift
    // pulls whatever tokenIn names; its amount too where nothing rewrites it on chain (an ERC-20 bridged alone); ETH only through a leg, a leg only
    // on ETH and only into USDC, as the wallet requires; and it asks for no gas drop and names no referrer, at any rate. A route the wallet would
    // refuse at signing for the order's token, amount, gas drop or referrer is never offered (under Fastest it had been funded first, and the escrow
    // waited for its refund time); the rest of the order — its trader, receiver, chain, asset, fees, deadline, auction mode, payload (type and custom
    // payload) and minimum, and a leg's floor after LI.FI's own swap — only the wallet reads (gap 82's residual)
    {
      const protocol = addr(M(1));
      const off = Number(u(M(2)));
      const pd = d.facetData.subarray(off + 32, off + 32 + Number(u(d.facetData.subarray(off, off + 32))));
      const sel = "0x" + pd.subarray(0, 4).toString("hex");
      const want = protocol === MAYAN_SWIFT_V2 ? SEL_SWIFT_CREATE_ORDER : protocol === MAYAN_FAST_MCTP ? SEL_CREATE_ORDER : null;
      // the whole static part of the order the protocol takes, every word read below among it (createOrderWithToken: two words, OrderParams'
      // fourteen and the custom payload's offset; createOrder: five words and OrderPayload's ten) — a shorter one neither contract decodes, and
      // a word cut inside would read as a smaller value: a referrer fee of 5 bps as 0 (a word cut off throws as it is read)
      const swift = protocol === MAYAN_SWIFT_V2;
      if (!want || sel !== want || pd.length < 4 + 32 * (swift ? 17 : 15)) throw new Error(`LI.FI/Mayan calldata: the order inside (${sel} for ${protocol}) is not one this adapter reads`);
      // the leg as the facet reads it: by its swap protocol alone (YA's critique) — a middle token or floor named without one is ignored on chain
      const legInside = addr(M(3)) !== ZERO;
      if (!legInside && (addr(M(5)) !== ZERO || u(M(6)) !== 0n)) throw new Error("LI.FI/Mayan calldata: a middle token or floor is named for a swap the facet does not run (no swap protocol)");
      // ... and ETH only through the leg: without one the facet forwards it as value, which neither Swift V2's nor Fast-MCTP's entry takes (it reverts)
      if (!legInside && bd.sendingAssetId === ZERO) throw new Error("LI.FI/Mayan calldata: ETH bridged into the order without a leg: the facet would forward it to an entry that takes no value (the call reverts)");
      if (legInside && bd.sendingAssetId !== ZERO) throw new Error(`LI.FI/Mayan calldata: a swap leg inside Mayan on ${bd.sendingAssetId}, a token the facet already bridges`);
      // ... and only into USDC, the one leg the wallet bounds (its mustBoundMiddle: "the ETH → USDC leg is not bounded in USDC"): LI.FI's live ETH →
      // SOL route wraps ETH into WETH as its leg, which the wallet refuses at signing — offered, it had been funded first under Fastest
      if (legInside && addr(M(5)) !== USDC_ETHEREUM) throw new Error(`LI.FI/Mayan calldata: a swap leg inside Mayan into ${addr(M(5))}, not USDC: the wallet bounds only an ETH → USDC leg and refuses any other at signing`);
      const handed = legInside ? addr(M(5)) : bd.sendingAssetId;
      const tokenIn = addr(pd.subarray(4, 36));
      // a Fast-MCTP order burns USDC through CCTP: handed USDC, and funded in it, in the wallet's words (the twelfth review round, YB's critique — any
      // other token reverts, so nothing stays in the forwarder; the Swift wording had said it did, and an earlier refusal had left the first check
      // unreached)
      if (protocol === MAYAN_FAST_MCTP) {
        if (handed !== USDC_ETHEREUM) throw new Error(`LI.FI/Mayan calldata: the facet hands the Fast-MCTP order ${handed}, not USDC`);
        if (tokenIn !== USDC_ETHEREUM) throw new Error("LI.FI/Mayan calldata: the Mayan order is not funded in USDC");
      } else if (tokenIn !== handed)
        throw new Error(`LI.FI/Mayan calldata: the order inside locks ${tokenIn}, not the ${handed} the facet hands Mayan`);
      if (!bd.hasSourceSwaps && bd.sendingAssetId !== ZERO && u(pd.subarray(36, 68)) !== bd.minAmount)
        throw new Error(`LI.FI/Mayan calldata: the order inside orders ${u(pd.subarray(36, 68))}, not the ${bd.minAmount} the facet bridges`);
      verified.push("the order inside locks what the facet hands Mayan");
      // ... and asks for no gas drop and names no referrer — neither its address nor its bps —, as the wallet signs no Mayan order that does: every
      // live LI.FI → Mayan route names LI.FI's own referrer at 0 bps (2026-11-09), which the owner decided stays refused, so those routes are never
      // offered (createOrderWithToken: the gas drop in word 9, the referrer in words 6 and 13; createOrder: in words 9, 13 and 14)
      const W = (i: number) => pd.subarray(4 + i * 32, 36 + i * 32);
      const gasDrop = u(W(9)), referrer = W(swift ? 6 : 13), referrerBps = u(W(swift ? 13 : 14));
      if (gasDrop !== 0n) throw new Error(`LI.FI/Mayan calldata: the order inside asks for a gas drop (${gasDrop}), which the wallet never signs`);
      if (!referrer.every((b) => b === 0))
        throw new Error(`LI.FI/Mayan calldata: the order inside names a referrer (0x${referrer.toString("hex")}) at ${referrerBps} bps, which the wallet never signs, even at 0 bps`);
      if (referrerBps !== 0n) throw new Error(`LI.FI/Mayan calldata: the order inside sets a referrer fee of ${referrerBps} bps, which the wallet never signs`);
      verified.push("the order inside asks for no gas drop and names no referrer");
    }
  }
  let exclusive: number | null = null;
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
    // the exclusive relayer's (word 6) window (word 9, the exclusivity parameter; the twelfth review round, F12-4): on the quote, for the competition
    exclusive = exclusivityWindow(F(6), u(F(9)), Math.floor(Date.now() / 1000));
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
  if (acrossV4) {
    // the facet never asks Across for more than it bridges (audit 2026-10-16): the bridged token must be the asset delivered
    // (sameAsset), and in its units the multiplier is at most one (the swap variant: whatever the swap returns, at
    // least minAmount, the facet asks for no more of it) and outputAmount at most minAmount (the bridge alone). The minimum is then
    // backed by minAmount, the source swap's floor on chain, and a deposit nobody fills refunds the escrow at least it. Otherwise a
    // minAmount of one unit under an inflated multiplier would read as any minimum while the source swap kept the order
    const facetWord = (i: number) => u(d.facetData.subarray(i * 32, i * 32 + 32));
    const asset = reshieldableAsset(req.from, bd.sendingAssetId);
    if (!asset || !sameAsset(asset.symbol, req.to.symbol)) throw new Error(`LI.FI/Across calldata: bridges ${bd.sendingAssetId}${asset ? ` (${asset.symbol})` : " (a token this adapter does not know)"} for ${req.to.symbol}; the floor must be counted in the asset delivered, or an unfilled deposit refunds less than the output is worth`);
    if (bd.hasSourceSwaps && facetWord(5) * 10n ** BigInt(asset.decimals) > ACROSS_MULTIPLIER_BASE * 10n ** BigInt(req.to.decimals)) throw new Error(`LI.FI/Across calldata: outputAmountMultiplier ${facetWord(5)} asks Across for more than the swap bridges (the minimum would not be backed by minAmount, the swap's floor)`);
    if (!bd.hasSourceSwaps && !covers(bd.minAmount, asset.decimals, facetWord(4), req.to.decimals)) throw new Error(`LI.FI/Across calldata: outputAmount ${facetWord(4)} is more than the ${bd.minAmount} bridged`);
    verified.push("bridged amount backs the output");
  }
  return { to: diamond, calldata: tr.data as `0x${string}`, value, verified, refundTokens: bd.hasSourceSwaps ? foreignRefundTokens(req.from, [bd.sendingAssetId]) : [], ...(exclusive !== null ? { exclusivitySeconds: exclusive } : {}) };
}

export class LifiAdapter implements ProviderAdapter {
  readonly id = "lifi" as const;
  readonly implemented = true;
  /** the service's own agreed prices (as Mayan's): an ETH → USDC leg inside the Mayan facet is bounded against them (the eleventh review round) */
  private readonly valuer: Valuer | null;
  constructor(opts: { valuer?: Valuer | null } = {}) {
    this.valuer = opts.valuer ?? null;
  }
  /** the agreed, fresh ETH price for an ETH-source quote; nothing without a valuer (the wallet bounds the leg at signing either way) */
  private async legPrice(req: QuoteRequest): Promise<LegPrice | undefined> {
    if (!this.valuer || req.from.asset !== "native") return undefined;
    const now = Math.floor(Date.now() / 1000);
    const prices = (await this.valuer.prices(now).catch(() => null)) ?? null;
    return { ethUsd1e8: availablePrice(prices, "ETH", now)?.usd1e8 ?? null };
  }

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
    // every check prepareIngress makes, but against the quote's own addresses, which are placeholders until the commit (audit
    // round 2, n08): a quote failing the floors — the bridged token not the one delivered, a minimum the bridged amount does
    // not back — was ranked, chosen and funded, and its execution could not be prepared: the escrow waited for its refund time
    const leg = await this.legPrice(req);
    let checked: ReturnType<typeof verifyLifiTransaction>;
    try {
      checked = verifyLifiTransaction({ ...req, source: String(q.action?.fromAddress ?? ""), destination: String(q.action?.toAddress ?? "") }, q, leg);
    } catch (e) {
      throw new AdapterRefusal(String((e as Error)?.message ?? e)); // its answer to this request, never an outage (the eighth review round, D-M2)
    }
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
      nativeAssets: !bridged, minOutEncoded: true, minOutVerified: isAcrossV4Call(q.transactionRequest?.data ?? ""), plan: SINGLE_PLAN(Number(est.executionDuration ?? 0)),
      refundTarget: lifiRefundTarget(q.transactionRequest?.data ?? ""),
      ...(checked.exclusivitySeconds !== undefined ? { exclusivitySeconds: checked.exclusivitySeconds } : {}),
      hops: [`${q.tool}`, ...hops], raw: q, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    const v = verifyLifiTransaction(req, quote.raw, await this.legPrice(req));
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
    // PARTIAL is another token at the destination (a bridge's alternative token when liquidity is low): its amount is never
    // reported as the output's units (2026-10-17, the audit's unverified m60) — a campaign valued it at the expected rate,
    // settled the step for that and planned the "rest" again
    const otherToken = sub === "PARTIAL";
    return { state, destinationTxHash: data.receiving?.txHash, deliveredAmount: data.receiving?.amount && !otherToken ? BigInt(data.receiving.amount) : undefined, deliveredAsset: data.receiving?.token?.symbol, raw: data };
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
