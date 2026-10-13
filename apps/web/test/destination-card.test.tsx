// @vitest-environment happy-dom
// Destinations on the screens (whale spec §21, §18): a typed address of another chain is refused by name
// and the action stays disabled; a valid one shows the card grouped in fours; the privacy lint lists its
// items under a public Send (V5: the Send screen's public path); Receive shows the card beside the QR. No network: nothing here fetches.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getAddress } from "viem";
import { Swap } from "../src/features/swap/Swap";
import { Send } from "../src/features/send/Send";
import { Receive } from "../src/features/wallet/Receive";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";
import { peekFreshAddress } from "../src/keys/chainKeys";
import { groupAddress } from "@privacy-wallet/protocol/wallet/destinations";
import type { Deployment } from "../src/sdk/chain";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let fetches = 0;
beforeAll(() => { globalThis.fetch = (async () => { fetches++; return new Response("{}", { status: 404 }); }) as unknown as typeof fetch; });
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); settings.reset(); });

const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: getAddress("0x00000000000000000000000000000000000000e7"), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1", "http://127.0.0.1:2"], fromBlock: 0n, erc20Vaults: [], swapFactory: getAddress("0x00000000000000000000000000000000000000f1") };
const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
const button = (c: HTMLElement, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const EVM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

async function mount(el: () => React.ReactElement) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  const container = document.createElement("div");
  await act(async () => { root = createRoot(container); root.render(el()); });
  return container;
}

describe("destinations on the screens", () => {
  it("Swap: an Ethereum address pasted as a Bitcoin destination is refused by name and the quote button stays disabled; a Bitcoin address passes", async () => {
    const container = await mount(() => <Swap masterSeed={session.state().seed!} deployment={deployment} />);
    await act(async () => { setValue(container.querySelector('[data-testid="swap-amount-input"]') as HTMLInputElement, "0.5"); }); // V5: no amount is pre-filled
    const input = container.querySelector('input[placeholder="fresh address"]') as HTMLInputElement;
    expect(input.value).toBe(peekFreshAddress(session.state().seed!, "bitcoin").address);
    await act(async () => { setValue(input, EVM); });
    expect(container.querySelector('[data-testid="destination-error"]')!.textContent).toContain("this looks like a Ethereum address; the destination is Bitcoin");
    expect(button(container, "Get a quote")!.disabled).toBe(true);
    await act(async () => { setValue(input, BTC); });
    expect(container.querySelector('[data-testid="destination-error"]')).toBeNull();
    expect(button(container, "Get a quote")!.disabled).toBe(false);
    await act(async () => { setValue(input, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv"); });
    expect(container.querySelector('[data-testid="destination-error"]')!.textContent).toContain("checksum");
    expect(fetches).toBe(0);
  });

  it("Send to a public address: the fresh recipient shows the card grouped in fours and the lint; a Bitcoin address is refused as such; the connected wallet's own address blocks until acknowledged at the high-value tier", async () => {
    const account = EVM;
    const container = await mount(() => <Send masterSeed={session.state().seed!} deployment={deployment} account={account} initialMode="public" />);
    const fresh = peekFreshAddress(session.state().seed!, "evm").address;
    await act(async () => { setValue(container.querySelector('[data-testid="send-amount-input"]') as HTMLInputElement, "1"); }); // the lint and the card's amount follow the amount
    expect(container.querySelector('[data-testid="destination-grouped"]')!.textContent).toBe(groupAddress(fresh));
    expect(container.querySelector('[data-testid="destination-card"]')!.textContent).toContain("A fresh address of this wallet, used once.");
    const lint = container.querySelector('[data-testid="privacy-lint"]')!;
    expect(lint.textContent).toContain("Destination linkage");
    expect(lint.querySelector('[data-item="destination-fresh"]')!.getAttribute("data-level")).toBe("ok");
    expect(lint.querySelector('[data-item="network"]')!.getAttribute("data-level")).toBe("ok"); // a relayer, two endpoints, the light client (chain 1 has a spec)
    const input = container.querySelector('input[placeholder^="0x"]') as HTMLInputElement;
    await act(async () => { setValue(input, BTC); });
    expect(container.querySelector('[data-testid="destination-error"]')!.textContent).toContain("this looks like a Bitcoin address; the destination is Ethereum");
    // no price on chain 1 → the fail-safe tier is high-value → the button opens the Review (whale spec §24)
    expect(button(container, "Review")!.disabled).toBe(true);
    // the connected wallet's own address: a block that clears with an acknowledgement
    await act(async () => { setValue(input, account); });
    expect(container.querySelector('[data-testid="destination-error"]')).toBeNull();
    const item = container.querySelector('[data-item="destination-not-public-wallet"]')!;
    expect(item.getAttribute("data-level")).toBe("block");
    expect(button(container, "Review")!.disabled).toBe(true);
    await act(async () => { button(container, "I understand")!.click(); });
    expect(container.querySelector('[data-item="destination-not-public-wallet"]')!.textContent).toContain("(acknowledged)");
    // V3 (High-Value Protection spec §12): an entered address at high-value is offered only once it is in the address book, verified and out of its cooling-off (test/address-book.test.tsx)
    expect(button(container, "Review")!.disabled).toBe(true);
    expect(container.querySelector('[data-testid="destination-status"]')!.getAttribute("data-reason")).toBe("unknown");
    expect(fetches).toBe(0);
  });

  it("Receive: the card beside the QR, grouped, for the privacy address and for a fresh chain address", async () => {
    const container = await mount(() => <Receive masterSeed={session.state().seed!} />);
    expect(container.querySelector('[data-testid="destination-card"]')!.textContent).toContain("Private pool");
    await act(async () => { (container.querySelector('[data-testid="receive-bitcoin"]') as HTMLButtonElement).click(); });
    await act(async () => { button(container, "Generate a private receiving address")!.click(); }); // the first Bitcoin address of this wallet
    const addr = container.querySelector("code")!.textContent!;
    expect(addr.startsWith("bc1q")).toBe(true);
    expect(container.querySelector('[data-testid="destination-grouped"]')!.textContent).toBe(groupAddress(addr));
    expect(container.querySelector("svg")).toBeTruthy();
    expect(fetches).toBe(0);
  });
});
