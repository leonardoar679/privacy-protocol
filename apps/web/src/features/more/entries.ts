// The entries of More (spec v3.0 §2; doc §3, §15; V7 Stage 4): one list for the phone's More screen and the desktop's
// Wallet menu, so everything reachable on a phone is reachable on a desktop (doc §88) — Tornado Classic (a separate
// application served under /classic/, reached through a plain link that leaves the wallet's router), the Privacy
// Center and Settings; the Advanced experience adds Private AI. Receive, Security, Wallet, Language and Advanced live
// under Settings now (features/settings/Settings.tsx).
import type { IconName } from "@privacy-wallet/ui";
import { config } from "@privacy-wallet/sdk/config";
import type { MessageKey } from "../../app/i18n/en";

export interface MoreEntry {
  to: string;
  title: MessageKey;
  subtitle: MessageKey;
  icon: IconName;
  /** more-<id> on the More screen, menu-<id> in the Wallet menu */
  id: string;
  advancedOnly?: boolean;
  /** a plain link, not a route: the Classic app is another application on this origin (spec v3.0 §7.8) */
  external?: boolean;
}

export const MORE_ENTRIES: readonly MoreEntry[] = [
  { to: "/classic/", title: "route.tornadoClassic", subtitle: "more.tornadoClassicWhy", icon: "recovery", id: "classic", external: true },
  { to: "/privacy", title: "route.privacy", subtitle: "more.privacyWhy", icon: "shield", id: "privacy" },
  { to: "/settings", title: "route.settings", subtitle: "more.settingsWhy", icon: "gear", id: "settings" },
  { to: "/more/ai", title: "route.ai", subtitle: "more.aiWhy", icon: "globe", id: "ai", advancedOnly: true },
];

/** The entries of the experience; the Classic entry points where the build serves the Classic application (VITE_CLASSIC_URL — its own origin is the stricter hosting; the fourth review round, 2026-11-03). */
export const moreEntries = (experience: "simple" | "advanced"): MoreEntry[] =>
  MORE_ENTRIES.filter((e) => !e.advancedOnly || experience === "advanced").map((e) => (e.id === "classic" ? { ...e, to: config().classicUrl ?? e.to } : e));
