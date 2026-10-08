// Shared fixtures of the high-value tests tree (contract §5): assets, a seeded source of randomness, a campaign builder
// over the pure core, and the lab's routes from the measured quotes of the V2 execution lab (read-only data).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCampaign, rateE18, withTrancheState, type AssetRefLike, type Campaign, type ExecutionBounds, type TranchePlan, type TrancheState } from "../../reference/typescript/src/wallet/campaign";
import { routesFromExecution, type RouteSpec } from "../../reference/typescript/src/sim/campaignLab";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const ETH = 10n ** 18n;
export const USDC = 10n ** 6n;
export const ETH_REF: AssetRefLike = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
export const BTC_REF: AssetRefLike = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
export const SOL_REF: AssetRefLike = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
export const USDC_REF: AssetRefLike = { chain: "ethereum", asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" };
export const USDT_REF: AssetRefLike = { chain: "ethereum", asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT" };
export const DEST_BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

/** A small LCG: deterministic, good enough to walk the state space (the wallet uses the CSPRNG). */
export const seeded = (seed = 7) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
export const sum = (xs: bigint[]): bigint => xs.reduce((s, x) => s + x, 0n);
export const soon = () => Math.floor(Date.now() / 1000) + 600;

/** The reference rate of a $10M ETH → BTC order at the probe's prices (2,353 ETH → 24 BTC × 1e8 per 800 ETH ≈ 0.03 BTC/ETH). */
export const REF_RATE = rateE18(24_000_000n, 800n * ETH);

export function bounds(over: Partial<ExecutionBounds> = {}): ExecutionBounds {
  return {
    orderId: "0x" + "11".repeat(32), assetIn: ETH_REF, chainIn: "ethereum", amountInLimit: (2353n * ETH).toString(), assetOut: BTC_REF, chainOut: "bitcoin",
    destination: { kind: "fresh-per-tranche" }, minimumOutput: REF_RATE.toString(), expiry: 1_800_000, maxFeeBps: 60, privacyMode: "balanced",
    maxExternalExposure: ((2353n * ETH * 250n) / 10000n).toString(), executeWindowSeconds: 7200, ...over,
  };
}
export function plan(over: Partial<TranchePlan> = {}): TranchePlan {
  return { riskClass: "R5", bandBps: [200, 300], capBps: 250, sizing: "bucket", concurrency: "sequential", maxParallel: 1, gate: "destination-final", cadenceSeconds: [600, 5400], providerShareCapBps: 10000, executeWindowSeconds: 7200, estimatedTranches: 47, estimatedSeconds: 60_000, shapeNotes: false, ...over };
}
/** A campaign over `pieces` with the given tranche states (the cap follows the plan's fraction of the order). */
export function campaign(pieces: bigint[], states: TrancheState[] = [], over: Partial<Campaign> = {}, p: Partial<TranchePlan> = {}): Campaign {
  const capBps = BigInt(p.capBps ?? 250);
  const total = sum(pieces);
  const c = createCampaign({ id: "c1", now: 1_000_000, mode: "balanced", tier: "institutional", request: { from: ETH_REF, to: BTC_REF, amount: total.toString(), preference: "balanced" }, bounds: bounds({ amountInLimit: total.toString(), maxExternalExposure: ((total * capBps) / 10000n).toString() }), plan: plan(p), pieces, referenceRateE18: REF_RATE });
  let out = { ...c, ...over };
  states.forEach((s, i) => { out = withTrancheState(out, i, s, 1_000_100 + i); });
  return out;
}

/** The lab's routes and prices from benchmarks/whale/execution.json (the V2 execution lab's measured quotes). */
export function labRoutes(): { routes: RouteSpec[]; prices: Record<string, number> } {
  const j = JSON.parse(readFileSync(join(ROOT, "benchmarks", "whale", "execution.json"), "utf8"));
  const prices: Record<string, number> = Object.fromEntries((j.feeds as { symbol: string; usd: number }[]).map((f) => [f.symbol, f.usd]));
  return { routes: routesFromExecution(j), prices };
}
