// The bounds of the scan's exemption for a deposit its wallet did not report (the eleventh review round's second critique of F11-10). The
// exemption records such a note from the endpoints' agreed view before the light client's proof covers it — the case the receipt's
// fallback to the endpoints had covered, never wider: a closed record's note, and a note the store already holds, wait for the proof; one
// note at two leaves keeps its proven copy alone, whichever scan saw which; the minute rescans end with the window and never start for
// another recovery; a failed read neither leaves the deposit's scan to the scheduler's backoff nor plans it hours away.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { useCoreModule } from "../src/core";
import { prepareShield, type PreparedShield } from "../src/privateTx";
import type { Deployment } from "../src/chain";
import { DEPOSIT_SCAN_DELAY_MS, DISCOVERY_ID, DISCOVERY_INTERVAL_MS, DISCOVERY_MIN_GAP_MS, runDiscovery, scanForDeposit } from "../src/wallet/discovery";
import { DEPOSIT_RESCAN_WINDOW_MS } from "../src/operations/stale";
import { noteStore } from "../src/wallet/notes";
import { completeAction, scheduleAction } from "../src/wallet/schedule";
import { applyEvent, getOperation, newOperation, resetOperationsMemory } from "../src/operations/store";
import { startPool } from "./helpers/mockPool";

// mainnet's light client: the pool proven at the latest finalized block holds `proven` leaves; `down`: its read fails
const lc = vi.hoisted(() => ({ proven: 0, down: false }));
vi.mock("../src/verifiedReads", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyTree: async () => {
    if (lc.down) throw new Error("the beacon API did not answer");
    return { kind: "verified", proof: { blockNumber: 100n, slot: 1, nextLeafIndex: lc.proven, root: 0n }, leaves: lc.proven };
  },
  provenSpent: async (_d: unknown, nfs: bigint[]) => (nfs.length ? { blockNumber: 100n, blocks: nfs.map(() => 100n), spent: nfs.map(() => false) } : null),
}));
vi.mock("@privacy-wallet/wallet-engine/injected", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/wallet-engine/injected")>()),
  activeProvider: () => null,
  connectedProvider: () => null,
}));

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const ACCOUNT = "0x00000000000000000000000000000000000000b0";
const rootOf = (leaves: Map<number, bigint>, next: number) => {
  const t = new MerkleTree(TX_LEVELS);
  for (let g = 0; g < next; g += 4) t.insertGroup([0, 1, 2, 3].map((k) => leaves.get(g + k) ?? ZERO_LEAF));
  return t.root;
};
let pool: Awaited<ReturnType<typeof startPool>>;
const d = (): Deployment => ({ chainId: 1, core: CORE, ethVault: VAULT, rpcUrl: pool.url, rpcUrls: [pool.url], fromBlock: 0n, erc20Vaults: [] });
const scan = () =>
  runDiscovery({ id: DISCOVERY_ID, kind: "discovery", orderId: "pool", dueAt: Date.now() } as never, {
    masterSeed: session.state().seed!,
    deployment: d(),
    session,
  });
