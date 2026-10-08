// Whale UTXO lab (plan V2 §73–§74, §120; spec docs/whale-execution-spec-v1.0.md §12, §13 and Stage 8):
// how should a wallet holding $1M–$10M leave the pool — one withdrawal of the exact amount, one
// extended-alphabet bucket, or many standard buckets over time? The same oracle-strength observer as the
// privacy lab (src/sim/privacyLab.ts: timing posterior from the known delay law, amount feasibility
// from the users' remaining balance) looks at a pool of ordinary users plus a few whales and reports, per
// strategy, the effective anonymity set of a whale's pieces, how many pieces it takes, and how much of
// the same-bucket traffic inside the whale's window is the whale itself (a burst of 133 × 10 ETH is a
// pattern of its own, which a per-piece posterior does not see).
//
// Strategies for a withdrawal of W ETH (default 1,330 ≈ $3.4M at the probe's price):
//   exact        one piece of W (today's swap: one escrow, an arbitrary amount)
//   bucket-ext   one piece of the largest extended bucket ≤ W (1,000 / 2,000 / 5,000 ETH alphabet); the rest stays private
//   pieces-500   greedy buckets ≤ 500 ETH (the current alphabet's top), each piece at its own random delay
//   pieces-100   greedy buckets ≤ 100 ETH
//   pieces-10    greedy buckets ≤ 10 ETH (the standard policy's maxBucket), each at its own delay
//   tranches-bucket / tranches-varied   V3 (High-Value Protection spec §4, §11): the campaign splitter's pieces inside
//                the 2–2.5 % band of the order under a 2.5 % cap, released one after another — each after the previous
//                settled (the stream's time plus Bitcoin's finality margin) plus a random cadence draw — so the pieces
//                are spread over days by the protection rule, not by a privacy delay
// Usage: npx tsx src/sim/whaleUtxoLab.ts [--users 8000] [--rate 10] [--whales 24] [--amount 1330] [--seed 4242] [--json out.json]
import { writeFileSync } from "fs";
import { BUCKETS, POLICY, WEI, planShield, sampleDelay } from "../wallet/amounts";
import { planTranches } from "../wallet/campaign";

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
const ROUND = [0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20, 50, 100];
const sampleAmount = (rng: () => number) => (rng() < 0.7 ? ROUND[Math.floor(rng() * ROUND.length)] : Math.round(Math.exp(0.4 * gaussian(rng) + Math.log(1.5)) * 1e6) / 1e6);
function entropyBits(ws: Float64Array, n: number) {
  let s = 0;
  for (let i = 0; i < n; i++) s += ws[i];
  if (s <= 0) return 0;
  let h = 0;
  for (let i = 0; i < n; i++) { const w = ws[i]; if (w > 0) { const p = w / s; h -= p * Math.log2(p); } }
  return h;
}
const toEth = (wei: bigint) => Number(wei) / 1e18;
const toWei = (eth: number) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;
const HOUR = 3600;

/** The extended alphabet a whale wallet would need (Stage 8 decides whether it ships): the 1-2-5 series continued. */
export const EXTENDED_BUCKETS: readonly bigint[] = [...BUCKETS, 1000n * WEI, 2000n * WEI, 5000n * WEI];
export type Strategy = "exact" | "bucket-ext" | "pieces-500" | "pieces-100" | "pieces-10" | "tranches-bucket" | "tranches-varied";
export const STRATEGIES: Strategy[] = ["exact", "bucket-ext", "pieces-500", "pieces-100", "pieces-10", "tranches-bucket", "tranches-varied"];
/** The campaign's clock between two releases (spec §4, §6): the stream of a ≈ $250K tranche (≈ 18 min measured), Bitcoin's finality margin (60 min), then a cadence draw inside the balanced window [10 min, 90 min]. */
export const TRANCHE_GAP = { executionSeconds: 1080, marginSeconds: 3600, cadence: [600, 5400] as [number, number] };
const isTranches = (s: Strategy) => s === "tranches-bucket" || s === "tranches-varied";

