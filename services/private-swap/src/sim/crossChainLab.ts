// Cross-chain observer lab (plan §72 "amount / timing against a blockchain observer", step 17).
//
// What the observer sees for a private swap: on the source chain the one-time escrow pays the
// provider (amount A·(1 − tip), time t_e); on the destination chain a fresh address receives
// out ≈ A·rate·(1 − fee) at t_d = t_e + ETA. The escrow address links the pool withdrawal to the
// provider ingress by construction (that side is the V1 privacy lab's problem: docs/privacy-lab.md);
// what is left to hide is WHICH destination arrival belongs to WHICH ingress. The observer here is
// the study's Bayesian one: for every arrival of ours it weighs every ingress by a timing
// likelihood (the provider's ETA law, lognormal) and an amount likelihood (predicted output from
// the ingress amount, the market rate at t_e and the provider fee, with the execution noise and the
// rate drift over the ETA as tolerance), and we report the effective anonymity set 2^H, the
// guess-hit rate and the share of arrivals that are uniquely linked.
//
// Variables: provider class (ETA, ETA spread, fee, execution noise), the provider's throughput
// (swaps/hour on the pair — the cover traffic), the wallet's share of that traffic, and the amount
// policy: `arbitrary` (the user's exact amount) vs `bucketed` (the 1-2-5 alphabet of
// reference/typescript/src/wallet/amounts.ts, as spec §8 recommends). The scheduled delay of spec
// §8 is deliberately NOT a variable: it separates the pool withdrawal from the shield (V1 lab), not
// the ingress from the arrival — the escrow address ties those two anyway.
// Usage: npx tsx src/sim/crossChainLab.ts [--swaps 6000] [--seed 4242] [--share 0.2] [--json out.json]
import { writeFileSync } from "fs";
import { BUCKETS } from "../../../../reference/typescript/src/wallet/amounts";
import { privacyScore } from "../privacyScore";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const expSample = (rng: () => number, mean: number) => -Math.log(1 - rng()) * mean;
function gaussian(rng: () => number) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function entropyBits(ws: Float64Array, n: number) {
  let s = 0;
  for (let i = 0; i < n; i++) s += ws[i];
  if (s <= 0) return 0;
  let h = 0;
  for (let i = 0; i < n; i++) { const w = ws[i]; if (w > 0) { const p = w / s; h -= p * Math.log2(p); } }
  return h;
}
// background traffic: the study's amount law (70 % round numbers, 30 % lognormal around 1.5)
const ROUND = [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 50, 100];
const lognormalAmount = (rng: () => number) => Math.exp(0.4 * gaussian(rng) + Math.log(1.5));
const sampleBackground = (rng: () => number) => (rng() < 0.7 ? ROUND[Math.floor(rng() * ROUND.length)] : lognormalAmount(rng));
const BUCKET_ETH = BUCKETS.map((b) => Number(b) / 1e18);
const toBucket = (a: number) => BUCKET_ETH.reduce((best, b) => (b <= a && b > best ? b : best), BUCKET_ETH[0]);

export interface ProviderClass { name: string; like: string; etaSeconds: number; etaSigma: number; feeBps: number; execNoise: number }
export const CLASSES: ProviderClass[] = [
  { name: "fast-intent", like: "Mayan / NEAR Intents / Across", etaSeconds: 60, etaSigma: 0.4, feeBps: 30, execNoise: 0.002 },
  { name: "native-chain", like: "THORChain / Chainflip", etaSeconds: 600, etaSigma: 0.5, feeBps: 50, execNoise: 0.005 },
  { name: "bridge-aggregator", like: "LI.FI over a bridge", etaSeconds: 900, etaSigma: 0.6, feeBps: 20, execNoise: 0.001 },
];
export const THROUGHPUTS = [5, 20, 100]; // swaps per hour on the pair, through that provider
export type AmountPolicy = "arbitrary" | "bucketed";
export interface Opts { swaps: number; seed: number; warmup: number; walletShare: number; rateDriftPerSqrtMin: number; tipBps: number }
export interface Row { cls: string; ratePerHour: number; policy: AmountPolicy; arrivals: number; effTiming: number; effAmount: number; effJoint: number; guessHit: number; unique: number; medianCandidates: number }

