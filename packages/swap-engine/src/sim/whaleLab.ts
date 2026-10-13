// Whale execution lab (plan V2 §119; spec docs/whale-execution-spec-v1.0.md §2, §4, §12, §13).
//
// LIVE and READ-ONLY: for every pair a whale moves and every size from $100K to $25M, ask each adapter
// that serves the pair for its quote exactly as the engine would (the same QuoteRequest, the spec §5
// placeholder destination), and fetch the streamed variants directly — THORChain's streaming quote
// (interval 1, quantity 0 = the node's own choice, capped by max_streaming_quantity) and Chainflip's
// DCA quote (dcaEnabled=true returns both the REGULAR and the DCA quote). Nothing is sent, signed or
// funded. The run is sequential with a pause between calls; LI.FI's anonymous limit answers 429 for
// two hours after heavy use, so it gets three calls in all.
//
// Sizes are converted to asset units with Chainlink's mainnet feeds read through public RPCs — the
// same table the wallet pins (spec §13), so the lab also checks that table. Per row: the quoted output,
// the provider's own slippage / impact figure, the ETA, the plan's parts, the limits and warnings, the
// price impact against the same provider's $100K quote (bps) and the all-in cost against the oracle
// rate (bps). Refusals ("insufficient liquidity", a 400) are rows too: at $5M+ they are the result.
// Usage: npx tsx src/sim/whaleLab.ts [--json out.json] [--md out.md] [--pause 1500] [--sizes 100000,1000000] [--pairs ETH>BTC,ETH>SOL]
import { writeFileSync } from "fs";
import type { AssetRef, ProviderAdapter, ProviderId, Quote, QuoteRequest } from "../types";
import { ThorchainAdapter, thorAsset, thornode, to1e8, from1e8 } from "../adapters/thorchain";
import { ChainflipAdapter, CHAINFLIP_BACKEND, cfAsset } from "../adapters/chainflip";
import { MayanAdapter } from "../adapters/mayan";
import { NearIntentsAdapter } from "../adapters/nearIntents";
import { LifiAdapter } from "../adapters/lifi";
import { AcrossAdapter } from "../adapters/across";

// ---- Chainlink through public RPCs: the feed table the wallet and the engine pin (packages/protocol/src/wallet/valuation.ts) ----
import { FEED_REGISTRY, SELECTOR, decodeAddress, decodeLatestRoundData, decodeString, feedsFor, getFeedCalldata, type FeedSpec } from "../../../../packages/protocol/src/wallet/valuation";
const RPCS = [process.env.LAB_RPC_URL, "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://1rpc.io/eth", "https://rpc.ankr.com/eth", "https://cloudflare-eth.com", "https://eth.llamarpc.com"].filter(Boolean) as string[];
/** The mainnet table (BTC is resolved from the Feed Registry: the address Chainlink's docs once listed for BTC / USD, 0xF4030086522a5bEEa4988F8cA5B36dBAC08cBBAE, has no code today). */
export const FEEDS: FeedSpec[] = feedsFor(1);