/** Greedy decomposition into buckets ≤ maxBucket from the given alphabet (no piece cap: a whale pays for every piece). */
export function greedy(amount: bigint, alphabet: readonly bigint[], maxBucket: bigint): bigint[] {
  const pieces: bigint[] = [];
  let left = amount;
  for (let i = alphabet.length - 1; i >= 0; i--) {
    const b = alphabet[i];
    if (b > maxBucket) continue;
    while (left >= b) { pieces.push(b); left -= b; }
  }
  return pieces;
}
export function piecesFor(strategy: Strategy, amount: bigint, rng: () => number = Math.random): bigint[] {
  switch (strategy) {
    case "exact": return [amount];
    case "bucket-ext": { const b = [...EXTENDED_BUCKETS].reverse().find((x) => x <= amount); return b ? [b] : []; }
    case "pieces-500": return greedy(amount, BUCKETS, 500n * WEI);
    case "pieces-100": return greedy(amount, BUCKETS, 100n * WEI);
    case "pieces-10": return greedy(amount, BUCKETS, 10n * WEI);
    case "tranches-bucket": return planTranches(amount, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing: "bucket", maxParallel: 1, rng }).pieces;
    case "tranches-varied": return planTranches(amount, { decimals: 18, bandBps: [200, 250], capBps: 250, sizing: "varied", maxParallel: 1, rng }).pieces;
  }
}
/** The whale's delay window per strategy: one piece draws from the standard policy; many pieces spread over up to 72 h (the high policy's mean). */
const windowFor = (s: Strategy, rng: () => number) => (s === "pieces-10" || s === "pieces-100" ? sampleDelay("high", rng) : sampleDelay("standard", rng));
/** A campaign's release times: the first piece after the standard delay, each next one after the previous settled plus a cadence draw (spec §6). */
function trancheTimes(n: number, rng: () => number): number[] {
  const out: number[] = [];
  let t = sampleDelay("standard", rng);
  for (let i = 0; i < n; i++) {
    out.push(t);
    const [lo, hi] = TRANCHE_GAP.cadence;
    t += TRANCHE_GAP.executionSeconds + TRANCHE_GAP.marginSeconds + lo + rng() * (hi - lo);
  }
  return out;
}

interface Opts { users: number; rate: number; whales: number; amountEth: number; seed: number; warmup: number }
interface Piece { user: number; amount: number; t: number; whale: boolean }
interface User { t: number; balance: number; whale: boolean }
export interface Result { strategy: Strategy; pieces: number; pieceEth: number[]; spanHours: number; effTiming: number; effAmount: number; effJoint: number; guessHit: number; unique: number; burstShare: number; gasUnits: number }

/** Gas per public withdrawal (`transact`, benchmarks/gas/measurements.json: 1.79M); the USD cost depends on the live gas price (benchmarks/gas/cost.mjs), never quoted here. */
export const GAS_PER_WITHDRAWAL = 1_790_000;

