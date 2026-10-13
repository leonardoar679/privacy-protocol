// Activity's and the detail's view-models from the engine (spec v2.0 §7.8): the rows of ./rows.ts (one per movement,
// a protected execution one row unless Advanced) as titles "ETH → BTC" / "Private Send" / "Protected USDC", amounts in
// the asset's display decimals, a USD value only when the order recorded one at its quote (never re-priced at today's
// rate), one status word; the detail's facts, its execution timeline from the record's state, and Advanced's
// identifiers. Pure: the routes read the stores and pass them in.
import type { IconName } from "@privacy-wallet/ui";
import type { OperationRecord, OperationState } from "@privacy-wallet/sdk/wallet/operationRecord";
import type { MessageKey } from "../../app/i18n/en";
import type { Vars } from "../../app/i18n/messages";
import { activityStatus, amountFrom, statusOf, targetOf, titleOf } from "../amounts";
import type { Amount, Status } from "../viewKit";
import { stateWords } from "../operations/recovery";
import type { ActivityRow, DayGroup } from "./rows";
import type { ActivityGroupView, ActivityModel, ActivityRowView, DetailModel, DetailStep } from "./View";

type T = (key: MessageKey, vars?: Vars) => string;

const ICON: Record<string, IconName> = {
  shield: "shield-plus",
  protect: "shield-plus",
  transfer: "send",
  send: "send",
  withdraw: "send",
  swap: "swap",
  "cross-chain": "swap",
  campaign: "swap",
  refund: "recovery",
  housekeeping: "refresh",
  "classic-deposit": "recovery",
  "classic-withdraw": "recovery",
};

/** The amount a row shows: the record's input, else the activity line's. */
function rowAmount(r: ActivityRow): Amount {
  if (r.record) return amountFrom(r.record.amounts.input, r.record.amounts.asset, r.record.amounts.decimals);
  if (r.activity) return amountFrom(r.activity.amount, r.activity.asset, r.activity.decimals);
  return amountFrom("0", "", 0);
}

/** The USD value an order recorded at its quote, in cents (a swap's or a protected execution's), else null. */
function quotedCents(r: ActivityRow): bigint | null {
  const usd = (r.swap?.value as { usd?: unknown } | undefined)?.usd ?? r.quotedUsd;
  return typeof usd === "number" && Number.isFinite(usd) ? BigInt(Math.round(usd * 100)) : null;
}

const rowStatus = (r: ActivityRow): Status => (r.record ? statusOf(r.record) : r.activity ? activityStatus(r.kind, r.activity.status) : "executing");

function rowTitle(r: ActivityRow, t: T): string {
  const asset = r.record?.amounts.asset ?? r.activity?.asset ?? "";
  const req = r.swap?.request as { to?: { symbol?: string } } | undefined;
  return titleOf(r.kind, asset, req?.to?.symbol ?? r.target ?? targetOf(r.activity?.note, r.record?.amounts.outputAsset), t);
}

export function rowView(r: ActivityRow, t: T): ActivityRowView {
  return { id: r.id, icon: ICON[r.kind] ?? "activity", title: rowTitle(r, t), amount: rowAmount(r), usdCents: quotedCents(r), status: rowStatus(r) };
}

export function activityModel(groups: DayGroup[], t: T, o: { refreshing?: string | null; advanced?: string[] | null; simple: boolean }): ActivityModel {
  const views: ActivityGroupView[] = groups
    .map((g) => ({ key: g.key, label: g.label, rows: g.rows.filter((r) => !(o.simple && r.kind === "housekeeping")).map((r) => rowView(r, t)) }))
    .filter((g) => g.rows.length > 0);
  return { groups: views, refreshing: o.refreshing ?? null, advanced: o.advanced ?? null };
}

