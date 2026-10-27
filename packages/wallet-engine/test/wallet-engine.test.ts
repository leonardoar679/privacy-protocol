// @vitest-environment happy-dom
// The wallet engine's names (doc §15; spec v2.0 §8) over a scripted EIP-1193 wallet: detectWallet finds the injected
// wallet and an EIP-6963 announcement; connect reads the account and the chain; signMessage and requestSignature ask
// the wallet with the account and the exact payload (EIP-191 hex text, EIP-712 JSON with bigints as decimal strings);
// switchNetwork asks for the deployment's chain; disconnect forgets it; nothing signs without a connected wallet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureWalletConnect, resetWalletConnect } from "../src/walletConnect";

// WalletConnect's provider, scripted: every init is a new pairing, and a disconnect ends that session
const wc = vi.hoisted(() => ({ inits: 0, disconnects: 0, restored: false, lastInit: null as unknown, methods: [] as string[] }));
vi.mock("@walletconnect/ethereum-provider", () => ({
  EthereumProvider: {
    init: async (opts: unknown) => {
      wc.inits++;
      wc.lastInit = opts;
      return {
        request: async ({ method }: { method: string }) => {
          wc.methods.push(method);
          // V7 Stage 16: eth_accounts answers from a session the provider restored from its own store, or nothing
          if (method === "eth_requestAccounts") return ["0x7a3b000000000000000000000000000000c491f2"];
          if (method === "eth_accounts") return wc.restored ? ["0x7a3b000000000000000000000000000000c491f2"] : [];
          return method === "eth_chainId" ? "0x1" : null;
        },
        on: () => {},
        removeListener: () => {},
        disconnect: async () => {
          wc.disconnects++;
        },
      };
    },
  },
}));
import { connect, connection, detectWallet, disconnect, getAddress, requestSignature, signMessage, switchNetwork, type Eip1193Provider } from "../src/index";

const ACCOUNT = "0x7a3b000000000000000000000000000000c491f2";

function scriptedWallet(chainId = "0x1"): Eip1193Provider & { calls: { method: string; params?: unknown[] }[] } {
  const calls: { method: string; params?: unknown[] }[] = [];
  return {
    calls,
    async request(args) {
      calls.push(args);
      switch (args.method) {
        case "eth_requestAccounts":
          return [ACCOUNT];
        case "eth_chainId":
          return chainId;
        case "personal_sign":
          return "0xsigned-text";
        case "eth_signTypedData_v4":
          return "0xsigned-typed";
        case "wallet_switchEthereumChain":
          return null;
        default:
          throw new Error(`unexpected ${args.method}`);
      }
    },
    on: () => undefined,
    removeListener: () => undefined,
  };
}

