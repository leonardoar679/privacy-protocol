// Operation notifications in the app (spec v2.0 §12.5; doc §76; V6 Stage 15): the engine decides which change deserves
// one (notificationFor, packages/sdk/src/operations/notify.ts); this module gives it the catalog's words and delivers it
// through the engine's notifier — the in-app list, shown as a toast while the app is open, and the browser's
// Notification API while the tab is hidden, generic unless the user allowed amounts. No amount by default.
import { useEffect, useRef } from "react";
import { useToast, type ToastKind } from "@privacy-wallet/ui";
import { watchOperationNotifications, type NotifiedAmount, type OperationNotification } from "@privacy-wallet/sdk/operations/notify";
import {
  notifications,
  notify,
  setSystemNotificationBody,
  setSystemNotificationWords,
  type WalletNotification,
} from "@privacy-wallet/sdk/wallet/notifications";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { t, type MessageKey } from "./i18n/messages";
import { amountFrom, displayAmount } from "../features/amounts";
import { useNotifications } from "../hooks/core";
import type { AlertKind } from "@privacy-wallet/protocol/wallet/campaign";
import { PAUSE_WORDS } from "../features/swap/protected/alertWords";
import { hasCode, reasonKey } from "@privacy-wallet/sdk/operations/errors/codes";

const TONE: Record<OperationNotification["kind"], "info" | "success" | "warn"> = {
  "quote-ready": "info",
  confirmed: "info",
  "cross-chain-executing": "info",
  completed: "success",
  "recovery-required": "warn",
};

const amountText = (a: NotifiedAmount): string => `${displayAmount(amountFrom(a.value, a.asset, a.decimals))} ${a.asset}`;

/** A finished swap that is not the whole delivery has its own words (the ninth review round, C-03/C-07), never "Your transaction is complete". */
const OUTCOME_WORDS: Record<NonNullable<OperationNotification["outcome"]>, string> = {
  partial: "partial",
  "partial-unreturned": "partialUnreturned", // the tenth review round, A10-2: "the rest came back" had been said with nothing back
  "other-token": "otherToken",
  "refunded-at-destination": "notDelivered",
};
const wordsOf = (n: OperationNotification): string => (n.kind === "completed" && n.outcome ? OUTCOME_WORDS[n.outcome] : n.kind);
const toneOf = (n: OperationNotification): "info" | "success" | "warn" =>
  n.kind === "completed" && n.outcome && n.outcome !== "partial" ? "warn" : TONE[n.kind];

/** The words of a notification: its kind's title and body, the amounts in front only when the user allowed them. */
export function notificationWords(n: OperationNotification): { title: string; body: string } {
  const title = t(`notification.${wordsOf(n)}.title` as MessageKey);
  const body = t(`notification.${wordsOf(n)}.body` as MessageKey);
  if (!n.amounts) return { title, body };
  const amounts = n.amounts.output ? `${amountText(n.amounts.input)} → ${amountText(n.amounts.output)}` : amountText(n.amounts.input);
  return { title, body: t("notification.withAmounts", { amounts, body }) };
}

/**
 * A notification in the reader's language (audit round 2, r57): a protected execution's alert by its catalog words — a pause by the
 * words of its kind, the runner's own reason under Advanced only (the eleventh review round, 2026-11-04, E11-10: that English had been every
 * reader's, a Korean one's too) —, any other as given. A finished one by the key the runner gives it, its distinction kept: part of
 * the amount not delivered as asked (`completed-not-all`, `cancelled-not-all`, a warning), a remainder kept in the balance
 * (`completed-kept`) — the eleventh review round, 2026-11-04, E11-1: "Every step settled." had replaced the runner's "part of the
 * amount did not arrive as you asked".
 */
export function shownWords(n: WalletNotification): { title: string; body: string } {
  if (!n.words) return { title: n.title, body: n.body };
  const title = t(`notification.campaign.${n.words.key}.title` as MessageKey, n.words.vars);
  // the cause's own code when the runner sent one (the third critique of slice 4), else the words of the pause's kind
  const code = n.words.vars?.code;
  const paused = (): string =>
    settings.get().advanced
      ? n.body
      : t(code && hasCode(code) ? (reasonKey(code) as MessageKey) : (PAUSE_WORDS[n.kind as AlertKind] ?? "notification.campaign.paused.body"));
  const body = n.words.key === "paused" ? paused() : t(`notification.campaign.${n.words.key}.body` as MessageKey, n.words.vars);
  return { title, body };
}

/** Starts the watcher (the Background does, while unlocked); amounts only when the user turned generic text off. */
export function startOperationNotifications(): () => void {
  // the system notification's words in the reader's language (audit round 2, r57)
  setSystemNotificationWords(() => ({ app: t("app.name"), generic: t("notification.generic") }));
  // and its body, when the user allows more than the generic text, in the toast's words (the second critique of E11-10)
  setSystemNotificationBody((n) => shownWords({ id: "", at: 0, ...n }).body);
  return watchOperationNotifications(
    (n) => {
      const w = notificationWords(n);
      notify({ kind: "info", title: w.title, body: w.body, operationId: n.operationId, tone: toneOf(n) });
    },
    { prefs: () => ({ amounts: !settings.get().protection.notifications.generic }) },
  );
}

/** Each new in-app notification once, as a toast (then marked read). */
export function NotificationToasts() {
  const list = useNotifications();
  const toast = useToast();
  const shown = useRef(new Set<string>());
  useEffect(() => {
    for (const n of list) {
      if (n.read || shown.current.has(n.id)) continue;
      shown.current.add(n.id);
      const kind: ToastKind = n.tone ?? "info";
      toast({ kind, ...shownWords(n) });
      notifications.markRead(n.id);
    }
  }, [list, toast]);
  return null;
}
