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
// adjustment only raises it. The exchange and its calldata stay opaque; what they can do is bounded by the
// swap's own floor, `minExpectedInputTokenAmount`, which must be in the asset delivered and cover the output
// in its units (audit 2026-10-16): a swap that yields less reverts the whole call (the escrow keeps the
// order), and a deposit nobody fills is refunded to the escrow at no less than the floor.
// The API pays the fill to Across's MulticallHandler with a message (verified source, the same address
// on Optimism, Base and Arbitrum): the handler runs the calls and, by its own comment, anything a message
// leaves in it "can be stolen". So the message is read too: only `drainLeftoverTokens(outputToken, fresh
// address)` on the pinned handler and `emitData` on the pinned AcrossEventEmitter (an event), no value,
// a fallback recipient that is the fresh address or none (a failing call then reverts the fill, and the
// unfilled deposit is refunded to the escrow); something must drain the output token to the fresh address.
import { hexBuf } from "../abi";
import { covers, escrowCanReshield, foreignRefundTokens, reshieldableAsset, sameAsset } from "../escrowAssets";
import { AdapterRefusal, SINGLE_PLAN, categoryOf, type Fee, type Ingress, type Quote, type QuoteRequest } from "../types";

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
/** makeCallWithBalance(address,bytes,uint256,(address,uint256)[]): for a native destination, the handler unwraps its WETH with it */
export const SEL_MAKE_CALL_WITH_BALANCE = "0xc41e8295";
const SEL_WETH_WITHDRAW = "0x2e1a7d4d"; // withdraw(uint256)

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
 * output (depositData.outputAmount, covered by the swap's own floor) and the token an unfilled deposit is
 * refunded in, when that is not the order's asset (the executor re-shields it through the escrow's refundToken).
 */
