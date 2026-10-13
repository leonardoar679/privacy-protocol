// The address book (High-Value Protection spec §12; V4 contract §3.12, §4.5): the lifecycle, verification, the 24 h
// cooling-off and its override, the approval step and its staleness, what a tier may pay, and that a retired address
// is never offered again.
import { describe, it, expect } from "vitest";
import { addEntry, approveEntry, APPROVAL_IDLE_MS, canUse, COOLING_OFF_MS, isStale, markSettled, markUsed, overrideCooling, retire, selectable, useStatus, verifyEntry } from "../src/wallet/addressBook";

const now = 1_000_000_000;
const entered = () => addEntry({ id: "a", chain: "bitcoin", address: "bc1qentered", normalized: "bc1qentered", label: "exchange", source: "entered", now });
const fresh = () => addEntry({ id: "f", chain: "bitcoin", address: "bc1qfresh", normalized: "bc1qfresh", source: "fresh", now });

describe("address book", () => {
  it("a fresh address is verified by derivation and has no cooling-off; an entered one starts unverified with a 24 h cooling-off", () => {
    expect(fresh()).toMatchObject({ lifecycle: "verified", verification: { status: "verified", method: "derived" }, source: "fresh" });
    expect(fresh().coolingUntil).toBeUndefined();
    expect(entered()).toMatchObject({ lifecycle: "generated", verification: { status: "unverified" }, coolingUntil: now + COOLING_OFF_MS, usedBy: [] });
  });
  it("below high-value anything but a retired entry may be paid; at high-value an entered address must be verified and out of its cooling-off", () => {
    const e = entered();
    expect(canUse(e, { tier: "enhanced", now })).toEqual({ ok: true });
    expect(canUse(e, { tier: "high-value", now })).toEqual({ ok: false, reason: "unverified" });
    const v = verifyEntry(e, "groups-read", now + 1);
    expect(v).toMatchObject({ lifecycle: "verified", verification: { status: "verified", method: "groups-read" } });
    expect(canUse(v, { tier: "high-value", now: now + 2 })).toEqual({ ok: false, reason: "cooling-off", until: now + COOLING_OFF_MS });
    // V4 (plan §19): out of its cooling-off the entry still needs the explicit approval for large payments
    expect(canUse(v, { tier: "institutional", now: now + COOLING_OFF_MS })).toEqual({ ok: false, reason: "unapproved" });
    const approved = approveEntry(v, now + COOLING_OFF_MS);
    expect(approved).toMatchObject({ lifecycle: "approved", approvedAt: now + COOLING_OFF_MS });
    expect(canUse(approved, { tier: "institutional", now: now + COOLING_OFF_MS })).toEqual({ ok: true });
    expect(approveEntry(e, now).approvedAt).toBeUndefined(); // never an unverified one
    // the Immediate override is an approval
    expect(canUse(overrideCooling(v, "second-factor", now + 3), { tier: "institutional", now: now + 4 })).toEqual({ ok: true });
    expect(overrideCooling(v, "second-factor", now + 3)).toMatchObject({ lifecycle: "approved", approvedAt: now + 3 });
    expect(canUse(fresh(), { tier: "institutional", now })).toEqual({ ok: true });
    expect(canUse(retire(fresh()), { tier: "standard", now })).toEqual({ ok: false, reason: "retired" });
  });
  it("use and settlement: a fresh address retires after one payment, an entered one stays usable; retired entries are never selectable", () => {
    const f = markSettled(markUsed(fresh(), "campaign-1", now + 10), now + 20);
    expect(f).toMatchObject({ lifecycle: "retired", usedBy: ["campaign-1"], lastUsedAt: now + 10 });
    const e = markSettled(markUsed(markUsed(verifyEntry(entered(), "signed-message", now), "c1", now + 10), "c1", now + 11), now + 20);
    expect(e).toMatchObject({ lifecycle: "settled", usedBy: ["c1"] });
    expect(selectable([f, e]).map((x) => x.id)).toEqual(["a"]);
    expect(markUsed(f, "c2", now + 30).lifecycle).toBe("retired");
  });
  it("an approval idle for 90 days is stale: a re-check or a use refreshes it; fresh addresses never go stale", () => {
    const a = approveEntry(verifyEntry(entered(), "groups-read", now), now + COOLING_OFF_MS);
    const later = now + COOLING_OFF_MS + APPROVAL_IDLE_MS + 1;
    expect(isStale(a, later)).toBe(true);
    expect(canUse(a, { tier: "high-value", now: later })).toEqual({ ok: false, reason: "stale" });
    expect(canUse(a, { tier: "enhanced", now: later })).toEqual({ ok: true });
    expect(canUse(verifyEntry(a, "signed-message", later), { tier: "high-value", now: later })).toEqual({ ok: true });
    expect(canUse(markUsed(a, "c9", later - 86_400_000), { tier: "high-value", now: later })).toEqual({ ok: true });
    expect(isStale(fresh(), later)).toBe(false);
    expect(canUse(fresh(), { tier: "institutional", now: later })).toEqual({ ok: true });
    expect(useStatus(a, { tier: "high-value", now: later })).toMatch(/check it again/);
    expect(useStatus(verifyEntry(entered(), "groups-read", now), { tier: "high-value", now: now + COOLING_OFF_MS })).toMatch(/approve it for large payments/);
  });
  it("the status line says what stands between the entry and a large payment", () => {
    expect(useStatus(fresh(), { tier: "institutional", now })).toMatch(/fresh address of this wallet/);
    expect(useStatus(entered(), { tier: "institutional", now })).toMatch(/Not verified yet/);
    expect(useStatus(verifyEntry(entered(), "groups-read", now), { tier: "institutional", now: now + 3600_000 })).toMatch(/wait 23 h more/);
    expect(useStatus(retire(fresh()), { tier: "standard", now })).toMatch(/Retired/);
    expect(useStatus(overrideCooling(verifyEntry(entered(), "groups-read", now), "second-device", now), { tier: "institutional", now })).toMatch(/overridden/);
  });
});