interface Swap { ours: boolean; amountIn: number; tE: number; tD: number; out: number; rateAtE: number }

export function simulate(cls: ProviderClass, ratePerHour: number, policy: AmountPolicy, o: Opts, seedOffset = 0): Row {
  const rng = mulberry32(o.seed + seedOffset);
  const swaps: Swap[] = [];
  let t = 0, logRate = 0, lastT = 0;
  for (let i = 0; i < o.swaps; i++) {
    t += expSample(rng, 3600 / ratePerHour);
    logRate += gaussian(rng) * o.rateDriftPerSqrtMin * Math.sqrt((t - lastT) / 60); // the market moves while swaps are in flight
    lastT = t;
    const ours = rng() < o.walletShare;
    let amountIn: number;
    if (!ours) amountIn = sampleBackground(rng);
    else {
      const wanted = lognormalAmount(rng);
      amountIn = (policy === "bucketed" ? toBucket(wanted) : wanted) * (1 - o.tipBps / 10000); // the escrow pays the executor tip first
    }
    const eta = Math.exp(Math.log(cls.etaSeconds) + cls.etaSigma * gaussian(rng));
    const rateAtE = Math.exp(logRate);
    const out = amountIn * rateAtE * (1 - cls.feeBps / 10000) * (1 + cls.execNoise * gaussian(rng));
    swaps.push({ ours, amountIn, tE: t, tD: t + eta, out, rateAtE });
  }
  // the observer's tolerances: execution noise plus the rate drift over a typical ETA
  const tau = Math.sqrt(cls.execNoise ** 2 + o.rateDriftPerSqrtMin ** 2 * (cls.etaSeconds / 60));
  const mu = Math.log(cls.etaSeconds), sig = cls.etaSigma;
  const lnPdf = (dt: number) => (dt <= 0 ? 0 : Math.exp(-((Math.log(dt) - mu) ** 2) / (2 * sig * sig)) / (dt * sig));
  const cutoff = cls.etaSeconds * Math.exp(5 * sig); // older ingresses have a negligible timing likelihood
  const n = swaps.length;
  const wT = new Float64Array(n), wA = new Float64Array(n), wJ = new Float64Array(n);
  const acc = { timing: [] as number[], amount: [] as number[], joint: [] as number[], gh: [] as number[], unique: 0, count: 0, cands: [] as number[] };
  const warmCut = Math.floor(n * o.warmup);
  for (let j = warmCut; j < n; j++) {
    const s = swaps[j];
    if (!s.ours) continue;
    let k = 0, trueIdx = -1;
    // candidates: every ingress submitted before the arrival and not older than the cutoff (ingresses are in time order)
    let lo = j;
    while (lo > 0 && swaps[lo - 1].tE > s.tD - cutoff) lo--;
    for (let i = lo; i < n && swaps[i].tE < s.tD; i++) {
      const c = swaps[i];
      const lt = lnPdf(s.tD - c.tE);
      const predicted = c.amountIn * c.rateAtE * (1 - cls.feeBps / 10000);
      const z = Math.log(s.out / predicted) / tau;
      const la = Math.abs(z) > 5 ? 0 : Math.exp(-z * z / 2);
      wT[k] = lt; wA[k] = la; wJ[k] = lt * la;
      if (i === j) trueIdx = k;
      k++;
    }
    const rec = (ws: Float64Array, into: number[]) => { into.push(Math.pow(2, entropyBits(ws, k))); };
    rec(wT, acc.timing); rec(wA, acc.amount); rec(wJ, acc.joint);
    let sum = 0, mx = 0;
    for (let i = 0; i < k; i++) { sum += wJ[i]; if (wJ[i] > mx) mx = wJ[i]; }
    let tie = 0;
    for (let i = 0; i < k; i++) if (wJ[i] >= mx - 1e-12 * mx) tie++;
    const hit = sum > 0 && trueIdx >= 0 && wJ[trueIdx] >= mx - 1e-12 * mx ? 1 / tie : 0;
    acc.gh.push(hit);
    if (sum > 0 && trueIdx >= 0 && wJ[trueIdx] / sum > 0.99) acc.unique++;
    acc.cands.push(k);
    acc.count++;
  }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const sorted = [...acc.cands].sort((a, b) => a - b);
  return {
    cls: cls.name, ratePerHour, policy, arrivals: acc.count,
    effTiming: mean(acc.timing), effAmount: mean(acc.amount), effJoint: mean(acc.joint), guessHit: mean(acc.gh), unique: acc.unique / Math.max(1, acc.count),
    medianCandidates: sorted[Math.floor(sorted.length / 2)] ?? 0,
  };
}