export function verifyAcrossSwapCall(
  req: QuoteRequest,
  tx: { to: string; data: string; value?: string | bigint; chainId?: number | string },
  pins: { periphery: string; spokePool: string; weth: string; chainId: Record<string, number>; outputToken: string; handler?: string; emitter?: string; nativeOut?: boolean },
  /** at quote time the escrow may not be known yet; prepareIngress always checks the depositor */
  opts: { requireDepositor?: boolean } = { requireDepositor: true },
): { minOut: bigint; refundTokens: string[]; verified: string[]; call: SwapAndBridge } {
  if (opts.requireDepositor !== false && !req.source) throw new Error("Across swap: the escrow address (req.source) is required as the depositor (refund target)");
  if (String(tx.to).toLowerCase() !== pins.periphery) throw new Error(`Across swap: transaction target ${tx.to} is not the pinned SpokePoolPeriphery`);
  if (tx.chainId !== undefined && Number(tx.chainId) !== pins.chainId[req.from.chain]) throw new Error(`Across swap: transaction chainId ${tx.chainId} is not ${req.from.chain}`);
  const c = decodeSwapAndBridge(tx.data);
  const verified = ["target=periphery"];
  const native = req.from.asset === "native";
  const value = BigInt(tx.value ?? 0);
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
    // ERC-20 out: something drains the output token to the fresh address (or the fallback is it). Native out: the
    // handler unwraps its WETH (only WETH.withdraw of its own WETH balance), and a drain of native ETH to the fresh
    // address follows the unwrap (ETH left in the handler could be taken by anyone).
    let drained = !pins.nativeOut && m.fallbackRecipient === dest;
    let unwrapped = false;
    for (const call of m.calls) {
      if (call.value !== 0n) throw new Error("Across swap: a destination call forwards value");
      const sel = "0x" + call.callData.subarray(0, 4).toString("hex");
      if (call.target === pins.handler && sel === SEL_DRAIN_LEFTOVER) {
        const a = call.callData.subarray(4);
        const token = a.length === 64 ? addr(word(a, 0)) : "";
        const okToken = token === output || (pins.nativeOut && token === ZERO);
        if (!okToken || addr(word(a, 1)) !== dest) throw new Error("Across swap: the handler would drain another token, or to another address than the fresh destination");
        // native out: the WETH only after the unwrap, its leftover (the eleventh review round, D11-8): drained before it, the fill went over as WETH
        if (pins.nativeOut && token === output && !unwrapped) throw new Error("Across swap: the handler would hand over the WETH before unwrapping it");
        if (pins.nativeOut ? token === ZERO && unwrapped : true) drained = true;
      } else if (pins.nativeOut && call.target === pins.handler && sel === SEL_MAKE_CALL_WITH_BALANCE) {
        // makeCallWithBalance(target, callData, value, Replacement[] { token, offset }): exactly WETH.withdraw(<its WETH balance>)
        const a = call.callData.subarray(4);
        const inner = bytes(a, u(word(a, 1)));
        const reps = at(a, u(word(a, 3)));
        const nRep = Number(u(word(reps, 0)));
        const innerOk = inner.length === 36 && "0x" + inner.subarray(0, 4).toString("hex") === SEL_WETH_WITHDRAW && inner.subarray(4).every((x) => x === 0);
        if (addr(word(a, 0)) !== output || u(word(a, 2)) !== 0n || !innerOk || nRep !== 1 || addr(word(reps, 1)) !== output || u(word(reps, 2)) !== 4n) throw new Error("Across swap: a balance call on the destination that is not the handler unwrapping its own WETH");
        unwrapped = true;
      } else if (!(pins.emitter && call.target === pins.emitter && sel === SEL_EMIT_DATA)) {
        throw new Error(`Across swap: the destination message calls ${call.target} (${sel}), which this adapter does not accept`);
      }
    }
    if (!drained) throw new Error(pins.nativeOut ? "Across swap: no drain of native ETH to the fresh destination after the unwrap (the handler would keep it)" : "Across swap: nothing hands the output token to the fresh destination (the handler would keep it)");
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
  // the swap's own floor backs the deposit (audit 2026-10-16): the exchange and its calldata stay opaque, and the periphery deposits
  // whatever the swap returned against outputAmount. So the swapped-into token must be the asset delivered (sameAsset), and
  // minExpectedInputTokenAmount must cover outputAmount in its units: a swap below it reverts the call, and a deposit nobody fills
  // refunds the escrow at least the output's worth. Otherwise the exchange could keep the order and return one unit
  const asset = reshieldableAsset(req.from, bridged);
  if (!asset || !sameAsset(asset.symbol, req.to.symbol)) throw new Error(`Across swap: bridges ${bridged}${asset ? ` (${asset.symbol})` : " (a token this adapter does not know)"} for ${req.to.symbol}; the swap's floor must be counted in the asset delivered, or an unfilled deposit refunds less than the output is worth`);
  if (!covers(c.minExpectedInputTokenAmount, asset.decimals, c.depositData.outputAmount, req.to.decimals)) throw new Error(`Across swap: the swap's own floor ${c.minExpectedInputTokenAmount} does not cover the deposit's output ${c.depositData.outputAmount} (the exchange could keep the order; an unfilled deposit refunds only the floor)`);
  verified.push("swap floor covers the output");
  return { minOut: c.depositData.outputAmount, refundTokens: foreignRefundTokens(req.from, [bridged]), verified, call: c };
}

const DEAD = "0x000000000000000000000000000000000000dEaD";

/** The pins for a request: the origin chain's periphery, SpokePool and WETH; the destination's handler and emitter. */
export function acrossSwapPins(req: QuoteRequest, base: { spokePool: Record<string, string>; weth: Record<string, string>; chainId: Record<string, number> }) {
  const periphery = ACROSS_PERIPHERY[req.from.chain], spokePool = base.spokePool[req.from.chain], weth = base.weth[req.from.chain];
  if (!periphery || !spokePool || !weth) throw new Error(`Across swap: no pinned periphery / SpokePool on ${req.from.chain}`);
  if (base.chainId[req.to.chain] === undefined) throw new Error(`Across swap: ${req.to.chain} is not a destination this adapter knows`);
  const nativeOut = req.to.asset === "native";
  const outputToken = nativeOut ? base.weth[req.to.chain] : req.to.asset;
  if (!outputToken) throw new Error(`Across swap: no WETH pinned on ${req.to.chain} for a native destination`);
  return { periphery, spokePool: spokePool.toLowerCase(), weth: weth.toLowerCase(), chainId: base.chainId, outputToken: outputToken.toLowerCase(), handler: ACROSS_MULTICALL_HANDLER[req.to.chain], emitter: ACROSS_EVENT_EMITTER[req.to.chain], nativeOut };
}

