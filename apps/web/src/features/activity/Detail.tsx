// An operation's detail (spec v2.0 §7.8; doc §40–§41): the route — the row of ./rows.ts mapped by ./model.ts and drawn
// by ./View.tsx. Refresh tracks a swap once; a record that needs attention shows its recovery (a refund through the
// executor, a refund-only job, or the monitoring — never a generic Retry); a protected execution shows its progress and
// the switch that pauses every large operation (moved here from Home, spec §7.1); a finished line can be removed from
// this device under Advanced.
import { useState, type ChangeEvent } from "react";
import { Card, StateScreen, Page } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { trackOrder } from "@privacy-wallet/sdk/orderTracker";
import { returnFunds } from "@privacy-wallet/sdk/wallet/orderRunner";
import { fundedOf } from "@privacy-wallet/sdk/wallet/journal";
import { deleteActivity } from "@privacy-wallet/sdk/wallet/activity";
import { isTerminal } from "@privacy-wallet/sdk/wallet/operationRecord";
import { removeOperation } from "@privacy-wallet/sdk/operations/store";
import { campaignById } from "@privacy-wallet/sdk/wallet/campaigns";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { needsAttention } from "../operations/recovery";
import { Recovery } from "../operations/RecoveryCard";
import { AttemptLine } from "../operations/AttemptLine";
import { errorWords, returnFundsWords } from "../operations/errorWords";
import { syncSwapRecord } from "@privacy-wallet/sdk/operations/swapRecords";
import { campaignStatus } from "../swap/protected/CampaignProgress";
import { campaignLineText, campaignStatusWords } from "../swap/protected/words";
import { buildRows, type ActivityRow } from "./rows";
import { detailModel } from "./model";
import { DetailView } from "./View";
import { useAllOperations, useSession, useSettings } from "../../hooks";

export interface DetailProps {
  id: string;
  deployment?: Deployment | null;
  onBack: () => void;
  onNewQuote?: () => void;
  /** a funded order's own page, where its pause's choice is (the eleventh review round, 2026-11-04, E11-14) */
  onOpenSwap?: (recordId: string) => void;
}

export function Detail({ id, deployment = null, onBack, onNewQuote, onOpenSwap }: DetailProps) {
  const t = useT();
  useSession();
  const { submission, advanced, protection } = useSettings();
  const records = useAllOperations();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const j = session.isUnlocked() ? session.journal() : null;
  const row: ActivityRow | undefined = buildRows(j, records, true, t).find(
    (r) => r.id === id || r.record?.id === id || r.ref.toLowerCase() === id.toLowerCase(),
  );
  if (!row) {
    return (
      <Page title={t("route.activity")} back={onBack} testId="activity-detail">
        <Card>
          <StateScreen kind="empty" title={t("activity.detailMissing")} testId="detail-missing" />
        </Card>
      </Page>
    );
  }
  const rec = row.record;
  const swap = row.swap;
  async function refresh() {
    if (!swap) return;
    setBusy(t("activity.trackingOne"));
    setError("");
    // this opening of the wallet only (the tenth review round, A10-5): a lock and another phrase during the read had written this wallet's
    // swap record into the other one's journal
    const s = session.pinned();
    try {
      const r = await trackOrder(swap, { deployment, relayerUrl: submission.kind === "relayer" ? submission.url : null, session: s });
      syncSwapRecord(swap, r.tracked, r.job, Date.now(), s);
    } catch (e) {
      // the catalog's words, the raw text after them under Advanced only (the eleventh review round, 2026-11-04, E11-10)
      setError(errorWords(t, e, { advanced, fallback: "activity.refreshFailed" }));
    } finally {
      setBusy("");
    }
  }
  async function refund() {
    const seed = session.isUnlocked() ? session.state().seed : null;
    if (!swap || !seed) return;
    setBusy(t("swap.handingRefund"));
    setError("");
    try {
      // the runner's own return, the Swap screen's (the ninth review round, 2026-11-04, C-05): it reads the escrow and the funding's fate,
      // asks the order's own relayer, clears the pause and plans the next tick — Activity's own call had done none of it, and the record
      // stayed "Refunding" with "Accept new minimum" still offered after the refund had landed
      await returnFunds(swap.orderId, { masterSeed: seed, deployment });
      await refresh();
    } catch (e) {
      // the catalog's words, never the relayer's or the runner's text in their place (the eleventh review round, 2026-11-04, E11-10)
      setError(returnFundsWords(t, e, advanced));
    } finally {
      setBusy("");
    }
  }
  const campaign = row.kind === "campaign" ? campaignById(row.ref) : rec?.refs.campaignId ? campaignById(rec.refs.campaignId) : undefined;
  // a funded order goes on from its own page (the eleventh review round, 2026-11-04, E11-14): Accept new minimum, Try again and Return funds
  // live on /swap/progress — "Get a new quote" had opened a blank swap while this order's funds waited, still paused, for its choice
  // — and so does an order paused for the user's choice before its funding, whose page offers Accept new minimum and the cancel (the fifth
  // critique of slice 4: its card had offered "Get a new quote" while the order stayed paused)
  const openSwap = rec && swap && (fundedOf(swap) || !!swap.paused) && !swap.campaign && onOpenSwap ? () => onOpenSwap(rec.id) : undefined;
  const pauseLarge = (e: ChangeEvent<HTMLInputElement>) => settings.set({ protection: { ...protection, pauseLargeOperations: e.target.checked } });
  const extra = campaign ? (
    <Card padding="md" testId="campaign-line">
      {(() => {
        const st = campaignStatus(campaign);
        return (
          <p>
            <b>
              {st.mark} {campaignStatusWords(t, st)}
            </b>{" "}
            · {t("home.protectedSwap", { from: campaign.request.from.symbol, to: campaign.request.to.symbol, line: campaignLineText(t, campaign, advanced) })}
          </p>
        );
      })()}
      {advanced && row.campaignLine ? (
        <p className="ds-note" data-testid="activity-campaign">
          {row.campaignLine}
        </p>
      ) : null}
      <AttemptLine orderId={campaign.id} testId="campaign-attempt" />
      <label className="ds-switch-row ds-native-row">
        <span>{t("home.pauseLarge")}</span>
        <input type="checkbox" checked={protection.pauseLargeOperations} onChange={pauseLarge} data-testid="pause-large-operations" />
      </label>
    </Card>
  ) : null;
  return (
    <div data-row={row.id} data-state={rec?.state ?? ""}>
      <DetailView
        model={detailModel(row, t)}
        onBack={onBack}
        onRefresh={swap ? () => void refresh() : undefined}
        onRemove={() => {
          if (row.activity) deleteActivity(row.activity.id);
          // the record too, once it is over (the review round of 2026-11-03, W3): without this the row came back from the record —
          // amounts and destination kept on the device — with no Remove any more
          if (rec && isTerminal(rec.state)) removeOperation(rec.id);
          onBack();
        }}
        busy={busy || null}
        extra={extra}
        recovery={
          <>
            {/* an alert, read out the moment it appears (the eleventh review round, 2026-11-04, E11-6: a failed return or refresh was silent) */}
            {error ? (
              <p className="ds-note-warn" role="alert" data-testid="detail-error">
                {error}
              </p>
            ) : null}
            {rec && needsAttention(rec) ? (
              <Recovery
                record={rec}
                onMonitor={swap ? () => void refresh() : undefined}
                onRefund={swap && fundedOf(swap) ? () => void refund() : undefined}
                onNewQuote={openSwap ? undefined : onNewQuote}
                onOpenSwap={openSwap}
              />
            ) : null}
          </>
        }
      />
    </div>
  );
}
