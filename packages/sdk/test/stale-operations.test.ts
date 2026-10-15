// Operations whose own flow is gone (a V6 follow-up of 2026-10-14): a reload or a closed tab during a Protect, a Send or a
// withdrawal had left its record open for good — Home's "in flight" card, Activity's pending row. The chain moves it
// now: the receipt completes it or fails it, a transaction the node forgot fails it after STALE_DROP_MS, a flow that
// stopped before "submitting" fails with nothing moved; a submission without its answer, a record this page still
// drives and a swap are left alone.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { applyEvent, getOperation, newOperation, resetOperationsMemory } from "../src/operations/store";
import { reconcileStaleOperations, STALE_DROP_MS, type StaleReads } from "../src/operations/stale";
import { noteStore } from "../src/wallet/notes";
import type { OperationKind } from "../src/wallet/operationRecord";

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterEach(() => {
  session.update((j) => {
    j.operations = [];
  });
  resetOperationsMemory();
  noteStore.clear();
});

const T0 = 1_800_000_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** A record taken as far as its flow got before the page went away. */
function record(
  kind: OperationKind,
  upTo: "proof" | "submitting" | "confirming",
  n: number,
  at = T0,
  kept: { noteCounter?: number; nullifiers?: [string, string]; relayerUrl?: string } = {},
): string {
  const r = newOperation(
    {
      kind,
      amounts: { asset: "USDC", decimals: 6, input: "1000" },
      destination: { kind: "privacy-address", display: "pp1…", chain: "ethereum" },
      tier: "standard",
    },
    at,
  );
  applyEvent(r.id, { type: "review" }, session, at);
  applyEvent(r.id, { type: "confirm" }, session, at);
  applyEvent(r.id, { type: "progress", step: "proof" }, session, at);
  if (upTo !== "proof") applyEvent(r.id, { type: "progress", step: "submitting", ...kept }, session, at);
  if (upTo === "confirming") {
    applyEvent(r.id, { type: "submitted", by: "relayer", txHash: hash(n) }, session, at);
    applyEvent(r.id, { type: "confirming", txHash: hash(n) }, session, at);
  }
  return r.id;
}

function chain(
  o: { mined?: number[]; reverted?: number[]; known?: number[]; down?: boolean; spent?: string[]; jobs?: Record<string, number> } = {},
): StaleReads {
  const has = (list: number[] | undefined, h: Hex) => (list ?? []).some((n) => hash(n) === h);
  return {
    receipt: async (h) => {
      if (o.down) throw new Error("fetch failed");
      return has(o.mined, h) ? "success" : has(o.reverted, h) ? "reverted" : null;
    },
    txKnown: async (h) => {
      if (o.down) throw new Error("fetch failed");
      return has(o.known, h) || has(o.mined, h) || has(o.reverted, h);
    },
    spent: async (n) => {
      if (o.down) throw new Error("fetch failed");
      return (o.spent ?? []).includes(n.toString());
    },
    relayerJob: async (_url, nullifiers) => {
      if (o.down) throw new Error("relayer: no answer within 20 s");
      const n = o.jobs?.[nullifiers[0].toString()];
      return n === undefined ? null : { txHash: hash(n) };
    },
  };
}

