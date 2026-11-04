// The ninth review round (2026-11-04, C-03/C-07): a finished swap that is not the order's whole delivery is said so — a partial fill,
// a refund the provider paid at the destination — in the record's words, Activity's status and the notification, in English and in
// Korean; the one-at-a-time words say how long the wallet takes to settle (C-11, C-12).
import { afterEach, describe, expect, it } from "vitest";
import type { OperationNotification } from "@privacy-wallet/sdk/operations/notify";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { notificationWords } from "../src/app/notifications";
import { finishedWords, recordWords } from "../src/features/operations/recovery";
import { statusOf } from "../src/features/amounts";
import { t, setLocale } from "../src/app/i18n/messages";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { en } from "../src/app/i18n/en";

afterEach(() => setLocale("en"));

const rec = (o: Partial<OperationRecord>): OperationRecord =>
  ({
    v: 3,
    id: "swap:0x01",
    kind: "cross-chain",
    state: "COMPLETED",
    createdAt: 0,
    updatedAt: 0,
    amounts: { asset: "ETH", decimals: 18, input: "1" },
    fees: [],
    destination: { kind: "fresh", display: "So1", chain: "solana" },
    refs: { txHashes: [] },
    tier: "standard",
    history: [],
    ...o,
  }) as OperationRecord;

describe("a finished swap's outcome", () => {
  it("the record's words and Activity's status: delivered in part, refunded at the destination — never a bare 'Completed' for them", () => {
    expect(finishedWords(rec({}), t)).toBe("Completed");
    expect(finishedWords(rec({ outcome: "partial" }), t)).toBe("Delivered in part");
    expect(recordWords(rec({ outcome: "refunded-at-destination" }), t)).toBe("Refunded at destination");
    // the outcome's own chip (the tenth review round, A10-4): "Completed" and "Returned" had said more than the record knows
    expect(statusOf(rec({ outcome: "refunded-at-destination" }))).toBe("refunded-at-destination");
    expect(statusOf(rec({ outcome: "partial" }))).toBe("partial");
    expect(statusOf(rec({ outcome: "partial-unreturned" }))).toBe("partial");
    expect(statusOf(rec({ outcome: "other-token" }))).toBe("other-token");
    expect(statusOf(rec({}))).toBe("completed");
  });

  it("the notification: its own words, a warning for a refund at the destination", () => {
    const n = (outcome?: OperationNotification["outcome"]): OperationNotification => ({ kind: "completed", operationId: "op", operation: "cross-chain", ...(outcome ? { outcome } : {}) });
    expect(notificationWords(n()).title).toBe("Completed");
    expect(notificationWords(n("partial"))).toEqual({ title: en["notification.partial.title"], body: en["notification.partial.body"] });
    expect(notificationWords(n("refunded-at-destination")).title).toBe("Not delivered");
    expect(notificationWords(n("refunded-at-destination")).body).not.toMatch(/complete/i);
  });

  it("in Korean", async () => {
    await loadCatalog("ko");
    setLocale("ko");
    expect(finishedWords(rec({ outcome: "partial" }), t)).toBe("일부만 전달됨");
    expect(finishedWords(rec({ outcome: "refunded-at-destination" }), t)).toBe("목적지에서 환불됨");
    expect(t("screen.swap.notDelivered", { symbol: "SOL" })).toContain("SOL");
  });

  it("the one-at-a-time words say an hour, or a day without the relayer — never 'within minutes' (C-12)", () => {
    expect(en["screen.review.blocker.oneAtATime"]).toMatch(/within an hour, or a day when its relayer cannot be reached/);
    expect(en["screen.review.blocker.oneAtATime"]).not.toMatch(/within minutes/);
  });
});
