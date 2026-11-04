// The eighth review round (2026-11-03, B-6): a lock while a Protect's receipt is awaited through the connected wallet's own provider
// never asks the privacy endpoints for that receipt — its `from` is the user's public address (threat model A4) — and the flow ends
// "sent, the next scan records it".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "@privacy-wallet/sdk/config";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { prepareShield, trackShieldCost } from "@privacy-wallet/sdk/privateTx";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { startMockCore } from "./helpers/mockRpc";

const store = memoryStorage();
const CORE = "0x00000000000000000000000000000000000000c0";
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterAll(() => setActiveProvider(null));

describe("a lock while the Protect's receipt is awaited", () => {
  it("asks the privacy endpoint for nothing; the flow ends locked_after_send", async () => {
    const rpc = await startMockCore({ core: CORE, events: {}, nextLeafIndex: 0, root: 0n });
    try {
      const deployment = { chainId: 31337, core: CORE, ethVault: "0x00000000000000000000000000000000000000e7", rpcUrl: rpc.url, rpcUrls: [rpc.url], fromBlock: 0n, erc20Vaults: [] } as never;
      const p = prepareShield({ masterSeed: session.state().seed!, deployment, amount: 10n ** 17n });
      rpc.mine(HASH, [{ leafIndex: 0, commitment: noteCommitment(noteBody(p.note), 0n), noteData: p.noteData }], 1n);
      // the connected wallet's provider: on the right chain, its receipt not there yet
      setActiveProvider({ request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x7a69" : null) } as never);
      const t = trackShieldCost(p, HASH).catch((e) => e);
      await new Promise((r) => setTimeout(r, 100));
      session.lock();
      const err = await t;
      expect(rpc.state.methods.filter((m: string) => m === "eth_getTransactionReceipt"), "no receipt read at the privacy endpoint").toEqual([]);
      expect((err as { code?: string }).code).toBe("locked_after_send");
    } finally {
      await rpc.close();
    }
  });
});
