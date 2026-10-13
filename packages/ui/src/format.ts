// The numbers on screen (spec v2.0 §5 AmountText, AddressChip; doc §92): an amount in an asset's base units shown with
// the asset's display decimals and the locale's grouping — never a raw base-unit or 18-decimal string —, USD from integer
// cents, an address as `0x43…82C1`. Pure, bigint only: no float ever touches an amount.

export type Rounding = "down" | "up" | "nearest";

export interface AmountFormat {
  /** the asset's base-unit decimals (18 for ETH, 6 for USDC, 8 for BTC) */
  decimals: number;
  /** how many decimals the screen shows (the asset registry's displayDecimals) */
  displayDecimals: number;
  /** decimals kept even when they are zeros (2 for a fiat-like amount); trailing zeros beyond it are dropped */
  minDecimals?: number;
  /** a balance or a receive amount rounds down (never show more than there is), a fee rounds up; nearest otherwise */
  rounding?: Rounding;
  locale?: string;
}

const MINUS = "−";
const pow10 = (n: number): bigint => 10n ** BigInt(n);

const groupers = new Map<string, Intl.NumberFormat>();
function group(whole: bigint, locale: string): string {
  let f = groupers.get(locale);
  if (!f) groupers.set(locale, (f = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 })));
  return f.format(whole);
}
const decimalMarks = new Map<string, string>();
function decimalMark(locale: string): string {
  let d = decimalMarks.get(locale);
  if (d === undefined) {
    d = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
    decimalMarks.set(locale, d);
  }
  return d;
}

/** An amount of base units as the screen shows it: "3,251.7952", "2,470.90", "< 0.0001" for dust that rounds to zero. */
export function formatAmount(value: bigint, f: AmountFormat): string {
  const locale = f.locale ?? "en-US";
  const shown = Math.max(0, Math.min(f.displayDecimals, f.decimals));
  const keep = Math.min(f.minDecimals ?? 0, shown);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = pow10(f.decimals);
  let whole = abs / scale;
  const frac = abs % scale;
  const unit = pow10(f.decimals - shown);
  let digits = frac / unit;
  const rest = frac % unit;
  const rounding = f.rounding ?? "nearest";
  if ((rounding === "up" && rest > 0n) || (rounding === "nearest" && rest * 2n >= unit && rest > 0n)) digits += 1n;
  if (digits === pow10(shown)) {
    whole += 1n;
    digits = 0n;
  }
  if (abs > 0n && whole === 0n && digits === 0n) {
    // dust: say it is there rather than show a zero
    const smallest = shown === 0 ? "1" : `0${decimalMark(locale)}${"0".repeat(shown - 1)}1`;
    return `${negative ? MINUS : ""}< ${smallest}`;
  }
  let fraction = shown === 0 ? "" : digits.toString().padStart(shown, "0");
  while (fraction.length > keep && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  const body = group(whole, locale) + (fraction ? decimalMark(locale) + fraction : "");
  return negative && (whole > 0n || digits > 0n) ? MINUS + body : body;
}

/** USD from integer cents: "$10,000.00", "−$4.10" (a fee, a total, a residual — never a float). */
export function formatUsdCents(cents: bigint, o: { locale?: string; signed?: boolean } = {}): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const body = `$${group(abs / 100n, o.locale ?? "en-US")}${decimalMark(o.locale ?? "en-US")}${(abs % 100n).toString().padStart(2, "0")}`;
  if (negative) return MINUS + body;
  return o.signed && abs > 0n ? `+${body}` : body;
}

/** An address as a chip shows it (spec §5): the first four characters, an ellipsis, the last four — `0x43…82C1`, `bc1q…82c1`. */
export function shortAddress(address: string): string {
  const a = address.trim();
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}
