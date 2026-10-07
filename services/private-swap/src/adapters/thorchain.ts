// THORChain adapter (plan §15): native-asset swaps via the THORNode quote API, ingress through the
// ETH router `depositWithExpiry`, limit (minimum output) encoded in the memo, status via tx/status.
// Public THORNode endpoints change; try a list, then THORNODE_URL if set.
import { keccak_256 } from "@noble/hashes/sha3";
import type { AssetRef, Capabilities, Health, Ingress, ProviderAdapter, Quote, QuoteRequest, TrackStatus } from "../types";
import { categoryOf } from "../types";

export const THORNODE_URLS = [
  process.env.THORNODE_URL,
  "https://gateway.liquify.com/chain/thorchain_api",
  "https://rest.cosmos.directory/thorchain",
  "https://thornode.ninerealms.com",
].filter(Boolean) as string[];

const CHAIN: Record<string, string> = { ethereum: "ETH", bitcoin: "BTC", solana: "SOL", base: "BASE", avalanche: "AVAX", bsc: "BSC", litecoin: "LTC", doge: "DOGE", tron: "TRON" };

/** THORChain asset notation: CHAIN.SYMBOL or CHAIN.SYMBOL-0xADDRESS for tokens. */
export function thorAsset(a: AssetRef): string {
  const chain = CHAIN[a.chain];
  if (!chain) throw new Error(`THORChain does not support chain ${a.chain}`);
  if (a.asset === "native") return `${chain}.${a.symbol.toUpperCase()}`;
  return `${chain}.${a.symbol.toUpperCase()}-${a.asset.toUpperCase()}`;
}

/** THORChain amounts are 1e8-based regardless of the asset's decimals. */
export const to1e8 = (amount: bigint, decimals: number) => (amount * 10n ** 8n) / 10n ** BigInt(decimals);
export const from1e8 = (amount1e8: bigint, decimals: number) => (amount1e8 * 10n ** BigInt(decimals)) / 10n ** 8n;

/** Distinct gateways that must agree on the inbound vault/router before an ingress is produced (plan §74). */
export const THORNODE_QUORUM = Number(process.env.THORNODE_QUORUM ?? "2");

async function fetchFrom<T>(base: string, path: string, timeoutMs: number): Promise<{ data: T; url: string; ms: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) { // public gateways drop connections now and then; one retry per endpoint
    const t0 = Date.now();
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${base}`);
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
  for (const base of THORNODE_URLS) {
    try { return await fetchFrom<T>(base, path, timeoutMs); } catch (e) { lastErr = e; }
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
  warning?: string; error?: string;
}

/** `=:ASSET:dest:limit` — the limit is the minimum output in 1e8 units; the swap refunds below it. */
export const buildMemo = (toAsset: string, destination: string, limit1e8: bigint) => `=:${toAsset}:${destination}:${limit1e8}`;

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
    return { routes: ["A", "B", "C", "E"], ingress: ["contract-call", "plain-address"], nativeAssets: true, atomic: false, chains: ["ethereum", "bitcoin", "solana", "base", "avalanche", "bsc", "litecoin", "doge", "tron"] };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    const from = thorAsset(req.from), to = thorAsset(req.to);
    const amount1e8 = to1e8(req.amount, req.from.decimals);
    const { data: q, url } = await thornode<ThorQuote>(`/thorchain/quote/swap?from_asset=${from}&to_asset=${to}&amount=${amount1e8}&destination=${req.destination}&tolerance_bps=${req.slippageBps}`);
    if (q.error) throw new Error(`THORChain quote: ${q.error}`);
    const expected1e8 = BigInt(q.expected_amount_out);
    const min1e8 = (expected1e8 * BigInt(10000 - req.slippageBps)) / 10000n;
    const fee = (kind: "liquidity" | "network" | "affiliate", v: string) => ({ kind, amount: from1e8(BigInt(v), req.to.decimals), asset: req.to.symbol });
    return {
      provider: "thorchain", category: categoryOf(req.from, req.to),
      toAmount: from1e8(expected1e8, req.to.decimals), toAmountMin: from1e8(min1e8, req.to.decimals),
      fees: [fee("liquidity", q.fees.liquidity), fee("network", q.fees.outbound), fee("affiliate", q.fees.affiliate)],
      etaSeconds: q.total_swap_seconds ?? 0, expiresAt: q.expiry, nativeAssets: true, minOutEncoded: true, minOutVerified: true,
      hops: [`${from} -> ${to} (${url})`], raw: { ...q, min1e8: min1e8.toString(), source: url }, obtainedAt: Date.now(),
    };
  }

  async prepareIngress(req: QuoteRequest, quote: Quote): Promise<Ingress> {
    const q = quote.raw as ThorQuote & { min1e8: string };
    const memo = buildMemo(thorAsset(req.to), req.destination, BigInt(q.min1e8)); // limit from OUR min-out, not the API memo
    // the deposit target must be confirmed by independent gateways, never taken from one quote response
    const inbound = await inboundQuorum(CHAIN[req.from.chain]);
    if (inbound.halted) throw new Error(`THORChain: ${CHAIN[req.from.chain]} inbound is halted`);
    if (q.inbound_address.toLowerCase() !== inbound.address) throw new Error(`THORChain: the quote's inbound address ${q.inbound_address} is not confirmed by the gateway quorum (${inbound.address})`);
    if ((q.router ?? "").toLowerCase() !== (inbound.router ?? "")) throw new Error(`THORChain: the quote's router ${q.router} is not confirmed by the gateway quorum (${inbound.router})`);
    const verified = [`inbound vault (${inbound.agreeing.length} gateways agree)`, "router (quorum)", "memo: destination + limit built locally"];
    if (req.from.chain !== "ethereum" && req.from.chain !== "base" && req.from.chain !== "avalanche" && req.from.chain !== "bsc") {
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

  async track(ref: { sourceTxHash?: string }): Promise<TrackStatus> {
    if (!ref.sourceTxHash) return { state: "unknown" };
    const id = ref.sourceTxHash.replace(/^0x/, "").toUpperCase();
    const { data } = await thornode<any>(`/thorchain/tx/status/${id}`);
    const st = data?.stages ?? {};
    const outs = data?.out_txs ?? [];
    if (outs.length && st.outbound_signed?.completed) {
      const o = outs[0];
      return { state: "destination-final", destinationTxHash: o.id, deliveredAmount: o.coins?.[0]?.amount ? BigInt(o.coins[0].amount) : undefined, deliveredAsset: o.coins?.[0]?.asset, raw: data };
    }
    if (st.swap_finalised?.completed) return { state: "destination-submitted", raw: data };
    if (st.inbound_finalised?.completed) return { state: "executing", raw: data };
    if (st.inbound_observed?.started) return { state: "executing", raw: data };
    return { state: "pending", raw: data };
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
