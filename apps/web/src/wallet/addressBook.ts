// The wallet's address book (High-Value Protection spec §12): destinations are security objects for large operations.
// Entries live in the encrypted journal (`addressBook?`, optional) and nowhere else. Fresh addresses of this wallet are
// recorded when they are reserved (verified by derivation) and retire once their payment settled; an entered address
// must be verified — the grouped address re-typed, a signed message the wallet checks, or a test transaction — before
// an operation at ≥ high-value may pay it, and waits 24 h after it is added unless the Immediate override was confirmed.
// The rules are the shared core's (packages/protocol/src/wallet/addressBook.ts); this module journals them.
import { useSyncExternalStore } from "react";
import { recoverMessageAddress, type Hex } from "viem";
import { approveEntry,
  addEntry, canUse, challengeMessage, markSettled, markUsed, overrideCooling, retire, selectable, useStatus as entryStatus, verifyEntry, verifySolanaMessage,
  type AddressBookEntry, type AddressChain, type VerificationMethod,
} from "@ref/wallet/addressBook";
import { parseDestination } from "@ref/wallet/destinations";
import { atLeast, type Tier } from "@ref/wallet/valuation";
import type { JournalData } from "./journal";
import { session as defaultSession, type WalletSession } from "./session";

export type { AddressBookEntry, AddressChain, VerificationMethod };
export { challengeMessage, selectable, entryStatus as useStatus };

const EMPTY: AddressBookEntry[] = [];
/** The book of a journal (the same empty array while there is none: a stable snapshot for the screens). */
export const bookOf = (j: JournalData): AddressBookEntry[] => j.addressBook ?? EMPTY;
export const useAddressBook = (s: WalletSession = defaultSession): AddressBookEntry[] => useSyncExternalStore((l) => s.subscribe(l), () => (s.isUnlocked() ? bookOf(s.journal()) : EMPTY));

/** One entry per chain and canonical address (EIP-55 differs only in case: the id is lowercase). */
export const entryIdFor = (chain: AddressChain, normalized: string): string => `${chain}:${normalized.toLowerCase()}`;

function put(e: AddressBookEntry, s: WalletSession): void {
  s.update((j) => { j.addressBook = [...(j.addressBook ?? []).filter((x) => x.id !== e.id), e].sort((a, b) => a.addedAt - b.addedAt); });
}
export function entryById(id: string, s: WalletSession = defaultSession): AddressBookEntry | null {
  return s.isUnlocked() ? bookOf(s.journal()).find((e) => e.id === id) ?? null : null;
}
/** The entry of a typed or derived address on `chain`, if it is in the book (the address is parsed to its canonical form first). */
export function findEntry(chain: AddressChain, address: string, s: WalletSession = defaultSession): AddressBookEntry | null {
  const p = parseDestination(chain, address);
  if (!p.ok) return null;
  return entryById(entryIdFor(chain, p.normalized), s);
}

/** Add an entered address (the user's own, verified later) or return the existing entry; a malformed address is refused with the parser's reason. */
export function addAddress(o: { chain: AddressChain; address: string; label?: string; asset?: string; now?: number }, s: WalletSession = defaultSession): { ok: true; entry: AddressBookEntry; existed: boolean } | { ok: false; reason: string } {
  const p = parseDestination(o.chain, o.address);
  if (!p.ok) return { ok: false, reason: p.reason };
  const id = entryIdFor(o.chain, p.normalized);
  const existing = entryById(id, s);
  if (existing) return { ok: true, entry: existing, existed: true };
  const entry = addEntry({ id, chain: o.chain, address: p.address, normalized: p.normalized, label: o.label, asset: o.asset, source: "entered", now: o.now ?? Date.now() });
  put(entry, s);
  return { ok: true, entry, existed: false };
}

/** A fresh address of this wallet, recorded when it is reserved (keys/chainKeys.ts): verified by derivation, no cooling-off. */
export function recordFreshAddress(chain: AddressChain, address: string, index: number, s: WalletSession = defaultSession, now = Date.now()): AddressBookEntry | null {
  if (!s.isUnlocked()) return null;
  const p = parseDestination(chain, address);
  const normalized = p.ok ? p.normalized : address;
  const id = entryIdFor(chain, normalized);
  const existing = entryById(id, s);
  if (existing) return existing;
  const entry = addEntry({ id, chain, address, normalized, label: `Fresh address #${index + 1}`, source: "fresh", now });
  put(entry, s);
  return entry;
}

