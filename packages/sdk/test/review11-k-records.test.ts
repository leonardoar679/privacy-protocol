// The eleventh review round (2026-11-04), A11-10 — a merge's and a split's own new note are recorded with the spend, inside its hold: the merged
// note and the split's piece go into the note store, and so into the journal, in the same synchronous block as the spent marks and the change
// note (submitAndRecordHeld's extraOwn). mergeNotesInTurn and splitNoteInTurn had added them after the spend's hold was released, and a lock due
// by then — the idle deadline passed while the spend proved — happens inside that release: the note went into the closed store, the journal the
// lock left held the spent inputs alone, and the balance lacked the merged note until a scan found it again. The critique of the round's diff
// (T2): no test ran the real merge or split and looked for its new note — not-this-spend.test.ts reads the merge's returned amount, and
// review11-notes.test.ts stubs the step's split —, so a build that never recorded either note passed every SDK test.
// Offline, as in not-this-spend.test.ts: the chain, the tree check and the prover are stubs; the plan, the proof's public inputs, the receipt
// check, the recording, the session with its journal and the auto-lock are the real code's.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { Deployment, TreeState } from "../src/chain";
import { expectedPublicInputs } from "@privacy-wallet/protocol/prover";

const HASH = ("0x" + "5a".repeat(32)) as Hex;
const w = vi.hoisted(() => ({
  tree: null as unknown,
  spec: null as unknown,
  nf: [0n, 0n] as [bigint, bigint],
  /** run by the prover: the moment "while the spend proves" */
  whileProving: null as (() => void) | null,
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
    sendViaInjectedWallet: async () => HASH,
    // the receipt: the spend's three outputs at the next leaves (2, 3, 4), and its event naming the nullifier pair the proof spent
    minedTx: async () => {
      const outputs = (w.spec as { outputs: Parameters<typeof noteBody>[0][] }).outputs;
      return {
        inserted: outputs.map((n, i) => ({ leafIndex: 2 + i, commitment: noteCommitment(noteBody(n), BigInt(2 + i)) })),
        costWei: 1n,
        spends: [w.nf],
      };
    },
  };
});

import { configure, defaultConfig } from "../src/config";
import { memoryStorage, JOURNAL_KEY } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { noteStore, type OwnedNote } from "../src/wallet/notes";
import { decryptJournal, journalKey, type EncryptedJournal, type JournalData } from "../src/wallet/journal";
import { AutoLock, type AutoLockClock, type LockTrigger } from "../src/session/autoLock";
import { mergeNotes, splitNote } from "../src/privateTx";
import { mainOwnerCommitment } from "../src/keys/ownerKeys";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { MerkleLayers } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";

const E16 = 10n ** 16n;
const E17 = 10n ** 17n;
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
const PASSWORD = "a strong password";
/** The wallet's seed. The session keeps its own copy, zeroed at a lock; this one opens the journal the device stores. */
const seed = new Uint8Array(32).fill(9);
const keys = deriveKeys(seed);
const store = memoryStorage();

beforeAll(async () => {
  configure(
    defaultConfig({
      storage: () => store,
      kdfLog2N: 12,
      // the proof: its public inputs are the plan's, as the circuit's are
      prover: async (spec) => {
        w.spec = spec;
        const publicInputs = expectedPublicInputs(spec);
        w.nf = [publicInputs.nullifier0, publicInputs.nullifier1];
        w.whileProving?.();
        return { proof: ("0x" + "00".repeat(256)) as Hex, publicInputs, publicSignals: [], ms: 1, verifiedLocally: false };
      },
    }),
  );
  await session.create(PASSWORD, seed);
  session.acknowledgePhrase();
});

beforeEach(async () => {
  if (!session.isUnlocked()) await session.unlock(PASSWORD); // a case before locked the wallet
  noteStore.clear(); // nothing of the case before, the counters free from 0 (as after the scan an unlock waits for)
});

