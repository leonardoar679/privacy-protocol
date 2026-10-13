// Privacy lab (plan §65–§68, Stage 10/17): the Tornado study's multi-channel adversary
// (research/09-testing/privacy-sim: seeded mulberry32, Poisson arrivals, exponential delays, a Bayesian
// posterior per withdrawal → effective anonymity set 2^H and guess-hit) applied to THIS protocol's
// public surface, with the wallet policy taken from src/wallet/amounts.ts — so the numbers measure
// the logic that ships, not a model of it.
//
// Public surface the observer sees: shields (depositor address, amount, time), withdrawals (fresh
// stealth address, amount, time). Private transactions leak nothing but their existence and time.
// Adversary strength: the study's upper-bound convention — it knows the delay law and which users
// still have shielded balance (an oracle a real observer does not have). Numbers are therefore
// conservative for the protocol.
//
// Policies:  P0 naive (Nova-like: one shield of A, one withdrawal of A − 2% fee, exp(24h) delay)
//            C  classic (fixed denominations 0.1/1/10/100, one shot, exp(24h))
//            P1 standard, P2 high (src/wallet/amounts.ts: bucketed pieces, floors + randomized delays,
//               fresh address per piece, fee paid as a PRIVATE note)
// Usage: npx tsx src/sim/privacyLab.ts [--users 8000] [--rate 10] [--seed 4242] [--json out.json]
import { writeFileSync } from "fs";
import { POLICY, WEI, planShield, planWithdrawal, sampleDelay, type PrivacyMode } from "../wallet/amounts";

// ---- the study's estimators, verbatim in spirit ----
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
const sampleAmount = (rng: () => number) =>
  rng() < 0.7 ? ROUND[Math.floor(rng() * ROUND.length)] : Math.round(Math.exp(0.4 * gaussian(rng) + Math.log(1.5)) * 1e6) / 1e6;
function entropyBits(ws: Float64Array, n: number) {
  let s = 0;
  for (let i = 0; i < n; i++) s += ws[i];
  if (s <= 0) return 0;
  let h = 0;
  for (let i = 0; i < n; i++) { const w = ws[i]; if (w > 0) { const p = w / s; h -= p * Math.log2(p); } }
  return h;
}
const CLASSIC = [0.1, 1, 10, 100];
const toClassic = (a: number) => CLASSIC.reduce((b, d) => (Math.abs(Math.log(a / d)) < Math.abs(Math.log(a / b)) ? d : b), CLASSIC[0]);
const toEth = (wei: bigint) => Number(wei) / 1e18;
const toWei = (eth: number) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;

type Policy = "P0" | "C" | "P1" | "P2";
interface Piece { user: number; amount: number; t: number }
interface User { t: number; deposited: number; balance: number; pieces: number; withdrawn: number }

interface Opts { users: number; rate: number; seed: number; warmup: number }