/** Across's Swap API: an origin-chain swap, then the bridge, as one swapAndBridge call; checked before it is ranked. */
export async function acrossSwapQuote(req: QuoteRequest, api: string, base: { spokePool: Record<string, string>; weth: Record<string, string>; chainId: Record<string, number> }): Promise<Quote> {
  const pins = acrossSwapPins(req, base);
  const qs = new URLSearchParams({
    tradeType: "exactInput", amount: req.amount.toString(), inputToken: req.from.asset === "native" ? ZERO : req.from.asset, originChainId: String(base.chainId[req.from.chain]),
    outputToken: req.to.asset === "native" ? ZERO : req.to.asset, destinationChainId: String(base.chainId[req.to.chain]), depositor: req.source ?? DEAD, recipient: req.destination, slippage: (req.slippageBps / 10000).toString(),
  });
  const r = await fetch(`${api}/swap/approval?${qs}`, { signal: AbortSignal.timeout(25000), headers: { accept: "application/json" } });
  const text = await r.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (r.status !== 200 || !data?.swapTx) throw new Error(`Across swap/approval: HTTP ${r.status} ${JSON.stringify(data).slice(0, 200)}`);
  if (data.crossSwapType !== "anyToBridgeable") throw new Error(`Across swap: a ${data.crossSwapType} route (only a swap on the origin chain, then the bridge, is offered)`);
  // the adapter's own checks of the call refuse it for this request: a refusal, never an outage (audit round 2, r03)
  let v: ReturnType<typeof verifyAcrossSwapCall>;
  try {
    v = verifyAcrossSwapCall(req, data.swapTx, pins, { requireDepositor: false });
  } catch (e) {
    throw new AdapterRefusal((e as Error)?.message ?? String(e));
  }
  const toAmount = BigInt(data.expectedOutputAmount ?? v.minOut);
  // the minimum the call guarantees must be consistent with the slippage asked for (a lowered minimum is a changed quote)
  if (v.minOut * 10000n < toAmount * BigInt(10000 - req.slippageBps - 50)) throw new AdapterRefusal(`Across swap: the guaranteed ${v.minOut} is more than ${req.slippageBps + 50} bps below the expected ${toAmount}`);
  const total = data.fees?.total;
  const fees: Fee[] = total ? [{ kind: "network", amount: BigInt(total.amount ?? 0), asset: total.token?.symbol ?? "?", decimals: typeof total.token?.decimals === "number" ? total.token.decimals : undefined, usd: Number(total.amountUsd ?? 0) }] : [];
  const fill = v.call.depositData.fillDeadline;
  const expiresAt = Math.min(Number(data.quoteExpiryTimestamp ?? fill - 600), fill - 600);
  const swap = data.steps?.originSwap;
  return {
    provider: "uniswap-across", category: categoryOf(req.from, req.to), toAmount: toAmount < v.minOut ? v.minOut : toAmount, toAmountMin: v.minOut, fees, etaSeconds: Number(data.expectedFillTime ?? 0),
    expiresAt, nativeAssets: false, minOutEncoded: true, minOutVerified: true, refundTarget: "escrow", plan: SINGLE_PLAN(Number(data.expectedFillTime ?? 0)),
    hops: [`${req.from.chain}:${req.from.symbol} -> swap (${swap?.swapProvider?.name ?? "?"}) -> ${swap?.tokenOut?.symbol ?? v.call.depositData.inputToken} -> Across -> ${req.to.chain}:${req.to.symbol}`],
    raw: data, obtainedAt: Date.now(),
  };
}

/** The swapAndBridge call as the escrow will make it, checked in full (the depositor must be the escrow). */
export function acrossSwapIngress(req: QuoteRequest, quote: Quote, base: { spokePool: Record<string, string>; weth: Record<string, string>; chainId: Record<string, number> }): Ingress {
  const tx = (quote.raw as any).swapTx;
  const v = verifyAcrossSwapCall(req, tx, acrossSwapPins(req, base));
  return { kind: "contract-call", to: String(tx.to).toLowerCase(), calldata: tx.data, value: BigInt(tx.value ?? 0), expiresAt: quote.expiresAt, minOutEncoded: true, verified: v.verified, ...(v.refundTokens.length ? { refundTokens: v.refundTokens } : {}) };
}
