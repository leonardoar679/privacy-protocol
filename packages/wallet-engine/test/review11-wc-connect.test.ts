// @vitest-environment happy-dom
// The wallet's Connect → WalletConnect over the installed EthereumProvider (the eleventh review round: the critique of its documents slice,
// then slice 6c's own). The real EthereumProvider and UniversalProvider run, initialized with the app's own options — the library's QR modal
// off (`showQrModal: false`): its <style> elements are refused by the page's policy, so the wallet shows the pairing itself, from the
// provider's display_uri. Only the sign client is a fake, passed through the provider's own `client` option — no relay, no network; its
// connect gives a pairing link and an approval the test settles.
// A first connection had asked eth_requestAccounts before any pairing, and the provider throws "Please call connect() before request()"
// then: no first WalletConnect connection ever paired (the scripted provider of wallet-engine.test.ts answered the accounts by itself, which
// hid it). Now it goes through the provider's enable(), one connection at a time, and Cancel drops what the wallet app answers later.
import { afterEach, describe, expect, it, vi } from "vitest";

interface Settle {
  approve(): void;
  refuse(e: unknown): void;
}
const sc = vi.hoisted(() => ({
  sessions: [] as unknown[],
  connectCalls: 0,
  disconnects: 0,
  inits: 0,
  initOpts: [] as Record<string, unknown>[],
  pending: [] as Settle[],
  listeners: new Map<string, ((e: unknown) => void)[]>(),
  /** while set, the sign client's connect waits for it before it gives the pairing link (a relay slow to answer) */
  gate: null as Promise<void> | null,
  /** while set, the provider's init waits for it (the library's chunk still loading) */
  initGate: null as Promise<void> | null,
  /** the next init fails (the provider's chunk failing to load after a deploy, a flaky network) */
  failInit: false,
  /** while set, the sign client's disconnect waits for it before it deletes the session (the relay slow to acknowledge the delete and the
   *  unsubscribe — the sign client deletes the session only then) */
  endGate: null as Promise<void> | null,
  /** the held end's release, called after each test (a failing test had left the end held, and every later tap waiting on it) */
  releaseEnd: null as null | (() => void),
  /** the session kept in the client's storage as well (the page's one Core): its keys cleared, a new client finds no session */
  sessionsInStore: false,
}));
const SESSION_KEY = "wc@2:client:0.3//session";
const ACCOUNT = "0x7a3b000000000000000000000000000000c491f2";
const linkOf = (n: number) => `wc:pairing-${n}@2?relay-protocol=irn&symKey=0${n}`;
const session = {
  topic: "a-topic",
  expiry: Math.floor(Date.now() / 1000) + 7 * 86400,
  namespaces: {
    eip155: {
      accounts: [`eip155:1:${ACCOUNT}`],
      methods: ["eth_sendTransaction", "personal_sign"],
      events: ["chainChanged", "accountsChanged"],
      chains: ["eip155:1"],
    },
  },
  requiredNamespaces: {},
  optionalNamespaces: {},
  peer: { metadata: { name: "A wallet", description: "", url: "https://wallet.example", icons: [] } },
  self: { metadata: { name: "Privacy Wallet", description: "", url: "https://localhost", icons: [] } },
  acknowledged: true,
  controller: "a-key",
  pairingTopic: "a-pairing",
  relay: { protocol: "irn" },
};

