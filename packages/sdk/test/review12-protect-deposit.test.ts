// The twelfth review round, 2026-11-06, area A — a Protect's deposit when its wallet's word is missing or misleading. A12-1: a deposit sped up in
// the wallet app (the same call under a new hash) had been failed "dropped — nothing moved, send it again" while its replacement landed, its note
// waiting in the unproven tail: the stale mover now looks in the latest scan's agreed view first, and a Protect the wallet no longer knows with no
// note anywhere reads its own words (deposit_dropped). A12-3: a deposit its wallet did not report keeps one clock — the moment its record read so
// — for its minute rescans, its hold and its "never landed". A12-4: its note is told by its counter AND its body, never another device's note at
// the same counter (gap 51). VA-N1: only the live flow's deposit is taken from the tail at once, never a page-gone record's.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { noteBody, noteCommitment, type Note } from "@privacy-wallet/protocol/note";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { useCoreModule } from "../src/core";
import { prepareShield, type PreparedShield } from "../src/privateTx";
import type { Deployment } from "../src/chain";
import { DISCOVERY_ID, runDiscovery } from "../src/wallet/discovery";
import { awaitedDeposits, depositAwaited, reconcileStaleOperations, RELAYER_GONE_MS, STALE_DROP_WALLET_MS, type StaleReads } from "../src/operations/stale";
import { noteStore } from "../src/wallet/notes";
import { applyEvent, getOperation, newOperation, resetOperationsMemory, unresolvedOf } from "../src/operations/store";
import { CATALOG } from "../src/operations/errors/catalog";
import { startPool } from "./helpers/mockPool";

const lc = vi.hoisted(() => ({ proven: 0 }));
vi.mock("../src/verifiedReads", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyTree: async () => ({ kind: "verified", proof: { blockNumber: 100n, slot: 1, nextLeafIndex: lc.proven, root: 0n }, leaves: lc.proven }),
  provenSpent: async (_d: unknown, nfs: bigint[]) => (nfs.length ? { blockNumber: 100n, blocks: nfs.map(() => 100n), spent: nfs.map(() => false) } : null),
}));
const w = vi.hoisted(() => ({ provider: null as null | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }));
vi.mock("@privacy-wallet/wallet-engine/injected", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/wallet-engine/injected")>()),
  activeProvider: () => w.provider,
  connectedProvider: () => w.provider,
}));

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const ACCOUNT = "0x00000000000000000000000000000000000000b0";
const h = (b: string) => ("0x" + b.repeat(32)) as Hex;
let pool: Awaited<ReturnType<typeof startPool>>;
const d = (): Deployment => ({ chainId: 1, core: CORE, ethVault: VAULT, rpcUrl: pool.url, rpcUrls: [pool.url], fromBlock: 0n, erc20Vaults: [] });
const scan = () =>
  runDiscovery({ id: DISCOVERY_ID, kind: "discovery", orderId: "pool", dueAt: Date.now() } as never, {
    masterSeed: session.state().seed!,
    deployment: d(),
    session,
  });
const noReads: StaleReads = {
  receipt: async () => null,
  txKnown: async () => false,
  spent: async () => false,
  relayerJob: async () => null,
  txSpends: async () => null,
  walletTx: async () => null,
};

/** the pool's notes; every other leaf empty */
const inserted: { leafIndex: number; commitment: bigint; noteData: Hex; txHash: Hex }[] = [];
function land(note: Note, noteData: Hex, leaf: number, txHash: Hex) {
  inserted.push({ leafIndex: leaf, commitment: noteCommitment(noteBody(note), BigInt(leaf)), noteData, txHash });
  const next = Math.max(...inserted.map((x) => x.leafIndex)) + 1;
  const groups = Math.ceil(next / 4) * 4;
  const t = new MerkleTree(TX_LEVELS);
  const at = new Map(inserted.map((x) => [x.leafIndex, x.commitment]));
  for (let g = 0; g < groups; g += 4) t.insertGroup([0, 1, 2, 3].map((k) => at.get(g + k) ?? ZERO_LEAF));
  pool.state.inserts = [...inserted];
  pool.state.next = groups;
  pool.state.root = t.root;
}
/** the connected wallet holding ACCOUNT on chain 1: `pending` the hashes its node holds unmined; none mined (no receipts) */
function wallet(pending: Hex[]) {
  w.provider = {
    request: async (a) => {
      if (a.method === "eth_accounts") return [ACCOUNT];
      if (a.method === "eth_chainId") return "0x1";
      if (a.method === "eth_getTransactionReceipt") return null;
      if (a.method === "eth_getTransactionByHash") return pending.includes(a.params?.[0] as Hex) ? { hash: a.params?.[0] } : null;
      throw new Error(`unexpected ${a.method}`);
    },
  };
}
/**
 * A Protect sent as its page drives it: the wallet's prompt names its note's counter and body (engineEvents' mapping, A12-4); `live`: the live
 * flow ended deposit_unconfirmed and marked it (ProtectScreen, VA-N1); `unconfirmedAt` when it did.
 */
