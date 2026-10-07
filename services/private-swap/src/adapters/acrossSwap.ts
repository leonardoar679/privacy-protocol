// The Uniswap leg of plan step 12 ("Uniswap-Across"): an asset change on the origin chain, then the
// Across bridge, in one call. Across's Swap API (`/swap/approval`) quotes it and returns a transaction to
// its SpokePoolPeriphery (verified source, Sourcify exact match), `swapAndBridge(SwapAndDepositData)`:
// the periphery wraps the ETH, has a separate SwapProxy call the exchange (Uniswap, or an aggregator the
// API picks) with exactly `swapTokenAmount`, takes back only the Across input token, reverts below
// `minExpectedInputTokenAmount`, and deposits the result into the SpokePool with the deposit data given.
// Nothing in that data is checked on chain against anything we asked for, and the periphery accepts ANY
// `spokePool` (it approves it for the swapped tokens), so every field the order key would sign is
// decoded here and compared: the pinned periphery and SpokePool, the spent token and amount, the escrow
// as depositor (an unfilled deposit is refunded to it, in the swapped token), the destination asset and
// chain, no submission fee, nonce zero. The guaranteed output is `depositData.outputAmount`: proportional
// adjustment only raises it. The exchange and its calldata stay opaque; what they can do is bounded by
// those checks (a swap that yields less than the minimum reverts the whole call; the escrow keeps the order).
// The API pays the fill to Across's MulticallHandler with a message (verified source, the same address
// on Optimism, Base and Arbitrum): the handler runs the calls and, by its own comment, anything a message
// leaves in it "can be stolen". So the message is read too: only `drainLeftoverTokens(outputToken, fresh
// address)` on the pinned handler and `emitData` on the pinned AcrossEventEmitter (an event), no value,
// a fallback recipient that is the fresh address or none (a failing call then reverts the fill, and the
// unfilled deposit is refunded to the escrow); something must drain the output token to the fresh address.
import { hexBuf } from "../abi";
import { escrowCanReshield, foreignRefundTokens } from "../escrowAssets";
import { categoryOf, type Fee, type Ingress, type Quote, type QuoteRequest } from "../types";

/** SpokePoolPeriphery on Ethereum (Across, `contracts/periphery/SpokePoolPeriphery.sol`, Sourcify exact match). */
export const ACROSS_PERIPHERY: Record<string, string> = { ethereum: "0x97ccdbea4632140639ad5ea9b944aa034eb15fd4" };
/** swapAndBridge(((uint256,address),(address,bytes32,uint256,address,bytes32,uint256,bytes32,uint32,uint32,uint32,bytes),address,address,uint8,uint256,uint256,bytes,bool,address,uint256)) */
export const SEL_SWAP_AND_BRIDGE = "0x110560ad";
/** Across MulticallHandler and AcrossEventEmitter (Sourcify exact match on each chain, the same addresses). */
const HANDLER = "0x0f7ae28de1c8532170ad4ee566b5801485c13a0e", EMITTER = "0xbf75133b48b0a42ab9374027902e83c5e2949034";
export const ACROSS_MULTICALL_HANDLER: Record<string, string> = { optimism: HANDLER, base: HANDLER, arbitrum: HANDLER };
export const ACROSS_EVENT_EMITTER: Record<string, string> = { optimism: EMITTER, base: EMITTER, arbitrum: EMITTER };
export const SEL_DRAIN_LEFTOVER = "0xef8738d3"; // drainLeftoverTokens(address,address)
export const SEL_EMIT_DATA = "0xd836083e"; // emitData(bytes)

export interface SwapAndBridge {
  submissionFee: bigint; submissionFeeRecipient: string;
  depositData: { inputToken: string; outputToken: Buffer; outputAmount: bigint; depositor: string; recipient: Buffer; destinationChainId: bigint; exclusiveRelayer: Buffer; quoteTimestamp: number; fillDeadline: number; exclusivityParameter: number; message: Buffer };
  swapToken: string; exchange: string; transferType: number; swapTokenAmount: bigint; minExpectedInputTokenAmount: bigint; routerCalldata: Buffer; proportional: boolean; spokePool: string; nonce: bigint;
}