/** WalletConnect's sign client, as far as the providers use it: its session store, its storage, its events, a connect that pairs on approval. */
function fakeSignClient() {
  const store = new Map<string, unknown>();
  return {
    session: {
      getAll: () => sc.sessions,
      get: (topic: string) => (sc.sessions as { topic: string }[]).find((s) => s.topic === topic),
      get keys() {
        return (sc.sessions as { topic: string }[]).map((s) => s.topic);
      },
      get length() {
        return sc.sessions.length;
      },
    },
    pairing: { getAll: () => [] },
    core: {
      storage: {
        getItem: async (k: string) => store.get(k),
        setItem: async (k: string, v: unknown) => void store.set(k, v),
        removeItem: async (k: string) => {
          store.delete(k);
          if (sc.sessionsInStore && k === SESSION_KEY) sc.sessions = []; // gone from the page's storage: a new client finds no session
        },
        getKeys: async () => [...store.keys()],
      },
      relayer: { connected: false, connecting: false, on: () => undefined, subscriber: { unsubscribe: async () => undefined } },
      pairing: { getPairings: () => [], pairings: { getAll: () => [] }, events: { on: () => undefined } },
      expirer: { on: () => undefined, set: () => undefined },
      projectId: "a-project-id",
    },
    on: (event: string, cb: (e: unknown) => void) => void sc.listeners.set(event, [...(sc.listeners.get(event) ?? []), cb]),
    off: () => undefined,
    removeListener: () => undefined,
    events: { on: () => undefined },
    // the pairing: a link for the QR code, then the wallet's approval (or its refusal), settled by the test
    connect: async () => {
      const n = ++sc.connectCalls;
      if (sc.gate) await sc.gate;
      let settle!: Settle;
      const approval = new Promise<typeof session>((resolve, reject) => {
        settle = {
          approve: () => {
            sc.sessions = [session];
            if (sc.sessionsInStore) store.set(SESSION_KEY, [session]);
            resolve(session);
          },
          refuse: reject,
        };
      });
      sc.pending.push(settle);
      return { uri: linkOf(n), approval: () => approval };
    },
    // the dapp ends the session at its relay
    disconnect: async ({ topic }: { topic: string }) => {
      sc.disconnects++;
      if (sc.endGate) await sc.endGate;
      sc.sessions = (sc.sessions as { topic: string }[]).filter((s) => s.topic !== topic);
    },
    logger: undefined,
  };
}

vi.mock("@walletconnect/ethereum-provider", async (importActual) => {
  const actual = (await importActual()) as { EthereumProvider: { init(o: Record<string, unknown>): Promise<unknown> } };
  return {
    EthereumProvider: {
      // the app's own options (its showQrModal among them), with the fake sign client
      init: async (opts: Record<string, unknown>) => {
        sc.inits++;
        sc.initOpts.push(opts);
        if (sc.initGate) await sc.initGate;
        // the modal would load AppKit and ask its hosts: refused here, as the page's policy refuses its styles
        if (opts.showQrModal !== false) throw new Error("the library's modal asked for");
        if (sc.failInit) {
          sc.failInit = false;
          throw new Error("the provider's chunk failed to load");
        }
        return actual.EthereumProvider.init({ ...opts, client: fakeSignClient() });
      },
    },
  };
});

import {
  configureWalletConnect,
  endWalletConnect,
  endWalletConnectOf,
  resetWalletConnect,
  walletConnectEndTiming,
  walletConnectProvider,
  type WcProvider,
} from "../src/walletConnect";
const END_BOUND = walletConnectEndTiming.boundMs;
import { connection } from "../src/connection";
import { setActiveProvider } from "../src/injected";

const w = () => window as unknown as Record<string, unknown>;
const lastPairing = () => sc.pending[sc.pending.length - 1]!;
/** Waits for the state to carry the pairing link of the n-th sign-client connect. */
const pairingShown = (n: number) => vi.waitFor(() => expect(connection.get().pairing).toBe(linkOf(n)));
/** The wallet app ends the session (its session_delete, as the relay brings it). */
const walletEnds = async () => {
  sc.sessions = [];
  for (const cb of sc.listeners.get("session_delete") ?? []) cb({ id: 1, topic: session.topic });
};

afterEach(() => {
  connection.reset();
  setActiveProvider(null);
  delete w().ethereum;
  configureWalletConnect(undefined);
  resetWalletConnect();
  sc.sessions = [];
  sc.connectCalls = 0;
  sc.disconnects = 0;
  sc.inits = 0;
  sc.initOpts = [];
  sc.pending = [];
  sc.listeners = new Map();
  sc.gate = null;
  sc.initGate = null;
  sc.failInit = false;
  sc.releaseEnd?.();
  sc.releaseEnd = null;
  sc.endGate = null;
  sc.sessionsInStore = false;
  walletConnectEndTiming.boundMs = END_BOUND;
});

