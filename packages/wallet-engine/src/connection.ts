// The public wallet's connection (spec §7; plan §11): EIP-6963 discovery of the wallets in this browser (keyed by
// their rdns), the injected provider as the fallback, WalletConnect loaded only on request and only when a project
// id is configured; the account and the chain from the provider, its `accountsChanged` / `chainChanged` /
// `disconnect` events followed; a wrong network named and switchable, never reinterpreted. The two security
// domains never meet: nothing here touches the shielded keys.
import { activeProvider, injectedProvider, setActiveProvider, type Eip1193Provider } from "./injected";
import { endWalletConnectOf, hasWalletConnectSession, walletConnectAvailable, type WcProvider } from "./walletConnect";

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
  /**
   * A WalletConnect pairing waiting for the wallet app: its link — the QR code's content, and the link that opens a phone's wallet app —, for
   * the wallet's own sheet to show (the eleventh review round, slice 6c). In memory only: never stored, never in this page's URL.
   */
  pairing: string | null;
  /**
   * The connector a connection is being made through, while it is (the eleventh review round, slice 6c's third critique): the pairing's own
   * sheet shows a WalletConnect connection from its start — its wait and a failure that comes before any link —, and the picker closed
   * while it loads cancels it.
   */
  pending: ConnectorInfo | null;
}

interface Eip6963Detail { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193Provider }

export const INJECTED_ID = "injected";
export const WALLETCONNECT_ID = "walletconnect";

const discovered = new Map<string, Eip6963Detail>();
let listening = false;
let expected: number | null = null;
let state: ConnectionState = { status: "disconnected", account: null, chainId: null, expectedChainId: null, connector: null, connectors: [], error: null, pairing: null, pending: null };
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
// a chain id the wallet did not give readably is not the deployment's chain (audit round 2, n55): it had read "connected", and
// reads such as the allowance list ran on a chain nobody knew (sends were re-checked by sendViaInjectedWallet)
const statusFor = (account: string | null, chainId: number | null): ConnectionStatus => (!account ? "disconnected" : expected !== null && chainId !== expected ? "wrong-network" : "connected");

