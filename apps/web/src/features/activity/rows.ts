// The Activity's rows (spec §3.10, §14; plan §27–§28): one row per money movement — the operation records merged
// with the V2 activity lines by id (a swap's record and its line share `swap:<orderId>`; a protect's or a send's
// line is matched through the record's transaction hashes), never two rows for one movement; a protected execution
// is one row unless Advanced; the status word from the record's state where there is one, else the line's own
// label; the groups by day in the user's locale. Pure.
import { exposure } from "@privacy-wallet/protocol/wallet/campaign";
import { levelOf } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { formatUsd } from "@privacy-wallet/protocol/wallet/valuation";
import { formatUnits } from "viem";
import type { IconName, StatusTone } from "@privacy-wallet/ui";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import { planWords } from "@privacy-wallet/sdk/tiers";
import { activityId, activityOf, activityStatusLabel, isFinished } from "@privacy-wallet/sdk/wallet/activity";
import { campaignById } from "@privacy-wallet/sdk/wallet/campaigns";
import type { ActivityRecord, JournalData, StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { isDraft, isTerminal, type OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { recordWords } from "../operations/recovery";

export type T = (key: MessageKey, vars?: Vars) => string;
export type RowKind = ActivityRecord["kind"] | OperationRecord["kind"];

export interface ActivityRow {
  id: string;
  kind: RowKind;
  at: number;
  title: string;
  amount: string;
  status: string;
  tone: StatusTone;
  ref: string;
  note?: string;
  finished: boolean;
  icon: IconName;
  activity?: ActivityRecord;
  record?: OperationRecord;
  swap?: StoredSwap;
  /** V4 (plan §100): a protected execution's summary line */
  campaignLine?: string;
  /** V6 (spec v2.0 §7.8): a protected execution's target asset and the USD value it was confirmed at */
  target?: string;
  quotedUsd?: number;
}

export const KIND_ICON: Record<RowKind, IconName> = { shield: "shield", protect: "shield", transfer: "send", send: "send", withdraw: "upload", swap: "swap", "cross-chain": "swap", refund: "recovery", housekeeping: "refresh", campaign: "shield", "classic-deposit": "lock", "classic-withdraw": "unlock", receive: "receive" };
const KIND_KEY: Record<RowKind, MessageKey> = { shield: "activity.kind.shield", protect: "activity.kind.protect", transfer: "activity.kind.transfer", send: "activity.kind.send", withdraw: "activity.kind.withdraw", swap: "activity.kind.swap", "cross-chain": "activity.kind.crossChain", refund: "activity.kind.refund", housekeeping: "activity.kind.housekeeping", campaign: "activity.kind.campaign", "classic-deposit": "activity.kind.classicDeposit", "classic-withdraw": "activity.kind.classicWithdraw", receive: "activity.kind.receive" } as Record<RowKind, MessageKey>;

export const amountOf = (amount: string, decimals: number, asset: string): string => { try { return `${formatUnits(BigInt(amount), decimals)} ${asset}`; } catch { return `${amount} ${asset}`; } };

function toneOfRecord(r: OperationRecord): StatusTone {
  if (r.state === "COMPLETED" || r.state === "REFUNDED") return "ok";
  if (r.state === "CANCELLED") return "neutral";
  if (r.state === "RECOVERY_REQUIRED" || r.delayed) return "warn";
  if (r.state === "FAILED" || (r.state === "READY_TO_REVIEW" && r.reason?.code === "quote_expired")) return "danger"; // V7: an expired quote before the funding
  return "pending";
}
function toneOfLabel(label: string): StatusTone {
  if (label === "Completed" || label === "Refunded") return "ok";
  if (label === "Needs attention" || label.startsWith("Paused") || label.startsWith("Route changed")) return "warn";
  if (label === "Failed") return "danger";
  if (label === "Abandoned" || label === "Not started" || label === "Returned") return "neutral";
  return "pending";
}

/** V4 (plan §100): execution, protection, privacy, duration of a protected execution. */
export function campaignLine(ref: string, decimals: number, asset: string, now = Date.now()): string | null {
  const c = campaignById(ref);
  if (!c) return null;
  const e = exposure(c);
  const usd = c.value && typeof c.value === "object" && "usd" in (c.value as object) ? (c.value as { usd: number }).usd : null;
  const capUsd = usd !== null && e.total > 0n ? formatUsd((usd * Number(e.cap)) / Number(e.total), { compact: true }) : `${formatUnits(e.cap, decimals)} ${asset}`;
  const snap = (c.riskSnapshot ?? {}) as { privacyScore?: number; quote?: { plan?: { mode: string; parts: number; intervalBlocks: number; expectedSeconds: number } } };
  const finished = c.state === "completed" || c.state === "cancelled";
  const end = finished ? c.history[c.history.length - 1]?.at ?? now : now;
  const ms = Math.max(0, end - c.createdAt);
  const dur = ms >= 3600_000 ? `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m` : `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `Execution: ${planWords(snap.quote?.plan as never)} · Protection: ${capUsd} max exposure · Privacy: ${typeof snap.privacyScore === "number" ? levelOf(snap.privacyScore) : "—"} · Duration: ${dur}`;
}

/** A protected execution's row facts: its summary line, the asset it buys, the USD value confirmed at its Review. */
function campaignFacts(line: ActivityRecord, now: number): Pick<ActivityRow, "campaignLine" | "target" | "quotedUsd"> {
  const c = campaignById(line.ref);
  if (!c) return {};
  const l = campaignLine(line.ref, line.decimals, line.asset, now);
  const usd = (c.value as { usd?: unknown } | undefined)?.usd;
  return { ...(l ? { campaignLine: l } : {}), target: c.request.to.symbol, ...(typeof usd === "number" && Number.isFinite(usd) ? { quotedUsd: usd } : {}) };
}

/** The record that belongs to an activity line: the same id (a swap), the line's id in the refs, or the line's reference among the hashes. */
export function recordFor(line: ActivityRecord, records: OperationRecord[]): OperationRecord | undefined {
  const ref = line.ref.toLowerCase();
  return records.find((r) => r.id === line.id || r.refs.activityId === line.id || r.refs.txHashes.some((h) => h.toLowerCase() === ref) || (r.refs.orderId && r.refs.orderId.toLowerCase() === ref));
}

export function buildRows(j: JournalData | null, records: OperationRecord[], advanced: boolean, t: T, now = Date.now()): ActivityRow[] {
  if (!j) return [];
  const stepIds = new Set(j.swaps.filter((s) => s.campaign).map((s) => activityId("swap", s.orderId))); // V3 (High-Value Protection spec §15): a protected execution is one row
  const swaps = new Map<string, StoredSwap>(j.swaps.map((s) => [activityId("swap", s.orderId), s]));
  const used = new Set<string>();
  const rows: ActivityRow[] = [];
  for (const line of activityOf(j)) {
    if (!advanced && stepIds.has(line.id)) continue;
    const record = recordFor(line, records);
    if (record) used.add(record.id);
    const swap = line.kind === "swap" ? swaps.get(line.id) : undefined;
    const label = record ? recordWords(record, t) : (swap?.track?.label ?? activityStatusLabel(line));
    rows.push({
      id: line.id, kind: line.kind, at: line.at, title: t(KIND_KEY[line.kind]), amount: amountOf(line.amount, line.decimals, line.asset), status: label, tone: record ? toneOfRecord(record) : toneOfLabel(label), ref: line.ref,
      ...(line.note ? { note: line.note.replace(/ · (Preparing|Waiting for source|Executing|Waiting for destination|Partial|Refunding|Refunded|Completed|Not started|Needs attention)$/, "") } : {}),
      finished: record ? isTerminal(record.state) : isFinished(line), icon: KIND_ICON[line.kind], activity: line, ...(record ? { record } : {}), ...(swap ? { swap } : {}),
      ...(line.kind === "campaign" ? campaignFacts(line, now) : {}),
    });
  }
  // records without a line of their own (a protect or a send that failed before it was recorded, an order not yet in the list);
  // V6: never a draft — nothing was signed (a declined prompt goes back to its review)
  for (const r of records) {
    if (used.has(r.id) || r.kind === "classic-deposit" || r.kind === "classic-withdraw" || isDraft(r.state)) continue;
    if (!advanced && r.refs.campaignId) continue;
    rows.push({ id: r.id, kind: r.kind, at: r.createdAt, title: t(KIND_KEY[r.kind]), amount: amountOf(r.amounts.input, r.amounts.decimals, r.amounts.asset), status: recordWords(r, t), tone: toneOfRecord(r), ref: r.refs.orderId ?? r.refs.txHashes[0] ?? r.id, finished: isTerminal(r.state), icon: KIND_ICON[r.kind], record: r });
  }
  return rows.sort((a, b) => b.at - a.at);
}

export interface DayGroup { key: string; label: string; rows: ActivityRow[] }

/** Today, Yesterday, then dates in the user's locale (spec §3.10). */
export function groupByDay(rows: ActivityRow[], t: T, now = Date.now(), locale?: string): DayGroup[] {
  const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const today = dayKey(now), yesterday = dayKey(now - 86_400_000);
  const fmt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" });
  const groups: DayGroup[] = [];
  for (const r of rows) {
    const key = dayKey(r.at);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) { g = { key, label: key === today ? t("activity.today") : key === yesterday ? t("activity.yesterday") : fmt.format(new Date(r.at)), rows: [] }; groups.push(g); }
    g.rows.push(r);
  }
  return groups;
}
