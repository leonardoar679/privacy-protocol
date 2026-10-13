// An amount on screen (spec v2.0 §5): base units with the asset's display decimals and grouping, or USD from integer
// cents — never a raw base-unit or 18-decimal string (doc §92). Tabular figures, so a column of amounts aligns.
import { cx } from "../cx";
import { formatAmount, formatUsdCents, type Rounding } from "../format";

interface Common {
  approx?: boolean;
  size?: "large" | "medium" | "inherit";
  locale?: string;
  testId?: string;
}
export type AmountTextProps =
  | (Common & {
      value: bigint;
      decimals: number;
      displayDecimals: number;
      symbol?: string;
      minDecimals?: number;
      pad?: boolean;
      rounding?: Rounding;
      usdCents?: undefined;
    })
  | (Common & { usdCents: bigint; signed?: boolean; value?: undefined });

export function AmountText(p: AmountTextProps) {
  const text =
    p.usdCents !== undefined
      ? formatUsdCents(p.usdCents, { locale: p.locale, signed: p.signed })
      : `${formatAmount(p.value, { decimals: p.decimals, displayDecimals: p.displayDecimals, minDecimals: p.minDecimals, pad: p.pad, rounding: p.rounding, locale: p.locale })}${p.symbol ? ` ${p.symbol}` : ""}`;
  return (
    <span className={cx("ds-amount-text", p.size === "large" && "ds-amount-text-large", p.size === "medium" && "ds-amount-text-medium")} data-testid={p.testId}>
      {p.approx ? "≈ " : ""}
      {text}
    </span>
  );
}
