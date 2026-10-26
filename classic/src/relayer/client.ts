// The relayer client (spec v3.0 §7.5; the compatibility matrix §4): the status, the withdrawal and the job of a relayer
// over an injected transport (src/net/relayer.ts in the app; a scripted one in the tests), every answer parsed by its
// schema (R-1, R-4), the request checked before it leaves (R-3), the job followed with a bounded poll — every 3 s, a
// transient error tried again up to five times, given up after 15 minutes as the original did. Nothing here knows a note.
import { isTerminal, parseJob, parseStatus, WithdrawRequestSchema, type RelayerJob, type RelayerStatus, type WithdrawRequest } from "./schema.ts";

export interface RelayerAnswer {
  status: number;
  body: unknown;
}

export interface RelayerTransport {
  getJson(url: string): Promise<RelayerAnswer>;
  postJson(url: string, body: unknown): Promise<RelayerAnswer>;
}

export class RelayerUnavailable extends Error {}
/** The relayer answered 400 with its reason (an input it refuses, an unknown job). */
export class RelayerRefusal extends Error {}
export class JobTimeout extends Error {
  readonly last: RelayerJob | null;
  constructor(message: string, last: RelayerJob | null) {
    super(message);
    this.last = last;
  }
}

export const normalizeBase = (url: string): string => url.replace(/\/+$/, "");

/** GET /v1/status (the original's path; `/status` is the same handler), parsed. */
export async function statusOf(t: RelayerTransport, baseUrl: string): Promise<RelayerStatus> {
  const r = await t.getJson(`${normalizeBase(baseUrl)}/v1/status`);
  if (r.status !== 200) throw new RelayerUnavailable(`the relayer answered HTTP ${r.status} to the status request`);
  return parseStatus(r.body);
}

/** POST /v1/tornadoWithdraw: the request checked by the schema first; the job id back, or the relayer's refusal. */
export async function submitWithdrawal(t: RelayerTransport, baseUrl: string, request: WithdrawRequest): Promise<{ id: string }> {
  const body = WithdrawRequestSchema.parse(request);
  const r = await t.postJson(`${normalizeBase(baseUrl)}/v1/tornadoWithdraw`, body);
  const answer = (r.body ?? {}) as { id?: unknown; error?: unknown };
  if (r.status === 200 && typeof answer.id === "string" && answer.id) return { id: answer.id };
  if (r.status === 400) throw new RelayerRefusal(typeof answer.error === "string" ? answer.error : "the relayer refused the withdrawal");
  throw new RelayerUnavailable(`the relayer answered HTTP ${r.status} to the withdrawal`);
}

/** GET /v1/jobs/:id, parsed; 400 is an unknown job. */
export async function jobOf(t: RelayerTransport, baseUrl: string, id: string): Promise<RelayerJob> {
  const r = await t.getJson(`${normalizeBase(baseUrl)}/v1/jobs/${encodeURIComponent(id)}`);
  if (r.status === 400) throw new RelayerRefusal("the relayer knows no such job");
  if (r.status !== 200) throw new RelayerUnavailable(`the relayer answered HTTP ${r.status} to the job request`);
  return parseJob(r.body);
}

export interface FollowOptions {
  intervalMs?: number;
  maxMs?: number;
  maxErrors?: number;
  onUpdate?: (job: RelayerJob) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const FOLLOW_DEFAULTS = Object.freeze({ intervalMs: 3_000, maxMs: 15 * 60_000, maxErrors: 5 });

/** Polls the job until CONFIRMED or FAILED (returned either way); a refusal ends it; errors beyond `maxErrors` in a row or the deadline throw. */
export async function followJob(t: RelayerTransport, baseUrl: string, id: string, o: FollowOptions = {}): Promise<RelayerJob> {
  const intervalMs = o.intervalMs ?? FOLLOW_DEFAULTS.intervalMs;
  const maxMs = o.maxMs ?? FOLLOW_DEFAULTS.maxMs;
  const maxErrors = o.maxErrors ?? FOLLOW_DEFAULTS.maxErrors;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const started = now();
  let last: RelayerJob | null = null;
  let lastState: string | null = null;
  let errors = 0;
  for (;;) {
    try {
      const job = await jobOf(t, baseUrl, id);
      errors = 0;
      last = job;
      if (job.status !== lastState) {
        lastState = job.status;
        o.onUpdate?.(job);
      }
      if (isTerminal(job.status)) return job;
    } catch (e) {
      if (e instanceof RelayerRefusal) throw e;
      if (++errors >= maxErrors) throw new RelayerUnavailable(`the relayer stopped answering about the job (${e instanceof Error ? e.message : "error"})`);
    }
    if (now() - started >= maxMs) throw new JobTimeout("the relayer did not finish the withdrawal in time", last);
    await sleep(intervalMs);
  }
}
