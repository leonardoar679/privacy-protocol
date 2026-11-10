// The ninth review round (2026-11-04): the operation records settle when they can — a transaction the wallet replaced (C-02), a Send
// whose relayer is gone for a day (C-06) —, a relayer's job is adopted only for the record's own call (C-10), a Send whose outcome is
// unknown still holds the next back (C-11), a finished swap names a partial fill or a refund paid at the destination (C-03, C-07), and a
// record written while locked never outlives the lock (C-08). The reviewers' probes (scratchpad review9/C f1, f3, f4, f7, f8, f10).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { applyEvent, getOperation, MAY_STILL_LAND_MS, newOperation, putOperation, resetOperationsMemory, unresolvedOf } from "../src/operations/store";
import { upgradeRecord } from "../src/operations/upgrade";
import { reconcileStaleOperations, RELAYER_GONE_MS, STALE_DROP_MS, type StaleReads } from "../src/operations/stale";
import { swapRecordId, syncSwapRecord } from "../src/operations/swapRecords";
import { notificationFor } from "../src/operations/notify";
import { noteStore } from "../src/wallet/notes";
import { forgetSpendIndexes, indexSpends, rememberSpendIndex } from "../src/wallet/spends";
import type { OperationKind, OperationRecord } from "../src/wallet/operationRecord";
import type { StoredSwap } from "../src/wallet/journal";
import type { Tracked } from "../src/orderTracker";
import type { SwapJob } from "../src/relayer";

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterEach(() => {
  session.update((j) => {
    j.operations = [];
    j.swaps = [];
  });
  resetOperationsMemory();
  noteStore.clear();
  forgetSpendIndexes();
});

const T0 = 1_800_000_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const DIGEST = ("0x" + "d1".repeat(32)) as Hex;
const RELAYER = "http://relayer.test";

function record(
  kind: OperationKind,
  upTo: "submitting" | "confirming",
  n: number,
  at = T0,
  kept: { noteCounter?: number; nullifiers?: [string, string]; relayerUrl?: string; inputsDigest?: string } = {},
): string {
  const r = newOperation(
    {
      kind,
      amounts: { asset: "ETH", decimals: 18, input: "1000" },
      destination: { kind: "privacy-address", display: "pp1…", chain: "ethereum" },
      tier: "standard",
    },
    at,
  );
  applyEvent(r.id, { type: "review" }, session, at);
  applyEvent(r.id, { type: "confirm" }, session, at);
  applyEvent(r.id, { type: "progress", step: "proof" }, session, at);
  applyEvent(r.id, { type: "progress", step: "submitting", ...kept }, session, at);
  if (upTo === "confirming") {
    applyEvent(r.id, { type: "submitted", by: kept.relayerUrl ? "relayer" : "wallet", txHash: hash(n) }, session, at);
    applyEvent(r.id, { type: "confirming", txHash: hash(n) }, session, at);
  }
  resetOperationsMemory();
  return r.id;
}

/** A scripted chain: mined hashes, the known ones, the spent nullifiers, the relayer's jobs, the index's pairs, each call's inputs. */
function chain(
  o: {
    mined?: number[];
    known?: number[];
    spent?: string[];
    jobs?: Record<string, number>;
    relayerDown?: boolean;
    index?: Record<string, number>;
    inputs?: Record<number, string>;
    spends?: Record<number, [string, string]>;
  } = {},
): StaleReads {
  const has = (list: number[] | undefined, h: Hex) => (list ?? []).some((n) => hash(n) === h);
  return {
    receipt: async (h) => (has(o.mined, h) ? "success" : null),
    txKnown: async (h) => has(o.known, h) || has(o.mined, h),
    spent: async (n) => (o.spent ?? []).includes(n.toString()),
    relayerJob: async (_url, nullifiers) => {
      if (o.relayerDown) throw new Error("relayer: no answer within 20 s");
      const n = o.jobs?.[nullifiers[0].toString()];
      return n === undefined ? null : { txHash: hash(n) };
    },
    txSpends: async (h) => {
      if (!(has(o.known, h) || has(o.mined, h))) return null;
      const pair = o.spends?.[Number(BigInt(h))];
      return pair ? [[BigInt(pair[0]), BigInt(pair[1])]] : [];
    },
    spendOf: async ([a, b]) => {
      const n = o.index?.[`${a},${b}`];
      return n === undefined ? null : { txHash: hash(n) };
    },
    txInputs: async (h) => (o.inputs?.[Number(BigInt(h))] as Hex | undefined) ?? null,
  };
}

