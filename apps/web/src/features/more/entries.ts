// The entries of More (spec v2.0 §6, §7.10): one list for the phone's More screen and the desktop's Wallet menu, so
// everything reachable on a phone is reachable on a desktop (doc §88). Advanced shows only in the Advanced experience;
// Classic Privacy is here and nowhere near Swap or Send (doc §53).
import type { IconName } from "@privacy-wallet/ui";
import type { MessageKey } from "../../app/i18n/en";

export interface MoreEntry {
  to: string;
  title: MessageKey;
  subtitle: MessageKey;
  icon: IconName;
  /** more-<id> on the More screen, menu-<id> in the Wallet menu */
  id: string;
  advancedOnly?: boolean;
}

export const MORE_ENTRIES: readonly MoreEntry[] = [
  { to: "/receive", title: "route.receive", subtitle: "more.receiveWhy", icon: "receive", id: "receive" },
  { to: "/more/privacy", title: "route.privacy", subtitle: "more.privacyWhy", icon: "shield", id: "privacy" },
  { to: "/more/security", title: "route.security", subtitle: "more.securityWhy", icon: "lock", id: "security" },
  { to: "/more/wallet", title: "route.wallet", subtitle: "more.walletWhy", icon: "wallet", id: "wallet" },
  // V6 Stage 16 (spec v2.0 §18): the language picker
  { to: "/more/language", title: "route.language", subtitle: "more.languageWhy", icon: "globe", id: "language" },
  { to: "/more/classic", title: "route.classic", subtitle: "more.classicWhy", icon: "recovery", id: "classic" },
  { to: "/more/ai", title: "route.ai", subtitle: "more.aiWhy", icon: "globe", id: "ai" },
  { to: "/more/advanced", title: "route.advanced", subtitle: "more.advancedWhy", icon: "gear", id: "advanced", advancedOnly: true },
];

export const moreEntries = (experience: "simple" | "advanced"): MoreEntry[] => MORE_ENTRIES.filter((e) => !e.advancedOnly || experience === "advanced");
