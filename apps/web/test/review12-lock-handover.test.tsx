// @vitest-environment happy-dom
// The twelfth review round (B12-1): a lock while the connector picker shows a WalletConnect pairing hands the pairing to the root's own
// sheet over the lock screen (pairingHost; docs/mobile-web-gate.md §6, scenario 12) — and its history entry with it. The picker had gone
// back while the root sheet pushed in the same task; the traversal's popstate, a task later, closed the root sheet and cancelled the
// pairing, so the approval given in the wallet app was ended at its relay — once the root sheet's chunk had loaded in the page (any earlier
// root sheet, or the first hand-over). happy-dom's history.back() is a full navigation with no popstate: window.history is a model of a
// browser's same-document history here — push and replace synchronous, back() a traversal queued for a later task that fires popstate (the
// reviewers' probes, checked against Chrome). Over the memory router (renderApp) only the sheets touch window.history, and the root sheet
// takes the picker's entry; over the production router (createBrowserRouter, as App.tsx) the Gate's replace at the lock takes it first and
// the root sheet pushes its own — the picker's entry left behind, one Back press on Home that does nothing (stated; the critique of 12d2).
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";

const wc = vi.hoisted(() => ({
  handlers: new Map<string, Set<(...a: unknown[]) => void>>(),
  settle: null as null | { approve(): void; refuse(e: unknown): void },
  session: false,
  disconnects: 0,
  /** the library's load held until released (a lock while it is still loading) */
  initGate: null as null | Promise<void>,
}));
vi.mock("@walletconnect/ethereum-provider", () => ({
  EthereumProvider: {
    init: async () => {
      if (wc.initGate) await wc.initGate;
      const emit = (event: string, ...a: unknown[]) => {
        for (const h of wc.handlers.get(event) ?? []) h(...a);
      };
      const accounts = () => {
        if (!wc.session) throw new Error("Please call connect() before request()");
        return ["0x7a3b000000000000000000000000000000c491f2"];
      };
      return {
        isWalletConnect: true,
        on: (event: string, h: (...a: unknown[]) => void) => void (wc.handlers.get(event) ?? wc.handlers.set(event, new Set()).get(event)!).add(h),
        removeListener: (event: string, h: (...a: unknown[]) => void) => void wc.handlers.get(event)?.delete(h),
        request: async ({ method }: { method: string }) =>
          method === "eth_chainId" ? "0x1" : method === "eth_requestAccounts" ? accounts() : method === "eth_accounts" ? (wc.session ? accounts() : []) : null,
        enable: async () => {
          if (!wc.session)
            await new Promise<void>((resolve, reject) => {
              wc.settle = {
                approve: () => {
                  wc.session = true;
                  resolve();
                },
                refuse: reject,
              };
              emit("display_uri", "wc:a-pairing@2?relay-protocol=irn&symKey=00");
            });
          return accounts();
        },
        disconnect: async () => {
          wc.disconnects++;
          wc.session = false;
        },
      };
    },
  },
}));