function simulate(policy: Policy, o: Opts) {
  const rng = mulberry32(o.seed);
  const HOUR = 3600;
  const mode: PrivacyMode | null = policy === "P1" ? "standard" : policy === "P2" ? "high" : null;
  const users: User[] = [];
  const deposits: Piece[] = [];
  const withdrawals: Piece[] = [];
  let t = 0;
  for (let u = 0; u < o.users; u++) {
    t += expSample(rng, HOUR / o.rate);
    const A = sampleAmount(rng);
    const user: User = { t, deposited: 0, balance: 0, pieces: 0, withdrawn: 0 };
    users.push(user);
    if (policy === "P0") {
      deposits.push({ user: u, amount: A, t });
      const fee = A * 0.02 * (0.5 + rng());
      withdrawals.push({ user: u, amount: A - fee, t: t + expSample(rng, 24 * HOUR) });
      user.deposited = A;
    } else if (policy === "C") {
      const d = toClassic(A);
      deposits.push({ user: u, amount: d, t });
      withdrawals.push({ user: u, amount: d, t: t + expSample(rng, 24 * HOUR) });
      user.deposited = d;
    } else {
      const shield = planShield(toWei(A), mode!);
      for (const p of shield.pieces) deposits.push({ user: u, amount: toEth(p), t });
      const shielded = shield.pieces.reduce((s, p) => s + p, 0n);
      user.deposited = toEth(shielded);
      // the relayer fee is a private note (0.001 per piece); it never appears publicly
      const feeTotal = BigInt(shield.pieces.length) * (WEI / 1000n);
      const w = planWithdrawal(shielded > feeTotal ? shielded - feeTotal : 0n, shielded, mode!);
      for (const p of w.pieces) withdrawals.push({ user: u, amount: toEth(p), t: t + sampleDelay(mode!, rng) });
    }
    user.balance = user.deposited;
    user.pieces = withdrawals.filter((w) => w.user === u).length;
  }
  withdrawals.sort((a, b) => a.t - b.t);

  // delay law known to the observer
  const pdf: (x: number) => number = mode
    ? ((min, mean) => (x: number) => (x < min ? 0 : Math.exp(-(x - min) / mean) / mean))(POLICY[mode].minDelaySeconds, POLICY[mode].meanDelaySeconds)
    : ((mean) => (x: number) => (x <= 0 ? 0 : Math.exp(-x / mean) / mean))(24 * HOUR);

  const n = o.users;
  const wT = new Float64Array(n), wA = new Float64Array(n), wJ = new Float64Array(n);
  const acc = { timing: [] as number[], amount: [] as number[], joint: [] as number[], ghJ: [] as number[], uniqA: 0, uniqJ: 0, nominal: [] as number[], count: 0 };
  const warmCut = Math.floor(n * o.warmup);

  for (const w of withdrawals) {
    const u0 = users[w.user];
    let nominal = 0, k = 0, trueIdx = -1;
    for (let u = 0; u < n; u++) {
      const usr = users[u];
      if (usr.t >= w.t) break; // users are in arrival order
      if (usr.balance <= 0) continue; // oracle: exhausted users are not candidates
      nominal++;
      const lt = pdf(w.t - usr.t);
      let la = 0;
      if (policy === "P0") { const lo = w.amount / (1 - 0.01), hi = w.amount / (1 - 0.03); la = usr.deposited >= lo && usr.deposited <= hi ? 1 : 0; }
      else if (policy === "C") la = usr.deposited === w.amount ? 1 : 0;
      else la = usr.balance + 1e-9 >= w.amount ? 1 : 0;
      wT[k] = lt; wA[k] = la; wJ[k] = lt * la;
      if (u === w.user) trueIdx = k;
      k++;
    }
    u0.balance = mode ? u0.balance - w.amount : 0; // one-shot policies: the deposit is spent (study convention)
    u0.withdrawn++;
    if (w.user < warmCut) continue;
    const record = (ws: Float64Array, into: number[], ghInto?: number[]) => {
      let sum = 0, mx = 0, support = 0;
      for (let i = 0; i < k; i++) { sum += ws[i]; if (ws[i] > mx) mx = ws[i]; if (ws[i] > 0) support++; }
      into.push(Math.pow(2, entropyBits(ws, k)));
      if (ghInto) {
        let gh = 0;
        if (sum > 0) { let tie = 0; for (let i = 0; i < k; i++) if (ws[i] >= mx - 1e-12 * mx) tie++; gh = trueIdx >= 0 && ws[trueIdx] >= mx - 1e-12 * mx ? 1 / tie : 0; }
        ghInto.push(gh);
      }
      return support;
    };
    record(wT, acc.timing);
    if (record(wA, acc.amount) === 1) acc.uniqA++;
    if (record(wJ, acc.joint, acc.ghJ) === 1) acc.uniqJ++;
    acc.nominal.push(nominal);
    acc.count++;
  }
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const piecesPerUser = withdrawals.length / n;
  return {
    policy, withdrawals: acc.count, piecesPerUser, nominal: mean(acc.nominal),
    effTiming: mean(acc.timing), effAmount: mean(acc.amount), effJoint: mean(acc.joint),
    guessHitJoint: mean(acc.ghJ), uniqueAmount: acc.uniqA / acc.count, uniqueJoint: acc.uniqJ / acc.count,
  };
}

// ---- CLI ----
const argv = process.argv.slice(2);
const arg = (k: string, d: number) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
const opts: Opts = { users: arg("users", 8000), rate: arg("rate", 10), seed: arg("seed", 4242), warmup: 0.2 };

const rows = (["P0", "C", "P1", "P2"] as Policy[]).map((p) => simulate(p, opts));
const f = (x: number, d = 1) => x.toFixed(d);
const names: Record<Policy, string> = { P0: "P0 naive (Nova-like, arbitrary amounts)", C: "C  classic (fixed denominations)", P1: "P1 standard (this wallet, default)", P2: "P2 high privacy (this wallet)" };
console.log(`# Privacy lab — multi-channel adversary vs the V1 design`);
console.log(`# users=${opts.users}, arrival=${opts.rate}/h, seed=${opts.seed}, warm-up ${opts.warmup * 100}% skipped; oracle-strength observer (knows delay law + exhausted users)\n`);
const w = [40, 9, 9, 11, 11, 11, 10, 10, 10];
const line = (c: (string | number)[]) => c.map((x, i) => String(x).padEnd(w[i])).join("");
console.log(line(["policy", "pieces/u", "nominal", "eff timing", "eff amount", "eff joint", "guess-hit", "uniq amt%", "uniq joint%"]));
console.log(line(w.map((n) => "-".repeat(n - 1))));
for (const r of rows) console.log(line([names[r.policy], f(r.piecesPerUser, 2), f(r.nominal), f(r.effTiming), f(r.effAmount), f(r.effJoint), f(r.guessHitJoint, 3), f(100 * r.uniqueAmount), f(100 * r.uniqueJoint)]));
console.log(`\n# collapse factor vs nominal (joint): ${rows.map((r) => `${r.policy} ${f(r.nominal / r.effJoint)}x`).join(", ")}`);
console.log(`# §68 acceptance — amount unique-link under P1: ${f(100 * rows[2].uniqueAmount, 2)}% (target ≈ 0);  joint collapse P1 vs P0: ${f(rows[0].nominal / rows[0].effJoint)}x -> ${f(rows[2].nominal / rows[2].effJoint)}x`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ opts, rows }, null, 2) + "\n");
