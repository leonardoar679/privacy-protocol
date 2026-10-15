// Numeric settings read strictly (a V6 follow-up of 2026-10-15). The services read their numbers with a bare `Number()`,
// and `Number("1k")` is NaN: a NaN poll interval ticks every millisecond (setInterval's floor), a NaN cap on open jobs
// caps nothing, a NaN budget or watch allows nothing, all without a word. A setting that is not a whole number in its
// range now stops the service at start, naming the setting; unset or empty, it takes its default.

type Env = Readonly<Record<string, string | undefined>>;

/** A whole-number setting in [min, max]; `fallback` when unset or empty. */
export function intSetting(env: Env, name: string, fallback: number, range: { min: number; max: number }): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = /^-?\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < range.min || n > range.max)
    throw new Error(`${name} must be a whole number from ${range.min} to ${range.max}, not ${JSON.stringify(env[name])}`);
  return n;
}

/** An amount in base units (wei, gas); `fallback` when unset or empty. */
export function bigintSetting(env: Env, name: string, fallback: bigint): bigint {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d{1,78}$/.test(raw)) throw new Error(`${name} must be a whole number of base units, not ${JSON.stringify(env[name])}`);
  return BigInt(raw);
}
