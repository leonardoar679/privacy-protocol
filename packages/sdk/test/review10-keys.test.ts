// The tenth review round (2026-11-04), D-1 (HIGH): a lock while a Protect waited for the scan after an unlock zeroed the seed array the
// flow held and released the wait as if the scan had finished; the deposit was then made from the zeroed seed at counter 0 — a note
// anyone can spend — and, after a quick unlock, prompted. Now a lock closes the note store (the wait is refused, no counter is handed
// out until the next unlock's load), the flow is bound to the opening it began in, and no key is ever derived from an all-zero seed.
import { afterEach, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { noteStore, StoreClosed } from "../src/wallet/notes";
import { shieldNative } from "../src/privateTx";
import { chainSeed } from "../src/keys/chainKeys";
import { deriveOrderKey, deriveRefundNote } from "../src/keys/swapKeys";
import { orderIsOurs } from "../src/swapFunding";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import { deriveKeys, SeedUnavailable } from "@privacy-wallet/protocol/keys";

const PW = "a strong password";
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const deployment = {
  chainId: 31337,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: "0x00000000000000000000000000000000000000e7",
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as never;

async function freshWallet() {
  const store = memoryStorage(); // one store for the wallet's life: a function that made a new one at every read had lost the keystore
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12, deploymentCheck: false }));
  await session.create(PW, undefined, { replace: true });
  session.acknowledgePhrase();
  session.lock();
  expect(await session.unlock(PW)).toBe(true);
}

afterEach(() => setActiveProvider(null));

describe("a lock during a flow's wait for the scan (the tenth review round, D-1)", () => {
  it("refuses the Protect at the lock — nothing is prepared or prompted, even after the user unlocks again at once", async () => {
    await freshWallet();
    expect(noteStore.countersHeld(), "held until the scan after this unlock").toBe(true);
    const sent: unknown[] = [];
    setActiveProvider({
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ACCOUNT];
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_sendTransaction") {
          sent.push((params as unknown[])[0]);
          return "0x" + "ab".repeat(32);
        }
        return null;
      },
    } as never);
    const seed = session.state().seed!; // what the Protect screen holds (useUnlockedSeed)
    const flow = shieldNative({ masterSeed: seed, deployment, amount: 10n ** 17n }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    session.lock(); // the idle lock, a pagehide, a step-aside or the Lock button
    expect(await session.unlock(PW)).toBe(true); // and the user unlocks again at once
    const end = (await flow) as { code?: string };
    expect(end.code).toBe("locked_mid_flow");
    expect(sent, "no deposit was prompted").toEqual([]);
  });

  it("a lock closes the note store until the next unlock's load: the wait is refused, no counter is handed out", async () => {
    await freshWallet();
    const wait = noteStore.untilScanned().catch((e: unknown) => e);
    session.lock();
    expect(await wait).toBeInstanceOf(StoreClosed);
    expect(noteStore.isClosed()).toBe(true);
    expect(() => noteStore.allocateCounter()).toThrow(StoreClosed);
    await expect(noteStore.untilScanned()).rejects.toBeInstanceOf(StoreClosed);
    expect(await session.unlock(PW)).toBe(true);
    expect(noteStore.isClosed(), "the unlock's load opens it again").toBe(false);
  });
});

describe("no key from an all-zero seed (the tenth review round, D-1)", () => {
  it("refuses the zeroed array a lock leaves behind, wherever a key is derived", () => {
    const zero = new Uint8Array(32);
    expect(() => deriveKeys(zero)).toThrow(SeedUnavailable);
    expect(() => chainSeed(zero)).toThrow(SeedUnavailable);
    expect(() => deriveOrderKey(zero, ("0x" + "11".repeat(32)) as `0x${string}`)).toThrow(SeedUnavailable);
    expect(() => deriveRefundNote(zero, 0)).toThrow(SeedUnavailable);
    expect(() => deriveKeys(new Uint8Array(0))).toThrow(SeedUnavailable);
    expect(deriveKeys(new Uint8Array(32).fill(7)).spendKey).toBeTypeOf("bigint");
  });

  it("refuses to make a wallet of the public all-zero phrase", async () => {
    configure(defaultConfig({ storage: () => memoryStorage(), kdfLog2N: 12, deploymentCheck: false }));
    await expect(session.restoreFromPhrase(`${"abandon ".repeat(23)}art`, PW, { replace: true })).rejects.toThrow(/publicly known/);
  });

  it("an order is funded only when its refund note and signer are this seed's (orderIsOurs)", () => {
    const seed = new Uint8Array(32).fill(9);
    const other = new Uint8Array(32).fill(5);
    const attemptId = ("0x" + "22".repeat(32)) as `0x${string}`;
    const refund = deriveRefundNote(seed, 3);
    const stored = {
      refundCounter: 3,
      attemptId,
      params: {
        refundOwnerCommitment: refund.ownerCommitment.toString(),
        refundNoteSecret: refund.noteSecret.toString(),
        orderSigner: deriveOrderKey(seed, attemptId).address,
      },
    } as never;
    expect(orderIsOurs(stored, seed)).toBe(true);
    expect(orderIsOurs(stored, other), "another seed's refund and signer").toBe(false);
    const zeroRefund = {
      ...(stored as object),
      params: { ...(stored as { params: object }).params, refundNoteSecret: deriveRefundNote(other, 3).noteSecret.toString() },
    } as never;
    expect(orderIsOurs(zeroRefund, seed), "a refund note this seed does not give").toBe(false);
  });
});