describe("Connect → WalletConnect over the installed EthereumProvider", () => {
  it("the provider runs as the app ships it — no library modal — and a first connection pairs: its link in the state until the wallet app approves, then connected", async () => {
    configureWalletConnect("a-project-id");
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    expect(sc.initOpts[0]?.showQrModal, "the modal is off: the wallet's own sheet shows the pairing").toBe(false);
    expect(connection.get().status).toBe("connecting");
    lastPairing().approve();
    const st = await run;
    expect(st.error, "never 'Please call connect() before request()'").toBeNull();
    expect(st.status).toBe("connected");
    expect(st.account?.toLowerCase()).toBe(ACCOUNT);
    expect(st.pairing, "the link goes once the pairing is answered").toBeNull();
    expect(sc.connectCalls, "one pairing").toBe(1);
  });

  it("a pairing the wallet app refuses, or one it leaves unanswered until it expires: disconnected, the failure kept for the sheet's words, the link gone", async () => {
    configureWalletConnect("a-project-id");
    let run = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().refuse({ code: 5000, message: "User rejected." }); // the wallet's JSON-RPC error, as the sign client gives it
    let st = await run;
    expect(st.status).toBe("disconnected");
    expect(st.error).toBe("User rejected.");
    expect(st.pairing).toBeNull();
    run = connection.connect("walletconnect");
    await pairingShown(2);
    lastPairing().refuse(new Error("Proposal expired"));
    st = await run;
    expect(st.status).toBe("disconnected");
    expect(st.error).toBe("Proposal expired");
  });

  it("Cancel: disconnected at once, nothing in error; an approval that comes after it writes nothing, and its session is ended at its relay", async () => {
    configureWalletConnect("a-project-id");
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null, error: null });
    lastPairing().approve(); // the wallet app approves the code scanned before the Cancel
    await run;
    await vi.waitFor(() => expect(sc.disconnects, "the late session is ended (m65's rule)").toBe(1));
    expect(connection.get()).toMatchObject({ status: "disconnected", account: null, connector: null, pairing: null, error: null });
    // ended as a Disconnect ends one: the provider forgotten, the next connection a new one with a new pairing
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    expect(sc.inits, "a new provider").toBe(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("a pairing link that comes after its connection was replaced is never shown: the other connection's prompt has no code over it", async () => {
    configureWalletConnect("a-project-id");
    let open!: () => void;
    sc.gate = new Promise<void>((r) => (open = r));
    const wcRun = connection.connect("walletconnect");
    await vi.waitFor(() => expect(sc.connectCalls, "the pairing asked of the relay").toBe(1));
    let answer!: (a: string[]) => void;
    const answered = new Promise<string[]>((r) => (answer = r));
    w().ethereum = {
      request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? answered : "0x1"),
      on: () => undefined,
      removeListener: () => undefined,
    };
    const injectedRun = connection.connect("injected"); // the user picks the browser's wallet instead
    open(); // the relay answers the WalletConnect pairing now
    await vi.waitFor(() => expect(sc.pending.length).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(connection.get(), "the replaced pairing's link is not shown").toMatchObject({ status: "connecting", pairing: null });
    answer(["0x7a0000000000000000000000000000000000091f"]);
    expect((await injectedRun).status).toBe("connected");
    lastPairing().refuse(new Error("Proposal expired"));
    await wcRun;
    expect(connection.get().status).toBe("connected");
  });

  it("Cancel, then the pairing expires: nothing is written; a retry pairs again on the same provider and connects", async () => {
    configureWalletConnect("a-project-id");
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    const cancelled = lastPairing();
    const retry = connection.connect("walletconnect");
    await pairingShown(2);
    cancelled.refuse(new Error("Proposal expired")); // the first pairing's expiry, after the Cancel
    await first;
    expect(connection.get(), "the expiry of a cancelled pairing writes nothing").toMatchObject({ status: "connecting", error: null, pairing: linkOf(2) });
    lastPairing().approve();
    const st = await retry;
    expect(st.status).toBe("connected");
    expect(sc.connectCalls, "two pairings").toBe(2);
    expect(sc.inits, "one provider").toBe(1);
  });

  it("an old pairing approved while a WalletConnect retry waits on the same provider is kept — ending it would end the retry's pairing (a stated residual: the installed library unsubscribes the old pairing at the retry's start)", async () => {
    configureWalletConnect("a-project-id");
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    const old = lastPairing();
    const retry = connection.connect("walletconnect");
    await pairingShown(2);
    old.approve(); // an approval already on its way when the retry began
    await first;
    await new Promise((r) => setTimeout(r, 20));
    expect(sc.disconnects, "not ended while the retry waits").toBe(0);
    expect(connection.get(), "the retry still waits, its link shown").toMatchObject({ status: "connecting", pairing: linkOf(2) });
    lastPairing().approve();
    expect((await retry).status).toBe("connected");
  });

  it("an old pairing approved after a retry connected on the same provider: the connection it holds is left alone", async () => {
    configureWalletConnect("a-project-id");
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    const old = lastPairing();
    const retry = connection.connect("walletconnect");
    await pairingShown(2);
    lastPairing().approve();
    expect((await retry).status).toBe("connected");
    old.approve(); // the first code, scanned and approved at last
    await first;
    await new Promise((r) => setTimeout(r, 20));
    expect(sc.disconnects, "the session the connection holds is not ended").toBe(0);
    expect(connection.get().status).toBe("connected");
  });

  it("one connection at a time: a second tap gets the first's outcome — one init, one pairing", async () => {
    configureWalletConnect("a-project-id");
    const a = connection.connect("walletconnect");
    const b = connection.connect("walletconnect");
    expect(b, "the same connection").toBe(a);
    await pairingShown(1);
    lastPairing().approve();
    expect((await a).status).toBe("connected");
    expect(sc.inits).toBe(1);
    expect(sc.connectCalls).toBe(1);
  });

  it("the provider's init is one at a time; one under way when WalletConnect is ended is never kept", async () => {
    configureWalletConnect("a-project-id");
    const [p1, p2] = await Promise.all([walletConnectProvider(1), walletConnectProvider(1)]);
    expect(p1).toBe(p2);
    expect(sc.inits).toBe(1);
    await endWalletConnect();
    sc.sessions = [session]; // the init about to be ended takes up a session WalletConnect's store holds
    const making = walletConnectProvider(1);
    const ended = endWalletConnect(); // ended while its init is under way
    const made = await making;
    await ended;
    expect(sc.inits).toBe(2);
    expect(sc.disconnects, "the session the ended init took up is ended at its relay").toBe(1);
    expect(await walletConnectProvider(1), "a new provider: the one made during the end is not kept").not.toBe(made);
    expect(sc.inits).toBe(3);
  });

  it("an init that fails is not kept: the next tap initializes again, pairs and connects", async () => {
    configureWalletConnect("a-project-id");
    sc.failInit = true;
    const first = await connection.connect("walletconnect");
    expect(first).toMatchObject({ status: "disconnected", pairing: null });
    expect(first.error).toMatch(/failed to load/);
    const again = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
    expect(sc.inits).toBe(2);
  });

  it("a WalletConnect tap replaced while its library loads leaves the replacing connection shared: a second tap on it is the same connection, one prompt", async () => {
    configureWalletConnect("a-project-id");
    let loaded!: () => void;
    sc.initGate = new Promise<void>((r) => (loaded = r));
    let answer!: (a: string[]) => void;
    const answered = new Promise<string[]>((r) => (answer = r));
    const asked: string[] = [];
    w().ethereum = {
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        return method === "eth_requestAccounts" ? answered : "0x1";
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const wcRun = connection.connect("walletconnect");
    const injectedRun = connection.connect("injected"); // its prompt open
    loaded(); // the replaced WalletConnect run ends once its library has loaded
    await wcRun;
    expect(connection.connect("injected"), "the same connection").toBe(injectedRun);
    answer(["0x7a0000000000000000000000000000000000091f"]);
    expect((await injectedRun).status).toBe("connected");
    expect(
      asked.filter((m) => m === "eth_requestAccounts"),
      "one prompt",
    ).toHaveLength(1);
    expect(sc.connectCalls, "the replaced run never paired").toBe(0);
  });

  it("a pairing approved after its Cancel while another wallet's prompt is still open is ended at its relay", async () => {
    configureWalletConnect("a-project-id");
    let answer!: (a: string[]) => void;
    const answered = new Promise<string[]>((r) => (answer = r));
    const injected = {
      request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? answered : "0x1"),
      on: () => undefined,
      removeListener: () => undefined,
    };
    w().ethereum = injected;
    const wcRun = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    const injectedRun = connection.connect("injected"); // the browser wallet's prompt opens
    lastPairing().approve(); // the phone approves the code scanned before the Cancel
    await wcRun;
    await vi.waitFor(() => expect(sc.disconnects, "ended while the other prompt is open").toBe(1));
    answer(["0x7a0000000000000000000000000000000000091f"]);
    expect((await injectedRun).status).toBe("connected");
    expect(connection.provider()).toBe(injected);
  });

  it("another connector replaces a pairing under way; that pairing's late approval is ended at its relay, the other connection untouched", async () => {
    configureWalletConnect("a-project-id");
    const injected = {
      request: async ({ method }: { method: string }) =>
        method === "eth_requestAccounts" ? ["0x7a0000000000000000000000000000000000091f"] : method === "eth_chainId" ? "0x1" : null,
      on: () => undefined,
      removeListener: () => undefined,
    };
    w().ethereum = injected;
    const wcRun = connection.connect("walletconnect");
    await pairingShown(1);
    const st = await connection.connect("injected");
    expect(st).toMatchObject({ status: "connected", connector: { kind: "injected" }, pairing: null });
    lastPairing().approve();
    await wcRun;
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    expect(connection.get()).toMatchObject({ status: "connected", connector: { kind: "injected" } });
    expect(connection.provider()).toBe(injected);
  });

  it("Disconnect drops a connection being made: its pairing gone, a later approval ended", async () => {
    configureWalletConnect("a-project-id");
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    connection.disconnect();
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null });
    lastPairing().approve();
    await run;
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    expect(connection.get().status).toBe("disconnected");
  });

  it("a session its store still holds (after a reload, audit gap 112): a tap on Connect takes it up — no new pairing", async () => {
    sc.sessions = [session];
    configureWalletConnect("a-project-id");
    const st = await connection.connect("walletconnect");
    expect(st.status).toBe("connected");
    expect(st.account?.toLowerCase()).toBe(ACCOUNT);
    expect(sc.connectCalls, "no pairing").toBe(0);
  });

  it("a session the wallet app ends: disconnected, and the provider then asks nothing — its request throws the words the error catalog reads as wallet_disconnected", async () => {
    configureWalletConnect("a-project-id");
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    expect((await run).status).toBe("connected");
    const provider = connection.provider()!;
    const injected = { request: async () => ["0x7a0000000000000000000000000000000000091f"], on: () => undefined, removeListener: () => undefined };
    w().ethereum = injected; // a browser wallet beside it, never connected for this
    await walletEnds();
    await vi.waitFor(() => expect(connection.get().status).toBe("disconnected"));
    expect(connection.get().connector, "the connector cleared").toBeNull();
    // the ended provider stays the active one — it refuses — and nothing falls back to the browser's wallet (the slice's third critique)
    expect(connection.provider(), "never the browser's injected wallet").toBe(provider);
    // what a send through the connected wallet asks first (packages/sdk/src/chain.ts sendViaInjectedWallet); the catalog's row:
    // apps/web/test/operations/catalog.test.ts
    await expect(provider.request({ method: "eth_requestAccounts" })).rejects.toThrow("Please call connect() before request()");
  });

  it("after the wallet app ended its session, a new pairing cancelled and approved late connects nothing and is ended at its relay", async () => {
    configureWalletConnect("a-project-id");
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    expect((await run).status).toBe("connected");
    await walletEnds();
    await vi.waitFor(() => expect(connection.get().status).toBe("disconnected"));
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    connection.cancel();
    lastPairing().approve();
    await again;
    await vi.waitFor(() => expect(sc.disconnects, "the late session ended").toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(connection.get(), "no listener of the ended session connects the page").toMatchObject({ status: "disconnected", account: null });
  });
});

