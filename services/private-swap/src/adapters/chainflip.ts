// Chainflip adapter (plan §15, step 08): native-asset swaps through Chainflip's MPC vaults.
//
// Ingress model: a *vault swap* — the escrow calls the Chainflip Vault contract on Ethereum
// (`xSwapNative` / `xSwapToken`) with the destination and the fill-or-kill parameters encoded in
// `cfParameters`. No deposit channel and no broker account are needed, which is what makes it fit the
// signed-execution escrow: the one-time order key signs exactly this calldata. The minimum price
// (our min-out) and the refund address (the escrow itself) are inside the calldata, so a worse fill
// is refunded to the escrow and re-shielded by `SwapOrderEscrow.refund` — never lost.
//
// The calldata is produced by Chainflip's public backend (`POST /api/encodeVaultSwapData`, the same
// route the official SDK uses) and then DECODED AND CHECKED HERE against what we asked for: the
// Vault address is pinned, and destination chain/asset/address, refund address and min price must
// match. A compromised backend can therefore only make the call fail, not redirect funds.
import { keccak_256 } from "@noble/hashes/sha3";
import type { AssetRef, Capabilities, Fee, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { categoryOf } from "../types";

export const CHAINFLIP_BACKEND = process.env.CHAINFLIP_BACKEND ?? "https://chainflip-swap.chainflip.io";
export const CHAINFLIP_RPC = process.env.CHAINFLIP_RPC ?? "https://mainnet-rpc.chainflip.io";
/** Chainflip Vault on Ethereum mainnet (pinned; the backend's `to` must equal it). */
export const CHAINFLIP_VAULT_ETHEREUM = "0xf5e10380213880111522dd0efd3dbb45b9f62bcc";
export const CHAINFLIP_BLOCK_SECONDS = 6;
/** A fresh quote is used for at most this long before the engine re-quotes (the FoK min price protects the fill itself). */
export const QUOTE_TTL_SECONDS = 600;

/** ForeignChain / Asset ids as used by `xSwapNative(dstChain, dstAddress, dstToken, cfParameters)`. */
export const CF_CHAIN_ID: Record<string, number> = { Ethereum: 1, Polkadot: 2, Bitcoin: 3, Arbitrum: 4, Solana: 5, Assethub: 6, Tron: 7 };
export const CF_ASSET_ID: Record<string, number> = {
  "Ethereum.ETH": 1, "Ethereum.FLIP": 2, "Ethereum.USDC": 3, "Polkadot.DOT": 4, "Bitcoin.BTC": 5, "Arbitrum.ETH": 6, "Arbitrum.USDC": 7,
  "Ethereum.USDT": 8, "Solana.SOL": 9, "Solana.USDC": 10, "Assethub.DOT": 11, "Assethub.USDT": 12, "Assethub.USDC": 13, "Arbitrum.USDT": 14, "Ethereum.WBTC": 15, "Solana.USDT": 16, "Tron.TRX": 17, "Tron.USDT": 18,
};

const CHAIN: Record<string, string> = { ethereum: "Ethereum", bitcoin: "Bitcoin", solana: "Solana", arbitrum: "Arbitrum", tron: "Tron" };

export interface CfAsset { chain: string; asset: string }

/** Our AssetRef → Chainflip {chain, asset}. Tokens are identified by symbol on Chainflip. */
export function cfAsset(a: AssetRef): CfAsset {
  const chain = CHAIN[a.chain];
  if (!chain) throw new Error(`Chainflip does not support chain ${a.chain}`);
  const asset = a.asset === "native" ? (a.chain === "bitcoin" ? "BTC" : a.chain === "solana" ? "SOL" : a.chain === "tron" ? "TRX" : "ETH") : a.symbol.toUpperCase();
  if (CF_ASSET_ID[`${chain}.${asset}`] === undefined) throw new Error(`Chainflip does not list ${chain}.${asset}`);
  return { chain, asset };
}

const X128 = 1n << 128n;

/** minPriceX128 exactly as the SDK derives it: price × 2^128 × 10^(destDecimals − srcDecimals), price rounded to dest decimals. */
export function minPriceX128(estimatedPrice: string, slippageBps: number, srcDecimals: number, destDecimals: number): bigint {
  // estimatedPrice is a decimal string (dest units per src unit); do exact decimal arithmetic in bigint
  const [ip, fp = ""] = estimatedPrice.split(".");
  const scale = fp.length;
  const priceScaled = BigInt(ip + fp); // price × 10^scale
  // price × (10000 − bps)/10000, truncated to destDecimals places (the SDK's toFixed(destDecimals) truncates on exactness; we floor)
  const minScaled = (priceScaled * BigInt(10000 - slippageBps)) / 10000n; // × 10^scale
  const keep = destDecimals;
  const minAtDest = scale >= keep ? minScaled / 10n ** BigInt(scale - keep) : minScaled * 10n ** BigInt(keep - scale); // × 10^destDecimals
  // × 2^128 × 10^(dest − src) / 10^dest
  const num = minAtDest * X128 * 10n ** BigInt(Math.max(0, destDecimals - srcDecimals));
  const den = 10n ** BigInt(destDecimals) * 10n ** BigInt(Math.max(0, srcDecimals - destDecimals));
  return num / den;
}

/** Minimum output in dest base units implied by a min price: srcAmount × minPriceX128 / 2^128. */
export const minOutFromPrice = (srcAmount: bigint, priceX128: bigint) => (srcAmount * priceX128) / X128;

interface CfQuote {
  type: "REGULAR" | "DCA"; isVaultSwap?: boolean; depositAmount: string; egressAmount: string; intermediateAmount?: string;
  estimatedPrice: string; estimatedDurationSeconds: number; recommendedSlippageTolerancePercent: number;
  recommendedRetryDurationMinutes?: number; lowLiquidityWarning: boolean;
  includedFees: { chain: string; asset: string; amount: string; type: "INGRESS" | "NETWORK" | "EGRESS" | "BOOST" | "BROKER" | "AFFILIATE" | string }[];
  srcAsset: CfAsset; destAsset: CfAsset;
}

async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 20000): Promise<{ data: T; ms: number; status: number }> {
  const t0 = Date.now();
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { data, ms: Date.now() - t0, status: r.status };
}

