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
  kind: "privacy-protocol/trade-check/v2";
  from: { chain: string; symbol: string };
  to: { chain: string; symbol: string };
  /** one significant digit, in the asset (the eighth review round, C-M3: three had matched the escrow funded minutes later) */
  amount: string;
  /** one significant digit, when valued */
  usd?: string;
  tier: Tier;
  preference?: string;
  /** the route's mode only, never its parts, interval, ETA or impact (the memo that lands carries those) — nor the score's components, which
   *  re-encode the ETA and the impact (the ninth review round, B-F9): its total alone */
  chosen?: { provider: string; plan?: { mode: ExecutionPlan["mode"] }; nativeAssets: boolean; linkPublic?: boolean; total?: number };
  /** each provider's answer as a closed code, never its words (they carried exact amounts and addresses) */
  competition: { provider: string; outcome: string; reason?: ReasonCode }[];
  lint: { id: string; level: string; category: string }[];
  /** V3 (High-Value Protection spec §16): the protection plan — class, band, cap, steps, gate, ELPF, concentration; never an amount in base units, never an address */
  /** `steps` as a band (B-F9): capped pieces had made the count the amount divided by the cap */
  protection?: { riskClass: string; custody: string; bandBps: [number, number]; capBps: number; steps: string; gate: string; concurrency: string; concentration: string; staged: boolean };
}

/** A provider's answer as one of a few codes (C-M3): its own words carried exact base-unit amounts and addresses. */
export type ReasonCode = "liquidity" | "minimum" | "limit" | "halted" | "timeout" | "unsupported" | "filtered" | "other";
export function reasonCode(reason: string): ReasonCode {
  if (/halt|pause/i.test(reason)) return "halted";
  if (/timed? ?out|timeout|aborted/i.test(reason)) return "timeout";
  if (/liquidity|insufficient|impact/i.test(reason)) return "liquidity";
  if (/minimum|too small|below|dust/i.test(reason)) return "minimum";
  if (/limit|above|too (large|high)|exceed/i.test(reason)) return "limit";
  if (/not supported|does not (support|list|serve)|not offered|cannot|unsupported|not implemented/i.test(reason)) return "unsupported";
  if (/filtered|skipped|breaker/i.test(reason)) return "filtered";
  return "other";
}

/** Round to `digits` significant digits, as a plain decimal string ("1360" → "1360", "1364.2" → "1360", "0.030012" → "0.03"). */
export function roundSignificant(value: number | string, digits = 3): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  const r = Number(n.toPrecision(digits));
  return r.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

/**
 * Shapes that must never leave for the provider: EVM addresses and hashes with or without 0x, bech32 and privacy addresses in either
 * case (the QR code's uppercase form is valid), base58check, Solana addresses and signatures, a secret as a long decimal. The eighth
 * review round (2026-11-03, C-L4): uppercase bech32, an uppercase privacy address, a bare hex address or txid and a Solana signature
 * had all gone through.
 */
const SHAPES = String.raw`(?:0x)?[0-9a-fA-F]{64}|(?:0x)?[0-9a-fA-F]{40}|\b(?:bc1|tb1|pp1)[0-9a-z]{20,}|\b(?:BC1|TB1|PP1)[0-9A-Z]{20,}|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\b[1-9A-HJ-NP-Za-km-z]{43,44}\b|\b[1-9A-HJ-NP-Za-km-z]{86,88}\b|\b\d{60,}\b`;
export const ADDRESS_LIKE = new RegExp(SHAPES);
/** Every match, for masking (a non-global replace had masked the first address only). */
const ADDRESS_LIKE_ALL = new RegExp(SHAPES, "g");
export const maskAddresses = (s: string): string => s.replace(ADDRESS_LIKE_ALL, "[address]");

/** Whether a text holds a run of 12 or more recovery-phrase words (BIP-39's English list): a phrase pasted "to check it". */
export function looksLikePhrase(text: string, words: readonly string[]): boolean {
  const known = new Set(words);
  let run = 0;
  for (const w of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    run = known.has(w) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}

/** Throws when any string inside the summary looks like an address, a hash or an identity. */
export function assertSanitized(x: unknown, path = "summary"): void {
  if (typeof x === "string") { if (ADDRESS_LIKE.test(x)) throw new Error(`the trade summary carries an address-like value at ${path}`); return; }
  if (Array.isArray(x)) { x.forEach((v, i) => assertSanitized(v, `${path}[${i}]`)); return; }
  if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) assertSanitized(v, `${path}.${k}`);
}

/** A step count as a band (B-F9). */
export const stepsBand = (n: number): string => (n <= 1 ? "1" : n <= 5 ? "2-5" : n <= 20 ? "6-20" : n <= 100 ? "21-100" : "over 100");