function bind(provider: Eip1193Provider, kind: ConnectorInfo["kind"]): void {
  unbind();
  const onAccounts = (accounts: unknown) => { const a = Array.isArray(accounts) ? (accounts[0] as string | undefined) ?? null : null; set({ account: a, status: statusFor(a, state.chainId) }); };
  const onChain = (id: unknown) => { const c = parseChainId(id); set({ chainId: c, status: statusFor(state.account, c) }); };
  // a WalletConnect session the wallet app ended is gone — its provider holds none until a new pairing, which goes through connect() —:
  // its listeners are let go, so a pairing approved later (one cancelled meanwhile) cannot connect this page through them (the eleventh
  // review round, slice 6c's second critique), and the connector is cleared. The provider stays the active one: it refuses every request
  // with the words the error catalog reads as wallet_disconnected — cleared, a send had fallen back to the browser's injected wallet, a
  // wallet never connected for it (the third critique). An injected wallet's disconnect is its link to the chain, which may come back: it
  // stays followed
  const onDisconnect = () => {
    if (kind !== "walletconnect") return set({ account: null, status: "disconnected" });
    unbind();
    set({ account: null, status: "disconnected", connector: null });
  };
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The connector a connection asks: the chosen one, else the first wallet of this browser (WalletConnect when it is the only one). */
function pick(id: string | undefined): ConnectorInfo | undefined {
  const list = connectorList();
  return id ? list.find((c) => c.id === id) : list.find((c) => c.kind !== "walletconnect") ?? list[0];
}
async function providerOf(info: ConnectorInfo): Promise<Eip1193Provider | null> {
  if (info.kind === "eip6963") return discovered.get(info.id)?.provider ?? null;
  if (info.kind === "injected") return injectedProvider();
  const { walletConnectProvider } = await import("./walletConnect");
  return walletConnectProvider(expected ?? 1);
}
async function providerFor(id: string | undefined, waitMs = 0): Promise<{ provider: Eip1193Provider; info: ConnectorInfo } | null> {
  let info = pick(id);
  // a remembered wallet may still be announcing itself (EIP-6963 answers asynchronously): a reconnect waits a moment for it
  for (const until = Date.now() + waitMs; !info && id && Date.now() < until; ) { await sleep(100); info = pick(id); }
  if (!info) return null;
  const provider = await providerOf(info);
  return provider ? { provider, info } : null;
}

/**
 * The review round of 2026-11-02: a remembered connector that was present at the reconnect and answered no account is
 * forgotten by the app (prefs.lastConnector) — it would be asked at every reload otherwise. One not present (a wallet still
 * announcing itself, an extension missing on this browser) is kept: nothing answered because nothing was asked.
 */
export const connectorAnsweredNothing = (id: string, st: ConnectionState): boolean => st.status === "disconnected" && st.connectors.some((c) => c.id === id);

/**
 * The connection being made: the connector it resolved to (its id and kind; null: none in this browser) — one at a time, shared by that
 * connector whichever entry point asked (the slice's second critique: Protect's Connect and the picker's row for the same wallet had been
 * two prompts, the first one's approval dropped).
 */
let inflight: { key: string | null; kind: ConnectorInfo["kind"] | null; run: Promise<ConnectionState> } | null = null;
/** Counts the connections started, cancelled and replaced: only the latest one writes the state. */
let attempt = 0;
const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof (e as { message?: unknown } | null)?.message === "string" ? (e as { message: string }).message : String(e);

/** The page holds a connection through this provider: bound to it, with an account. */
const holdsConnection = (p: Eip1193Provider): boolean => bound?.provider === p && state.account !== null;

async function connectOnce(info: ConnectorInfo | undefined, mine: number): Promise<ConnectionState> {
  const current = () => mine === attempt;
  set({ status: "connecting", error: null, pairing: null, pending: info ?? null });
  // what this run resolves with: its outcome while it is the latest; cancelled or replaced, its own start — never another connection's
  // state, which a caller had read as its own (the third critique: the same connector tapped again, the first pairing's expiry closed the
  // picker the second had connected)
  const started = state;
  const outcome = (): ConnectionState => (current() ? state : started);
  try {
    const provider = info ? await providerOf(info) : null;
    if (!current()) return outcome();
    if (!info || !provider) { set({ status: "unavailable", account: null, connector: null, pending: null }); return state; }
    const chosen = { provider, info };
    const wc = chosen.info.kind === "walletconnect";
    let accounts: string[] | undefined;
    if (wc) {
      // WalletConnect pairs through its provider's own enable() — its connect() when it holds no session, then the accounts — or takes up a
      // session its store holds: eth_requestAccounts alone, with no session, had thrown "Please call connect() before request()", so no first
      // WalletConnect connection ever paired (the eleventh review round, the critique of its documents slice). The pairing's link comes as the
      // provider's display_uri, for the wallet's own sheet (slice 6c's critique: the library's modal is refused by the page's policy); only
      // WalletConnect's enable() — an injected wallet's is deprecated
      const p = chosen.provider as WcProvider;
      const onUri = (uri: unknown) => { if (current() && typeof uri === "string") set({ pairing: uri }); };
      p.on?.("display_uri", onUri);
      try { accounts = await p.enable(); } finally { p.removeListener?.("display_uri", onUri); }
    } else accounts = (await chosen.provider.request({ method: "eth_requestAccounts" })) as string[] | undefined;
    const account = accounts?.[0] ?? null;
    let chainId: number | null = null;
    try { chainId = parseChainId(await chosen.provider.request({ method: "eth_chainId" })); } catch { chainId = null; }
    if (!current()) {
      // approved after it was cancelled or replaced: a WalletConnect session nothing here holds is ended at its relay, as a Disconnect ends one
      // (the audit's m65) — the wallet app never shows a connection this page does not. Kept only while a WalletConnect connection is being
      // made again (ending it would end that pairing too) or while the page holds this provider's connection (the slice's second critique:
      // any connection in flight had kept it, and the active provider had been read as the live connection after the wallet app ended it)
      if (wc && inflight?.kind !== "walletconnect" && !holdsConnection(chosen.provider)) void endWalletConnectOf(chosen.provider as WcProvider);
      return outcome();
    }
    setActiveProvider(chosen.provider);
    bind(chosen.provider, chosen.info.kind);
    set({ account, chainId, connector: chosen.info, status: statusFor(account, chainId), error: null, pairing: null, pending: null });
  } catch (e) {
    // a cancelled or replaced connection's failure (a pairing expired after its Cancel) writes nothing
    if (current()) set({ status: "disconnected", account: null, connector: null, error: messageOf(e), pairing: null, pending: null });
  }
  return outcome();
}

export const connection = {
  get: (): ConnectionState => state,
  subscribe: (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  /** The deployment's chain (the app's Providers call it once). */
  configure(o: { expectedChainId: number | null }): void { expected = o.expectedChainId; set({ expectedChainId: expected, status: statusFor(state.account, state.chainId) }); },
  /**
   * Connects a wallet: the chosen connector, else the first wallet of this browser. Never throws. One connection at a time (the eleventh
   * review round, slice 6c's critique): another ask for the same connector gets the first's outcome — two had made two WalletConnect
   * pairings, and the one never scanned wrote "disconnected" over the one that connected when it expired five minutes later —; another
   * connector replaces it, and only the latest writes the state. Resolves with the state the run left: its outcome while it is the latest;
   * a cancelled or replaced run, its own start (connecting) — never another connection's state (the slice's second and third critiques:
   * the picker had remembered a connector that never connected, and closed on a retry the first pairing's expiry did not concern).
   */
  connect(id?: string): Promise<ConnectionState> {
    discover();
    const info = pick(id);
    const key = info?.id ?? null;
    if (inflight && inflight.key === key) return inflight.run;
    const mine = ++attempt;
    const run = connectOnce(info, mine).finally(() => {
      if (inflight?.run === run) inflight = null;
    });
    inflight = { key, kind: info?.kind ?? null, run };
    return run;
  },
  /** The last failure dismissed (the pairing sheet closed over it; slice 6c's second critique). */
  dismissError(): void {
    if (state.error !== null) set({ error: null });
  },
  /**
   * Stops the connection being made (the eleventh review round, slice 6c): the pairing's Cancel, its sheet closed. Its outcome, whenever it
   * comes, is not taken — a WalletConnect pairing approved after it is ended at its relay, unless a WalletConnect connection is being made
   * again or the page holds a connection through that provider; one that expires writes nothing. Never throws.
   */
  cancel(): void {
    if (!inflight) return;
    attempt++;
    inflight = null;
    set({ status: statusFor(state.account, state.chainId), error: null, pairing: null, pending: null });
  },
  /**
   * V7 Stage 4 (spec v3.0 §2): reconnects the remembered connector after a reload without a prompt (`eth_accounts`): a
   * wallet that no longer authorizes this site leaves the state disconnected. V7 Stage 16 (spec v3.0 §9): WalletConnect too —
   * only when its own store holds a session (the review round of 2026-11-02): then its provider is initialized, restores it,
   * and `eth_accounts` answers from it without a pairing; none stored: nothing is initialized (its init opens the relay
   * socket, which every reload of a browser that once chose it had opened for nothing) and the state stays disconnected.
   * Never throws.
   */
  async reconnect(id: string): Promise<ConnectionState> {
    discover();
    if (state.status !== "disconnected") return state;
    if (id === WALLETCONNECT_ID && !hasWalletConnectSession()) return state;
    try {
      const chosen = await providerFor(id, 1_500);
      if (!chosen) return state;
      const accounts = (await chosen.provider.request({ method: "eth_accounts" })) as string[] | undefined;
      const account = accounts?.[0] ?? null;
      if (!account || state.status !== "disconnected") return state;
      let chainId: number | null = null;
      try { chainId = parseChainId(await chosen.provider.request({ method: "eth_chainId" })); } catch { chainId = null; }
      setActiveProvider(chosen.provider);
      bind(chosen.provider, chosen.info.kind);
      set({ account, chainId, connector: chosen.info, status: statusFor(account, chainId), error: null });
    } catch {
      // the wallet refused or threw: nothing changes, the user connects by hand
    }
    return state;
  },
  /** Asks the wallet to switch to the deployment's chain (EIP-3326). Never throws. */
  async switchNetwork(): Promise<boolean> {
    const p = activeProvider();
    if (!p || expected === null) return false;
    // a refusal is the switch's, not the connection's: returned, never kept as the connection's error — the picker had read a declined switch
    // as a declined connection once the account went (slice 6c's second critique)
    try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${expected.toString(16)}` }] }); return true; } catch { return false; }
  },
  disconnect(): void {
    // a WalletConnect session is ended at its relay too, not only forgotten here (the audit's unverified m65)
    if (state.connector?.kind === "walletconnect") void import("./walletConnect").then((m) => m.endWalletConnect());
    // a connection still being made is dropped with it (slice 6c)
    attempt++;
    inflight = null;
    unbind();
    setActiveProvider(null);
    set({ status: "disconnected", account: null, chainId: null, connector: null, error: null, pairing: null, pending: null });
  },
  /** Tests: everything back to the start. */
  reset(): void { attempt++; inflight = null; unbind(); setActiveProvider(null); discovered.clear(); expected = null; state = { status: "disconnected", account: null, chainId: null, expectedChainId: null, connector: null, connectors: [], error: null, pairing: null, pending: null }; for (const l of listeners) l(); },
  provider: (): Eip1193Provider | null => activeProvider(),
};

/** `0x7A…91F2` (spec §1). */
export const shortAccount = (account: string): string => `${account.slice(0, 4)}…${account.slice(-4)}`;
