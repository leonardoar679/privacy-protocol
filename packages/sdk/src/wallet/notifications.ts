// Notifications (High-Value Protection spec §15; plan V3 §76, §144–§146): in-app always (a store the screens read),
// the browser's Notification API only when the user enabled it and the tab is hidden, with the generic text "Your
// private operation has updated" unless amount previews are allowed. No push server, no native shell (out of scope).
import type { AlertKind } from "@privacy-wallet/protocol/wallet/campaign";
import { settings as defaultSettings, type ProtectionSettings } from "./settings";

export interface WalletNotification {
  id: string;
  at: number;
  kind: AlertKind | "info";
  title: string;
  body: string;
  campaignId?: string;
  /** V6 Stage 15 (doc §76): the operation it is about, and the tone its toast takes */
  operationId?: string;
  tone?: "info" | "success" | "warn";
  read?: boolean;
  /** a protected execution's alert by its catalog words, the app's to say in the reader's language (audit round 2, r57) */
  words?: AlertWords;
}

/** A protected execution's alerts, named for the app's catalog (`notification.campaign.<key>.title/.body`, with `vars`). */
export interface AlertWords { key: "paused" | "route-changed" | "route-review" | "cancelled" | "completed"; vars?: Record<string, string> }

export const GENERIC_TEXT = "Your private operation has updated";
/**
 * The system notification's words: the app gives its catalog's (audit round 2, r57) — it had always read "Privacy Wallet —
 * Your private operation has updated", in English, whatever the language the reader chose.
 */
let systemWords = (): { app: string; generic: string } => ({ app: "Privacy Wallet", generic: GENERIC_TEXT });
export function setSystemNotificationWords(words: () => { app: string; generic: string }): void {
  systemWords = words;
}
const MAX_KEPT = 50;

class NotificationStore {
  private list: WalletNotification[] = [];
  private listeners = new Set<() => void>();
  all(): WalletNotification[] { return this.list; }
  unread(): number { return this.list.filter((n) => !n.read).length; }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(): void { for (const l of this.listeners) l(); }
  push(n: Omit<WalletNotification, "id" | "at"> & { at?: number }): WalletNotification {
    const full: WalletNotification = { id: `${n.at ?? Date.now()}:${Math.random().toString(36).slice(2, 8)}`, at: n.at ?? Date.now(), ...n };
    this.list = [...this.list, full].slice(-MAX_KEPT);
    this.emit();
    return full;
  }
  markRead(id?: string): void { this.list = this.list.map((n) => (id === undefined || n.id === id ? { ...n, read: true } : n)); this.emit(); }
  clear(): void { this.list = []; this.emit(); }
}
export const notifications = new NotificationStore();

export interface NotifyDeps {
  settings?: ProtectionSettings["notifications"];
  /** the tab is hidden (document.hidden); a system notification is shown only then */
  hidden?: boolean;
  /** the system notifier (the browser's Notification API by default); tests inject one */
  system?: (title: string, body: string) => void;
  now?: number;
}

function browserSystem(title: string, body: string): void {
  const N = (globalThis as { Notification?: { permission: string; new (t: string, o?: { body?: string }): unknown } }).Notification;
  if (!N || N.permission !== "granted") return;
  try { new N(title, { body }); } catch { /* a blocked API is no error */ }
}

/** Deliver one notification by the user's settings: in-app when allowed; the system one only when enabled and the tab is hidden, generic unless amounts are allowed. */
export function notify(n: { kind: AlertKind | "info"; title: string; body: string; campaignId?: string; operationId?: string; tone?: WalletNotification["tone"]; words?: AlertWords }, deps: NotifyDeps = {}): WalletNotification | null {
  const s = deps.settings ?? defaultSettings.get().protection.notifications;
  const hidden = deps.hidden ?? (typeof document !== "undefined" ? document.hidden : false);
  let shown: WalletNotification | null = null;
  if (s.inApp) shown = notifications.push({ kind: n.kind, title: n.title, body: n.body, campaignId: n.campaignId, ...(n.operationId ? { operationId: n.operationId } : {}), ...(n.tone ? { tone: n.tone } : {}), ...(n.words ? { words: n.words } : {}), at: deps.now });
  if (s.system && hidden) {
    const w = systemWords();
    (deps.system ?? browserSystem)(w.app, s.generic ? w.generic : n.body);
  }
  return shown;
}

/** Settings → Notifications: ask the browser once; false when the API is absent or refused. */
export async function requestSystemNotifications(): Promise<boolean> {
  const N = (globalThis as { Notification?: { permission: string; requestPermission?: () => Promise<string> } }).Notification;
  if (!N?.requestPermission) return false;
  try { return (await N.requestPermission()) === "granted"; } catch { return false; }
}
