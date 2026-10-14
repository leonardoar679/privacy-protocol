// @vitest-environment happy-dom
// Allowances (High-Value Protection spec §13, Stage 6): read and revoked through the injected wallet's own provider,
// never this wallet's RPC endpoints; the deployment's ERC-20 vaults listed under More → Wallet with a Revoke per
// non-zero allowance; the Protect screen (V6 Stage 10: its progress route) reads what a failed ERC-20 deposit left
// behind and offers to revoke it.
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { decodeFunctionData, encodeAbiParameters, getAddress } from "viem";
import { erc20Abi } from "@privacy-wallet/sdk/privacyProtocol";
import { allowancesFor, readAllowance, revokeAllowance } from "@privacy-wallet/sdk/allowances";
import { parseErc20Vaults } from "@privacy-wallet/sdk/assets";
import { Wallet } from "../src/features/more/Wallet";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ProtectScreen } from "../src/features/protect/ProtectScreen";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import type { Deployment } from "@privacy-wallet/sdk/chain";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  shieldERC20: async (o: any) => { o.onStatus?.("1/2 Approving…"); throw new Error("the deposit reverted after the approval"); },
}));

const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const USDC_VAULT = getAddress("0x00000000000000000000000000000000000ca5de");
const OWNER = getAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: getAddress("0x00000000000000000000000000000000000000e7"), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: parseErc20Vaults(`USDC:${USDC}:${USDC_VAULT}:6`) };
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); settings.reset(); delete (window as any).ethereum; connection.reset(); });
const button = (c: ParentNode, text: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

/** An injected provider: allowances by (token, owner, spender); approvals recorded. */
function provider(allowance: bigint) {
  const calls: { method: string; params: any[] }[] = [];
  let current = allowance;
  const eth = {
    calls,
    request: async ({ method, params }: { method: string; params?: any[] }) => {
      calls.push({ method, params: params ?? [] });
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [OWNER];
      if (method === "eth_call") {
        const d = decodeFunctionData({ abi: erc20Abi, data: params![0].data });
        if (d.functionName !== "allowance") throw new Error("unexpected call");
        return encodeAbiParameters([{ type: "uint256" }], [current]);
      }
      if (method === "eth_sendTransaction") {
        const d = decodeFunctionData({ abi: erc20Abi, data: params![0].data });
        if (d.functionName === "approve") current = (d.args as any)[1] as bigint;
        return "0x" + "ab".repeat(32);
      }
      throw new Error(`unsupported ${method}`);
    },
  };
  return eth;
}

describe("allowances through the injected wallet", () => {
  it("reads allowance(owner, spender) with eth_call and revokes with approve(spender, 0); without a provider the read is null", async () => {
    const eth = provider(250_000_000n);
    expect(await readAllowance(USDC, OWNER, USDC_VAULT, eth)).toBe(250_000_000n);
    const call = eth.calls.find((c) => c.method === "eth_call")!;
    expect(call.params[0].to).toBe(USDC);
    const d = decodeFunctionData({ abi: erc20Abi, data: call.params[0].data });
    expect(d.functionName).toBe("allowance");
    expect(String((d.args as any)[0]).toLowerCase()).toBe(OWNER.toLowerCase());
    expect(String((d.args as any)[1]).toLowerCase()).toBe(USDC_VAULT.toLowerCase());
    expect(await readAllowance(USDC, OWNER, USDC_VAULT, null)).toBeNull();
    (window as any).ethereum = eth;
    const tx = await revokeAllowance(USDC, USDC_VAULT);
    expect(tx).toBe("0x" + "ab".repeat(32));
    const sent = eth.calls.find((c) => c.method === "eth_sendTransaction")!;
    expect(sent.params[0].to).toBe(USDC);
    const a = decodeFunctionData({ abi: erc20Abi, data: sent.params[0].data });
    expect(a.functionName).toBe("approve");
    expect((a.args as any)[1]).toBe(0n);
    expect(await readAllowance(USDC, OWNER, USDC_VAULT, eth)).toBe(0n);
    const lines = await allowancesFor(deployment, OWNER, eth);
    expect(lines.map((l) => [l.asset.symbol, l.allowance])).toEqual([["USDC", 0n]]);
    // V6 (spec v2.0 §11.1): with ProtectRouter the router is a spender too — a protect approves it, not the vault
    const ROUTER = "0x00000000000000000000000000000000000000f7" as const;
    const routed = await allowancesFor({ ...deployment, protectRouter: ROUTER }, OWNER, eth);
    expect(routed.map((l) => [l.asset.symbol, l.via, l.spender])).toEqual([["USDC", "vault", USDC_VAULT], ["USDC", "router", ROUTER]]);
    expect(await allowancesFor({ ...deployment, erc20Vaults: [] }, OWNER, eth)).toEqual([]);
  });

  it("Settings → Advanced lists the connected wallet's allowances toward the vaults with a Revoke; the Shield screen reads what a failed deposit left and offers to revoke it", async () => {
    await session.create("pw"); session.acknowledgePhrase();
    const eth = provider(250_000_000n);
    (window as any).ethereum = eth;
    const container = document.createElement("div");
    await connection.connect(); // V5: the Wallet screen reads the account from the connection store (the injected fallback)
    await act(async () => { root = createRoot(container); root.render(<Wallet deployment={deployment} />); });
    await act(async () => { button(container, "Read allowances")!.click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="allowance-line"]')).toBeTruthy());
    const line = container.querySelector('[data-testid="allowance-line"]')!;
    expect(line.getAttribute("data-asset")).toBe("USDC");
    expect(line.textContent).toContain("250 USDC");
    await act(async () => { (line.querySelector('[data-testid="revoke-allowance"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="allowances"]')!.textContent).toContain("Revoked"));
    expect(eth.calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
    expect(eth.calls.every((c) => c.method !== "eth_getBalance")).toBe(true);
    // the Protect screen: the deposit failed after the approval → the leftover is read and can be revoked
    const eth2 = provider(100_000_000n);
    (window as any).ethereum = eth2;
    act(() => root!.unmount()); root = null;
    connection.reset(); // the Wallet part's provider is released: the Protect screen falls back to the injected one below
    const c2 = document.createElement("div");
    const router = createMemoryRouter([{ path: "/protect/*", element: <ProtectScreen masterSeed={session.state().seed!} deployment={deployment} account={OWNER} /> }], { initialEntries: ["/protect"], future: ROUTER_FUTURE });
    await act(async () => { root = createRoot(c2); root.render(<RouterProvider router={router} future={PROVIDER_FUTURE} />); });
    await act(async () => { (c2.querySelector('[data-testid="protect-from-asset"]') as HTMLElement).click(); }); // the asset selector (a sheet in the document's body)
    await vi.waitFor(() => expect(document.body.querySelector('[data-testid="protect-asset-selector-option"]')).toBeTruthy());
    const usdc = [...document.body.querySelectorAll('[data-testid="protect-asset-selector-option"]')].find((b) => b.textContent?.includes("USDC")) as HTMLButtonElement;
    await act(async () => { usdc.click(); });
    const amountInput = c2.querySelector('[data-testid="amount-input"]') as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(amountInput, "100"); amountInput.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { (c2.querySelector('[data-testid="protect-review"]') as HTMLButtonElement).click(); });
    // no price on chain 1: the fail-safe tier is high-value, so the Review holds
    const hold = c2.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement;
    expect(hold).toBeTruthy();
    await act(async () => { hold.dispatchEvent(new Event("pointerdown", { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
    await vi.waitFor(() => expect(c2.querySelector('[data-testid="leftover-allowance"]')).toBeTruthy());
    expect(c2.querySelector('[data-testid="leftover-allowance"]')!.textContent).toContain("An approval of 100 USDC for the vault remains");
    await act(async () => { (c2.querySelector('[data-testid="revoke-leftover"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(c2.textContent).toContain("Allowance revoked"));
    expect(c2.querySelector('[data-testid="leftover-allowance"]')!.textContent).toContain("No allowance is left");
  });
});
