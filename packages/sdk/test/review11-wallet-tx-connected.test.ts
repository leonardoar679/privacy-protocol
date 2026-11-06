// walletTxStatus over the real wallet engine (no mock of the injected module): with no wallet connected, the browser's injected wallet —
// even one holding the account the Protect came from, the same seed imported in an extension — is never asked about the transaction (the
// eleventh review round's critique of F11-10: the stale mover had read the hash through `window.ethereum` once WalletConnect was not taken
// up after a reload).
import { afterEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { activeProvider, setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import { walletTxStatus } from "../src/chain";

const ACCOUNT = "0x00000000000000000000000000000000000000b0";
const H = ("0x" + "e7".repeat(32)) as Hex;
afterEach(() => {
  setActiveProvider(null);
  delete (globalThis as { window?: unknown }).window;
});

describe("walletTxStatus with no wallet connected", () => {
  it("the browser's extension holding the sending account is asked nothing; the connected wallet is", async () => {
    const asked: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        if (method === "eth_accounts") return [ACCOUNT];
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getTransactionReceipt") return null;
        if (method === "eth_getTransactionByHash") return { hash: H };
        throw new Error(method);
      },
    };
    (globalThis as { window?: unknown }).window = { ethereum: provider };
    setActiveProvider(null);
    expect(activeProvider(), "the flows would fall back to it").toBe(provider);
    expect(await walletTxStatus(H, 1, ACCOUNT)).toBeNull();
    expect(asked, "window.ethereum asked nothing").toEqual([]);
    setActiveProvider(provider); // the same wallet, connected
    expect(await walletTxStatus(H, 1, ACCOUNT)).toBe("pending");
    expect(asked).toEqual(["eth_accounts", "eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionByHash"]);
  });
});
