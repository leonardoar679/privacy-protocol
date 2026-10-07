// The provider call, checked by THIS wallet before the one-time order key signs it (spec v1.1 §2, §5, §7).
// swapGuard.ts already ensures a swap service cannot redirect the private withdrawal, or get a call signed
// other than the one it shows. This module checks what that call DOES, from the wallet's own request and
// pinned contracts, never from the service's description of it:
//  - the call goes to a known provider contract (an ERC-20 escrow approves it for its whole balance);
//  - it pays this wallet's fresh destination, in the asset and on the chain the wallet asked for;
//  - it spends exactly what the escrow forwards, and a provider refund lands in the escrow (where
//    refund() re-shields it) or, for a provider that only refunds at the destination, at that address;
//  - it binds a minimum output the wallet can read; the caller compares it with what the user approved.
// THORChain's inbound vault rotates, so it is confirmed by a quorum of public THORNode gateways queried
// from here (the request carries no order data); the router is pinned. A call this wallet cannot read is
// refused. A minimum it cannot read (LI.FI into Mayan) is accepted only under the Fastest policy (§9).
// Written independently of services/private-swap's adapters; the tests check both decoders agree on
// real provider calls.
import { base58 } from "@scure/base";
import { bytesToHex, decodeFunctionData, getAddress, hexToBytes, isAddress, padHex, parseAbi, type Address, type Hex } from "viem";
import type { AssetRef, Policy } from "./swapService";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const env: Record<string, string | undefined> = (import.meta as any).env ?? {};
const pinned = (value: string | undefined, fallback: string): Address => getAddress(value && isAddress(value) ? value : fallback);

/** Provider contracts on Ethereum, where every escrow lives. A call to any other address is refused. */
export const PINNED = {
  /** THORChain Router v4.1.1 (the router the gateways report; VITE_THORCHAIN_ROUTER after a router upgrade) */
  thorchainRouter: pinned(env.VITE_THORCHAIN_ROUTER, "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146"),
  chainflipVault: getAddress("0xf5e10380213880111522dd0efd3dbb45b9f62bcc"),
  lifiDiamond: getAddress("0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"),
  mayanForwarder: getAddress("0x337685fdab40d39bd02028545a4ffa7d287cc3e2"),
  mayanFastMctp: getAddress("0xc1062b7c5dc8e4b1df9f200fe360cdc0ed6e7741"),
  acrossSpokePool: getAddress("0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5"),
} as const;