/** Two notes of this wallet of 0.1 each at leaves 0 and 1, and the tree that holds them. */
function twoNotes(): [OwnedNote, OwnedNote] {
  const oc = mainOwnerCommitment(keys);
  const notes = [0, 1].map((leafIndex): OwnedNote => ({
    note: { vaultId: BigInt(VAULT), amount: E17, ownerCommitment: oc, noteSecret: 7n + BigInt(leafIndex) },
    leafIndex,
    noteData: "0x",
    spent: false,
  }));
  const leaves = notes.map((n) => noteCommitment(noteBody(n.note), BigInt(n.leafIndex)));
  w.tree = { leaves, root: 0n, nextLeafIndex: 2, notes: 2, layers: MerkleLayers.build(leaves, TX_LEVELS) } satisfies TreeState;
  for (const n of notes) noteStore.add(n);
  return notes as [OwnedNote, OwnedNote];
}

/** A note as these cases compare it, in the store or in the journal: its leaf, amount, spent mark and label, by leaf. */
type Row = [leaf: number, amount: bigint, spent: boolean, label: string | null];
const byLeaf = (rows: Row[]): Row[] => rows.sort((x, y) => x[0] - y[0]);
const storeRows = (): Row[] => byLeaf(noteStore.all().map((n): Row => [n.leafIndex, n.note.amount, n.spent, n.label ?? null]));
const journalRows = (j: JournalData): Row[] => byLeaf(j.notes.map((n): Row => [n.leafIndex, BigInt(n.amount), n.spent, n.label ?? null]));
/** The journal as the device stores it, opened with the seed: what the next unlock loads. */
const storedJournal = (): JournalData => decryptJournal(journalKey(seed), JSON.parse(store.get(JOURNAL_KEY)!) as EncryptedJournal)!;
/** A new note of this wallet as the journal keeps it: its secret the seed's at its counter, so the next unlock can spend it. */
const ownEntry = (leafIndex: number, amount: bigint, counter: number, label: string) => ({
  vaultId: BigInt(VAULT).toString(),
  amount: amount.toString(),
  ownerCommitment: mainOwnerCommitment(keys).toString(),
  noteSecret: deriveNoteSecret(keys.noteKey, counter).toString(),
  leafIndex,
  counter,
  spent: false,
  txHash: HASH,
  label,
});

/**
 * A spend under the auto-lock (15 idle minutes, on a clock of the test's): the idle deadline passes while it proves, so the lock is due from
 * there on, held off by the spend's hold, and happens at the hold's release. Returns what the spend returned, what the auto-lock did, what the
 * prover saw, and the journal the lock left on the device.
 */
async function idleLockAtTheRelease<T>(
  spend: () => Promise<T>,
): Promise<{ result: T; locks: LockTrigger[]; proving: { holds: string[]; unlocked: boolean }; journal: JournalData }> {
  let now = Date.now();
  const clock: AutoLockClock = { now: () => now, setTimeout: () => 0 as never, clearTimeout: () => undefined };
  const locks: LockTrigger[] = [];
  const auto = new AutoLock({ session, minutes: () => 15, clock, onLock: (t) => locks.push(t) });
  const stop = auto.start();
  const proving = { holds: [] as string[], unlocked: false };
  w.whileProving = () => {
    now += 20 * 60_000; // the idle deadline passes while the spend proves
    auto.check(); // due now: the spend's hold defers it
    proving.holds = session.holds().map((h) => h.reason);
    proving.unlocked = session.isUnlocked();
  };
  try {
    const result = await spend();
    return { result, locks, proving, journal: storedJournal() };
  } finally {
    w.whileProving = null;
    stop();
  }
}

