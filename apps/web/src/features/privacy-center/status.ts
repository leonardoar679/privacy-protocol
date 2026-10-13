// The Privacy Center's facts (spec §3.13, §15): computed, never asserted — the session facts (no analytics and no
// tracking are structural: no such code path exists, the leakage gate proves it on every build; the wallet data is
// ciphertext in the secure store; a private operation is a relayer submission paid with a private note; the
// destination is isolated when no entered destination was used in the last 30 days) and the §31 rows from the
// posture. Pure over the stores the wallet already keeps; nothing is fetched.
import type { Posture } from "@ref/wallet/privacyCenter";
import type { AddressBookEntry } from "../../wallet/addressBook";
import type { Settings } from "../../wallet/settings";
import type { Deployment } from "../../sdk/chain";
import { specForChain } from "../../sdk/lightclient/spec";

export const FRESH_WINDOW_MS = 30 * 86_400_000;

/** V5 (spec §15): no entered destination was used in the last 30 days (from the address book). */
export function freshDestinations(book: AddressBookEntry[], now = Date.now()): boolean {
  return !book.some((e) => e.source === "entered" && e.lastUsedAt !== undefined && now - e.lastUsedAt < FRESH_WINDOW_MS);
}

export interface SessionFacts { analyticsOff: true; trackingOff: true; walletDataLocal: true; privateOperation: boolean; destinationIsolated: boolean }
export interface PrivacyRow { id: "protection" | "walletData" | "analytics" | "privateRpc" | "shielded" | "freshDestination"; ok: boolean; level?: Posture["overall"] }

export function sessionFacts(s: Pick<Settings, "submission">, book: AddressBookEntry[], now = Date.now()): SessionFacts {
  return { analyticsOff: true, trackingOff: true, walletDataLocal: true, privateOperation: s.submission.kind === "relayer", destinationIsolated: freshDestinations(book, now) };
}

export function privacyRows(posture: Posture, deployment: Deployment | null, s: Pick<Settings, "submission" | "verifyReads">, book: AddressBookEntry[], now = Date.now()): PrivacyRow[] {
  const endpoints = deployment ? (deployment.rpcUrls?.length ? deployment.rpcUrls.length : 1) : 0;
  const lightClient = !!deployment && s.verifyReads && !!specForChain(deployment.chainId);
  return [
    { id: "protection", ok: posture.overall !== "Reduced", level: posture.overall },
    { id: "walletData", ok: true },
    { id: "analytics", ok: true },
    { id: "privateRpc", ok: endpoints >= 2 && lightClient },
    { id: "shielded", ok: s.submission.kind === "relayer" },
    { id: "freshDestination", ok: freshDestinations(book, now) },
  ];
}
