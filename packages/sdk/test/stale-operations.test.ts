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
import { reconcileStaleOperations, STALE_DROP_MS, STALE_DROP_WALLET_MS, type StaleReads } from "../src/operations/stale";
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
  kept: { noteCounter?: number; nullifiers?: [string, string]; relayerUrl?: string; inputsDigest?: string } = {},
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
  o: {
    mined?: number[];
    reverted?: number[];
    known?: number[];
    down?: boolean;
    spent?: string[];
    jobs?: Record<string, number>;
    /** the nullifiers each transaction's core call spends */
    spends?: Record<number, [string, string]>;
    /** the scan's spend index: "n0,n1" → the transaction that spent exactly that pair (the sixth review round) */
    index?: Record<string, number>;
    /** the digest of each transaction's call inputs (the sixth review round): absent, unreadable */
    inputs?: Record<number, string>;
  } = {},
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
    txSpends: async (h) => {
      if (o.down) throw new Error("fetch failed");
      if (!(has(o.known, h) || has(o.mined, h) || has(o.reverted, h))) return null;
      const n = Number(BigInt(h));
      const pair = o.spends?.[n];
      return pair ? [[BigInt(pair[0]), BigInt(pair[1])]] : [];
    },
    spendOf: async ([a, b]) => {
      if (o.down) throw new Error("fetch failed");
      const n = o.index?.[`${a},${b}`];
      return n === undefined ? null : { txHash: hash(n) };
    },
    txInputs: async (h) => {
      if (o.down) throw new Error("fetch failed");
      const d = o.inputs?.[Number(BigInt(h))];
      return d === undefined ? null : (d as Hex);
    },
  };
}

