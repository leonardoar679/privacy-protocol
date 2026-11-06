// The connection's own provider, and WalletConnect's by its own flag (the eleventh review round's critique of F11-10). A Protect's
// transaction is asked only of the wallet the connection holds — never the browser's injected wallet in its place — and the one approval
// exception (audit gap 100) is WalletConnect's provider, recognised by the `isWalletConnect` the installed @walletconnect/ethereum-provider
// carries on its prototype: the tests elsewhere use fakes that set the flag themselves.
import { afterEach, describe, expect, it } from "vitest";
import { activeProvider, connectedProvider, setActiveProvider, type Eip1193Provider } from "../src/injected";
import { isWalletConnectProvider } from "../src/walletConnect";

const fake = (): Eip1193Provider => ({ request: async () => null });
afterEach(() => {
  setActiveProvider(null);
  delete (globalThis as { window?: unknown }).window;
});

describe("connectedProvider", () => {
  it("null while nothing is connected, even with the browser's injected wallet present — which activeProvider falls back to", () => {
    const injected = fake();
    (globalThis as { window?: unknown }).window = { ethereum: injected };
    expect(activeProvider(), "the flows' fallback").toBe(injected);
    expect(connectedProvider(), "never the injected wallet in the connection's place").toBeNull();
    const connected = fake();
    setActiveProvider(connected);
    expect(connectedProvider()).toBe(connected);
    expect(activeProvider()).toBe(connected);
  });
});

describe("isWalletConnectProvider", () => {
  it("WalletConnect's provider as installed carries the flag (no init, no network); any other provider does not", async () => {
    const mod = (await import("@walletconnect/ethereum-provider")) as { EthereumProvider: { prototype: object } };
    expect(isWalletConnectProvider(Object.create(mod.EthereumProvider.prototype))).toBe(true);
    expect(isWalletConnectProvider(fake())).toBe(false);
    expect(isWalletConnectProvider(null)).toBe(false);
  });
});