/** the pool shows these notes, at these leaves, `next` leaves in all */
function show(notes: [number, PreparedShield, Hex][], next: number) {
  const at = (p: PreparedShield, leaf: number) => noteCommitment(noteBody(p.note), BigInt(leaf));
  pool.state.inserts = notes.map(([leaf, p, txHash]) => ({ leafIndex: leaf, commitment: at(p, leaf), noteData: p.noteData, txHash }));
  pool.state.next = next;
  pool.state.root = rootOf(new Map(notes.map(([leaf, p]) => [leaf, at(p, leaf)])), next);
}
/** a Protect sent as `hash` for `p`'s note, its record as `code` left it (`at`: when it was made and last moved) */
function protectRecord(p: PreparedShield, hash: Hex, code: "deposit_unconfirmed" | "locked_after_send" | "receipt_reverted" | "page-gone", at = Date.now()) {
  const r = newOperation(
    {
      kind: "protect",
      amounts: { asset: "ETH", decimals: 18, input: "1" },
      destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
      tier: "standard",
    } as never,
    at,
  );
  applyEvent(r.id, { type: "review" }, session, at);
  applyEvent(r.id, { type: "confirm" }, session, at);
  applyEvent(r.id, { type: "progress", step: "submitting", noteCounter: p.counter, sender: ACCOUNT } as never, session, at);
  applyEvent(r.id, { type: "submitted", by: "wallet", txHash: hash } as never, session, at);
  if (code === "page-gone")
    resetOperationsMemory(); // sent and confirming; its page went away before the receipt
  else
    applyEvent(
      r.id,
      // the live flow's deposit_unconfirmed carries its page's marker (the twelfth review round, VA-N1): its note is awaited, a page-gone one's never
      code === "receipt_reverted"
        ? { type: "submission-failed", code, detail: "reverted" }
        : { type: "recovery-required", code, detail: "no receipt", ...(code === "deposit_unconfirmed" ? { noteAwaited: true as const } : {}) },
      session,
      at,
    );
  return r.id;
}
const nextScan = () => session.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done)!;
const leavesOf = (p: PreparedShield) =>
  noteStore
    .all()
    .filter((n) => n.counter === p.counter)
    .map((n) => n.leafIndex);

beforeAll(async () => {
  configure(defaultConfig({ kdfLog2N: 12, storage: () => memoryStorage() }));
  await session.create("a strong password");
  session.acknowledgePhrase();
  useCoreModule(null);
  pool = await startPool({ core: CORE, inserts: [], next: 0, root: rootOf(new Map(), 0) });
});
afterAll(async () => {
  await pool.close();
});
beforeEach(() => {
  lc.down = false;
});

describe("the exemption covers a deposit its wallet did not report, and nothing else", () => {
  it("a Protect whose page went away after its send waits for its note's proof, as before — the exemption is the unreported deposit's alone", async () => {
    const p = prepareShield({ masterSeed: session.state().seed!, deployment: d(), amount: 10n ** 17n });
    const id = protectRecord(p, ("0x" + "a3".repeat(32)) as Hex, "page-gone");
    expect(getOperation(id)?.state).toBe("SOURCE_CONFIRMING");
    show([[0, p, ("0x" + "a3".repeat(32)) as Hex]], 4);
    lc.proven = 0;
    await scan();
    expect(leavesOf(p), "held for the proof").toEqual([]);
    lc.proven = 4;
    await scan();
    expect(leavesOf(p), "recorded once proven").toEqual([0]);
    expect(getOperation(id)?.state, "and its record completes from it").toBe("COMPLETED");
  });

  it("a closed Protect's note shown in the tail waits for its proof — a reverted deposit's public opening is no deposit", async () => {
    const p = prepareShield({ masterSeed: session.state().seed!, deployment: d(), amount: 10n ** 17n });
    protectRecord(p, ("0x" + "a1".repeat(32)) as Hex, "receipt_reverted");
    show([[0, p, ("0x" + "a2".repeat(32)) as Hex]], 4);
    lc.proven = 0;
    await scan();
    expect(leavesOf(p), "held for the proof").toEqual([]);
  });

  it("the record's note already in the store, its opening replayed at another tail leaf alone: the replay waits, the store keeps one", async () => {
    const p = prepareShield({ masterSeed: session.state().seed!, deployment: d(), amount: 10n ** 17n });
    const H = ("0x" + "b1".repeat(32)) as Hex;
    protectRecord(p, H, "deposit_unconfirmed");
    noteStore.add({
      note: p.note,
      leafIndex: 0,
      noteData: p.noteData,
      counter: p.counter,
      spent: false,
      txHash: H,
      label: "protected",
      addedAt: Date.now(),
    } as never);
    show([[4, p, ("0x" + "b2".repeat(32)) as Hex]], 8); // the quorum hides leaf 0, shows the opening at 4
    lc.proven = 0;
    await scan();
    expect(leavesOf(p), "the deposit once").toEqual([0]);
  });

  it("one note at two leaves across scans: recorded from the tail where the quorum showed it, then proven where it is — the proven copy alone stays", async () => {
    const p = prepareShield({ masterSeed: session.state().seed!, deployment: d(), amount: 10n ** 17n });
    const H = ("0x" + "c1".repeat(32)) as Hex;
    const id = protectRecord(p, H, "deposit_unconfirmed");
    // scan 1: the quorum shows the deposit's public opening at tail leaf 10 alone (the proof at 8)
    show([[10, p, H]], 12);
    lc.proven = 8;
    await scan();
    expect(leavesOf(p), "recorded from the tail: the record awaited it").toEqual([10]);
    expect(getOperation(id)?.state).toBe("COMPLETED");
    // scan 2: the proof covers leaf 9, where the deposit really is; the tail still shows 10
    show(
      [
        [9, p, H],
        [10, p, ("0x" + "c2".repeat(32)) as Hex],
      ],
      12,
    );
    lc.proven = 10;
    await scan();
    expect(leavesOf(p), "one deposit, one note: its proven copy").toEqual([9]);
  });
});

