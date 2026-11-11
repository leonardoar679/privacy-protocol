// @vitest-environment happy-dom
// The twelfth review round (B12-6): a connection is remembered by the connector it connected (prefs.lastConnector), whichever entry point
// made it — the picker's rows, Welcome's, Protect's and Settings' Connect, the pairing sheet's Try again (review11-connect-sheet) — so the
// next launch reconnects the wallet connected last. The picker alone had written it: a first launch's Connect was never remembered, and an
// older picker choice was reconnected after a reload instead. Two EIP-6963 wallets announce themselves, B first (the reviewers' probe).
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// WalletConnect's provider, scripted (as review11-connect-sheet's): a pairing's link, then the approval the test gives
const wc = vi.hoisted(() => ({
  handlers: new Map<string, Set<(...a: unknown[]) => void>>(),
  settle: null as null | { approve(): void; refuse(e: unknown): void },
  session: false,
}));
vi.mock("@walletconnect/ethereum-provider", () => ({
  EthereumProvider: {
    init: async () => {
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
          wc.session = false;
        },
      };
    },
  },
}));
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { configureWalletConnect, resetWalletConnect } from "@privacy-wallet/wallet-engine/walletConnect";
import { ConnectSheet } from "../src/features/wallet/ConnectSheet";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { prefs } from "../src/storage/prefs";
import { connectWith } from "../src/features/wallet/connect";
import { WalletSection } from "../src/features/more/Wallet";
import { renderApp } from "./helpers/render";

const LAZY = { timeout: 15_000 };
const ACC = { a: "0xaaaa00000000000000000000000000000000aaaa", b: "0xbbbb00000000000000000000000000000000bbbb" };
function wallet(name: "a" | "b") {
  const handlers = new Map<string, Set<(...x: unknown[]) => void>>();
  let authorized = false;
  const p = {
    unlocked: true,
    reset: () => {
      authorized = false;
      p.unlocked = true;
    },
    emit: (ev: string, ...x: unknown[]) => handlers.get(ev)?.forEach((h) => h(...x)),
    on: (ev: string, h: (...x: unknown[]) => void) => void (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(h),
    removeListener: (ev: string, h: (...x: unknown[]) => void) => void handlers.get(ev)?.delete(h),
    request: async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts") {
        authorized = true;
        return [ACC[name]];
      }
      if (method === "eth_accounts") return authorized && p.unlocked ? [ACC[name]] : [];
      if (method === "eth_chainId") return "0x1";
      return null;
    },
  };
  return p;
}
const A = wallet("a");
const B = wallet("b");
function announce() {
  for (const [rdns, name, provider] of [
    ["io.wallet-b", "Wallet B", B],
    ["io.wallet-a", "Wallet A", A],
  ] as const)
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { uuid: rdns, name, icon: "data:,", rdns }, provider } }));
}
beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  window.addEventListener("eip6963:requestProvider", announce);
});
afterEach(() => {
  cleanup();
  session.forget();
  settings.reset();
  prefs().reset();
  connection.reset();
  configureWalletConnect(undefined);
  resetWalletConnect();
  wc.handlers.clear();
  wc.settle = null;
  wc.session = false;
  A.reset();
  B.reset();
});
/** A reload: the page's memory goes, the preferences stay; the remembered connector reconnects without a prompt. */
const reload = async () => {
  cleanup();
  connection.reset();
  await renderApp("/");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
};

describe("a connection remembered by the connector it connected, whichever entry point made it (B12-6)", () => {
  it("Welcome's Connect: the wallet it connected is remembered, and reconnected after a reload", async () => {
    await renderApp("/");
    await screen.findByTestId("welcome");
    fireEvent.click(screen.getByTestId("welcome-connect"));
    await screen.findByTestId("welcome-connected");
    expect(connection.get().connector?.id, "the first wallet announced").toBe("io.wallet-b");
    expect(prefs().get().lastConnector).toBe("io.wallet-b");
    await reload();
    expect(connection.get()).toMatchObject({ status: "connected", connector: { id: "io.wallet-b" } });
  });

  it("an earlier picker choice gives way to the wallet connected last: after a reload, that one — never the older choice", async () => {
    await renderApp("/");
    await screen.findByTestId("welcome");
    expect(await connectWith("io.wallet-a")).toBe(true); // the picker's row for A
    expect(prefs().get().lastConnector).toBe("io.wallet-a");
    act(() => {
      A.unlocked = false;
      A.emit("accountsChanged", []); // A locked: the page reads disconnected
    });
    expect(connection.get().status).toBe("disconnected");
    fireEvent.click(screen.getByTestId("welcome-connect")); // Welcome's Connect: the first wallet announced, B
    await screen.findByTestId("welcome-connected");
    expect(prefs().get().lastConnector, "the wallet connected last").toBe("io.wallet-b");
    A.unlocked = true; // A unlocked again later
    await reload();
    expect(connection.get().connector?.id).toBe("io.wallet-b");
  });

  it("Protect's Connect: remembered as well", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    await renderApp("/protect");
    fireEvent.click(await screen.findByTestId("protect-connect", {}, LAZY));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(connection.get()).toMatchObject({ status: "connected", connector: { id: "io.wallet-b" } });
    expect(prefs().get().lastConnector).toBe("io.wallet-b");
  });

  it("a cancelled run that began over a connector still set is never remembered — the wallet connected last stays (the critique of 12d3b)", async () => {
    configureWalletConnect("a-project-id");
    await renderApp("/");
    await screen.findByTestId("welcome");
    expect(await connectWith("io.wallet-a")).toBe(true);
    act(() => {
      A.unlocked = false;
      A.emit("accountsChanged", []); // A locked: the page reads disconnected
    });
    const pairing = connectWith("walletconnect"); // a WalletConnect pairing begun over it...
    await waitFor(() => expect(connection.get().pairing).not.toBeNull());
    connection.cancel(); // ...and cancelled
    expect(await connectWith("io.wallet-b")).toBe(true); // B connected
    act(() => wc.settle!.approve()); // the cancelled pairing approved after all
    expect(await pairing, "its own start: never a connection held").toBe(false);
    expect(prefs().get().lastConnector, "the wallet connected last").toBe("io.wallet-b");
    A.unlocked = true;
    await reload();
    expect(connection.get().connector?.id).toBe("io.wallet-b");
  });

  it("Disconnect forgets the connector — from Settings and from the picker: after a reload nothing reconnects", async () => {
    render(<WalletSection deployment={null} />);
    fireEvent.click(await screen.findByTestId("wallet-connect"));
    await waitFor(() => expect(prefs().get().lastConnector).toBe("io.wallet-b"));
    fireEvent.click(await screen.findByTestId("wallet-disconnect"));
    expect(prefs().get().lastConnector, "Settings' Disconnect: forgotten").toBeUndefined();
    await reload();
    expect(connection.get().status).toBe("disconnected");
    cleanup();
    render(<ConnectSheet open onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("connector-io.wallet-a"));
    await waitFor(() => expect(prefs().get().lastConnector).toBe("io.wallet-a"));
    fireEvent.click(await screen.findByTestId("connect-disconnect"));
    expect(prefs().get().lastConnector, "the picker's Disconnect: forgotten").toBeUndefined();
    await reload();
    expect(connection.get().status).toBe("disconnected");
  });

  it("Settings' wallet section, with no picker to open: its own Connect remembered as well", async () => {
    render(<WalletSection deployment={null} />);
    fireEvent.click(await screen.findByTestId("wallet-connect"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(connection.get().connector?.id).toBe("io.wallet-b");
    expect(prefs().get().lastConnector).toBe("io.wallet-b");
  });
});
