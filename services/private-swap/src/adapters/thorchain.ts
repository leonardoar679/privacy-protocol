// THORChain adapter (plan §15): native-asset swaps via the THORNode quote API, ingress through the
// ETH router `depositWithExpiry`, limit (minimum output) encoded in the memo, status via tx/status.
// Public THORNode endpoints change; try a list, then THORNODE_URL if set.
//
// Refunds (spec §7): without a refund address in the memo THORChain refunds "to the originator's
// address" — for a router deposit that is the account that sent the transaction, i.e. the relayer
// executing the escrow, not the escrow. So an escrow-sourced memo always carries `/<escrow>` after the
// destination (`=:ASSET:DEST/REFUND:LIMIT`, the form THORNode's own quote API emits for
// `refund_address`); a refund then lands in the escrow, whose `refund()` re-shields it. The router pays
// ETH refunds with `send` (2300 gas), which the escrow's empty `receive()` accepts.
import { keccak_256 } from "@noble/hashes/sha3";
import type { AssetRef, Capabilities, ExecutionPlan, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { SINGLE_PLAN, categoryOf } from "../types";

export const THORNODE_URLS = [
  process.env.THORNODE_URL,
  "https://gateway.liquify.com/chain/thorchain_api",
  "https://rest.cosmos.directory/thorchain",
  // THORWallet's public load balancer: a third, independent operator (thornode.ninerealms.com stopped resolving in 2026-10)
  "https://thorchain-thornode-lb-1.thorwallet.org",
].filter(Boolean) as string[];

const CHAIN: Record<string, string> = { ethereum: "ETH", bitcoin: "BTC", solana: "SOL", base: "BASE", avalanche: "AVAX", bsc: "BSC", litecoin: "LTC", doge: "DOGE", tron: "TRON" };

/** THORChain asset notation: CHAIN.SYMBOL or CHAIN.SYMBOL-0xADDRESS for tokens. */
export function thorAsset(a: AssetRef): string {
  const chain = CHAIN[a.chain];
  if (!chain) throw new Error(`THORChain does not support chain ${a.chain}`);
  if (a.asset === "native") return `${chain}.${a.symbol.toUpperCase()}`;
  return `${chain}.${a.symbol.toUpperCase()}-${a.asset.toUpperCase()}`;
}

/**
 * The short asset form THORChain's own quote API writes into memos for UTXO sources (`ETH.USDC` for
 * ETH.USDC-0XA0B8…): a token is matched to the whitelisted pool with that ticker. Used only when the
 * full form would not fit a UTXO chain's 80-byte OP_RETURN; native assets keep their full form.
 */
export function thorAssetShort(a: AssetRef): string {
  const full = thorAsset(a);
  return a.asset === "native" ? full : full.slice(0, full.indexOf("-"));
}
/** A UTXO chain carries the memo in OP_RETURN: at most 80 bytes (THORChain memo docs). */
export const UTXO_MEMO_BYTES = 80;

/** THORChain amounts are 1e8-based regardless of the asset's decimals. */
export const to1e8 = (amount: bigint, decimals: number) => (amount * 10n ** 8n) / 10n ** BigInt(decimals);
export const from1e8 = (amount1e8: bigint, decimals: number) => (amount1e8 * 10n ** BigInt(decimals)) / 10n ** 8n;

/** THORChain's Ethereum router (v4.1.1), pinned like every other provider contract an escrow calls; the wallet pins it too (THORCHAIN_ROUTER after a router upgrade). */
export const THORCHAIN_ROUTER_ETHEREUM = (process.env.THORCHAIN_ROUTER ?? "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146").toLowerCase();

/** Distinct gateways that must agree on the inbound vault/router before an ingress is produced (plan §74). */
export const THORNODE_QUORUM = Number(process.env.THORNODE_QUORUM ?? "2");

/** A gateway answered but refused the request (HTTP 4xx with THORNode's reason): the request is the problem, not the gateway. */
class ThornodeRefusal extends Error {}
/** THORNode's reason without the simulation wrapper ("failed to simulate swap: failed to simulate handler: X: invalid request" → "X"). */
const refusalReason = (m: string) => m.replace(/^(failed to simulate (swap|handler): )+/, "").replace(/: invalid request$/, "");

async function fetchFrom<T>(base: string, path: string, timeoutMs: number): Promise<{ data: T; url: string; ms: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) { // public gateways drop connections now and then; one retry per endpoint
    const t0 = Date.now();
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      if (!r.ok) {
        let message = "";
        try { message = String(((await r.json()) as any)?.message ?? ""); } catch { /* not JSON */ }
        if (r.status >= 400 && r.status < 500 && message) throw new ThornodeRefusal(refusalReason(message));
        throw new Error(`HTTP ${r.status} from ${base}`);
      }
      return { data: (await r.json()) as T, url: base, ms: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof TypeError)) break; // HTTP errors are not retried on the same endpoint
    }
  }
  throw lastErr;
}

