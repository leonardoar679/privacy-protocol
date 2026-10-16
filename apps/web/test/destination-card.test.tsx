// @vitest-environment happy-dom
// Destinations on the screens (whale spec §21, §18): on Swap a typed address of another chain is refused by name and
// the action stays disabled; on Send (V6 Stage 10, spec v2.0 §7.4) the fresh address of this wallet is one tap away and
// the Review lints it, a Bitcoin address continues as a cross-chain send, the connected wallet's own address is flagged;
// Receive shows the card beside the QR, grouped in fours. No network: nothing here fetches.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getAddress } from "viem";
import { Swap } from "../src/features/swap/Swap";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SendScreen } from "../src/features/send/SendScreen";
import { Receive } from "../src/features/wallet/Receive";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { groupAddress } from "@privacy-wallet/protocol/wallet/destinations";
import type { Deployment } from "@privacy-wallet/sdk/chain";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// the relayer's terms (Send quotes with them): read from the engine, never fetched here
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  feeTerms: async () => ({ url: "http://relayer.test", info: { feePercentBps: 100 }, fee: { amount: 10n ** 15n, ownerCommitment: 0n, viewPub: new Uint8Array(32), vault: 0n } }),
}));
let fetches = 0;
beforeAll(() => { globalThis.fetch = (async () => { fetches++; return new Response("{}", { status: 404 }); }) as unknown as typeof fetch; });
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); settings.reset(); noteStore.clear(); });

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
    expect(container.querySelector('[data-testid="destination-error"]')!.textContent).toBe("This looks like a Ethereum address; the destination is Bitcoin.");
    expect(button(container, "Get a quote")!.disabled).toBe(true);
    await act(async () => { setValue(input, BTC); });
    expect(container.querySelector('[data-testid="destination-error"]')).toBeNull();
    expect(button(container, "Get a quote")!.disabled).toBe(false);
    await act(async () => { setValue(input, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv"); });
    expect(container.querySelector('[data-testid="destination-error"]')!.textContent, "said from its code (a V6 follow-up of 2026-10-16)").toBe("This is not a valid Bitcoin address.");
    expect(fetches).toBe(0);
  });

  it("Send (V6): the fresh address of this wallet is one tap away and the Review lints it; a Bitcoin address continues as a cross-chain send; the connected wallet's own address is flagged and, at the high-value tier, locked until the address book clears it", async () => {
    const account = EVM;
    let router: ReturnType<typeof createMemoryRouter> | null = null;
    const container = await mount(() => {
      router = createMemoryRouter([{ path: "/send/*", element: <SendScreen masterSeed={session.state().seed!} deployment={deployment} account={account} /> }], { initialEntries: ["/send"], future: ROUTER_FUTURE });
      return <Providers deployment={deployment}><RouterProvider router={router} future={PROVIDER_FUTURE} /></Providers>;
    });
    const fresh = peekFreshAddress(session.state().seed!, "evm").address;
    const by = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    await act(async () => { noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 3n * 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false }); });
    await act(async () => { setValue(by("amount-input") as HTMLInputElement, "1"); });
    await act(async () => { (container.querySelector('[data-testid="address-book-entry"]') as HTMLButtonElement).click(); }); // the fresh address of this wallet
    expect((by("address-input") as HTMLInputElement).value).toBe(fresh);
    await vi.waitFor(() => expect((by("send-review") as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { by("send-review").click(); });
    // no price on chain 1 → the fail-safe tier is high-value → the V2–V4 Review, with the lint (compact: what is not clear)
    const lint = by("privacy-lint");
    expect(lint.textContent).toContain("Privacy check");
    expect(lint.querySelectorAll('[data-item^="destination"]'), "the fresh address raises nothing").toHaveLength(0);
    expect(lint.querySelector('[data-item="network"]'), "a relayer, two endpoints, the light client (chain 1 has a spec): nothing to raise").toBeNull();
    await act(async () => { await router!.navigate("/send"); });
    const input = by("address-input") as HTMLInputElement;
    await act(async () => { setValue(input, BTC); });
    expect(by("address-checks").textContent).toContain("Bitcoin address");
    expect(by("send-kind").textContent).toBe("This continues as a cross-chain send to Bitcoin.");
    expect(by("send-review").textContent).toBe("Continue to the cross-chain send");
    expect((by("send-review") as HTMLButtonElement).disabled).toBe(false);
    // the connected wallet's own address: flagged; at high-value an entered address is offered only once the address book clears it (test/address-book.test.tsx)
    await act(async () => { setValue(input, account); });
    expect(by("send-destination-note").textContent).toBe("This is your connected wallet: sending to it links your protected balance to it publicly.");
    expect(by("destination-status").getAttribute("data-reason")).toBe("unknown");
    expect((by("send-review") as HTMLButtonElement).disabled).toBe(true);
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
