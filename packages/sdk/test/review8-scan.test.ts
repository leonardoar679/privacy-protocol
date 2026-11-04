// The eighth review round (2026-11-03, B-3): a scan whose view of the pool predates a spend's receipt never lifts the receipt's spent
// mark — the balance had counted the spent note again beside its change. A view at or past the mark's block that lacks the spend still
// lifts it (a dropped block).
import { beforeAll, describe, expect, it, vi } from "vitest";

const view = vi.hoisted(() => ({ value: null as unknown, during: null as null | (() => void) }));
vi.mock("../src/chain", async (orig) => ({ ...(await orig<Record<string, unknown>>()), syncPoolQuorum: async () => view.value }));
vi.mock("../src/verifiedReads", async (orig) => {
  const real = await orig<Record<string, (...a: unknown[]) => unknown>>();
  return {
    ...real,
    verifyTree: async (...a: unknown[]) => {
      const d = view.during;
      view.during = null;
      d?.();
      return real.verifyTree(...a);
    },
  };
});

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { scanNotes } from "../src/privateTx";
import { noteStore } from "../src/wallet/notes";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { MerkleLayers } from "@privacy-wallet/protocol/merkle";

const ETH = 10n ** 18n;
const VAULT = "0x00000000000000000000000000000000000000e7";
const deployment = {
  chainId: 31337,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as never;
const seed = new Uint8Array(32).fill(13);
const keys = deriveKeys(seed);
const hex = (b: Uint8Array) => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as `0x${string}`;

beforeAll(() => {
  const m = memoryStorage();
  configure(defaultConfig({ kdfLog2N: 12, storage: () => m }));
});

function poolView(leaves: { note: Note; data: `0x${string}` }[], block: bigint) {
  const commitments = leaves.map((l, i) => noteCommitment(noteBody(l.note), BigInt(i)));
  const layers = MerkleLayers.build(commitments, 32);
  return {
    tree: { leaves: commitments, root: layers.root, nextLeafIndex: commitments.length, notes: commitments.length, layers },
    logs: leaves.map((l, i) => ({
      leafIndex: i,
      commitment: commitments[i],
      noteData: l.data,
      transactionHash: ("0x" + "11".repeat(31) + i.toString(16).padStart(2, "0")) as `0x${string}`,
      blockNumber: 50n,
    })),
    spends: [],
    block,
  };
}
const own = (i: number, amount: bigint): Note => ({
  vaultId: BigInt(VAULT),
  amount,
  ownerCommitment: ownerCommitmentOf(keys.spendKey),
  noteSecret: deriveNoteSecret(keys.noteKey, i),
});
const payload = (n: Note) => hex(encryptNoteData(viewKeyPair(keys.viewKey).publicKey, { amount: n.amount, noteSecret: n.noteSecret, vaultId: n.vaultId }));

describe("a spent mark lifted only by a view at or past its block", () => {
  it("the mark made at block 100 survives a scan that read the pool at block 90", async () => {
    const input = own(0, 10n * ETH);
    const data = payload(input);
    noteStore.clear();
    noteStore.add({ note: input, leafIndex: 0, noteData: data, counter: 0, spent: false });
    noteStore.markSpent([0], { atBlock: 100 });
    noteStore.add({ note: own(1, 7n * ETH), leafIndex: 1, noteData: "0x", counter: 1, spent: false });
    view.value = poolView([{ note: input, data }], 90n);
    await scanNotes({ masterSeed: seed, deployment });
    expect(noteStore.all().find((n) => n.leafIndex === 0)!.spent).toBe(true);
    expect(noteStore.balance(BigInt(VAULT))).toBe(7n * ETH);
  });
  it("nor a receipt that arrives while the scan of block 99 is still opening payloads", async () => {
    const input = own(0, 10n * ETH);
    const data = payload(input);
    noteStore.clear();
    noteStore.add({ note: input, leafIndex: 0, noteData: data, counter: 0, spent: false });
    view.value = poolView([{ note: input, data }], 99n);
    view.during = () => {
      noteStore.markSpent([0], { atBlock: 100 });
      noteStore.add({ note: own(1, 7n * ETH), leafIndex: 1, noteData: "0x", counter: 1, spent: false });
    };
    await scanNotes({ masterSeed: seed, deployment });
    expect(noteStore.all().find((n) => n.leafIndex === 0)!.spent).toBe(true);
    expect(noteStore.balance(BigInt(VAULT))).toBe(7n * ETH);
  });
  it("a view past the mark's block without the spend lifts it: the block that spent it was dropped", async () => {
    const input = own(0, 10n * ETH);
    const data = payload(input);
    noteStore.clear();
    noteStore.add({ note: input, leafIndex: 0, noteData: data, counter: 0, spent: false });
    noteStore.markSpent([0], { atBlock: 100 });
    view.value = poolView([{ note: input, data }], 120n);
    await scanNotes({ masterSeed: seed, deployment });
    expect(noteStore.all().find((n) => n.leafIndex === 0)!.spent).toBe(false);
  });
});