export function verifyAddress(id: string, method: VerificationMethod, s: WalletSession = defaultSession, now = Date.now()): AddressBookEntry | null {
  const e = entryById(id, s);
  if (!e) return null;
  const v = verifyEntry(e, method, now);
  put(v, s);
  return v;
}
/** The Immediate override (§12), journaled with what confirmed it; the cooling-off then no longer applies. */
export function overrideCoolingOff(id: string, by: "second-factor" | "second-device", s: WalletSession = defaultSession, now = Date.now()): AddressBookEntry | null {
  const e = entryById(id, s);
  if (!e) return null;
  const v = overrideCooling(e, by, now);
  put(v, s);
  return v;
}
export function retireAddress(id: string, s: WalletSession = defaultSession): AddressBookEntry | null {
  const e = entryById(id, s);
  if (!e) return null;
  const v = retire(e);
  put(v, s);
  return v;
}
export function relabelAddress(id: string, label: string, s: WalletSession = defaultSession): void {
  const e = entryById(id, s);
  if (e) put({ ...e, label }, s);
}
/** At a hand-over (a tranche or an order): the destination is `used` by that order. */
export function markAddressUsed(chain: AddressChain, address: string, by: string, s: WalletSession = defaultSession, now = Date.now()): void {
  const e = findEntry(chain, address, s);
  if (e) put(markUsed(e, by, now), s);
}
/** V4 (plan §18–§19): the explicit approval for large payments, once verified and out of its cooling-off (or overridden). */
export function approveAddress(id: string, s: WalletSession = defaultSession, now = Date.now()): AddressBookEntry | null {
  const e = bookOf(s.journal()).find((x) => x.id === id);
  if (!e) return null;
  const a = approveEntry(e, now);
  put(a, s);
  return a;
}
/** At settlement: a fresh address retires (one use), an entered one is `settled` and stays usable. */
export function markAddressSettled(chain: AddressChain, address: string, s: WalletSession = defaultSession, now = Date.now()): void {
  const e = findEntry(chain, address, s);
  if (e) put(markSettled(e, now), s);
}

export interface DestinationCheck {
  entry: AddressBookEntry | null;
  /** the operation may pay this destination now */
  ok: boolean;
  /** what stands in the way: unknown (not in the book), unverified, cooling-off, unapproved or stale (V4, plan §19), retired */
  reason?: "unknown" | "unverified" | "cooling-off" | "unapproved" | "stale" | "retired";
  /** the entry is verified (an unverified one can never be confirmed at ≥ high-value; a cooling one can, its first funding waits) */
  verified: boolean;
  /** the cooling-off end, when it is the only obstacle */
  until?: number;
  status: string;
}

/** What stands between this destination and an operation of `tier` (§12): nothing below high-value; the book's rules above. */
export function destinationCheck(chain: AddressChain, address: string, o: { tier: Tier; now?: number }, s: WalletSession = defaultSession): DestinationCheck {
  const now = o.now ?? Date.now();
  const entry = findEntry(chain, address, s);
  const large = atLeast(o.tier, "high-value");
  if (!entry) return large
    ? { entry: null, ok: false, reason: "unknown", verified: false, status: "Not in your address book: add it and verify it before a large payment." }
    : { entry: null, ok: true, verified: false, status: "Entered by hand: check every group before you confirm." };
  const r = canUse(entry, { tier: o.tier, now });
  const verified = entry.verification.status === "verified";
  if (r.ok) return { entry, ok: true, verified, status: entryStatus(entry, { tier: o.tier, now }) };
  return { entry, ok: false, reason: r.reason, verified, ...(r.reason === "cooling-off" ? { until: r.until } : {}), status: entryStatus(entry, { tier: o.tier, now }) };
}

/** The signed-message check (§12): an EVM address proves control with an EIP-191 signature the wallet recovers offline; a Solana address with an ed25519 signature. Bitcoin signatures are not read (use the groups or a test transaction). */
export async function verifySignedChallenge(entry: AddressBookEntry, message: string, signature: string): Promise<boolean> {
  try {
    if (entry.chain === "evm") {
      const sig = signature.trim();
      if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
      const recovered = await recoverMessageAddress({ message, signature: sig as Hex });
      return recovered.toLowerCase() === entry.normalized.toLowerCase();
    }
    if (entry.chain === "solana") return verifySolanaMessage(entry.normalized, message, signature);
    return false;
  } catch { return false; }
}

/** The verification methods a chain offers on the screen (§12): the groups everywhere, a signed message where the wallet can check it, a test transaction where the pool can pay it. */
export function methodsFor(chain: AddressChain): VerificationMethod[] {
  return chain === "evm" ? ["groups-read", "signed-message", "test-transaction"] : chain === "solana" ? ["groups-read", "signed-message"] : ["groups-read"];
}
