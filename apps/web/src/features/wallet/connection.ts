// The public wallet's connection (spec §7; plan §11): EIP-6963 discovery of the wallets in this browser (keyed by
// their rdns), the injected provider as the fallback, WalletConnect loaded only on request and only when a project
// id is configured; the account and the chain from the provider, its `accountsChanged` / `chainChanged` /
// `disconnect` events followed; a wrong network named and switchable, never reinterpreted. The two security
// domains never meet: nothing here touches the shielded keys.
import { activeProvider, injectedProvider, setActiveProvider, type Eip1193Provider } from "../../sdk/injected";
import { walletConnectAvailable } from "./walletConnect";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "wrong-network" | "unavailable";
export interface ConnectorInfo { id: string; name: string; icon?: string; kind: "eip6963" | "injected" | "walletconnect" }
export interface ConnectionState {
  status: ConnectionStatus;
  account: string | null;
  chainId: number | null;
  expectedChainId: number | null;
  connector: ConnectorInfo | null;
  connectors: ConnectorInfo[];
  /** the last failure, for the screen (never thrown) */
  error: string | null;
}

interface Eip6963Detail { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193Provider }

export const INJECTED_ID = "injected";
export const WALLETCONNECT_ID = "walletconnect";

const discovered = new Map<string, Eip6963Detail>();
let listening = false;
let expected: number | null = null;
let state: ConnectionState = { status: "disconnected", account: null, chainId: null, expectedChainId: null, connector: null, connectors: [], error: null };
const listeners = new Set<() => void>();
let bound: { provider: Eip1193Provider; onAccounts: (...a: unknown[]) => void; onChain: (...a: unknown[]) => void; onDisconnect: (...a: unknown[]) => void } | null = null;

const set = (patch: Partial<ConnectionState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };

function connectorList(): ConnectorInfo[] {
  const out: ConnectorInfo[] = [...discovered.values()].map((d) => ({ id: d.info.rdns, name: d.info.name, icon: d.info.icon, kind: "eip6963" as const }));
  if (!out.length && injectedProvider()) out.push({ id: INJECTED_ID, name: "Browser wallet", kind: "injected" });
  if (walletConnectAvailable()) out.push({ id: WALLETCONNECT_ID, name: "WalletConnect", kind: "walletconnect" });
  return out;
}

/** Listens for the wallets announcing themselves (EIP-6963) and asks them to; idempotent. */
export function discover(): void {
  if (typeof window === "undefined") return;
  if (!listening) {
    listening = true;
    window.addEventListener("eip6963:announceProvider", (e: Event) => {
      const detail = (e as CustomEvent<Eip6963Detail>).detail;
      if (detail?.info?.rdns && detail.provider) { discovered.set(detail.info.rdns, detail); set({ connectors: connectorList() }); }
    });
  }
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  set({ connectors: connectorList() });
}

const parseChainId = (x: unknown): number | null => (typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x) ? parseInt(x, 16) : typeof x === "number" ? x : null);
const statusFor = (account: string | null, chainId: number | null): ConnectionStatus => (!account ? "disconnected" : expected !== null && chainId !== null && chainId !== expected ? "wrong-network" : "connected");

function bind(provider: Eip1193Provider): void {
  unbind();
  const onAccounts = (accounts: unknown) => { const a = Array.isArray(accounts) ? (accounts[0] as string | undefined) ?? null : null; set({ account: a, status: statusFor(a, state.chainId) }); };
  const onChain = (id: unknown) => { const c = parseChainId(id); set({ chainId: c, status: statusFor(state.account, c) }); };
  const onDisconnect = () => { set({ account: null, status: "disconnected" }); };
  provider.on?.("accountsChanged", onAccounts);
  provider.on?.("chainChanged", onChain);
  provider.on?.("disconnect", onDisconnect);
  bound = { provider, onAccounts, onChain, onDisconnect };
}
function unbind(): void {
  if (!bound) return;
  bound.provider.removeListener?.("accountsChanged", bound.onAccounts);
  bound.provider.removeListener?.("chainChanged", bound.onChain);
  bound.provider.removeListener?.("disconnect", bound.onDisconnect);
  bound = null;
}

async function providerFor(id: string | undefined): Promise<{ provider: Eip1193Provider; info: ConnectorInfo } | null> {
  const list = connectorList();
  const info = id ? list.find((c) => c.id === id) : list.find((c) => c.kind !== "walletconnect") ?? list[0];
  if (!info) return null;
  if (info.kind === "eip6963") return { provider: discovered.get(info.id)!.provider, info };
  if (info.kind === "injected") { const p = injectedProvider(); return p ? { provider: p, info } : null; }
  const { walletConnectProvider } = await import("./walletConnect");
  const p = await walletConnectProvider(expected ?? 1);
  return p ? { provider: p, info } : null;
}

export const connection = {
  get: (): ConnectionState => state,
  subscribe: (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  /** The deployment's chain (the app's Providers call it once). */
  configure(o: { expectedChainId: number | null }): void { expected = o.expectedChainId; set({ expectedChainId: expected, status: statusFor(state.account, state.chainId) }); },
  /** Connects a wallet: the chosen connector, else the first wallet of this browser. Never throws. */
  async connect(id?: string): Promise<ConnectionState> {
    discover();
    set({ status: "connecting", error: null });
    try {
      const chosen = await providerFor(id);
      if (!chosen) { set({ status: "unavailable", account: null, connector: null }); return state; }
      const accounts = (await chosen.provider.request({ method: "eth_requestAccounts" })) as string[] | undefined;
      const account = accounts?.[0] ?? null;
      let chainId: number | null = null;
      try { chainId = parseChainId(await chosen.provider.request({ method: "eth_chainId" })); } catch { chainId = null; }
      setActiveProvider(chosen.provider);
      bind(chosen.provider);
      set({ account, chainId, connector: chosen.info, status: statusFor(account, chainId) });
    } catch (e) {
      set({ status: "disconnected", account: null, connector: null, error: e instanceof Error ? e.message : String(e) });
    }
    return state;
  },
  /** Asks the wallet to switch to the deployment's chain (EIP-3326). Never throws. */
  async switchNetwork(): Promise<boolean> {
    const p = activeProvider();
    if (!p || expected === null) return false;
    try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${expected.toString(16)}` }] }); return true; } catch (e) { set({ error: e instanceof Error ? e.message : String(e) }); return false; }
  },
  disconnect(): void { unbind(); setActiveProvider(null); set({ status: "disconnected", account: null, chainId: null, connector: null, error: null }); },
  /** Tests: everything back to the start. */
  reset(): void { unbind(); setActiveProvider(null); discovered.clear(); expected = null; state = { status: "disconnected", account: null, chainId: null, expectedChainId: null, connector: null, connectors: [], error: null }; for (const l of listeners) l(); },
  provider: (): Eip1193Provider | null => activeProvider(),
};

/** `0x7A…91F2` (spec §1). */
export const shortAccount = (account: string): string => `${account.slice(0, 4)}…${account.slice(-4)}`;