describe("the minute rescans", () => {
  it("end with the window, and never start for another recovery", async () => {
    const p = prepareShield({ masterSeed: session.state().seed!, deployment: d(), amount: 10n ** 17n });
    show([], 12);
    lc.proven = 12;
    const old = protectRecord(p, ("0x" + "d1".repeat(32)) as Hex, "deposit_unconfirmed", Date.now() - DEPOSIT_RESCAN_WINDOW_MS - 5 * 60_000);
    let before = Date.now();
    await scan();
    expect(nextScan().dueAt - before, "past the window: the interval").toBeGreaterThanOrEqual(DISCOVERY_INTERVAL_MS - 1_000);
    expect(getOperation(old)?.state).toBe("RECOVERY_REQUIRED");
    const q = prepareShield({ masterSeed: session.state().seed!, deployment: d(), amount: 10n ** 17n });
    protectRecord(q, ("0x" + "d2".repeat(32)) as Hex, "locked_after_send");
    before = Date.now();
    await scan();
    expect(nextScan().dueAt - before, "another recovery: the interval").toBeGreaterThanOrEqual(DISCOVERY_INTERVAL_MS - 1_000);
  });

  it("a failed read while a young deposit waits: read again in a minute, never the scheduler's backoff", async () => {
    const p = prepareShield({ masterSeed: session.state().seed!, deployment: d(), amount: 10n ** 17n });
    protectRecord(p, ("0x" + "e1".repeat(32)) as Hex, "deposit_unconfirmed");
    lc.down = true;
    const before = Date.now();
    await expect(scan(), "no throw: no backoff").resolves.toBeUndefined();
    expect(nextScan().dueAt - before).toBeLessThanOrEqual(DISCOVERY_MIN_GAP_MS + 1_000);
  });
});

describe("the deposit's scan", () => {
  it("is planned past the scheduler's backoff: due half a minute on, the backoff dropped", () => {
    scheduleAction({ kind: "discovery", orderId: "pool", dueAt: Date.now() - 60_000 }, session);
    completeAction(DISCOVERY_ID, "the endpoints disagree", session, Date.now()); // in the backoff now
    const held = nextScan();
    expect(held.nextAttemptAt, "backed off").toBeGreaterThan(Date.now() + DEPOSIT_SCAN_DELAY_MS);
    const now = Date.now();
    expect(scanForDeposit(now, session)).toBe(true);
    const planned = nextScan();
    expect(planned.nextAttemptAt, "the backoff dropped").toBeUndefined();
    expect(planned.dueAt, "due at once or half a minute on, never later").toBeLessThanOrEqual(now + DEPOSIT_SCAN_DELAY_MS);
  });
});
