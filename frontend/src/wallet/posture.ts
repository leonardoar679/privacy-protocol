// The wallet's privacy posture (plan V2 §75, §93): the facts the Privacy Center and the Home badge are
// computed from, read from the stores the wallet already keeps — nothing is fetched for it.
import { privacyPosture, type Posture, type PostureFacts } from "@ref/wallet/privacyCenter";
import type { Deployment } from "../sdk/chain";
import { DELAY_WINDOW, policyFromPreference } from "../sdk/policy";
import { specForChain } from "../sdk/lightclient/spec";
import { usePoolStats, type PoolStats } from "./poolStats";
import { useSettings, type Settings } from "./settings";

export function postureFacts(deployment: Deployment | null, s: Pick<Settings, "submission" | "preference" | "verifyReads">, pool: PoolStats | null): PostureFacts {
  const rpcEndpoints = deployment ? (deployment.rpcUrls?.length ? deployment.rpcUrls.length : 1) : 0;
  return {
    poolSize: pool?.notes ?? null,
    delayWindow: DELAY_WINDOW[policyFromPreference(s.preference)],
    privateSubmission: s.submission.kind === "relayer",
    rpcEndpoints,
    lightClient: !!deployment && s.verifyReads && !!specForChain(deployment.chainId),
    freshDestinations: true, // withdrawals, swaps and receipts default to a fresh address of this wallet (plan §28, §45–§46)
    crossChain: null,
  };
}

/** The posture from the live stores (re-renders when the pool stats or the settings change). */
export function usePosture(deployment: Deployment | null): Posture {
  const pool = usePoolStats();
  const s = useSettings();
  return privacyPosture(postureFacts(deployment, s, pool));
}
