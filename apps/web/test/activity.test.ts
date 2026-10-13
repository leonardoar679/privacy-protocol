// The Activity records (whale spec §25): written into the encrypted journal only, replaced by id (the first
// time stamp kept), updated, deleted; the labels never say "failed" for a funded swap; the journal's
// optional field stays out of emptyJournal() so the pinned at-rest vectors hold.
import { describe, it, expect, beforeEach } from "vitest";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { emptyJournal } from "@privacy-wallet/sdk/wallet/journal";
import { activityId, activityOf, activityStatusLabel, deleteActivity, isFinished, recordActivity, updateActivity } from "@privacy-wallet/sdk/wallet/activity";
import { fmtUnits, parseUnitsSafe, shortRef } from "@privacy-wallet/sdk/format";

const KDF = { N: 1 << 12, r: 8, p: 1 };

describe("activity records", () => {
  let s: WalletSession;
  beforeEach(async () => { noteStore.clear(); s = new WalletSession(memoryStorage(), KDF); await s.create("pw"); });

  it("are recorded, replaced by id, updated and deleted in the journal; emptyJournal() has no activity field", () => {
    expect("activity" in emptyJournal()).toBe(false);
    expect(activityOf(s.journal())).toEqual([]);
    recordActivity({ id: activityId("swap", "0xABC"), kind: "swap", asset: "ETH", decimals: 18, amount: "1", status: "committed", ref: "0xABC", at: 1000 }, s);
    recordActivity({ id: "shield:0x1", kind: "shield", asset: "USDC", decimals: 6, amount: "2500000", status: "completed", ref: "0x1" }, s);
    expect(activityOf(s.journal()).map((r) => r.id)).toEqual(["swap:0xabc", "shield:0x1"]);
    recordActivity({ id: "swap:0xabc", kind: "swap", asset: "ETH", decimals: 18, amount: "1", status: "funded", ref: "0xABC", at: 5000 }, s);
    const swap = activityOf(s.journal())[0];
    expect(swap.status).toBe("funded");
    expect(swap.at, "the first time stamp is kept").toBe(1000);
    updateActivity("swap:0xabc", { status: "executing" }, s);
    updateActivity("nope", { status: "x" }, s);
    expect(activityOf(s.journal())[0].status).toBe("executing");
    expect(activityOf(s.journal())).toHaveLength(2);
    deleteActivity("shield:0x1", s);
    expect(activityOf(s.journal()).map((r) => r.id)).toEqual(["swap:0xabc"]);
    s.lock();
    recordActivity({ id: "x", kind: "shield", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x" }, s); // no-op while locked
    expect(s.state().status).toBe("locked");
  });

  it("labels and finished states", () => {
    expect(activityStatusLabel({ kind: "swap", status: "committed" })).toBe("Pending");
    expect(activityStatusLabel({ kind: "swap", status: "executed" })).toBe("Executing");
    expect(activityStatusLabel({ kind: "swap", status: "refund-only" })).toBe("Refunding");
    expect(activityStatusLabel({ kind: "swap", status: "execute-failed" })).toBe("Needs attention");
    expect(activityStatusLabel({ kind: "swap", status: "abandoned" })).toBe("Abandoned");
    expect(activityStatusLabel({ kind: "shield", status: "completed" })).toBe("Completed");
    expect(isFinished({ kind: "swap", status: "executing" })).toBe(false);
    expect(isFinished({ kind: "swap", status: "refunded" })).toBe(true);
    expect(isFinished({ kind: "withdraw", status: "completed" })).toBe(true);
    expect(isFinished({ kind: "withdraw", status: "pending" })).toBe(false);
  });
});

describe("amount formatting from base units", () => {
  it("is exact at eight figures, truncates to the places, and never goes through a float", () => {
    expect(fmtUnits("123456789012345678901234", 18)).toBe("123456.789012");
    expect(fmtUnits(3_000_000n, 8)).toBe("0.030000");
    expect(fmtUnits(2_940_000n, 8)).toBe("0.029400");
    expect(fmtUnits(30_000_000n, 8)).toBe("0.300000");
    expect(fmtUnits(3_000_000n, 8, 8)).toBe("0.03000000");
    expect(fmtUnits("5", 0)).toBe("5");
    expect(fmtUnits(-1_500_000n, 6)).toBe("-1.500000");
    expect(fmtUnits("x", 6)).toBe("n/a");
    expect(fmtUnits(99_999_999_999_999_999_999n, 18, 2)).toBe("99.99"); // truncated, not rounded up
    expect(parseUnitsSafe("0.5", 18)).toBe(5n * 10n ** 17n);
    expect(parseUnitsSafe("1,5", 18)).toBe(0n);
    expect(parseUnitsSafe("", 8)).toBe(0n);
    expect(shortRef("0x" + "ab".repeat(32))).toBe("0xabababab…abab");
    expect(shortRef("short")).toBe("short");
  });
});
