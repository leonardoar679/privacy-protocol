// The wallet's privacy posture (plan V2 §75, §93): the facts the Privacy Center and the Home badge are
// computed from, read from the stores the wallet already keeps — nothing is fetched for it.
import type { PostureFacts } from "@privacy-wallet/protocol/wallet/privacyCenter";
import type { Deployment } from "../chain";
import { specForChain } from "../lightclient/spec";
import { type PoolStats } from "./poolStats";
import { type Settings } from "./settings";

export function postureFacts(deployment: Deployment | null, s: Pick<Settings, "submission" | "preference" | "verifyReads">, pool: PoolStats | null): PostureFacts {
  const rpcEndpoints = deployment ? (deployment.rpcUrls?.length ? deployment.rpcUrls.length : 1) : 0;
  return {
    poolSize: pool?.notes ?? null,
    // the one-confirmation runner funds a swap as soon as it is confirmed (spec v2.0 §7.6); only "Delay for more privacy", chosen
    // on a swap, adds a random 1–24 h — the preference's window had scored a delay the wallet no longer takes (the review round of
    // 2026-11-03, W1)
    delayWindow: [0, 0],
    privateSubmission: s.submission.kind === "relayer",
    rpcEndpoints,
    lightClient: !!deployment && s.verifyReads && !!specForChain(deployment.chainId),
    freshDestinations: true, // withdrawals, swaps and receipts default to a fresh address of this wallet (plan §28, §45–§46)
    crossChain: null,
  };
}
