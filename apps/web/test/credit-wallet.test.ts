// @vitest-environment happy-dom
// Private AI's funding wallet (audit round 2, n56): the connected wallet is the provider the connection chose — an EIP-6963
// wallet or WalletConnect — never window.ethereum by default; the fresh account is the seed's own.
import { afterEach, describe, expect, it } from "vitest";
import { setActiveProvider, type Eip1193Provider } from "@privacy-wallet/wallet-engine/injected";
import { creditWalletProvider, fundingChainOk } from "../src/zkapi/creditWallet";
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

  it("the pool funds a credit on its own chain only (audit round 2, p03)", () => {
    expect(fundingChainOk(1, { trusted_deployment: { chain_id: 11155111 } }), "a mainnet pool, a Sepolia credit").toBe(false);
    expect(fundingChainOk(11155111, { trusted_deployment: { chain_id: "11155111" } })).toBe(true);
    expect(fundingChainOk(1, null), "no deployment read").toBe(false);
  });

  it("fresh: the seed's own funding account", () => {
    const key = deriveFundingKey(new Uint8Array(32).fill(5), 0);
    const p = creditWalletProvider("fresh", () => freshAccountProvider(key.privateKey, "http://127.0.0.1:8545", 1));
    expect((p as { address?: string }).address).toBe(key.address);
  });
});
