// The twelfth review round, slice 12e2 (E12-2, E12-5; the reconciler's decision W6 §3): the fresh-address indexes and Private AI's funding index
// past their reserves wherever a journal turns out not to know what was handed out. E12-5: a profile restored from an older copy of itself — the
// scan finds counters the journal did not know, beginning at its own — resumed its note counters a reserve past them (the fifth round's rule) and
// trusted its indexes: the next Receive handed out an address its lost period had given to a payer. Its addresses now resume past their reserves
// too, but only on that continuation: another installation of the seed hands its counters out a reserve past what it saw, and two installations
// taking turns would otherwise jump at every turn (W6 §3's probe: both landed on one index). E12-2: a merge into a journal no restore began
// recorded nothing it knew, and its next backup was compared with the first merge's resume point — a guess —, the reserve past the other
// installation held once. The real scan runs over a scripted pool (an in-process JSON-RPC endpoint, as review11-k-scan.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, toFunctionSelector, toHex, type Hex } from "viem";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { configure, defaultConfig } from "../src/config";
import { useCoreModule } from "../src/core";
import { coreAbi } from "../src/privacyProtocol";
import { COUNTER_RESERVE, scanNotes } from "../src/privateTx";
import { depositOwnerCommitment } from "../src/keys/ownerKeys";
import { KEYSTORE_KEY, memoryStorage } from "../src/wallet/storage";
import { session, WalletSession } from "../src/wallet/session";
import { NoteStore, noteStore } from "../src/wallet/notes";
import { ADDRESS_INDEX_RESERVE, AI_FUNDING_RESERVE, emptyJournal, restoredJournal, rolledBackJournal, type JournalData } from "../src/wallet/journal";
import { mergeJournals } from "../src/wallet/journalMerge";
import type { Deployment } from "../src/chain";

const PASSWORD = "a strong password";
const SEED = Uint8Array.from({ length: 32 }, (_, i) => (i * 29 + 7) & 0xff);
const keys = deriveKeys(SEED);
const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const RPC = "http://127.0.0.1:1";
const deployment: Deployment = { chainId: 31337, core: CORE, ethVault: VAULT, rpcUrl: RPC, rpcUrls: [RPC], fromBlock: 0n, erc20Vaults: [] };
const hex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;

interface Insert {
  leafIndex: number;
  commitment: bigint;
  noteData: Hex;
}
/**
 * this seed's notes of the counters given, at leaves 0, 1, 2, … (a deposit made out to its own owner commitment, or a change note), then
 * someone else's up to the next group of four (the pool inserts by four; every leaf has its event)
 */
