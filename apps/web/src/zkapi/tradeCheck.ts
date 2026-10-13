// "Check this trade" on Private AI (whale spec §22; plan V2 §34–§37, §77–§80): the Review screen can send
// a SANITIZED summary of a trade — assets, amounts rounded to three significant digits, the tier, the
// chosen route's plan and components, the competition record, the lint items — to the private inference
// session the user opened under Private AI, and show the answer as best route / alternative / estimated
// savings / privacy / execution / risk. No address, no identity, no note data ever leaves: the summary is
// checked against address shapes before it is sent. The assistant recommends, simulates, explains,
// compares and warns; it signs nothing, withdraws nothing, changes no destination and overrides no check
// (plan §78): this module imports nothing that signs or submits, and a test pins that.
import { chatStream, type ChatMessage, type InferenceAccess } from "./policy";
import type { CompetitionEntry, ExecutionPlan, Protection, RouteScore } from "@privacy-wallet/sdk/swapService";
import type { LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";

export interface TradeSummary {
  kind: "privacy-protocol/trade-check/v1";
  from: { chain: string; symbol: string };
  to: { chain: string; symbol: string };
  /** three significant digits, in the asset */
  amount: string;
  /** three significant digits, when valued */
  usd?: string;
  tier: Tier;
  preference?: string;
  chosen?: { provider: string; plan?: ExecutionPlan; etaSeconds: number; impactBps?: number; nativeAssets: boolean; linkPublic?: boolean; components?: RouteScore["components"]; total?: number; receiveMinRounded: string };
  competition: { provider: string; outcome: string; reason?: string; ms: number }[];
  lint: { id: string; level: string; category: string }[];
  /** V3 (High-Value Protection spec §16): the protection plan — class, band, cap, steps, gate, ELPF, concentration; never an amount in base units, never an address */
  protection?: { riskClass: string; custody: string; bandBps: [number, number]; capBps: number; steps: number; gate: string; concurrency: string; elpfUsd?: string; concentration: string; staged: boolean };
}

/** Round to `digits` significant digits, as a plain decimal string ("1360" → "1360", "1364.2" → "1360", "0.030012" → "0.03"). */
export function roundSignificant(value: number | string, digits = 3): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  const r = Number(n.toPrecision(digits));
  return r.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

/** Shapes that must never appear in a summary: EVM, bech32, base58check, Solana base58, privacy addresses, hashes. */
export const ADDRESS_LIKE = /0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64}|\bbc1[0-9a-z]{20,}|\btb1[0-9a-z]{20,}|\bpp1[0-9a-z]{20,}|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/;

/** Throws when any string inside the summary looks like an address, a hash or an identity. */
export function assertSanitized(x: unknown, path = "summary"): void {
  if (typeof x === "string") { if (ADDRESS_LIKE.test(x)) throw new Error(`the trade summary carries an address-like value at ${path}`); return; }
  if (Array.isArray(x)) { x.forEach((v, i) => assertSanitized(v, `${path}[${i}]`)); return; }
  if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) assertSanitized(v, `${path}.${k}`);
}