/** One eth_call through the public RPCs, each tried twice (they rate-limit and answer HTML now and then); "0x" means no code at the address. */
async function ethCall(to: string, data: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of RPCS) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }), signal: AbortSignal.timeout(15000) });
        const text = await r.text();
        let j: any;
        try { j = JSON.parse(text); } catch { throw new Error(`${url} answered ${r.status} ${text.slice(0, 40).replace(/\s+/g, " ")}`); }
        if (j.error) throw new Error(`${url}: ${j.error.message}`);
        if (j.result === "0x") throw new NoCode(`no code at ${to} (${url})`);
        if (typeof j.result === "string") return j.result;
        throw new Error(`${url}: no result`);
      } catch (e) {
        if (e instanceof NoCode) throw e; // every RPC would say the same
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastErr;
}
class NoCode extends Error {}
export interface FeedRead { symbol: string; source: string; description: string; usd: number; updatedAt: number; roundId: string; ageSeconds: number }
export async function readFeed(symbol: string, now = Math.floor(Date.now() / 1000)): Promise<FeedRead> {
  const f = FEEDS.find((x) => x.symbol === symbol);
  if (!f) throw new Error(`no feed for ${symbol}`);
  const candidates: string[] = f.proxy ? [f.proxy] : [];
  if (f.registryBase) {
    try { candidates.push(decodeAddress(await ethCall(FEED_REGISTRY, getFeedCalldata(f.registryBase)))); } catch { /* registry unreachable */ }
  }
  let lastErr: unknown;
  for (const addr of candidates) {
    try {
      const description = decodeString(await ethCall(addr, SELECTOR.description));
      if (description !== f.description) throw new Error(`${addr} is "${description}", not "${f.description}"`);
      const rd = decodeLatestRoundData(await ethCall(addr, SELECTOR.latestRoundData));
      return { symbol, source: addr, description, usd: Number(rd.answer) / 1e8, updatedAt: rd.updatedAt, roundId: rd.roundId.toString(), ageSeconds: now - rd.updatedAt };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`no feed answered for ${symbol}: ${String(lastErr)}`);
}

// ---- assets, pairs, placeholders (spec §5) --------------------------------------------------------
export const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
export const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
export const SOL: AssetRef = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
export const USDC: AssetRef = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
export const USDC_BASE: AssetRef = { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" };
export const ETH_BASE: AssetRef = { chain: "base", asset: "native", decimals: 18, symbol: "ETH" };
/** Fixed, format-valid placeholder destinations (spec §5): never a real address of ours. */
export const PLACEHOLDER: Record<string, string> = {
  ethereum: "0x1111111111111111111111111111111111111111", base: "0x1111111111111111111111111111111111111111", arbitrum: "0x1111111111111111111111111111111111111111",
  bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", solana: "11111111111111111111111111111111",
};
export interface Pair { name: string; from: AssetRef; to: AssetRef; providers: ProviderId[]; lifiSizes?: number[] }
export const PAIRS: Pair[] = [
  { name: "ETH>BTC", from: ETH, to: BTC, providers: ["thorchain", "chainflip", "near-intents"] },
  { name: "BTC>ETH", from: BTC, to: ETH, providers: ["thorchain", "chainflip", "near-intents"] },
  { name: "ETH>SOL", from: ETH, to: SOL, providers: ["thorchain", "chainflip", "mayan", "near-intents", "lifi"], lifiSizes: [1_000_000, 5_000_000] },
  { name: "ETH>USDC(Base)", from: ETH, to: USDC_BASE, providers: ["thorchain", "mayan", "near-intents", "uniswap-across", "lifi"], lifiSizes: [1_000_000] },
  { name: "USDC>BTC", from: USDC, to: BTC, providers: ["thorchain", "chainflip", "near-intents"] },
  { name: "ETH>ETH(Base)", from: ETH, to: ETH_BASE, providers: ["uniswap-across"] },
];
export const SIZES_USD = [100_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 25_000_000];

export interface Row {
  pair: string; usd: number; amount: string; amountUnits: number; provider: string; variant: "single" | "streaming" | "dca"; ok: boolean; ms: number;
  toAmount?: string; toAmountMin?: string; unitOut?: number; impactBps?: number; costVsOracleBps?: number;
  providerSlippageBps?: number; etaSeconds?: number; parts?: number; maxParts?: number; intervalBlocks?: number;
  lowLiquidity?: boolean; recommendedSlippagePct?: number; limits?: Record<string, string>; warning?: string; error?: string;
}
const units = (amount: bigint, decimals: number) => Number(amount) / 10 ** decimals;
const toBase = (x: number, decimals: number) => BigInt(Math.round(x * 1e6)) * 10n ** BigInt(decimals - 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 220);

function adapterFor(id: ProviderId): ProviderAdapter {
  switch (id) {
    case "thorchain": return new ThorchainAdapter();
    case "chainflip": return new ChainflipAdapter();
    case "mayan": return new MayanAdapter();
    case "near-intents": return new NearIntentsAdapter();
    case "lifi": return new LifiAdapter();
    case "uniswap-across": return new AcrossAdapter();
  }
}

/** The adapter's own quote: what the engine would see for this size. */
async function adapterRow(a: ProviderAdapter, pair: Pair, usd: number, amount: bigint): Promise<Row> {
  const t0 = Date.now();
  const req: QuoteRequest = { from: pair.from, to: pair.to, amount, destination: PLACEHOLDER[pair.to.chain], slippageBps: 50 };
  const base: Row = { pair: pair.name, usd, amount: amount.toString(), amountUnits: units(amount, pair.from.decimals), provider: a.id, variant: "single", ok: false, ms: 0 };
  try {
    const q: Quote = await a.quote(req);
    const raw: any = q.raw ?? {};
    const row: Row = { ...base, ok: true, toAmount: q.toAmount.toString(), toAmountMin: q.toAmountMin.toString(), unitOut: units(q.toAmount, pair.to.decimals) / units(amount, pair.from.decimals), etaSeconds: q.etaSeconds };
    if (a.id === "thorchain") { row.providerSlippageBps = raw.fees?.slippage_bps; row.maxParts = raw.max_streaming_quantity; row.parts = raw.streaming_swap_blocks; row.warning = raw.warning; if (raw.recommended_min_amount_in) row.limits = { min1e8: String(raw.recommended_min_amount_in) }; }
    if (a.id === "chainflip") { row.lowLiquidity = raw.lowLiquidityWarning; row.recommendedSlippagePct = raw.recommendedSlippageTolerancePercent; }
    if (a.id === "mayan") { if (raw.priceImpact !== undefined) row.providerSlippageBps = Math.round(Number(raw.priceImpact) * 100); }
    if (a.id === "uniswap-across" && raw.limits) row.limits = { minDeposit: String(raw.limits.minDeposit), maxDeposit: String(raw.limits.maxDeposit), maxDepositInstant: String(raw.limits.maxDepositInstant) };
    row.ms = Date.now() - t0;
    return row;
  } catch (e) {
    return { ...base, ms: Date.now() - t0, error: errText(e) };
  }
}

/** THORChain's streaming quote, fetched directly (the adapter sends no streaming parameters until Stage 3). */
async function thorStreamingRow(pair: Pair, usd: number, amount: bigint): Promise<Row> {
  const t0 = Date.now();
  const base: Row = { pair: pair.name, usd, amount: amount.toString(), amountUnits: units(amount, pair.from.decimals), provider: "thorchain", variant: "streaming", ok: false, ms: 0 };
  try {
    const { data: q } = await thornode<any>(`/thorchain/quote/swap?from_asset=${thorAsset(pair.from)}&to_asset=${thorAsset(pair.to)}&amount=${to1e8(amount, pair.from.decimals)}&streaming_interval=1&streaming_quantity=0`);
    if (q.error) throw new Error(q.error);
    const out = from1e8(BigInt(q.expected_amount_out), pair.to.decimals);
    return { ...base, ok: true, ms: Date.now() - t0, toAmount: out.toString(), unitOut: units(out, pair.to.decimals) / units(amount, pair.from.decimals), providerSlippageBps: q.fees?.slippage_bps, etaSeconds: q.total_swap_seconds, parts: q.streaming_swap_blocks, maxParts: q.max_streaming_quantity, intervalBlocks: 1, warning: q.warning };
  } catch (e) {
    return { ...base, ms: Date.now() - t0, error: errText(e) };
  }
}

/** Chainflip's REGULAR and DCA quotes from one request (the adapter picks REGULAR until Stage 3). */
async function chainflipRows(pair: Pair, usd: number, amount: bigint): Promise<Row[]> {
  const t0 = Date.now();
  const src = cfAsset(pair.from), dst = cfAsset(pair.to);
  const isVault = pair.from.chain === "ethereum" || pair.from.chain === "arbitrum";
  const base: Row = { pair: pair.name, usd, amount: amount.toString(), amountUnits: units(amount, pair.from.decimals), provider: "chainflip", variant: "single", ok: false, ms: 0 };
  try {
    const qs = new URLSearchParams({ srcChain: src.chain, srcAsset: src.asset, destChain: dst.chain, destAsset: dst.asset, amount: amount.toString(), isVaultSwap: String(isVault), dcaEnabled: "true" });
    const r = await fetch(`${CHAINFLIP_BACKEND}/v2/quote?${qs}`, { signal: AbortSignal.timeout(45000), headers: { accept: "application/json" } });
    const text = await r.text();
    let data: any; try { data = JSON.parse(text); } catch { data = text; }
    if (r.status !== 200 || !Array.isArray(data)) throw new Error(`HTTP ${r.status} ${typeof data === "string" ? data.slice(0, 120) : JSON.stringify(data).slice(0, 120)}`);
    const ms = Date.now() - t0;
    return data.map((q: any) => ({
      ...base, variant: q.type === "DCA" ? "dca" : "single", ok: true, ms, toAmount: String(q.egressAmount), unitOut: units(BigInt(q.egressAmount), pair.to.decimals) / units(amount, pair.from.decimals),
      etaSeconds: q.estimatedDurationSeconds, lowLiquidity: q.lowLiquidityWarning, recommendedSlippagePct: q.recommendedSlippageTolerancePercent,
      parts: q.dcaParams?.numberOfChunks, intervalBlocks: q.dcaParams?.chunkIntervalBlocks,
    }));
  } catch (e) {
    return [{ ...base, ms: Date.now() - t0, error: errText(e) }];
  }
}

export interface LabResult { at: string; feeds: FeedRead[]; sizesUsd: number[]; pauseMs: number; rows: Row[]; notes: string[] }

export async function runLab(o: { sizes: number[]; pairs: Pair[]; pauseMs: number; log: (s: string) => void }): Promise<LabResult> {
  const feeds: FeedRead[] = [];
  for (const s of ["ETH", "BTC", "SOL", "USDC"]) { const f = await readFeed(s); feeds.push(f); o.log(`${s}/USD ${f.usd} (${f.source}, ${f.ageSeconds} s old)`); }
  const price = (a: AssetRef) => feeds.find((f) => f.symbol === a.symbol)!.usd;
  const rows: Row[] = [];
  const notes: string[] = [];
  const adapters = new Map<ProviderId, ProviderAdapter>();
  for (const pair of o.pairs) {
    const fair = price(pair.from) / price(pair.to); // oracle rate: `to` units per `from` unit
    for (const usd of o.sizes) {
      const amount = toBase(usd / price(pair.from), pair.from.decimals);
      for (const id of pair.providers) {
        if (id === "lifi" && !(pair.lifiSizes ?? []).includes(usd)) continue;
        if (!adapters.has(id)) adapters.set(id, adapterFor(id));
        const batch: Row[] = [];
        if (id === "chainflip") batch.push(...(await chainflipRows(pair, usd, amount)));
        else {
          batch.push(await adapterRow(adapters.get(id)!, pair, usd, amount));
          if (id === "thorchain") { await sleep(o.pauseMs); batch.push(await thorStreamingRow(pair, usd, amount)); }
        }
        for (const row of batch) {
          if (row.ok && row.unitOut) row.costVsOracleBps = Math.round((1 - row.unitOut / fair) * 10000);
          rows.push(row);
          o.log(`${pair.name.padEnd(15)} $${(usd / 1e6).toFixed(2).padStart(6)}M ${row.provider.padEnd(14)} ${row.variant.padEnd(9)} ${row.ok ? `out ${row.unitOut?.toPrecision(6)} /unit, cost ${row.costVsOracleBps} bps${row.providerSlippageBps !== undefined ? `, provider ${row.providerSlippageBps} bps` : ""}${row.parts ? `, parts ${row.parts}` : ""}${row.etaSeconds ? `, eta ${row.etaSeconds}s` : ""}` : `REFUSED ${row.error}`} (${row.ms} ms)`);
        }
        await sleep(o.pauseMs);
      }
    }
  }
  // price impact against the same provider's / variant's $100K quote
  const baseline = new Map<string, number>();
  for (const r of rows) if (r.ok && r.usd === Math.min(...o.sizes) && r.unitOut) baseline.set(`${r.pair}|${r.provider}|${r.variant}`, r.unitOut);
  for (const r of rows) { const b = baseline.get(`${r.pair}|${r.provider}|${r.variant}`) ?? baseline.get(`${r.pair}|${r.provider}|single`); if (r.ok && r.unitOut && b) r.impactBps = Math.round((1 - r.unitOut / b) * 10000); }
  notes.push("Read-only quotes; nothing was sent, signed or funded. Impact = output per unit against the same provider's smallest-size quote; cost = output per unit against the Chainlink oracle rate (fees + impact).");
  notes.push("A refusal at a size is this order's size, not a health incident (spec §2): Chainflip answers 400 'insufficient liquidity' above its depth; THORChain quotes any size but streams it.");
  return { at: new Date().toISOString(), feeds, sizesUsd: o.sizes, pauseMs: o.pauseMs, rows, notes };
}

export function toMarkdown(res: LabResult): string {
  const f = (x: number | undefined, d = 0) => (x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d));
  const money = (usd: number) => (usd >= 1e6 ? `$${(usd / 1e6).toFixed(usd % 1e6 ? 1 : 0)}M` : `$${(usd / 1e3).toFixed(0)}K`);
  const lines: string[] = [];
  lines.push(`# Whale execution lab — ${res.at}`, "");
  lines.push(`Prices (Chainlink via public RPC): ${res.feeds.map((x) => `${x.symbol} $${x.usd.toFixed(x.usd > 100 ? 0 : 4)} (${x.ageSeconds} s old)`).join(" · ")}`, "");
  for (const n of res.notes) lines.push(`> ${n}`);
  lines.push("");
  const pairs = [...new Set(res.rows.map((r) => r.pair))];
  for (const p of pairs) {
    lines.push(`## ${p}`, "", "| size | provider | plan | output / unit | impact bps | cost vs oracle bps | provider bps | ETA | parts | notes |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const r of res.rows.filter((x) => x.pair === p)) {
      const notes = [r.lowLiquidity ? "low liquidity" : "", r.recommendedSlippagePct !== undefined ? `rec. slippage ${r.recommendedSlippagePct} %` : "", r.limits ? Object.entries(r.limits).map(([k, v]) => `${k} ${v}`).join(", ") : "", r.maxParts ? `max parts ${r.maxParts}` : ""].filter(Boolean).join("; ");
      lines.push(`| ${money(r.usd)} | ${r.provider} | ${r.variant} | ${r.ok ? r.unitOut?.toPrecision(6) : `refused: ${r.error}`} | ${f(r.impactBps)} | ${f(r.costVsOracleBps)} | ${f(r.providerSlippageBps)} | ${r.etaSeconds ? `${Math.round(r.etaSeconds / 60)} min` : "—"} | ${r.parts ?? "—"} | ${notes} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---- CLI ----
const isMain = process.argv[1] && /whaleLab\.(ts|js|mjs)$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const sizes = opt("sizes") ? opt("sizes")!.split(",").map(Number) : SIZES_USD;
  const pairNames = opt("pairs")?.split(",");
  const pairs = pairNames ? PAIRS.filter((p) => pairNames.includes(p.name)) : PAIRS;
  const pauseMs = Number(opt("pause") ?? 1500);
  runLab({ sizes, pairs, pauseMs, log: (s) => console.log(s) }).then((res) => {
    if (opt("json")) writeFileSync(opt("json")!, JSON.stringify(res, null, 2) + "\n");
    if (opt("md")) writeFileSync(opt("md")!, toMarkdown(res));
    console.log(`\n${res.rows.length} rows, ${res.rows.filter((r) => r.ok).length} quoted, ${res.rows.filter((r) => !r.ok).length} refused`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
