// The policy benchmark (High-Value Execution Engine plan §119–§123; contract §9): the campaign lab run over the sizes
// $1M / $5M / $10M / $25M / $50M, the cap variants — one execution, 5 %, 2.5 %, 1 % — and the §119 conditions (volatility,
// liquidity, the provider's health, the destination chain), reporting the plan's §122 columns: order size, risk tier,
// exposure %, the number of external executions, the completion time, the expected loss, the worst-case loss, the
// privacy score and the cost (gas at the price the runner fetched, never a constant; plus the price-impact cost of the
// pieces). The §120 privacy matrix comes from the whale UTXO lab's rows and the privacy assessment. The §123 decision
// follows a stated rule. Read-only; seeded; nothing here is live.
// Usage: npx tsx src/sim/policyBenchmark.ts --execution ../../benchmarks/whale/execution.json --utxo ../../benchmarks/whale/utxo-10m.json [--json out.json] [--md out.md] [--gwei X --eth-usd Y]
import { readFileSync, writeFileSync } from "fs";
import { routesFromExecution, simulateCampaign, type RouteSpec, type SimRow } from "./campaignLab";
import { assessPrivacy } from "../wallet/privacyAssessment";
import { exposureTierOf } from "../wallet/exposurePolicy";
import { riskModelOf } from "../wallet/riskClasses";
import { bucketsFor } from "../wallet/amounts";
import { CADENCE } from "./campaignLab";

export const SIZES = [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000];
export type CapVariant = "one-trade" | "500" | "250" | "100";
export const CAP_VARIANTS: CapVariant[] = ["one-trade", "500", "250", "100"];
export interface Conditions { volatility: "low" | "high"; liquidity: "deep" | "thin"; provider: "healthy" | "degraded" }
export const CALM: Conditions = { volatility: "low", liquidity: "deep", provider: "healthy" };
/** the provider's cover traffic (swaps/hour on a typical pair) the privacy assessment uses — the engine's static estimates (DEFAULT_PROVIDER_THROUGHPUT) */
const COVER_PER_HOUR: Record<string, number> = { thorchain: 60, chainflip: 30, mayan: 60, "near-intents": 40, lifi: 100, "uniswap-across": 100 };

export interface BenchRow {
  sizeUsd: number; pair: string; provider: string; variant: CapVariant; conditions: Conditions;
  riskTier: string; exposureBps: number; executions: number; completionHours: number;
  expectedLossUsd: number; worstCaseLossUsd: number; privacyScore: number; privacyLevel: string;
  gasUnits: number; impactCostUsd: number; /** the route states an impact figure at these sizes (else the impact cost is not measurable) */ impactStated: boolean; pauses: number; completed: boolean; invariantsHeld: boolean;
}

/** One cell of the matrix. */
export function benchRow(route: RouteSpec, prices: Record<string, number>, sizeUsd: number, variant: CapVariant, cond: Conditions, seed: number): BenchRow {
  const one = variant === "one-trade";
  const capBps = one ? 10000 : Number(variant);
  // the band follows the cap (half the cap to the cap) so each variant's pieces scale with its exposure; the baseline is the whole order as one piece
  const base = { sizeUsd, route, mode: "balanced" as const, sizing: "varied" as const, priceUsd: prices[route.from.symbol], seed, capBpsOverride: capBps, ...(one ? { bandOverride: [10000, 10000] as [number, number], ignoreImpact: true, singlePiece: true } : { bandOverride: [Math.max(50, Math.floor(capBps / 2)), capBps] as [number, number] }), impactMultiplier: cond.liquidity === "thin" ? 4 : 1, etaMultiplier: cond.liquidity === "thin" ? 2 : 1, reliability: cond.provider === "degraded" ? 70 : 90 };
  // the conditions that are events: a price spike (high volatility) or a provider outage (degraded) at a random step
  const probe = simulateCampaign(base);
  const steps = Math.max(1, probe.tranches);
  const at = Math.floor((seed % 997) / 997 * steps);
  const row: SimRow = cond.volatility === "high" ? simulateCampaign({ ...base, fault: "price-spike", faultAt: at }) : cond.provider === "degraded" ? simulateCampaign({ ...base, fault: "provider-outage", faultAt: at }) : probe;
  const model = riskModelOf(route.provider, { plan: { mode: route.planMode } }, route.from, route.to, "balanced");
  const tier = one ? "none (one execution)" : exposureTierOf(model, { planMode: route.planMode, thinMarket: cond.liquidity === "thin", incidentWithinDays: null }).tier;
  const decimals = route.from.decimals;
  const alphabet = bucketsFor(decimals);
  const bucketish = (x: bigint) => alphabet.includes(x) || alphabet.some((p) => alphabet.some((q) => q * 10n >= p && p + q === x));
  const pieces = row.pieceUnits.map((p) => BigInt(p));
  const allBuckets = pieces.length > 1 && pieces.slice(0, -1).every(bucketish);
  const privacy = assessPrivacy({
    sourceIsPool: true, amount: { kind: one ? "exact" : allBuckets ? "bucket" : "pair", uniqueness: 0.9 }, delaySeconds: one ? 3600 : CADENCE.balanced[0], destination: one ? "fresh" : "fresh-per-tranche", steps: pieces.length,
    provider: { linkPublic: true, kind: route.provider === "thorchain" || route.provider === "chainflip" || route.provider === "near-intents" ? "deposit-address" : route.provider === "mayan" ? "signed-intent" : "aggregator-api", coverPerHour: COVER_PER_HOUR[route.provider] ?? 50, etaSeconds: route.measured[0]?.etaSeconds ?? 600 },
    crossChain: route.to.chain !== route.from.chain, sameSizeConsecutive: pieces.some((p, i) => i > 0 && p === pieces[i - 1]), cadenceFixed: false,
  });
  const worst = one ? sizeUsd : row.maxInFlightUsd;
  return {
    sizeUsd, pair: route.pair, provider: route.provider, variant, conditions: cond, riskTier: tier, exposureBps: capBps, executions: row.handOvers, completionHours: row.wallHours,
    expectedLossUsd: row.pFailPrior * worst, worstCaseLossUsd: worst, privacyScore: privacy.score, privacyLevel: privacy.level,
    gasUnits: row.gasUnits, impactCostUsd: row.impactCostUsd, impactStated: route.measured.some((m) => m.impactBps !== undefined && m.impactBps > 0), pauses: row.pauses.length, completed: row.completed, invariantsHeld: row.invariantsHeld,
  };
}

