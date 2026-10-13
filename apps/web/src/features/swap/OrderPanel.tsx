// The order after commit (private-swap spec §11; whale spec §19, §24; plan §33, §60–§61): the destination card, the
// privacy level, the funding line, the review hold, the refund-after line, the advanced rows, the three actions (fund,
// confirm, return), the minimum-moved notice, what the wallet checked before signing, the lint read against the call,
// the simulation line, the settlement line from the tracker and the executor's job, the refund line — and the
// recovery card from the operation record when the order needs attention.
import type { Hex } from "viem";
import { levelOf } from "@privacy-wallet/protocol/wallet/privacyCenter";
import type { LintItem } from "@privacy-wallet/protocol/wallet/privacyLint";
import { Button, Card, Collapsible } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { formatAmount, type Asset } from "@privacy-wallet/sdk/assets";
import { fmtUnits } from "@privacy-wallet/sdk/format";
import type { MinimumMoved, CheckedCall } from "@privacy-wallet/sdk/providerCall";
import { swapJobStatus, type SwapJob } from "@privacy-wallet/sdk/relayer";
import type { AssetRef, ServiceOrder } from "@privacy-wallet/sdk/swapService";
import type { Tracked } from "@privacy-wallet/sdk/orderTracker";
import type { Submission } from "@privacy-wallet/sdk/wallet/settings";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { DestinationCard } from "../../components/DestinationCard";
import { PrivacyLint } from "../../components/PrivacyLint";
import { SettlementLine } from "../../components/SettlementLine";
import { needsAttention } from "../operations/recovery";
import { Recovery } from "../operations/RecoveryCard";
import { OPEN_FOR_RESIGN, canReturn, hours, type Target } from "./targets";

export interface OrderPanelProps {
  order: ServiceOrder;
  stored: StoredSwap | null;
  orderAsset: Asset;
  target: Target;
  destination: string;
  destinationEdited: boolean;
  orderKeyAddress?: Hex | null;
  job: SwapJob | null;
  tracked: Tracked | null;
  record: OperationRecord | null;
  signed: string | null;
  checked: CheckedCall | null;
  moved: MinimumMoved | null;
  refundLine: string;
  signLint: LintItem[] | null;
  advanced: boolean;
  busy: string;
  submission: Submission;
  holdActive: boolean;
  canExport: boolean;
  onFundNow: () => void;
  onSign: (acceptMin?: bigint) => void;
  onReturn: () => void;
  onExport: () => void;
  onMonitor: () => void;
}