describe("the twelfth review round (B12-2, VB12-N1): a tap while an end is at its relay", () => {
  /** the end's acknowledgement held until released: the session stays in the store meanwhile, as the sign client keeps it */
  const holdEnd = () => {
    let release!: () => void;
    sc.endGate = new Promise<void>((r) => (release = r));
    sc.releaseEnd = () => release();
    return () => release();
  };
  const settleSoon = () => new Promise((r) => setTimeout(r, 30));

  it("WalletConnect tapped again while a Disconnect's end waits on its relay: the tap waits for it — then a new pairing, never the session being ended", async () => {
    configureWalletConnect("a-project-id");
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    expect((await first).status).toBe("connected");
    const release = holdEnd();
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects, "the delete published, its acknowledgement awaited").toBe(1));
    expect(sc.sessions, "the session still in the store").toHaveLength(1);
    const again = connection.connect("walletconnect");
    await settleSoon();
    expect(connection.get(), "waiting for the end: nothing taken up").toMatchObject({ status: "connecting", account: null, pairing: null });
    expect(sc.inits, "no provider made while the end is under way").toBe(1);
    release();
    await pairingShown(2);
    expect(sc.inits, "a new provider once it ended").toBe(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("a late approval's end — a provider forgotten before its session was — is waited for too: then a new pairing", async () => {
    configureWalletConnect("a-project-id");
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    await endWalletConnect(); // the provider forgotten (a Forget) before its pairing was approved
    const before = sc.disconnects;
    const release = holdEnd();
    lastPairing().approve(); // approved after all: its session ended at its relay, the provider no longer the page's
    await run;
    await vi.waitFor(() => expect(sc.disconnects, "its end at the relay").toBe(before + 1));
    expect(sc.sessions, "the late session still in the store, its end awaited").toHaveLength(1);
    const again = connection.connect("walletconnect");
    await settleSoon();
    expect(connection.get(), "waiting for that end: nothing taken up").toMatchObject({ status: "connecting", account: null, pairing: null });
    release();
    await pairingShown(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("the usual late approval — after its Cancel, the provider still the page's — ends as a Disconnect does: a tap meanwhile waits, then pairs anew", async () => {
    configureWalletConnect("a-project-id");
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    const release = holdEnd();
    lastPairing().approve(); // approved after its Cancel: its session ended (endWalletConnectOf → endWalletConnect)
    await run;
    await vi.waitFor(() => expect(sc.disconnects, "its end at the relay").toBe(1));
    const again = connection.connect("walletconnect");
    await settleSoon();
    expect(connection.get(), "waiting for that end: nothing taken up").toMatchObject({ status: "connecting", account: null, pairing: null });
    expect(sc.inits, "no provider made meanwhile").toBe(1);
    release();
    await pairingShown(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("an end whose delete is never acknowledged (its unsubscribe unanswered, its socket gone) is bounded: past it the keys are cleared and the tap pairs anew — never Connecting… for good", async () => {
    configureWalletConnect("a-project-id");
    sc.sessionsInStore = true;
    walletConnectEndTiming.boundMs = 200;
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first;
    holdEnd(); // never released within the test: the relay never answers
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    const again = connection.connect("walletconnect");
    await settleSoon();
    expect(connection.get(), "within the bound: waiting").toMatchObject({ status: "connecting", account: null, pairing: null });
    await pairingShown(2); // the bound passed: the keys cleared, a new provider, a new pairing
    expect(connection.get().account, "never the session being ended").toBeNull();
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("a late end never acknowledged is bounded too: past it the shared store's keys go while the page holds no other connection, and the tap pairs anew", async () => {
    configureWalletConnect("a-project-id");
    sc.sessionsInStore = true;
    walletConnectEndTiming.boundMs = 200;
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    await endWalletConnect(); // the provider forgotten before its pairing was approved
    const before = sc.disconnects;
    holdEnd(); // its late end never acknowledged
    lastPairing().approve();
    await run;
    await vi.waitFor(() => expect(sc.disconnects).toBe(before + 1));
    expect(sc.sessions, "the late session in the store").toHaveLength(1);
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    expect(sc.sessions, "its keys cleared past the bound").toHaveLength(0);
    expect(connection.get().account).toBeNull();
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("the bound sits just past the library's own on the delete's publish (60 s): never below it, never far past it", () => {
    expect(END_BOUND, "past the library's 60 s: its own retries of the delete never cut short").toBeGreaterThan(60_000);
    expect(END_BOUND, "and a tap on Connecting… no longer than that").toBeLessThanOrEqual(65_000);
  });

  it("a late end past its bound leaves the shared store alone while a provider's init is under way — the keys it is about to read", async () => {
    configureWalletConnect("a-project-id");
    walletConnectEndTiming.boundMs = 100;
    let releaseInit!: () => void;
    sc.initGate = new Promise<void>((r) => (releaseInit = r));
    const init = walletConnectProvider(1); // an init under way (the library's chunk still loading)
    await vi.waitFor(() => expect(sc.inits).toBe(1));
    const removed: string[] = [];
    const forgotten = {
      disconnect: () => new Promise<void>(() => undefined), // its delete never acknowledged
      signer: { client: { core: { storage: { getKeys: async () => ["a-key"], removeItem: async (k: string) => void removed.push(k) } } } },
    } as unknown as WcProvider;
    await endWalletConnectOf(forgotten);
    expect(removed, "the store left alone while the init is under way").toEqual([]);
    releaseInit();
    expect(await init).not.toBeNull();
  });

  it("a late end past its bound leaves the shared store alone while the page holds another WalletConnect connection — whose keys it holds too", async () => {
    configureWalletConnect("a-project-id");
    walletConnectEndTiming.boundMs = 100;
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first; // a connection the page holds
    const removed: string[] = [];
    const forgotten = {
      disconnect: () => new Promise<void>(() => undefined), // its delete never acknowledged
      signer: { client: { core: { storage: { getKeys: async () => ["a-key"], removeItem: async (k: string) => void removed.push(k) } } } },
    } as unknown as WcProvider;
    await endWalletConnectOf(forgotten);
    expect(removed, "the held connection's keys kept").toEqual([]);
    await endWalletConnect(); // nothing held any more
    await endWalletConnectOf(forgotten);
    expect(removed, "nothing else held: its keys cleared past the bound").toEqual(["a-key"]);
  });

  it("an end begun while a tap waits for another — a late approval's during a Disconnect's — is waited for as well, before any provider is made", async () => {
    configureWalletConnect("a-project-id");
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first;
    const releaseEnd = holdEnd();
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    const inits = sc.inits;
    const tap = walletConnectProvider(1); // waits for the Disconnect's end
    let releaseLate!: () => void;
    const late = new Promise<void>((r) => (releaseLate = r));
    void endWalletConnectOf({ disconnect: () => late } as unknown as WcProvider); // a provider forgotten before: its session's end begins now
    releaseEnd();
    await settleSoon();
    expect(sc.inits, "the Disconnect's end over, the late one still under way: nothing made yet").toBe(inits);
    releaseLate();
    expect(await tap, "a provider once both ended").not.toBeNull();
    expect(sc.inits).toBe(inits + 1);
  });

  it("a second Disconnect while the first one's end waits (VB12-N1): nothing was taken up meanwhile — the next tap pairs anew", async () => {
    configureWalletConnect("a-project-id");
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first;
    const release = holdEnd();
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    void connection.connect("walletconnect"); // a tap meanwhile, waiting for the end
    await settleSoon();
    expect(sc.inits, "nothing made during the end").toBe(1);
    connection.disconnect(); // the second Disconnect drops that tap
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null });
    release();
    await vi.waitFor(() => expect(sc.sessions, "the session ended").toHaveLength(0));
    const next = connection.connect("walletconnect");
    await vi.waitFor(() => expect(connection.get().pairing, "a new pairing, never the ended session").not.toBeNull());
    expect(connection.get().account).toBeNull();
    lastPairing().approve();
    expect((await next).status).toBe("connected");
  });
});
