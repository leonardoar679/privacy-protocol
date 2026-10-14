// The typed logger (doc §67; spec v2.0 §15): one JSON line per event whose keys are a subset of LOG_KEYS — the type
// accepts nothing else, unknown keys are dropped at run time, and a value that does not have its field's shape (an
// operation id, a provider's name, a state, an error class, a network) is written as "redacted". An address, a
// transaction hash, an amount, a Bitcoin or a Solana string therefore never reaches a log line, whoever calls it.

export const LOG_KEYS = ["at", "level", "event", "operationId", "provider", "state", "errorClass", "network"] as const;
export type LogKey = (typeof LOG_KEYS)[number];
export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  /** what happened: dotted lower-case words ("operation.created", "fee.deviation", "http.error") */
  event: string;
  level?: LogLevel;
  /** an API operation id (`op_` and 26 base32 characters) — never the on-chain order id */
  operationId?: string;
  provider?: string;
  /** an operation state, a job state or an HTTP status */
  state?: string;
  /** a catalog code ("minimum_moved", "rate_limited") */
  errorClass?: string;
  network?: string;
}

// Words carry no digits (a bech32 or a hex string always does); the only digits allowed are an operation id's base32 and
// an HTTP status. Each shape is length-capped as well.
const WORD = /^[a-z]+(-[a-z]+)*$/;
const SHAPES: Record<Exclude<keyof LogFields, "level">, RegExp> = {
  event: /^[a-z]+(-[a-z]+)*(\.[a-z]+(-[a-z]+)*){0,4}$/,
  operationId: /^op_[a-z2-7]{26}$/,
  provider: WORD,
  state: /^([A-Z]+(_[A-Z]+)*|[a-z]+(-[a-z]+)*|[1-5][0-9]{2})$/,
  errorClass: /^[a-z]+(_[a-z]+)*$/,
  network: WORD,
};
const MAX_LENGTH = 64;
const LEVELS: readonly LogLevel[] = ["info", "warn", "error"];

/** The record a set of fields becomes: the known keys only, each value checked against its shape. */
export function sanitize(f: LogFields, at: Date): Partial<Record<LogKey, string>> {
  const out: Partial<Record<LogKey, string>> = { at: at.toISOString(), level: LEVELS.includes(f.level as LogLevel) ? (f.level as LogLevel) : "info" };
  for (const key of Object.keys(SHAPES) as (keyof typeof SHAPES)[]) {
    const v = (f as unknown as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = typeof v === "string" && v.length <= MAX_LENGTH && SHAPES[key].test(v) ? v : "redacted";
  }
  return out;
}

/** The line a set of fields becomes. */
export const logLine = (f: LogFields, at: Date): string => JSON.stringify(sanitize(f, at));

export type LogSink = (line: string) => void;
export interface Logger {
  log(f: LogFields): void;
  info(f: Omit<LogFields, "level">): void;
  warn(f: Omit<LogFields, "level">): void;
  error(f: Omit<LogFields, "level">): void;
}

/** A logger writing to `sink` (stdout by default); `now` for tests. */
export function createLogger(sink: LogSink = (line) => void process.stdout.write(`${line}\n`), now: () => Date = () => new Date()): Logger {
  const log = (f: LogFields): void => sink(logLine(f, now()));
  return { log, info: (f) => log({ ...f, level: "info" }), warn: (f) => log({ ...f, level: "warn" }), error: (f) => log({ ...f, level: "error" }) };
}