// ---- minimal ABI / base58 helpers for verifying the backend's calldata ---------------------------
const selector = (sig: string) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(sig))).subarray(0, 4).toString("hex");
export const SEL_X_SWAP_NATIVE = selector("xSwapNative(uint32,bytes,uint32,bytes)");
export const SEL_X_SWAP_TOKEN = selector("xSwapToken(uint32,bytes,uint32,address,uint256,bytes)");

const word = (b: Buffer, i: number) => BigInt("0x" + b.subarray(i, i + 32).toString("hex"));
const dynBytes = (b: Buffer, offset: number) => { const len = Number(word(b, offset)); return b.subarray(offset + 32, offset + 32 + len); };

export interface DecodedVaultSwap { dstChain: number; dstAddress: Buffer; dstToken: number; srcToken?: string; amount?: bigint; cf: DecodedCfParameters }
export interface DecodedCfParameters { version: number; retryDuration: number; refundAddress: string; minPriceX128: bigint; refundCcm: boolean; maxOracleSlippage: number | null; dca: { chunks: number; interval: number } | null; boostFee: number; brokerAccount: string; brokerBps: number; affiliates: number }

/** cfParameters v1 for an EVM-source vault swap (SCALE-like, little-endian), as emitted by the backend. */
export function decodeCfParameters(cf: Buffer): DecodedCfParameters {
  let i = 0;
  const version = cf[i++];
  if (version !== 1) throw new Error(`cfParameters version ${version} not understood`);
  const retryDuration = cf.readUInt32LE(i); i += 4;
  const refundAddress = "0x" + cf.subarray(i, i + 20).toString("hex"); i += 20;
  let minPrice = 0n; for (let k = 31; k >= 0; k--) minPrice = (minPrice << 8n) | BigInt(cf[i + k]); i += 32;
  const refundCcm = cf[i++] === 1; if (refundCcm) throw new Error("refund CCM metadata present; not expected");
  const hasOracle = cf[i++] === 1; let maxOracleSlippage: number | null = null; if (hasOracle) { maxOracleSlippage = cf.readUInt16LE(i); i += 2; }
  const hasDca = cf[i++] === 1; let dca: DecodedCfParameters["dca"] = null; if (hasDca) { dca = { chunks: cf.readUInt32LE(i), interval: cf.readUInt32LE(i + 4) }; i += 8; }
  const boostFee = cf[i++];
  const brokerAccount = "0x" + cf.subarray(i, i + 32).toString("hex"); i += 32;
  const brokerBps = cf.readUInt16LE(i); i += 2;
  const affiliates = cf[i++]; // compact length (< 64 entries)
  if (affiliates !== 0) throw new Error("affiliate fees present; not expected");
  if (i !== cf.length) throw new Error(`cfParameters has ${cf.length - i} trailing bytes`);
  return { version, retryDuration, refundAddress, minPriceX128: minPrice, refundCcm, maxOracleSlippage, dca, boostFee, brokerAccount, brokerBps, affiliates };
}

