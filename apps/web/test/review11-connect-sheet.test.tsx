// @vitest-environment happy-dom
// The connector picker and a WalletConnect pairing (the eleventh review round, slice 6c's critique). The library's QR modal is off — the page's
// policy refuses its <style> elements, and under it the modal took no tap — so the wallet shows the pairing itself: in the picker while it
// is open, in place of the connectors; else in a sheet of its own from the app's root (Welcome's and Protect's Connect, WalletConnect the
// browser's only connector). Cancel, or the sheet closed over it, ends the pairing; a failure reads in the sheet's words, the wallet's own
// text after them under Advanced only. WalletConnect's provider is scripted as the installed one behaves (enable() pairs, giving its link as
// display_uri; packages/wallet-engine/test/review11-wc-connect.test.ts runs the real one).
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const ACCOUNT = "0x7a3b000000000000000000000000000000c491f2";
const LINK = "wc:a-pairing@2?relay-protocol=irn&symKey=00";
const wc = vi.hoisted(() => ({
  handlers: new Map<string, Set<(...a: unknown[]) => void>>(),
  settle: null as null | { approve(): void; refuse(e: unknown): void },
  session: false,
  disconnects: 0,
  /** while set, the provider's init waits for it (WalletConnect's library still loading) */
  initGate: null as Promise<void> | null,
  /** while set, a pairing waits for it before its link (the relay slow to answer) */
  uriGate: null as Promise<void> | null,
  /** the next init fails (the library's chunk failing to load after a deploy, a flaky network) */
  failInit: false,
}));
vi.mock("@walletconnect/ethereum-provider", () => ({
  EthereumProvider: {
    init: async () => {
      if (wc.initGate) await wc.initGate;
      if (wc.failInit) {
        wc.failInit = false;
        throw new Error("Failed to fetch dynamically imported module");
      }
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
        request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x1" : method === "eth_requestAccounts" ? accounts() : method === "eth_accounts" ? (wc.session ? accounts() : []) : null),
        enable: async () => {
          if (!wc.session && wc.uriGate) await wc.uriGate;
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
import { registerCatalog, t } from "../src/app/i18n/messages";
import { ko as KO } from "../src/app/i18n/ko";
import { ConnectSheet } from "../src/features/wallet/ConnectSheet";
import { connectErrorWords } from "../src/features/wallet/connectWords";
import { prefs } from "../src/storage/prefs";
import { renderApp } from "./helpers/render";

const LAZY = { timeout: 15_000 };
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
  wc.uriGate = null;
  wc.failInit = false;
  delete (window as unknown as Record<string, unknown>).ethereum;
});

/** The picker open, WalletConnect tapped: its pairing shown. */
async function pairingInPicker(onClose = vi.fn()) {
  configureWalletConnect("a-project-id");
  discover();
  render(<ConnectSheet open onClose={onClose} />);
  fireEvent.click(await screen.findByTestId("connector-walletconnect"));
  await screen.findByTestId("connect-qr", {}, LAZY);
  return onClose;
}

describe("a connection's failure in the sheet's words", () => {
  it("a refusal, a request the wallet is already showing, a pairing not answered in time, anything else — the wallet's own text after them under Advanced only; Korean too", () => {
    expect(connectErrorWords(t, "User rejected.", false)).toBe("The wallet declined the connection.");
    expect(connectErrorWords(t, "User denied account authorization", false)).toBe("The wallet declined the connection.");
    expect(connectErrorWords(t, "Proposal expired", false)).toBe("The wallet app did not answer in time. Choose it again to try once more.");
    // EIP-1193 -32002, MetaMask's two texts: trying again fails the same way until the wallet's own request is answered
    const pending = "The wallet is already asking you to connect. Open it, answer its request, then try again.";
    expect(connectErrorWords(t, "Already processing eth_requestAccounts. Please wait.", false)).toBe(pending);
    expect(connectErrorWords(t, "Request of type 'wallet_requestPermissions' already pending for origin https://wallet.example. Please wait.", false)).toBe(pending);
    expect(connectErrorWords(t, "Internal JSON-RPC error.", false)).toBe("The wallet did not connect. Try again, or choose another wallet.");
    expect(connectErrorWords(t, "User rejected.", true)).toBe("The wallet declined the connection. (User rejected.)");
    // the pairing's own sheet: its one action is Try again; the picker with one connector: no other wallet to choose (the third and fourth
    // critiques); a connection that could not start on this device: said as such, whichever sheet
    expect(connectErrorWords(t, "Proposal expired", false, "pairing")).toBe("The wallet app did not answer in time. Try again for a new code.");
    expect(connectErrorWords(t, "Internal JSON-RPC error.", false, "pairing")).toBe("The wallet app did not connect. Try again.");
    expect(connectErrorWords(t, "Internal JSON-RPC error.", false, "picker", false)).toBe("The wallet did not connect. Try again.");
    const network = "The connection could not start. Check this device's internet connection and try again.";
    for (const e of ["Failed to fetch dynamically imported module: https://wallet.example/assets/index-a1.js", "No internet connection detected. Please restart your network and try again.", "WebSocket connection closed abnormally with code: 3000"])
      for (const where of ["picker", "pairing"] as const) expect(connectErrorWords(t, e, false, where), `${e} (${where})`).toBe(network);
    registerCatalog("ko", KO);
    const ko = (k: Parameters<typeof t>[0]) => t(k, undefined, "ko");
    expect(connectErrorWords(ko, "Proposal expired", false, "pairing")).toBe("지갑 앱이 제때 응답하지 않았습니다. 다시 시도해 새 코드를 받으세요.");
    expect(connectErrorWords(ko, "Internal JSON-RPC error.", false, "pairing")).toBe("지갑 앱이 연결되지 않았습니다. 다시 시도하세요.");
    expect(connectErrorWords(ko, "Internal JSON-RPC error.", false, "picker", false)).toBe("지갑이 연결되지 않았습니다. 다시 시도하세요.");
    expect(connectErrorWords(ko, "No internet connection detected.", false, "pairing")).toBe("연결을 시작하지 못했습니다. 이 기기의 인터넷 연결을 확인한 뒤 다시 시도하세요.");
    expect(connectErrorWords(ko, "User rejected.", false)).toBe("지갑이 연결을 거절했습니다.");
    expect(connectErrorWords(ko, "Proposal expired", false)).toBe("지갑 앱이 제때 응답하지 않았습니다. 다시 선택해 한 번 더 시도하세요.");
  });
});

describe("a WalletConnect pairing, shown by the wallet itself", () => {
  it("in the picker, in place of the connectors: the code named for a reader, the link that opens the wallet app (never shown as text), Cancel — which brings the connectors back", async () => {
    const onClose = await pairingInPicker();
    const qr = screen.getByTestId("connect-qr");
    expect(qr).toHaveAttribute("role", "img");
    expect(qr).toHaveAccessibleName("The code for the wallet app to scan");
    expect(qr.querySelector("svg"), "the code, drawn").not.toBeNull();
    expect(screen.getByTestId("connect-open-app")).toHaveAttribute("href", LINK);
    expect(screen.getByTestId("connect-sheet")).not.toHaveTextContent("symKey");
    expect(screen.queryByTestId("connector-walletconnect"), "the rows give way to the pairing").toBeNull();
    expect(screen.getByTestId("connect-waiting")).toHaveTextContent("Waiting for the wallet app to approve…");
    fireEvent.click(screen.getByTestId("connect-cancel"));
    await screen.findByTestId("connector-walletconnect");
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null, error: null });
    expect(onClose, "Cancel leaves the picker open").not.toHaveBeenCalled();
  });

  it("the picker closed over a pairing cancels it: the approval that comes later connects nothing, and its session is ended", async () => {
    const onClose = await pairingInPicker();
    fireEvent.click(within(screen.getByTestId("connect-sheet")).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null });
    act(() => wc.settle!.approve());
    await waitFor(() => expect(wc.disconnects, "the late session ended").toBe(1));
    expect(connection.get()).toMatchObject({ status: "disconnected", account: null });
  });

  it("a pairing the wallet app approves: connected, the connector remembered, the picker closed", async () => {
    const onClose = await pairingInPicker();
    act(() => wc.settle!.approve());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(connection.get()).toMatchObject({ status: "connected", pairing: null });
    expect(connection.get().account?.toLowerCase()).toBe(ACCOUNT);
    expect(prefs().get().lastConnector).toBe("walletconnect");
  });

  it("a WalletConnect pairing cancelled, the browser wallet connected: the pairing settling later remembers nothing and closes nothing (the slice's second critique)", async () => {
    for (const late of ["expires", "is approved"] as const) {
      const injected = {
        request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? ["0x7a0000000000000000000000000000000000091f"] : method === "eth_chainId" ? "0x1" : null),
        on: () => undefined,
        removeListener: () => undefined,
      };
      (window as unknown as Record<string, unknown>).ethereum = injected;
      const onClose = await pairingInPicker();
      const cancelled = wc.settle!;
      fireEvent.click(screen.getByTestId("connect-cancel"));
      fireEvent.click(await screen.findByTestId("connector-injected"));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(prefs().get().lastConnector).toBe("injected");
      act(() => (late === "expires" ? cancelled.refuse(new Error("Proposal expired")) : cancelled.approve()));
      await new Promise((r) => setTimeout(r, 30));
      expect(prefs().get().lastConnector, `the pairing ${late}: the browser wallet stays remembered`).toBe("injected");
      expect(onClose, "the picker is not closed again").toHaveBeenCalledTimes(1);
      expect(connection.get()).toMatchObject({ status: "connected", connector: { kind: "injected" } });
      cleanup();
      connection.reset();
      prefs().reset();
      resetWalletConnect();
      wc.session = false;
      delete (window as unknown as Record<string, unknown>).ethereum;
    }
  });

  it("WalletConnect cancelled and tapped again, the retry connected: the first pairing's expiry closes nothing (the slice's third critique)", async () => {
    const onClose = await pairingInPicker();
    const first = wc.settle!;
    fireEvent.click(screen.getByTestId("connect-cancel"));
    fireEvent.click(await screen.findByTestId("connector-walletconnect"));
    await screen.findByTestId("connect-qr", {}, LAZY);
    expect(wc.settle, "a new pairing").not.toBe(first);
    act(() => wc.settle!.approve());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(prefs().get().lastConnector).toBe("walletconnect");
    act(() => first.refuse(new Error("Proposal expired")));
    await new Promise((r) => setTimeout(r, 30));
    expect(onClose, "the picker the retry connected is not closed again").toHaveBeenCalledTimes(1);
    expect(connection.get()).toMatchObject({ status: "connected", connector: { kind: "walletconnect" } });
  });

  it("a browser wallet's prompt outlives the picker's close and opens no sheet from the root; its approval connects and is remembered (the fourth critique)", async () => {
    configureWalletConnect("a-project-id");
    let answer!: (a: string[]) => void;
    const answered = new Promise<string[]>((r) => (answer = r));
    (window as unknown as Record<string, unknown>).ethereum = {
      request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? answered : method === "eth_chainId" ? "0x1" : null),
      on: () => undefined,
      removeListener: () => undefined,
    };
    await renderApp("/");
    await screen.findByTestId("welcome");
    // Welcome's Connect: the browser's wallet, its prompt open — no pairing sheet over it
    fireEvent.click(screen.getByTestId("welcome-connect"));
    await waitFor(() => expect(connection.get()).toMatchObject({ status: "connecting", pending: { kind: "injected" } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("pairing-sheet"), "no sheet over a browser wallet's prompt").toBeNull();
    // the picker opened over it, its row tapped (one connection for the wallet), the picker closed: the prompt stays
    const onClose = vi.fn();
    discover();
    render(<ConnectSheet open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("connector-injected"));
    fireEvent.click(within(screen.getByTestId("connect-sheet")).getByRole("button", { name: "Close" }));
    expect(connection.get()).toMatchObject({ status: "connecting", pending: { kind: "injected" } });
    act(() => answer(["0x7a0000000000000000000000000000000000091f"]));
    await waitFor(() => expect(connection.get()).toMatchObject({ status: "connected", connector: { kind: "injected" } }));
    await waitFor(() => expect(prefs().get().lastConnector).toBe("injected"));
    expect(screen.queryByTestId("pairing-sheet")).toBeNull();
  });

  it("the picker closed while WalletConnect's library loads cancels it: no pairing, no sheet of its own afterwards", async () => {
    configureWalletConnect("a-project-id");
    await renderApp("/");
    await screen.findByTestId("welcome");
    let loaded!: () => void;
    wc.initGate = new Promise<void>((r) => (loaded = r));
    const onClose = vi.fn();
    discover();
    render(<ConnectSheet open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("connector-walletconnect"));
    await waitFor(() => expect(connection.get()).toMatchObject({ status: "connecting", pending: { kind: "walletconnect" } }));
    fireEvent.click(within(screen.getByTestId("connect-sheet")).getByRole("button", { name: "Close" }));
    expect(connection.get()).toMatchObject({ status: "disconnected", pending: null });
    act(() => loaded());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("pairing-sheet"), "no sheet opens by itself").toBeNull();
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null });
  });

  it("a picker that lists WalletConnect alone (a phone) never says to choose another wallet (the fourth critique)", async () => {
    await pairingInPicker();
    expect(screen.queryAllByTestId(/^connector-/), "the rows give way to the pairing").toHaveLength(0);
    act(() => wc.settle!.refuse(new Error("Internal JSON-RPC error.")));
    const error = await screen.findByTestId("connect-error");
    expect(error).toHaveTextContent("The wallet did not connect. Try again.");
    expect(error).not.toHaveTextContent("choose another wallet");
    expect(screen.getAllByTestId(/^connector-/)).toHaveLength(1);
  });

  it("a refusal reads in the sheet's words — the wallet's own text only under Advanced", async () => {
    await pairingInPicker();
    act(() => wc.settle!.refuse({ code: 5000, message: "User rejected." }));
    const error = await screen.findByTestId("connect-error");
    expect(error).toHaveTextContent("The wallet declined the connection.");
    expect(error).not.toHaveTextContent("User rejected.");
    act(() => prefs().update({ experience: "advanced" }));
    expect(screen.getByTestId("connect-error")).toHaveTextContent("The wallet declined the connection. (User rejected.)");
  });

  it("Welcome's Connect, WalletConnect the only connector: the pairing in a sheet of its own from the app's root; its Cancel ends it", async () => {
    configureWalletConnect("a-project-id");
    await renderApp("/");
    await screen.findByTestId("welcome");
    fireEvent.click(screen.getByTestId("welcome-connect"));
    const sheet = await screen.findByTestId("pairing-sheet", {}, LAZY);
    await within(sheet).findByTestId("connect-qr");
    expect(within(sheet).getByTestId("connect-open-app")).toHaveAttribute("href", LINK);
    fireEvent.click(within(sheet).getByTestId("connect-cancel"));
    await waitFor(() => expect(screen.queryByTestId("pairing-sheet")).toBeNull());
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null, error: null });
    // its close (the X, Escape, a phone's back) cancels the same way; a later approval is ended
    fireEvent.click(screen.getByTestId("welcome-connect"));
    const again = await screen.findByTestId("pairing-sheet", {}, LAZY);
    await within(again).findByTestId("connect-qr");
    const pending = wc.settle!;
    fireEvent.click(within(again).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("pairing-sheet")).toBeNull());
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null });
    act(() => pending.approve());
    await waitFor(() => expect(wc.disconnects, "the late session ended").toBe(1));
    expect(connection.get().status).toBe("disconnected");
  });

  it("from the app's root, a failure stays on the pairing's sheet in the wallet's words, with Try again: a new pairing in the same sheet; closed over the failure, the failure is dismissed", async () => {
    configureWalletConnect("a-project-id");
    await renderApp("/");
    await screen.findByTestId("welcome");
    fireEvent.click(screen.getByTestId("welcome-connect"));
    const sheet = await screen.findByTestId("pairing-sheet", {}, LAZY);
    await within(sheet).findByTestId("connect-qr");
    act(() => wc.settle!.refuse({ code: 5000, message: "User rejected." }));
    expect(await within(sheet).findByTestId("connect-error")).toHaveTextContent("The wallet declined the connection.");
    expect(screen.getByTestId("pairing-sheet"), "the same sheet").toBe(sheet);
    fireEvent.click(within(sheet).getByTestId("connect-retry"));
    await within(sheet).findByTestId("connect-qr");
    expect(screen.getByTestId("pairing-sheet"), "still the same sheet").toBe(sheet);
    act(() => wc.settle!.approve());
    await waitFor(() => expect(screen.queryByTestId("pairing-sheet")).toBeNull());
    expect(await screen.findByTestId("welcome-connected")).toHaveTextContent("Connected: 0x7a…91f2");
    // a failure, then the sheet closed: the failure dismissed, nothing left in the picker later
    connection.disconnect();
    fireEvent.click(await screen.findByTestId("welcome-connect"));
    const third = await screen.findByTestId("pairing-sheet", {}, LAZY);
    await within(third).findByTestId("connect-qr");
    act(() => wc.settle!.refuse(new Error("Proposal expired")));
    // the sheet's own words: its one action is Try again — no list to choose from again, no other wallet (the third critique)
    expect(await within(third).findByTestId("connect-error")).toHaveTextContent("The wallet app did not answer in time. Try again for a new code.");
    fireEvent.click(within(third).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("pairing-sheet")).toBeNull());
    expect(connection.get()).toMatchObject({ status: "disconnected", error: null });
  });

  it("from the app's root, a WalletConnect connection shows from its start: a failure before any link reads in its own words with Try again (the third critique)", async () => {
    configureWalletConnect("a-project-id");
    await renderApp("/");
    await screen.findByTestId("welcome");
    wc.failInit = true;
    fireEvent.click(screen.getByTestId("welcome-connect"));
    const sheet = await screen.findByTestId("pairing-sheet", {}, LAZY);
    // the library's chunk not loaded: a failure on this device, said as such — no wallet app was asked (the fourth critique)
    expect(await within(sheet).findByTestId("connect-error")).toHaveTextContent("The connection could not start. Check this device's internet connection and try again.");
    fireEvent.click(within(sheet).getByTestId("connect-retry"));
    await within(sheet).findByTestId("connect-qr");
    act(() => wc.settle!.approve());
    await waitFor(() => expect(screen.queryByTestId("pairing-sheet")).toBeNull());
    expect(connection.get().status).toBe("connected");
  });

  it("from the app's root, closed during the wait before the link: the connection cancelled, and the link that comes later shows nothing", async () => {
    configureWalletConnect("a-project-id");
    await renderApp("/");
    await screen.findByTestId("welcome");
    let linked!: () => void;
    wc.uriGate = new Promise<void>((r) => (linked = r));
    fireEvent.click(screen.getByTestId("welcome-connect"));
    const sheet = await screen.findByTestId("pairing-sheet", {}, LAZY);
    expect(await within(sheet).findByTestId("connect-connecting")).toHaveTextContent("Connecting…");
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("pairing-sheet")).toBeNull());
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null, pending: null });
    act(() => linked());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("pairing-sheet"), "the closed sheet does not come back").toBeNull();
    expect(connection.get()).toMatchObject({ status: "disconnected", pairing: null });
  });

  it("while the picker is open the pairing shows there alone — never a second sheet from the root", async () => {
    configureWalletConnect("a-project-id");
    await renderApp("/");
    await screen.findByTestId("welcome");
    await pairingInPicker();
    expect(screen.getAllByTestId("connect-qr")).toHaveLength(1);
    expect(screen.queryByTestId("pairing-sheet")).toBeNull();
    act(() => connection.cancel());
  });
});