function sentProtect(p: PreparedShield, H1: Hex, at: number, o: { live?: boolean; unconfirmedAt?: number } = {}) {
  const r = newOperation(
    {
      kind: "protect",
      amounts: { asset: "ETH", decimals: 18, input: (10n ** 17n).toString() },
      destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
      tier: "standard",
    } as never,
    at,
  );
  applyEvent(r.id, { type: "review" }, session, at);
  applyEvent(r.id, { type: "confirm" }, session, at);
  applyEvent(
    r.id,
    {
      type: "progress",
      step: "submitting",
      i: 1,
      n: 1,
      noteCounter: p.counter,
      sender: ACCOUNT,
      noteBody: { vault: p.vault, amount: p.note.amount.toString() },
    } as never,
    session,
    at,
  );
  applyEvent(r.id, { type: "submitted", by: "wallet", txHash: H1 } as never, session, at);
  applyEvent(r.id, { type: "confirming", txHash: H1 } as never, session, at);
  if (o.live)
    applyEvent(
      r.id,
      { type: "recovery-required", code: "deposit_unconfirmed", detail: "no receipt (timeout)", noteAwaited: true },
      session,
      o.unconfirmedAt ?? at,
    );
  resetOperationsMemory(); // the page that drove it is gone
  return r.id;
}
const mine = (p: PreparedShield) => noteStore.all().filter((n) => n.counter === p.counter);
const toHex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
/** another device of this wallet's deposit at the same counter (gap 51): the same secret and owner commitment, another amount, its own envelope */
const theirsOf = (p: PreparedShield, amount: bigint): { note: Note; noteData: Hex } => {
  const note: Note = { ...p.note, amount };
  const keys = deriveKeys(session.state().seed!);
  return { note, noteData: toHex(encryptNoteData(viewKeyPair(keys.viewKey).publicKey, { amount, noteSecret: note.noteSecret, vaultId: note.vaultId })) };
};
const shield = (amount = 10n ** 17n) => prepareShield({ masterSeed: session.state().seed!, deployment: d(), amount });

beforeAll(async () => {
  configure(defaultConfig({ kdfLog2N: 12, storage: () => memoryStorage() }));
  await session.create("a strong password");
  session.acknowledgePhrase();
  useCoreModule(null);
  pool = await startPool({ core: CORE, inserts: [], next: 0, root: new MerkleTree(TX_LEVELS).root });
});
afterAll(async () => {
  w.provider = null;
  await pool.close();
});
beforeEach(() => {
  w.provider = null;
  lc.proven = Math.max(0, pool.state.next);
});

