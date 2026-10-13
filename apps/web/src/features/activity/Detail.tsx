// The operation's detail (spec §3.10, §14; plan §28): the pair and the value, the status, the source, the destination
// with its verification, the fees, the provider (Advanced only), the transaction, and "View advanced details" —
// Execution ID, Quote ID, Block, Root, Nullifier status, Provider execution ID, Relayer transaction, Confirmation
// state, Recovery state — read from the record's refs; Refresh tracks a swap once; the recovery card when the record
// needs attention, with the refund through the executor (a refund-only job) or the monitoring.
import { useState } from "react";
import { formatUsd } from "@privacy-wallet/protocol/wallet/valuation";
import { Card, Collapsible, IconButton, Page, StatusBadge, TextButton } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { shortRef } from "@privacy-wallet/sdk/format";
import { trackOrder } from "@privacy-wallet/sdk/orderTracker";
import { returnOrderToBalance } from "@privacy-wallet/sdk/swapExecute";
import { deleteActivity } from "@privacy-wallet/sdk/wallet/activity";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { needsAttention, stateWords } from "../operations/recovery";
import { Recovery } from "../operations/RecoveryCard";
import { syncSwapRecord } from "../swap/records";
import { buildRows, type ActivityRow } from "./rows";
import { useAllOperations, useSession, useSettings } from "../../hooks";

export interface DetailProps { id: string; deployment?: Deployment | null; onBack: () => void; onNewQuote?: () => void }

