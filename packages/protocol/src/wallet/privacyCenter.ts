// The Privacy Center (plan V2 §75, §93; whale spec §23): the wallet's privacy posture in six categories
// with a word level beside each number — Excellent / Good / Reduced — a plain explanation, and the
// limits the wallet never hides (plan §69). Built on the same lab-calibrated model as the per-action
// scorecard (scorecard.ts), so a category here and a row there never disagree. Nothing in this file
// says "anonymous": the pool's size and the public sides bound every guarantee.
import { effectiveAnonymity, setScore, TIMING_FACTOR } from "./scorecard";

export type Level = "Excellent" | "Good" | "Reduced";
export const levelOf = (score: number): Level => (score >= 85 ? "Excellent" : score >= 60 ? "Good" : "Reduced");

export interface PostureFacts {
  /** notes in the pool from the last sync, null until the first one */
  poolSize: number | null;
  /** the funding delay window of the saved preference, seconds */
  delayWindow: [number, number];
  /** a relayer submits private transactions, paid by a private fee note */
  privateSubmission: boolean;
  /** RPC endpoints in the read quorum */
  rpcEndpoints: number;
  /** the Ethereum light client checks the pool before every transaction (on a chain it serves) */
  lightClient: boolean;
  /** withdrawals, swaps and receipts use fresh addresses of this wallet by default */
  freshDestinations: boolean;
  /** the last swap route's cross-chain privacy, when one was quoted */
  crossChain?: { privacy: number; linkPublic: boolean } | null;
}

export type CategoryId = "financial" | "addresses" | "network" | "rpc" | "timing" | "crossChain";
/** A "Why" line by its code and values (audit round 2, n92): the app says it in the reader's language; `why` keeps the English. */
export interface WhyLine { code: string; vars?: Record<string, number> }
export interface PostureCategory { id: CategoryId; label: string; score: number | null; level: Level | null; why: string[]; whyCodes?: WhyLine[] }
export interface Posture { categories: PostureCategory[]; overall: Level | null; limits: string[] }