export function runBenchmark(routes: RouteSpec[], prices: Record<string, number>, seed = 4242): { table: BenchRow[]; matrix: BenchRow[] } {
  const table: BenchRow[] = [];
  const matrix: BenchRow[] = [];
  let s = seed;
  const refs = [routes.find((r) => r.pair === "ETH>BTC" && r.provider === "thorchain"), routes.find((r) => r.family === "EVM→EVM" && r.provider === "uniswap-across")].filter((r): r is RouteSpec => !!r);
  // §121–§122: the cap variants over the sizes, calm conditions
  for (const route of refs) for (const sizeUsd of SIZES) for (const variant of CAP_VARIANTS) table.push(benchRow(route, prices, sizeUsd, variant, CALM, s++));
  // §119: the conditions at $10M under the 2.5 % default and the single trade
  for (const route of refs) for (const volatility of ["low", "high"] as const) for (const liquidity of ["deep", "thin"] as const) for (const provider of ["healthy", "degraded"] as const) {
    for (const variant of ["250", "one-trade"] as CapVariant[]) matrix.push(benchRow(route, prices, 10_000_000, variant, { volatility, liquidity, provider }, s++));
  }
  return { table, matrix };
}

/**
 * The plan's §123 rule, stated before the run: among the caps that complete $10M on the reference cross-chain route in calm
 * conditions within a week (168 h), the one with the smallest expected loss plus the protection's cost (gas at the run's
 * price plus the stated impact); the single execution is the baseline, never a candidate; no candidate → 2.5 % stays.
 */
export const TIME_BUDGET_HOURS = 168;
export function decideDefault(table: BenchRow[], gasUsd: (units: number) => number | null): { capBps: number; why: string } {
  const at = table.filter((r) => r.sizeUsd === 10_000_000 && r.pair === "ETH>BTC" && r.variant !== "one-trade" && r.completed && r.invariantsHeld);
  const cost = (r: BenchRow) => (gasUsd(r.gasUnits) ?? 0) + r.impactCostUsd;
  const total = (r: BenchRow) => r.expectedLossUsd + cost(r);
  const candidates = at.filter((r) => r.completionHours <= TIME_BUDGET_HOURS).sort((a, b) => total(a) - total(b));
  if (!candidates.length) return { capBps: 250, why: `no cap completes $10M within ${TIME_BUDGET_HOURS} h on the reference route: the default stays 2.5 %` };
  const pick = candidates[0];
  const others = at.filter((r) => r !== pick).map((r) => `${r.exposureBps / 100} %: ${Math.round(total(r))} USD${r.completionHours > TIME_BUDGET_HOURS ? ` but ${r.completionHours.toFixed(0)} h, over the budget` : ""}`).join("; ");
  return { capBps: pick.exposureBps, why: `${pick.exposureBps / 100} % completes $10M in ${pick.completionHours.toFixed(0)} h with an expected loss of ${Math.round(pick.expectedLossUsd)} USD and a cost of ${Math.round(cost(pick))} USD (${Math.round(total(pick))} USD together; ${others})` };
}

