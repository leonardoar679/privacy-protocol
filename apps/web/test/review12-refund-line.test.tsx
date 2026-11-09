// @vitest-environment happy-dom
// The twelfth review round, slice 12a (XN's critique): the swap screen's refund line ("Refunded on chain; …") follows the tracker's reading, never a
// relayer's "refunded" alone — beside a kept "refunded" over an escrow that still holds the whole order (inside its window, and DROPPED past it) it had
// said the order was refunded while the card said nothing was swapped. The reviewer's probe (scratchpad review12/XN3) became these cases.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Swap } from "../src/features/swap/Swap";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { deployment, ETH_VAULT, fetchMock, jobs, resetWorld, world } from "./helpers/swapWorld";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const refundHook = vi.hoisted(() => ({ calls: 0, result: [] as unknown[] }));
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  recoverSwapRefunds: async () => {
    refundHook.calls++;
    return refundHook.result;
  },
}));
beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  session.forget();
  resetWorld();
  refundHook.calls = 0;
});
const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const button = (c: HTMLElement, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
async function mount(container: HTMLElement) {
  if (root) act(() => root!.unmount());
  await act(async () => {
    root = createRoot(container);
    root.render(<Swap masterSeed={session.state().seed!} deployment={deployment} />);
  });
}
const NOTE_SECRET = 0x1d4c9a7be2f05836c71e9a2b4d6f8031a5c7e9b2d4f60817394a6c8e0b2d4f6n;
/** an order committed through the screen, then funded and handed over in the journal */
async function committedAndFunded(container: HTMLElement) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: NOTE_SECRET }, leafIndex: 0, noteData: "0x", spent: false });
  await priceStore.refresh(deployment);
  await mount(container);
  await act(async () => {
    setValue(container.querySelector('[data-testid="swap-amount-input"]') as HTMLInputElement, "0.5");
  });
  await act(async () => {
    button(container, "Get a quote")!.click();
  });
  await vi.waitFor(() => expect(button(container, "Review Swap")).toBeTruthy());
  await act(async () => {
    button(container, "Review Swap")!.click();
  });
  await vi.waitFor(() => expect(container.querySelector('[data-testid="confirm-tap"]')).toBeTruthy());
  await act(async () => {
    (container.querySelector('[data-testid="confirm-tap"]') as HTMLButtonElement).click();
  });
  await vi.waitFor(() => expect(session.journal().swaps).toHaveLength(1));
  session.update((j) => {
    j.swaps[0].fundedTx = "0x" + "11".repeat(32);
    j.swaps[0].state = "funded";
    j.swaps[0].jobId = j.swaps[0].orderId;
  });
  return session.journal().swaps[0];
}
const settled = (c: HTMLElement) => c.querySelector('[data-testid="settlement"]')?.getAttribute("data-state");

describe("the refund line follows the tracker's reading (the twelfth review round, XN)", () => {
  it("a relayer's 'refunded' over an escrow that still holds the order: no 'Refunded on chain', inside its window and past it (DROPPED)", async () => {
    for (const past of [false, true]) {
      const container = document.createElement("div");
      const s = await committedAndFunded(container);
      if (past) {
        session.update((j) => {
          (j.swaps[0].params as { executeDeadline: number }).executeDeadline = Math.floor(Date.now() / 1000) - 3600;
        });
      }
      jobs.set(s.orderId.toLowerCase(), "refunded"); // the relayer's kept word
      world.escrowBalance = BigInt((s.params as { amount: string }).amount); // the escrow still holds the whole order
      await mount(container);
      await act(async () => {
        button(container, "Open")!.click();
      });
      await vi.waitFor(() => expect(settled(container)).toBeTruthy(), { timeout: 20_000 });
      if (past) await vi.waitFor(() => expect(settled(container)).toBe("DROPPED"), { timeout: 20_000 });
      expect(settled(container)).not.toBe("REFUNDED");
      expect(container.querySelector('[data-testid="refund-line"]'), past ? "dropped" : "inside its window").toBeNull();
      expect(refundHook.calls, "no refund looked for").toBe(0);
      act(() => root!.unmount());
      root = null;
      session.forget();
      resetWorld();
    }
  });

  it("a relayer's 'refunded' over an escrow read empty: the refund looked for, the line said", async () => {
    const container = document.createElement("div");
    const s = await committedAndFunded(container);
    session.update((j) => {
      (j.swaps[0].params as { executeDeadline: number }).executeDeadline = Math.floor(Date.now() / 1000) - 3600;
    });
    jobs.set(s.orderId.toLowerCase(), "refunded");
    world.escrowBalance = 0n;
    await mount(container);
    await act(async () => {
      button(container, "Open")!.click();
    });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="refund-line"]')).toBeTruthy(), { timeout: 20_000 });
    expect(refundHook.calls).toBeGreaterThan(0);
  });
});
