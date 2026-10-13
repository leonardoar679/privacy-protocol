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
import { returnOrderToBalance } from "@privacy-wallet/sdk/swapExecute";
import { deleteActivity } from "@privacy-wallet/sdk/wallet/activity";
import { campaignById, progressLine } from "@privacy-wallet/sdk/wallet/campaigns";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { needsAttention } from "../operations/recovery";
import { Recovery } from "../operations/RecoveryCard";
import { syncSwapRecord } from "../swap/records";
import { campaignStatus } from "../swap/protected/CampaignProgress";
import { buildRows, type ActivityRow } from "./rows";
import { detailModel } from "./model";
import { DetailView } from "./View";
import { useAllOperations, useSession, useSettings } from "../../hooks";

export interface DetailProps {
  id: string;
  deployment?: Deployment | null;
  onBack: () => void;
  onNewQuote?: () => void;
}

export function Detail({ id, deployment = null, onBack, onNewQuote }: DetailProps) {
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
    try {
      const r = await trackOrder(swap, { deployment, relayerUrl: submission.kind === "relayer" ? submission.url : null });
      syncSwapRecord(swap, r.tracked, r.job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  async function refund() {
    if (!swap) return;
    setBusy(t("swap.handingRefund"));
    setError("");
    try {
      await returnOrderToBalance({ deployment, stored: swap, submission });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }
  const campaign = row.kind === "campaign" ? campaignById(row.ref) : rec?.refs.campaignId ? campaignById(rec.refs.campaignId) : undefined;
  const pauseLarge = (e: ChangeEvent<HTMLInputElement>) => settings.set({ protection: { ...protection, pauseLargeOperations: e.target.checked } });
  const extra = campaign ? (
    <Card padding="md" testId="campaign-line">
      {(() => {
        const st = campaignStatus(campaign);
        return (
          <p>
            <b>
              {st.mark} {st.word}
            </b>{" "}
            · {t("home.protectedSwap", { from: campaign.request.from.symbol, to: campaign.request.to.symbol, line: progressLine(campaign, advanced) })}
          </p>
        );
      })()}
      {advanced && row.campaignLine ? (
        <p className="ds-note" data-testid="activity-campaign">
          {row.campaignLine}
        </p>
      ) : null}
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
          onBack();
        }}
        busy={busy || null}
        extra={extra}
        recovery={
          <>
            {error ? (
              <p className="ds-note-warn" data-testid="detail-error">
                {error}
              </p>
            ) : null}
            {rec && needsAttention(rec) ? (
              <Recovery
                record={rec}
                onMonitor={swap ? () => void refresh() : undefined}
                onRefund={swap && swap.fundedTx ? () => void refund() : undefined}
                onNewQuote={onNewQuote}
              />
            ) : null}
          </>
        }
      />
    </div>
  );
}