export function decodeVaultSwapCalldata(calldata: string): DecodedVaultSwap {
  const b = Buffer.from(calldata.replace(/^0x/, ""), "hex");
  const sel = "0x" + b.subarray(0, 4).toString("hex");
  const args = b.subarray(4);
  if (sel === SEL_X_SWAP_NATIVE) {
    const dstChain = Number(word(args, 0)), dstAddress = dynBytes(args, Number(word(args, 32))), dstToken = Number(word(args, 64)), cf = dynBytes(args, Number(word(args, 96)));
    return { dstChain, dstAddress: Buffer.from(dstAddress), dstToken, cf: decodeCfParameters(Buffer.from(cf)) };
  }
  if (sel === SEL_X_SWAP_TOKEN) {
    const dstChain = Number(word(args, 0)), dstAddress = dynBytes(args, Number(word(args, 32))), dstToken = Number(word(args, 64));
    const srcToken = "0x" + args.subarray(96 + 12, 128).toString("hex"), amount = word(args, 128), cf = dynBytes(args, Number(word(args, 160)));
    return { dstChain, dstAddress: Buffer.from(dstAddress), dstToken, srcToken, amount, cf: decodeCfParameters(Buffer.from(cf)) };
  }
  throw new Error(`unexpected selector ${sel}`);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) throw new Error("bad base58"); n = n * 58n + BigInt(v); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

/** The destination address bytes Chainflip expects in `dstAddress` for each chain. */
export function encodeDestination(chain: string, address: string): Buffer {
  if (chain === "Ethereum" || chain === "Arbitrum") return Buffer.from(address.replace(/^0x/, ""), "hex");
  if (chain === "Solana") return base58Decode(address);
  if (chain === "Bitcoin") return Buffer.from(address, "utf8");
  throw new Error(`destination encoding for ${chain} not implemented`);
}

export class ChainflipAdapter implements ProviderAdapter {
  readonly id = "chainflip" as const;
  readonly implemented = true;