/** The execution timeline (spec §7.8) of a record's state: what is done, what runs now, what waits. */
export function stepsOf(r: OperationRecord, t: T): DetailStep[] {
  const swap = r.kind === "swap" || r.kind === "cross-chain";
  const ORDER: OperationState[] = [
    "DRAFT",
    "QUOTING",
    "QUOTE_READY",
    "REVIEW",
    "AWAITING_SIGNATURE",
    "SIGNED",
    "SUBMITTED",
    "RELAYER_EXECUTING",
    "NETWORK_CONFIRMING",
    "SETTLEMENT_VERIFYING",
    "COMPLETED",
  ];
  const reached = (s: OperationState) => r.history.some((h) => ORDER.indexOf(h.state) >= ORDER.indexOf(s)) || ORDER.indexOf(r.state) >= ORDER.indexOf(s);
  const failed = ["SUBMISSION_FAILED", "PROVIDER_FAILED", "RECOVERY_REQUIRED", "NETWORK_DELAYED"].includes(r.state);
  const labels: [MessageKey, OperationState][] = swap
    ? [
        ["activity.step.quote", "QUOTE_READY"],
        ["activity.step.authorized", "SIGNED"],
        ["activity.step.submitted", "SUBMITTED"],
        ["activity.step.settlement", "SETTLEMENT_VERIFYING"],
        ["activity.step.complete", "COMPLETED"],
      ]
    : [
        ["activity.step.prepared", "REVIEW"],
        ["activity.step.authorized", "SIGNED"],
        ["activity.step.submitted", "SUBMITTED"],
        ["activity.step.confirming", "NETWORK_CONFIRMING"],
        ["activity.step.complete", "COMPLETED"],
      ];
  let activeGiven = false;
  return labels.map(([key, s]) => {
    const done = r.state === "COMPLETED" || reached(s);
    let state: DetailStep["state"] = done ? "done" : "waiting";
    if (!done && !activeGiven && r.state !== "CANCELLED" && r.state !== "REFUNDED") {
      state = failed ? "failed" : "active";
      activeGiven = true;
    }
    return { label: t(key), state };
  });
}

export function detailModel(r: ActivityRow, t: T): DetailModel {
  const rec = r.record;
  const amount = rowAmount(r);
  const receive = rec?.amounts.outputAsset
    ? rec.amounts.delivered
      ? { amount: amountFrom(rec.amounts.delivered, rec.amounts.outputAsset, rec.amounts.outputDecimals ?? 18), approx: false }
      : rec.amounts.expectedOutput
        ? { amount: amountFrom(rec.amounts.expectedOutput, rec.amounts.outputAsset, rec.amounts.outputDecimals ?? 18), approx: true }
        : null
    : null;
  const dest = rec?.destination;
  const destination = dest
    ? {
        label:
          dest.kind === "privacy-address" && /protected|self/i.test(dest.display)
            ? t("activity.protectedBalance")
            : dest.display.length > 14
              ? `${dest.display.slice(0, 4)}…${dest.display.slice(-4)}`
              : dest.display,
        verified: dest.kind === "fresh" || dest.kind === "book" || dest.kind === "privacy-address",
      }
    : null;
  const tx = rec?.refs.txHashes.at(-1) ?? r.activity?.ref;
  const advanced: DetailModel["advanced"] = [
    { label: t("activity.operationId"), value: rec?.id ?? r.id },
    ...(rec?.refs.provider || r.swap?.provider ? [{ label: t("activity.provider"), value: rec?.refs.provider ?? r.swap?.provider ?? "" }] : []),
    { label: t("activity.executionId"), value: rec?.refs.orderId ?? r.swap?.orderId ?? "—" },
    { label: t("activity.quoteId"), value: rec?.refs.quoteId ?? "—" },
    { label: t("activity.providerExecutionId"), value: rec?.refs.executionRef ?? r.swap?.executionRef ?? "—" },
    { label: t("activity.relayerTransaction"), value: rec?.refs.executionTx ?? r.swap?.executionTx ?? "—" },
    { label: t("activity.transaction"), value: tx ?? "—" },
    { label: t("activity.nullifierStatus"), value: rec?.refs.leafIndex !== undefined ? t("activity.leafAt", { leaf: rec.refs.leafIndex }) : "—" },
    { label: t("activity.confirmationState"), value: rec ? stateWords(rec.state, t) : (r.swap?.track?.label ?? r.status) },
    { label: t("activity.recoveryState"), value: rec?.recovery?.state ?? "—" },
    ...(rec
      ? [
          {
            label: t("activity.history"),
            value: rec.history.map((h) => `${new Date(h.at).toLocaleTimeString()} ${h.state}${h.note ? ` (${h.note})` : ""}`).join(" · "),
          },
        ]
      : []),
  ];
  return {
    id: r.id,
    title: rowTitle(r, t),
    amount,
    usdCents: quotedCents(r),
    status: rowStatus(r),
    pay: amount,
    receive,
    destination,
    fees: (rec?.fees ?? []).map((f) => ({ label: f.label, value: { text: f.value } })),
    steps: rec ? stepsOf(rec, t) : [],
    advanced,
    canRemove: r.finished && !!r.activity,
  };
}
