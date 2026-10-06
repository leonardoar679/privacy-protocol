// Live privacy score — turns the privacy lab's measurements into a user-facing feature.
// Constants come from docs/privacy-lab.md (benchmarks/privacy/run.mjs, the study's adversary against
// this protocol's public surface with the shipped wallet policy):
//   - amount: arbitrary public amounts collapse the set ~19.4x (P0); bucketed pieces ~2.9x (P1).
//   - timing: a delay floor + randomized delay widen the timing-only set 3.4x (P1) to 9.8x (P2).
//   - channels MULTIPLY: naive joint collapse 23.4x; P1 brings the joint effective set from 10 to 349.
// Network channels (RPC, mempool, relayer; L3/L4) are outside the lab and discounted separately.
export interface PrivacyFactors {
  poolSize: number; // nominal anonymity set for the asset/pool
  delaySeconds: number; // planned delay between deposit and withdrawal
  amountStandardized: boolean; // using common denomination buckets vs. a one-off amount
  privateSubmission: boolean; // private mempool / oblivious relay vs. public broadcast
  privateRpc: boolean; // light client / private RPC vs. a default provider
}

export type Risk = "Low" | "Medium" | "High";

export interface PrivacyReport {
  score: number; // 0..100
  effectiveAnonymity: number;
  timingRisk: Risk;
  amountRisk: Risk;
  rpcExposure: "Protected" | "Exposed";
  relayer: "Private" | "Public";
}

export function computePrivacy(f: PrivacyFactors): PrivacyReport {
  let timingFactor: number;
  let timingRisk: Risk;
  if (f.delaySeconds < 60) {
    timingFactor = 3.0;
    timingRisk = "High";
  } else if (f.delaySeconds < 3600) {
    timingFactor = 1.8;
    timingRisk = "Medium";
  } else if (f.delaySeconds < 86400) {
    timingFactor = 1.2;
    timingRisk = "Low";
  } else {
    timingFactor = 1.05;
    timingRisk = "Low";
  }

  const amountFactor = f.amountStandardized ? 2.9 : 19.4; // privacy lab: P1 vs P0 amount-only collapse
  const amountRisk: Risk = f.amountStandardized ? "Low" : "High";

  const effectiveAnonymity = Math.max(1, Math.floor(f.poolSize / (timingFactor * amountFactor)));

  let score = 100 * (effectiveAnonymity / Math.max(1, f.poolSize));
  if (!f.privateRpc) score *= 0.6; // RPC can bridge IP <-> pool (TC-08)
  if (!f.privateSubmission) score *= 0.8; // public mempool leaks timing/relayer metadata (TC-07)
  score = Math.round(Math.max(0, Math.min(100, score)));

  return {
    score,
    effectiveAnonymity,
    timingRisk,
    amountRisk,
    rpcExposure: f.privateRpc ? "Protected" : "Exposed",
    relayer: f.privateSubmission ? "Private" : "Public",
  };
}
