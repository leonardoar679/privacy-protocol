// The two status lines of More → Advanced and Home's details (the light client and the crypto core). Moved from
// App.tsx unchanged (V5 Stage 3), under More since Stage 10.
import { useSyncExternalStore } from "react";
import { coreStatus, subscribeCore, type CoreStatus } from "@privacy-wallet/sdk/core";
import { specForChain } from "@privacy-wallet/sdk/lightclient/spec";
import type { VerifyStatus } from "@privacy-wallet/sdk/verifiedReads";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { useSettings, useVerifyStatus } from "../../hooks";

export function useStatusLines(deployment: Deployment | null): { readsLine: string; coreLine: string; advanced: boolean } {
  const { advanced, verifyReads } = useSettings();
  const core = useSyncExternalStore(subscribeCore, coreStatus);
  const vs = useVerifyStatus();
  return { readsLine: readsLineOf(verifyReads, deployment, vs), coreLine: coreLineOf(core), advanced };
}

/** The light client's line, from the setting, the deployment's chain and the last check's status. */
export function readsLineOf(verifyReads: boolean, deployment: Deployment | null, vs: VerifyStatus): string {
  return !verifyReads ? "Off: the pool is read from the RPC endpoints' agreement alone."
    : !deployment || !specForChain(deployment.chainId) ? `No light client for chain ${deployment?.chainId ?? "?"} (a local devnet): reads rest on the RPC endpoints' agreement.`
    : vs.kind === "verified" ? `Verified at finalized block ${vs.proof.blockNumber}: ${vs.proof.nextLeafIndex} of ${vs.leaves} leaves proven (newer ones rest on the RPC endpoints until finality).`
    // a failed check says so (audit round 2, n42): the last success's line had stood after a refusal
    : vs.kind === "failed" ? `The last check failed: ${vs.reason.replace(/\.$/, "")}. Every transaction checks again first and is refused while it fails.`
    : "Checked before every transaction (beacon light client + storage proofs).";
}

/** The crypto core's line (Home's Advanced details read it after loading this module). */
export const coreLineOf = (core: CoreStatus): string =>
  core === "wasm" ? "crypto core: Rust (WASM)" : core === "typescript" ? "crypto core: TypeScript (no WASM package served)" : "crypto core: loads on the first sync";
