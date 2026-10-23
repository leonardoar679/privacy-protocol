// Operation notifications in the app (spec v2.0 §12.5; doc §76; V6 Stage 15): the engine decides which change deserves
// one (notificationFor, packages/sdk/src/operations/notify.ts); this module gives it the catalog's words and delivers it
// through the engine's notifier — the in-app list, shown as a toast while the app is open, and the browser's
// Notification API while the tab is hidden, generic unless the user allowed amounts. No amount by default.
import { useEffect, useRef } from "react";
import { useToast, type ToastKind } from "@privacy-wallet/ui";
import { watchOperationNotifications, type NotifiedAmount, type OperationNotification } from "@privacy-wallet/sdk/operations/notify";
import { notifications, notify, setSystemNotificationWords, type WalletNotification } from "@privacy-wallet/sdk/wallet/notifications";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { t, type MessageKey } from "./i18n/messages";
import { amountFrom, displayAmount } from "../features/amounts";
import { useNotifications } from "../hooks/core";

const TONE: Record<OperationNotification["kind"], "info" | "success" | "warn"> = {
  "quote-ready": "info",
  confirmed: "info",
  "cross-chain-executing": "info",
  completed: "success",
  "recovery-required": "warn",
};

const amountText = (a: NotifiedAmount): string => `${displayAmount(amountFrom(a.value, a.asset, a.decimals))} ${a.asset}`;

/** The words of a notification: its kind's title and body, the amounts in front only when the user allowed them. */
export function notificationWords(n: OperationNotification): { title: string; body: string } {
  const title = t(`notification.${n.kind}.title` as MessageKey);
  const body = t(`notification.${n.kind}.body` as MessageKey);
  if (!n.amounts) return { title, body };
  const amounts = n.amounts.output ? `${amountText(n.amounts.input)} → ${amountText(n.amounts.output)}` : amountText(n.amounts.input);
  return { title, body: t("notification.withAmounts", { amounts, body }) };
}

/**
 * A notification in the reader's language (audit round 2, r57): a protected execution's alert by its catalog words — a pause
 * keeps the runner's own reason —, any other as given.
 */
export function shownWords(n: WalletNotification): { title: string; body: string } {
  if (!n.words) return { title: n.title, body: n.body };
  const title = t(`notification.campaign.${n.words.key}.title` as MessageKey, n.words.vars);
  const body = n.words.key === "paused" ? n.body : t(`notification.campaign.${n.words.key}.body` as MessageKey, n.words.vars);
  return { title, body };
}

/** Starts the watcher (the Background does, while unlocked); amounts only when the user turned generic text off. */
export function startOperationNotifications(): () => void {
  // the system notification's words in the reader's language (audit round 2, r57)
  setSystemNotificationWords(() => ({ app: t("app.name"), generic: t("notification.generic") }));
  return watchOperationNotifications(
    (n) => {
      const w = notificationWords(n);
      notify({ kind: "info", title: w.title, body: w.body, operationId: n.operationId, tone: TONE[n.kind] });
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