describe("a merge's and a split's own new note, recorded with the spend (A11-10)", () => {
  it("a merge puts its merged note in the note store and in the journal on the device: at the leaf its receipt gave it, the two inputs' sum, unspent, its secret the seed's at its counter", async () => {
    const [a, b] = twoNotes();
    const r = await mergeNotes({ masterSeed: seed, deployment, a, b, submission: { kind: "wallet" } });
    expect(r.merged.leafIndex).toBe(2);
    const after: Row[] = [
      [0, E17, true, null],
      [1, E17, true, null],
      [2, 2n * E17, false, "merged"],
    ];
    expect(storeRows(), "the inputs spent, the merged note in the store").toEqual(after);
    expect(noteStore.balance(BigInt(VAULT)), "the balance is the merged note").toBe(2n * E17);
    const j = storedJournal();
    expect(journalRows(j), "the same in the journal").toEqual(after);
    expect(j.notes.find((n) => n.leafIndex === 2)).toMatchObject({ ...ownEntry(2, 2n * E17, 0, "merged"), noteData: r.merged.noteData });
  });

  it("a split puts its piece in the note store and in the journal on the device beside the rest: the input spent, the wallet's other note untouched", async () => {
    const [a] = twoNotes();
    const r = await splitNote({ masterSeed: seed, deployment, note: a, piece: 4n * E16, submission: { kind: "wallet" } });
    expect([r.pieceNote.leafIndex, r.restNote.leafIndex]).toEqual([2, 3]);
    const after: Row[] = [
      [0, E17, true, null],
      [1, E17, false, null],
      [2, 4n * E16, false, "piece"],
      [3, 6n * E16, false, "change"],
    ];
    expect(storeRows(), "the piece beside the rest in the store").toEqual(after);
    const j = storedJournal();
    expect(journalRows(j), "the same in the journal").toEqual(after);
    expect(j.notes.find((n) => n.leafIndex === 2)).toMatchObject({ ...ownEntry(2, 4n * E16, 0, "piece"), noteData: r.pieceNote.noteData });
  });

  it("an idle deadline that passes while a merge proves locks at the spend's release, after the merged note was journaled: the journal the lock left holds it, and the next unlock opens it into the balance", async () => {
    const [a, b] = twoNotes();
    const { result, locks, proving, journal } = await idleLockAtTheRelease(() =>
      mergeNotes({ masterSeed: seed, deployment, a, b, submission: { kind: "wallet" } }),
    );
    expect(proving, "due while it proved, held off by the spend's hold").toEqual({ holds: ["spend"], unlocked: true });
    expect(locks, "the idle lock, once").toEqual(["idle"]);
    expect(session.isUnlocked(), "locked at the hold's release").toBe(false);
    expect(result.merged.leafIndex).toBe(2);
    const after: Row[] = [
      [0, E17, true, null],
      [1, E17, true, null],
      [2, 2n * E17, false, "merged"],
    ];
    expect(journalRows(journal), "the spent inputs and the merged note, never the spent inputs alone").toEqual(after);
    expect(await session.unlock(PASSWORD)).toBe(true);
    expect(storeRows(), "the next unlock's store, before any scan").toEqual(after);
    expect(noteStore.balance(BigInt(VAULT)), "the balance keeps the merged note").toBe(2n * E17);
  });

  it("so does a split's piece: an idle lock at the spend's release leaves the piece beside the rest in the journal", async () => {
    const [a] = twoNotes();
    const { result, locks, journal } = await idleLockAtTheRelease(() =>
      splitNote({ masterSeed: seed, deployment, note: a, piece: 4n * E16, submission: { kind: "wallet" } }),
    );
    expect(locks, "the idle lock, once, at the hold's release").toEqual(["idle"]);
    expect(session.isUnlocked()).toBe(false);
    expect([result.pieceNote.leafIndex, result.restNote.leafIndex]).toEqual([2, 3]);
    expect(journalRows(journal), "the piece too, not the rest alone").toEqual([
      [0, E17, true, null],
      [1, E17, false, null],
      [2, 4n * E16, false, "piece"],
      [3, 6n * E16, false, "change"],
    ]);
  });
});