import { connection, discover } from "@privacy-wallet/wallet-engine/connection";
import { configureWalletConnect, resetWalletConnect } from "@privacy-wallet/wallet-engine/walletConnect";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { prefs } from "../src/storage/prefs";
import { renderApp, settle } from "./helpers/render";
import { buildRoutes, PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";

const LAZY = { timeout: 15_000 };
/** What the sheets did to the history, in order */
const log: string[] = [];
const real = { window: Object.getOwnPropertyDescriptor(window, "history"), global: Object.getOwnPropertyDescriptor(globalThis, "history") };
function installAsyncHistory() {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "http://localhost/" }];
  let index = 0;
  const resolve = (url?: string | URL | null) => (url === undefined || url === null || url === "" ? entries[index].url : new URL(String(url), entries[index].url).href);
  const model = {
    get state() {
      return entries[index].state;
    },
    get length() {
      return entries.length;
    },
    scrollRestoration: "auto",
    pushState(state: unknown, _title?: string, url?: string | URL | null) {
      const u = resolve(url);
      entries.length = index + 1;
      entries.push({ state: JSON.parse(JSON.stringify(state ?? null)), url: u });
      index++;
      log.push(`push ${JSON.stringify(state)}`);
    },
    replaceState(state: unknown, _title?: string, url?: string | URL | null) {
      entries[index] = { state: JSON.parse(JSON.stringify(state ?? null)), url: resolve(url) };
      log.push(`replace ${JSON.stringify(state)}`);
    },
    back() {
      const target = index - 1; // the target taken as back() is called, the traversal a task later (a browser's)
      log.push(`back() from ${JSON.stringify(entries[index].state)}`);
      setTimeout(() => {
        if (target >= 0 && entries[target]) {
          index = target;
          log.push(`popstate -> ${JSON.stringify(entries[index].state)}`);
          window.dispatchEvent(new PopStateEvent("popstate", { state: entries[index].state }));
        }
      }, 0);
    },
    forward() {},
    go() {},
  };
  Object.defineProperty(window, "history", { value: model, configurable: true });
  Object.defineProperty(globalThis, "history", { value: model, configurable: true });
  // the production router's own window: the model's history and location, the real window's events and document
  const routerWindow = {
    history: model,
    get location() {
      return new URL(entries[index].url);
    },
    document: window.document,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    scrollTo() {},
  } as unknown as Window;
  return { entries: () => entries.length, index: () => index, current: () => entries[index].state, routerWindow };
}

beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
});
afterEach(() => {
  session.forget();
  settings.reset();
  prefs().reset();
  connection.reset();
  configureWalletConnect(undefined);
  resetWalletConnect();
  wc.handlers.clear();
  wc.settle = null;
  wc.session = false;
  wc.disconnects = 0;
  wc.initGate = null;
  log.length = 0;
  delete (window as unknown as Record<string, unknown>).ethereum;
  if (real.window) Object.defineProperty(window, "history", real.window);
  if (real.global) Object.defineProperty(globalThis, "history", real.global);
});
const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
};

/** Home's chip → the picker → WalletConnect, its code shown; then the lock (a pagehide at the switch to the wallet app, an idle lock) */
async function pairInPickerThenLock(): Promise<void> {
  fireEvent.click(await screen.findByTestId("home-wallet", {}, LAZY));
  const picker = await screen.findByTestId("connect-sheet");
  fireEvent.click(within(picker).getByTestId("connector-walletconnect"));
  await within(picker).findByTestId("connect-qr", {}, LAZY);
  expect(connection.get().pairing).not.toBeNull();
  log.push("--- lock ---");
  await act(async () => {
    session.lock();
  });
  await ticks();
}
const afterLock = () => log.slice(log.indexOf("--- lock ---") + 1);

