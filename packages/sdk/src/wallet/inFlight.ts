// V7 Stage 13 (spec v3.0 §4; the owner's decision 3): the $50K–$100K band's exposure limit — one protected operation of the
// band in flight per wallet (sdk/tiers PROTECTED_EXECUTION.MAX_IN_FLIGHT). Counted from the encrypted journal: the band's open
// single orders (never a campaign's own steps) and its campaigns not yet completed or cancelled. Nothing here is sent anywhere.
import { isOpenSwap } from "../swapFunding";
import { PROTECTED_EXECUTION } from "../tiers";
import { campaignsOf, TERMINAL_STATES } from "./campaigns";
import type { JournalData } from "./journal";
import { session as defaultSession, type WalletSession } from "./session";

/** The band's protected operations in flight in a journal: its open orders and its running campaigns. */
export function protectedInFlightOf(j: JournalData): number {
  const orders = j.swaps.filter((x) => !x.campaign && x.tier === "large-protected" && isOpenSwap(x)).length;
  const campaigns = campaignsOf(j).filter((c) => c.tier === "large-protected" && !TERMINAL_STATES.includes(c.state)).length;
  return orders + campaigns;
}

/** The band's protected operations this wallet has in flight (0 while locked). */
export const protectedInFlight = (s: WalletSession = defaultSession): number => (s.isUnlocked() ? protectedInFlightOf(s.journal()) : 0);

/** Whether the band's limit is reached: no further protected operation of the band may start now. */
export const inFlightLimitReached = (s: WalletSession = defaultSession): boolean => protectedInFlight(s) >= PROTECTED_EXECUTION.MAX_IN_FLIGHT;
