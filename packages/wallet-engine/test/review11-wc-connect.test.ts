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
  /** while set, the sign client's disconnect fails (offline, its publish expired) — once its held answer comes, when held: the delete never
   *  acknowledged */
  endFails: false,
  /** the latest sign client's storage (the page's one Core) */
  store: null as Map<string, unknown> | null,
}));
const HISTORY_KEY = "wc@2:core:0.3//history";
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
  sc.store = store;
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
      if (sc.endFails) throw new Error("Failed to publish payload, please try again.");
      if (sc.sessionsInStore) store.set(HISTORY_KEY, "the delete's own records"); // as the library writes its history at a delete
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
  WalletConnectEndUnfinished,
  WalletConnectSessionLeft,
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
/** The end's answer held until released: the session stays in the store meanwhile, as the sign client keeps it. */
const holdEnd = () => {
  let release!: () => void;
  sc.endGate = new Promise<void>((r) => (release = r));
  sc.releaseEnd = () => release();
  return () => release();
};
/** The refusal while an earlier end's delete is acknowledged but unfinished. */
const UNFINISHED = new WalletConnectEndUnfinished().message;

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
  sc.endFails = false;
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
    // ended as a Disconnect ends one: its session deleted, the next connection a new pairing on the page's one provider (12d3c)
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    expect(sc.inits, "the page's one provider").toBe(1);
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

  it("the provider's init is one at a time, and its provider the page's one — kept through an end, one under way during its init too (12d3c)", async () => {
    configureWalletConnect("a-project-id");
    const [p1, p2] = await Promise.all([walletConnectProvider(1), walletConnectProvider(1)]);
    expect(p1).toBe(p2);
    expect(sc.inits).toBe(1);
    await endWalletConnect();
    expect(await walletConnectProvider(1), "kept through an end: never a second sign client over the page's one Core").toBe(p1);
    expect(sc.inits).toBe(1);
    resetWalletConnect(); // a new page
    sc.sessions = [session]; // the init about to be ended takes up a session WalletConnect's store holds
    const making = walletConnectProvider(1);
    const ended = endWalletConnect(); // ended while its init is under way
    const made = await making;
    await ended;
    expect(sc.inits).toBe(2);
    expect(sc.disconnects, "the session the init took up is ended at its relay").toBe(1);
    expect(await walletConnectProvider(1), "the provider made during the end is the page's").toBe(made);
    expect(sc.inits).toBe(2);
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
  const settleSoon = () => new Promise((r) => setTimeout(r, 30));

  it("WalletConnect tapped again while a Disconnect's end waits on its relay: the tap waits for it — then a new pairing on the page's one provider, never the session being ended", async () => {
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
    release();
    await pairingShown(2);
    expect(sc.inits, "the page's one provider, paired anew (12d3c)").toBe(1);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("a late approval's end after an end during its pairing — the page's provider ended again — is waited for too: then a new pairing", async () => {
    configureWalletConnect("a-project-id");
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    await endWalletConnect(); // an end (a Forget) before its pairing was approved: the page's provider kept, nothing to delete
    const before = sc.disconnects;
    const release = holdEnd();
    lastPairing().approve(); // approved after all: its session ended at its relay, as a Disconnect ends one
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

  it("the usual late approval — after its Cancel — ends as a Disconnect does: a tap meanwhile waits, then pairs anew", async () => {
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

  it("an end whose delete goes unanswered is bounded: past it the keys are cleared; a tap meanwhile waits, then reads the refusal — never a second delete beside the first, nor a pairing over it — and once that delete completes the next tap pairs anew, its session kept", async () => {
    configureWalletConnect("a-project-id");
    sc.sessionsInStore = true;
    walletConnectEndTiming.boundMs = 1_000;
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first;
    const release = holdEnd(); // answered only past its bound: the library then finishes that delete, its cleanup run on the provider
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    sc.endGate = null; // a second delete would be answered at once
    const tap = connection.connect("walletconnect");
    await settleSoon();
    expect(connection.get(), "within the bound: waiting").toMatchObject({ status: "connecting", account: null, pairing: null });
    const st = await tap; // the bound passed, the keys cleared — the first delete still under way
    expect(st).toMatchObject({ status: "disconnected", account: null, pairing: null });
    expect(st.error).toBe(UNFINISHED);
    expect(sc.disconnects, "no second delete beside the first").toBe(1);
    expect(sc.connectCalls, "no pairing over it").toBe(1);
    const t0 = Date.now();
    const st2 = await connection.connect("walletconnect");
    expect(st2.error, "a tap past that delete's bound: the refusal at once, no second wait").toBe(st.error);
    expect(Date.now() - t0).toBeLessThan(500);
    release(); // answered at last
    await settleSoon();
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
    await settleSoon();
    expect(sc.disconnects, "nothing more sent: that session was gone").toBe(1);
    expect((connection.provider() as WcProvider).session, "the new session kept on the provider").toBeDefined();
  });

  it("an end whose unsubscribe's answer never comes — lost with a socket that dropped —: every tap refused, at the bound, then at once, after online and after the wallet app's own end too; never a second delete, never a pairing (stated: a reload is the way out)", async () => {
    configureWalletConnect("a-project-id");
    walletConnectEndTiming.boundMs = 200;
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first;
    holdEnd(); // never answered within the test
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    sc.endGate = null; // a second delete would be answered at once
    expect((await connection.connect("walletconnect")).error, "at the bound").toBe(UNFINISHED);
    expect((await connection.connect("walletconnect")).error, "at once after it").toBe(UNFINISHED);
    window.dispatchEvent(new Event("online"));
    await settleSoon();
    expect((await connection.connect("walletconnect")).error, "after online").toBe(UNFINISHED);
    await walletEnds(); // the wallet app's own end: the provider's cleanup ran, the first delete still under way
    await settleSoon();
    expect((await connection.connect("walletconnect")).error, "after the wallet app's own end").toBe(UNFINISHED);
    expect(sc.disconnects, "never a second delete").toBe(1);
    expect(sc.connectCalls, "never a pairing").toBe(1);
  });

  it("a Forget's end while an end is unfinished joins its disconnect: settled at once past the bound, never a second delete beside it, every tap still refused", async () => {
    configureWalletConnect("a-project-id");
    walletConnectEndTiming.boundMs = 1_000;
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first;
    holdEnd(); // never answered within the test
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    sc.endGate = null; // a second delete would be answered at once
    await new Promise((r) => setTimeout(r, 1_200)); // past its bound: the end over, its disconnect still under way
    const t0 = Date.now();
    await endWalletConnect(); // the Forget's end (a dev build: no restart after it)
    expect(Date.now() - t0, "settled at once").toBeLessThan(500);
    expect(sc.disconnects, "never a second delete beside the one under way").toBe(1);
    expect((await connection.connect("walletconnect")).error).toBe(UNFINISHED);
    expect(sc.connectCalls, "never a pairing").toBe(1);
  });

  it("an end past its bound whose delete then fails, nothing held or being made: never sent again online — only a tap, or a later end, deletes it again", async () => {
    configureWalletConnect("a-project-id");
    sc.sessionsInStore = true;
    walletConnectEndTiming.boundMs = 200;
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first;
    const release = holdEnd(); // answered past its bound, and refused
    connection.disconnect();
    await vi.waitFor(() => expect(sc.sessions, "the bound passed: its keys cleared").toHaveLength(0));
    sc.endFails = true;
    release();
    await settleSoon();
    sc.endFails = false; // the relay would answer now
    window.dispatchEvent(new Event("online"));
    await settleSoon();
    expect(sc.disconnects, "never sent again online (the owner's decision: at a tap, or by a later end)").toBe(1);
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    expect(sc.disconnects, "deleted again at the tap, before its pairing").toBe(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
    await settleSoon();
    expect(sc.disconnects, "and nothing more").toBe(2);
  });

  it("a late approval's end past its bound is a Disconnect's: a tap meanwhile reads the refusal, and once that delete completes the next tap pairs anew", async () => {
    configureWalletConnect("a-project-id");
    sc.sessionsInStore = true;
    walletConnectEndTiming.boundMs = 200;
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    const release = holdEnd(); // the late session's delete answered only past its bound
    lastPairing().approve();
    await run;
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    sc.endGate = null;
    const st = await connection.connect("walletconnect");
    expect(st.error, "the refusal while that delete is under way").toBe(UNFINISHED);
    expect(st.account, "never the late session").toBeNull();
    expect(sc.connectCalls, "no pairing over it").toBe(1);
    release();
    await settleSoon();
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
    await settleSoon();
    expect(sc.disconnects, "nothing more sent").toBe(1);
  });

  it("the bound sits just past the library's own on the delete's publish (60 s): never below it, never far past it", () => {
    expect(END_BOUND, "past the library's 60 s: its own retries of the delete never cut short").toBeGreaterThan(60_000);
    expect(END_BOUND, "and a tap on Connecting… no longer than that").toBeLessThanOrEqual(65_000);
  });

  it("a provider not the page's — none since one provider per page — has its session ended and nothing else: the shared store left alone", async () => {
    configureWalletConnect("a-project-id");
    const removed: string[] = [];
    let ends = 0;
    const other = {
      disconnect: async () => void ends++,
      signer: { client: { core: { storage: { getKeys: async () => ["a-key"], removeItem: async (k: string) => void removed.push(k) } } } },
    } as unknown as WcProvider;
    await endWalletConnectOf(other);
    expect(ends).toBe(1);
    expect(removed).toEqual([]);
    const refusing = { disconnect: async () => Promise.reject(new Error("refused")) } as unknown as WcProvider;
    const t0 = Date.now();
    await endWalletConnectOf(refusing);
    expect(Date.now() - t0, "a refused end settles at once, never at the bound").toBeLessThan(1_000);
  });

  it("a second tap while the first deletes again what an earlier end left waits for it: one delete, one provider", async () => {
    configureWalletConnect("a-project-id");
    const first = connection.connect("walletconnect");
    await pairingShown(1);
    lastPairing().approve();
    await first;
    sc.endFails = true;
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await settleSoon(); // the end over, its delete failed
    sc.endFails = false;
    const release = holdEnd(); // the delete again, held
    const a = walletConnectProvider(1);
    const b = walletConnectProvider(1);
    let handed = false;
    void a.then(() => (handed = true));
    await vi.waitFor(() => expect(sc.disconnects, "one delete again").toBe(2));
    await settleSoon();
    expect(handed, "no provider handed out while its session is deleted again").toBe(false);
    release();
    const [pa, pb] = await Promise.all([a, b]);
    expect(pa).toBe(pb);
    expect(sc.disconnects, "one delete for both taps").toBe(2);
    expect(sc.inits).toBe(1);
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
    expect(connection.get(), "the tap waiting for the end: nothing taken up").toMatchObject({ status: "connecting", account: null, pairing: null });
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

describe("the twelfth review round (B12-3; 12d3c): an end its relay does not complete, deleted again at the next tap", () => {
  const settleSoon = () => new Promise((r) => setTimeout(r, 30));
  async function connected(n: number) {
    const run = connection.connect("walletconnect");
    await pairingShown(n);
    lastPairing().approve();
    expect((await run).status).toBe("connected");
  }

  it("a Disconnect whose delete fails: its keys cleared, never sent again online; the next tap deletes it again before it pairs — then a new pairing on the same provider", async () => {
    configureWalletConnect("a-project-id");
    sc.sessionsInStore = true;
    await connected(1);
    sc.endFails = true;
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await vi.waitFor(() => expect(sc.sessions, "its keys cleared all the same").toHaveLength(0));
    sc.endFails = false;
    window.dispatchEvent(new Event("online"));
    await settleSoon();
    expect(sc.disconnects, "never sent again online (the owner's decision: at a tap, or by a later end)").toBe(1);
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    expect(sc.disconnects, "deleted again at the tap, before its pairing").toBe(2);
    expect(sc.store?.has(HISTORY_KEY), "what the library wrote at that delete, cleared").toBe(false);
    expect(sc.inits, "the page's one provider").toBe(1);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
    await settleSoon();
    expect(sc.disconnects, "and nothing more").toBe(2);
  });

  it("still failing at the next tap: the connection reads the refusal, its cause kept — never the session taken up, never a pairing beside it", async () => {
    configureWalletConnect("a-project-id");
    await connected(1);
    sc.endFails = true;
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await settleSoon();
    const st = await connection.connect("walletconnect");
    expect(sc.disconnects, "deleted again once at the tap").toBe(2);
    expect(st).toMatchObject({ status: "disconnected", account: null, pairing: null });
    expect(st.error).toBe(new WalletConnectSessionLeft("Failed to publish payload, please try again.").message);
    expect(sc.connectCalls, "no pairing beside the session left").toBe(1);
  });

  it("an end while a failed one's session is left — a Forget's — deletes it at its relay: none left on the provider, its keys cleared, and the next tap pairs with no delete again", async () => {
    configureWalletConnect("a-project-id");
    sc.sessionsInStore = true;
    await connected(1);
    const provider = connection.provider() as WcProvider;
    sc.endFails = true;
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await settleSoon(); // its delete failed: the session left on the provider
    sc.endFails = false; // back online
    await endWalletConnect(); // the Forget's end
    expect(sc.disconnects, "the left session deleted at its relay").toBe(2);
    expect(provider.session, "none left on the provider").toBeUndefined();
    expect(sc.store?.has(HISTORY_KEY), "its keys cleared, what the library wrote at that delete among them").toBe(false);
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    expect(sc.disconnects, "no delete again at the tap").toBe(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("a failed end, then the tap's delete again acknowledged but unfinished past its own bound: that tap waits its bound and reads the unfinished refusal — never the failed one's words, never a pairing beside it —, the next tap at once; once answered, the next tap pairs, nothing more sent", async () => {
    configureWalletConnect("a-project-id");
    walletConnectEndTiming.boundMs = 1_000;
    await connected(1);
    sc.endFails = true;
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await settleSoon(); // the end over, its delete failed: the session left on the provider
    sc.endFails = false;
    const release = holdEnd(); // the delete again acknowledged, its unsubscribe unanswered
    const t0 = Date.now();
    const st = await connection.connect("walletconnect");
    expect(Date.now() - t0, "it waited that delete again's bound").toBeGreaterThanOrEqual(900);
    expect(sc.disconnects, "deleted again once at the tap").toBe(2);
    expect(st.error, "the unfinished refusal — not the failed one's words").toBe(UNFINISHED);
    expect(sc.connectCalls, "no pairing beside the delete again under way").toBe(1);
    sc.endGate = null; // a third delete would be answered at once
    const t1 = Date.now();
    expect((await connection.connect("walletconnect")).error).toBe(UNFINISHED);
    expect(Date.now() - t1, "at once").toBeLessThan(500);
    expect(sc.disconnects, "never a third delete beside it").toBe(2);
    release(); // answered at last
    await settleSoon();
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
    await settleSoon();
    expect(sc.disconnects, "nothing more sent").toBe(2);
  });

  it("a Forget's end that meets a tap's delete again under way waits for it — refused, its keys cleared all the same: nothing the session wrote back is left", async () => {
    configureWalletConnect("a-project-id");
    await connected(1);
    sc.endFails = true;
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await settleSoon(); // its delete failed: the session left on the provider, its keys cleared
    sc.store!.set(HISTORY_KEY, "a ping's records, the account among them"); // the session's sign client answers the wallet app's ping
    const release = holdEnd(); // the tap's delete again held, then refused (still offline)
    const tap = connection.connect("walletconnect");
    await vi.waitFor(() => expect(sc.disconnects, "deleted again at the tap").toBe(2));
    const forget = endWalletConnect(); // the Forget's end meets it
    release();
    await forget;
    expect([...sc.store!.keys()], "nothing left in WalletConnect's store").toEqual([]);
    expect((await tap).error).toBe(new WalletConnectSessionLeft("Failed to publish payload, please try again.").message);
  });

  it("the refusal carries the latest cause: an end past its bound, its delete then refused, and the tap's delete again refused too", async () => {
    configureWalletConnect("a-project-id");
    walletConnectEndTiming.boundMs = 200;
    await connected(1);
    const release = holdEnd();
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await new Promise((r) => setTimeout(r, 300)); // past its bound: the keys cleared, the session left, its delete still under way
    sc.endFails = true;
    release(); // then refused
    await settleSoon();
    const st = await connection.connect("walletconnect");
    expect(sc.disconnects, "deleted again at the tap").toBe(2);
    expect(st.error, "the delete again's own cause, not the first's").toBe(
      new WalletConnectSessionLeft("Failed to publish payload, please try again.").message,
    );
  });

  it("the wallet app's own end during the delete again — that delete then refused, its session gone from the provider all the same — is a delete: the tap pairs", async () => {
    configureWalletConnect("a-project-id");
    await connected(1);
    sc.endFails = true;
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await settleSoon(); // the end over, its delete failed: the session left on the provider
    const release = holdEnd(); // the delete again held, then refused
    const again = connection.connect("walletconnect");
    await vi.waitFor(() => expect(sc.disconnects, "deleted again at the tap").toBe(2));
    await walletEnds(); // meanwhile the wallet app ends that session: the provider's cleanup runs
    await settleSoon();
    release(); // the delete again refused: the session no longer at the relay
    await pairingShown(2);
    expect(connection.get().error, "never the refusal").toBeNull();
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });

  it("a late approval's end whose delete fails is a Disconnect's: its keys cleared — the next tap never takes it up — and deleted again at that tap before it pairs", async () => {
    configureWalletConnect("a-project-id");
    sc.sessionsInStore = true;
    const run = connection.connect("walletconnect");
    await pairingShown(1);
    connection.cancel();
    sc.endFails = true;
    lastPairing().approve(); // approved after its Cancel: its delete fails at once (offline)
    await run;
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await vi.waitFor(() => expect(sc.sessions, "its keys cleared").toHaveLength(0));
    sc.endFails = false;
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    expect(sc.disconnects, "deleted again at the tap").toBe(2);
    expect(connection.get().account, "never the late session").toBeNull();
    lastPairing().approve();
    expect((await again).status).toBe("connected");
    await settleSoon();
    expect(sc.disconnects, "and nothing more").toBe(2);
  });

  it("a session the wallet app ended meanwhile — nothing left to delete — is not sent again: the next tap pairs at once", async () => {
    configureWalletConnect("a-project-id");
    await connected(1);
    sc.endFails = true;
    connection.disconnect();
    await vi.waitFor(() => expect(sc.disconnects).toBe(1));
    await settleSoon();
    sc.endFails = false;
    await walletEnds(); // the wallet app's own end of that session: the provider's cleanup ran
    const again = connection.connect("walletconnect");
    await pairingShown(2);
    expect(sc.disconnects, "nothing to delete again").toBe(1);
    lastPairing().approve();
    expect((await again).status).toBe("connected");
  });
});