  capabilities(): Capabilities {
    return { routes: ["A", "B", "C", "E"], ingress: ["contract-call"], nativeAssets: true, atomic: false, chains: ["ethereum", "bitcoin", "solana", "arbitrum", "tron"], destinationLinkPublic: true, linkEvidence: "the vault-swap calldata encodes the destination address (decoded locally before signing)" };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const src = cfAsset(req.from), dst = cfAsset(req.to);
    const isVault = req.from.chain === "ethereum" || req.from.chain === "arbitrum"; // our source is the EVM escrow
    const qs = new URLSearchParams({ srcChain: src.chain, srcAsset: src.asset, destChain: dst.chain, destAsset: dst.asset, amount: req.amount.toString(), isVaultSwap: String(isVault) });
    const { data, status } = await getJson<CfQuote[] | { message?: string }>(`${CHAINFLIP_BACKEND}/v2/quote?${qs}`);
    if (status !== 200 || !Array.isArray(data)) throw new Error(`Chainflip quote: HTTP ${status} ${JSON.stringify(data).slice(0, 200)}`);
    const q = data.find((x) => x.type === "REGULAR") ?? data[0];
    if (!q) throw new Error("Chainflip returned no quote");
    const priceX128 = minPriceX128(q.estimatedPrice, req.slippageBps, req.from.decimals, req.to.decimals);
    const toAmountMin = minOutFromPrice(req.amount, priceX128);
    const toAmount = BigInt(q.egressAmount);
    if (toAmountMin > toAmount) throw new Error("Chainflip min-out exceeds the quoted output (price inconsistency)");
    const feeKind: Record<string, Fee["kind"]> = { INGRESS: "gas", NETWORK: "protocol", EGRESS: "network", BOOST: "liquidity", BROKER: "affiliate", AFFILIATE: "affiliate" };
    const fees: Fee[] = q.includedFees.map((f) => ({ kind: feeKind[f.type] ?? "protocol", amount: BigInt(f.amount), asset: `${f.chain}.${f.asset}` }));
    const now = Math.floor(Date.now() / 1000);
    return {
      provider: "chainflip", category: categoryOf(req.from, req.to),
      toAmount, toAmountMin, fees, etaSeconds: q.estimatedDurationSeconds, expiresAt: now + QUOTE_TTL_SECONDS,
      nativeAssets: true, minOutEncoded: isVault, minOutVerified: isVault, hops: [`${src.chain}.${src.asset} -> USDC -> ${dst.chain}.${dst.asset} (vault swap: ${isVault})`],
      raw: { ...q, minPriceX128: priceX128.toString(), isVault, retryDurationBlocks: Math.max(1, Math.ceil(((q.recommendedRetryDurationMinutes ?? 30) * 60) / CHAINFLIP_BLOCK_SECONDS)) },
      obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    const q = quote.raw as CfQuote & { minPriceX128: string; isVault: boolean; retryDurationBlocks: number };
    if (!q.isVault) throw new Error("Chainflip: non-EVM sources need a broker-opened deposit channel (not used by V1.1; the source is always the EVM escrow)");
    if (!req.source) throw new Error("Chainflip: the escrow address (req.source) is required as the refund address");
    const src = cfAsset(req.from), dst = cfAsset(req.to);
    const body = {
      srcAsset: src, destAsset: dst, srcAddress: req.source, destAddress: req.destination, amount: req.amount.toString(),
      fillOrKillParams: { retryDurationBlocks: q.retryDurationBlocks, refundAddress: req.source, minPriceX128: q.minPriceX128 },
    };
    const { data, status } = await getJson<{ chain: string; to: string; calldata: string; value: string; sourceTokenAddress?: string } | { message?: string }>(`${CHAINFLIP_BACKEND}/api/encodeVaultSwapData`, { method: "POST", body: JSON.stringify(body) });
    if (status !== 200 || !("calldata" in data)) throw new Error(`Chainflip encodeVaultSwapData: HTTP ${status} ${JSON.stringify(data).slice(0, 300)}`);
    // ---- verify: the backend is a convenience, not a trust anchor -----------------------------------
    if (data.to.toLowerCase() !== CHAINFLIP_VAULT_ETHEREUM) throw new Error(`Chainflip: unexpected vault address ${data.to}`);
    const d = decodeVaultSwapCalldata(data.calldata);
    if (d.dstChain !== CF_CHAIN_ID[dst.chain]) throw new Error(`Chainflip calldata: dstChain ${d.dstChain} != ${dst.chain}`);
    if (d.dstToken !== CF_ASSET_ID[`${dst.chain}.${dst.asset}`]) throw new Error(`Chainflip calldata: dstToken ${d.dstToken} != ${dst.chain}.${dst.asset}`);
    if (!d.dstAddress.equals(encodeDestination(dst.chain, req.destination))) throw new Error("Chainflip calldata: destination address mismatch");
    if (d.cf.refundAddress.toLowerCase() !== req.source.toLowerCase()) throw new Error("Chainflip calldata: refund address is not the escrow");
    if (d.cf.minPriceX128 !== BigInt(q.minPriceX128)) throw new Error("Chainflip calldata: min price mismatch");
    if (d.cf.retryDuration !== q.retryDurationBlocks) throw new Error("Chainflip calldata: retry duration mismatch");
    if (d.cf.brokerBps !== 0 || d.cf.boostFee !== 0 || d.cf.dca) throw new Error("Chainflip calldata: unexpected broker fee / boost / DCA");
    if (req.from.asset === "native") {
      if (BigInt(data.value) !== req.amount || d.srcToken) throw new Error("Chainflip calldata: value/amount mismatch for a native swap");
    } else {
      if (BigInt(data.value) !== 0n || d.srcToken?.toLowerCase() !== req.from.asset.toLowerCase() || d.amount !== req.amount) throw new Error("Chainflip calldata: token/amount mismatch");
    }
    return { kind: "contract-call", to: data.to, calldata: data.calldata as `0x${string}`, value: BigInt(data.value), expiresAt: quote.expiresAt, minOutEncoded: true };
  }

  async track(ref: { sourceTxHash?: string }): Promise<TrackStatus> {
    if (!ref.sourceTxHash) return { state: "unknown" };
    const { data, status } = await getJson<any>(`${CHAINFLIP_BACKEND}/v2/swaps/${ref.sourceTxHash}`);
    if (status === 404) return { state: "unknown", raw: data };
    if (status !== 200) return { state: "unknown", raw: data };
    const egress = data.swapEgress, refund = data.refundEgress;
    switch (data.state) {
      case "WAITING": case "RECEIVING": return { state: "pending", raw: data };
      case "SWAPPING": return { state: "executing", raw: data };
      case "SENDING": return { state: "destination-submitted", destinationTxHash: egress?.txRef, raw: data };
      case "SENT": case "COMPLETED":
        if (refund && !egress) return { state: "refunded", raw: data };
        return { state: data.state === "COMPLETED" ? "completed" : "destination-final", destinationTxHash: egress?.txRef, deliveredAmount: egress?.amount ? BigInt(egress.amount) : undefined, raw: data };
      case "FAILED": return { state: refund ? "refunded" : "failed", raw: data };
      default: return { state: "unknown", raw: data };
    }
  }

  async health(): Promise<Health> {
    const t0 = Date.now();
    try {
      const { data } = await getJson<any>(CHAINFLIP_RPC, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "cf_safe_mode_statuses", params: [] }) });
      const r = data?.result;
      if (!r?.swapping) throw new Error("no safe-mode result");
      const haltedChains = Object.keys(r).filter((k) => k.startsWith("ingress_egress_") && (!r[k].vault_deposit_witnessing_enabled || !r[k].deposit_channel_witnessing_enabled)).map((k) => k.replace("ingress_egress_", ""));
      const halted = !r.swapping.swaps_enabled || !r.swapping.deposit_enabled || !r.swapping.withdrawals_enabled || haltedChains.includes("ethereum");
      return { provider: "chainflip", reachable: true, apiLatencyMs: Date.now() - t0, halted, haltedChains, checkedAt: Date.now() };
    } catch (e) {
      return { provider: "chainflip", reachable: false, apiLatencyMs: Date.now() - t0, halted: true, haltedChains: [], checkedAt: Date.now(), note: String(e) };
    }
  }
}
