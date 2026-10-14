// Activity (spec v2.0 §7.8; doc §39, §73): the route — one local list of everything this wallet moved, from the
// encrypted journal, never from a server — the rows of ./rows.ts mapped by ./model.ts and drawn by ./View.tsx. Refresh
// tracks every open swap once. A scheduled funding that failed raises a warning; its technical reason is Advanced's.
import { useEffect, useState } from "react";
import { DESKTOP_QUERY, WarningCard, useMediaQuery } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { formatTime, intlLocale } from "../../app/i18n/intl";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { shortRef } from "@privacy-wallet/sdk/format";
import { trackOrder } from "@privacy-wallet/sdk/orderTracker";
import { isOpenSwap } from "@privacy-wallet/sdk/swapFunding";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { buildRows, groupByDay } from "./rows";
import { activityModel } from "./model";
import { reconcileOpenSwaps } from "@privacy-wallet/sdk/operations/swapRecords";
import { discoverSoon } from "@privacy-wallet/sdk/wallet/discovery";
import { ActivityView } from "./View";
import { useAllOperations, useSession, useSettings } from "../../hooks";

export interface ActivityProps {
  deployment?: Deployment | null;
  onOpen?: (rowId: string) => void;
}

export function Activity({ deployment = null, onOpen }: ActivityProps) {
  const t = useT();
  useSession(); // re-render on every journal write
  const { submission, advanced } = useSettings();
  const records = useAllOperations();
  const [refreshing, setRefreshing] = useState("");
  const wide = useMediaQuery(DESKTOP_QUERY);
  const j = session.isUnlocked() ? session.journal() : null;
  const groups = groupByDay(buildRows(j, records, advanced, t), t, Date.now(), intlLocale());
  // a scheduled funding that failed (a note scan that failed retries by itself and moves nothing)
  const failed = j ? j.schedule.filter((a) => !a.done && a.error && a.kind !== "discovery") : [];
  // V6 (spec v2.0 §12.5; doc §73): opening Activity reconciles the open swaps with the API (throttled; the wallet's reads win)
  useEffect(() => {
    if (session.isUnlocked()) void reconcileOpenSwaps(session.journal().swaps.filter(isOpenSwap));
    discoverSoon(); // a V6 follow-up: notes received since the last scan are looked for now (at most once a minute)
  }, []);

  async function refresh() {
    if (!j) return;
    const open = j.swaps.filter((s) => isOpenSwap(s) && (!["committed"].includes(s.state) || !!s.fundedTx));
    setRefreshing(t("activity.tracking", { n: open.length, plural: open.length === 1 ? "" : "s" }));
    for (const s of open) {
      try {
        await trackOrder(s, { deployment, relayerUrl: submission.kind === "relayer" ? submission.url : null });
      } catch {
        /* the next one */
      }
    }
    setRefreshing("");
  }

  const technical = advanced
    ? failed.map((a) =>
        t("activity.fundingFailed", {
          ref: shortRef(a.orderId),
          error: a.error ?? "",
          next: a.nextAttemptAt ? t("activity.nextAttempt", { time: formatTime(a.nextAttemptAt), n: a.attempts ?? 1 }) : "",
        }),
      )
    : null;
  const model = activityModel(groups, t, { refreshing: refreshing || null, advanced: technical, simple: !advanced });
  return (
    <ActivityView
      model={model}
      wide={wide}
      onOpen={(id) => onOpen?.(id)}
      onRefresh={() => void refresh()}
      notice={
        failed.length ? <WarningCard title={t("activity.fundingFailedTitle")} body={t("activity.fundingFailedBody")} testId="activity-funding-warning" /> : null
      }
    />
  );
}