describe("A12-1: a sped-up deposit is never dropped while its replacement's note is in the pool's view", () => {
  it("page gone, H1 stuck past the hour, then sped up: no verdict while H2's note waits for its proof — completed from it once proven", async () => {
    const p = shield();
    const [H1, H2] = [h("a1"), h("a2")];
    const id = sentProtect(p, H1, Date.now() - STALE_DROP_WALLET_MS - 5 * 60_000);
    wallet([H1]); // stuck: its node holds it pending
    await scan();
    expect(getOperation(id)?.state, "pending: waited for").toBe("SOURCE_CONFIRMING");
    wallet([]); // the speed-up: H1 gone from the node, H2 mined past the proven pool
    const tail = pool.state.next;
    land(p.note, p.noteData, tail, H2);
    lc.proven = tail;
    await scan();
    expect(mine(p), "H2's note waits for its proof").toEqual([]);
    expect(getOperation(id)?.state, "landed: no verdict, never 'dropped — send it again'").toBe("SOURCE_CONFIRMING");
    lc.proven = pool.state.next;
    await scan();
    expect(mine(p).map((n) => n.txHash)).toEqual([H2]);
    expect(getOperation(id)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: tail } });
  });

  it("a cancel — the nonce used by a 0-value self-send, no note anywhere — is dropped in a Protect's own words: nothing moved, never 'send it again'", async () => {
    const p = shield();
    const id = sentProtect(p, h("d1"), Date.now() - STALE_DROP_WALLET_MS - 5 * 60_000);
    wallet([]);
    await scan();
    expect(getOperation(id)).toMatchObject({ state: "FAILED", reason: { code: "deposit_dropped", fundsClass: "not-moved" } });
    expect(CATALOG.deposit_dropped).toEqual({ source: "wallet", fundsClass: "not-moved", actions: ["review"] });
  });

  it("the live flow's deposit_unconfirmed whose H2 is mined: its note taken from the tail at once, completed — as before", async () => {
    const p = shield();
    const [H1, H2] = [h("c1"), h("c2")];
    const id = sentProtect(p, H1, Date.now() - STALE_DROP_WALLET_MS - 5 * 60_000, { live: true });
    wallet([]);
    const tail = pool.state.next;
    land(p.note, p.noteData, tail, H2);
    lc.proven = tail;
    await scan();
    expect(getOperation(id)?.state).toBe("COMPLETED");
  });
});

describe("VA-N1: a page-gone record is never taken from the tail at once", () => {
  it("moved to deposit_unconfirmed by the stale mover (no wallet at its first pass): not awaited — its note waits for the proof, then completes it", async () => {
    const p = shield();
    const [H1, H2] = [h("b1"), h("b2")];
    const id = sentProtect(p, H1, Date.now() - STALE_DROP_WALLET_MS - 5 * 60_000);
    await scan(); // no connected wallet: deposit_unconfirmed, the stale mover's — no live flow's marker
    expect(getOperation(id)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "deposit_unconfirmed" } });
    expect(
      awaitedDeposits(session).map((a) => a.counter),
      "never awaited",
    ).not.toContain(p.counter);
    expect(depositAwaited(session), "no minute rescans for it").toBe(false);
    wallet([]);
    const tail = pool.state.next;
    land(p.note, p.noteData, tail, H2);
    lc.proven = tail;
    await scan();
    expect(mine(p), "not taken from the tail").toEqual([]);
    expect(getOperation(id)?.state, "in the pool's view: no verdict").toBe("RECOVERY_REQUIRED");
    lc.proven = pool.state.next;
    await scan();
    expect(getOperation(id)?.state).toBe("COMPLETED");
  });
});

describe("A12-1 with VA-N1: the view alone holds off a verdict for the stale mover's deposit_unconfirmed (ZG's critique)", () => {
  it("moved there two hours ago, then sped up — the wallet answering 'unknown' for H1: no 'dropped' while H2's note waits, completed once proven", async () => {
    const p = shield();
    const [H1, H2] = [h("g1"), h("g2")];
    const now = Date.now();
    const id = sentProtect(p, H1, now - 3.5 * 3600_000);
    await reconcileStaleOperations(noReads, now - 2 * 3600_000, session); // no wallet at that pass
    expect(getOperation(id)?.reason?.code).toBe("deposit_unconfirmed");
    wallet([]);
    const tail = pool.state.next;
    land(p.note, p.noteData, tail, H2);
    lc.proven = tail;
    await scan();
    expect(getOperation(id)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "deposit_unconfirmed" } });
    lc.proven = pool.state.next;
    await scan();
    expect(getOperation(id)?.state).toBe("COMPLETED");
  });

  it("moved there a day and an hour ago, no wallet: never 'never landed' while its note waits for its proof", async () => {
    const p = shield();
    const now = Date.now();
    const id = sentProtect(p, h("g3"), now - 26.5 * 3600_000);
    await reconcileStaleOperations(noReads, now - 25 * 3600_000, session);
    expect(getOperation(id)?.reason?.code).toBe("deposit_unconfirmed");
    const tail = pool.state.next;
    land(p.note, p.noteData, tail, h("g4"));
    lc.proven = tail;
    await scan();
    expect(getOperation(id)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "deposit_unconfirmed" } });
    lc.proven = pool.state.next;
    await scan();
    expect(getOperation(id)?.state).toBe("COMPLETED");
  });
});

