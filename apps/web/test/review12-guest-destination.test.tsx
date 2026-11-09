// @vitest-environment happy-dom
// The twelfth review round, 2026-11-06. F12-8: the walletless screen's destination check refuses a registry token's own contract, as the swap
// screens do — a guest choosing USDC on Ethereum who pasted the USDC contract's address had been quoted, and THORChain paid the USDC to its own
// contract, lost: the refusal is the browser's, before any quote. F12-5: an instruction into a chain THORChain has halted is not shown, in its
// own words (ZE's critique: the gateways' sentence had named two causes that were not so, and "a moment" for a halt that can last hours).
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getAddress } from "viem";
import { Guest } from "../src/components/Guest";
import { buildMemo } from "@privacy-wallet/swap-engine/adapters/thorchain";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const VAULT = "bc1qvaultvaultvaultvaultvaultvaultvaultvau1t";
const DEST = getAddress("0x4e41cd3b4b0d4ec1b0c1db5e1c9f0a7d0b5c1e2f");
const LIMIT = 30_000_000n;
const calls: string[] = [];
/** the service and THORChain's gateways: none answer unless a test says so */
let ethHalted: boolean | null = null;
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const thorQuote = { provider: "thorchain", category: "E", toAmount: (LIMIT * 10n ** 10n + 10n ** 15n).toString(), toAmountMin: (LIMIT * 10n ** 10n).toString(), etaSeconds: 1200, expiresAt: 0, nativeAssets: true, minOutEncoded: true, minOutVerified: true, fees: [], hops: [], obtainedAt: 0 };
beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    if (ethHalted === null) return json({ error: "not served here" }, 404);
    if (u.pathname.endsWith("/thorchain/inbound_addresses"))
      return json([{ chain: "BTC", address: VAULT, router: "", halted: false }, { chain: "ETH", address: "0x755e7849e47cbbfaf0efe8c76a2def21dd4a85bb", router: "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146", halted: ethHalted }]);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.pathname === "/v1/guest/quote") return json({ quotes: [thorQuote], scores: [], errors: {}, chosen: undefined });
    if (u.pathname === "/v1/guest/ingress")
      return json({ provider: "thorchain", quote: thorQuote, ingress: { to: VAULT, memo: buildMemo("ETH.ETH", body.destination, LIMIT), amount: body.amount, expiresAt: Math.floor(Date.now() / 1000) + 900, verified: [] }, status: "Pending" });
    return json({ error: `unexpected ${u.pathname}` }, 404);
  }) as unknown as typeof fetch;
});
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  ethHalted = null;
  calls.length = 0;
});
const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const button = (c: HTMLElement, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const typed = async (address: string) => {
  const container = document.createElement("div");
  await act(async () => {
    root = createRoot(container);
    root.render(<Guest onBack={() => {}} />);
  });
  await act(async () => setValue(container.querySelector('input[placeholder="0x…"]') as HTMLInputElement, address));
  return { container, quote: button(container, "Get a quote")! };
};

describe("F12-8: the guest's destination is never a token's own contract", () => {
  it("the USDC contract is refused before any quote: its button disabled, a press asks nothing of the service", async () => {
    const { container, quote } = await typed(getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"));
    expect(container.querySelector('[data-testid="destination-error"]')?.textContent).toMatch(/Destination: /);
    expect(quote.disabled).toBe(true);
    await act(async () => quote.click());
    expect(calls.filter((c) => c.startsWith("/v1/guest/")), "nothing asked of the service").toEqual([]);
  });

  it("a plain address is taken: no error, the button enabled", async () => {
    const { container, quote } = await typed(DEST);
    expect(container.querySelector('[data-testid="destination-error"]')).toBeNull();
    expect(quote.disabled).toBe(false);
  });
});

describe("F12-5: an instruction into a halted chain, in its own words", () => {
  it("Ethereum halted on THORChain: nothing shown, the guest told the swap would come back less its fee — never that the gateways disagree", async () => {
    ethHalted = true;
    const { container, quote } = await typed(DEST);
    await act(async () => quote.click());
    await vi.waitFor(() => expect(button(container, "Show my deposit instruction")).toBeTruthy());
    await act(async () => button(container, "Show my deposit instruction")!.click());
    await vi.waitFor(() => expect(container.textContent).toMatch(/THORChain has paused swaps into Ethereum right now: a swap sent now would come back to the address you send from, less its fee\. Nothing is shown; try again later\./));
    expect(container.textContent).not.toMatch(/too few of its public gateways agree|paused deposits of this coin/);
    expect(container.textContent).not.toContain(VAULT);
  });

  it("Ethereum open: the instruction is shown, as before", async () => {
    ethHalted = false;
    const { container, quote } = await typed(DEST);
    await act(async () => quote.click());
    await vi.waitFor(() => expect(button(container, "Show my deposit instruction")).toBeTruthy());
    await act(async () => button(container, "Show my deposit instruction")!.click());
    await vi.waitFor(() => expect(container.querySelector('[data-testid="guest-checked"]')).toBeTruthy());
  });
});
