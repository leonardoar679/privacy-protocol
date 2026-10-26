// "Time passed" as the original showed it: a rounded distance ("2 days", "5 hours", "12 minutes"), in the catalog's words.
export type Passed = { unit: "minutes" | "hours" | "days"; n: number };

/** The distance from `fromSeconds` to `nowSeconds`, in the largest unit that keeps a whole number ≥ 1. */
export function timePassed(fromSeconds: number, nowSeconds: number): Passed {
  const s = Math.max(0, nowSeconds - fromSeconds);
  if (s >= 86_400) return { unit: "days", n: Math.floor(s / 86_400) };
  if (s >= 3_600) return { unit: "hours", n: Math.floor(s / 3_600) };
  return { unit: "minutes", n: Math.floor(s / 60) };
}

/** The original's two warnings before a withdrawal: under 24 hours since the deposit, or under 5 deposits after it. */
export const MIN_HOURS = 24;
export const MIN_SUBSEQUENT_DEPOSITS = 5;
export const notEnoughTime = (fromSeconds: number, nowSeconds: number): boolean => nowSeconds - fromSeconds < MIN_HOURS * 3_600;
export const notEnoughDeposits = (depositsSince: number): boolean => depositsSince < MIN_SUBSEQUENT_DEPOSITS;