// ABI reading with every offset bounds-checked
const word = (b: Buffer, i: number) => { if ((i + 1) * 32 > b.length) throw new Error("Across calldata: truncated"); return b.subarray(i * 32, i * 32 + 32); };
const u = (w: Buffer) => BigInt("0x" + w.toString("hex"));
const addr = (w: Buffer) => { if (!w.subarray(0, 12).every((x) => x === 0)) throw new Error("Across calldata: an address word with high bits set"); return "0x" + w.subarray(12).toString("hex"); };
const at = (b: Buffer, off: bigint) => { if (off >= BigInt(b.length)) throw new Error("Across calldata: offset out of range"); return b.subarray(Number(off)); };
const bytes = (b: Buffer, off: bigint) => { const s = at(b, off); const n = Number(u(word(s, 0))); if (32 + n > s.length) throw new Error("Across calldata: bytes out of range"); return s.subarray(32, 32 + n); };
const small = (w: Buffer, bits: number) => { const v = u(w); if (v >= 1n << BigInt(bits)) throw new Error("Across calldata: a narrow integer out of range"); return Number(v); };

/** Decode swapAndBridge calldata (one dynamic tuple holding a static Fees tuple, a dynamic BaseDepositData tuple and the router bytes). */
export function decodeSwapAndBridge(calldata: string): SwapAndBridge {
  const d = hexBuf(calldata);
  if ("0x" + d.subarray(0, 4).toString("hex") !== SEL_SWAP_AND_BRIDGE) throw new Error(`not swapAndBridge (selector 0x${d.subarray(0, 4).toString("hex")})`);
  const args = d.subarray(4);
  const t = at(args, u(word(args, 0)));
  const dd = at(t, u(word(t, 2)));
  return {
    submissionFee: u(word(t, 0)), submissionFeeRecipient: addr(word(t, 1)),
    depositData: {
      inputToken: addr(word(dd, 0)), outputToken: word(dd, 1), outputAmount: u(word(dd, 2)), depositor: addr(word(dd, 3)), recipient: word(dd, 4),
      destinationChainId: u(word(dd, 5)), exclusiveRelayer: word(dd, 6), quoteTimestamp: small(word(dd, 7), 32), fillDeadline: small(word(dd, 8), 32), exclusivityParameter: small(word(dd, 9), 32),
      message: bytes(dd, u(word(dd, 10))),
    },
    swapToken: addr(word(t, 3)), exchange: addr(word(t, 4)), transferType: small(word(t, 5), 8), swapTokenAmount: u(word(t, 6)), minExpectedInputTokenAmount: u(word(t, 7)),
    routerCalldata: bytes(t, u(word(t, 8))), proportional: small(word(t, 9), 1) === 1, spokePool: addr(word(t, 10)), nonce: u(word(t, 11)),
  };
}

