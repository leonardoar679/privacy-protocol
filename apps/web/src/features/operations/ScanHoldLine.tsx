// Where the scan stands under a refusal because the counters wait on it (`notes_loading`; the twelfth review round, W6 §5.4): planned —
// or, offline, once the connection is back (ZP's critique: "shortly" while nothing runs) —, reading now, or failed, and once it has gone
// through "you can try again now". Why the wallet reads the pool is the refusal's own reason, just above (ZO's critique: the line had said
// it again); which hold, the next attempt and Try again now are the notice's, over every screen (app/ScanHeldNotice.tsx).
import { useSyncExternalStore } from "react";
import { scanHold, subscribeScanHold, type ScanHold } from "@privacy-wallet/sdk/wallet/discovery";
import { useT } from "../../app/i18n/useT";
import { useConnectivity } from "../../hooks/core";

export const useScanHold = (): ScanHold | null => useSyncExternalStore((l) => subscribeScanHold(l), () => scanHold());

export function ScanHoldLine({ testId = "scan-hold" }: { testId?: string }) {
  const t = useT();
  const h = useScanHold();
  const { online } = useConnectivity();
  return (
    // a live region: where the scan stands changes on its own, "you can try again now" with it (ZR's critique: it had changed in silence)
    <p className="ds-note" role="status" aria-live="polite" aria-atomic="true" data-testid={testId} data-hold={h?.hold ?? "none"}>
      {!h ? t("scan.held.read") : h.running ? t("scan.held.reading") : h.failed ? t("scan.held.lastFailed") : t(online ? "scan.held.planned" : "scan.held.offline")}
    </p>
  );
}
