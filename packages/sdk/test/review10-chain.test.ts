// The tenth review round (2026-11-04), part B — round 9's chain-truth changes against honest users: the windowed read is judged by its own
// pace, never a fixed deadline, and its windows grow back (B10-1); one event listed twice is one event (B10-10); the scan journals only the
// refunds it records (B10-2); a note a scan found has its time, so a view a block behind drops nothing at once (B10-3). The reviewer's probes
// (scratchpad review10/B P1, P8, P12, P2b) became these cases; the scan cases run on the loopback pool (helpers/mockPool.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, type Note } from "@privacy-wallet/protocol/note";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { useCoreModule } from "../src/core";
import { scanNotes } from "../src/privateTx";
import { noteStore } from "../src/wallet/notes";
import { depositOwnerCommitment } from "../src/keys/ownerKeys";
import { refundPayload } from "../src/keys/swapKeys";
import { coreLogs, logsInWindows, MAX_PROJECTED_READ_MS, type Deployment } from "../src/chain";
import type { StoredSwap } from "../src/wallet/journal";
import { startPool, type Insert } from "./helpers/mockPool";

describe("the windowed read (the tenth review round, B10-1)", () => {
  afterEach(() => vi.restoreAllMocks());
  const capped = (cap: bigint, msPerRead: number, clock: { t: number }) => {
    const windows: [bigint, bigint][] = [];
    let refused = 0;
    const read = async (from: bigint, to: bigint | "latest") => {
      clock.t += msPerRead;
      if (to === "latest" || to - from + 1n > cap) {
        refused++;
        throw new Error("query returned more than 10000 results");
      }
      windows.push([from, to]);
      return [from];
    };
    return { read, windows, refused: () => refused };
  };

  it("an honest endpoint capped at 1,000 blocks reads a history of two million blocks to its end, past the ninth round's ten minutes", async () => {
    const clock = { t: 0 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    const e = capped(1000n, 200, clock);
    const out = await logsInWindows({ getBlockNumber: async () => 2_000_000n } as never, 0n, e.read, 10_000n, 2_000_000n);
    expect(clock.t, "longer than the ninth round's fixed ten minutes").toBeGreaterThan(10 * 60_000);
    expect(e.windows[0][0]).toBe(0n);
    for (let i = 1; i < e.windows.length; i++) expect(e.windows[i][0], "contiguous").toBe(e.windows[i - 1][1] + 1n);
    expect(e.windows[e.windows.length - 1][1]).toBe(2_000_000n);
    expect(out).toHaveLength(e.windows.length);
    // the windows grow back after a run of answers: against the 1,000-block cap one request in seventeen is refused, never one in two
    expect(e.refused()).toBeLessThan(e.windows.length / 8);
  });

  it("a head no chain has is refused at once, and a pace that would take more than two hours is refused within a minute of windows", async () => {
    const clock = { t: 0 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.t);
    const absurd = capped(1000n, 1, clock);
    await expect(logsInWindows({ getBlockNumber: async () => 0n } as never, 0n, absurd.read, 10_000n, 10n ** 15n)).rejects.toThrow(/than any chain has/);
    expect(absurd.windows).toHaveLength(0);
    // an endpoint answering a ten-block window every minute, over a million blocks: the pace says weeks
    const slow = capped(10n, 60_000, clock);
    await expect(logsInWindows({ getBlockNumber: async () => 0n } as never, 0n, slow.read, 10_000n, 1_000_000n)).rejects.toThrow(
      new RegExp(`would take more than ${MAX_PROJECTED_READ_MS / 3_600_000} hours at its pace`),
    );
    expect(slow.windows.length, "judged after its first windows, never walked to the end").toBeLessThan(200);
  });
});

describe("one event listed twice (the tenth review round, B10-10)", () => {
  it("is one event; two different events at one leaf stay refused", async () => {
    const d = { core: "0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9", fromBlock: 0n } as unknown as Deployment;
    const log = { eventName: "NoteInserted", args: { leafIndex: 0, commitment: 11n, noteData: "0x11" }, transactionHash: "0xaa", blockNumber: 5n, logIndex: 0 };
    const spend = { eventName: "ShieldedTransaction", args: { nullifier0: 3n, nullifier1: 4n }, transactionHash: "0xbb", blockNumber: 6n, logIndex: 1 };
    const client = (logs: unknown[]) => ({ getBlockNumber: async () => 10n, getLogs: async () => logs }) as never;
    const r = await coreLogs(client([log, { ...log }, spend, { ...spend }]), d, 10n);
    expect(r.logs).toHaveLength(1);
    expect(r.spends).toHaveLength(1);
    const other = await coreLogs(client([log, { ...log, args: { ...log.args, commitment: 12n } }]), d, 10n);
    expect(other.logs, "both kept: buildTree refuses them (D-9)").toHaveLength(2);
  });
});

// the light client: the pool proven at finalized block 100 (`proven` leaves), every nullifier proven unspent there
const lc = vi.hoisted(() => ({ proven: 8 }));
vi.mock("../src/verifiedReads", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyTree: async () => ({ kind: "verified", proof: { blockNumber: 100n, slot: 1, nextLeafIndex: lc.proven, root: 0n }, leaves: lc.proven }),
  provenSpent: async (_d: unknown, nfs: bigint[]) => (nfs.length ? { blockNumber: 100n, blocks: nfs.map(() => 100n), spent: nfs.map(() => false) } : null),
}));

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const rootOf = (leaves: Map<number, bigint>, next: number) => {
  const t = new MerkleTree(TX_LEVELS);
  for (let g = 0; g < next; g += 4) t.insertGroup([0, 1, 2, 3].map((k) => leaves.get(g + k) ?? ZERO_LEAF));
  return t.root;
};
let pool: Awaited<ReturnType<typeof startPool>>;
const d = (): Deployment => ({ chainId: 1, core: CORE, ethVault: VAULT, rpcUrl: pool.url, rpcUrls: [pool.url], fromBlock: 0n, erc20Vaults: [] });
function serve(inserts: Insert[], next: number) {
  pool.state.inserts = inserts;
  pool.state.next = next;
  pool.state.root = rootOf(new Map(inserts.map((i) => [i.leafIndex, i.commitment])), next);
}