export async function thornode<T>(path: string, timeoutMs = 20000): Promise<{ data: T; url: string; ms: number }> {
  let lastErr: unknown;
  const refusals: string[] = [];
  for (const base of THORNODE_URLS) {
    try { return await fetchFrom<T>(base, path, timeoutMs); } catch (e) { if (e instanceof ThornodeRefusal) refusals.push(e.message); lastErr = e; }
  }
  // gateways that answered with a reason (a halted chain, a limit the route cannot meet) say more than "unreachable"
  if (refusals.length) {
    const distinct = [...new Set(refusals)];
    throw new Error(`THORChain refused: ${distinct[0]}${distinct.length > 1 ? ` (gateways differ: ${distinct.join(" | ")})` : ""}`);
  }
  throw new Error(`no THORNode endpoint reachable: ${String(lastErr)}`);
}

export interface InboundQuorum { address: string; router?: string; halted: boolean; agreeing: string[]; unreachable: string[] }

/**
 * The inbound vault + router for `chain`, confirmed by at least THORNODE_QUORUM distinct gateways
 * (plan §74 "THORChain compromised" at the API level: one lying gateway cannot redirect the deposit).
 * Any reachable gateway that disagrees fails the check — fail closed.
 */
export async function inboundQuorum(chain: string, timeoutMs = 20000): Promise<InboundQuorum> {
  const results: { base: string; entry?: any; error?: string }[] = await Promise.all(THORNODE_URLS.map(async (base) => {
    try { const { data } = await fetchFrom<any[]>(base, "/thorchain/inbound_addresses", timeoutMs); return { base, entry: data.find((c) => c.chain === chain) }; }
    catch (e) { return { base, error: String(e) }; }
  }));
  const reachable = results.filter((r) => r.entry);
  const unreachable = results.filter((r) => !r.entry).map((r) => r.base);
  if (reachable.length < THORNODE_QUORUM) throw new Error(`THORNode quorum not reached: ${reachable.length}/${THORNODE_QUORUM} gateways answered for ${chain} (unreachable: ${unreachable.join(", ") || "none"})`);
  const key = (e: any) => `${String(e.address).toLowerCase()}|${String(e.router ?? "").toLowerCase()}`;
  const first = key(reachable[0].entry);
  if (reachable.some((r) => key(r.entry) !== first)) throw new Error(`THORNode gateways disagree on the ${chain} inbound vault/router: ${reachable.map((r) => `${r.base} -> ${key(r.entry)}`).join("; ")}`);
  const e = reachable[0].entry;
  return { address: String(e.address).toLowerCase(), router: e.router ? String(e.router).toLowerCase() : undefined, halted: !!(e.halted || e.global_trading_paused || e.chain_trading_paused), agreeing: reachable.map((r) => r.base), unreachable };
}

interface ThorQuote {
  inbound_address: string; router?: string; memo: string; expected_amount_out: string; recommended_min_amount_in: string;
  expiry: number; total_swap_seconds?: number; fees: { asset: string; affiliate: string; outbound: string; liquidity: string; total: string; slippage_bps: number; total_bps: number };
  /** the streaming plan THORNode assumed (whale spec §6, §12): blocks ≈ sub-swaps at interval 1; the most sub-swaps it allows */
  streaming_swap_blocks?: number; streaming_swap_seconds?: number; max_streaming_quantity?: number; dust_threshold?: string;
  warning?: string; error?: string;
}

