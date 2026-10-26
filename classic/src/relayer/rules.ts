// Whether a relayer may be offered for a pool (spec v3.0 §7.5; the review's R-6 to R-8; the original UI's rules): healthy,
// on this network, serving this pool at this address, paying to the account the registry knows, a fee under the cap the
// user sees, a queue of at most five, a version the protocol trusts (4.1.4 and up, any 5.x). Pure.
import { isHealthy, type RelayerStatus } from "./schema.ts";

export type RelayerProblem =
  "unhealthy" | "other network" | "pool not served" | "reward account differs" | "fee above cap" | "queue overloaded" | "version outdated";

export interface RelayerCheckInput {
  status: RelayerStatus;
  netId: number;
  /** the pool's address and the amount the status lists it under ("0.1", "1", "10", "100") */
  pool: { address: string; amount: string };
  /** the account the registry registered for this relayer; null for a relayer the user typed in */
  expectedRewardAccount?: string | null;
  /** the cap the user sees before choosing, a percent (the original schema's 20 at most) */
  maxFeePercent?: number;
  maxQueue?: number;
}

export interface RelayerFacts {
  rewardAccount: `0x${string}`;
  /** the service fee as percent × 10,000 (0.3 % → 3,000) */
  feePercentE4: number;
  version: string;
  currentQueue: number;
}

export type RelayerVerdict = { ok: true; facts: RelayerFacts } | { ok: false; problems: RelayerProblem[]; facts: RelayerFacts };

export const MAX_FEE_PERCENT = 20;
export const MAX_QUEUE = 5;

/** percent → percent × 10,000, rounded (0.05 → 500). */
export const feePercentE4 = (percent: number): number => Math.round(percent * 10_000);

/** 5.0.0 and any later 5.x; 4.1.4 and any later 4.x (a 4.x beta from 11, as the original UI took them); nothing older. */
export function versionAccepted(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const prerelease = m[4];
  if (major >= 5) return true;
  if (major !== 4) return false;
  if (prerelease) {
    const beta = Number(prerelease.split(".").at(-1));
    return Number.isFinite(beta) && beta >= 11;
  }
  return minor > 1 || (minor === 1 && patch >= 4);
}

export function checkRelayer(input: RelayerCheckInput): RelayerVerdict {
  const { status } = input;
  const problems: RelayerProblem[] = [];
  const facts: RelayerFacts = {
    rewardAccount: status.rewardAccount.toLowerCase() as `0x${string}`,
    feePercentE4: feePercentE4(status.tornadoServiceFee),
    version: status.version,
    currentQueue: status.currentQueue ?? 0,
  };
  if (!isHealthy(status)) problems.push("unhealthy");
  if (status.netId !== input.netId) problems.push("other network");
  const served = status.instances.eth.instanceAddress[input.pool.amount];
  if (!served || served.toLowerCase() !== input.pool.address.toLowerCase()) problems.push("pool not served");
  if (input.expectedRewardAccount && input.expectedRewardAccount.toLowerCase() !== facts.rewardAccount) problems.push("reward account differs");
  if (status.tornadoServiceFee > (input.maxFeePercent ?? MAX_FEE_PERCENT)) problems.push("fee above cap");
  if (facts.currentQueue > (input.maxQueue ?? MAX_QUEUE)) problems.push("queue overloaded");
  if (!versionAccepted(status.version)) problems.push("version outdated");
  return problems.length ? { ok: false, problems, facts } : { ok: true, facts };
}
