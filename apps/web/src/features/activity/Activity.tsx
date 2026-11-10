// Activity (spec v2.0 §7.8; doc §39, §73): the route — one local list of everything this wallet moved, from the
// encrypted journal, never from a server — the rows of ./rows.ts mapped by ./model.ts and drawn by ./View.tsx. Refresh
// tracks every open swap once. A scheduled action that failed raises a warning in its own words — a funding's, or an automatic step's with
// where its funds are (failureWarning; the eleventh review round, 2026-11-04, E11-5) —; its technical reason is Advanced's.
import { useEffect, useState } from "react";
import { DESKTOP_QUERY, WarningCard, useMediaQuery } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { formatTime, intlLocale } from "../../app/i18n/intl";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { shortRef } from "@privacy-wallet/sdk/format";
import { trackOrder } from "@privacy-wallet/sdk/orderTracker";
import { isOpenSwap } from "@privacy-wallet/sdk/swapFunding";
import { fundedOf, type JournalData, type ScheduledAction, type StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import type { FundsClass, OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { diagnose } from "@privacy-wallet/sdk/operations/recovery";
import { TERMINAL_STATES as CAMPAIGN_ENDED } from "@privacy-wallet/sdk/wallet/campaigns";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { buildRows, groupByDay } from "./rows";
import { activityModel } from "./model";
import { fundsHeadline } from "../operations/recovery";
import { reconcileOpenSwaps } from "@privacy-wallet/sdk/operations/swapRecords";
import { discoverSoon } from "@privacy-wallet/sdk/wallet/discovery";
import { ActivityView } from "./View";
import { useAllOperations, useSession, useSettings } from "../../hooks";

/** What Activity's list says over the scheduled actions whose last run failed. */
export type FailureWarning = { kind: "funding" } | { kind: "step"; funds: FundsClass };
const GRAVER: readonly FundsClass[] = ["not-moved", "still-protected", "unknown"];
const graver = (a: FundsClass, b: FundsClass): FundsClass => (GRAVER.indexOf(b) > GRAVER.indexOf(a) ? b : a);

/**
 * The warning over the scheduled actions whose last run failed (the eleventh review round, 2026-11-04, E11-5): every failure had read "A
 * scheduled funding did not go through … Your funds have not moved." — a protected swap's refund of a funded step, a funded order's tick, a
 * maintenance run. The funding's words stay for a funding that failed with nothing sent; any other action reads "An automatic step did not
 * go through" with the sentence about the funds its operation's records give: over what was funded or has a funding on its way, the gravest
 * class of their records — a step finished as asked or returned is "still protected", one not delivered as asked or still open reads its
 * record's class, never "not moved" (a funded order's record that says so, or none, reads "we are checking") —; "not moved" only when the
 * journal holds nothing of it funded. The leftover action of an order the journal holds as finished, or of a protected swap that ended,
 * raises no card (its own record says what happened), nor a maintenance run (it moves notes inside the pool only and tries again by itself)
 * or a scan; Advanced lists every one. Null when there is nothing to say. (Here, not in ./model.ts: Home's chunk reads that one.)
 */
export function failureWarning(
  failed: readonly ScheduledAction[],
  j: Pick<JournalData, "swaps" | "campaigns">,
  records: readonly OperationRecord[],
): FailureWarning | null {
  const same = (a: string, b: string | undefined) => b !== undefined && a.toLowerCase() === b.toLowerCase();
  const moved = (s: StoredSwap) => fundedOf(s) || !!s.fundingAttempt;
  const classOf = (s: StoredSwap): FundsClass => {
    const r = records.find((x) => same(s.orderId, x.refs.orderId));
    if (!r) return "unknown";
    if ((r.state === "COMPLETED" && (!r.outcome || r.outcome === "partial")) || r.state === "REFUNDED" || r.state === "CANCELLED") return "still-protected";
    const c = diagnose(r).fundsClass;
    return c === "not-moved" ? "unknown" : c;
  };
  let funds: FundsClass | null = null;
  let funding = false;
  for (const a of failed) {
    if (a.kind === "discovery" || a.kind === "housekeeping") continue;
    const ofCampaign = a.kind === "campaign-tick" || a.kind === "campaign-shape";
    if (ofCampaign && (j.campaigns ?? []).some((c) => c.id === a.orderId && CAMPAIGN_ENDED.includes(c.state))) continue;
    const orders = j.swaps.filter((s) => (ofCampaign ? same(a.orderId, s.campaign?.id) : same(a.orderId, s.orderId)));
    if (!ofCampaign && orders.length > 0 && !orders.some(isOpenSwap)) continue;
    const funded = orders.filter(moved);
    if (a.kind === "fund-escrow" && !funded.length) {
      funding = true;
      continue;
    }
    const c = funded.length ? funded.map(classOf).reduce(graver) : "not-moved";
    funds = funds === null ? c : graver(funds, c);
  }
  return funds !== null ? { kind: "step", funds } : funding ? { kind: "funding" } : null;
}

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
  // the scheduled actions whose last run failed (a note scan that failed retries by itself and moves nothing), and the card over them in
  // their own words (the eleventh review round, 2026-11-04, E11-5: every failure had read "A scheduled funding did not go through … Your
  // funds have not moved." — a protected swap's refund of a funded step, a funded order's tick, a maintenance run)
  const failed = j ? j.schedule.filter((a) => !a.done && a.error && a.kind !== "discovery") : [];
  const warning = j ? failureWarning(failed, j, records) : null;
  // V6 (spec v2.0 §12.5; doc §73): opening Activity reconciles the open swaps with the API (throttled; the wallet's reads win)
  useEffect(() => {
    if (session.isUnlocked()) void reconcileOpenSwaps(session.journal().swaps.filter(isOpenSwap));
    discoverSoon(); // a V6 follow-up: notes received since the last scan are looked for now (at most once a minute)
  }, []);

  async function refresh() {
    if (!j) return;
    const open = j.swaps.filter((s) => isOpenSwap(s) && (!["committed"].includes(s.state) || fundedOf(s)));
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
        t(a.kind === "fund-escrow" ? "activity.fundingFailed" : "activity.actionFailed", {
          ref: shortRef(a.orderId),
          error: a.error ?? "",
          // an action waiting behind the scan the counters wait on has no time of its own: its next attempt comes once the pool is read (the
          // twelfth review round, ZX's critique of 12b2d: the line had named none, its detail saying so)
          next: a.waitsOnScan
            ? t("activity.nextAfterScan")
            : a.nextAttemptAt
              ? t("activity.nextAttempt", { time: formatTime(a.nextAttemptAt), n: a.attempts ?? 1 })
              : "",
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
        warning ? (
          <WarningCard
            title={t(warning.kind === "funding" ? "activity.fundingFailedTitle" : "activity.stepFailedTitle")}
            body={warning.kind === "funding" ? t("activity.fundingFailedBody") : t("activity.stepFailedBody", { funds: fundsHeadline(warning.funds, t) })}
            testId="activity-funding-warning"
          />
        ) : null
      }
    />
  );
}