export function simulate(strategy: Strategy, o: Opts): Result {
  const rng = mulberry32(o.seed + STRATEGIES.indexOf(strategy) * 7919);
  const users: User[] = [];
  const withdrawals: Piece[] = [];
  let t = 0;
  // ordinary users: the standard policy exactly as it ships (privacyLab P1)
  for (let u = 0; u < o.users; u++) {
    t += expSample(rng, HOUR / o.rate);
    const A = sampleAmount(rng);
    const shield = planShield(toWei(A), "standard");
    const shielded = shield.pieces.reduce((s, p) => s + p, 0n);
    users.push({ t, balance: toEth(shielded), whale: false });
    const fee = BigInt(shield.pieces.length) * (WEI / 1000n);
    const spendable = shielded > fee ? shielded - fee : 0n;
    for (const p of greedy(spendable, BUCKETS, POLICY.standard.maxBucket).slice(0, POLICY.standard.maxPieces)) withdrawals.push({ user: u, amount: toEth(p), t: t + sampleDelay("standard", rng), whale: false });
  }
  const horizon = t;
  // whales: arrive uniformly after the warm-up, hold the amount (deposited earlier in large buckets: public, like every shield), withdraw by the strategy
  const amount = toWei(o.amountEth);
  const pieces = piecesFor(strategy, amount, rng);
  for (let w = 0; w < o.whales; w++) {
    const tw = horizon * (o.warmup + (1 - o.warmup) * rng());
    users.push({ t: tw, balance: o.amountEth, whale: true });
    if (isTranches(strategy)) { const times = trancheTimes(pieces.length, rng); pieces.forEach((p, i) => withdrawals.push({ user: o.users + w, amount: toEth(p), t: tw + times[i], whale: true })); }
    else for (const p of pieces) withdrawals.push({ user: o.users + w, amount: toEth(p), t: tw + windowFor(strategy, rng), whale: true });
  }
  // pieces reference users by push order; the observer scans users in time order
  const original: User[] = [...users];
  users.sort((a, b) => a.t - b.t);
  const idxOf = new Map<User, number>(users.map((u, i) => [u, i]));
  const byTime = withdrawals.map((w) => ({ ...w })).sort((a, b) => a.t - b.t);
  const pdfStd = ((min, mean) => (x: number) => (x < min ? 0 : Math.exp(-(x - min) / mean) / mean))(POLICY.standard.minDelaySeconds, POLICY.standard.meanDelaySeconds);
  const pdfHigh = ((min, mean) => (x: number) => (x < min ? 0 : Math.exp(-(x - min) / mean) / mean))(POLICY.high.minDelaySeconds, POLICY.high.meanDelaySeconds);
  // the observer's timing law: the standard delay for one piece, the high policy for many pieces; a campaign's pieces follow the
  // protection clock (stream + finality + cadence), which an observer who knows the rule can model exactly — the standard
  // law is used here for the first piece and the later ones are far outside it, so the timing posterior is an upper bound
  const pdf = strategy === "pieces-10" || strategy === "pieces-100" ? pdfHigh : pdfStd;
  const n = users.length;
  const wT = new Float64Array(n), wA = new Float64Array(n), wJ = new Float64Array(n);
  const acc = { timing: [] as number[], amount: [] as number[], joint: [] as number[], gh: [] as number[], unique: 0, count: 0 };
  // whale windows for the burst share
  const whaleTimes = new Map<number, { first: number; last: number; pieces: number }>();
  for (const w of byTime) if (w.whale) { const e = whaleTimes.get(w.user) ?? { first: w.t, last: w.t, pieces: 0 }; e.first = Math.min(e.first, w.t); e.last = Math.max(e.last, w.t); e.pieces++; whaleTimes.set(w.user, e); }
  let burstNum = 0, burstDen = 0;
  for (const w of byTime) {
    const uIdx = idxOf.get(original[w.user])!;
    const target = users[uIdx];
    let k = 0, trueIdx = -1;
    for (let u = 0; u < n; u++) {
      const usr = users[u];
      if (usr.t >= w.t) break;
      if (usr.balance + 1e-9 < w.amount) continue; // oracle: only users who can still pay this piece
      wT[k] = pdf(w.t - usr.t); wA[k] = 1; wJ[k] = wT[k];
      if (u === uIdx) trueIdx = k;
      k++;
    }
    target.balance -= w.amount;
    if (!w.whale) continue;
    const rec = (ws: Float64Array, into: number[]) => into.push(Math.pow(2, entropyBits(ws, k)));
    rec(wT, acc.timing); rec(wA, acc.amount); rec(wJ, acc.joint);
    let sum = 0, mx = 0;
    for (let i = 0; i < k; i++) { sum += wJ[i]; if (wJ[i] > mx) mx = wJ[i]; }
    let tie = 0;
    for (let i = 0; i < k; i++) if (wJ[i] >= mx - 1e-12 * mx) tie++;
    acc.gh.push(sum > 0 && trueIdx >= 0 && wJ[trueIdx] >= mx - 1e-12 * mx ? 1 / tie : 0);
    if (sum > 0 && trueIdx >= 0 && wJ[trueIdx] / sum > 0.99) acc.unique++;
    acc.count++;
    // burst share: of all withdrawals of this exact amount inside this whale's own window, how many are this whale's
    const win = whaleTimes.get(w.user)!;
    const same = byTime.filter((x) => x.amount === w.amount && x.t >= win.first && x.t <= win.last);
    burstNum += same.filter((x) => x.user === w.user).length; burstDen += same.length;
  }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const spans = [...whaleTimes.values()].map((e) => (e.last - e.first) / HOUR);
  return {
    strategy, pieces: pieces.length, pieceEth: [...new Set(pieces.map(toEth))], spanHours: mean(spans),
    effTiming: mean(acc.timing), effAmount: mean(acc.amount), effJoint: mean(acc.joint), guessHit: mean(acc.gh), unique: acc.unique / Math.max(1, acc.count),
    burstShare: burstDen ? burstNum / burstDen : 0, gasUnits: pieces.length * GAS_PER_WITHDRAWAL,
  };
}

// ---- CLI ----
const isMain = process.argv[1] && /whaleUtxoLab\.(ts|js|mjs)$/.test(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k: string, d: number) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
  const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
  const opts: Opts = { users: arg("users", 8000), rate: arg("rate", 10), whales: arg("whales", 24), amountEth: arg("amount", 1330), seed: arg("seed", 4242), warmup: 0.2 };
  const rows = STRATEGIES.map((s) => simulate(s, opts));
  const f = (x: number, d = 1) => x.toFixed(d);
  console.log(`# Whale UTXO lab — a ${opts.amountEth} ETH withdrawal by ${opts.whales} whales among ${opts.users} ordinary users (${opts.rate}/h, standard policy), seed ${opts.seed}`);
  console.log(`# oracle-strength observer (delay law + remaining balances); per-piece effective set, then the burst share the per-piece view misses\n`);
  const w = [12, 8, 22, 10, 11, 11, 11, 10, 9, 10, 12];
  const line = (c: (string | number)[]) => c.map((x, i) => String(x).padEnd(w[i])).join("");
  console.log(line(["strategy", "pieces", "piece sizes (ETH)", "span h", "eff timing", "eff amount", "eff joint", "guess-hit", "unique%", "burst%", "gas (M)"]));
  console.log(line(w.map((n) => "-".repeat(n - 1))));
  for (const r of rows) console.log(line([r.strategy, r.pieces, r.pieceEth.join("/"), f(r.spanHours), f(r.effTiming), f(r.effAmount), f(r.effJoint), f(r.guessHit, 3), f(100 * r.unique), f(100 * r.burstShare), f(r.gasUnits / 1e6, 0)]));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ opts, rows }, null, 2) + "\n");
}
