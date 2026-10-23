// Numbers, dates and times in the wallet's language (spec v2.0 §18; doc §78; V6 Stage 16): Intl over the locale the
// catalog runs with — not the device's own when the reader chose another language under More → Language.
import { formatUsd } from "@privacy-wallet/protocol/wallet/valuation";
import { getLocale } from "./messages";

const TAGS: Record<string, string> = { en: "en-US", ko: "ko-KR", zh: "zh-CN", ja: "ja-JP", pseudo: "en-US" };

/** The BCP 47 tag Intl writes a catalog locale's numbers and dates with. */
export const intlLocale = (locale: string = getLocale()): string => TAGS[locale] ?? TAGS[locale.split("-")[0]] ?? locale;
/**
 * A compact dollar figure (a protected execution's "≈ $25K"; audit round 2, r55): the protocol's own form for an English
 * reader, Intl's compact form in another language ("$2.5만" in Korean, where "$25K" had read in English).
 */
export const formatUsdCompact = (usd: number, locale: string = getLocale()): string =>
  locale === "en" || locale === "pseudo" || !Number.isFinite(usd)
    ? formatUsd(usd, { compact: true })
    : new Intl.NumberFormat(intlLocale(locale), {
        style: "currency",
        currency: "USD",
        currencyDisplay: "narrowSymbol",
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(usd);
/** A time of day: "3:04:05 PM", "오후 3:04:05". */
export const formatTime = (ms: number): string => new Date(ms).toLocaleTimeString(intlLocale());
/** A date and a time: "10/14/2026, 3:04:05 PM", "2026. 10. 14. 오후 3:04:05". */
export const formatDateTime = (ms: number): string => new Date(ms).toLocaleString(intlLocale());
/** A date: "10/14/2026", "2026. 10. 14.". */
export const formatDate = (ms: number): string => new Date(ms).toLocaleDateString(intlLocale());
/** A count: "1,234". */
export const formatCount = (n: number | bigint): string => new Intl.NumberFormat(intlLocale()).format(n);