// ---- CLI ----
const isMain = process.argv[1] && /policyBenchmark\.(ts|js|mjs)$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k: string): string | null => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
  const executionPath = opt("execution") ?? "../../benchmarks/whale/execution.json";
  const j = JSON.parse(readFileSync(executionPath, "utf8"));
  const prices: Record<string, number> = Object.fromEntries((j.feeds as { symbol: string; usd: number }[]).map((f) => [f.symbol, f.usd]));
  const routes = routesFromExecution(j);
  const utxoPath = opt("utxo");
  const utxo = utxoPath ? JSON.parse(readFileSync(utxoPath, "utf8")) as { opts: { amountEth: number }; rows: { strategy: string; pieces: number; effTiming: number; effAmount: number; effJoint: number; unique: number; burstShare: number; gasUnits: number }[] } : null;
  const gwei = opt("gwei") ? Number(opt("gwei")) : null, ethUsd = opt("eth-usd") ? Number(opt("eth-usd")) : null;
  const gasUsd = (units: number) => (gwei !== null && ethUsd !== null ? units * gwei * 1e-9 * ethUsd : null);
  const { table, matrix } = runBenchmark(routes, prices, Number(opt("seed") ?? 4242));
  const decision = decideDefault(table, gasUsd);
  const money = (x: number) => "$" + Math.round(x).toLocaleString("en-US");
  const f = (x: number, d = 1) => x.toFixed(d);
  const impactWord = (r: BenchRow) => (r.impactStated ? `impact ${money(r.impactCostUsd)}` : "impact n/a (the provider states none)");
  const cost = (r: BenchRow) => (gasUsd(r.gasUnits) !== null ? `${money(gasUsd(r.gasUnits)! + r.impactCostUsd)} (gas ${money(gasUsd(r.gasUnits)!)} + ${impactWord(r)})` : `${f(r.gasUnits / 1e6, 0)}M gas + ${impactWord(r)}`);
  const variantWord = (v: CapVariant) => (v === "one-trade" ? "one execution" : `${Number(v) / 100} %`);
  const lines: string[] = [];
  lines.push(`# High-Value Policy Benchmark (plan §121–§123)`, ``);
  lines.push(`Generated by \`benchmarks/whale/run-policy.mjs\` → \`packages/protocol/src/sim/policyBenchmark.ts\` on ${new Date().toISOString().slice(0, 10)} from the measured quotes of \`benchmarks/whale/execution.json\` (${j.feeds.map((x: { symbol: string; usd: number }) => `${x.symbol} $${x.usd.toFixed(0)}`).join(", ")}) through the campaign lab (the reducer of \`packages/protocol/src/wallet/campaign.ts\` against a simulated clock; gates per class with the finality margins; the cadence drawn in the Balanced window; the user reassesses a pause after 10 min). ${gwei !== null ? `Gas in USD at the price fetched when this ran: ${f(gwei, 3)} gwei, ETH $${f(ethUsd!, 0)} — never a constant.` : "No live gas price was available: gas is reported in units."} The expected loss is the class prior (2 % for a bridge / MPC route, an assumption until settlement history exists) × the capital externally reachable at once; the worst-case loss is that capital; the privacy score is the six-component assessment of contract §3.11 (pool-side source, piece sizes, the Balanced cadence, fresh addresses per step, the provider's published link and its cover traffic, the cross-chain leg). Nothing here is a universal rule (plan §4): these are the engineering defaults measured. The cap variants cut pieces in a band from half the cap to the cap (so 5 % means pieces of 2.5–5 %), one at a time on a bridge route; the baseline is the whole order handed over once. Thin liquidity is the measured impact × 4 where the provider states one and a stream twice as slow where it does not (THORChain's streaming quotes state no impact figure at these sizes; the thin-market rule needs one); high volatility is a 3 % move against the order at a random step (a price-deviation pause, a requote); a degraded provider is reliability 70 and a 30-minute outage at a random step.`, ``);
  lines.push(`## §121–§122: one execution vs 5 % vs 2.5 % vs 1 %`, ``, `| order | route | risk tier | exposure | external executions | completion | expected loss | worst-case loss | privacy | cost | pauses | invariants |`, `|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of table) lines.push(`| ${money(r.sizeUsd)} | ${r.pair} / ${r.provider} | ${r.riskTier} | ${variantWord(r.variant)} | ${r.executions} | ${f(r.completionHours)} h | ${money(r.expectedLossUsd)} | ${money(r.worstCaseLossUsd)} | ${r.privacyScore} (${r.privacyLevel}) | ${cost(r)} | ${r.pauses} | ${r.invariantsHeld && r.completed ? "held" : r.invariantsHeld ? "held (open)" : "BROKEN"} |`);
  lines.push(``, `## §119: the simulation matrix at $10M — conditions × (2.5 % · one execution)`, ``, `| route | volatility | liquidity | provider | exposure | executions | completion | expected loss | worst-case loss | privacy | cost | pauses |`, `|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of matrix) lines.push(`| ${r.pair} / ${r.provider} | ${r.conditions.volatility} | ${r.conditions.liquidity} | ${r.conditions.provider} | ${variantWord(r.variant)} | ${r.executions} | ${f(r.completionHours)} h | ${money(r.expectedLossUsd)} | ${money(r.worstCaseLossUsd)} | ${r.privacyScore} | ${cost(r)} | ${r.pauses} |`);
  if (utxo) {
    const row = (s: string) => utxo.rows.find((x) => x.strategy === s);
    const sub = (p: boolean) => assessPrivacy({ sourceIsPool: true, amount: { kind: "bucket" }, delaySeconds: CADENCE.balanced[0], destination: "fresh-per-tranche", steps: row("tranches-varied")?.pieces ?? 77, provider: { linkPublic: true, kind: "deposit-address", coverPerHour: 60, etaSeconds: 1080 }, crossChain: true });
    const a = sub(true);
    lines.push(``, `## §120: the privacy benchmark matrix (${utxo.opts.amountEth} ETH, the whale UTXO lab and the assessment)`, ``,
      `Columns: effective anonymity, timing correlation and amount correlation are the whale UTXO lab's per-piece effective sets (oracle-strength observer, 8,000 users; higher is better); cross-chain correlation and provider correlation are the assessment's components (0 unlinkable … 1 linked). The rows are the configurations the plan names, mapped onto what the labs measure.`, ``,
      `| configuration | lab row | pieces | effective anonymity (joint) | timing (eff. set) | amount (eff. set) | uniquely linked | burst share | cross-chain correlation | provider correlation |`, `|---|---|---|---|---|---|---|---|---|---|`);
    for (const [name, strat, note] of [["Tornado-style fixed denominations (100 ETH pieces, the wallet's delay policy)", "pieces-100", "the fixed-size baseline"], ["New pool, one escrow (V2)", "exact", "one public piece"], ["New pool + privacy scheduler (V3/V4 campaign: varied tranches on the gated cadence)", "tranches-varied", "the protected execution"], ["New pool + scheduler + private submission (the relayer; the mempool never sees the address)", "tranches-varied", "the same pieces; the submission channel is scored, not simulated"]] as const) {
      const r = row(strat);
      if (!r) continue;
      lines.push(`| ${name} | ${strat} (${note}) | ${r.pieces} | ${f(r.effJoint)} | ${f(r.effTiming)} | ${f(r.effAmount)} | ${f(100 * r.unique)} % | ${f(100 * r.burstShare)} % | ${f(a.components.crossChain, 2)} | ${f(a.components.provider, 2)} |`);
    }
    lines.push(``, `The pool-side numbers come from \`benchmarks/whale/utxo-10m.json\`; the mempool channel is outside the labs (docs/privacy-lab.md "Limits of the model") and enters only through the score's submission factor (privacyScore.ts: mempool visibility 0.05).`);
  }
  lines.push(``, `## §123: the default after benchmarking`, ``, `Rule (stated before the run): among the caps that complete $10M on the reference cross-chain route in calm conditions within a week (${TIME_BUDGET_HOURS} h), the one with the smallest expected loss plus the protection's cost (gas at the run's price plus the stated impact); the single execution is the baseline, never a candidate; no candidate → 2.5 % stays. Gas scales with the number of steps and the expected loss with the piece, so the rule weighs the two in the same unit; the time budget is the gate's price the V3 lab measured (a week for $10M at the destination-final gate).`, ``, `**Result: ${decision.capBps / 100} %** — ${decision.why}.`, ``, `The production default (\`PROTECTION_DEFAULTS.balanced.capBps\`, \`EXPOSURE_POLICY["high-value"].capBps\`) is set from this figure; the figure is recorded in the contract (§9).`);
  const md = lines.join("\n") + "\n";
  const jsonOut = opt("json"), mdOut = opt("md");
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), execution: executionPath, prices, gwei, ethUsd, decision, table, matrix }, null, 2) + "\n");
  if (mdOut) writeFileSync(mdOut, md);
  if (!jsonOut && !mdOut) console.log(md);
  const broken = [...table, ...matrix].filter((r) => !r.invariantsHeld);
  console.log(`${table.length} table rows, ${matrix.length} matrix rows; invariants broken in ${broken.length}; default ${decision.capBps / 100} %`);
  if (broken.length) process.exit(1);
}