describe("C-02: a transaction the wallet replaced (a speed-up)", () => {
  it("a Protect completes from its note the scan found; a Send from the pool's spend of its pair with its own inputs — or fails as spent elsewhere", async () => {
    const protect = record("protect", "confirming", 1, T0, { noteCounter: 41 });
    noteStore.add({
      note: { vaultId: 1n, amount: 5n, ownerCommitment: 2n, noteSecret: 3n },
      leafIndex: 12,
      noteData: "0x",
      counter: 41,
      spent: false,
      txHash: hash(2),
    });
    const send = record("send", "confirming", 3, T0, { nullifiers: ["31", "32"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    const other = record("send", "confirming", 5, T0, { nullifiers: ["51", "52"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    // hashes 1, 3 and 5 are unknown everywhere; the replacements 2, 4 (this Send's call) and 6 (another operation's) are mined
    const reads = chain({
      mined: [2, 4, 6],
      index: { "31,32": 4, "51,52": 6 },
      inputs: { 4: DIGEST, 6: "0x" + "ee".repeat(32) },
      spends: { 4: ["31", "32"], 6: ["51", "52"] },
      spent: ["31", "32", "51", "52"],
    });
    await reconcileStaleOperations(reads, T0 + 2 * 3600_000);
    expect(getOperation(protect)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: 12 } });
    expect(getOperation(send)!.state).toBe("COMPLETED");
    expect(getOperation(send)!.refs.txHashes).toContain(hash(4));
    expect(getOperation(other)).toMatchObject({ state: "FAILED", reason: { code: "spent_elsewhere", fundsClass: "not-moved" } });
  });

  it("nothing says yet (no note, no spend in the index): left as it is", async () => {
    const protect = record("protect", "confirming", 7, T0, { noteCounter: 42 });
    expect(await reconcileStaleOperations(chain(), T0 + 60_000)).toBe(0);
    expect(getOperation(protect)!.state).toBe("SOURCE_CONFIRMING");
  });
});

describe("C-06: a relayer that cannot be reached", () => {
  it("keeps a Send at SUBMITTING for the day only; then the chain alone decides — its notes unspent, nothing moved", async () => {
    const id = record("send", "submitting", 9, T0, { nullifiers: ["91", "92"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    const reads = chain({ relayerDown: true });
    await reconcileStaleOperations(reads, T0 + STALE_DROP_MS + 1);
    expect(getOperation(id)!.state, "an hour: the relayer is asked again").toBe("SUBMITTING");
    expect(unresolvedOf([getOperation(id)!], "send"), "and it holds the next Send back").not.toBeNull();
    await reconcileStaleOperations(reads, T0 + RELAYER_GONE_MS + 1);
    expect(getOperation(id)).toMatchObject({ state: "FAILED", reason: { code: "interrupted", fundsClass: "not-moved" } });
    expect(unresolvedOf([getOperation(id)!], "send")).toBeNull();
  });
  it("its notes spent, it is sent as far as the chain can tell: never 'nothing moved'", async () => {
    const id = record("send", "submitting", 10, T0, { nullifiers: ["101", "102"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    await reconcileStaleOperations(chain({ relayerDown: true, spent: ["101"] }), T0 + RELAYER_GONE_MS + 1);
    expect(getOperation(id)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "outcome_unknown", fundsClass: "unknown" } });
  });
});

describe("C-10: the relayer's job is adopted only for the record's own call", () => {
  it("a record kept without its call's digest waits as outcome unknown (gap 86); with it, its own call completes it", async () => {
    const legacy = record("send", "submitting", 11, T0, { nullifiers: ["111", "112"], relayerUrl: RELAYER });
    const kept = record("send", "submitting", 13, T0, { nullifiers: ["131", "132"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    const reads = chain({
      jobs: { "111": 12, "131": 14 },
      mined: [12, 14],
      spends: { 12: ["111", "112"], 14: ["131", "132"] },
      inputs: { 12: "0x" + "ab".repeat(32), 14: DIGEST },
      spent: ["111", "112", "131", "132"],
    });
    await reconcileStaleOperations(reads, T0 + 60_000);
    expect(getOperation(legacy)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "outcome_unknown", fundsClass: "unknown" } });
    expect(getOperation(legacy)!.refs.txHashes).toEqual([]);
    expect(getOperation(kept)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(14)] } });
  });
});

describe("C-11: a Send whose outcome is unknown", () => {
  it("holds the next back while its notes are not seen spent in the pool; seen spent, it can no longer land twice", () => {
    const id = record("send", "submitting", 15, T0, { nullifiers: ["151", "152"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    applyEvent(id, { type: "recovery-required", code: "relayer_unreachable", detail: "the answer was lost" }, session, T0 + 1000);
    const rec = getOperation(id)!;
    expect(rec).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { fundsClass: "unknown" } });
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0 + 2000); // the hold's own clock (the critique of 12d1b): within its day
    try {
      expect(unresolvedOf([rec], "send")?.id).toBe(id);
      rememberSpendIndex("0x" + "c0".repeat(20), indexSpends([{ nullifier0: 151n, nullifier1: 152n, transactionHash: hash(16), blockNumber: 5n }], 10n));
      expect(unresolvedOf([rec], "send")).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});

describe("A10-1 (the tenth review round): a Send that never settles holds the next back no longer", () => {
  it("a relayer that keeps naming a transaction no endpoint knows: past the drop limit, the notes unspent, nothing moved", async () => {
    const id = record("send", "submitting", 21, T0, { nullifiers: ["211", "212"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    const reads = chain({ jobs: { "211": 22 } }); // hash 22 is known nowhere
    await reconcileStaleOperations(reads, T0 + 60_000);
    expect(getOperation(id)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "outcome_unknown" } });
    await reconcileStaleOperations(reads, T0 + 60_000 + STALE_DROP_MS + 60_000);
    expect(getOperation(id)).toMatchObject({ state: "FAILED", reason: { code: "transaction_dropped", fundsClass: "not-moved" } });
    expect(unresolvedOf([getOperation(id)!], "send")).toBeNull();
  });

  it("a transaction that spends other notes: past the drop limit with the record's own notes unspent, its call never landed", async () => {
    const id = record("send", "confirming", 23, T0, { nullifiers: ["231", "232"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    const reads = chain({ mined: [23], spends: { 23: ["991", "992"] } });
    await reconcileStaleOperations(reads, T0 + 60_000);
    expect(getOperation(id)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "not_this_spend" } });
    await reconcileStaleOperations(reads, T0 + 60_000 + STALE_DROP_MS + 60_000);
    expect(getOperation(id)).toMatchObject({ state: "FAILED", reason: { code: "transaction_dropped" } });
  });

  it("an outcome still unknown a day after the Send was made holds nothing back", () => {
    const made = Date.now() - MAY_STILL_LAND_MS - 60_000;
    const id = record("send", "submitting", 25, made, { nullifiers: ["251", "252"], relayerUrl: RELAYER, inputsDigest: DIGEST });
    applyEvent(id, { type: "recovery-required", code: "relayer_unreachable", detail: "the answer was lost" }, session, made + 1000);
    const rec = getOperation(id)!;
    expect(rec.reason?.fundsClass).toBe("unknown");
    expect(unresolvedOf([rec], "send")).toBeNull();
  });
});

describe("C-08: a record written while locked", () => {
  it("is not kept past the lock; a draft beside a journaled record never replaces it", async () => {
    const id = record("send", "confirming", 17, T0, { nullifiers: ["171", "172"], relayerUrl: RELAYER });
    const journaled = getOperation(id)!;
    session.lock();
    putOperation({ ...journaled, state: "COMPLETED", history: [...journaled.history, { state: "COMPLETED", at: T0 + 5 }] });
    await session.unlock("a strong password");
    expect(getOperation(id)!.state, "the journal's record, not the write made while locked").toBe("SOURCE_CONFIRMING");
    expect(getOperation(id)!.history).toEqual(journaled.history);
  });
});

describe("C-03, C-07: a finished swap names what it came to", () => {
  const ORDER = "0x" + "c3".repeat(32);
  const stored = (extra: Partial<StoredSwap> = {}): StoredSwap =>
    ({
      orderId: ORDER,
      attemptId: "0x01",
      refundCounter: 1,
      provider: "lifi",
      policy: "balanced",
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" },
        amount: "1000",
        destination: "So1",
      },
      params: { amount: "1000", executeDeadline: 2_000_000_000, refundAfter: 2_000_086_400 },
      endpoint: "0x" + "e5".repeat(20),
      createdAt: T0,
      state: "executed",
      fundedTx: "0xf00d",
      jobId: "job-1",
      ...extra,
    }) as StoredSwap;
  const tracked = (state: Tracked["state"], extra: Partial<Tracked> = {}): Tracked =>
    ({ state, label: "Partial", steps: [true, true, true, true], detail: "", ...extra }) as Tracked;
  const job = (state: string) => ({ id: "job-1", escrow: "0x", state, updatedAt: T0 }) as unknown as SwapJob;

  it("a partial fill waits while its rest may still come back; once the watch ended it is finished — delivered in part", () => {
    expect(syncSwapRecord(stored(), tracked("PARTIAL", { deliveredUnits: "600" }), job("executed"), T0)).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: { code: "partial_delivery" },
    });
    // the watch ended with nothing re-shielded (a completed job, no refund note): the rest did not come back — never "it came back" (the
    // tenth review round, A10-2; the ninth round's case had pinned "partial" here)
    const done = syncSwapRecord(stored(), tracked("PARTIAL"), job("completed"), T0 + 1000);
    expect(done).toMatchObject({ state: "COMPLETED", outcome: "partial-unreturned", amounts: { delivered: "600" } });
    // read again later without the amount: the record keeps it
    expect(syncSwapRecord(stored(), null, null, T0 + 2000)).toMatchObject({ state: "COMPLETED", outcome: "partial-unreturned", amounts: { delivered: "600" } });
  });

  it("delivered in part with the rest back — a refund note found, or a refunded job — or delivered in another token: each its own outcome (the tenth review round, A10-2)", () => {
    session.update((j) => {
      j.operations = [];
    });
    expect(
      syncSwapRecord(
        stored({ refunds: [{ leafIndex: 9, vault: "0x01", amount: "400" }] }),
        tracked("PARTIAL", { deliveredUnits: "600" }),
        job("completed"),
        T0,
      ),
    ).toMatchObject({
      state: "COMPLETED",
      outcome: "partial",
    });
    session.update((j) => {
      j.operations = [];
    });
    expect(syncSwapRecord(stored(), tracked("PARTIAL", { deliveredUnits: "600" }), job("refunded"), T0)).toMatchObject({
      state: "COMPLETED",
      outcome: "partial",
    });
    session.update((j) => {
      j.operations = [];
    });
    expect(syncSwapRecord(stored(), tracked("PARTIAL", { deliveredAsset: "USDC.e" }), job("completed"), T0)).toMatchObject({
      state: "COMPLETED",
      outcome: "other-token",
      outcomeAsset: "USDC.e",
    });
  });

  it("an outcome this build does not know is dropped as the journal is read (the tenth review round, A10-8)", () => {
    const rec = { v: 3, id: "x", kind: "swap", state: "COMPLETED", outcome: "lost-in-space", outcomeAsset: "X" } as unknown as OperationRecord;
    const read = upgradeRecord(rec);
    expect(read.outcome).toBeUndefined();
    expect(read.outcomeAsset).toBeUndefined();
    const known = { ...rec, outcome: "partial" } as unknown as OperationRecord;
    expect(upgradeRecord(known), "a known one is the same object").toBe(known);
  });

  it("a refund the provider paid at the destination is a finished record that says so — and its notification never 'complete', no expected amount", () => {
    const before = syncSwapRecord(stored(), tracked("DESTINATION_SUBMITTED"), job("executed"), T0);
    const after = syncSwapRecord(stored(), tracked("REFUNDED_AT_DESTINATION"), job("completed"), T0 + 1000);
    expect(after).toMatchObject({ state: "COMPLETED", outcome: "refunded-at-destination" });
    expect(after.amounts.delivered).toBeUndefined();
    const n = notificationFor(before as OperationRecord, after, { enabled: true, amounts: true } as never);
    expect(n).toMatchObject({ kind: "completed", outcome: "refunded-at-destination" });
    expect(n!.amounts?.output, "nothing of the output arrived").toBeUndefined();
    expect(getOperation(swapRecordId(ORDER))!.outcome).toBe("refunded-at-destination");
  });
});