export function OrderPanel(p: OrderPanelProps) {
  const t = useT();
  const funded = !!p.stored?.fundedTx;
  const dueAt = p.stored?.dueAt;
  const to = ((p.stored?.request as { to?: AssetRef } | undefined)?.to ?? p.target.ref);
  const refundAfter = new Date(p.order.params.refundAfter * 1000).toLocaleString();
  const attention = p.record && needsAttention(p.record);
  return (
    <Card testId="order-panel">
      <div className="ds-stack-sm" data-order={p.order.orderId} data-state={p.stored?.state ?? p.order.state}>
        <DestinationCard network={p.target.network} asset={to.symbol} address={p.destination} amount={fmtUnits(p.order.quote.toAmount, to.decimals)} kind={p.destinationEdited ? "entered" : "fresh"} />
        <div className="ds-kv"><span className="ds-kv-label">{t("review.privacy")}</span><b className={`ds-level ds-level-${levelOf(p.order.privacy.score)}`}>{levelOf(p.order.privacy.score)}{p.advanced ? ` (${p.order.privacy.score}/100)` : ""}</b></div>
        <div className="ds-kv"><span className="ds-kv-label">{funded ? t("order.funded") : dueAt ? t("order.fundingScheduled") : t("order.funding")}</span><b className="ds-kv-value">{funded ? t("order.fundedTx", { hash: `${p.stored!.fundedTx!.slice(0, 10)}…` }) : dueAt ? t("order.scheduledAt", { time: new Date(dueAt).toLocaleString(), lo: hours(p.order.privacy.delaySeconds[0]), hi: hours(p.order.privacy.delaySeconds[1]) }) : t("order.notYet")}</b></div>
        {p.holdActive ? <p className="ds-note-warn" data-testid="review-hold">{t("order.reviewHold", { time: new Date(p.stored!.reviewHoldUntil!).toLocaleTimeString() })}</p> : null}
        <div className="ds-kv"><span className="ds-kv-label">{t("order.returnsBy")}</span><b className="ds-kv-value">{refundAfter}</b></div>
        {p.advanced ? (
          <Collapsible summary={t("order.advanced")} testId="order-advanced" defaultOpen>
            <div className="ds-stack-sm ds-note">
              <div className="ds-kv"><span className="ds-kv-label">{t("review.route")}</span><b>{p.order.quote.provider}</b></div>
              <div className="ds-kv"><span className="ds-kv-label">{t("order.escrow")}</span><code className="ds-mono-break">{p.order.endpoint}</code></div>
              <div className="ds-kv"><span className="ds-kv-label">{t("order.tip")}</span><b>{formatAmount(p.orderAsset, BigInt(p.order.params.executorTip))} {p.orderAsset.symbol}</b></div>
              <div className="ds-kv"><span className="ds-kv-label">{t("order.orderKey")}</span><code className="ds-mono-break">{p.orderKeyAddress ?? ""}</code></div>
            </div>
          </Collapsible>
        ) : null}
        <div className="ds-actions">
          <Button onClick={p.onFundNow} disabled={!!p.busy || funded || p.holdActive} title={p.holdActive ? t("order.holdNotPassed") : dueAt ? t("order.fundNowHint") : undefined} data-testid="order-fund">{dueAt && !funded ? t("order.fundNowEarly") : t("order.fundNow")}</Button>
          <Button onClick={() => p.onSign()} disabled={!!p.busy || !funded || (!!p.job && !OPEN_FOR_RESIGN.includes(p.job.state))} data-testid="order-confirm">{p.job && OPEN_FOR_RESIGN.includes(p.job.state) ? t("order.confirmAgain") : t("order.confirm")}</Button>
          {funded && canReturn(p.job?.state) ? <Button variant="secondary" onClick={p.onReturn} disabled={!!p.busy} title={t("order.returnHint")} data-testid="order-return">{t("order.return")}</Button> : null}
          {p.canExport && p.stored ? <Button variant="secondary" icon="download" onClick={p.onExport}>{t("review.export")}</Button> : null}
        </div>
        {p.moved ? (() => {
          const dec = to.decimals, sym = to.symbol;
          const drop = p.moved.approved > 0n ? Number(((p.moved.approved - p.moved.minOut) * 10000n) / p.moved.approved) / 100 : 0;
          return (
            <div className="ds-review-block" data-testid="minimum-moved">
              <p className="ds-note">{t("order.priceMoved", { min: `${fmtUnits(p.moved.minOut.toString(), dec)} ${sym}`, approved: `${fmtUnits(p.moved.approved.toString(), dec)} ${sym}`, drop })}</p>
              <p className="ds-note">{t("order.priceMovedNote", { time: refundAfter })}</p>
              <div className="ds-actions">
                <Button variant="secondary" onClick={() => p.onSign(p.moved!.minOut)} disabled={!!p.busy}>{t("order.confirmNewMinimum")}</Button>
                <Button variant="ghost" onClick={p.onReturn} disabled={!!p.busy}>{t("order.returnInstead")}</Button>
              </div>
            </div>
          );
        })() : null}
        {p.checked ? <p className="ds-note" data-testid="checked-line">{t("order.checked", { minimum: p.checked.minOut !== null ? t("order.checkedMinimum", { amount: `${fmtUnits(p.checked.minOut.toString(), to.decimals)} ${to.symbol}` }) : "", refund: p.checked.refundTo === "destination" ? t("order.refundAtDestination") : t("order.refundToPool") })}{p.advanced ? ` (${p.checked.provider}: ${p.checked.facts.join("; ")})` : ""}</p> : null}
        {p.signLint ? <PrivacyLint items={p.signLint} compact /> : null}
        {p.stored?.simulation ? <p className="ds-note">{p.stored.simulation.ok ? t("order.simulated", { gas: p.stored.simulation.gas ? t("order.simulatedGas", { gas: Number(p.stored.simulation.gas).toLocaleString() }) : "" }) : t("order.simulationFailed", { reason: p.stored.simulation.reason ?? p.stored.simulation.error ?? "" })}</p> : null}
        {p.signed ? <p className="ds-note">{t("order.confirmed", { label: p.signed })}{p.submission.kind !== "relayer" ? ` ${t("order.selfSubmit")}` : ""}</p> : null}
        {p.tracked ? <SettlementLine tracked={p.tracked} /> : p.job ? <p className="ds-note">{t("order.status")}: <b>{swapJobStatus(p.job.state)}</b></p> : <p className="ds-note">{t("order.status")}: {t("order.pending")} — {funded ? t("order.pendingFunded") : dueAt ? t("order.pendingScheduled") : t("order.pendingUnfunded")}</p>}
        {p.job ? <p className="ds-note">{p.advanced ? `${t("order.executor")}: ${p.job.state}${p.job.executionTx ? `, ${t("order.execution", { hash: `${p.job.executionTx.slice(0, 10)}…` })}` : p.job.txHash ? `, tx ${p.job.txHash.slice(0, 10)}…` : ""}${p.job.error ? `, ${p.job.error}` : ""} — ` : ""}{t("order.refreshNote")}</p> : null}
        {p.job?.state === "executed" ? <p className="ds-note">{(p.checked?.refundTo ?? (p.stored?.quote as { refundTarget?: string } | undefined)?.refundTarget) === "destination" ? t("order.handedRefundDestination") : t("order.handedRefundPool", { time: refundAfter })}</p> : null}
        {p.job?.state === "refund-only" ? <p className="ds-note">{t("order.refundOnly", { time: refundAfter })}</p> : null}
        {p.refundLine ? <p className="ds-note" data-testid="refund-line">{p.refundLine}</p> : null}
        {attention && p.record ? <Recovery record={p.record} onMonitor={p.onMonitor} onRefund={funded && canReturn(p.job?.state) ? p.onReturn : undefined} /> : null}
      </div>
    </Card>
  );
}