describe("operations whose flow is gone", () => {
  it("a submitted one: its receipt completes it or fails it; a forgotten transaction fails it once the node has not known it long enough", async () => {
    const mined = record("send", "confirming", 1);
    const reverted = record("send", "confirming", 2);
    const pending = record("protect", "confirming", 3);
    const forgotten = record("withdraw", "confirming", 4, T0, { relayerUrl: "http://relayer.test" });
    resetOperationsMemory(); // the page reloaded
    const reads = chain({ mined: [1], reverted: [2], known: [3] });
    expect(await reconcileStaleOperations(reads, T0 + 60_000)).toBe(2);
    expect(getOperation(mined)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(1)] } });
    expect(getOperation(reverted)).toMatchObject({ state: "FAILED", reason: { code: "receipt_reverted", fundsClass: "not-moved" } });
    expect(getOperation(pending)!.state, "the node still knows it: waited for").toBe("SOURCE_CONFIRMING");
    expect(getOperation(forgotten)!.state, "forgotten for less than the limit: waited for").toBe("SOURCE_CONFIRMING");
    expect(await reconcileStaleOperations(reads, T0 + STALE_DROP_MS + 1)).toBe(1);
    expect(getOperation(forgotten)).toMatchObject({ state: "FAILED", reason: { code: "transaction_dropped", fundsClass: "not-moved" } });
    expect(getOperation(pending)!.state).toBe("SOURCE_CONFIRMING");
    expect(STALE_DROP_MS, "an hour for a relayer-sent spend too (the sixth review round, 2026-11-03)").toBe(3_600_000);
  });

  it("'nothing moved' only while the notes are unspent: a reverted receipt or a forgotten transaction of a spend whose notes are spent is left as it is (audit round 2, r23)", async () => {
    const reverted = record("send", "confirming", 41, T0, { nullifiers: ["411", "412"], relayerUrl: "http://relayer.test" });
    const forgotten = record("withdraw", "confirming", 42, T0, { nullifiers: ["421", "422"], relayerUrl: "http://relayer.test" });
    resetOperationsMemory(); // the page reloaded
    // an endpoint's "reverted", a node that never saw the relayer's pending transaction: the notes are spent all the same
    expect(await reconcileStaleOperations(chain({ reverted: [41], spent: ["411", "421"], spends: { 41: ["411", "412"] } }), T0 + STALE_DROP_MS + 1)).toBe(0);
    expect(getOperation(reverted)!.state).toBe("SOURCE_CONFIRMING");
    expect(getOperation(forgotten)!.state).toBe("SOURCE_CONFIRMING");
    // unspent: nothing moved, as before
    expect(await reconcileStaleOperations(chain({ reverted: [41], spends: { 41: ["411", "412"] } }), T0 + STALE_DROP_MS + 1)).toBe(2);
    expect(getOperation(reverted)).toMatchObject({ state: "FAILED", reason: { code: "receipt_reverted" } });
    expect(getOperation(forgotten)).toMatchObject({ state: "FAILED", reason: { code: "transaction_dropped" } });
  });

  it("one stopped before it was submitted fails with nothing moved; one submitting without its answer is left alone", async () => {
    const proof = record("send", "proof", 5);
    const submitting = record("send", "submitting", 6);
    resetOperationsMemory();
    expect(await reconcileStaleOperations(chain(), T0 + 1_000)).toBe(1);
    expect(getOperation(proof)).toMatchObject({ state: "FAILED", reason: { code: "interrupted", fundsClass: "not-moved" } });
    expect(getOperation(submitting)!.state, "V7: the submission is a state of its own").toBe("SUBMITTING");
  });

  it("a Send its page moved to RECOVERY_REQUIRED after a lost answer is settled from what it kept, never called 'nothing moved' while it may have been sent (audit round 2, r41)", async () => {
    const relayer = "http://relayer.test";
    const sent = record("send", "submitting", 30, T0, { nullifiers: ["301", "302"], relayerUrl: relayer });
    // the retry was refused nullifier_in_flight and the relayer had not stored its job yet: an unknown outcome, the step dropped
    applyEvent(sent, { type: "recovery-required", code: "nullifier_in_flight" }, session, T0);
    expect(getOperation(sent)!.state).toBe("RECOVERY_REQUIRED");
    expect(getOperation(sent)!.progress).toBeUndefined();
    // still its page's: settled all the same — that flow is over
    expect(await reconcileStaleOperations(chain({ jobs: { "301": 30 }, mined: [30], spends: { 30: ["301", "302"] } }), T0 + STALE_DROP_MS + 1)).toBe(1);
    expect(getOperation(sent)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(30)] } });
    // after a reload: the relayer does not know it, its notes are spent — sent, its transaction unknown here: left as it is
    const spent = record("send", "submitting", 31, T0, { nullifiers: ["311", "312"], relayerUrl: relayer });
    applyEvent(spent, { type: "recovery-required", code: "relayer_unreachable" }, session, T0);
    resetOperationsMemory();
    expect(await reconcileStaleOperations(chain({ spent: ["311"] }), T0 + STALE_DROP_MS + 1)).toBe(0);
    expect(getOperation(spent)!.state, "never 'nothing moved: start it again'").toBe("RECOVERY_REQUIRED");
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
    expect(getOperation(unanswered)!.state, "the wallet may still be asking: waited for").toBe("AWAITING_AUTHORIZATION");
    expect(await reconcileStaleOperations(chain(), T0 + 10 * 60_000 + 1), "its own wallet's: waited for an hour (audit round 2, n66)").toBe(0);
    expect(await reconcileStaleOperations(chain(), T0 + STALE_DROP_WALLET_MS + 1)).toBe(1);
    expect(getOperation(unanswered)).toMatchObject({ state: "FAILED", reason: { code: "interrupted", fundsClass: "not-moved" } });
  });

  it("a Send whose answer its page never got: the relayer, asked by its nullifiers, names the transaction; unspent and unknown past the limit, nothing moved; spent, left", async () => {
    const relayer = "http://relayer.test";
    const answered = record("send", "submitting", 20, T0, { nullifiers: ["201", "202"], relayerUrl: relayer });
    const lost = record("send", "submitting", 21, T0, { nullifiers: ["211", "212"], relayerUrl: relayer });
    const spentElsewhere = record("withdraw", "submitting", 22, T0, { nullifiers: ["221", "222"], relayerUrl: relayer });
    resetOperationsMemory();
    const reads = chain({ jobs: { "201": 20 }, mined: [20], spent: ["221"], spends: { 20: ["201", "202"] } });
    expect(await reconcileStaleOperations(reads, T0 + 60_000), "the answered one completed; the spent one waits (the review round of 2026-11-02)").toBe(2);
    expect(getOperation(answered)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(20)] } });
    expect(getOperation(lost)!.state).toBe("SUBMITTING");
    expect(await reconcileStaleOperations(reads, T0 + STALE_DROP_MS + 1)).toBe(1);
    expect(getOperation(lost)).toMatchObject({ state: "FAILED", reason: { code: "interrupted", fundsClass: "not-moved" } });
    expect(
      getOperation(spentElsewhere),
      "sent, its transaction unknown here: never called interrupted — and never left where it blocks the next Send for good",
    ).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: { code: "outcome_unknown", fundsClass: "unknown" },
    });
    expect(await reconcileStaleOperations(reads, T0 + 2 * STALE_DROP_MS), "read again, nothing new: no second move").toBe(0);
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

  it("a Send waiting as RECOVERY_REQUIRED, its answer lost and its notes spent, completes once the pool's spend index names its transaction (the sixth review round, 2026-11-03)", async () => {
    const relayer = "http://relayer.test";
    const lost = record("send", "submitting", 33, T0, { nullifiers: ["331", "332"], relayerUrl: relayer, inputsDigest: "0xa1" });
    applyEvent(lost, { type: "recovery-required", code: "relayer_unreachable" }, session, T0);
    resetOperationsMemory();
    // the relayer never names it; the index does not have the pair yet: left waiting
    expect(await reconcileStaleOperations(chain({ spent: ["331", "332"] }), T0 + STALE_DROP_MS + 1)).toBe(0);
    expect(getOperation(lost)!.state).toBe("RECOVERY_REQUIRED");
    // another pair's spend, or the pair in the other order, is not this record's
    expect(
      await reconcileStaleOperations(
        chain({ spent: ["331", "332"], index: { "332,331": 33, "331,999": 34 }, mined: [33, 34], spends: { 33: ["332", "331"], 34: ["331", "999"] } }),
        T0 + STALE_DROP_MS + 1,
      ),
    ).toBe(0);
    expect(getOperation(lost)!.state).toBe("RECOVERY_REQUIRED");
    // the index names the transact that spent exactly this pair: submitted as the wallet's own, then completed from its receipt
    expect(
      await reconcileStaleOperations(
        chain({ spent: ["331", "332"], index: { "331,332": 33 }, mined: [33], spends: { 33: ["331", "332"] }, inputs: { 33: "0xa1" } }),
        T0 + STALE_DROP_MS + 1,
      ),
    ).toBe(1);
    expect(getOperation(lost)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(33)] } });
    // the same for one sent through the connected wallet (no relayer to ask) whose page lost the answer
    const own = record("send", "submitting", 35, T0, { nullifiers: ["351", "352"], inputsDigest: "0xc1" });
    resetOperationsMemory();
    expect(
      await reconcileStaleOperations(
        chain({ spent: ["351"], index: { "351,352": 35 }, mined: [35], spends: { 35: ["351", "352"] }, inputs: { 35: "0xc1" } }),
        T0 + 60_000,
      ),
    ).toBe(1);
    expect(getOperation(own)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(35)] } });
    expect(
      getOperation(own)!.history.some((h) => h.state === "SOURCE_CONFIRMING"),
      "submitted, then completed",
    ).toBe(true);
  });

  it("the pair alone adopts nothing: another Send of the same note spends the same pair — its call's inputs decide; another operation's fails the record as spent elsewhere (the sixth review round, 2026-11-03)", async () => {
    const relayer = "http://relayer.test";
    // A's answer was lost; B, a later Send of the same single note, spent the same pair (the phantom pad derives from the first nullifier)
    const a = record("send", "submitting", 70, T0, { nullifiers: ["701", "702"], relayerUrl: relayer, inputsDigest: "0xaaaa" });
    applyEvent(a, { type: "recovery-required", code: "relayer_unreachable" }, session, T0);
    resetOperationsMemory();
    // the index names B's transaction for the pair, its inputs not readable here (a smart account's call): nothing adopted, nothing failed
    expect(await reconcileStaleOperations(chain({ spent: ["701"], index: { "701,702": 71 }, mined: [71], spends: { 71: ["701", "702"] } }), T0 + 60_000)).toBe(
      0,
    );
    expect(getOperation(a)!.state).toBe("RECOVERY_REQUIRED");
    // the relayer files B under the same nullifiers: its job is not A's either
    expect(
      await reconcileStaleOperations(
        chain({ spent: ["701"], jobs: { "701": 71 }, mined: [71], spends: { 71: ["701", "702"] }, inputs: { 71: "0xbbbb" } }),
        T0 + 60_000,
      ),
    ).toBe(0);
    expect(getOperation(a)!.state, "the relayer's job of another operation is not adopted").toBe("RECOVERY_REQUIRED");
    // B's inputs read: another operation spent A's notes — A can never land; nothing of it was sent
    expect(
      await reconcileStaleOperations(
        chain({ spent: ["701"], index: { "701,702": 71 }, mined: [71], spends: { 71: ["701", "702"] }, inputs: { 71: "0xbbbb" } }),
        T0 + 60_000,
      ),
    ).toBe(1);
    expect(getOperation(a)).toMatchObject({ state: "FAILED", reason: { code: "spent_elsewhere", fundsClass: "not-moved" }, refs: { txHashes: [] } });
    // an older record (no inputs kept): the index alone adopts nothing, as before this round
    const old = record("send", "submitting", 72, T0, { nullifiers: ["721", "722"], relayerUrl: relayer });
    applyEvent(old, { type: "recovery-required", code: "relayer_unreachable" }, session, T0);
    resetOperationsMemory();
    expect(
      await reconcileStaleOperations(
        chain({ spent: ["721"], index: { "721,722": 73 }, mined: [73], spends: { 73: ["721", "722"] }, inputs: { 73: "0xdddd" } }),
        T0 + 60_000,
      ),
    ).toBe(0);
    expect(getOperation(old)!.state).toBe("RECOVERY_REQUIRED");
  });

  it("a record that reached the submission but kept nothing (from before the keeping of 2026-10-14): past the limit it waits as RECOVERY_REQUIRED rather than block the wallet for good (the review round of 2026-11-02)", async () => {
    const bare = record("send", "submitting", 60);
    resetOperationsMemory();
    expect(await reconcileStaleOperations(chain(), T0 + 60_000), "within the limit: left").toBe(0);
    expect(getOperation(bare)!.state).toBe("SUBMITTING");
    expect(await reconcileStaleOperations(chain(), T0 + STALE_DROP_WALLET_MS + 1)).toBe(1);
    expect(getOperation(bare)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "outcome_unknown", fundsClass: "unknown" } });
  });

  it("the relayer's word alone completes nothing: a transaction spending other notes is never adopted, and one a record already carries needs recovery (the audit round of 2026-10-16, c42)", async () => {
    const relayer = "http://relayer.test";
    const named = record("send", "submitting", 30, T0, { nullifiers: ["301", "302"], relayerUrl: relayer });
    resetOperationsMemory();
    // the relayer names transaction 31: mined, but a spend of notes 311/312
    const reads = chain({ jobs: { "301": 31 }, mined: [31], spends: { 31: ["311", "312"] } });
    await reconcileStaleOperations(reads, T0 + 60_000);
    expect(getOperation(named)!.state, "not adopted: still waiting for its own").toBe("SUBMITTING");
    expect(getOperation(named)!.refs.txHashes).toEqual([]);
    // a Send whose page got the relayer's answer before it went away carries that transaction
    const carried = record("send", "submitting", 32, T0, { nullifiers: ["321", "322"], relayerUrl: relayer });
    applyEvent(carried, { type: "submitted", by: "relayer", txHash: hash(33) }, undefined, T0);
    resetOperationsMemory();
    await reconcileStaleOperations(chain({ mined: [33], spends: { 33: ["331", "332"] } }), T0 + 60_000);
    expect(getOperation(carried)).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code: "not_this_spend", fundsClass: "unknown" } });
  });

  it("a record it moved is still its own to move: a Send it moved to SUBMITTED completes in the same page (the audit round of 2026-10-16, c43)", async () => {
    const relayer = "http://relayer.test";
    const id = record("send", "submitting", 40, T0, { nullifiers: ["401", "402"], relayerUrl: relayer });
    resetOperationsMemory();
    await reconcileStaleOperations(chain({ jobs: { "401": 40 }, known: [40], spends: { 40: ["401", "402"] } }), T0 + 60_000);
    expect(getOperation(id)).toMatchObject({ state: "SOURCE_CONFIRMING", refs: { txHashes: [hash(40)] } });
    // no reload: the transaction is mined at the next scan
    expect(await reconcileStaleOperations(chain({ jobs: { "401": 40 }, mined: [40], spends: { 40: ["401", "402"] } }), T0 + 120_000)).toBe(1);
    expect(getOperation(id)).toMatchObject({ state: "COMPLETED", refs: { txHashes: [hash(40)] } });
  });

  it("a transaction the wallet's own connection sent waits an hour before it reads dropped, and never while what it made shows (audit round 2, n66)", async () => {
    const send = record("send", "confirming", 50, T0, { nullifiers: ["501", "502"] });
    const protect = record("protect", "confirming", 51, T0, { noteCounter: 88 });
    resetOperationsMemory();
    // a private mempool: the RPC sees nothing of either until it is mined
    expect(await reconcileStaleOperations(chain(), T0 + 10 * 60_000 + 1), "ten minutes: waited for (an hour for every send since the sixth review round)").toBe(
      0,
    );
    // an hour on, the Protect's note found by the scan (it landed, the RPC still blind): never "dropped, send it again"
    noteStore.add({
      note: { vaultId: 1n, amount: 990n, ownerCommitment: 2n, noteSecret: 3n },
      leafIndex: 8,
      noteData: "0x",
      counter: 88,
      spent: false,
      txHash: hash(51),
    });
    expect(await reconcileStaleOperations(chain(), T0 + STALE_DROP_WALLET_MS + 1)).toBe(1);
    expect(getOperation(protect)!.state).toBe("SOURCE_CONFIRMING");
    expect(getOperation(send)).toMatchObject({ state: "FAILED", reason: { code: "transaction_dropped" } });
    expect(STALE_DROP_WALLET_MS).toBe(3_600_000);
  });

  it("a record this page still drives, a swap, an unread chain: nothing moves", async () => {
    const live = record("send", "proof", 7);
    expect(await reconcileStaleOperations(chain(), T0 + 1_000), "driven by a flow of this page").toBe(0);
    expect(getOperation(live)!.state).toBe("PREPARING_PROOF");
    const swap = record("swap", "proof", 8);
    resetOperationsMemory();
    expect(await reconcileStaleOperations(chain({ down: true }), T0 + STALE_DROP_MS + 1)).toBe(1); // the never-sent send needs no read
    expect(getOperation(swap)!.state, "a swap's runner moves it").toBe("PREPARING_PROOF");
    const sent = record("send", "confirming", 9);
    resetOperationsMemory();
    expect(await reconcileStaleOperations(chain({ down: true }), T0 + STALE_DROP_MS + 1), "unread: tried again at the next scan").toBe(0);
    expect(getOperation(sent)!.state).toBe("SOURCE_CONFIRMING");
  });
});
