// @vitest-environment happy-dom
// Operation notifications in the app (spec v2.0 §12.5; doc §76; V6 Stage 15): every kind has its words in the catalog;
// no amount unless the user allowed amount previews; a transition while unlocked lands in the in-app list and shows as
// a toast once.
import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider } from "@privacy-wallet/ui";
import { NOTIFICATION_KINDS, type OperationNotification } from "@privacy-wallet/sdk/operations/notify";
import { newOperation, putOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { notifications, notify } from "@privacy-wallet/sdk/wallet/notifications";
import { setLocale } from "../src/app/i18n/messages";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { en } from "../src/app/i18n/en";
import { NotificationToasts, notificationWords, shownWords, startOperationNotifications } from "../src/app/notifications";

afterEach(() => {
  session.forget();
  resetOperationsMemory();
  notifications.clear();
});

const completed: OperationNotification = { kind: "completed", operationId: "op-1", operation: "swap" };

describe("operation notifications (doc §76)", () => {
  it("every kind has a title and a body in the catalog", () => {
    for (const k of NOTIFICATION_KINDS) {
      expect(en, k).toHaveProperty(`notification.${k}.title`);
      expect(en, k).toHaveProperty(`notification.${k}.body`);
    }
  });

  it("no amount by default; the amounts in front only when the user allowed them", () => {
    expect(notificationWords(completed)).toEqual({ title: "Completed", body: "Your transaction is complete." });
    const shown = notificationWords({
      ...completed,
      amounts: { input: { asset: "USDC", decimals: 6, value: "8000000000" }, output: { asset: "ETH", decimals: 18, value: "3100307000000000000" } },
    });
    expect(shown.body).toMatch(/^8,000 USDC → 3\.1\d* ETH\. Your transaction is complete\.$/);
  });

  it("in the reader's language: the system notification's app name and generic text, and a protected execution's alert (audit round 2, r57)", async () => {
    await loadCatalog("ko");
    setLocale("ko");
    try {
      await session.create("pw");
      session.acknowledgePhrase();
      const off = startOperationNotifications();
      const shown: [string, string][] = [];
      notify(
        {
          kind: "cancelled",
          title: "Protected swap cancelled",
          body: "The rest returned to your private balance.",
          campaignId: "c1",
          words: { key: "cancelled" },
        },
        { settings: { inApp: true, system: true, generic: true }, hidden: true, system: (title, body) => void shown.push([title, body]) },
      );
      expect(shown).toEqual([["프라이버시 지갑", "비공개 작업이 업데이트되었습니다"]]);
      expect(shownWords(notifications.all()[0])).toEqual({ title: "보호된 스왑이 취소되었습니다", body: "나머지는 비공개 잔액으로 돌아갔습니다." });
      // a route change names its provider; a pause keeps the runner's own reason
      expect(
        shownWords({
          id: "x",
          at: 0,
          kind: "route-changed",
          title: "Route changed",
          body: "The route changed to chainflip.",
          words: { key: "route-changed", vars: { provider: "chainflip" } },
        }).body,
      ).toBe("경로가 chainflip(으)로 바뀌었습니다.");
      expect(shownWords({ id: "y", at: 0, kind: "paused", title: "Protected swap paused", body: "the provider failed", words: { key: "paused" } })).toEqual({
        title: "보호된 스왑이 일시 중지되었습니다",
        body: "the provider failed",
      });
      off();
    } finally {
      setLocale("en");
    }
  });

  it("a lock clears the list, a forget too: the next wallet of this tab is never shown the last one's (audit round 2, n50)", async () => {
    const inApp = { settings: { inApp: true, system: false, generic: false }, hidden: false };
    await session.create("pw");
    session.acknowledgePhrase();
    notify({ kind: "info", title: "Completed", body: "8,000 USDC → 3.1 ETH. Your transaction is complete." }, inApp);
    expect(notifications.all()).toHaveLength(1);
    session.lock();
    expect(notifications.all(), "a lock").toEqual([]);
    expect(await session.unlock("pw")).toBe(true);
    notify({ kind: "info", title: "Completed", body: "8,000 USDC → 3.1 ETH. Your transaction is complete." }, inApp);
    session.forget();
    expect(notifications.all(), "a forget").toEqual([]);
    await session.create("another wallet");
    session.acknowledgePhrase();
    render(
      <ToastProvider>
        <NotificationToasts />
      </ToastProvider>,
    );
    expect(screen.queryByTestId("toast"), "nothing of the last wallet's toasted").toBeNull();
  });

  it("a transition while unlocked lands in the in-app list, without an amount, and shows once as a toast", async () => {
    await session.create("pw");
    session.acknowledgePhrase();
    const off = startOperationNotifications();
    const rec = newOperation({
      kind: "swap",
      amounts: { asset: "USDC", decimals: 6, input: "8000000000" },
      destination: { kind: "fresh", display: "Your protected balance", chain: "ethereum" },
      tier: "standard",
    });
    putOperation({ ...rec, state: "DESTINATION_CONFIRMING" });
    expect(notifications.all(), "an operation's first steps notify nothing").toHaveLength(0);
    putOperation({ ...rec, state: "COMPLETED" });
    expect(notifications.all().map((n) => [n.title, n.body, n.operationId, n.tone])).toEqual([
      ["Completed", "Your transaction is complete.", rec.id, "success"],
    ]);
    expect(JSON.stringify(notifications.all())).not.toMatch(/8000000000|8,000/);
    render(
      <ToastProvider>
        <NotificationToasts />
      </ToastProvider>,
    );
    expect((await screen.findByTestId("toast")).textContent).toContain("Your transaction is complete.");
    expect(notifications.unread()).toBe(0);
    act(() => void putOperation({ ...rec, state: "COMPLETED", updatedAt: Date.now() + 1 }));
    expect(screen.getAllByTestId("toast"), "the same state again shows nothing new").toHaveLength(1);
    off();
  });
});
