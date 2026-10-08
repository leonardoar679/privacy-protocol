#!/usr/bin/env node
// Whale research (plan V2 §118): what large transfers look like on public decentralized rails, from
// public data only — THORChain's Midgard swap history (the last N swap actions: sizes in USD, the share
// that streamed, the streaming parameters of the largest, their slippage), its daily volume, Mayan's
// public stats overview and Across's public deposits feed (both recorded as they answer, not
// interpreted beyond their own field names). Nothing here identifies anyone: a THORChain "address" is a
// service, an aggregator, a custodian or a contract as often as a person (the document's own caveat).
// Usage: node research.mjs [--pages 40] [--json research.json] [--md whale-research.md]
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const PAGES = Number(opt("pages", 40));
const MIDGARD = [process.env.MIDGARD_URL, "https://gateway.liquify.com/chain/thorchain_midgard", "https://midgard.ninerealms.com", "https://midgard.thorswap.net"].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, timeoutMs = 25000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
async function midgard(path) {
  let lastErr;
  for (const base of MIDGARD) {
    try { const { status, data } = await getJson(base + path); if (status === 200 && typeof data === "object") return { base, data }; lastErr = new Error(`HTTP ${status} from ${base}`); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
const assetOf = (coins) => coins?.[0]?.asset ?? "?";

/** The last N swap actions, optionally on one asset (the unfiltered feed covers only a couple of hours of a 200K-swaps/day network; the BTC and ETH feeds reach further back). */
async function thorchainSwaps(asset = "") {
  const actions = [];
  let token = null, base = null;
  for (let page = 0; page < PAGES; page++) {
    const path = `/v2/actions?type=swap&limit=50${asset ? `&asset=${encodeURIComponent(asset)}` : ""}${token ? `&nextPageToken=${token}` : page ? `&offset=${page * 50}` : ""}`;
    const r = await midgard(path);
    base = r.base;
    const batch = r.data.actions ?? [];
    if (!batch.length) break;
    actions.push(...batch);
    token = r.data.meta?.nextPageToken ?? null;
    await sleep(300);
  }
  const swaps = actions.filter((a) => a.status === "success" && a.metadata?.swap).map((a) => {
    const m = a.metadata.swap, sm = m.streamingSwapMeta;
    const inCoin = a.in?.[0]?.coins?.[0];
    const inUsd = inCoin ? (Number(inCoin.amount) / 1e8) * Number(m.inPriceUSD ?? 0) : 0;
    const streamed = !!(m.isStreamingSwap || (sm && Number(sm.quantity ?? 0) > 1));
    return {
      date: new Date(Number(BigInt(a.date) / 1000000n)).toISOString(), height: Number(a.height), pair: `${assetOf(a.in?.[0]?.coins)} → ${assetOf(a.out?.[0]?.coins)}`,
      inUsd: Math.round(inUsd), streamed, quantity: sm ? Number(sm.quantity) : undefined, interval: sm ? Number(sm.interval) : undefined, count: sm ? Number(sm.count) : undefined,
      durationSeconds: sm && sm.lastHeight ? (Number(sm.lastHeight) - Number(a.height)) * 6 : undefined, slipBps: m.swapSlip !== undefined ? Number(m.swapSlip) : undefined, outs: a.out?.length ?? 0,
    };
  });
  const sorted = swaps.map((s) => s.inUsd).sort((a, b) => a - b);
  const big = swaps.filter((s) => s.inUsd >= 1_000_000), mid = swaps.filter((s) => s.inUsd >= 100_000);
  const median = (xs) => quantile([...xs].sort((a, b) => a - b), 0.5);
  return {
    asset: asset || "all", source: base, actionsRead: actions.length, swaps: swaps.length, from: swaps.at(-1)?.date, to: swaps[0]?.date,
    usd: { p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), p99: quantile(sorted, 0.99), max: sorted.at(-1) ?? 0, totalUsd: sorted.reduce((a, b) => a + b, 0) },
    countsOver: { "100K": mid.length, "1M": big.length },
    streamedShare: { all: swaps.filter((s) => s.streamed).length / Math.max(1, swaps.length), over100K: mid.filter((s) => s.streamed).length / Math.max(1, mid.length), over1M: big.filter((s) => s.streamed).length / Math.max(1, big.length) },
    streamedOver1M: { medianQuantity: median(big.filter((s) => s.streamed && s.quantity).map((s) => s.quantity)), medianInterval: median(big.filter((s) => s.streamed && s.interval).map((s) => s.interval)), medianDurationSeconds: median(big.filter((s) => s.streamed && s.durationSeconds).map((s) => s.durationSeconds)) },
    top: [...swaps].sort((a, b) => b.inUsd - a.inUsd).slice(0, 10),
  };
}

async function thorchainDaily() {
  const r = await midgard("/v2/history/swaps?interval=day&count=30");
  const intervals = (r.data.intervals ?? []).map((i) => ({ day: new Date(Number(i.startTime) * 1000).toISOString().slice(0, 10), count: Number(i.totalCount ?? 0), volumeUsd: Math.round((Number(i.totalVolume ?? 0) / 1e8) * Number(i.runePriceUSD ?? 0)) }));
  const meta = r.data.meta ?? {};
  return { source: r.base, days: intervals.length, totalCount: Number(meta.totalCount ?? 0), totalVolumeUsd: Math.round((Number(meta.totalVolume ?? 0) / 1e8) * Number(meta.runePriceUSD ?? 0)), intervals };
}

async function bestEffort(name, url) {
  try {
    const { status, data } = await getJson(url);
    if (status !== 200) return { name, url, status, note: `HTTP ${status}` };
    const sample = Array.isArray(data) ? data[0] : data;
    const out = { name, url, status, keys: sample && typeof sample === "object" ? Object.keys(sample).slice(0, 40) : [], items: Array.isArray(data) ? data.length : undefined, data: JSON.stringify(data).length < 4000 ? data : undefined };
    // Across deposits carry inputAmount + inputPriceUsd: the USD size of each listed deposit
    if (Array.isArray(data) && data[0]?.inputPriceUsd !== undefined) {
      // the feed names the token by address only; decimals are inferred from the price class (stablecoins 6, BTC-priced 8, else 18) — approximate
      const decimalsOf = (d) => { const p = Number(d.inputPriceUsd); return p > 10_000 ? 8 : p > 0.9 && p < 1.1 ? 6 : 18; };
      const sizes = data.map((d) => (Number(d.inputAmount) / 10 ** decimalsOf(d)) * Number(d.inputPriceUsd)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      out.usd = { items: sizes.length, p50: quantile(sizes, 0.5), p90: quantile(sizes, 0.9), max: sizes.at(-1) ?? 0, statuses: [...new Set(data.map((d) => d.status))], note: "decimals inferred from the price class; approximate" };
    }
    return out;
  } catch (e) { return { name, url, note: String(e).slice(0, 200) }; }
}

const f = (x) => (x === undefined || Number.isNaN(x) ? "—" : x.toLocaleString("en-US"));
const pct = (x) => `${(100 * x).toFixed(1)} %`;
function markdown(res) {
  const d = res.thorchainDaily;
  const lines = [`# Whale research — ${res.at}`, "", "> Public data only. A label on a chain is a service, an aggregator, a custodian or a contract as often as a person; nothing here identifies anyone. Sizes are what the rails already carry, not who carries them.", ""];
  for (const t of res.thorchain ?? []) {
    lines.push(`## THORChain — the last ${t.swaps} successful swaps${t.asset === "all" ? "" : ` on ${t.asset}`} (${t.from?.slice(0, 16).replace("T", " ")} → ${t.to?.slice(0, 16).replace("T", " ")}, Midgard ${t.source})`, "",
      `- Size in USD: median $${f(t.usd.p50)}, p90 $${f(t.usd.p90)}, p99 $${f(t.usd.p99)}, largest $${f(t.usd.max)}; ${t.countsOver["100K"]} swaps ≥ $100K, ${t.countsOver["1M"]} ≥ $1M.`,
      `- Streamed: ${pct(t.streamedShare.all)} of all swaps, ${pct(t.streamedShare.over100K)} of those ≥ $100K, ${pct(t.streamedShare.over1M)} of those ≥ $1M.`,
      `- Streams ≥ $1M: median quantity ${f(t.streamedOver1M.medianQuantity)} sub-swaps, median interval ${f(t.streamedOver1M.medianInterval)} blocks, median duration ${t.streamedOver1M.medianDurationSeconds ? Math.round(t.streamedOver1M.medianDurationSeconds / 60) : "—"} min.`, "",
      "| date | pair | size | streamed | quantity × interval | count | duration | slip bps |", "|---|---|---|---|---|---|---|---|");
    for (const s of t.top) lines.push(`| ${s.date.slice(0, 16).replace("T", " ")} | ${s.pair} | $${f(s.inUsd)} | ${s.streamed ? "yes" : "no"} | ${s.quantity ?? "—"} × ${s.interval ?? "—"} | ${s.count ?? "—"} | ${s.durationSeconds ? `${Math.round(s.durationSeconds / 60)} min` : "—"} | ${s.slipBps ?? "—"} |`);
    lines.push("");
  }
  if (d) lines.push(`## THORChain — daily (${d.days} days)`, "", `- ${f(d.totalCount)} swaps, $${f(d.totalVolumeUsd)} volume (RUNE-denominated volume at the day's RUNE price).`, "", "| day | swaps | volume USD |", "|---|---|---|", ...d.intervals.slice(-10).map((i) => `| ${i.day} | ${f(i.count)} | $${f(i.volumeUsd)} |`), "");
  for (const b of res.bestEffort) {
    lines.push(`## ${b.name} (best effort)`, "", `- ${b.url}: ${b.note ?? `HTTP ${b.status}`}${b.items !== undefined ? `, ${b.items} items` : ""}${b.keys?.length ? `; fields: ${b.keys.join(", ")}` : ""}`, "");
    if (b.usd) lines.push(`- Size in USD of the ${b.usd.items} listed deposits: median $${f(Math.round(b.usd.p50))}, p90 $${f(Math.round(b.usd.p90))}, largest $${f(Math.round(b.usd.max))} (statuses: ${b.usd.statuses.join(", ")}).`, "");
    if (b.data) lines.push("```json", JSON.stringify(b.data, null, 1).slice(0, 2500), "```", "");
  }
  for (const e of res.errors) lines.push(`> ${e}`);
  return lines.join("\n") + "\n";
}

const res = { at: new Date().toISOString(), errors: [], bestEffort: [], thorchain: [] };
for (const asset of ["", "BTC.BTC", "ETH.ETH"]) {
  try { res.thorchain.push(await thorchainSwaps(asset)); } catch (e) { res.errors.push(`THORChain actions${asset ? ` (${asset})` : ""}: ${String(e).slice(0, 200)}`); }
}
try { res.thorchainDaily = await thorchainDaily(); } catch (e) { res.errors.push(`THORChain history: ${String(e).slice(0, 200)}`); }
res.bestEffort.push(await bestEffort("Mayan stats overview", "https://explorer-api.mayan.finance/v3/stats/overview"));
res.bestEffort.push(await bestEffort("Across deposits", "https://app.across.to/api/deposits?limit=50"));
writeFileSync(opt("json", join(here, "research.json")), JSON.stringify(res, null, 2) + "\n");
writeFileSync(opt("md", join(here, "whale-research.md")), markdown(res));
console.log(markdown(res));
