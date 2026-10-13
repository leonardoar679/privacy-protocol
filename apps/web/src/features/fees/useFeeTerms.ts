// The relayer's terms for a vault, for the screens (spec §10): the live minimum with the wallet's margin and the
// percentage, read once per vault and refreshed on request; "unavailable" when no relayer serves the vault, which the
// screen says instead of guessing a fee.
import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import type { FeeTerms } from "@ref/wallet/fees";
import { useDeployment } from "../../app/deployment";
import { feeTerms } from "../../sdk/privateTx";
import { useSettings } from "../../wallet/settings";

export interface FeeTermsState { status: "idle" | "loading" | "ready" | "unavailable" | "public"; terms: FeeTerms | null; url: string | null; reason?: string }

export function useFeeTerms(vault: Address | null): FeeTermsState & { refresh: () => void } {
  const deployment = useDeployment();
  const { submission } = useSettings();
  const [state, setState] = useState<FeeTermsState>({ status: "idle", terms: null, url: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!deployment || !vault) { setState({ status: "idle", terms: null, url: null }); return; }
    if (submission.kind !== "relayer") { setState({ status: "public", terms: null, url: null }); return; }
    setState((s) => ({ ...s, status: "loading" }));
    feeTerms(deployment, submission, vault)
      .then((r) => { if (!alive) return; setState(r ? { status: "ready", terms: { minimum: r.fee.amount, feePercentBps: r.info.feePercentBps ?? 0 }, url: r.url } : { status: "public", terms: null, url: null }); })
      .catch((e: unknown) => { if (alive) setState({ status: "unavailable", terms: null, url: null, reason: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [deployment, vault, submission, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}