function notesOf(counters: number[]): Insert[] {
  const filler = (leafIndex: number): Insert => ({ leafIndex, commitment: 0xf00000n + BigInt(leafIndex), noteData: hex(dummyNoteData()) });
  const ours = counters.map((k, leafIndex) => {
    const noteSecret = deriveNoteSecret(keys.noteKey, k);
    const owner = k % 2 === 0 ? depositOwnerCommitment(keys, noteSecret) : ownerCommitmentOf(keys.spendKey);
    const note: Note = { vaultId: BigInt(VAULT), amount: BigInt(k + 1) * 10n ** 15n, ownerCommitment: owner, noteSecret };
    const commitment = noteCommitment(noteBody(note), BigInt(leafIndex));
    return {
      leafIndex,
      commitment,
      noteData: hex(encryptNoteData(viewKeyPair(keys.viewKey).publicKey, { amount: note.amount, noteSecret, vaultId: note.vaultId })),
    };
  });
  return [...ours, ...Array.from({ length: (4 - (ours.length % 4)) % 4 }, (_, i) => filler(ours.length + i))];
}
const pool = { inserts: [] as Insert[] };
const next = (): number => pool.inserts.length;
const root = (): bigint => {
  const leaves = new Map(pool.inserts.map((l) => [l.leafIndex, l.commitment]));
  const t = new MerkleTree(TX_LEVELS);
  for (let g = 0; g < next(); g += 4) t.insertGroup([0, 1, 2, 3].map((k) => leaves.get(g + k) ?? ZERO_LEAF));
  return t.root;
};
const SEL = { next: toFunctionSelector("nextLeafIndex()"), root: toFunctionSelector("currentRoot()") };
const pad32 = (v: bigint): Hex => ("0x" + v.toString(16).padStart(64, "0")) as Hex;
const noteLog = (l: Insert) => ({
  address: CORE.toLowerCase(),
  blockNumber: "0x5",
  blockHash: "0x" + "22".repeat(32),
  transactionHash: "0x" + "33".repeat(28) + l.leafIndex.toString(16).padStart(8, "0"),
  transactionIndex: "0x0",
  logIndex: toHex(l.leafIndex),
  removed: false,
  topics: encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex: l.leafIndex } }),
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [l.commitment, l.noteData]),
});
interface RpcRequest {
  id: number;
  method: string;
  params: unknown[];
}
function answer(req: RpcRequest) {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "eth_chainId":
      return ok(toHex(deployment.chainId));
    case "eth_blockNumber":
      return ok("0x40");
    case "eth_getLogs": {
      const t0 = ((req.params[0] ?? {}) as { topics?: (string | string[] | null)[] }).topics?.[0];
      const inserted = encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted" })[0].toLowerCase();
      const wanted = !t0 || (Array.isArray(t0) ? t0 : [t0]).some((t) => t.toLowerCase() === inserted);
      return ok(wanted ? pool.inserts.map(noteLog) : []);
    }
    case "eth_call": {
      const data = (req.params[0] as { data: string }).data;
      if (data.startsWith(SEL.next)) return ok(pad32(BigInt(next())));
      if (data.startsWith(SEL.root)) return ok(pad32(root()));
      return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "mock: unknown call" } };
    }
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock: ${req.method} unsupported` } };
  }
}
const realFetch = globalThis.fetch;
const rpcFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(RPC)) throw new TypeError(`offline: this test answers ${RPC} only, not ${url}`);
  const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { headers: { "content-type": "application/json" } });
};

const disk = memoryStorage(); // one device: the wallet locked and unlocked on it
beforeAll(() => {
  configure(defaultConfig({ kdfLog2N: 12, storage: () => disk }));
  useCoreModule(null); // the TypeScript reference opens the payloads and hashes the tree
  globalThis.fetch = rpcFetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  session.forget();
});

/**
 * This wallet on this device with its journal as `as` sets it — then locked and unlocked, as a profile restored from an older copy is opened:
 * the counters held until the scan after the unlock.
 */
async function opened(as: (j: JournalData) => void, used = 0): Promise<void> {
  session.forget();
  await session.create(PASSWORD, SEED);
  session.acknowledgePhrase();
  for (let i = 0; i < used; i++) noteStore.allocateCounter(); // the journal's counter is the store's
  session.update(as);
  session.lock();
  expect(await session.unlock(PASSWORD)).toBe(true);
  expect(noteStore.countersHeld(), "held until the scan after the unlock").toBe(true);
}
const scan = () => scanNotes({ masterSeed: session.state().seed!, deployment });

describe("a journal the scan finds to be an older copy of itself (E12-5; W6 §3)", () => {
  it("its counters past what was found and a reserve, and its fresh addresses and Private AI's funding index past their reserves — never one its lost period handed out", async () => {
    // the newer copy had used counters 0–4, handed out EVM addresses 1 and 2 and funded Private AI's address 0; the older copy knew none of it
    pool.inserts = notesOf([0, 1, 2, 3, 4]);
    await opened((j) => {
      j.chainIndexes = { evm: 1 };
      j.aiFunding = { index: 0 };
    });
    await scan();
    expect(noteStore.countersHeld()).toBe(false);
    expect(noteStore.nextCounter(), "past what was found, and the reserve").toBe(5 + COUNTER_RESERVE);
    const j = session.journal();
    expect(j.chainIndexes.evm, "never index 1 or 2 again").toBeGreaterThanOrEqual(1 + ADDRESS_INDEX_RESERVE);
    expect(j.chainIndexes.evm).toBeLessThan(1 + 2 * ADDRESS_INDEX_RESERVE);
    expect(j.chainIndexes.bitcoin, "every chain, as a restore resumes").toBeGreaterThanOrEqual(ADDRESS_INDEX_RESERVE);
    expect(j.aiFunding?.index, "a funding address the lost period may have funded is never offered again").toBeGreaterThanOrEqual(AI_FUNDING_RESERVE);
    expect(j.resumedPast, "what the journal knew: a later backup merge compares with it").toEqual({ chainIndexes: { evm: 1 }, aiFunding: 0 });
    // the next scan of this opening moves nothing more: the hold is gone
    const after = { ...session.journal().chainIndexes };
    await scan();
    expect(session.journal().chainIndexes).toEqual(after);
  });

  it("a backup of the same moment restored over the rolled-back journal (REPLACE): the merge kept the device's indexes, and the scan still resumes them", async () => {
    // the profile put back to the moment S, then the backup file made at S restored over it — the recovery a user tries on missing activity
    pool.inserts = notesOf([0, 1, 2, 3, 4]);
    session.forget();
    await session.create(PASSWORD, SEED);
    session.acknowledgePhrase();
    session.update((j) => {
      j.chainIndexes = { evm: 1 };
      j.aiFunding = { index: 0 };
    });
    const atS = session.exportBackup();
    expect(await session.restoreFromBackup(atS, PASSWORD, { replace: true })).toBe(true);
    expect(session.journal().countersHeldByMerge, "the hold is a merge's into this device's own journal").toBe(true);
    await scan();
    expect(noteStore.nextCounter()).toBe(5 + COUNTER_RESERVE);
    expect(session.journal().chainIndexes.evm, "never index 1 or 2 again").toBeGreaterThanOrEqual(1 + ADDRESS_INDEX_RESERVE);
    expect(session.journal().aiFunding?.index).toBeGreaterThanOrEqual(AI_FUNDING_RESERVE);
    expect(session.journal().countersHeld).toBeUndefined();
    expect(session.journal().countersHeldByMerge, "gone with the hold").toBeUndefined();
  });

  it("a backup restored where this wallet's journal was set aside unreadable: that journal resumed past its reserve when read, and the scan resumes nothing again", async () => {
    pool.inserts = notesOf([0, 1, 2, 3, 4]);
    session.forget();
    await session.create(PASSWORD, SEED);
    session.acknowledgePhrase();
    session.update((j) => {
      j.chainIndexes = { evm: 1 };
    });
    const backup = session.exportBackup();
    session.lock();
    // another wallet's keystore over it: this wallet's journal no longer opens and is set aside (A11-8)
    const other = new WalletSession(memoryStorage(), { N: 1 << 12, r: 8, p: 1 });
    await other.create("pw of another", new Uint8Array(32).fill(9));
    other.acknowledgePhrase();
    disk.set(KEYSTORE_KEY, JSON.stringify(JSON.parse(other.exportBackup()).keystore));
    other.lock();
    expect(await session.unlock("pw of another")).toBe(true);
    session.discardUnreadableJournal();
    session.lock();
    expect(await session.restoreFromBackup(backup, PASSWORD, { replace: true })).toBe(true);
    expect(session.journal().countersHeldByMerge, "the merge's base was the set-aside journal, resumed already").toBeUndefined();
    const resumed = session.journal().chainIndexes.evm;
    expect(resumed).toBeGreaterThanOrEqual(1 + ADDRESS_INDEX_RESERVE);
    await scan();
    expect(session.journal().chainIndexes.evm, "one resume, not two").toBe(resumed);
  });

  it("a journal the scan finds current resumes where it was: no counter past it, no address moved", async () => {
    pool.inserts = notesOf([0, 1, 2]);
    await opened((j) => {
      j.chainIndexes = { evm: 4 };
    }, 3);
    await scan();
    expect(noteStore.nextCounter()).toBe(3);
    expect(session.journal().chainIndexes).toEqual({ evm: 4 });
    expect(session.journal().resumedPast).toBeUndefined();
  });

  it("another installation's counters, a reserve past this journal's: the counters past them, the addresses where they were (two installations taking turns never jump)", async () => {
    // the other installation (restored from this one's backup at counter 3) handed out its counters from 3 + 256 on
    pool.inserts = notesOf([0, 1, 2, 259, 260]);
    await opened((j) => {
      j.chainIndexes = { evm: 4 };
    }, 3);
    await scan();
    expect(noteStore.nextCounter(), "past what was found, and the reserve").toBe(261 + COUNTER_RESERVE);
    expect(session.journal().chainIndexes, "no jump: the other installation's addresses are its own range's").toEqual({ evm: 4 });
    expect(session.journal().resumedPast).toBeUndefined();
  });
});

describe("the note store's answer (W6 §3: a continuation of the journal's own counters)", () => {
  /** a store loaded with a journal at `counter`, held until the scan after its unlock */
  const loadedAt = (counter: number): NoteStore => {
    const s = new NoteStore();
    s.load({ notes: [], noteCounter: counter });
    s.holdUntilScanned();
    return s;
  };

  it("counters found beginning within a quarter of the reserve past the loaded one: an older copy of itself — 63 is, 64 is not", () => {
    const at63 = loadedAt(10);
    at63.observeCounter(10 + 63);
    expect(at63.releaseCounters(COUNTER_RESERVE)).toBe(true);
    const at64 = loadedAt(10);
    at64.observeCounter(10 + 64);
    expect(at64.releaseCounters(COUNTER_RESERVE)).toBe(false);
    expect(at64.nextCounter(), "the counters still take their reserve").toBe(75 + COUNTER_RESERVE);
  });

  it("the loaded counter itself found is the lowest edge: an older copy of itself", () => {
    const s = loadedAt(10);
    s.observeCounter(10);
    expect(s.releaseCounters(COUNTER_RESERVE)).toBe(true);
  });

  it("under a backup merge's hold into this device's own journal it answers as under none: that merge resumed no index of the device's", () => {
    const merged = new NoteStore();
    merged.load({ notes: [], noteCounter: 10, countersHeld: true, countersHeldByMerge: true });
    merged.observeCounter(10);
    expect(merged.releaseCounters(COUNTER_RESERVE)).toBe(true);
    const far = new NoteStore();
    far.load({ notes: [], noteCounter: 10, countersHeld: true, countersHeldByMerge: true });
    far.observeCounter(10 + 64);
    expect(far.releaseCounters(COUNTER_RESERVE), "another installation's, as under no hold").toBe(false);
  });

  it("the lowest counter found past the loaded one decides, whatever the order it is found in", () => {
    const s = loadedAt(10);
    for (const c of [3, 300, 12, 90]) s.observeCounter(c);
    expect(s.releaseCounters(COUNTER_RESERVE)).toBe(true);
  });

  it("never for a current journal, a restore's hold, or a second release in one opening", () => {
    const current = loadedAt(10);
    current.observeCounter(9);
    expect(current.releaseCounters(COUNTER_RESERVE), "nothing found past the loaded counter").toBe(false);
    const restored = new NoteStore();
    restored.load({ notes: [], noteCounter: 10, countersHeld: true });
    restored.observeCounter(10);
    expect(restored.releaseCounters(COUNTER_RESERVE), "a restore's hold, its journal resumed already (restoredJournal)").toBe(false);
    const twice = loadedAt(10);
    twice.observeCounter(11);
    expect(twice.releaseCounters(COUNTER_RESERVE)).toBe(true);
    twice.observeCounter(12);
    expect(twice.releaseCounters(COUNTER_RESERVE), "the hold is gone: nothing moves again").toBe(false);
  });

  it("each opening's own: a new load forgets what an earlier opening's scan found and never released", () => {
    const s = loadedAt(10);
    s.observeCounter(12); // that opening's scan never completed
    s.load({ notes: [], noteCounter: 500 });
    s.holdUntilScanned();
    s.observeCounter(600);
    expect(s.releaseCounters(COUNTER_RESERVE), "600 is 100 past 500, beyond a quarter of the reserve: another installation's").toBe(false);
  });

  it("two installations taking turns: each finds the other's counters a reserve past its own and never reads as an older copy of itself", () => {
    // A hands out counters 0–2; B, restored from A's backup at 3, resumes 256 past what it found; then each opens after the other's turn
    let a = 3;
    let b = 3 + COUNTER_RESERVE;
    for (let turn = 0; turn < 4; turn++) {
      const aOpens = loadedAt(a);
      for (const c of [b, b + 1, b + 2]) aOpens.observeCounter(c); // B's turn: three counters
      expect(aOpens.releaseCounters(COUNTER_RESERVE), `A's unlock, turn ${turn}`).toBe(false);
      a = aOpens.nextCounter() + 3; // A's turn
      const bOpens = loadedAt(b + 3);
      for (const c of [a - 3, a - 2, a - 1]) bOpens.observeCounter(c);
      expect(bOpens.releaseCounters(COUNTER_RESERVE), `B's unlock, turn ${turn}`).toBe(false);
      b = bOpens.nextCounter();
    }
  });
});

