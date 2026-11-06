// @vitest-environment happy-dom
// The public wallet's connection (spec §7): EIP-6963 discovery, the injected fallback, WalletConnect only with a
// project id, the account and the chain, the wrong-network status and the switch, the provider's events, a refusal
// that leaves the wallet disconnected, the provider the engine reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { connection, connectorAnsweredNothing, discover, INJECTED_ID, shortAccount } from "@privacy-wallet/wallet-engine/connection";
import { activeProvider, setActiveProvider } from "@privacy-wallet/wallet-engine/injected";

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
    // the legacy enable() injected wallets still carry (deprecated): never called — only WalletConnect's provider is enabled (the eleventh
    // review round, slice 6c's critique)
    async enable() { calls.push({ method: "enable" }); throw new Error("the deprecated enable() was called"); },
  };
}
const w = () => window as unknown as Record<string, unknown>;

afterEach(() => { connection.reset(); setActiveProvider(null); delete w().ethereum; });

describe("the public wallet's connection (spec §7)", () => {
  it("an injected or an EIP-6963 wallet is asked eth_requestAccounts and its chain — never its deprecated enable() (the eleventh review round, slice 6c)", async () => {
    const p = stubProvider();
    w().ethereum = p;
    expect((await connection.connect()).status).toBe("connected");
    expect(p.calls.map((c) => c.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
    connection.reset();
    const announced = stubProvider();
    discover();
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u9", name: "Rabbit Wallet", icon: "data:image/svg+xml;base64,", rdns: "io.rabbit" }, provider: announced } }));
    expect((await connection.connect("io.rabbit")).status).toBe("connected");
    expect(announced.calls.map((c) => c.method)).toEqual(["eth_requestAccounts", "eth_chainId"]);
  });
  it("one connection per wallet whichever entry point asks: Protect's Connect (the browser's first wallet) and the picker's row for it share one prompt (slice 6c's second critique)", async () => {
    let answer: (a: string[]) => void = () => undefined;
    const answered = new Promise<string[]>((r) => (answer = r));
    const asked: string[] = [];
    const slow = {
      ...stubProvider(),
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        return method === "eth_requestAccounts" ? answered : "0x1";
      },
    };
    discover();
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u7", name: "Rabbit Wallet", icon: "data:image/svg+xml;base64,", rdns: "io.rabbit" }, provider: slow } }));
    const fromProtect = connection.connect();
    const fromPicker = connection.connect("io.rabbit");
    expect(fromPicker, "the same connection").toBe(fromProtect);
    answer(["0x7A0000000000000000000000000000000000091F2"]);
    expect((await fromPicker).status).toBe("connected");
    expect(asked.filter((m) => m === "eth_requestAccounts"), "one prompt").toHaveLength(1);
  });
  it("a declined network switch is the switch's, never kept as the connection's failure (slice 6c's second critique)", async () => {
    const p = { ...stubProvider({ chainId: "0x5" }), request: async ({ method }: { method: string }) => { if (method === "wallet_switchEthereumChain") throw new Error("User rejected the request."); return method === "eth_requestAccounts" ? ["0x7A0000000000000000000000000000000000091F2"] : "0x5"; } };
    w().ethereum = p;
    connection.configure({ expectedChainId: 1 });
    expect((await connection.connect()).status).toBe("wrong-network");
    expect(await connection.switchNetwork()).toBe(false);
    expect(connection.get().error).toBeNull();
  });
  it("one connection at a time: a second tap on the same wallet gets the first's answer, one prompt; another wallet replaces it (slice 6c)", async () => {
    let answer: (a: string[]) => void = () => undefined;
    const answered = new Promise<string[]>((r) => (answer = r));
    const slow = { ...stubProvider(), request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? answered : "0x1") };
    w().ethereum = slow;
    const a = connection.connect();
    const b = connection.connect();
    expect(b).toBe(a);
    answer(["0x7A0000000000000000000000000000000000091F2"]);
    expect((await a).status).toBe("connected");
    connection.reset();
    let late: (a: string[]) => void = () => undefined;
    const lateAnswer = new Promise<string[]>((r) => (late = r));
    const first = { ...stubProvider(), request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? lateAnswer : "0x1") };
    w().ethereum = first;
    discover();
    const replaced = connection.connect(INJECTED_ID);
    const other = stubProvider({ accounts: ["0xabc0000000000000000000000000000000000001"] });
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: "u8", name: "Rabbit Wallet", icon: "data:image/svg+xml;base64,", rdns: "io.rabbit" }, provider: other } }));
    expect((await connection.connect("io.rabbit")).account).toBe("0xabc0000000000000000000000000000000000001");
    late(["0x7A0000000000000000000000000000000000091F2"]); // the replaced wallet answers at last
    await replaced;
    expect(connection.get(), "the replaced connection writes nothing").toMatchObject({ status: "connected", account: "0xabc0000000000000000000000000000000000001" });
    expect(activeProvider()).toBe(other);
  });
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
    // an injected wallet's disconnect is its link to the chain: the connection reads disconnected through the same connector, still
    // followed — its account back, the page is connected again (the eleventh review round, slice 6c's third critique)
    p.emit("disconnect");
    expect(connection.get()).toMatchObject({ status: "disconnected", connector: { kind: "injected" } });
    p.emit("accountsChanged", ["0xabc0000000000000000000000000000000000001"]);
    expect(connection.get()).toMatchObject({ status: "connected", account: "0xabc0000000000000000000000000000000000001" });
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
  it("a remembered connector is forgotten after a reconnect only when it was present and answered no account (the review round of 2026-11-02)", () => {
    const base = { ...connection.get(), status: "disconnected" as const, connectors: [{ id: "io.metamask", name: "MetaMask", kind: "eip6963" as const }] };
    expect(connectorAnsweredNothing("io.metamask", base), "present, nothing answered: forgotten").toBe(true);
    expect(connectorAnsweredNothing("walletconnect", base), "not present (still announcing, or missing here): kept").toBe(false);
    expect(connectorAnsweredNothing("io.metamask", { ...base, status: "connected" }), "connected: kept").toBe(false);
  });
  it("the short form of an account is its first four and last four characters", () => {
    expect(shortAccount("0x7A0000000000000000000000000000000000091F2")).toBe("0x7A…91F2");
  });
});