export function tradeSummary(i: {
  from: { chain: string; symbol: string; decimals: number }; to: { chain: string; symbol: string; decimals: number }; amountUnits: bigint; usd?: number | null; tier: Tier; preference?: string;
  chosen?: { provider: string; score?: RouteScore; quote: { plan?: ExecutionPlan; etaSeconds: number; impactBps?: number; nativeAssets: boolean; toAmountMin: string }; linkPublic?: boolean } | null;
  competition?: CompetitionEntry[] | null; lint?: LintItem[] | null; protection?: Protection | null;
}): TradeSummary {
  // one significant digit (the eighth review round, 2026-11-03, C-M3): the summary is read by the provider, from this IP, minutes before
  // the escrow is funded — three digits, the route's plan, ETA and impact had matched the swap that landed
  const units = (u: bigint | string, d: number) => roundSignificant(Number(BigInt(u)) / 10 ** d, 1);
  const amount = units(i.amountUnits, i.from.decimals);
  const exact = Number(i.amountUnits) / 10 ** i.from.decimals;
  const s: TradeSummary = {
    kind: "privacy-protocol/trade-check/v2",
    from: { chain: i.from.chain, symbol: i.from.symbol },
    to: { chain: i.to.chain, symbol: i.to.symbol },
    amount,
    // the value of the rounded amount, never of the exact one, and no minimum received nor expected loss beside it (the tenth review round,
    // B10-12): four one-digit figures of one amount had pinned it to ±2.5–7 % together
    ...(typeof i.usd === "number" && exact > 0 ? { usd: roundSignificant((i.usd * Number(amount)) / exact, 1) } : {}),
    tier: i.tier,
    ...(i.preference ? { preference: i.preference } : {}),
    ...(i.chosen ? { chosen: { provider: i.chosen.provider, ...(i.chosen.quote.plan ? { plan: { mode: i.chosen.quote.plan.mode } } : {}), nativeAssets: i.chosen.quote.nativeAssets, linkPublic: i.chosen.linkPublic, ...(i.chosen.score ? { total: Math.round(i.chosen.score.total) } : {}) } } : {}),
    competition: (i.competition ?? []).map((c) => ({ provider: c.provider, outcome: c.outcome, ...(c.reason ? { reason: reasonCode(c.reason) } : {}) })),
    lint: (i.lint ?? []).map((l) => ({ id: l.id, level: l.level, category: l.category })),
    ...(i.protection ? { protection: { riskClass: i.protection.riskClass, custody: i.protection.custody, bandBps: i.protection.bandBps, capBps: i.protection.capBps, steps: stepsBand(i.protection.estimatedTranches), gate: i.protection.gate, concurrency: i.protection.concurrency, concentration: i.protection.concentration.singleVenue ? "single venue" : `${i.protection.concentration.providers.length} venues, share cap ${i.protection.concentration.capBps / 100} %`, staged: i.protection.staged } } : {}),
  };
  assertSanitized(s);
  return s;
}

export interface TradeCheck { bestRoute: string; alternative: string; estimatedSavings: string; privacy: string; execution: string; risk: string; /** the lines not shown: they used a word this wallet never uses (H11-6) */ withheld?: TradeCheckLine[] }
export type TradeCheckLine = "bestRoute" | "alternative" | "estimatedSavings" | "privacy" | "execution" | "risk";
const LINES: readonly TradeCheckLine[] = ["bestRoute", "alternative", "estimatedSavings", "privacy", "execution", "risk"];
/**
 * The words this wallet never says (spec §18; apps/web/eslint.config.js FORBIDDEN), "atomic" (plan §79) and a 100 % claim of privacy or safety
 * (spec §18; the critique, K3-6): named to the model, held to after.
 */
export const TRADE_CHECK_FORBIDDEN =
  /\b(atomic(ally)?|anonym\w*|mix(er|ers|ing)|untraceabl\w*|undetectabl\w*|invisibl\w*|impossible to trace)\b|\b100\s?(%|percent)\s*(private|privacy|anonymous|untraceable|safe|safety|secure|protected|unlinkable)/i;
/**
 * The model's answer held to the wallet's words before it is shown (the eleventh review round, 2026-11-04, H11-6): a line that uses one is
 * withheld — the Review shows it under the wallet's own labels, and nothing had held "works like a mixer… untraceable" back.
 */
export function holdToWords(c: TradeCheck): TradeCheck {
  const withheld = LINES.filter((k) => TRADE_CHECK_FORBIDDEN.test(c[k]));
  if (!withheld.length) return c;
  const out: TradeCheck = { ...c, withheld };
  for (const k of withheld) out[k] = "";
  return out;
}

export const TRADE_CHECK_SYSTEM = [
  "You are the trade checker of a privacy wallet. You receive a sanitized summary of a planned cross-chain swap: assets, rounded amounts, the value tier, the chosen route with its execution mode and total score, what every provider answered (the competition record), the wallet's privacy check items and, for a large order, the protection plan (risk class, tranche band, exposure cap, a band of steps, settlement gate, expected loss per failure, concentration).",
  "You recommend, compare, explain and warn. You cannot sign, withdraw, change a destination or override a check, and you never ask for addresses, keys, phrases or balances.",
  "Answer with one JSON object and nothing else, with exactly these keys, each a short plain sentence: bestRoute, alternative, estimatedSavings, privacy, execution, risk. Never use the words atomic, anonymous, anonymity, mixer, mixing, untraceable, undetectable or invisible, never claim 100 % privacy or safety, and promise nothing about privacy: say what is reduced and what stays public.",
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

/**
 * Send the sanitized summary to the private session and read the structured answer — through the inference transport unless a
 * caller hands its own fetch (audit round 2, n51/n73): the global fetch had been the default, outside the policy (no allowlist,
 * no announcement for the leakage gate, no no-store or no-referrer).
 */
export async function checkTrade(access: InferenceAccess, model: string, summary: TradeSummary, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<TradeCheck> {
  assertSanitized(summary);
  let text = "";
  for await (const chunk of chatStream(access, model, tradeCheckMessages(summary), signal, fetchImpl)) text += chunk;
  return holdToWords(parseTradeCheck(text)); // the answer held to the wallet's words before any screen shows it (H11-6)
}