export function runAll(o: Opts): Row[] {
  const rows: Row[] = [];
  let seedOffset = 0;
  for (const cls of CLASSES) for (const rate of THROUGHPUTS) for (const policy of ["arbitrary", "bucketed"] as AmountPolicy[]) rows.push(simulate(cls, rate, policy, o, seedOffset++));
  return rows;
}

// ---- CLI ----
const isMain = process.argv[1] && /crossChainLab\.(ts|js|mjs)$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k: string, d: number) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
  const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
  const opts: Opts = { swaps: arg("swaps", 6000), seed: arg("seed", 4242), warmup: 0.2, walletShare: arg("share", 0.2), rateDriftPerSqrtMin: arg("drift", 0.0005), tipBps: 25 };
  const rows = runAll(opts);
  const f = (x: number, d = 1) => x.toFixed(d);
  console.log(`# Cross-chain observer lab — ingress ↔ arrival linkability per provider class`);
  console.log(`# swaps=${opts.swaps} per row, wallet share=${opts.walletShare}, rate drift=${opts.rateDriftPerSqrtMin}/√min, tip=${opts.tipBps} bps, seed=${opts.seed}, warm-up ${opts.warmup * 100}% skipped\n`);
  const w = [18, 8, 10, 9, 12, 12, 12, 10, 9];
  const line = (c: (string | number)[]) => c.map((x, i) => String(x).padEnd(w[i])).join("");
  console.log(line(["class", "swaps/h", "amounts", "cands", "eff timing", "eff amount", "eff joint", "guess-hit", "unique%"]));
  console.log(line(w.map((n) => "-".repeat(n - 1))));
  for (const r of rows) console.log(line([r.cls, r.ratePerHour, r.policy, r.medianCandidates, f(r.effTiming), f(r.effAmount), f(r.effJoint), f(r.guessHit, 3), f(100 * r.unique)]));
  // the spec §10 score (1 h delay, fresh endpoints, private submission): with the link public (every
  // adapter today) the cross-chain leg neither adds nor takes; a provider that kept it private would add
  // a second hurdle as strong as this table's effective set
  const score = (bucket: boolean, cls: ProviderClass, rate: number, linkPublic: boolean) => privacyScore({ sourceIsPool: true, destinationFresh: true, amountIsBucket: bucket, amountUniqueness: 0.8, delaySeconds: 3600, providerKind: cls.name === "fast-intent" ? "signed-intent" : cls.name === "native-chain" ? "deposit-address" : "aggregator-api", nativeAssets: cls.name !== "bridge-aggregator", oneTimeEndpoints: true, privateSubmission: true, crossChain: { throughputPerHour: rate, etaSeconds: cls.etaSeconds, etaSigma: cls.etaSigma, linkPublic } });
  console.log(`
# spec §10 score, bucketed / arbitrary — link public (every adapter today) | link private (hypothetical):`);
  for (const cls of CLASSES) console.log(`#   ${cls.name.padEnd(18)} ${THROUGHPUTS.map((r) => `${r}/h ${score(true, cls, r, true)} / ${score(false, cls, r, true)} | ${score(true, cls, r, false)} / ${score(false, cls, r, false)}`).join("   ")}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ opts, classes: CLASSES, rows }, null, 2) + "\n");
}
