// @vitest-environment happy-dom
// Private AI's funding wallet (audit round 2, n56): the connected wallet is the provider the connection chose — an EIP-6963
// wallet or WalletConnect — never window.ethereum by default; the fresh account is the seed's own.
import { afterEach, describe, expect, it } from "vitest";
import { setActiveProvider, type Eip1193Provider } from "@privacy-wallet/wallet-engine/injected";
import { creditWalletProvider } from "../src/zkapi/creditWallet";
import { deriveFundingKey, freshAccountProvider } from "../src/zkapi/freshAccountProvider";

const wallet = (name: string): Eip1193Provider => ({ request: async () => name }) as unknown as Eip1193Provider;

afterEach(() => {
  setActiveProvider(null);
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe("the credit's funding wallet", () => {
  it("connected: the provider the connection chose, not the injected one", () => {
    const injected = wallet("injected");
    const chosen = wallet("walletconnect");
    (window as unknown as { ethereum: unknown }).ethereum = injected;
    setActiveProvider(chosen);
    expect(
      creditWalletProvider("connected", () => {
        throw new Error("not asked");
      }),
    ).toBe(chosen);
  });

  it("fresh: the seed's own funding account", () => {
    const key = deriveFundingKey(new Uint8Array(32).fill(5), 0);
    const p = creditWalletProvider("fresh", () => freshAccountProvider(key.privateKey, "http://127.0.0.1:8545", 1));
    expect((p as { address?: string }).address).toBe(key.address);
  });
});
