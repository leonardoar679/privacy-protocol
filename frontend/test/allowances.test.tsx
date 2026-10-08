// @vitest-environment happy-dom
// Allowances (High-Value Protection spec §13, Stage 6): read and revoked through the injected wallet's own provider,
// never this wallet's RPC endpoints; the deployment's ERC-20 vaults listed under Settings → Advanced with a Revoke per
// non-zero allowance; the Shield screen reads what a failed ERC-20 deposit left behind and offers to revoke it.
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { decodeFunctionData, encodeAbiParameters, getAddress } from "viem";
import { erc20Abi } from "../src/sdk/privacyProtocol";
import { allowancesFor, readAllowance, revokeAllowance } from "../src/sdk/allowances";
import { parseErc20Vaults } from "../src/sdk/assets";
import { Settings } from "../src/components/Settings";
import { Shield } from "../src/components/Shield";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";
import type { Deployment } from "../src/sdk/chain";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../src/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sdk/privateTx")>()),
  shieldERC20: async (o: any) => { o.onStatus?.("1/2 Approving…"); throw new Error("the deposit reverted after the approval"); },
}));

const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const USDC_VAULT = getAddress("0x00000000000000000000000000000000000ca5de");
const OWNER = getAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: getAddress("0x00000000000000000000000000000000000000e7"), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: parseErc20Vaults(`USDC:${USDC}:${USDC_VAULT}:6`) };
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); settings.reset(); delete (window as any).ethereum; });
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
    expect(await allowancesFor({ ...deployment, erc20Vaults: [] }, OWNER, eth)).toEqual([]);
  });

  it("Settings → Advanced lists the connected wallet's allowances toward the vaults with a Revoke; the Shield screen reads what a failed deposit left and offers to revoke it", async () => {
    await session.create("pw"); session.acknowledgePhrase();
    const eth = provider(250_000_000n);
    (window as any).ethereum = eth;
    const container = document.createElement("div");
    await act(async () => { root = createRoot(container); root.render(<Settings deployment={deployment} readsLine="" coreLine="" account={OWNER} />); });
    await act(async () => { button(container, "Read allowances")!.click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="allowance-line"]')).toBeTruthy());
    const line = container.querySelector('[data-testid="allowance-line"]')!;
    expect(line.getAttribute("data-asset")).toBe("USDC");
    expect(line.textContent).toContain("250 USDC");
    await act(async () => { (line.querySelector('[data-testid="revoke-allowance"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="allowances"]')!.textContent).toContain("Revoked"));
    expect(eth.calls.filter((c) => c.method === "eth_sendTransaction")).toHaveLength(1);
    expect(eth.calls.every((c) => c.method !== "eth_getBalance")).toBe(true);
    // the Shield screen: the deposit failed after the approval → the leftover is read and can be revoked
    const eth2 = provider(100_000_000n);
    (window as any).ethereum = eth2;
    act(() => root!.unmount()); root = null;
    const c2 = document.createElement("div");
    await act(async () => { root = createRoot(c2); root.render(<Shield masterSeed={session.state().seed!} deployment={deployment} />); });
    const select = c2.querySelector("select") as HTMLSelectElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, USDC_VAULT); select.dispatchEvent(new Event("change", { bubbles: true })); }); // the selector keys assets by vault
    await act(async () => { button(c2, "Shield")!.click(); });
    await vi.waitFor(() => expect(c2.querySelector('[data-testid="leftover-allowance"]')).toBeTruthy());
    expect(c2.querySelector('[data-testid="leftover-allowance"]')!.textContent).toContain("An approval of 100 USDC for the vault remains");
    await act(async () => { (c2.querySelector('[data-testid="revoke-leftover"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(c2.textContent).toContain("Allowance revoked"));
    expect(c2.querySelector('[data-testid="leftover-allowance"]')!.textContent).toContain("No allowance is left");
  });
});
