// @vitest-environment happy-dom
// The walletless screen, clicked through: quote → "Show my deposit instruction". The browser checks the
// instruction against three THORNode gateways and the guest's own inputs before showing an address: an
// honest one is shown with what was checked; one naming another address is not shown at all; one with a
// lower minimum is shown only after the guest accepts that minimum. The service is a fetch mock whose
// memos come from the swap service's own builder.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getAddress } from "viem";
import { Guest } from "../src/components/Guest";
import { buildMemo } from "../../../packages/swap-engine/src/adapters/thorchain";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const VAULT = "bc1qvaultvaultvaultvaultvaultvaultvaultvau1t";
const DEST = getAddress("0x4e41cd3b4b0d4ec1b0c1db5e1c9f0a7d0b5c1e2f"); // EIP-55: a mixed-case address must carry its checksum (whale spec §21)
const LIMIT = 30_000_000n; // 0.3 ETH in 1e8 units
let bent: { to?: string; limit?: bigint } = {};
const calls: string[] = [];
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const thorQuote = { provider: "thorchain", category: "E", toAmount: (LIMIT * 10n ** 10n + 10n ** 15n).toString(), toAmountMin: (LIMIT * 10n ** 10n).toString(), etaSeconds: 1200, expiresAt: 0, nativeAssets: true, minOutEncoded: true, hops: [] };

beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    if (u.pathname.endsWith("/thorchain/inbound_addresses")) return json([{ chain: "BTC", address: VAULT, router: "", halted: false }]);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.pathname === "/guest/quote") return json({ quotes: [thorQuote], scores: [], errors: {}, chosen: undefined });
    if (u.pathname === "/guest/ingress") {
      const memo = buildMemo("ETH.ETH", body.destination, bent.limit ?? LIMIT);
      return json({ provider: "thorchain", quote: thorQuote, ingress: { to: bent.to ?? VAULT, memo, amount: body.amount, expiresAt: Math.floor(Date.now() / 1000) + 900, verified: ["the service says so"] }, status: "Pending" });
    }
    return json({ error: `unexpected ${u.pathname}` }, 404);
  }) as unknown as typeof fetch;
});
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } bent = {}; calls.length = 0; });

const button = (c: HTMLElement, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };

async function quoted(container: HTMLElement) {
  await act(async () => { root = createRoot(container); root.render(<Guest onBack={() => {}} />); });
  const dest = container.querySelector('input[placeholder="0x…"]') as HTMLInputElement;
  await act(async () => { setValue(dest, DEST); });
  await act(async () => { button(container, "Get a quote")!.click(); });
  await vi.waitFor(() => expect(button(container, "Show my deposit instruction")).toBeTruthy());
  expect(container.textContent, "the quote shown is THORChain's, the route the instruction will use").toContain("0.300000 ETH");
}

describe("walletless deposit instruction, checked in the browser (happy-dom)", () => {
  it("an honest instruction is shown with what was checked", async () => {
    const container = document.createElement("div");
    await quoted(container);
    await act(async () => { button(container, "Show my deposit instruction")!.click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="guest-checked"]')).toBeTruthy());
    expect(container.textContent).toContain(VAULT);
    expect(container.querySelector('[data-testid="guest-checked"]')!.textContent).toContain("3 public gateways agree");
    expect(container.textContent).not.toContain("the service says so"); // the service's own claims are not what is shown
    expect(calls.filter((c) => c.endsWith("/thorchain/inbound_addresses")).length).toBe(3);
  });
  it("an instruction naming another address is never shown", async () => {
    const container = document.createElement("div");
    await quoted(container);
    bent = { to: "bc1qattackerattackerattackerattackerattack" };
    await act(async () => { button(container, "Show my deposit instruction")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toMatch(/deposit instruction does not match what you asked for \(vault/));
    expect(container.textContent).not.toContain("bc1qattacker");
    expect(container.querySelector("svg"), "no QR code").toBeNull();
  });
  it("a lower minimum is shown for consent first; the accepted instruction is then displayed", async () => {
    const container = document.createElement("div");
    await quoted(container);
    bent = { limit: LIMIT - 600_000n };
    await act(async () => { button(container, "Show my deposit instruction")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("The price moved"));
    expect(container.textContent).not.toContain(VAULT);
    await act(async () => { button(container, "Show the instruction at the new minimum")!.click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="guest-checked"]')).toBeTruthy());
    expect(container.querySelector('[data-testid="guest-checked"]')!.textContent).toContain("at least 0.294000 ETH");
  });
});
