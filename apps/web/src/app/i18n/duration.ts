// Durations in the reader's words (audit round 2, r55): the units come from the catalog; "6 h" had stayed English inside a
// Korean sentence.
import type { MessageKey } from "./en";
import type { Vars } from "./messages";

type T = (key: MessageKey, vars?: Vars) => string;

/** Hours from an hour, minutes from a minute, else seconds (the privacy check's delays). */
export const hoursText = (t: T, seconds: number): string =>
  seconds >= 3600
    ? t("unit.hoursShort", { n: Math.round(seconds / 3600) })
    : seconds >= 60
      ? t("unit.minutesShort", { n: Math.round(seconds / 60) })
      : t("unit.secondsShort", { n: seconds });

/** Days from two days, hours from an hour, else minutes (a protected execution's duration and cadence). */
export const durationText = (t: T, seconds: number): string =>
  seconds >= 2 * 86400
    ? t("unit.days", { n: Math.round(seconds / 86400) })
    : seconds >= 3600
      ? t("unit.hoursShort", { n: Math.round(seconds / 3600) })
      : t("unit.minutesShort", { n: Math.round(seconds / 60) });
