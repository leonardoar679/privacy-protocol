// A spend is the transaction that spends its notes (the audit round of 2026-10-16, c31). A spend marked its input notes
// spent on whatever receipt came back for the hash it was handed: a replacement, a cancel in the connected wallet, a relayer
// naming another transaction. Nothing ever cleared the flag, and the balance lost those notes. Now the receipt's own event
// (the core's ShieldedTransaction) must name the spend's nullifiers before anything is marked: otherwise NotThisSpend
// (not_this_spend: where the spend went is not known), the notes untouched. Offline: the chain, the tree check and the
// prover are stubs; the plan, the proof's public inputs and the receipt check are the real code's.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { Deployment, TreeState } from "../src/chain";
import { expectedPublicInputs } from "@privacy-wallet/protocol/prover";

const HASH = ("0x" + "5a".repeat(32)) as Hex;
const w = vi.hoisted(() => ({
  spends: [] as [bigint, bigint][] | "own",
  tree: null as unknown,
  sent: 0,
  spec: null as unknown,
  gate: null as Promise<void> | null,
  nf: [0n, 0n] as [bigint, bigint],
}));
vi.mock("../src/deploymentGuard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploymentGuard")>()),
  guardDeployment: async () => undefined,
}));
vi.mock("../src/verifiedReads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/verifiedReads")>()),
  verifyTree: async () => undefined,
}));
vi.mock("../src/chain", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/chain")>();
  const { noteBody, noteCommitment } = await import("@privacy-wallet/protocol/note");
  return {
    ...real,
    syncTreeQuorum: async () => w.tree,
    sendViaInjectedWallet: async () => {
      w.sent++;
      return HASH;
    },
    // the receipt: the merge's outputs at the next leaves, and the nullifier pair its event names
    minedTx: async () => {
      if (w.gate) await w.gate; // a receipt that takes its time (the third review round: a lock and a REPLACE in between)
      const outputs = (w.spec as { outputs: Parameters<typeof noteBody>[0][] }).outputs;
      return {
        inserted: outputs.map((n, i) => ({ leafIndex: 2 + i, commitment: noteCommitment(noteBody(n), BigInt(2 + i)) })),
        costWei: 1n,
        spends: w.spends === "own" ? [w.nf] : w.spends,
      };
    },
  };
});

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { noteStore, type OwnedNote } from "../src/wallet/notes";
import { mergeNotes, NotThisSpend } from "../src/privateTx";
import { classify } from "../src/operations/errors/catalog";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { MerkleLayers } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { mainOwnerCommitment } from "../src/keys/ownerKeys";

const VAULT = "0x00000000000000000000000000000000000000e7";
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as unknown as Deployment;
const seed = new Uint8Array(32).fill(9);
const store = memoryStorage();

beforeAll(async () => {
  configure(
    defaultConfig({
      storage: () => store,
      kdfLog2N: 12,
      // the proof: its public inputs carry the spend's nullifiers, as the circuit's do
      prover: async (spec) => {
        w.spec = spec;
        const publicInputs = expectedPublicInputs(spec); // what the main thread checks the answer against (the third review round)
        w.nf = [publicInputs.nullifier0, publicInputs.nullifier1];
        return {
          proof: ("0x" + "00".repeat(256)) as Hex,
          publicInputs,
          publicSignals: [],
          ms: 1,
          verifiedLocally: false,
        };
      },
    }),
  );
  await session.create("a strong password");
  session.acknowledgePhrase();
});

/** Two notes of this wallet at leaves 0 and 1, and the tree that holds them. */
function twoNotes(): [OwnedNote, OwnedNote] {
  const oc = mainOwnerCommitment(deriveKeys(seed));
  const notes = [0, 1].map(
    (leafIndex) =>
      ({
        note: { vaultId: BigInt(VAULT), amount: 10n ** 17n, ownerCommitment: oc, noteSecret: 7n + BigInt(leafIndex) },
        leafIndex,
        noteData: "0x",
        spent: false,
      }) as OwnedNote,
  );
  const leaves = notes.map((n) => noteCommitment(noteBody(n.note), BigInt(n.leafIndex)));
  w.tree = { leaves, root: 0n, nextLeafIndex: 2, notes: 2, layers: MerkleLayers.build(leaves, TX_LEVELS) } satisfies TreeState;
  for (const n of notes) noteStore.add(n);
  return notes as [OwnedNote, OwnedNote];
}

beforeEach(() => {
  noteStore.clear();
  w.sent = 0;
});

describe("a spend is the transaction that spends its notes", () => {
  it("a receipt that spends other notes marks none spent: NotThisSpend, where the spend went not known (audit c31)", async () => {
    const [a, b] = twoNotes();
    w.spends = [[7n, 8n]]; // a cancel, a replacement, another spend
    const e = await mergeNotes({ masterSeed: seed, deployment, a, b, submission: { kind: "wallet" } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotThisSpend);
    expect(classify(e)).toMatchObject({ code: "not_this_spend", fundsClass: "unknown", actions: ["resume-tracking"] });
    expect(w.sent).toBe(1);
    expect(
      noteStore.all().map((n) => [n.leafIndex, n.spent]),
      "both notes still unspent",
    ).toEqual([
      [0, false],
      [1, false],
    ]);
    w.spends = []; // a receipt with no transact of the core at all
    await expect(mergeNotes({ masterSeed: seed, deployment, a, b, submission: { kind: "wallet" } })).rejects.toBeInstanceOf(NotThisSpend);
    expect(noteStore.unspent(BigInt(VAULT))).toHaveLength(2);
  });

  it("a receipt whose event names the spend's nullifiers marks its notes spent and records the merged note", async () => {
    const [a, b] = twoNotes();
    w.spends = "own";
    const r = await mergeNotes({ masterSeed: seed, deployment, a, b, submission: { kind: "wallet" } });
    expect(r.txHash).toBe(HASH);
    expect(
      noteStore
        .all()
        .filter((n) => n.spent)
        .map((n) => n.leafIndex),
    ).toEqual([0, 1]);
    expect(r.merged.note.amount).toBe(2n * 10n ** 17n);
  });

  it("a receipt that lands after a lock and a REPLACE with another phrase in the same tab records nothing into the new wallet (the third review round, 2026-11-03)", async () => {
    const [a, b] = twoNotes();
    w.spends = "own";
    let release!: () => void;
    w.gate = new Promise<void>((r) => {
      release = r;
    });
    const merge = mergeNotes({ masterSeed: seed, deployment, a, b, submission: { kind: "wallet" } }).catch((x: unknown) => x);
    for (let i = 0; i < 200 && w.sent === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(w.sent, "sent, the receipt not yet in").toBe(1);
    const before = session.epoch();
    session.lock();
    await session.create("another password", new Uint8Array(32).fill(9), { replace: true });
    expect(session.epoch()).not.toBe(before);
    release();
    const e = await merge;
    expect(e).toMatchObject({ code: "locked_mid_flow" });
    expect(noteStore.all(), "the other wallet's store holds nothing of the old wallet's spend").toEqual([]);
    w.gate = null;
    session.lock();
    await session.create("a strong password", undefined, { replace: true });
  });
});