describe("the scan against a lagging or lying view (the tenth review round, B10-2, B10-3)", () => {
  beforeAll(async () => {
    const store = memoryStorage();
    configure(defaultConfig({ kdfLog2N: 12, storage: () => store }));
    await session.create("a strong password", undefined, { replace: true });
    session.acknowledgePhrase();
    pool = await startPool({ core: CORE, inserts: [], next: 0, root: rootOf(new Map(), 0) });
  });
  afterAll(async () => {
    await pool.close();
  });
  beforeEach(() => {
    useCoreModule(null);
    noteStore.load({ notes: [], noteCounter: 0 });
    lc.proven = 8;
    pool.state.spends = [];
    pool.state.deposits = [];
    pool.state.block = 0x80n;
    session.update((j) => {
      j.swaps = [];
      j.notes = [];
    });
  });

  it("a refund a lying quorum replays at a tail leaf is not journaled for its order, and an honest proof later records the real one", async () => {
    const seed = session.state().seed!;
    const keys = deriveKeys(seed);
    const counter = 5;
    const secret = deriveNoteSecret(keys.noteKey, counter);
    const oc = depositOwnerCommitment(keys, secret);
    const payload = refundPayload(seed, counter);
    const amount = 7n * 10n ** 17n;
    const note: Note = { vaultId: BigInt(VAULT), amount, ownerCommitment: oc, noteSecret: secret };
    const ins = (leaf: number): Insert => ({ leafIndex: leaf, commitment: noteCommitment(noteBody(note), BigInt(leaf)), noteData: payload });
    const order = {
      orderId: "0x" + "01".repeat(32),
      refundCounter: counter,
      refundNoteData: payload,
      state: "funded",
      request: { from: { chain: "ethereum", symbol: "ETH", decimals: 18 }, to: { chain: "bitcoin", symbol: "BTC", decimals: 8 } },
      params: { refundOwnerCommitment: oc.toString(), amount: amount.toString() },
    } as unknown as StoredSwap;
    session.update((j) => {
      j.swaps = [order];
    });
    const REPLAY = 1000;
    serve([{ leafIndex: 0, commitment: 11n, noteData: ("0x" + "11".repeat(169)) as Hex }, ins(REPLAY)], REPLAY + 4);
    pool.state.deposits = [{ vault: VAULT, ownerCommitment: oc, amount, leafIndex: REPLAY }];
    lc.proven = 4;
    await scanNotes({ masterSeed: seed, deployment: d() });
    const journaled = () => session.journal().swaps.find((s) => s.orderId === order.orderId)!;
    expect(journaled().refunds ?? [], "a find past the proven pool journals nothing").toEqual([]);
    expect(journaled().state).toBe("funded");
    // the real refund, inside the proven pool
    serve([{ leafIndex: 0, commitment: 11n, noteData: ("0x" + "11".repeat(169)) as Hex }, ins(1)], 4);
    pool.state.deposits = [{ vault: VAULT, ownerCommitment: oc, amount, leafIndex: 1 }];
    await scanNotes({ masterSeed: seed, deployment: d() });
    expect(journaled().refunds?.map((r) => r.leafIndex)).toEqual([1]);
    // the order is its runner's to close, once the escrow reads empty (the twelfth review round, C12-1): its tick is due now
    expect(journaled().state).toBe("funded");
    expect(session.journal().schedule.some((a) => a.id === `order-tick:${order.orderId}`)).toBe(true);
  });

  it("a note a scan found carries its time: a view a block behind keeps it for the grace a recorded note gets", async () => {
    const seed = session.state().seed!;
    const keys = deriveKeys(seed);
    const counter = 2;
    const secret = deriveNoteSecret(keys.noteKey, counter);
    const amount = 10n ** 17n;
    const own: Note = { vaultId: BigInt(VAULT), amount, ownerCommitment: depositOwnerCommitment(keys, secret), noteSecret: secret };
    const { encryptNoteData, viewKeyPair } = await import("@privacy-wallet/protocol/envelope");
    const env = encryptNoteData(viewKeyPair(keys.viewKey).publicKey, { amount, noteSecret: secret, vaultId: own.vaultId });
    const payload = ("0x" + Array.from(env, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
    lc.proven = 8;
    serve([{ leafIndex: 4, commitment: noteCommitment(noteBody(own), 4n), noteData: payload }], 8);
    await scanNotes({ masterSeed: seed, deployment: d() });
    const found = noteStore.all().find((n) => n.leafIndex === 4);
    expect(found?.addedAt, "the scan's own find has its time").toBeTypeOf("number");
    // the next view is a block behind: the leaf is past its pool, but within the grace the note stays
    lc.proven = 4;
    serve([], 4);
    await scanNotes({ masterSeed: seed, deployment: d() }).catch(() => undefined);
    expect(noteStore.all().some((n) => n.leafIndex === 4)).toBe(true);
  });
});
