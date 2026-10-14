// @vitest-environment happy-dom
// Operation notifications in the app (spec v2.0 §12.5; doc §76; V6 Stage 15): every kind has its words in the catalog;
// no amount unless the user allowed amount previews; a transition while unlocked lands in the in-app list and shows as
// a toast once.
import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider } from "@privacy-wallet/ui";
import { NOTIFICATION_KINDS, type OperationNotification } from "@privacy-wallet/sdk/operations/notify";
import { newOperation, putOperation, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { notifications } from "@privacy-wallet/sdk/wallet/notifications";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { en } from "../src/app/i18n/en";
import { NotificationToasts, notificationWords, startOperationNotifications } from "../src/app/notifications";

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
    putOperation({ ...rec, state: "SETTLING" });
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