const Row = ({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) => <div className="ds-kv" data-testid={testId}><span className="ds-kv-label">{label}</span><span className="ds-kv-value">{children}</span></div>;

export function Detail({ id, deployment = null, onBack, onNewQuote }: DetailProps) {
  const t = useT();
  useSession();
  const { submission, advanced } = useSettings();
  const records = useAllOperations();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const j = session.isUnlocked() ? session.journal() : null;
  const row: ActivityRow | undefined = buildRows(j, records, true, t).find((r) => r.id === id || r.record?.id === id || r.ref.toLowerCase() === id.toLowerCase());
  if (!row) return <Page title={t("route.activity")} back={onBack} testId="activity-detail"><Card><p className="ds-note" data-testid="detail-missing">{t("activity.detailMissing")}</p></Card></Page>;
  const rec = row.record;
  const swap = row.swap;
  const req = swap?.request as { from?: { symbol?: string }; to?: { symbol?: string }; destination?: string } | undefined;
  const value = swap?.value && typeof swap.value === "object" && "usd" in (swap.value as object) ? formatUsd((swap.value as { usd: number }).usd) : null;
  const pair = req?.from?.symbol && req.to?.symbol ? `${req.from.symbol} → ${req.to.symbol}` : row.title;
  const destination = rec?.destination.display ?? req?.destination ?? (row.activity?.note ?? "");
  const destinationKind = rec?.destination.kind ?? (swap ? ((swap.request as { destinationKind?: string }).destinationKind === "entered" ? "entered" : "fresh") : undefined);
  const fees = rec?.fees ?? [];
  const privacyFee = fees.find((f) => /privacy/i.test(f.label));
  const relayerFee = fees.find((f) => /relayer|network/i.test(f.label));
  const txs = rec?.refs.txHashes ?? (row.activity ? [row.activity.ref] : []);
  async function refresh() {
    if (!swap) return;
    setBusy(t("activity.trackingOne")); setError("");
    try { const r = await trackOrder(swap, { deployment, relayerUrl: submission.kind === "relayer" ? submission.url : null }); syncSwapRecord(swap, r.tracked, r.job); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(""); }
  }
  async function refund() {
    if (!swap) return;
    setBusy(t("swap.handingRefund")); setError("");
    try { await returnOrderToBalance({ deployment, stored: swap, submission }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(""); }
  }
  return (
    <Page title={t("route.activity")} back={onBack} testId="activity-detail" actions={swap ? <IconButton label={t("activity.refresh")} icon="refresh" onClick={() => void refresh()} disabled={!!busy} data-testid="detail-refresh" /> : undefined}>
      <div className="ds-stack" data-row={row.id} data-state={rec?.state ?? ""}>
        <Card>
          <div className="ds-stack-sm">
            <div className="ds-kv"><b data-testid="detail-pair">{pair}</b><span className="ds-numeral" data-testid="detail-value">{value ?? row.amount}</span></div>
            <Row label={t("activity.status")} testId="detail-status"><StatusBadge tone={row.tone}>{row.status}</StatusBadge></Row>
            <Row label={t("activity.source")}>{t("activity.sourceProtected", { symbol: row.activity?.asset ?? rec?.amounts.asset ?? "" })}</Row>
            {destination ? <Row label={t("activity.destination")} testId="detail-destination">{shortRef(destination, 6, 4)}{destinationKind === "fresh" || destinationKind === "book" || destinationKind === "privacy-address" ? ` ✓ ${t("activity.verified")}` : destinationKind === "entered" ? ` · ${t("activity.entered")}` : ""}</Row> : null}
            {privacyFee ? <Row label={t("activity.privacyFee")}>{privacyFee.value}</Row> : null}
            {relayerFee ? <Row label={t("activity.relayer")}>{relayerFee.value}</Row> : null}
            {advanced && (swap?.provider ?? rec?.refs.provider) ? <Row label={t("activity.provider")} testId="detail-provider">{swap?.provider ?? rec?.refs.provider}</Row> : null}
            {txs.length ? <Row label={t("activity.transaction")} testId="detail-tx"><code className="ds-mono-break">{txs[txs.length - 1]}</code> <TextButton onClick={() => navigator.clipboard?.writeText(txs[txs.length - 1])} data-testid="detail-copy">{t("receive.copy")}</TextButton></Row> : null}
          </div>
        </Card>
        <Collapsible summary={t("activity.advancedDetails")} testId="detail-advanced">
          <div className="ds-stack-sm ds-note" data-testid="detail-advanced-list">
            <Row label={t("activity.executionId")}>{rec?.refs.orderId ?? swap?.orderId ?? "—"}</Row>
            <Row label={t("activity.quoteId")}>{rec?.refs.quoteId ?? "—"}</Row>
            <Row label={t("activity.block")}>{"—"}</Row>
            <Row label={t("activity.root")}>{"—"}</Row>
            <Row label={t("activity.nullifierStatus")}>{rec?.refs.leafIndex !== undefined ? t("activity.leafAt", { leaf: rec.refs.leafIndex }) : "—"}</Row>
            <Row label={t("activity.providerExecutionId")}>{rec?.refs.executionRef ?? swap?.executionRef ?? "—"}</Row>
            <Row label={t("activity.relayerTransaction")}>{rec?.refs.executionTx ?? swap?.executionTx ?? "—"}</Row>
            <Row label={t("activity.confirmationState")}>{rec ? stateWords(rec.state, t) : swap?.track?.label ?? row.status}</Row>
            <Row label={t("activity.recoveryState")}>{rec?.recovery?.state ?? "—"}</Row>
            {rec ? <Row label={t("activity.history")}>{rec.history.map((h) => `${new Date(h.at).toLocaleTimeString()} ${h.state}${h.note ? ` (${h.note})` : ""}`).join(" · ")}</Row> : null}
          </div>
        </Collapsible>
        {busy ? <p className="ds-note" data-testid="detail-busy">{busy}</p> : null}
        {error ? <p className="ds-note-warn" data-testid="detail-error">{error}</p> : null}
        {rec && needsAttention(rec) ? <Recovery record={rec} onMonitor={swap ? () => void refresh() : undefined} onRefund={swap && swap.fundedTx ? () => void refund() : undefined} onNewQuote={onNewQuote} /> : null}
        {row.finished && row.activity ? <TextButton onClick={() => { deleteActivity(row.activity!.id); onBack(); }} data-testid="detail-remove">{t("activity.remove")}</TextButton> : null}
      </div>
    </Page>
  );
}