/** What the wallet cannot promise (plan §69), stated the same way everywhere. */
export const LIMITS: readonly string[] = [
  "Adding funds is public by design: the deposit shows your address and its amount; privacy starts with what happens after it.",
  "Your IP address is visible to the RPC endpoints and to the relayer; a native app with Tor or a light client is the upgrade.",
  "A swap provider sees the one-time deposit address, the destination and the amount, and some publish that link; your private source stays protected, but timing and amount can be correlated by a patient observer.",
  "The pool is the crowd you hide in: with few notes, or an unusual amount, the effective set is small and the numbers here say so.",
  "Every action here leaves some public trace by construction. Every score is a bound from the privacy lab, not a guarantee.",
];

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
const LEVELS: Level[] = ["Reduced", "Good", "Excellent"];
const mid = ([min, max]: [number, number]) => (min + max) / 2;
const hours = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function privacyPosture(f: PostureFacts): Posture {
  const cats: PostureCategory[] = [];
  const delay = mid(f.delayWindow);
  const line = (code: string, text: string, vars?: Record<string, number>) => ({ code, text, ...(vars ? { vars } : {}) });
  const cat = (id: CategoryId, label: string, score: number | null, level: Level | null, lines: { code: string; text: string; vars?: Record<string, number> }[]): PostureCategory => ({
    id,
    label,
    score,
    level,
    why: lines.map((l) => l.text),
    whyCodes: lines.map((l) => (l.vars ? { code: l.code, vars: l.vars } : { code: l.code })),
  });

  // Financial history: can the money's history be reconstructed? The pool's size against bucketed amounts and the delay.
  if (f.poolSize === null) cats.push(cat("financial", "Financial history", null, null, [line("financial.unknown", "Unknown until the first sync: the pool's size is what an observer must search, and the wallet has not read it yet.")]));
  else {
    const eff = effectiveAnonymity({ poolSize: f.poolSize, delaySeconds: delay, amountIsBucket: true });
    const score = setScore(eff);
    cats.push(
      cat("financial", "Financial history", score, levelOf(score), [
        line("financial.pool", `The pool holds ${f.poolSize} notes; with bucketed amounts and your delay window the effective set is about ${Math.round(eff)}.`, { notes: f.poolSize, set: Math.round(eff) }),
        line("financial.inside", "Private transfers inside the pool show nothing but a transaction; only what leaves it has a public side."),
      ]),
    );
  }

  // Address separation: the permanent address never meets a provider or a counterparty.
  const addresses = f.freshDestinations ? 90 : 40;
  cats.push(
    cat("addresses", "Address separation", addresses, levelOf(addresses), f.freshDestinations
      ? [
          line("addresses.fresh", "Every withdrawal, swap and receipt uses a fresh address of this wallet; your privacy address is shared only with people who pay you."),
          line("addresses.typed", "An address you type by hand is yours to keep separate: the wallet warns when it is reused."),
        ]
      : [line("addresses.entered", "Destinations are entered by hand: whoever knows an address knows the payments to it.")]),
  );

  // Network privacy: who submits, and what they learn.
  const network = f.privateSubmission ? 75 : 35;
  cats.push(
    cat("network", "Network privacy", network, levelOf(network), f.privateSubmission
      ? [
          line("network.relayer", "A relayer submits your private transactions and is paid by a private fee note; your address never sends them."),
          line("network.ip", "The relayer still sees your IP address (the web build cannot hide it)."),
        ]
      : [line("network.wallet", "Your connected wallet submits the transactions: each one is tied to its address. The relayer route avoids that.")]),
  );

  // RPC privacy: who sees the reads, and whether they are checked.
  const rpc = f.rpcEndpoints >= 2 ? (f.lightClient ? 80 : 65) : 35;
  cats.push(
    cat("rpc", "RPC privacy", rpc, levelOf(rpc), [
      f.rpcEndpoints >= 2
        ? line("rpc.quorum", `${f.rpcEndpoints} endpoints answer every read and must agree; none is trusted alone.`, { n: f.rpcEndpoints })
        : line("rpc.single", "One endpoint serves every read and could lie or watch; configure two or more."),
      f.lightClient
        ? line("rpc.lightClient", "An Ethereum light client proves the pool before every transaction.")
        : line("rpc.noLightClient", "Reads rest on the endpoints' agreement alone (no light client for this chain)."),
      // the swap side too (2026-10-17, the audit's unverified m69): the pre-trade simulation goes to every endpoint; and the
      // wallet's own reads (audit round 2, n26)
      line("rpc.reads", "Every endpoint sees your IP address and what this wallet reads: the pool's events, as every user does, but also its own notes' spent state, its transactions' receipts and its swaps' escrows; each endpoint also simulates every swap you confirm: its escrow, amount and destination."),
    ]),
  );

  // Timing privacy: the random delay between funding and acting.
  const timing = clamp(100 / TIMING_FACTOR(delay));
  cats.push(
    cat("timing", "Timing privacy", timing, levelOf(timing), f.delayWindow[1] === 0
      ? [line("timing.immediate", "Swaps are funded as soon as you confirm, so funding and acting are linked by time; Delay for more privacy on a swap adds a random 1–24 h.")]
      : [line("timing.window", `Swaps are funded at a random moment inside ${hours(f.delayWindow[0])}–${hours(f.delayWindow[1])}; a patient observer still sees when money moves.`, { from: f.delayWindow[0], to: f.delayWindow[1] })]),
  );

  // Cross-chain privacy: the one-time escrow, the fresh destination, and what the provider publishes.
  if (f.crossChain) {
    const score = clamp(f.crossChain.privacy - (f.crossChain.linkPublic ? 5 : 0));
    cats.push(
      cat("crossChain", "Cross-chain privacy", score, levelOf(score), [
        line("crossChain.escrow", "A swap pays from a one-time escrow to a fresh address of this wallet; the provider never sees your permanent address."),
        f.crossChain.linkPublic
          ? line("crossChain.public", "This route publishes the escrow → destination link; your private source stays protected, but timing and amount may be correlated.")
          : line("crossChain.private", "This route keeps the escrow → destination link off public chains."),
      ]),
    );
  } else
    cats.push(
      cat("crossChain", "Cross-chain privacy", 70, "Good", [
        line("crossChain.default", "A swap pays from a one-time escrow to a fresh address of this wallet; the provider sees the escrow, the destination and the amount, never your permanent address."),
        line("crossChain.route", "The route is chosen by its privacy score among live quotes; the Swap screen shows the level of the chosen one."),
      ]),
    );

  const known = cats.filter((c) => c.level !== null);
  const overall = known.length ? LEVELS[Math.min(...known.map((c) => LEVELS.indexOf(c.level!)))] : null;
  return { categories: cats, overall, limits: [...LIMITS] };
}
