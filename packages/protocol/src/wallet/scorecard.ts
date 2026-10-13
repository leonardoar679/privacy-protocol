// Privacy scorecard per action (plan §78): six 0–100 scores — financial, network, recipient, timing,
// amount, provider — and an overall, computed from what the wallet is about to do. Calibrated by the
// privacy lab (docs/privacy-lab.md): arbitrary public amounts collapse the anonymity set ~19.4×,
// bucketed pieces ~2.9×; a delay floor + randomized delay widens the timing-only set from 3.0× loss
// (immediate) to ~1.05× (≥ 24 h); the channels multiply. Network scores are capped below 100 in the
// web build: the endpoints and the relayer still see an IP (Tor / light client are native-host work).
export type ActionKind = "shield" | "transfer" | "withdraw" | "swap" | "credit";

export interface ScorecardFacts {
  /** notes in the pool (the anonymity set an observer must search; the wallet reads it from the tree size) */
  poolSize: number;
  /** planned delay between the funds becoming spendable and this action (0 = immediately) */
  delaySeconds: number;
  /** the public amount comes from the shared bucket alphabet (wallet/amounts.ts) */
  amountIsBucket: boolean;
  /** a relayer submits, paid by a private fee note (the wallet's address never submits) */
  privateSubmission: boolean;
  /** RPC endpoints in the read quorum (1 = one provider sees every read) */
  rpcEndpoints: number;
  /** withdraw / swap / credit: the destination is a fresh, one-time address of this wallet */
  recipientFresh: boolean;
  /** swap only: the engine's cross-chain privacy score and what the provider sees */
  provider?: { crossChainScore: number; nativeAssets: boolean; kind: "deposit-address" | "signed-intent" | "aggregator-api" };
  /** credit (Pay) only: runtime-key mode (the billing server never sees content) and a fresh funding address */
  credit?: { runtimeKey: boolean; freshFunding: boolean };
}

export interface Scorecard {
  financial: number;
  network: number;
  recipient: number;
  timing: number;
  amount: number;
  provider: number;
  overall: number;
  /** what limits each score, in the user's words */
  notes: string[];
}

export const TIMING_FACTOR = (delaySeconds: number): number => (delaySeconds < 60 ? 3.0 : delaySeconds < 3600 ? 1.8 : delaySeconds < 86400 ? 1.2 : 1.05);
export const AMOUNT_FACTOR = (bucket: boolean): number => (bucket ? 2.9 : 19.4);
const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
/** 0 at an effective set of 1, 100 at 1000+ (log scale: every ×10 of cover is worth the same). */
export const setScore = (effective: number): number => clamp((100 * Math.log10(Math.max(1, effective))) / 3);

export function effectiveAnonymity(f: Pick<ScorecardFacts, "poolSize" | "delaySeconds" | "amountIsBucket">): number {
  return Math.max(1, f.poolSize / (TIMING_FACTOR(f.delaySeconds) * AMOUNT_FACTOR(f.amountIsBucket)));
}

export function scorecard(action: ActionKind, f: ScorecardFacts): Scorecard {
  const notes: string[] = [];
  const publicSide = action === "withdraw" || action === "swap" || action === "shield" || action === "credit";

  // timing: only actions that leave the pool have a timing channel against the pool
  const timing = action === "transfer" ? 100 : action === "shield" ? 100 : clamp(100 / TIMING_FACTOR(f.delaySeconds));
  if (publicSide && action !== "shield" && f.delaySeconds < 3600) notes.push("acting within an hour of funding links the two by time; a delay of a day or more widens the set");

  // amount: private transfers never show one; public sides should use the bucket alphabet
  const amount = action === "transfer" ? 100 : f.amountIsBucket ? 95 : 15;
  if (publicSide && !f.amountIsBucket) notes.push("an arbitrary public amount is a fingerprint (the lab: ~19× smaller anonymity set); use a bucket");

  // financial: can the money history be reconstructed?
  let financial: number;
  if (action === "transfer") financial = 98; // only the existence of a transaction is public
  else if (action === "shield") financial = f.amountIsBucket ? 90 : 35; // the deposit is public by design; the bucket hides nothing but the amount class
  else financial = setScore(effectiveAnonymity(f));
  if (publicSide && action !== "shield" && effectiveAnonymity(f) < 10) notes.push(`the effective anonymity set is about ${Math.round(effectiveAnonymity(f))} — small pool or strong fingerprints`);

  // network: who sees the reads and the submission
  const base = f.rpcEndpoints >= 2 ? 65 : 40;
  const network = clamp(base + (f.privateSubmission || action === "shield" || action === "credit" ? 20 : 0));
  if (f.rpcEndpoints < 2) notes.push("one RPC endpoint serves every read; configure two or more (VITE_RPC_URLS) so none is trusted alone");
  if (!f.privateSubmission && (action === "transfer" || action === "withdraw" || action === "swap")) notes.push("submitting from your connected wallet ties the transaction to its address; the relayer route avoids that");
  notes.push("your IP is visible to the endpoints and the relayer; Tor / a light client are the native-app upgrade");

  // recipient: who receives, and how public that is
  let recipient: number;
  if (action === "transfer") recipient = 100; // a privacy address, the payload encrypted to the recipient
  else if (action === "shield") { recipient = 0; notes.push("a shield is public by design: your address funds the pool; privacy starts with the private transfers after it"); }
  else recipient = f.recipientFresh ? 85 : 10;
  if (publicSide && action !== "shield" && !f.recipientFresh) notes.push("the destination is a reused address: whoever knows it knows this payment");

  // provider: third parties in the path
  let provider: number;
  if (action === "swap" && f.provider) {
    provider = clamp(f.provider.crossChainScore - (f.provider.nativeAssets ? 0 : 5) - (f.provider.kind === "aggregator-api" ? 5 : 0));
    notes.push("the provider sees the one-time escrow, the destination and the amount; its cover traffic bounds the link between them (docs/privacy-lab.md)");
  } else if (action === "credit" && f.credit) {
    provider = f.credit.runtimeKey ? (f.credit.freshFunding ? 90 : 60) : 35;
    if (!f.credit.runtimeKey) notes.push("proxy mode lets the billing server read the content");
  } else provider = f.privateSubmission && action !== "shield" ? 95 : 100;

  const overall = clamp(0.25 * financial + 0.15 * network + 0.2 * recipient + 0.15 * timing + 0.15 * amount + 0.1 * provider);
  return { financial, network, recipient, timing, amount, provider, overall, notes };
}
