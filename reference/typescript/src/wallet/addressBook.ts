// The address book (spec V3 §12): destinations are security objects for large operations — every entry carries
// its chain, asset, label, verification and lifecycle GENERATED → VERIFIED → USED → SETTLED → RETIRED; an entered
// destination must be verified before any operation at ≥ high-value and is in a 24 h cooling-off after it is
// added; the Immediate override is explicit and journaled; a retired address is never selected automatically.
// Pure rules over plain records (the wallet keeps them in the encrypted journal; nothing here is ever sent).
import { atLeast, type Tier } from "./valuation";

export type AddressLifecycle = "generated" | "verified" | "used" | "settled" | "retired";
export type VerificationMethod = "derived" | "groups-read" | "signed-message" | "test-transaction";
export type AddressChain = "evm" | "bitcoin" | "solana";

export interface AddressBookEntry {
  id: string;
  chain: AddressChain;
  asset?: string;
  /** as entered / derived */
  address: string;
  /** the canonical form (destinations.ts: EIP-55, lowercase bech32) */
  normalized: string;
  label: string;
  /** a fresh address of this wallet (verified by derivation) or one the user entered */
  source: "fresh" | "entered";
  addedAt: number;
  lifecycle: AddressLifecycle;
  verification: { status: "unverified" | "verified"; method?: VerificationMethod; at?: number };
  /** unix ms: a ≥ high-value operation may not fund toward an entered address before this (§12) */
  coolingUntil?: number;
  override?: { at: number; by: "second-factor" | "second-device" };
  lastUsedAt?: number;
  /** the campaigns / orders that paid it */
  usedBy: string[];
}

export const COOLING_OFF_MS = 24 * 3600_000;

export function addEntry(o: { id: string; chain: AddressChain; address: string; normalized: string; label?: string; asset?: string; source: "fresh" | "entered"; now: number }): AddressBookEntry {
  const fresh = o.source === "fresh";
  return {
    id: o.id, chain: o.chain, asset: o.asset, address: o.address, normalized: o.normalized, label: o.label ?? (fresh ? "A fresh address of this wallet" : ""), source: o.source, addedAt: o.now,
    lifecycle: fresh ? "verified" : "generated",
    verification: fresh ? { status: "verified", method: "derived", at: o.now } : { status: "unverified" },
    ...(fresh ? {} : { coolingUntil: o.now + COOLING_OFF_MS }),
    usedBy: [],
  };
}

export function verifyEntry(e: AddressBookEntry, method: VerificationMethod, now: number): AddressBookEntry {
  return { ...e, lifecycle: e.lifecycle === "generated" ? "verified" : e.lifecycle, verification: { status: "verified", method, at: now } };
}

/** The Immediate override (§12): recorded with what confirmed it; the cooling-off then no longer applies. */
export function overrideCooling(e: AddressBookEntry, by: "second-factor" | "second-device", now: number): AddressBookEntry {
  return { ...e, override: { at: now, by } };
}

export type UseRefusal = { ok: false; reason: "retired" | "unverified" | "cooling-off"; until?: number };

/** Whether an operation of `tier` may pay this entry now (§12). */
export function canUse(e: AddressBookEntry, o: { tier: Tier; now: number }): { ok: true } | UseRefusal {
  if (e.lifecycle === "retired") return { ok: false, reason: "retired" };
  if (!atLeast(o.tier, "high-value")) return { ok: true };
  if (e.verification.status !== "verified") return { ok: false, reason: "unverified" };
  if (e.source === "entered" && e.coolingUntil !== undefined && e.coolingUntil > o.now && !e.override) return { ok: false, reason: "cooling-off", until: e.coolingUntil };
  return { ok: true };
}

export function markUsed(e: AddressBookEntry, by: string, now: number): AddressBookEntry {
  return { ...e, lifecycle: e.lifecycle === "retired" ? "retired" : "used", lastUsedAt: now, usedBy: e.usedBy.includes(by) ? e.usedBy : [...e.usedBy, by] };
}

/** A fresh address retires once its payment settled (one use, §12); an entered address stays usable but is warned on reuse. */
export function markSettled(e: AddressBookEntry, now: number): AddressBookEntry {
  if (e.source === "fresh") return { ...e, lifecycle: "retired", lastUsedAt: e.lastUsedAt ?? now };
  return { ...e, lifecycle: "settled" };
}

export function retire(e: AddressBookEntry): AddressBookEntry {
  return { ...e, lifecycle: "retired" };
}

/** The entries an automatic choice may draw from: never a retired one. */
export const selectable = (entries: AddressBookEntry[]): AddressBookEntry[] => entries.filter((e) => e.lifecycle !== "retired");

/** Text for the screens: what stands between this entry and a large payment. */
export function useStatus(e: AddressBookEntry, o: { tier: Tier; now: number }): string {
  const r = canUse(e, o);
  if (r.ok) return e.source === "fresh" ? "A fresh address of this wallet, verified by derivation." : e.override ? "Verified; the cooling-off was overridden." : "Verified.";
  if (r.reason === "retired") return "Retired: used once and never offered again.";
  if (r.reason === "unverified") return "Not verified yet: verify it before a large payment.";
  const hours = Math.max(1, Math.ceil(((r.until ?? o.now) - o.now) / 3600_000));
  return `Added recently: large payments wait ${hours} h more (or confirm an immediate use).`;
}