const EVM_CHAIN_ID: Record<string, number> = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137, bsc: 56, avalanche: 43114 };
const WETH: Record<string, Address> = {
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", base: "0x4200000000000000000000000000000000000006",
  optimism: "0x4200000000000000000000000000000000000006", arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
/** USDC on Ethereum: Mayan Fast-MCTP's input token (Circle CCTP). */
const USDC_ETHEREUM: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const LIFI_CHAIN_ID: Record<string, bigint> = { ...Object.fromEntries(Object.entries(EVM_CHAIN_ID).map(([k, v]) => [k, BigInt(v)])), solana: 1151111081099710n, bitcoin: 20000000000001n };
/** LI.FI's NON_EVM_ADDRESS: BridgeData.receiver for a non-EVM destination (the real receiver is in the facet data). */
const LIFI_NON_EVM_RECEIVER = "0x11f111f111f111f111f111f111f111f111f111f1";
const CCTP_DOMAIN: Record<string, number> = { ethereum: 0, avalanche: 1, optimism: 2, arbitrum: 3, solana: 5, base: 6, polygon: 7 };
const THOR_CHAIN: Record<string, string> = { ethereum: "ETH", bitcoin: "BTC", solana: "SOL", base: "BASE", avalanche: "AVAX", bsc: "BSC", litecoin: "LTC", doge: "DOGE", tron: "TRON" };
const CF_CHAIN: Record<string, [string, number]> = { ethereum: ["Ethereum", 1], bitcoin: ["Bitcoin", 3], arbitrum: ["Arbitrum", 4], solana: ["Solana", 5], tron: ["Tron", 7] };
const CF_ASSET: Record<string, number> = {
  "Ethereum.ETH": 1, "Ethereum.FLIP": 2, "Ethereum.USDC": 3, "Bitcoin.BTC": 5, "Arbitrum.ETH": 6, "Arbitrum.USDC": 7, "Ethereum.USDT": 8,
  "Solana.SOL": 9, "Solana.USDC": 10, "Arbitrum.USDT": 14, "Ethereum.WBTC": 15, "Solana.USDT": 16, "Tron.TRX": 17, "Tron.USDT": 18,
};
/** Chainflip's fill-or-kill retry is in 6-second blocks; a day is the most this wallet lets an order wait before its refund. */
const CF_MAX_RETRY_BLOCKS = 14_400;

export type ProviderName = "thorchain" | "chainflip" | "mayan" | "lifi" | "across";

export interface ProviderCall { provider: Address; value: bigint; calldata: Hex }

export interface CallExpectation {
  /** the order's escrow, recomputed by this wallet from its own factory (swapGuard.checkOrder) */
  escrow: Address;
  /** what this wallet asked for, from its own journal, never the service's echo */
  from: AssetRef;
  to: AssetRef;
  destination: string;
  /** amount − executor tip: what the escrow forwards to the provider */
  net: bigint;
  policy: Policy;
  /** unix seconds (tests) */
  now?: number;
}

export interface CheckedCall {
  provider: ProviderName;
  receiver: string;
  /** the least the call can deliver, in `to` base units; null when the call binds no minimum this wallet can read */
  minOut: bigint | null;
  /** where a provider-level refund lands */
  refundTo: "escrow" | "destination" | "provider";
  /** what this wallet confirmed, in plain words */
  facts: string[];
}

export class ProviderCallMismatch extends Error {
  constructor(public readonly provider: string, public readonly field: string, detail: string) {
    super(`the provider call does not do what this wallet asked for (${provider} ${field}: ${detail}) — not signing it`);
  }
}

/** The call is sound but guarantees less than the user approved; signing needs the user's consent to the new minimum. */
export class MinimumMoved extends Error {
  constructor(public readonly minOut: bigint, public readonly approved: bigint) {
    super(`the route now guarantees at least ${minOut}, below the ${approved} you approved`);
  }
}

export interface InboundVault { address: string; router: string; halted: boolean; agreeing: string[] }
export type InboundLookup = (chain: string) => Promise<InboundVault>;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The 32-byte form of an address on `chain`: an EVM address left-padded, a Solana key as is. */
export function bytes32Of(chain: string, address: string): Hex {
  if (EVM_CHAIN_ID[chain] !== undefined) {
    if (!isAddress(address, { strict: false })) throw new Error(`not an EVM address: ${address}`);
    return padHex(address.toLowerCase() as Hex, { size: 32 });
  }
  if (chain === "solana") {
    const b = base58.decode(address);
    if (b.length !== 32) throw new Error(`not a Solana address: ${address}`);
    return bytesToHex(b);
  }
  throw new Error(`no 32-byte address form for ${chain}`);
}

/** THORChain asset notation, as the engine writes it into the memo: CHAIN.SYMBOL or CHAIN.SYMBOL-0XTOKEN. */
export function thorAsset(a: AssetRef): string {
  const chain = THOR_CHAIN[a.chain];
  if (!chain) throw new Error(`THORChain does not serve ${a.chain}`);
  return a.asset === "native" ? `${chain}.${a.symbol.toUpperCase()}` : `${chain}.${a.symbol.toUpperCase()}-${a.asset.toUpperCase()}`;
}

/** THORChain limits are in 1e8 units whatever the asset's decimals. */
const from1e8 = (v: bigint, decimals: number) => (v * 10n ** BigInt(decimals)) / 10n ** 8n;

// ---- THORNode gateways: the inbound vault, confirmed from this wallet -----------------------------

export const THORNODE_GATEWAYS: string[] = (env.VITE_THORNODE_URLS ?? "https://gateway.liquify.com/chain/thorchain_api,https://rest.cosmos.directory/thorchain,https://thorchain-thornode-lb-1.thorwallet.org")
  .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
export const THORNODE_QUORUM = Math.max(2, Number(env.VITE_THORNODE_QUORUM ?? 2));

/**
 * The inbound vault + router for `chain` (THORChain notation, e.g. "ETH"), as at least `quorum` gateways
 * report it; any reachable gateway that disagrees fails the lookup (fail closed). The request is the
 * same for every user (all chains, no amounts, no addresses), and carries no cookie or referrer.
 */
export async function thornodeInbound(chain: string, opts: { gateways?: string[]; quorum?: number; fetchFn?: typeof fetch; timeoutMs?: number } = {}): Promise<InboundVault> {
  const gateways = opts.gateways ?? THORNODE_GATEWAYS, quorum = opts.quorum ?? THORNODE_QUORUM, fetchFn = opts.fetchFn ?? fetch;
  const answers = await Promise.all(gateways.map(async (base) => {
    try {
      const r = await fetchFn(`${base}/thorchain/inbound_addresses`, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
      if (!r.ok) return { base };
      const list = (await r.json()) as any[];
      const e = Array.isArray(list) ? list.find((c) => c?.chain === chain) : undefined;
      return e && isAddress(String(e.address)) && isAddress(String(e.router)) ? { base, entry: e } : { base };
    } catch { return { base }; }
  }));
  const reachable = answers.filter((a) => a.entry);
  if (reachable.length < quorum) throw new ProviderCallMismatch("thorchain", "vault", `only ${reachable.length} of ${gateways.length} THORNode gateways answered for ${chain}; ${quorum} must agree`);
  const key = (e: any) => `${String(e.address).toLowerCase()}|${String(e.router).toLowerCase()}`;
  if (reachable.some((a) => key(a.entry) !== key(reachable[0].entry))) throw new ProviderCallMismatch("thorchain", "vault", `THORNode gateways disagree on the ${chain} inbound vault/router`);
  const e: any = reachable[0].entry;
  return { address: getAddress(e.address), router: getAddress(e.router), halted: !!(e.halted || e.global_trading_paused || e.chain_trading_paused), agreeing: reachable.map((a) => a.base) };
}

// ---- ABIs (the provider contracts' entry points the engine's adapters produce) --------------------

const THOR_ABI = parseAbi(["function depositWithExpiry(address vault, address asset, uint256 amount, string memo, uint256 expiry) payable"]);
const CHAINFLIP_ABI = parseAbi([
  "function xSwapNative(uint32 dstChain, bytes dstAddress, uint32 dstToken, bytes cfParameters) payable",
  "function xSwapToken(uint32 dstChain, bytes dstAddress, uint32 dstToken, address srcToken, uint256 amount, bytes cfParameters)",
]);
const ACROSS_ABI = parseAbi(["function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable"]);
const MAYAN_FORWARDER_ABI = parseAbi([
  "struct PermitParams { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function swapAndForwardEth(uint256 amountIn, address swapProtocol, bytes swapData, address middleToken, uint256 minMiddleAmount, address mayanProtocol, bytes mayanData) payable",
  "function forwardERC20(address tokenIn, uint256 amountIn, PermitParams permitParams, address mayanProtocol, bytes protocolData) payable",
]);
const FAST_MCTP_ABI = parseAbi([
  "struct OrderPayload { uint8 payloadType; bytes32 destAddr; bytes32 tokenOut; uint64 amountOutMin; uint64 gasDrop; uint64 redeemFee; uint64 refundFee; uint64 deadline; bytes32 referrerAddr; uint8 referrerBps; }",
  "function createOrder(address tokenIn, uint256 amountIn, uint256 circleMaxFee, uint32 destDomain, uint32 minFinalityThreshold, OrderPayload orderPayload)",
]);
/** LI.FI diamond: the facets this wallet reads (lifinance/contracts AcrossFacetV4.sol, MayanFacet.sol as deployed 2026-10). */
const LIFI_ABI = parseAbi([
  "struct BridgeData { bytes32 transactionId; string bridge; string integrator; address referrer; address sendingAssetId; address receiver; uint256 minAmount; uint256 destinationChainId; bool hasSourceSwaps; bool hasDestinationCall; }",
  "struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }",
  "struct AcrossV4Data { bytes32 receiverAddress; bytes32 refundAddress; bytes32 sendingAssetId; bytes32 receivingAssetId; uint256 outputAmount; uint128 outputAmountMultiplier; bytes32 exclusiveRelayer; uint32 quoteTimestamp; uint32 fillDeadline; uint32 exclusivityParameter; bytes message; }",
  "struct MayanData { bytes32 nonEVMReceiver; address mayanProtocol; bytes protocolData; address swapProtocol; bytes swapData; address middleToken; uint256 minMiddleAmount; address refundRecipient; uint256 mayanAmountIn; }",
  "function startBridgeTokensViaAcrossV4(BridgeData _bridgeData, AcrossV4Data _acrossData) payable",
  "function swapAndStartBridgeTokensViaAcrossV4(BridgeData _bridgeData, SwapData[] _swapData, AcrossV4Data _acrossData) payable",
  "function startBridgeTokensViaMayan(BridgeData _bridgeData, MayanData _mayanData) payable",
  "function swapAndStartBridgeTokensViaMayan(BridgeData _bridgeData, SwapData[] _swapData, MayanData _mayanData) payable",
]);
/** AcrossFacetV4.MULTIPLIER_BASE */
const ACROSS_MULTIPLIER_BASE = 10n ** 18n;

/** Decode against `abi` or refuse: a selector outside it is a call this wallet cannot read. */
function decode<A extends readonly unknown[]>(provider: ProviderName, abi: A, data: Hex): { functionName: string; args: readonly any[] } {
  try { return decodeFunctionData({ abi: abi as any, data }) as any; }
  catch { throw new ProviderCallMismatch(provider, "call", `${data.slice(0, 10)} is not an entry point this wallet can read`); }
}

// ---- the check ---------------------------------------------------------------------------------------

/**
 * Throws ProviderCallMismatch unless `call` is one this wallet can read, sent to a pinned provider
 * contract, paying `e.destination` in `e.to`, spending `e.net` of `e.from`, with provider refunds to the
 * escrow. Returns what it confirmed, including the minimum output (compare it with `checkMinimum`).
 */
export async function checkProviderCall(call: ProviderCall, e: CallExpectation, deps: { inbound?: InboundLookup } = {}): Promise<CheckedCall> {
  if (e.from.chain !== "ethereum") throw new ProviderCallMismatch("escrow", "source", "escrows live on Ethereum");
  if (!isAddress(call.provider)) throw new ProviderCallMismatch("escrow", "provider", `${call.provider} is not an address`);
  const now = e.now ?? Math.floor(Date.now() / 1000);
  let checked: CheckedCall;
  const guarded = async (name: ProviderName, f: () => CheckedCall | Promise<CheckedCall>) => {
    try { return await f(); } catch (err) { throw err instanceof ProviderCallMismatch ? err : new ProviderCallMismatch(name, "call", String((err as Error).message ?? err)); }
  };
  if (same(call.provider, PINNED.thorchainRouter)) checked = await guarded("thorchain", () => thorchain(call, e, now, deps.inbound ?? ((chain) => thornodeInbound(chain))));
  else if (same(call.provider, PINNED.chainflipVault)) checked = await guarded("chainflip", () => chainflip(call, e));
  else if (same(call.provider, PINNED.acrossSpokePool)) checked = await guarded("across", () => across(call, e, now));
  else if (same(call.provider, PINNED.mayanForwarder)) checked = await guarded("mayan", () => mayan(call, e, now));
  else if (same(call.provider, PINNED.lifiDiamond)) checked = await guarded("lifi", () => lifi(call, e));
  else if (e.from.asset !== "native" && same(call.provider, e.from.asset)) {
    throw new ProviderCallMismatch("deposit address", "receiver", "a token transfer to a provider's deposit address: where that address pays out is the provider's promise, not something this wallet can read");
  } else if (call.calldata === "0x") {
    throw new ProviderCallMismatch("deposit address", "receiver", `${call.provider} is a plain deposit address: where it pays out is the provider's promise, not something this wallet can read`);
  } else {
    throw new ProviderCallMismatch("unknown", "provider", `${call.provider} is not a provider contract this wallet knows`);
  }
  if (checked.minOut === null && e.policy !== "fastest") throw new ProviderCallMismatch(checked.provider, "minimum", "this call binds no minimum output this wallet can read; only the Fastest policy accepts that");
  if (checked.minOut === null) checked.facts.push("minimum output: not readable in this call (accepted under Fastest)");
  return checked;
}

/** Throws MinimumMoved when the call guarantees less than the user approved. */
export function checkMinimum(checked: CheckedCall, approved: bigint): void {
  if (checked.minOut !== null && checked.minOut < approved) throw new MinimumMoved(checked.minOut, approved);
}

function must(ok: boolean, provider: ProviderName, field: string, detail: string): asserts ok {
  if (!ok) throw new ProviderCallMismatch(provider, field, detail);
}

async function thorchain(call: ProviderCall, e: CallExpectation, now: number, inbound: InboundLookup): Promise<CheckedCall> {
  const P: ProviderName = "thorchain";
  const { args } = decode(P, THOR_ABI, call.calldata);
  const [vault, asset, amount, memo, expiry] = args as [Address, Address, bigint, string, bigint];
  const v = await inbound("ETH");
  must(!v.halted, P, "inbound", "THORChain has halted Ethereum inbound");
  must(same(v.router, call.provider), P, "router", `the gateways report router ${v.router}, the call targets ${call.provider}`);
  must(same(vault, v.address), P, "vault", `${vault} is not the inbound vault ${v.agreeing.length} gateways report (${v.address})`);
  must(same(asset, e.from.asset === "native" ? ZERO : e.from.asset), P, "asset", `deposits ${asset}, not ${e.from.symbol}`);
  must(amount === e.net, P, "amount", `${amount} != ${e.net}`);
  must(call.value === (e.from.asset === "native" ? e.net : 0n), P, "value", `${call.value} forwarded`);
  must(expiry > BigInt(now), P, "expiry", "already passed");
  // =:ASSET:DEST/REFUND:LIMIT — no streaming, no affiliate: exactly the swap this wallet asked for
  const m = /^=:([^:]+):([^:/]+)\/([^:/]+):(\d+)$/.exec(memo);
  must(!!m, P, "memo", `"${memo}" is not =:ASSET:DEST/REFUND:LIMIT`);
  const [, memoAsset, memoDest, memoRefund, limit] = m!;
  must(memoAsset === thorAsset(e.to), P, "memo asset", `${memoAsset} is not ${thorAsset(e.to)}`);
  must(memoDest === e.destination, P, "receiver", `the memo pays ${memoDest}, not your fresh address`);
  must(same(memoRefund, e.escrow), P, "refund", `a refund would go to ${memoRefund}, not the escrow`);
  const minOut = from1e8(BigInt(limit), e.to.decimals);
  return {
    provider: P, receiver: memoDest, minOut, refundTo: "escrow",
    facts: [`router pinned; inbound vault confirmed by ${v.agreeing.length} THORNode gateways`, "memo pays your fresh address", "a THORChain refund goes to the escrow", `limit ${limit} (1e8 units)`],
  };
}

function chainflip(call: ProviderCall, e: CallExpectation): CheckedCall {
  const P: ProviderName = "chainflip";
  const { functionName, args } = decode(P, CHAINFLIP_ABI, call.calldata);
  const dst = CF_CHAIN[e.to.chain];
  must(!!dst, P, "destination", `Chainflip does not serve ${e.to.chain}`);
  const dstSymbol = e.to.asset === "native" ? ({ bitcoin: "BTC", solana: "SOL", tron: "TRX" } as Record<string, string>)[e.to.chain] ?? "ETH" : e.to.symbol.toUpperCase();
  const [dstChain, dstAddress, dstToken] = args as [number, Hex, number];
  must(dstChain === dst[1], P, "chain", `pays out on Chainflip chain ${dstChain}, not ${dst[0]}`);
  must(dstToken === CF_ASSET[`${dst[0]}.${dstSymbol}`], P, "asset", `pays out asset ${dstToken}, not ${dst[0]}.${dstSymbol}`);
  const want = e.to.chain === "bitcoin" ? new TextEncoder().encode(e.destination) : e.to.chain === "solana" ? base58.decode(e.destination) : hexToBytes(e.destination as Hex);
  must(bytesEqual(hexToBytes(dstAddress), want), P, "receiver", "the vault swap pays another address than your fresh one");
  let srcAmount: bigint, cfParameters: Hex;
  if (functionName === "xSwapNative") {
    must(e.from.asset === "native", P, "asset", "a native swap for a token order");
    must(call.value === e.net, P, "value", `${call.value} != ${e.net}`);
    srcAmount = call.value; cfParameters = args[3] as Hex;
  } else {
    const [, , , srcToken, amount, cf] = args as [number, Hex, number, Address, bigint, Hex];
    must(e.from.asset !== "native" && same(srcToken, e.from.asset), P, "asset", `swaps ${srcToken}, not ${e.from.symbol}`);
    must(amount === e.net && call.value === 0n, P, "amount", `${amount} (value ${call.value}) != ${e.net}`);
    srcAmount = amount; cfParameters = cf;
  }
  const cf = decodeCfParameters(hexToBytes(cfParameters));
  must(same(cf.refundAddress, e.escrow), P, "refund", `a fill-or-kill refund would go to ${cf.refundAddress}, not the escrow`);
  must(cf.brokerBps === 0 && cf.boostFee === 0 && cf.dca === null, P, "fees", "carries a broker fee, boost or DCA");
  must(cf.retryDuration <= CF_MAX_RETRY_BLOCKS, P, "retry", `${cf.retryDuration} blocks before a refund`);
  const minOut = (srcAmount * cf.minPriceX128) >> 128n;
  return { provider: P, receiver: e.destination, minOut, refundTo: "escrow", facts: ["vault pinned", "pays your fresh address", "fill-or-kill refund to the escrow", "no broker fee, boost or DCA"] };
}

interface CfParameters { refundAddress: Address; retryDuration: number; minPriceX128: bigint; boostFee: number; brokerBps: number; dca: { chunks: number; interval: number } | null }

/** cfParameters v1 for an EVM-source vault swap (SCALE, little-endian), as Chainflip's backend encodes it. */
export function decodeCfParameters(b: Uint8Array): CfParameters {
  const fail = (why: string): never => { throw new ProviderCallMismatch("chainflip", "cfParameters", why); };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const need = (n: number) => { if (i + n > b.length) fail("truncated"); };
  need(1); if (b[i++] !== 1) fail(`version ${b[0]} not understood`);
  need(4); const retryDuration = dv.getUint32(i, true); i += 4;
  need(20); const refundAddress = getAddress(bytesToHex(b.subarray(i, i + 20))); i += 20;
  need(32); let minPriceX128 = 0n; for (let k = 31; k >= 0; k--) minPriceX128 = (minPriceX128 << 8n) | BigInt(b[i + k]); i += 32;
  need(1); if (b[i++] !== 0) fail("refund CCM metadata present");
  need(1); if (b[i++] === 1) { need(2); i += 2; } // max oracle slippage: does not move money
  need(1); let dca: CfParameters["dca"] = null; if (b[i++] === 1) { need(8); dca = { chunks: dv.getUint32(i, true), interval: dv.getUint32(i + 4, true) }; i += 8; }
  need(1); const boostFee = b[i++];
  need(32); i += 32; // broker account
  need(2); const brokerBps = dv.getUint16(i, true); i += 2;
  need(1); if (b[i++] !== 0) fail("affiliate fees present");
  if (i !== b.length) fail(`${b.length - i} trailing bytes`);
  return { refundAddress, retryDuration, minPriceX128, boostFee, brokerBps, dca };
}

function across(call: ProviderCall, e: CallExpectation, now: number): CheckedCall {
  const P: ProviderName = "across";
  const { args } = decode(P, ACROSS_ABI, call.calldata);
  const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, , , fillDeadline, , message] = args as [Address, Address, Address, Address, bigint, bigint, bigint, Address, number, number, number, Hex];
  must(EVM_CHAIN_ID[e.to.chain] !== undefined, P, "destination", `Across bridges between EVM chains, not to ${e.to.chain}`);
  must(destinationChainId === BigInt(EVM_CHAIN_ID[e.to.chain]), P, "chain", `bridges to chain ${destinationChainId}, not ${e.to.chain}`);
  must(same(recipient, e.destination), P, "receiver", `pays ${recipient}, not your fresh address`);
  must(same(depositor, e.escrow), P, "refund", `an unfilled deposit would refund ${depositor}, not the escrow`);
  must(same(inputToken, e.from.asset === "native" ? WETH.ethereum : e.from.asset), P, "asset", `spends ${inputToken}, not ${e.from.symbol}`);
  const wantOut = e.to.asset === "native" ? WETH[e.to.chain] : e.to.asset;
  must(!!wantOut && same(outputToken, wantOut), P, "asset", `delivers ${outputToken}, not ${e.to.symbol}`);
  must(inputAmount === e.net && call.value === (e.from.asset === "native" ? e.net : 0n), P, "amount", `${inputAmount} (value ${call.value}) != ${e.net}`);
  must(message === "0x", P, "message", "a destination call is attached");
  must(fillDeadline > now, P, "deadline", "the fill deadline has passed");
  return { provider: P, receiver: recipient, minOut: outputAmount, refundTo: "escrow", facts: ["SpokePool pinned", "pays your fresh address", "exact fill amount, an unfilled deposit refunds the escrow"] };
}

function mayan(call: ProviderCall, e: CallExpectation, now: number): CheckedCall {
  const P: ProviderName = "mayan";
  const { functionName, args } = decode(P, MAYAN_FORWARDER_ABI, call.calldata);
  let mayanProtocol: Address, protocolData: Hex;
  if (functionName === "swapAndForwardEth") {
    const [amountIn, , , middleToken, minMiddleAmount, protocol, data] = args as [bigint, Address, Hex, Address, bigint, Address, Hex];
    must(e.from.asset === "native" && amountIn === e.net && call.value === e.net, P, "amount", `${amountIn} (value ${call.value}) != ${e.net}`);
    must(same(middleToken, USDC_ETHEREUM) && minMiddleAmount > 0n, P, "swap", "the ETH → USDC leg is not bounded in USDC");
    mayanProtocol = protocol; protocolData = data;
  } else {
    const [tokenIn, amountIn, permit, protocol, data] = args as [Address, bigint, { value: bigint; deadline: bigint }, Address, Hex];
    must(e.from.asset !== "native" && same(tokenIn, e.from.asset) && amountIn === e.net && call.value === 0n, P, "amount", `${amountIn} of ${tokenIn} != ${e.net} ${e.from.symbol}`);
    must(permit.value === 0n && permit.deadline === 0n, P, "permit", "carries a permit (the escrow approves instead)");
    mayanProtocol = protocol; protocolData = data;
  }
  must(same(mayanProtocol, PINNED.mayanFastMctp), P, "protocol", `hands the order to ${mayanProtocol}, not the pinned Fast-MCTP contract`);
  const order = decode(P, FAST_MCTP_ABI, protocolData);
  const [tokenIn, amountIn, , destDomain, , payload] = order.args as [Address, bigint, bigint, number, number, { payloadType: number; destAddr: Hex; tokenOut: Hex; amountOutMin: bigint; deadline: bigint; referrerAddr: Hex; referrerBps: number }];
  must(same(tokenIn, USDC_ETHEREUM), P, "order", "the order is not funded in USDC");
  // MayanForwarder (verified source, Sourcify): swapAndForwardEth overwrites the order's amountIn with the
  // USDC its whitelisted router produced (replaceMiddleAmount); forwardERC20 passes the order through as
  // is after pulling amountIn, so there the two must match or the difference stays in the forwarder
  if (e.from.asset !== "native") must(amountIn === e.net, P, "order", `orders ${amountIn}, not ${e.net}`);
  must(CCTP_DOMAIN[e.to.chain] !== undefined && destDomain === CCTP_DOMAIN[e.to.chain], P, "chain", `delivers to CCTP domain ${destDomain}, not ${e.to.chain}`);
  must(payload.payloadType === 3, P, "order", `payload type ${payload.payloadType}`);
  must(same(payload.destAddr, bytes32Of(e.to.chain, e.destination)), P, "receiver", "the order pays another address than your fresh one");
  const wantTokenOut = e.to.asset === "native" ? padHex("0x", { size: 32 }) : bytes32Of(e.to.chain, e.to.asset);
  must(same(payload.tokenOut, wantTokenOut), P, "asset", `delivers ${payload.tokenOut}, not ${e.to.symbol}`);
  must(BigInt(payload.referrerAddr) === 0n && payload.referrerBps === 0, P, "fees", "carries a referrer fee");
  must(payload.deadline > BigInt(now), P, "deadline", "the order deadline has passed");
  // amountOutMin carries min(8, decimals) decimals
  const minOut = e.to.decimals > 8 ? payload.amountOutMin * 10n ** BigInt(e.to.decimals - 8) : payload.amountOutMin;
  return { provider: P, receiver: e.destination, minOut, refundTo: "destination", facts: ["forwarder and Fast-MCTP pinned", "the order pays your fresh address", "an unfilled order refunds USDC to your fresh address, not to the pool"] };
}

function lifi(call: ProviderCall, e: CallExpectation): CheckedCall {
  const P: ProviderName = "lifi";
  const { functionName, args } = decode(P, LIFI_ABI, call.calldata);
  const bd = args[0] as { sendingAssetId: Address; receiver: Address; minAmount: bigint; destinationChainId: bigint; hasSourceSwaps: boolean; hasDestinationCall: boolean };
  const swaps = (bd.hasSourceSwaps ? args[1] : []) as { sendingAssetId: Address; fromAmount: bigint }[];
  const facet = args[args.length - 1] as any;
  must(bd.hasSourceSwaps === functionName.startsWith("swapAnd"), P, "call", "BridgeData.hasSourceSwaps disagrees with the entry point");
  must(LIFI_CHAIN_ID[e.to.chain] !== undefined && bd.destinationChainId === LIFI_CHAIN_ID[e.to.chain], P, "chain", `bridges to ${bd.destinationChainId}, not ${e.to.chain}`);
  must(!bd.hasDestinationCall, P, "receiver", "a destination call is attached (the bridge would pay a contract, not your fresh address)");
  const ours = e.from.asset === "native" ? ZERO : getAddress(e.from.asset);
  if (bd.hasSourceSwaps) must(swaps.length > 0 && same(swaps[0].sendingAssetId, ours) && swaps[0].fromAmount === e.net, P, "amount", `the first swap spends ${swaps[0]?.fromAmount} of ${swaps[0]?.sendingAssetId}, not ${e.net} ${e.from.symbol}`);
  else must(same(bd.sendingAssetId, ours) && bd.minAmount > 0n && bd.minAmount <= e.net, P, "amount", `bridges ${bd.minAmount} of ${bd.sendingAssetId}, not up to ${e.net} ${e.from.symbol}`);
  must(call.value === (e.from.asset === "native" ? e.net : 0n), P, "value", `${call.value} forwarded`);
  const evmDest = EVM_CHAIN_ID[e.to.chain] !== undefined;
  if (evmDest) must(same(bd.receiver, e.destination), P, "receiver", `pays ${bd.receiver}, not your fresh address`);
  else must(same(bd.receiver, LIFI_NON_EVM_RECEIVER), P, "receiver", "a non-EVM destination without LI.FI's non-EVM marker");
  const destination32 = bytes32Of(e.to.chain, e.destination);

  if (functionName.endsWith("AcrossV4")) {
    const a = facet as { receiverAddress: Hex; refundAddress: Hex; sendingAssetId: Hex; receivingAssetId: Hex; outputAmount: bigint; outputAmountMultiplier: bigint; message: Hex };
    must(same(a.receiverAddress, destination32), P, "receiver", "Across would pay another address than your fresh one");
    must(same(a.refundAddress, bytes32Of("ethereum", e.escrow)), P, "refund", "an unfilled Across deposit would refund another address than the escrow");
    if (!same(bd.sendingAssetId, ZERO)) must(same(a.sendingAssetId, bytes32Of("ethereum", bd.sendingAssetId)), P, "asset", "Across would be told to pull another token than the one bridged");
    const wantOut = e.to.asset === "native" ? WETH[e.to.chain] : e.to.asset;
    must(!!wantOut && same(a.receivingAssetId, bytes32Of(e.to.chain, wantOut)), P, "asset", `delivers ${a.receivingAssetId}, not ${e.to.symbol}`);
    must(a.message === "0x", P, "message", "a destination message is attached");
    // the swap variant overwrites outputAmount on chain: (swap result, >= minAmount) × multiplier / 1e18
    const minOut = bd.hasSourceSwaps ? (bd.minAmount * a.outputAmountMultiplier) / ACROSS_MULTIPLIER_BASE : a.outputAmount;
    if (bd.hasSourceSwaps) must(a.outputAmount === minOut, P, "minimum", "outputAmount disagrees with minAmount × outputAmountMultiplier");
    return { provider: P, receiver: e.destination, minOut, refundTo: "escrow", facts: ["LI.FI diamond pinned; Across facet decoded", "pays your fresh address", "an unfilled deposit refunds the escrow", bd.hasSourceSwaps ? "minimum = bridged amount × LI.FI's output multiplier (what the facet hands Across)" : "exact fill amount"] };
  }
  // MayanFacet: the facet checks the receiver against Mayan's order on chain; it sweeps excess value
  // and, in the swap variant, everything above mayanAmountIn to refundRecipient
  const m = facet as { nonEVMReceiver: Hex; refundRecipient: Address; mayanAmountIn: bigint };
  if (!evmDest) must(same(m.nonEVMReceiver, destination32), P, "receiver", "Mayan would pay another address than your fresh one");
  must(same(m.refundRecipient, e.escrow), P, "refund", `excess value and swap surplus would go to ${m.refundRecipient}, not the escrow`);
  if (bd.hasSourceSwaps) must(m.mayanAmountIn === bd.minAmount, P, "amount", `hands Mayan ${m.mayanAmountIn} of the ${bd.minAmount} bridged; the rest would be swept away`);
  return { provider: P, receiver: e.destination, minOut: null, refundTo: "provider", facts: ["LI.FI diamond pinned; Mayan facet decoded", "pays your fresh address", "excess value and swap surplus return to the escrow", "a failed Mayan order refunds by Mayan's rules"] };
}