export function tradeSummary(i: {
  from: { chain: string; symbol: string; decimals: number }; to: { chain: string; symbol: string; decimals: number }; amountUnits: bigint; usd?: number | null; tier: Tier; preference?: string;
  chosen?: { provider: string; score?: RouteScore; quote: { plan?: ExecutionPlan; etaSeconds: number; impactBps?: number; nativeAssets: boolean; toAmountMin: string }; linkPublic?: boolean } | null;
  competition?: CompetitionEntry[] | null; lint?: LintItem[] | null; protection?: Protection | null;
}): TradeSummary {
  const units = (u: bigint | string, d: number) => roundSignificant(Number(BigInt(u)) / 10 ** d);
  const s: TradeSummary = {
    kind: "privacy-protocol/trade-check/v1",
    from: { chain: i.from.chain, symbol: i.from.symbol },
    to: { chain: i.to.chain, symbol: i.to.symbol },
    amount: units(i.amountUnits, i.from.decimals),
    ...(typeof i.usd === "number" ? { usd: roundSignificant(i.usd) } : {}),
    tier: i.tier,
    ...(i.preference ? { preference: i.preference } : {}),
    ...(i.chosen ? { chosen: { provider: i.chosen.provider, plan: i.chosen.quote.plan, etaSeconds: i.chosen.quote.etaSeconds, impactBps: i.chosen.quote.impactBps, nativeAssets: i.chosen.quote.nativeAssets, linkPublic: i.chosen.linkPublic, ...(i.chosen.score ? { components: i.chosen.score.components, total: i.chosen.score.total } : {}), receiveMinRounded: units(i.chosen.quote.toAmountMin, i.to.decimals) } } : {}),
    competition: (i.competition ?? []).map((c) => ({ provider: c.provider, outcome: c.outcome, ...(c.reason ? { reason: c.reason.replace(ADDRESS_LIKE, "[address]") } : {}), ms: c.ms })),
    lint: (i.lint ?? []).map((l) => ({ id: l.id, level: l.level, category: l.category })),
    ...(i.protection ? { protection: { riskClass: i.protection.riskClass, custody: i.protection.custody, bandBps: i.protection.bandBps, capBps: i.protection.capBps, steps: i.protection.estimatedTranches, gate: i.protection.gate, concurrency: i.protection.concurrency, ...(i.protection.elpf.perCampaignUsd !== null ? { elpfUsd: roundSignificant(i.protection.elpf.perCampaignUsd) } : {}), concentration: i.protection.concentration.singleVenue ? "single venue" : `${i.protection.concentration.providers.length} venues, share cap ${i.protection.concentration.capBps / 100} %`, staged: i.protection.staged } } : {}),
  };
  assertSanitized(s);
  return s;
}

export interface TradeCheck { bestRoute: string; alternative: string; estimatedSavings: string; privacy: string; execution: string; risk: string }

export const TRADE_CHECK_SYSTEM = [
  "You are the trade checker of a privacy wallet. You receive a sanitized summary of a planned cross-chain swap: assets, rounded amounts, the value tier, the chosen route with its execution plan and score components, what every provider answered (the competition record), the wallet's privacy check items and, for a large order, the protection plan (risk class, tranche band, exposure cap, steps, settlement gate, expected loss per failure, concentration).",
  "You recommend, compare, explain and warn. You cannot sign, withdraw, change a destination or override a check, and you never ask for addresses, keys, phrases or balances.",
  "Answer with one JSON object and nothing else, with exactly these keys, each a short plain sentence: bestRoute, alternative, estimatedSavings, privacy, execution, risk. Never use the words atomic or anonymous.",
].join(" ");

export const tradeCheckMessages = (s: TradeSummary): ChatMessage[] => [{ role: "system", content: TRADE_CHECK_SYSTEM }, { role: "user", content: JSON.stringify(s) }];

/** The answer as the six lines of plan §79; prose around the JSON is tolerated, no JSON at all becomes the bestRoute line. */
export function parseTradeCheck(text: string): TradeCheck {
  const empty: TradeCheck = { bestRoute: "", alternative: "", estimatedSavings: "", privacy: "", execution: "", risk: "" };
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as Partial<Record<keyof TradeCheck, unknown>>;
      const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
      return { bestRoute: str(j.bestRoute), alternative: str(j.alternative), estimatedSavings: str(j.estimatedSavings), privacy: str(j.privacy), execution: str(j.execution), risk: str(j.risk) };
    } catch { /* not JSON after all */ }
  }
  return { ...empty, bestRoute: text.trim() };
}

/** Send the sanitized summary to the private session and read the structured answer. */
export async function checkTrade(access: InferenceAccess, model: string, summary: TradeSummary, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<TradeCheck> {
  assertSanitized(summary);
  let text = "";
  for await (const chunk of chatStream(access, model, tradeCheckMessages(summary), signal, fetchImpl)) text += chunk;
  return parseTradeCheck(text);
}
