// Money on screen (spec §3.3, §3.6, §5): the protected balance, an asset row, the fee summary collapsed to one
// number, the quote card, the badges. Every amount arrives formatted by the caller; nothing here touches units.
import { useState, type ReactNode } from "react";
import { cx, nextId } from "../cx";
import { AssetMonogram, Icon } from "../icons";
import { Card } from "./Layout";

export function BalanceCard({ label, amountUsd, subline, status, onStatus, statusLabel, testId = "balance", amountTestId }: { label: string; amountUsd: string | null; subline?: ReactNode; status: "protected" | "unavailable" | "loading"; onStatus?: () => void; statusLabel?: string; testId?: string; amountTestId?: string }) {
  return (
    <Card elevation={1} padding="lg" testId={testId}>
      <div className="ds-balance">
        <span className="ds-balance-amount" aria-live="polite" data-testid={amountTestId ?? `${testId}-amount`} data-status={status}>{amountUsd ?? "—"}</span>
        <span className="ds-balance-label">{label}</span>
        {subline ? <span className="ds-balance-sub">{subline}</span> : null}
        {onStatus && statusLabel ? <ProtectionBadge level={status === "protected" ? "High" : "Reduced"} label={statusLabel} onPress={onStatus} /> : null}
      </div>
    </Card>
  );
}

export interface AssetView { symbol: string; name: string; decimals?: number; address?: string }

export function AssetRow({ asset, amount, usd, onPress, trailing, testId }: { asset: AssetView; amount: string; usd?: string | null; onPress?: () => void; trailing?: ReactNode; testId?: string }) {
  const body = (
    <>
      <AssetMonogram symbol={asset.symbol} />
      <span className="ds-asset-main"><span>{asset.symbol}</span><span className="ds-asset-name">{asset.name}</span></span>
      <span className="ds-asset-amount"><span className="ds-numeral">{amount}</span>{usd ? <span className="ds-asset-usd">{usd}</span> : null}</span>
      {trailing}
    </>
  );
  return onPress
    ? <button type="button" className="ds-asset-row" onClick={onPress} data-testid={testId}>{body}</button>
    : <div className="ds-asset-row" data-testid={testId}>{body}</div>;
}

export interface FeeLine { label: string; value: string; hint?: string }

/** Plan §22: one number by default — "You'll receive" and "Total fees" — the lines behind "View fee details". */
export function FeeSummary({ receive, pay, total, totalLabel = "Total fees", detailsLabel = "View fee details", lines, defaultOpen = false, testId = "fees" }: { receive: { label: string; value: string }; pay?: { label: string; value: string }; total: string; totalLabel?: string; detailsLabel?: string; lines: FeeLine[]; defaultOpen?: boolean; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [id] = useState(() => nextId("fees"));
  return (
    <section className="ds-fees" data-testid={testId}>
      <div className="ds-fees-receive"><span>{receive.label}</span><strong className="ds-numeral" data-testid={`${testId}-receive`}>{receive.value}</strong></div>
      {pay ? <div className="ds-fees-pay"><span>{pay.label}</span><span className="ds-numeral" data-testid={`${testId}-pay`}>{pay.value}</span></div> : null}
      <button type="button" className="ds-fees-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} data-testid={`${testId}-toggle`}>
        <Icon name="info" size={16} />
        <span>{totalLabel} <span className="ds-numeral" data-testid={`${testId}-total`}>{total}</span> · {detailsLabel}</span>
      </button>
      {open ? (
        <dl className="ds-fees-lines" id={id} data-testid={`${testId}-lines`}>
          {lines.map((l) => (
            <div key={l.label} style={{ display: "contents" }}>
              <dt>{l.label}</dt>
              <dd className="ds-numeral">{l.value}{l.hint ? <span className="ds-fees-hint"> · {l.hint}</span> : null}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

export type ProtectionLevel = "High" | "Reduced" | "Off";

export function ProtectionBadge({ level, label, onPress, testId = "protection-badge" }: { level: ProtectionLevel; label: string; onPress?: () => void; testId?: string }) {
  const cls = cx("ds-badge", `ds-badge-${level.toLowerCase()}`);
  const inner = <><Icon name={level === "Off" ? "shield" : "shield-check"} size={18} /><span>{label}</span></>;
  return onPress
    ? <button type="button" className={cls} onClick={onPress} data-testid={testId} data-level={level}>{inner}</button>
    : <span className={cls} data-testid={testId} data-level={level}>{inner}</span>;
}

export type StatusTone = "ok" | "pending" | "warn" | "danger" | "neutral";
export function StatusBadge({ tone, children, testId }: { tone: StatusTone; children: ReactNode; testId?: string }) {
  return <span className={cx("ds-status", `ds-status-${tone}`)} data-tone={tone} data-testid={testId}>{children}</span>;
}

export interface QuoteView { pay: string; receive: string; minimum: string; fees: string; time: string; protection: ProtectionLevel; route: string }

/** Plan §37: the quote card — You pay / You receive / Minimum / Fees / Time / Protection; "Compare routes" only under Advanced. */
export function QuoteCard({ quote, labels, onCompare, compareLabel = "Compare routes", testId = "quote" }: { quote: QuoteView; labels: { pay: string; receive: string; minimum: string; fees: string; time: string; protection: string }; onCompare?: () => void; compareLabel?: string; testId?: string }) {
  return (
    <Card elevation={1} testId={testId}>
      <div className="ds-quote">
        <div className="ds-quote-head"><span>{quote.route}</span><ProtectionBadge level={quote.protection} label={quote.protection === "High" ? `${labels.protection} ✓` : labels.protection} /></div>
        <dl className="ds-quote-rows">
          <dt>{labels.pay}</dt><dd className="ds-numeral">{quote.pay}</dd>
          <div className="ds-quote-receive" style={{ display: "contents" }}><dt>{labels.receive}</dt><dd className="ds-numeral" data-testid={`${testId}-receive`}>{quote.receive}</dd></div>
          <dt>{labels.minimum}</dt><dd className="ds-numeral" data-testid={`${testId}-minimum`}>{quote.minimum}</dd>
          <dt>{labels.fees}</dt><dd className="ds-numeral">{quote.fees}</dd>
          <dt>{labels.time}</dt><dd>{quote.time}</dd>
        </dl>
        {onCompare ? <button type="button" className="ds-collapsible-toggle" onClick={onCompare} data-testid={`${testId}-compare`}><span>{compareLabel}</span><Icon name="chevron-right" size={16} /></button> : null}
      </div>
    </Card>
  );
}
