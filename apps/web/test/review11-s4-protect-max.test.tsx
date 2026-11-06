// @vitest-environment happy-dom
// The eleventh review round's critique of E11-13 (2026-11-05): Protect's Max of ETH leaves three times the live estimate, and the page had then
// refused Max's own amount whenever the estimate read next for that amount came out a few wei higher — a node prices the calldata by the byte
// (16 gas a non-zero byte, 4 a zero byte) and the deposit's calldata carries the note's net amount and two random fields, and the gas price
// moves a block later. The amount Max filled is accepted as filled until it is edited; an edited one is held to the live estimate again; a
// balance the reserve takes whole is said as such, never "Max leaves enough".
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { getAddress } from "viem";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { ProtectScreen } from "../src/features/protect/ProtectScreen";
import { prefs } from "../src/storage/prefs";
import { t } from "../src/app/i18n/messages";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";

const OWNER = getAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
const ROUTER = getAddress("0x00000000000000000000000000000000000000a1");
const deployment: Deployment = {
  chainId: 31337,
  core: getAddress("0x00000000000000000000000000000000000000c0"),
  ethVault: getAddress("0x00000000000000000000000000000000000000e7"),
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
  protectRouter: ROUTER,
};
beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  session.forget();
  settings.reset();
  prefs().reset();
  noteStore.clear();
  resetOperationsMemory();
  setActiveProvider(null);
});

/** intrinsic calldata cost as a node charges it (EIP-2028), plus a fixed execution */
const calldataGas = (data: string): bigint => {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  let g = 0n;
  for (let i = 0; i < hex.length; i += 2) g += hex.slice(i, i + 2) === "00" ? 4n : 16n;
  return g;
};
const BALANCE = 2_037_142_857_142_857_143n; // an arbitrary balance, as a wallet's is
function provider(o: { rising?: boolean; balance?: bigint; estimateHeld?: Promise<void> } = {}) {
  let price = 20n * 10n ** 9n;
  return {
    request: async ({ method, params }: { method: string; params?: { data?: string }[] }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [OWNER];
      if (method === "eth_getBalance") return "0x" + (o.balance ?? BALANCE).toString(16);
      if (method === "eth_estimateGas") {
        if (o.estimateHeld) await o.estimateHeld; // the node takes its time
        return "0x" + (21_000n + 90_000n + calldataGas(params?.[0]?.data ?? "0x")).toString(16);
      }
      if (method === "eth_gasPrice") {
        const p = price;
        if (o.rising) price += 10n ** 8n; // 0.1 gwei more a block
        return "0x" + p.toString(16);
      }
      throw new Error(`unsupported ${method}`);
    },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const type = (el: HTMLElement, v: string) => fireEvent.input(el, { target: { value: v } });
const input = () => screen.getByTestId("amount-input") as HTMLInputElement;

const withUsdc: Deployment = {
  ...deployment,
  erc20Vaults: [{ symbol: "USDC", decimals: 6, vault: getAddress("0x00000000000000000000000000000000000ca5de"), token: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") }],
};
async function page(o: { rising?: boolean; balance?: bigint; estimateHeld?: Promise<void>; usdc?: boolean } = {}) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  setActiveProvider(provider(o) as never);
  const router = createMemoryRouter(
    [{ path: "/protect/*", element: <ProtectScreen masterSeed={session.state().seed!} deployment={o.usdc ? withUsdc : deployment} account={OWNER} /> }],
    { initialEntries: ["/protect"], future: ROUTER_FUTURE },
  );
  render(<RouterProvider router={router} future={PROVIDER_FUTURE} />);
  // the Max button, which comes with the balance (the second critique: the account's address chip had matched a digit before the balance)
  await screen.findByTestId("protect-max");
}
async function max(before: string) {
  fireEvent.click(screen.getByTestId("protect-max"));
  await waitFor(() => expect(input().value).not.toBe(before));
  await sleep(900); // the page's estimate for Max's amount (250 ms after it changed)
}

describe("Protect's Max of ETH against its own reserve (the eleventh review round's critique of E11-13)", () => {
  it("an amount typed first, then Max: Max's amount is accepted — never refused by the estimate read next for it", async () => {
    for (let run = 0; run < 3; run++) {
      await page();
      type(input(), "1.5");
      await sleep(700); // the estimate for the typed amount
      await max("1.5");
      expect(screen.queryByTestId("protect-error"), `run ${run}: ${screen.queryByTestId("protect-error")?.textContent}`).toBeNull();
      expect((screen.getByTestId("protect-review") as HTMLButtonElement).disabled).toBe(false);
      cleanup();
      session.forget();
      setActiveProvider(null);
    }
  }, 60_000);

  it("Max while the gas price rises between two reads: accepted as filled", async () => {
    await page({ rising: true });
    await max("");
    expect(screen.queryByTestId("protect-error")).toBeNull();
  }, 30_000);

  it("Max's amount edited: held to the live estimate again — an amount that leaves too little is refused, saying Max leaves enough", async () => {
    await page();
    await max("");
    const filled = input().value;
    // the same amount and a little more: it leaves less than the reserve now
    type(input(), (Number(filled) + 0.0001).toFixed(18).replace(/0+$/, ""));
    await sleep(700);
    expect(screen.getByTestId("protect-error").textContent).toBe(t("screen.protect.insufficientFee", { symbol: "ETH" }));
  }, 30_000);

  it("an amount typed while Max reads its estimate wins over the Max (the second critique: the guard had no test)", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page({ estimateHeld: held });
    fireEvent.click(screen.getByTestId("protect-max")); // no amount yet: Max reads an estimate for the whole balance
    type(input(), "0.5");
    await sleep(50);
    release();
    await sleep(900);
    expect(input().value, "the typed amount stands").toBe("0.5");
  }, 30_000);

  it("another asset chosen while Max reads its estimate wins over the Max: the new asset's field stays empty (the third critique)", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page({ estimateHeld: held, usdc: true });
    fireEvent.click(screen.getByTestId("protect-max")); // no amount yet: Max reads an estimate for the whole ETH balance
    fireEvent.click(screen.getByTestId("protect-from-asset"));
    const usdc = (await screen.findAllByTestId("protect-asset-selector-option")).find((b) => b.textContent?.includes("USDC"))!;
    fireEvent.click(usdc);
    release();
    await sleep(900);
    expect(input().value, "never the ETH figure in the USDC field").toBe("");
  }, 30_000);

  it("a balance the reserve takes whole: Max fills it and the page says this ETH does not cover a deposit and its fee — never 'Max leaves enough'", async () => {
    await page({ balance: 5n * 10n ** 15n }); // 0.005 ETH; the deposit's estimate is about 0.0025 ETH, its reserve three times that
    await sleep(300);
    type(input(), "0.001");
    await sleep(700);
    await max("0.001");
    expect(input().value).toBe("0.005");
    expect(screen.getByTestId("protect-error").textContent).toBe(t("screen.protect.cannotCoverFee", { symbol: "ETH" }));
    expect(screen.getByTestId("protect-error").textContent).not.toContain("Max leaves enough");
  }, 30_000);
});