afterEach(() => {
  connection.reset();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe("the wallet engine (doc §15)", () => {
  it("detects the injected wallet and an EIP-6963 announcement", () => {
    (window as unknown as { ethereum: Eip1193Provider }).ethereum = scriptedWallet();
    expect(detectWallet().map((c) => c.kind)).toEqual(["injected"]);
    const announced = scriptedWallet();
    window.addEventListener(
      "eip6963:requestProvider",
      () => {
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: { info: { uuid: "u", name: "Example Wallet", icon: "data:,", rdns: "com.example" }, provider: announced },
          }),
        );
      },
      { once: true },
    );
    expect(detectWallet().map((c) => [c.id, c.kind])).toEqual([["com.example", "eip6963"]]);
  });

  it("connects, signs a text and typed data through the wallet, switches the network and disconnects", async () => {
    const w = scriptedWallet("0x2105");
    (window as unknown as { ethereum: Eip1193Provider }).ethereum = w;
    connection.configure({ expectedChainId: 1 });
    const state = await connect();
    expect(state).toMatchObject({ status: "wrong-network", account: ACCOUNT, chainId: 8453 });
    expect(getAddress()).toBe(ACCOUNT);

    expect(await signMessage("Protect 5,000 USDC")).toBe("0xsigned-text");
    expect(w.calls.at(-1)).toEqual({ method: "personal_sign", params: ["0x" + Buffer.from("Protect 5,000 USDC", "utf8").toString("hex"), ACCOUNT] });

    const typed = {
      domain: { name: "Example", chainId: 1n },
      types: { Order: [{ name: "amount", type: "uint256" }] },
      primaryType: "Order",
      message: { amount: 10n ** 30n },
    };
    expect(await requestSignature(typed)).toBe("0xsigned-typed");
    const [account, json] = w.calls.at(-1)!.params as [string, string];
    expect(account).toBe(ACCOUNT);
    expect(JSON.parse(json)).toEqual({
      domain: { name: "Example", chainId: "1" },
      types: typed.types,
      primaryType: "Order",
      message: { amount: "1000000000000000000000000000000" },
    });

    expect(await switchNetwork()).toBe(true);
    expect(w.calls.at(-1)).toEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });

    disconnect();
    expect(getAddress()).toBeNull();
    await expect(signMessage("again")).rejects.toThrow(/no wallet connected/);
    await expect(requestSignature(typed)).rejects.toThrow(/no wallet connected/);
  });

  it("a chain id it cannot read is not the deployment's network: wrong-network, never connected (audit round 2, n55)", async () => {
    (window as unknown as { ethereum: Eip1193Provider }).ethereum = scriptedWallet("not a chain id");
    connection.configure({ expectedChainId: 1 });
    expect(await connect()).toMatchObject({ status: "wrong-network", account: ACCOUNT, chainId: null });
  });

  it("without any wallet: nothing to detect, connect reports it unavailable, never throws", async () => {
    expect(detectWallet()).toEqual([]);
    expect(await connect()).toMatchObject({ status: "unavailable", account: null });
    expect(await switchNetwork()).toBe(false);
  });
});

describe("WalletConnect (the audit's unverified m65)", () => {
  it("Disconnect ends the session at its relay, and the next connection is a new pairing", async () => {
    configureWalletConnect("a-project-id");
    try {
      const first = await connection.connect("walletconnect");
      expect(first.status).toBe("connected");
      expect(wc.inits).toBe(1);
      connection.disconnect();
      await vi.waitFor(() => expect(wc.disconnects, "the session is ended, not only forgotten").toBe(1));
      await connection.connect("walletconnect");
      expect(wc.inits, "a new pairing, never the old session").toBe(2);
    } finally {
      connection.disconnect();
      configureWalletConnect(undefined);
      resetWalletConnect();
    }
  });

  it("declares the icon a wallet shows and where a phone's wallet app returns after signing (V7 Stage 16, spec v3.0 §9)", async () => {
    configureWalletConnect("a-project-id");
    try {
      await connection.connect("walletconnect");
      const m = (wc.lastInit as { metadata: { url: string; icons: string[]; redirect?: { universal?: string } } }).metadata;
      expect(m.url).toBe(location.origin);
      expect(m.icons).toEqual([`${location.origin}/icon.svg`]);
      expect(m.redirect).toEqual({ universal: location.origin });
    } finally {
      connection.disconnect();
      configureWalletConnect(undefined);
      resetWalletConnect();
    }
  });

  it("after a reload a session the provider restored is taken up without a pairing (V7 Stage 16): eth_accounts, never eth_requestAccounts; none stored stays disconnected", async () => {
    configureWalletConnect("a-project-id");
    try {
      wc.restored = false;
      wc.methods.length = 0;
      expect((await connection.reconnect("walletconnect")).status, "nothing stored").toBe("disconnected");
      resetWalletConnect();
      wc.restored = true;
      const s = await connection.reconnect("walletconnect");
      expect(s.status).toBe("connected");
      expect(s.connector?.kind).toBe("walletconnect");
      expect(wc.methods, "no prompt").not.toContain("eth_requestAccounts");
    } finally {
      wc.restored = false;
      connection.disconnect();
      configureWalletConnect(undefined);
      resetWalletConnect();
    }
  });
});