describe("A12-4 on the paths its first tests did not take (ZG's critique)", () => {
  it("a Protect whose page went away at its deposit prompt — no hash —: never completed from another device's proven deposit at its counter", async () => {
    const p = shield();
    const at = Date.now() - 2 * 3600_000;
    const r = newOperation(
      {
        kind: "protect",
        amounts: { asset: "ETH", decimals: 18, input: (10n ** 17n).toString() },
        destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
        tier: "standard",
      } as never,
      at,
    );
    applyEvent(r.id, { type: "review" }, session, at);
    applyEvent(r.id, { type: "confirm" }, session, at);
    applyEvent(
      r.id,
      {
        type: "progress",
        step: "submitting",
        i: 1,
        n: 1,
        noteCounter: p.counter,
        sender: ACCOUNT,
        noteBody: { vault: p.vault, amount: p.note.amount.toString() },
      } as never,
      session,
      at,
    );
    resetOperationsMemory();
    const theirs = theirsOf(p, 5n * 10n ** 17n);
    const leaf = pool.state.next;
    land(theirs.note, theirs.noteData, leaf, h("g5"));
    lc.proven = pool.state.next;
    await scan();
    const rec = getOperation(r.id)!;
    expect(rec.state, "never 'Added' at the other device's leaf").not.toBe("COMPLETED");
    expect(rec.refs.leafIndex).toBeUndefined();
  });

  it("the live flow's record whose own note and another device's note at its counter are both in the tail: completed at its own leaf at once", async () => {
    const p = shield();
    const id = sentProtect(p, h("g6"), Date.now() - 60_000, { live: true });
    const theirs = theirsOf(p, 6n * 10n ** 17n);
    const tail = pool.state.next;
    land(theirs.note, theirs.noteData, tail, h("g7"));
    land(p.note, p.noteData, tail + 4, h("g8"));
    lc.proven = tail;
    await scan();
    expect(getOperation(id)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: tail + 4 } });
  });
});

describe("A12-4: another device's note already in the store", () => {
  it("the live flow's record whose counter holds another device's proven note: its own tail note still taken at once", async () => {
    const p = shield();
    const theirs = theirsOf(p, 7n * 10n ** 17n);
    land(theirs.note, theirs.noteData, pool.state.next, h("c7"));
    lc.proven = pool.state.next;
    await scan(); // the other device's deposit, proven: in the store at this counter
    expect(mine(p).map((n) => n.note.amount)).toContain(theirs.note.amount);
    const id = sentProtect(p, h("c8"), Date.now() - 60_000, { live: true });
    const tail = pool.state.next;
    land(p.note, p.noteData, tail, h("c9"));
    lc.proven = tail;
    await scan();
    expect(getOperation(id)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: tail } });
  });
});

describe("A12-3: a deposit its wallet did not report keeps one clock — the moment its record read so", () => {
  it("unconfirmed 16 minutes after its confirmation (a 5-minute prompt, then the receipt's 10): awaited, its minute rescans from then", () => {
    const p = shield();
    const now = Date.now();
    sentProtect(p, h("e1"), now - 16 * 60_000, { live: true, unconfirmedAt: now });
    expect(depositAwaited(session, now)).toBe(true);
    expect(depositAwaited(session, now + 16 * 60_000), "a quarter hour after it read so: settled").toBe(false);
  });

  it("a page gone after its send, moved to deposit_unconfirmed 20 hours on: held a day from then, and 'never landed' a day from then — never before", async () => {
    const p = shield();
    const now = Date.now();
    const T0 = now - 25 * 3600_000; // confirmed and sent 25 hours ago, the page gone at once
    const id = sentProtect(p, h("e2"), T0);
    await reconcileStaleOperations(noReads, T0 + 20 * 3600_000, session); // the first pass after the absence: not reported
    expect(getOperation(id)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "deposit_unconfirmed" } });
    expect(unresolvedOf([getOperation(id)!], "protect")?.id, "25 h after its send, 5 h after it read so: still held").toBe(id);
    await reconcileStaleOperations(noReads, now, session);
    expect(getOperation(id)?.reason?.code, "no verdict a day from its send").toBe("deposit_unconfirmed");
    // a monitoring read the next day moves the record's last move, never its clock
    applyEvent(id, { type: "monitor" }, session, T0 + 43 * 3600_000);
    await reconcileStaleOperations(noReads, T0 + 20 * 3600_000 + RELAYER_GONE_MS + 60_000, session);
    expect(getOperation(id)?.reason?.code, "a day from the moment it read so, whatever moved since").toBe("deposit_never_landed");
  });
});