/** The MulticallHandler message: abi.encode(Instructions { Call[] calls; address fallbackRecipient }), Call { target, callData, value }. */
export function decodeHandlerMessage(message: Buffer): { calls: { target: string; callData: Buffer; value: bigint }[]; fallbackRecipient: string } {
  const ins = at(message, u(word(message, 0)));
  const arr = at(ins, u(word(ins, 0)));
  const n = Number(u(word(arr, 0)));
  if (n > 16) throw new Error("Across message: too many calls");
  const elems = arr.subarray(32);
  const calls = Array.from({ length: n }, (_, i) => {
    const c = at(elems, u(word(elems, i)));
    return { target: addr(word(c, 0)), callData: bytes(c, u(word(c, 1))), value: u(word(c, 2)) };
  });
  return { calls, fallbackRecipient: addr(word(ins, 1)) };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const b32 = (a: string) => Buffer.concat([Buffer.alloc(12), hexBuf(a)]);

/**
 * Check a swapAndBridge call against the request: what the order key would sign. Returns the guaranteed
 * output (depositData.outputAmount) and the token an unfilled deposit is refunded in, when that is not
 * the order's asset (the executor re-shields it through the escrow's refundToken).
 */
export function verifyAcrossSwapCall(
  req: QuoteRequest,
  tx: { to: string; data: string; value: string | bigint; chainId?: number | string },
  pins: { periphery: string; spokePool: string; weth: string; chainId: Record<string, number>; outputToken: string; handler?: string; emitter?: string },
  /** at quote time the escrow may not be known yet; prepareIngress always checks the depositor */
  opts: { requireDepositor?: boolean } = { requireDepositor: true },
): { minOut: bigint; refundTokens: string[]; verified: string[]; call: SwapAndBridge } {
  if (opts.requireDepositor !== false && !req.source) throw new Error("Across swap: the escrow address (req.source) is required as the depositor (refund target)");
  if (String(tx.to).toLowerCase() !== pins.periphery) throw new Error(`Across swap: transaction target ${tx.to} is not the pinned SpokePoolPeriphery`);
  if (tx.chainId !== undefined && Number(tx.chainId) !== pins.chainId[req.from.chain]) throw new Error(`Across swap: transaction chainId ${tx.chainId} is not ${req.from.chain}`);
  const c = decodeSwapAndBridge(tx.data);
  const verified = ["target=periphery"];
  const native = req.from.asset === "native";
  const value = BigInt(tx.value);
  if (value !== (native ? req.amount : 0n)) throw new Error(`Across swap: transaction value ${value} != ${native ? req.amount : 0n}`);
  if (c.swapToken !== (native ? pins.weth : req.from.asset.toLowerCase())) throw new Error(`Across swap: swaps ${c.swapToken}, not ${req.from.symbol}`);
  if (c.swapTokenAmount !== req.amount) throw new Error(`Across swap: swaps ${c.swapTokenAmount}, not the order's ${req.amount}`);
  verified.push("value", "spent asset/amount");
  if (c.spokePool !== pins.spokePool) throw new Error(`Across swap: deposits into ${c.spokePool}, not the pinned SpokePool (the periphery would approve it for the swapped tokens)`);
  if (req.source && c.depositData.depositor !== req.source.toLowerCase()) throw new Error("Across swap: the depositor is not the escrow (an unfilled deposit is refunded to the depositor)");
  if (c.depositData.destinationChainId !== BigInt(pins.chainId[req.to.chain] ?? -1)) throw new Error(`Across swap: destinationChainId ${c.depositData.destinationChainId} is not ${req.to.chain}`);
  if (!c.depositData.outputToken.equals(b32(pins.outputToken))) throw new Error("Across swap: the output token is not the destination asset");
  const dest = req.destination.toLowerCase(), output = pins.outputToken.toLowerCase();
  if (c.depositData.message.length === 0) {
    if (!c.depositData.recipient.equals(b32(dest))) throw new Error("Across swap: the recipient is not the fresh destination");
    verified.push("receiver");
  } else {
    // the fill goes to the pinned MulticallHandler, whose message must hand the output token to the fresh address
    if (!pins.handler || !c.depositData.recipient.equals(b32(pins.handler))) throw new Error("Across swap: the deposit pays neither the fresh destination nor the pinned MulticallHandler");
    const m = decodeHandlerMessage(c.depositData.message);
    if (m.fallbackRecipient !== ZERO && m.fallbackRecipient !== dest) throw new Error("Across swap: the handler's fallback recipient is not the fresh destination");
    let drained = m.fallbackRecipient === dest; // a fallback recipient also receives whatever the calls leave
    for (const call of m.calls) {
      if (call.value !== 0n) throw new Error("Across swap: a destination call forwards value");
      const sel = "0x" + call.callData.subarray(0, 4).toString("hex");
      if (call.target === pins.handler && sel === SEL_DRAIN_LEFTOVER) {
        const a = call.callData.subarray(4);
        if (a.length !== 64 || addr(word(a, 0)) !== output || addr(word(a, 1)) !== dest) throw new Error("Across swap: the handler would drain another token, or to another address than the fresh destination");
        drained = true;
      } else if (!(pins.emitter && call.target === pins.emitter && sel === SEL_EMIT_DATA)) {
        throw new Error(`Across swap: the destination message calls ${call.target} (${sel}), which this adapter does not accept`);
      }
    }
    if (!drained) throw new Error("Across swap: nothing hands the output token to the fresh destination (the handler would keep it)");
    verified.push("receiver (pinned handler drains to it)");
  }
  if (c.submissionFee !== 0n) throw new Error("Across swap: a submission fee is set");
  if (c.nonce !== 0n) throw new Error("Across swap: a non-zero nonce (only the signed-deposit flows use one)");
  if (c.minExpectedInputTokenAmount === 0n || c.depositData.outputAmount === 0n) throw new Error("Across swap: a zero minimum");
  verified.push("spokePool pinned", ...(req.source ? ["depositor=escrow"] : []), "destination chain", "receiving asset", "no fees", "min-out");
  // an unfilled deposit is refunded to the escrow in the swapped token: it must re-shield (PP-S08)
  const bridged = c.depositData.inputToken;
  if (bridged === ZERO || !escrowCanReshield(req.from, bridged)) throw new Error(`Across swap: swaps ${req.from.symbol} into ${bridged} before bridging; an unfilled deposit would come back to the escrow in that token, which it cannot re-shield (the pool has no vault for it)`);
  verified.push("refunds re-shieldable");
  return { minOut: c.depositData.outputAmount, refundTokens: foreignRefundTokens(req.from, [bridged]), verified, call: c };
}

const DEAD = "0x000000000000000000000000000000000000dEaD";

/** The pins for a request: the origin chain's periphery, SpokePool and WETH; the destination's handler and emitter. */
export function acrossSwapPins(req: QuoteRequest, base: { spokePool: Record<string, string>; weth: Record<string, string>; chainId: Record<string, number> }) {
  const periphery = ACROSS_PERIPHERY[req.from.chain], spokePool = base.spokePool[req.from.chain], weth = base.weth[req.from.chain];
  if (!periphery || !spokePool || !weth) throw new Error(`Across swap: no pinned periphery / SpokePool on ${req.from.chain}`);
  if (base.chainId[req.to.chain] === undefined) throw new Error(`Across swap: ${req.to.chain} is not a destination this adapter knows`);
  if (req.to.asset === "native") throw new Error("Across swap: a native destination asset needs an unwrap on the destination chain this adapter does not read; not offered");
  return { periphery, spokePool: spokePool.toLowerCase(), weth: weth.toLowerCase(), chainId: base.chainId, outputToken: req.to.asset.toLowerCase(), handler: ACROSS_MULTICALL_HANDLER[req.to.chain], emitter: ACROSS_EVENT_EMITTER[req.to.chain] };
}

/** Across's Swap API: an origin-chain swap, then the bridge, as one swapAndBridge call; checked before it is ranked. */
export async function acrossSwapQuote(req: QuoteRequest, api: string, base: { spokePool: Record<string, string>; weth: Record<string, string>; chainId: Record<string, number> }): Promise<Quote> {
  const pins = acrossSwapPins(req, base);
  const qs = new URLSearchParams({
    tradeType: "exactInput", amount: req.amount.toString(), inputToken: req.from.asset === "native" ? ZERO : req.from.asset, originChainId: String(base.chainId[req.from.chain]),
    outputToken: req.to.asset, destinationChainId: String(base.chainId[req.to.chain]), depositor: req.source ?? DEAD, recipient: req.destination, slippage: (req.slippageBps / 10000).toString(),
  });
  const r = await fetch(`${api}/swap/approval?${qs}`, { signal: AbortSignal.timeout(25000), headers: { accept: "application/json" } });
  const text = await r.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (r.status !== 200 || !data?.swapTx) throw new Error(`Across swap/approval: HTTP ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
  if (data.crossSwapType !== "anyToBridgeable") throw new Error(`Across swap: a ${data.crossSwapType} route (only a swap on the origin chain, then the bridge, is offered)`);
  const v = verifyAcrossSwapCall(req, data.swapTx, pins, { requireDepositor: false });
  const toAmount = BigInt(data.expectedOutputAmount ?? v.minOut);
  // the minimum the call guarantees must be consistent with the slippage asked for (a lowered minimum is a changed quote)
  if (v.minOut * 10000n < toAmount * BigInt(10000 - req.slippageBps - 50)) throw new Error(`Across swap: the guaranteed ${v.minOut} is more than ${req.slippageBps + 50} bps below the expected ${toAmount}`);
  const total = data.fees?.total;
  const fees: Fee[] = total ? [{ kind: "network", amount: BigInt(total.amount ?? 0), asset: total.token?.symbol ?? "?", usd: Number(total.amountUsd ?? 0) }] : [];
  const fill = v.call.depositData.fillDeadline;
  const expiresAt = Math.min(Number(data.quoteExpiryTimestamp ?? fill - 600), fill - 600);
  const swap = data.steps?.originSwap;
  return {
    provider: "uniswap-across", category: categoryOf(req.from, req.to), toAmount: toAmount < v.minOut ? v.minOut : toAmount, toAmountMin: v.minOut, fees, etaSeconds: Number(data.expectedFillTime ?? 0),
    expiresAt, nativeAssets: false, minOutEncoded: true, minOutVerified: true, refundTarget: "escrow",
    hops: [`${req.from.chain}:${req.from.symbol} -> swap (${swap?.swapProvider?.name ?? "?"}) -> ${swap?.tokenOut?.symbol ?? v.call.depositData.inputToken} -> Across -> ${req.to.chain}:${req.to.symbol}`],
    raw: data, obtainedAt: Date.now(),
  };
}

/** The swapAndBridge call as the escrow will make it, checked in full (the depositor must be the escrow). */
export function acrossSwapIngress(req: QuoteRequest, quote: Quote, base: { spokePool: Record<string, string>; weth: Record<string, string>; chainId: Record<string, number> }): Ingress {
  const tx = (quote.raw as any).swapTx;
  const v = verifyAcrossSwapCall(req, tx, acrossSwapPins(req, base));
  return { kind: "contract-call", to: String(tx.to).toLowerCase(), calldata: tx.data, value: BigInt(tx.value), expiresAt: quote.expiresAt, minOutEncoded: true, verified: v.verified, ...(v.refundTokens.length ? { refundTokens: v.refundTokens } : {}) };
}