describe("a lock while the picker shows a WalletConnect pairing (the twelfth review round, B12-1)", () => {
  for (const which of ["the page's first hand-over (the root sheet's chunk not loaded yet)", "a later hand-over (the root sheet shown before in this page)"]) {
    it(`${which}: the pairing goes on in its own sheet over the lock screen — over the memory router on the picker's own history entry — and its approval connects`, async () => {
      configureWalletConnect("a-project-id");
      await session.create("a strong password");
      session.acknowledgePhrase();
      const h = installAsyncHistory();
      await renderApp("/");
      await screen.findByTestId("home", {}, LAZY);
      await pairInPickerThenLock();
      await screen.findByTestId("lock-screen", {}, LAZY);
      const sheet = await screen.findByTestId("pairing-sheet", {}, LAZY);
      await within(sheet).findByTestId("connect-qr");
      await ticks();
      expect(afterLock().filter((l) => l.startsWith("back()") || l.startsWith("popstate")), "no back(), no traversal").toEqual([]);
      expect(afterLock().filter((l) => l.startsWith("push")), "the picker's entry adopted, none pushed").toEqual([]);
      expect(h.current(), "the entry the pairing sheet's").toMatchObject({ dsSheet: "pairing" });
      expect((h.current() as { dsHandOver?: boolean }).dsHandOver).toBeUndefined();
      expect(connection.get().pairing, "the pairing goes on").not.toBeNull();
      act(() => wc.settle!.approve()); // the user approves in the wallet app
      await waitFor(() => expect(connection.get().status).toBe("connected"));
      await ticks();
      expect(wc.disconnects, "the approved session is kept").toBe(0);
      expect(screen.queryByTestId("pairing-sheet"), "connected: the sheet gone").toBeNull();
      expect(log.filter((l) => l.startsWith("back()")), "its own entry popped as it closed").toHaveLength(1);
    });
  }

  it("a lock while WalletConnect's library still loads in the picker (no code yet): the wait goes on in the root sheet on the picker's entry, then its code, then the approval", async () => {
    configureWalletConnect("a-project-id");
    await session.create("a strong password");
    session.acknowledgePhrase();
    const h = installAsyncHistory();
    let release!: () => void;
    wc.initGate = new Promise<void>((r) => (release = r));
    await renderApp("/");
    await screen.findByTestId("home", {}, LAZY);
    fireEvent.click(await screen.findByTestId("home-wallet", {}, LAZY));
    const picker = await screen.findByTestId("connect-sheet");
    fireEvent.click(within(picker).getByTestId("connector-walletconnect"));
    await waitFor(() => expect(connection.get().pending?.kind).toBe("walletconnect"));
    expect(connection.get().pairing, "its code not shown yet").toBeNull();
    log.push("--- lock ---");
    await act(async () => {
      session.lock();
    });
    await ticks();
    await screen.findByTestId("lock-screen", {}, LAZY);
    const sheet = await screen.findByTestId("pairing-sheet", {}, LAZY);
    await within(sheet).findByTestId("connect-connecting");
    expect(afterLock().filter((l) => l.startsWith("back()") || l.startsWith("popstate") || l.startsWith("push")), "handed over: no back(), no push").toEqual([]);
    expect(h.current()).toMatchObject({ dsSheet: "pairing" });
    await act(async () => {
      release();
    });
    await within(await screen.findByTestId("pairing-sheet", {}, LAZY)).findByTestId("connect-qr", {}, LAZY);
    act(() => wc.settle!.approve());
    await waitFor(() => expect(connection.get().status).toBe("connected"));
    expect(wc.disconnects).toBe(0);
  });

  it("the production router (createBrowserRouter): no traversal at the lock either — the Gate's replace takes the picker's entry, the root sheet pushes its own; the pairing kept and approved; the picker's entry left behind (stated)", async () => {
    configureWalletConnect("a-project-id");
    await session.create("a strong password");
    session.acknowledgePhrase();
    const h = installAsyncHistory();
    const router = createBrowserRouter(buildRoutes({ preview: false }), { future: ROUTER_FUTURE, window: h.routerWindow });
    render(<RouterProvider router={router} future={PROVIDER_FUTURE} />);
    await act(async () => {
      await session.ready;
    });
    await settle(router);
    await screen.findByTestId("home", {}, LAZY);
    await pairInPickerThenLock();
    await screen.findByTestId("lock-screen", {}, LAZY);
    await within(await screen.findByTestId("pairing-sheet", {}, LAZY)).findByTestId("connect-qr", {}, LAZY);
    await ticks();
    expect(afterLock().filter((l) => l.startsWith("back()") || l.startsWith("popstate")), "no back(), no traversal").toEqual([]);
    expect(afterLock().filter((l) => l.startsWith("push")), "the root sheet's own entry, over the router's").toHaveLength(1);
    act(() => wc.settle!.approve());
    await waitFor(() => expect(connection.get().status).toBe("connected"));
    await ticks(10);
    expect(wc.disconnects, "the approved session kept").toBe(0);
    expect(screen.queryByTestId("pairing-sheet")).toBeNull();
    await act(async () => {
      await session.unlock("a strong password");
    });
    await screen.findByTestId("home", {}, LAZY);
    await ticks(5);
    // stated (the critique of 12d2): the picker's entry, the router's since the lock, stays behind — one Back press on Home stays on Home
    const at = h.index();
    act(() => {
      window.history.back();
    });
    await ticks(5);
    expect(h.index(), "one entry back").toBe(at - 1);
    expect(router.state.location.pathname, "and still Home: the entry left behind").toBe("/");
  });

  it("the back button over the root sheet the pairing was handed to closes it — the pairing cancelled, its entry popped by that press alone", async () => {
    configureWalletConnect("a-project-id");
    await session.create("a strong password");
    session.acknowledgePhrase();
    installAsyncHistory();
    await renderApp("/");
    await screen.findByTestId("home", {}, LAZY);
    await pairInPickerThenLock();
    await screen.findByTestId("pairing-sheet", {}, LAZY);
    await ticks();
    log.push("--- back ---");
    act(() => {
      window.history.back(); // the user's back press
    });
    await ticks();
    const after = log.slice(log.indexOf("--- back ---") + 1);
    expect(screen.queryByTestId("pairing-sheet"), "closed by the back button").toBeNull();
    expect(connection.get().pairing, "the pairing cancelled").toBeNull();
    expect(after.filter((l) => l.startsWith("back()")), "the press alone").toHaveLength(1);
  });

  it("the picker closed over a browser wallet's prompt, still open: back() as ever, nothing handed over — its approval still connects", async () => {
    configureWalletConnect("a-project-id");
    let answer!: (a: string[]) => void;
    const answered = new Promise<string[]>((r) => (answer = r));
    (window as unknown as Record<string, unknown>).ethereum = {
      request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? answered : method === "eth_chainId" ? "0x1" : null),
      on: () => undefined,
      removeListener: () => undefined,
    };
    discover();
    await session.create("a strong password");
    session.acknowledgePhrase();
    installAsyncHistory();
    await renderApp("/");
    await screen.findByTestId("home", {}, LAZY);
    fireEvent.click(await screen.findByTestId("home-wallet", {}, LAZY));
    const picker = await screen.findByTestId("connect-sheet");
    fireEvent.click(within(picker).getByTestId("connector-injected"));
    await waitFor(() => expect(connection.get()).toMatchObject({ status: "connecting", pending: { kind: "injected" } }));
    log.push("--- close ---");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await ticks();
    const after = log.slice(log.indexOf("--- close ---") + 1);
    expect(after.some((l) => l.startsWith("back()")), "its entry popped").toBe(true);
    expect(after.some((l) => l.includes("dsHandOver")), "a browser wallet's prompt is never handed over").toBe(false);
    act(() => answer(["0x7a0000000000000000000000000000000000091f"]));
    await waitFor(() => expect(connection.get()).toMatchObject({ status: "connected", connector: { kind: "injected" } }));
  });

  it("the picker closed by the user over a pairing still cancels it and goes back — nothing handed over", async () => {
    configureWalletConnect("a-project-id");
    await session.create("a strong password");
    session.acknowledgePhrase();
    installAsyncHistory();
    await renderApp("/");
    await screen.findByTestId("home", {}, LAZY);
    fireEvent.click(await screen.findByTestId("home-wallet", {}, LAZY));
    const picker = await screen.findByTestId("connect-sheet");
    fireEvent.click(within(picker).getByTestId("connector-walletconnect"));
    await within(picker).findByTestId("connect-qr", {}, LAZY);
    log.push("--- close ---");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await ticks();
    const after = log.slice(log.indexOf("--- close ---") + 1);
    expect(connection.get().pairing, "cancelled").toBeNull();
    expect(after.some((l) => l.startsWith("back()")), "its entry popped").toBe(true);
    expect(after.some((l) => l.includes("dsHandOver")), "never handed over").toBe(false);
    expect(screen.queryByTestId("pairing-sheet")).toBeNull();
  });
});
