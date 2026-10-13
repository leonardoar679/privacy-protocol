// The fee lines (spec v2.0 §3, §5): what the user receives first and largest, then every fee on its own line — the
// privacy fee, the relayer / network fee, the swap / provider fee, "Market rate & impact" —, then the total. The values
// arrive formatted (AmountText, formatUsdCents); the lines add up because the screen computes them from one quote.
import type { ReactNode } from "react";
import { cx } from "../cx";

export interface FeeLineItem {
  label: string;
  value: ReactNode;
  /** a short qualifier under the label ("1 % of the amount", "estimated") */
  hint?: string;
  testId?: string;
}

export function FeeLines({
  receive,
  lines,
  total,
  testId = "fee-lines",
}: {
  receive?: FeeLineItem;
  lines: FeeLineItem[];
  total?: FeeLineItem;
  testId?: string;
}) {
  const row = (l: FeeLineItem, kind: "receive" | "line" | "total") => (
    <div key={`${kind}-${l.label}`} className={cx("ds-fee-row", `ds-fee-row-${kind}`)} data-testid={l.testId}>
      <dt>
        <span>{l.label}</span>
        {l.hint ? <span className="ds-fee-hint">{l.hint}</span> : null}
      </dt>
      <dd>{l.value}</dd>
    </div>
  );
  return (
    <dl className="ds-fee-lines" data-testid={testId}>
      {receive ? row(receive, "receive") : null}
      {lines.map((l) => row(l, "line"))}
      {total ? row(total, "total") : null}
    </dl>
  );
}
