// The relayer's terms for a vault, for the screens (spec §10): the live minimum with the wallet's margin and the
// percentage, read once per vault and refreshed on request; "unavailable" when no relayer serves the vault, which the
// screen says instead of guessing a fee.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import type { FeeTerms } from "@privacy-wallet/protocol/wallet/fees";
import { useDeployment } from "../../app/deployment";
import { feeTerms } from "@privacy-wallet/sdk/privateTx";
import { useSettings } from "../../hooks";

export interface FeeTermsState { status: "idle" | "loading" | "ready" | "unavailable" | "public"; terms: FeeTerms | null; url: string | null; reason?: string }

export function useFeeTerms(vault: Address | null): FeeTermsState & { refresh: () => void } {
  const deployment = useDeployment();
  const { submission } = useSettings();
  const [state, setState] = useState<FeeTermsState>({ status: "idle", terms: null, url: null });
  const [tick, setTick] = useState(0);
  const readyFor = useRef<Address | null>(null); // the vault whose terms the state holds
  useEffect(() => {
    let alive = true;
    if (!deployment || !vault) { setState({ status: "idle", terms: null, url: null }); return; }
    if (submission.kind !== "relayer") { setState({ status: "public", terms: null, url: null }); return; }
    // a refresh keeps the vault's terms until the new ones arrive: a Review shown meanwhile stays (audit round 2, r09)
    setState((s) => (s.status === "ready" && readyFor.current === vault ? s : { ...s, status: "loading" }));
    feeTerms(deployment, submission, vault)
      .then((r) => { if (!alive) return; readyFor.current = r ? vault : null; setState(r ? { status: "ready", terms: { minimum: r.fee.amount, feePercentBps: r.info.feePercentBps ?? 0 }, url: r.url } : { status: "public", terms: null, url: null }); })
      .catch((e: unknown) => { if (alive) setState({ status: "unavailable", terms: null, url: null, reason: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [deployment, vault, submission, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}
