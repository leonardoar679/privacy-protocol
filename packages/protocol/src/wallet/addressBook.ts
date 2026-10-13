// The address book (spec V3 §12; V4 contract §3.12, §4.5): destinations are security objects for large operations — every
// entry carries its chain, asset, label, verification and lifecycle GENERATED → VERIFIED → APPROVED → USED → SETTLED → RETIRED
// (the plan's §19; an approval idle for 90 days is stale and needs a re-check before a large payment); an entered
// destination must be verified before any operation at ≥ high-value and is in a 24 h cooling-off after it is
// added; the Immediate override is explicit and journaled; a retired address is never selected automatically.
// Pure rules over plain records (the wallet keeps them in the encrypted journal; nothing here is ever sent).
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { atLeast, type Tier } from "./valuation";

export type AddressLifecycle = "generated" | "verified" | "approved" | "used" | "settled" | "retired";
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
  /** V4 (plan §19): the explicit approval for large payments (the Immediate override is one); stale after APPROVAL_IDLE_MS idle */
  approvedAt?: number;
  lastUsedAt?: number;
  /** the campaigns / orders that paid it */
  usedBy: string[];
}

export const COOLING_OFF_MS = 24 * 3600_000;
/** An approval (or the last use or re-check) older than this is stale: the entry needs a re-check before a payment at ≥ high-value (plan §19). */
export const APPROVAL_IDLE_MS = 90 * 24 * 3600_000;

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

/** The explicit approval for large payments (plan §18–§19, the local allowlist): only a verified entry; a retired one stays retired. */
export function approveEntry(e: AddressBookEntry, now: number): AddressBookEntry {
  if (e.verification.status !== "verified" || e.lifecycle === "retired") return e;
  return { ...e, lifecycle: e.lifecycle === "generated" || e.lifecycle === "verified" ? "approved" : e.lifecycle, approvedAt: now };
}

/** The Immediate override (§12): recorded with what confirmed it; the cooling-off then no longer applies, and the override is the approval. */
export function overrideCooling(e: AddressBookEntry, by: "second-factor" | "second-device", now: number): AddressBookEntry {
  return approveEntry({ ...e, override: { at: now, by } }, now);
}

/** Stale (plan §19): approved, but neither approved, re-checked nor used within APPROVAL_IDLE_MS. */
export const isStale = (e: AddressBookEntry, now: number): boolean => e.approvedAt !== undefined && now - Math.max(e.approvedAt, e.verification.at ?? 0, e.lastUsedAt ?? 0) > APPROVAL_IDLE_MS;

export type UseRefusal = { ok: false; reason: "retired" | "unverified" | "cooling-off" | "unapproved" | "stale"; until?: number };

/** Whether an operation of `tier` may pay this entry now (§12). */
export function canUse(e: AddressBookEntry, o: { tier: Tier; now: number }): { ok: true } | UseRefusal {
  if (e.lifecycle === "retired") return { ok: false, reason: "retired" };
  if (!atLeast(o.tier, "high-value")) return { ok: true };
  if (e.verification.status !== "verified") return { ok: false, reason: "unverified" };
  if (e.source === "entered" && e.coolingUntil !== undefined && e.coolingUntil > o.now && !e.override) return { ok: false, reason: "cooling-off", until: e.coolingUntil };
  if (e.source === "entered" && e.approvedAt === undefined) return { ok: false, reason: "unapproved" };
  if (e.source === "entered" && isStale(e, o.now)) return { ok: false, reason: "stale" };
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
  if (r.reason === "unapproved") return "Verified; approve it for large payments to use it.";
  if (r.reason === "stale") return "Approved long ago and not used since: check it again before a large payment.";
  const hours = Math.max(1, Math.ceil(((r.until ?? o.now) - o.now) / 3600_000));
  return `Added recently: large payments wait ${hours} h more (or confirm an immediate use).`;
}

/** The challenge an entered destination signs to prove control (§12, signed-message): plain text, dated, naming the address and the entry. */
export const challengeMessage = (e: Pick<AddressBookEntry, "id" | "normalized">, at: number): string => `Privacy Wallet destination check
address: ${e.normalized}
id: ${e.id}
at: ${new Date(at).toISOString()}`;

/** A Solana destination proves control with an ed25519 signature (base58 or hex, 64 bytes) of the challenge; the address is the public key. */
export function verifySolanaMessage(address: string, message: string, signature: string): boolean {
  try {
    const pub = base58.decode(address);
    const s = signature.trim();
    const sig = /^(0x)?[0-9a-fA-F]{128}$/.test(s) ? hexToBytes(s.replace(/^0x/, "")) : base58.decode(s);
    return pub.length === 32 && sig.length === 64 && ed25519.verify(sig, utf8ToBytes(message), pub);
  } catch { return false; }
}
