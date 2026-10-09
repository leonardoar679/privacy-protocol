// @vitest-environment happy-dom
// The public wallet's connection (spec §7): EIP-6963 discovery, the injected fallback, WalletConnect only with a
// project id, the account and the chain, the wrong-network status and the switch, the provider's events, a refusal
// that leaves the wallet disconnected, the provider the engine reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { connection, discover, INJECTED_ID, shortAccount } from "../src/features/wallet/connection";
import { activeProvider, setActiveProvider } from "../src/sdk/injected";

type Handler = (...args: unknown[]) => void;
function stubProvider(opts: { accounts?: string[]; chainId?: string; refuse?: boolean } = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const calls: { method: string; params?: unknown[] }[] = [];
  return {
    calls,
    emit(event: string, ...args: unknown[]) { for (const h of handlers.get(event) ?? []) h(...args); },
    async request(args: { method: string; params?: unknown[] }) {
      calls.push(args);
      if (args.method === "eth_requestAccounts") { if (opts.refuse) throw new Error("User rejected the request."); return opts.accounts ?? ["0x7A0000000000000000000000000000000000091F2"]; }
      if (args.method === "eth_chainId") return opts.chainId ?? "0x1";
      if (args.method === "wallet_switchEthereumChain") return null;
      throw new Error(`unexpected ${args.method}`);
    },
    on(event: string, h: Handler) { (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(h); },
    removeListener(event: string, h: Handler) { handlers.get(event)?.delete(h); },
  };
}
const w = () => window as unknown as Record<string, unknown>;

afterEach(() => { connection.reset(); setActiveProvider(null); delete w().ethereum; });

describe("the public wallet's connection (spec §7)", () => {
  it("discovers EIP-6963 wallets, falls back to the injected provider, lists WalletConnect only with a project id", () => {
    discover();
    expect(connection.get().connectors).toEqual([]);
    w().ethereum = stubProvider();
    discover();
    expect(connection.get().connectors.map((c) => c.id)).toEqual([INJECTED_ID]);
    const announced = stubProvider();
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u1", name: "Rabbit Wallet", icon: "data:image/svg+xml;base64,", rdns: "io.rabbit" }, provider: announced } }));
    expect(connection.get().connectors.map((c) => [c.id, c.kind])).toEqual([["io.rabbit", "eip6963"]]); // an announced wallet replaces the bare injected entry
    expect(connection.get().connectors.some((c) => c.kind === "walletconnect"), "no project id configured").toBe(false);
  });
  it("connects: the account and the chain, the status against the expected chain, the switch, the events", async () => {
    const p = stubProvider({ chainId: "0x5" });
    w().ethereum = p;
    connection.configure({ expectedChainId: 1 });
    const st = await connection.connect();
    expect(st).toMatchObject({ status: "wrong-network", account: "0x7A0000000000000000000000000000000000091F2", chainId: 5, expectedChainId: 1, connector: { id: INJECTED_ID, kind: "injected" } });
    expect(activeProvider()).toBe(p);
    expect(await connection.switchNetwork()).toBe(true);
    expect(p.calls.at(-1)).toEqual({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
    p.emit("chainChanged", "0x1");
    expect(connection.get()).toMatchObject({ status: "connected", chainId: 1 });
    p.emit("accountsChanged", ["0xabc0000000000000000000000000000000000001"]);
    expect(connection.get().account).toBe("0xabc0000000000000000000000000000000000001");
    p.emit("accountsChanged", []);
    expect(connection.get()).toMatchObject({ status: "disconnected", account: null });
    p.emit("disconnect");
    connection.disconnect();
    expect(connection.get()).toMatchObject({ status: "disconnected", connector: null });
    expect(activeProvider(), "the injected provider stays the engine's fallback").toBe(p);
  });
  it("a refusal leaves it disconnected with the reason; no wallet at all is 'unavailable'", async () => {
    w().ethereum = stubProvider({ refuse: true });
    expect(await connection.connect()).toMatchObject({ status: "disconnected", account: null, error: "User rejected the request." });
    delete w().ethereum;
    connection.reset();
    expect(await connection.connect()).toMatchObject({ status: "unavailable", account: null });
  });
  it("connects the chosen EIP-6963 wallet by its rdns and follows its events", async () => {
    const a = stubProvider({ accounts: ["0xaaaa000000000000000000000000000000000001"] });
    const b = stubProvider({ accounts: ["0xbbbb000000000000000000000000000000000002"] });
    discover();
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "a", name: "A", icon: "", rdns: "com.a" }, provider: a } }));
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "b", name: "B", icon: "", rdns: "com.b" }, provider: b } }));
    const st = await connection.connect("com.b");
    expect(st.account).toBe("0xbbbb000000000000000000000000000000000002");
    expect(st.connector).toMatchObject({ id: "com.b", name: "B" });
    expect(activeProvider()).toBe(b);
    const spy = vi.fn();
    const off = connection.subscribe(spy);
    b.emit("chainChanged", "0x2105");
    expect(spy).toHaveBeenCalled();
    expect(connection.get().chainId).toBe(8453);
    off();
  });
  it("the short form of an account is its first four and last four characters", () => {
    expect(shortAccount("0x7A0000000000000000000000000000000000091F2")).toBe("0x7A…91F2");
  });
});