describe("A12-4: a note is the record's by its counter and its body — another device's deposit at the same counter is not (gap 51)", () => {
  it("this device's Protect from its receipt at a tail leaf stays while another device's deposit of another amount at its counter stands proven", async () => {
    const p = shield();
    const theirs = theirsOf(p, 2n * 10n ** 17n);
    const H_MINE = h("f1");
    const base = pool.state.next;
    // device B's deposit at the same counter, proven; this device's at the tail, recorded from its wallet's receipt
    land(theirs.note, theirs.noteData, base, h("f2"));
    land(p.note, p.noteData, base + 4, H_MINE);
    noteStore.add({
      note: p.note,
      leafIndex: base + 4,
      noteData: p.noteData,
      counter: p.counter,
      spent: false,
      txHash: H_MINE,
      label: "shield",
      addedAt: Date.now(),
    } as never);
    lc.proven = base + 4;
    await scan();
    const amounts = mine(p).map((n) => n.note.amount);
    expect(amounts, "the other device's deposit, proven, is the wallet's too").toContain(2n * 10n ** 17n);
    expect(amounts, "this device's own deposit kept beside it — never dropped as a 'replay'").toContain(10n ** 17n);
  });

  it("a record awaiting its note never completes from another device's deposit at its counter", async () => {
    const p = shield();
    const id = sentProtect(p, h("f3"), Date.now() - 60_000, { live: true });
    const theirs = theirsOf(p, 3n * 10n ** 17n);
    const tail = pool.state.next;
    land(theirs.note, theirs.noteData, tail, h("f4"));
    lc.proven = tail;
    await scan();
    expect(getOperation(id)?.state, "another note's: never this record's").toBe("RECOVERY_REQUIRED");
    expect(
      mine(p).some((n) => n.note.amount === theirs.note.amount),
      "and never taken from the tail as this record's",
    ).toBe(false);
    lc.proven = pool.state.next;
    await scan();
    expect(
      mine(p).map((n) => n.note.amount),
      "proven, it is the wallet's",
    ).toContain(theirs.note.amount);
    expect(getOperation(id)?.state, "and still never this record's").toBe("RECOVERY_REQUIRED");
  });

  it("a cancel while another device's deposit at its counter is in the pool's view: still dropped — the view is read by counter and body", async () => {
    const p = shield();
    const id = sentProtect(p, h("f5"), Date.now() - STALE_DROP_WALLET_MS - 5 * 60_000);
    const theirs = theirsOf(p, 4n * 10n ** 17n);
    const tail = pool.state.next;
    land(theirs.note, theirs.noteData, tail, h("f6"));
    lc.proven = tail;
    wallet([]);
    await scan();
    expect(getOperation(id)).toMatchObject({ state: "FAILED", reason: { code: "deposit_dropped" } });
  });
});

// last: it closes the store, as a lock does
describe("A12-1: the scan's agreed view is the open session's alone", () => {
  it("recorded by the scan, read by counter, gone at a lock and never set while the store is closed", () => {
    noteStore.setScanView([{ counter: 900, vaultId: 1n, amount: 2n, leafIndex: 3 }]);
    expect(noteStore.scanView(900)).toEqual([{ counter: 900, vaultId: 1n, amount: 2n, leafIndex: 3 }]);
    expect(noteStore.scanView(901)).toEqual([]);
    noteStore.close();
    expect(noteStore.scanView(900), "forgotten at the lock").toEqual([]);
    noteStore.setScanView([{ counter: 900, vaultId: 1n, amount: 2n, leafIndex: 3 }]);
    expect(noteStore.scanView(900), "never set while closed").toEqual([]);
  });
});
