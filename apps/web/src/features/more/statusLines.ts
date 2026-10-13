// The two status lines of More → Advanced and Home's details (the light client and the crypto core). Moved from
// App.tsx unchanged (V5 Stage 3), under More since Stage 10.
import { useSyncExternalStore } from "react";
import { coreStatus, subscribeCore } from "../../sdk/core";
import { specForChain } from "../../sdk/lightclient/spec";
import type { Deployment } from "../../sdk/chain";
import { useSettings, useVerifyStatus } from "../../hooks";

export function useStatusLines(deployment: Deployment | null): { readsLine: string; coreLine: string; advanced: boolean } {
  const { advanced, verifyReads } = useSettings();
  const core = useSyncExternalStore(subscribeCore, coreStatus);
  const vs = useVerifyStatus();
  const readsLine = !verifyReads ? "Off: the pool is read from the RPC endpoints' agreement alone."
    : !deployment || !specForChain(deployment.chainId) ? `No light client for chain ${deployment?.chainId ?? "?"} (a local devnet): reads rest on the RPC endpoints' agreement.`
    : vs.kind === "verified" ? `Verified at finalized block ${vs.proof.blockNumber}: ${vs.proof.nextLeafIndex} of ${vs.leaves} leaves proven (newer ones rest on the RPC endpoints until finality).`
    : "Checked before every transaction (beacon light client + storage proofs).";
  const coreLine = core === "wasm" ? "crypto core: Rust (WASM)" : core === "typescript" ? "crypto core: TypeScript (no WASM package served)" : "crypto core: loads on the first sync";
  return { readsLine, coreLine, advanced };
}