describe("operations whose flow is gone", () => {
  it("a submitted one: its receipt completes it or fails it; a forgotten transaction fails it once the node has not known it long enough", async () => {
    const mined = record("send", "confirming", 1);
    const reverted = record("send", "confirming", 2);
    const pending = record("protect", "confirming", 3);
    const forgotten = record("withdraw", "confirming", 4);
    resetOperationsMemory(); // the page reloaded
    const reads = chain({ mined: [1], reverted: [2], known: [3] });
    expect(await reconcileStaleOperations(reads, T0 + 60_000)).toBe(2);
    expect(getOperation(mined)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(1)] } });
    expect(getOperation(reverted)).toMatchObject({ state: "FAILED", reason: { code: "receipt_reverted", fundsClass: "not-moved" } });
    expect(getOperation(pending)!.state, "the node still knows it: waited for").toBe("CONFIRMING");
    expect(getOperation(forgotten)!.state, "forgotten for less than the limit: waited for").toBe("CONFIRMING");
    expect(await reconcileStaleOperations(reads, T0 + STALE_DROP_MS + 1)).toBe(1);
    expect(getOperation(forgotten)).toMatchObject({ state: "FAILED", reason: { code: "transaction_dropped", fundsClass: "not-moved" } });
    expect(getOperation(pending)!.state).toBe("CONFIRMING");
    expect(STALE_DROP_MS).toBe(600_000);
  });

  it("one stopped before it was submitted fails with nothing moved; one submitting without its answer is left alone", async () => {
    const proof = record("send", "proof", 5);
    const submitting = record("send", "submitting", 6);
    resetOperationsMemory();
    expect(await reconcileStaleOperations(chain(), T0 + 1_000)).toBe(1);
    expect(getOperation(proof)).toMatchObject({ state: "FAILED", reason: { code: "interrupted", fundsClass: "not-moved" } });
    expect(getOperation(submitting)!.state).toBe("AWAITING_SIGNATURE");
  });

  it("a Protect waiting for the wallet when its page went away: its note, once the scan found it, completes it; none past the limit, nothing moved", async () => {
    const landed = record("protect", "submitting", 10, T0, { noteCounter: 42 });
    const unanswered = record("protect", "submitting", 11, T0, { noteCounter: 43 });
    resetOperationsMemory();
    noteStore.add({
      note: { vaultId: 1n, amount: 990n, ownerCommitment: 2n, noteSecret: 3n },
      leafIndex: 7,
      noteData: "0x",
      counter: 42,
      spent: false,
      txHash: hash(42),
    });
    expect(await reconcileStaleOperations(chain(), T0 + 60_000)).toBe(1);
    expect(getOperation(landed)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: 7, txHashes: [hash(42)] } });
    expect(getOperation(unanswered)!.state, "the wallet may still be asking: waited for").toBe("AWAITING_SIGNATURE");
    expect(await reconcileStaleOperations(chain(), T0 + STALE_DROP_MS + 1)).toBe(1);
    expect(getOperation(unanswered)).toMatchObject({ state: "FAILED", reason: { code: "interrupted", fundsClass: "not-moved" } });
  });

  it("a Send whose answer its page never got: the relayer, asked by its nullifiers, names the transaction; unspent and unknown past the limit, nothing moved; spent, left", async () => {
    const relayer = "http://relayer.test";
    const answered = record("send", "submitting", 20, T0, { nullifiers: ["201", "202"], relayerUrl: relayer });
    const lost = record("send", "submitting", 21, T0, { nullifiers: ["211", "212"], relayerUrl: relayer });
    const spentElsewhere = record("withdraw", "submitting", 22, T0, { nullifiers: ["221", "222"], relayerUrl: relayer });
    resetOperationsMemory();
    const reads = chain({ jobs: { "201": 20 }, mined: [20], spent: ["221"] });
    expect(await reconcileStaleOperations(reads, T0 + 60_000)).toBe(1);
    expect(getOperation(answered)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(20)] } });
    expect(getOperation(lost)!.state).toBe("AWAITING_SIGNATURE");
    expect(await reconcileStaleOperations(reads, T0 + STALE_DROP_MS + 1)).toBe(1);
    expect(getOperation(lost)).toMatchObject({ state: "FAILED", reason: { code: "interrupted", fundsClass: "not-moved" } });
    expect(getOperation(spentElsewhere)!.state, "sent, its transaction unknown here: never called interrupted").toBe("AWAITING_SIGNATURE");
    // sent through the connected wallet (no relayer to ask): its change note, once the scan found it, completes it
    const own = record("send", "submitting", 23, T0, { nullifiers: ["231", "232"], noteCounter: 77 });
    resetOperationsMemory();
    noteStore.add({
      note: { vaultId: 1n, amount: 5n, ownerCommitment: 2n, noteSecret: 3n },
      leafIndex: 9,
      noteData: "0x",
      counter: 77,
      spent: false,
      txHash: hash(23),
    });
    await reconcileStaleOperations(chain({ spent: ["231"] }), T0 + 60_000);
    expect(getOperation(own)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: 9, txHashes: [hash(23)] } });
  });

  it("a record this page still drives, a swap, an unread chain: nothing moves", async () => {
    const live = record("send", "proof", 7);
    expect(await reconcileStaleOperations(chain(), T0 + 1_000), "driven by a flow of this page").toBe(0);
    expect(getOperation(live)!.state).toBe("AWAITING_SIGNATURE");
    const swap = record("swap", "proof", 8);
    resetOperationsMemory();
    expect(await reconcileStaleOperations(chain({ down: true }), T0 + STALE_DROP_MS + 1)).toBe(1); // the never-sent send needs no read
    expect(getOperation(swap)!.state, "a swap's runner moves it").toBe("AWAITING_SIGNATURE");
    const sent = record("send", "confirming", 9);
    resetOperationsMemory();
    expect(await reconcileStaleOperations(chain({ down: true }), T0 + STALE_DROP_MS + 1), "unread: tried again at the next scan").toBe(0);
    expect(getOperation(sent)!.state).toBe("CONFIRMING");
  });
});