/** THORChain's EVM source chains: the ingress is a router deposit with the escrow as refund address; everything else is a UTXO deposit (guest mode). */
export const EVM_SOURCES = ["ethereum", "base", "avalanche", "bsc"];

/**
 * `=:ASSET:dest[/refund]:limit[/interval/quantity]` — the limit is the minimum output in 1e8 units; the swap refunds below it, to
 * `refund` when given (else to the originator). A streamed swap (whale spec §12) adds the interval (blocks between sub-swaps) and the
 * quantity (sub-swaps): THORChain applies the limit pro rata per sub-swap and refunds the unexecuted remainder to the refund address.
 */
export const buildMemo = (toAsset: string, destination: string, limit1e8: bigint, refund?: string, streaming?: { interval: number; quantity: number }) =>
  `=:${toAsset}:${destination}${refund ? `/${refund}` : ""}:${limit1e8}${streaming ? `/${streaming.interval}/${streaming.quantity}` : ""}`;

const SELECTOR_DEPOSIT_WITH_EXPIRY = Buffer.from(keccak_256(new TextEncoder().encode("depositWithExpiry(address,address,uint256,string,uint256)"))).subarray(0, 4);
const w = (v: bigint) => { const b = Buffer.alloc(32); let x = v; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

/** abi.encodeWithSelector(depositWithExpiry, vault, asset, amount, memo, expiry) */
export function encodeDepositWithExpiry(vault: string, asset: string, amount: bigint, memo: string, expiry: bigint): `0x${string}` {
  const m = Buffer.from(memo, "utf8");
  const padded = Buffer.concat([m, Buffer.alloc((32 - (m.length % 32)) % 32)]);
  return ("0x" + Buffer.concat([
    SELECTOR_DEPOSIT_WITH_EXPIRY, w(BigInt(vault)), w(BigInt(asset)), w(amount), w(160n), w(expiry), w(BigInt(m.length)), padded,
  ]).toString("hex")) as `0x${string}`;
}

export class ThorchainAdapter implements ProviderAdapter {
  readonly id = "thorchain" as const;
  readonly implemented = true;

  capabilities(): Capabilities {
    return { routes: ["A", "B", "C", "E"], ingress: ["contract-call", "plain-address"], nativeAssets: true, atomic: false, chains: ["ethereum", "bitcoin", "solana", "base", "avalanche", "bsc", "litecoin", "doge", "tron"], destinationLinkPublic: true, linkEvidence: "the deposit memo names the destination and the refund escrow (=:ASSET:DEST/ESCROW:LIMIT) and the outbound carries OUT:<inbound tx>" };
  }

  /**
   * The quote carries no destination and no tolerance (whale spec §6): the memo is built locally and the limit is ours (spec §14); with
   * `tolerance_bps` THORNode simulates a single swap and refuses it from $100K up (Stage 1). THORNode's default answer is its own plan
   * for the size — it streams what a single swap would slip on — and `streaming_swap_blocks` is that plan's sub-swap count at interval 1;
   * for an EVM source that plan is then quoted explicitly, so the expected output, the limit and the ETA are those of exactly the plan
   * the memo will carry. A UTXO source (guest mode) stays single: one memo of at most 80 bytes.
   */
  async quote(req: QuoteRequest): Promise<Quote> {
    const from = thorAsset(req.from), to = thorAsset(req.to);
    const amount1e8 = to1e8(req.amount, req.from.decimals);
    const base = `/thorchain/quote/swap?from_asset=${from}&to_asset=${to}&amount=${amount1e8}`;
    let { data: q, url } = await thornode<ThorQuote>(base);
    if (q.error) throw new Error(`THORChain quote: ${q.error}`);
    const evmSource = EVM_SOURCES.includes(req.from.chain);
    const parts = evmSource && req.plan !== "single" ? Math.max(0, Math.floor(Number(q.streaming_swap_blocks ?? 0))) : 0;
    if (parts > 0) {
      const explicit = await thornode<ThorQuote>(`${base}&streaming_interval=1&streaming_quantity=${parts}`).catch(() => null);
      if (explicit && !explicit.data.error) { q = explicit.data; url = explicit.url; }
    }
    const expected1e8 = BigInt(q.expected_amount_out);
    const min1e8 = (expected1e8 * BigInt(10000 - req.slippageBps)) / 10000n;
    const fee = (kind: "liquidity" | "network" | "affiliate", v: string) => ({ kind, amount: from1e8(BigInt(v), req.to.decimals), asset: req.to.symbol });
    const plan: ExecutionPlan = parts > 0 ? { mode: "streaming", parts, intervalBlocks: 1, expectedSeconds: q.total_swap_seconds ?? 0 } : SINGLE_PLAN(q.total_swap_seconds ?? 0);
    const sizeSignals = [q.warning, q.max_streaming_quantity ? `up to ${q.max_streaming_quantity} sub-swaps` : undefined].filter((x): x is string => !!x);
    return {
      provider: "thorchain", category: categoryOf(req.from, req.to),
      toAmount: from1e8(expected1e8, req.to.decimals), toAmountMin: from1e8(min1e8, req.to.decimals),
      fees: [fee("liquidity", q.fees.liquidity), fee("network", q.fees.outbound), fee("affiliate", q.fees.affiliate)],
      etaSeconds: q.total_swap_seconds ?? 0, expiresAt: q.expiry, nativeAssets: true, minOutEncoded: true, minOutVerified: true,
      plan, impactBps: q.fees.slippage_bps, limits: q.recommended_min_amount_in ? { min: from1e8(BigInt(q.recommended_min_amount_in), req.from.decimals) } : undefined, sizeSignals,
      hops: [`${from} -> ${to} (${url})${parts > 0 ? `, streamed in ${parts} sub-swaps` : ""}`], raw: { ...q, min1e8: min1e8.toString(), source: url, plan }, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    const q = quote.raw as ThorQuote & { min1e8: string };
    const evmSource = EVM_SOURCES.includes(req.from.chain);
    if (evmSource && !req.source) throw new Error("THORChain: the escrow address (req.source) is required as the refund address (a router deposit otherwise refunds to the transaction sender, the relayer)");
    // a streamed plan is written into the memo explicitly (never quantity 0, which would let the network choose); a UTXO source is never streamed
    const streaming = evmSource && quote.plan?.mode === "streaming" && quote.plan.parts > 0 ? { interval: Math.max(1, quote.plan.intervalBlocks), quantity: quote.plan.parts } : undefined;
    // limit from OUR min-out, not the API memo; a refund goes to the escrow (spec §7), never to the relayer that sends the transaction
    let memo = buildMemo(thorAsset(req.to), req.destination, BigInt(q.min1e8), evmSource ? req.source : undefined, streaming);
    if (!evmSource && Buffer.byteLength(memo) > UTXO_MEMO_BYTES) {
      // a UTXO deposit's OP_RETURN holds 80 bytes: use the short asset form THORChain's own quote API emits
      memo = buildMemo(thorAssetShort(req.to), req.destination, BigInt(q.min1e8));
      if (Buffer.byteLength(memo) > UTXO_MEMO_BYTES) throw new Error(`THORChain: the memo (${Buffer.byteLength(memo)} bytes) does not fit a ${req.from.chain} OP_RETURN (80 bytes)`);
    }
    // the deposit target must be confirmed by independent gateways, never taken from one quote response
    const inbound = await inboundQuorum(CHAIN[req.from.chain]);
    if (inbound.halted) throw new Error(`THORChain: ${CHAIN[req.from.chain]} inbound is halted`);
    // an ERC-20 escrow approves the router for its whole balance: even agreeing gateways cannot name another contract
    if (req.from.chain === "ethereum" && inbound.router !== THORCHAIN_ROUTER_ETHEREUM) throw new Error(`THORChain: the gateways report router ${inbound.router}, not the pinned Ethereum router ${THORCHAIN_ROUTER_ETHEREUM} (set THORCHAIN_ROUTER after a router upgrade)`);
    if (q.inbound_address.toLowerCase() !== inbound.address) throw new Error(`THORChain: the quote's inbound address ${q.inbound_address} is not confirmed by the gateway quorum (${inbound.address})`);
    if ((q.router ?? "").toLowerCase() !== (inbound.router ?? "")) throw new Error(`THORChain: the quote's router ${q.router} is not confirmed by the gateway quorum (${inbound.router})`);
    const verified = [
      `inbound vault (${inbound.agreeing.length} gateways agree)`, req.from.chain === "ethereum" ? "router (quorum + pinned)" : "router (quorum)", `memo: destination + limit${evmSource ? " + refund to the escrow" : ""} built locally`,
      streaming ? `streaming: ${streaming.quantity} sub-swaps, one every ${streaming.interval} block(s); the limit applies per sub-swap, unexecuted sub-swaps refund the escrow` : "one swap",
    ];
    if (!evmSource) {
      return { kind: "plain-address", to: q.inbound_address, calldata: "0x", value: req.amount, memo, expiresAt: q.expiry, minOutEncoded: true, verified };
    }
    if (!q.router) throw new Error("THORChain quote has no router for an EVM source");
    const asset = req.from.asset === "native" ? "0x0000000000000000000000000000000000000000" : req.from.asset;
    return {
      kind: "contract-call", to: q.router,
      calldata: encodeDepositWithExpiry(q.inbound_address, asset, req.amount, memo, BigInt(q.expiry)),
      value: req.from.asset === "native" ? req.amount : 0n, memo, expiresAt: q.expiry, minOutEncoded: true, verified,
    };
  }

  /**
   * Status from THORNode (whale spec §6, §19): the outbounds are classified by memo — `OUT:` delivered, `REFUND:` returned to the refund
   * address (a missing memo counts as delivered) — so a stream whose remainder came back is `partial`, with both amounts; the stream's
   * progress comes from `stages.swap_status.streaming`.
   */
  async track(ref: { sourceTxHash?: string }): Promise<TrackStatus> {
    if (!ref.sourceTxHash) return { state: "unknown" };
    const id = ref.sourceTxHash.replace(/^0x/, "").toUpperCase();
    const { data } = await thornode<any>(`/thorchain/tx/status/${id}`);
    const st = data?.stages ?? {};
    const outs: any[] = data?.out_txs ?? [];
    const isRefund = (o: any) => String(o?.memo ?? "").toUpperCase().startsWith("REFUND:");
    const delivered = outs.filter((o) => !isRefund(o)), refunded = outs.filter(isRefund);
    const sum = (xs: any[]) => xs.reduce((s: bigint, o: any) => s + BigInt(o?.coins?.[0]?.amount ?? 0), 0n);
    const streaming = st.swap_status?.streaming;
    const progress = streaming && Number(streaming.quantity) > 0 ? { parts: Number(streaming.quantity), done: Number(streaming.count ?? 0) } : undefined;
    if (outs.length && st.outbound_signed?.completed) {
      if (delivered.length && refunded.length) return { state: "partial", destinationTxHash: delivered[0].id, deliveredAmount: sum(delivered), deliveredAsset: delivered[0].coins?.[0]?.asset, refundedAmount: sum(refunded), progress, raw: data };
      if (!delivered.length) return { state: "refunded", refundedAmount: sum(refunded), progress, raw: data };
      return { state: "destination-final", destinationTxHash: delivered[0].id, deliveredAmount: sum(delivered), deliveredAsset: delivered[0].coins?.[0]?.asset, progress, raw: data };
    }
    if (st.swap_finalised?.completed) return { state: "destination-submitted", progress, raw: data };
    if (st.inbound_finalised?.completed) return { state: "executing", progress, raw: data };
    if (st.inbound_observed?.started) return { state: "executing", progress, raw: data };
    return { state: "pending", progress, raw: data };
  }

  async health(): Promise<Health> {
    const t0 = Date.now();
    try {
      const { data } = await thornode<any[]>("/thorchain/inbound_addresses");
      const halted = data.filter((c) => c.halted || c.global_trading_paused || c.chain_trading_paused).map((c) => c.chain);
      const eth = data.find((c) => c.chain === "ETH");
      return { provider: "thorchain", reachable: true, apiLatencyMs: Date.now() - t0, halted: !eth || !!eth.halted || !!eth.global_trading_paused || !!eth.chain_trading_paused, haltedChains: halted, checkedAt: Date.now() };
    } catch (e) {
      return { provider: "thorchain", reachable: false, apiLatencyMs: Date.now() - t0, halted: true, haltedChains: [], checkedAt: Date.now(), note: String(e) };
    }
  }
}
