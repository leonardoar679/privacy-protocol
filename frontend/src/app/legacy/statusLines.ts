// The two status lines the legacy Settings screen shows (the light client and the crypto core), computed here until
// Stage 10 moves them under More → Advanced. Moved from App.tsx unchanged.
import { useSyncExternalStore } from "react";
import { coreStatus, subscribeCore } from "../../sdk/core";
import { specForChain } from "../../sdk/lightclient/spec";
import { useVerifyStatus } from "../../sdk/verifiedReads";
import { useSettings } from "../../wallet/settings";
import type { Deployment } from "../../sdk/chain";

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