describe("what a journal knows travels with it (E12-2, E12-5)", () => {
  const journal = (o: Partial<JournalData>): JournalData => ({ ...emptyJournal(), ...o });

  it("a rolled-back journal's indexes resume past their reserves, and what it knew is recorded with any earlier record", () => {
    const j = journal({ chainIndexes: { evm: 1, bitcoin: 3 }, aiFunding: { index: 2, funded: 2 } });
    const r = rolledBackJournal(j, () => 0);
    expect(r.chainIndexes).toEqual({ evm: 1001, bitcoin: 1003, solana: 1000 });
    expect(r.aiFunding).toEqual({ index: 102 });
    expect(r.resumedPast).toEqual({ chainIndexes: { evm: 1, bitcoin: 3 }, aiFunding: 2 });
    const earlier = rolledBackJournal({ ...j, resumedPast: { chainIndexes: { evm: 5, solana: 9 }, aiFunding: 7 } }, () => 0);
    expect(earlier.resumedPast).toEqual({ chainIndexes: { evm: 5, solana: 9, bitcoin: 3 }, aiFunding: 7 });
  });

  it("a rolled-back journal from before Private AI was used: the funding index resumes past its reserve all the same", () => {
    const r = rolledBackJournal(journal({ chainIndexes: { evm: 1 } }), () => 0);
    expect(r.aiFunding, "the lost period may have funded address 0").toEqual({ index: AI_FUNDING_RESERVE });
    expect(r.resumedPast).toEqual({ chainIndexes: { evm: 1 }, aiFunding: 0 });
  });

  it("every resume draw comes from the CSPRNG by default: a restore's, a rolled-back journal's", () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    try {
      restoredJournal(journal({ chainIndexes: { evm: 3 } }));
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      rolledBackJournal(journal({ chainIndexes: { evm: 3 } }));
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the device's own funding index stays in the record where it is ahead of the backup's", () => {
    const m = mergeJournals(
      journal({ chainIndexes: { evm: 10 }, aiFunding: { index: 50 } }),
      journal({ chainIndexes: { evm: 1500 }, aiFunding: { index: 5 } }),
      () => 0,
    );
    expect(m.aiFunding?.index, "past the backup's already").toBe(50);
    expect(m.resumedPast).toEqual({ chainIndexes: { evm: 1500 }, aiFunding: 50 });
    // the other installation's next backup at 30: this device was past it, nothing moves
    expect(mergeJournals(m, journal({ aiFunding: { index: 30 } }), () => 0).aiFunding?.index).toBe(50);
  });

  it("a journal no restore began: its second backup merge resumes past the second backup, never left at the first merge's guess", () => {
    // this device created the wallet (EVM index 10); the other installation's backups at 1500, then 2400 after it went on
    const first = mergeJournals(
      journal({ chainIndexes: { evm: 10 }, aiFunding: { index: 3 } }),
      journal({ chainIndexes: { evm: 1500 }, aiFunding: { index: 40 } }),
      () => 0,
    );
    expect(first.chainIndexes.evm).toBe(1500 + ADDRESS_INDEX_RESERVE);
    expect(first.resumedPast, "what the device and the backup knew").toEqual({ chainIndexes: { evm: 1500 }, aiFunding: 40 });
    const second = mergeJournals(first, journal({ chainIndexes: { evm: 2400 }, aiFunding: { index: 90 } }), () => 0);
    expect(second.chainIndexes.evm, "the reserve past the other installation's next index").toBe(2400 + ADDRESS_INDEX_RESERVE);
    expect(second.aiFunding?.index).toBe(90 + AI_FUNDING_RESERVE);
    expect(second.resumedPast).toEqual({ chainIndexes: { evm: 2400 }, aiFunding: 90 });
    // the same backup again moves nothing
    expect(mergeJournals(second, journal({ chainIndexes: { evm: 2400 }, aiFunding: { index: 90 } }), () => 0).chainIndexes.evm).toBe(
      2400 + ADDRESS_INDEX_RESERVE,
    );
  });

  it("recorded whichever index resumed: a chain's alone, or Private AI's funding index alone", () => {
    const chain = mergeJournals(journal({ chainIndexes: { evm: 10 } }), journal({ chainIndexes: { evm: 1500 } }), () => 0);
    expect(chain.resumedPast).toEqual({ chainIndexes: { evm: 1500 }, aiFunding: 0 });
    const ai = mergeJournals(
      journal({ chainIndexes: { evm: 10 }, aiFunding: { index: 3 } }),
      journal({ chainIndexes: { evm: 4 }, aiFunding: { index: 40 } }),
      () => 0,
    );
    expect(ai.aiFunding?.index).toBe(40 + AI_FUNDING_RESERVE);
    expect(ai.resumedPast).toEqual({ chainIndexes: { evm: 10 }, aiFunding: 40 });
    // the other installation's next funding index, past what it knew and short of the resume point: still past its reserve
    expect(mergeJournals(ai, journal({ aiFunding: { index: 90 } }), () => 0).aiFunding?.index).toBe(90 + AI_FUNDING_RESERVE);
  });

  it("a merge that resumes nothing records nothing: a journal no restore began knows its own indexes", () => {
    expect(mergeJournals(journal({ chainIndexes: { evm: 10 } }), journal({ chainIndexes: { evm: 4 } }), () => 0).resumedPast).toBeUndefined();
  });

  it("after a rolled-back journal resumed, a backup at what it knew moves nothing; one past it resumes past that backup", () => {
    const rolled = rolledBackJournal(journal({ chainIndexes: { evm: 1 } }), () => 0);
    expect(mergeJournals(rolled, journal({ chainIndexes: { evm: 1 } }), () => 0).chainIndexes.evm).toBe(1001);
    // the newer copy's own backup, which had handed out 1 and 2: past it, and still past the resume point
    expect(mergeJournals(rolled, journal({ chainIndexes: { evm: 3 } }), () => 0).chainIndexes.evm).toBe(1003);
  });
});
