// The fresh-destination fact of the Privacy Center (spec §3.13, §15; V6 Stage 14: the rest of its facts are computed in
// ./model.ts): no entered destination was used in the last 30 days, from the address book. Pure.
import type { AddressBookEntry } from "@privacy-wallet/sdk/wallet/addressBook";

export const FRESH_WINDOW_MS = 30 * 86_400_000;

/** V5 (spec §15): no entered destination was used in the last 30 days (from the address book). */
export function freshDestinations(book: AddressBookEntry[], now = Date.now()): boolean {
  return !book.some((e) => e.source === "entered" && e.lastUsedAt !== undefined && now - e.lastUsedAt < FRESH_WINDOW_MS);
}
