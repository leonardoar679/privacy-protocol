// Settlement tracking (whale spec §19, §25): the state a wallet derives from its journal, the relayer job,
// the escrow balance and the tracker — the plan §61 labels, the four-step line of plan §60, partial fills
// with both amounts, never a bare "failed" for a funded order — and the journaling of executionTx (once),
// the track read, a history entry per transition and the Activity label.
import { describe, it, expect, beforeEach } from "vitest";
import { deriveState, trackOrder, type TrackFacts } from "@privacy-wallet/sdk/orderTracker";
import type { SwapJob } from "@privacy-wallet/sdk/relayer";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { activityId, recordActivity } from "@privacy-wallet/sdk/wallet/activity";

const NOW = 1_800_000_000_000;
const sec = Math.floor(NOW / 1000);
const order = (over: Partial<StoredSwap> = {}): StoredSwap => ({
  orderId: "0x" + "ab".repeat(32), attemptId: "0x" + "11".repeat(32), refundCounter: 0, provider: "thorchain", policy: "balanced",
  request: { from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: (10n ** 18n).toString(), destination: "bc1q", slippageBps: 50 },
  params: { amount: (10n ** 18n).toString(), executeDeadline: sec + 3600, refundAfter: sec + 7200 }, endpoint: "0x" + "e5".repeat(20), createdAt: NOW - 60_000, state: "committed", ...over,
});
const job = (state: SwapJob["state"], over: Partial<SwapJob> = {}): SwapJob => ({ id: "0x" + "ab".repeat(32), escrow: "0x" + "e5".repeat(20), state, updatedAt: NOW, ...over });
const facts = (over: Partial<TrackFacts> = {}): TrackFacts => ({ now: NOW, job: null, escrowBalance: null, track: null, refundFound: false, ...over });
const steps = (t: ReturnType<typeof deriveState>) => t.steps.map((d) => (d ? 1 : 0)).join("");

describe("deriveState", () => {
  it("before and around funding: Preparing, Waiting for source, the funded escrow, Not started", () => {
    expect(deriveState(order({ dueAt: NOW + 3600_000 }), facts())).toMatchObject({ state: "COMMITTED", label: "Preparing" });
    expect(steps(deriveState(order(), facts()))).toBe("1000");
    expect(deriveState(order({ fundedTx: "0x1" }), facts())).toMatchObject({ state: "SOURCE_SUBMITTED", label: "Waiting for source" });
    expect(deriveState(order({ fundedTx: "0x1" }), facts({ escrowBalance: 10n ** 17n }))).toMatchObject({ state: "SOURCE_SUBMITTED" });
    // journaled funded without its transaction — reconciled from the escrow, or a funding that landed while its page was gone
    // (audit round 2, r10): funded all the same, never "Preparing" or "nothing left your private balance"
    expect(deriveState(order({ state: "funded" }), facts({ escrowBalance: 10n ** 18n })).state).toBe(deriveState(order({ fundedTx: "0x1", state: "funded" }), facts({ escrowBalance: 10n ** 18n })).state);
    const funded = deriveState(order({ fundedTx: "0x1", state: "funded" }), facts({ escrowBalance: 10n ** 18n }));
    expect(funded).toMatchObject({ state: "SOURCE_FINAL", label: "Preparing" });
    expect(steps(funded)).toBe("1100");
    expect(funded.detail).toMatch(/confirm the swap/);
    expect(deriveState(order({ state: "abandoned" }), facts())).toMatchObject({ state: "CANCELLED", label: "Not started" });
    expect(deriveState(order(), facts({ now: NOW + 2 * 3600_000 }))).toMatchObject({ state: "EXPIRED", label: "Not started" });
    expect(deriveState(order({ fundedTx: "0x1" }), facts({ escrowBalance: 10n ** 18n, now: NOW + 1.5 * 3600_000 }))).toMatchObject({ state: "PROVIDER_TIMEOUT", label: "Refunding" });
    expect(deriveState(order({ fundedTx: "0x1" }), facts({ escrowBalance: 10n ** 18n, now: NOW + 3 * 3600_000 }))).toMatchObject({ state: "REFUND_PENDING", label: "Refunding" });
  });

  it("handed over, its executor not read this time: never back to the funding phase (audit round 2, r38)", () => {
    const f = order({ fundedTx: "0x1", state: "executed", jobId: "j" });
    const unread = deriveState(f, facts({ job: null, escrowBalance: 0n }));
    expect(unread).toMatchObject({ state: "PROVIDER_EXECUTING", label: "Executing" });
    expect(steps(unread)).toBe("1100");
  });

  it("executing: the executor's job, then the destination side from the tracker, partial fills with both amounts", () => {
    const f = order({ fundedTx: "0x1", state: "executing", jobId: "j" });
    expect(deriveState(f, facts({ job: job("executing") }))).toMatchObject({ state: "SOURCE_FINAL", label: "Executing" });
    const exec = deriveState(f, facts({ job: job("executed", { executionTx: "0x" + "ee".repeat(32) }) }));
    expect(exec).toMatchObject({ state: "PROVIDER_EXECUTING", label: "Executing" });
    expect(exec.detail).toContain("0xeeeeeeee…");
    expect(steps(exec)).toBe("1100");
    const sent = deriveState(f, facts({ job: job("executed", { executionTx: "0xee" }), track: { state: "destination-submitted", destinationTxHash: "0x" + "dd".repeat(32) } }));
    expect(sent).toMatchObject({ state: "DESTINATION_SUBMITTED", label: "Waiting for destination" });
    expect(steps(sent)).toBe("1110");
    const fin = deriveState(f, facts({ job: job("executed", { executionTx: "0xee" }), track: { state: "destination-final", deliveredAmount: "3000000" } }));
    expect(fin).toMatchObject({ state: "DESTINATION_FINAL", label: "Waiting for destination", deliveredAmount: "0.03 BTC" });
    expect(steps(fin)).toBe("1111");
    const partial = deriveState(f, facts({ job: job("executed", { executionTx: "0xee" }), track: { state: "partial", deliveredAmount: "2000000", refundedAmount: (3n * 10n ** 17n).toString(), progress: { parts: 10, done: 7 } } }));
    expect(partial).toMatchObject({ state: "PARTIAL", label: "Partial", deliveredAmount: "0.02 BTC", refundedAmount: "0.3 ETH" });
    expect(partial.detail).toMatch(/0\.02 BTC delivered.*7 of 10 parts.*0\.3 ETH comes back/);
    expect(steps(partial)).toBe("1110");
    const streaming = deriveState(f, facts({ job: job("executed", { executionTx: "0xee" }), track: { state: "executing", progress: { parts: 300, done: 12 } } }));
    expect(streaming.detail).toContain("12 of 300 parts");
    expect(deriveState(f, facts({ job: job("executed", { executionTx: "0xee" }), track: { state: "refunded", refundedAmount: (10n ** 18n).toString() } }))).toMatchObject({ state: "REFUND_PENDING", label: "Refunding" });
    expect(deriveState(f, facts({ job: job("executed", { executionTx: "0xee" }), track: { state: "failed" } }))).toMatchObject({ state: "DESTINATION_FAILED", label: "Refunding" });
  });

  it("the end states: completed only after the watch, refunded with the note, needs attention says where the money is; never a bare failed", () => {
    const f = order({ fundedTx: "0x1", jobId: "j" });
    const done = deriveState(f, facts({ job: job("completed", { executionTx: "0xee" }), track: { state: "completed", deliveredAmount: "3000000" }, escrowBalance: 0n }));
    expect(done).toMatchObject({ state: "COMPLETED", label: "Completed" });
    expect(steps(done)).toBe("1111");
    expect(deriveState(f, facts({ job: job("completed", { executionTx: "0xee" }), track: { state: "partial", deliveredAmount: "2000000", refundedAmount: "1" }, escrowBalance: 0n }))).toMatchObject({ state: "PARTIAL", label: "Partial" });
    expect(deriveState(f, facts({ job: job("refunding") }))).toMatchObject({ state: "REFUND_PENDING", label: "Refunding" });
    expect(deriveState(f, facts({ job: job("refund-only") })).detail).toMatch(/re-shields after/);
    expect(deriveState(f, facts({ job: job("expired") })).detail).toMatch(/expired before execution/);
    expect(deriveState(f, facts({ escrowBalance: 0n, job: job("refunded") }))).toMatchObject({ state: "REFUNDED", label: "Refunded" });
    // the refund note: the order back (the twelfth review round, XG: a 1-unit note is no refund of it — anyone holding the payload can make one)
    expect(deriveState(order({ fundedTx: "0x1", refunds: [{ leafIndex: 3, vault: "0x", amount: (10n ** 18n).toString() }] }), facts({ escrowBalance: 0n }))).toMatchObject({ state: "REFUNDED" });
    expect(deriveState(order({ fundedTx: "0x1", refunds: [{ leafIndex: 3, vault: "0x", amount: "1" }] }), facts({ escrowBalance: 0n })).state).not.toBe("REFUNDED");
    const failed = deriveState(f, facts({ job: job("execute-failed", { error: "nonce too low" }), escrowBalance: 10n ** 18n }));
    expect(failed).toMatchObject({ state: "FAILED", label: "Needs attention" });
    expect(failed.detail).toMatch(/1 ETH sits in the one-time escrow \(nonce too low\)/);
    expect(deriveState(f, facts({ job: job("refund-failed") })).label).toBe("Needs attention");
    for (const t of [done, failed, partial(f)]) { expect(t.label.toLowerCase()).not.toBe("failed"); expect(t.detail.toLowerCase()).not.toContain("atomic"); }
  });
});
const partial = (f: StoredSwap) => deriveState(f, facts({ job: job("executed", { executionTx: "0xee" }), track: { state: "partial", deliveredAmount: "1", refundedAmount: "1" } }));

describe("an executor's job that ended with nothing in the escrow (a V6 follow-up of 2026-10-16, audit c07)", () => {
  it("never funded: Not started; funded: the refund is looked for; the refund note found: Refunded", () => {
    expect(deriveState(order({ jobId: "j" }), facts({ job: job("lapsed"), now: NOW + 30 * 3600_000 }))).toMatchObject({ state: "EXPIRED", label: "Not started" });
    expect(deriveState(order({ fundedTx: "0x1", state: "funded", jobId: "j" }), facts({ job: job("lapsed") }))).toMatchObject({ state: "REFUND_PENDING", label: "Refunding" });
    expect(deriveState(order({ fundedTx: "0x1", state: "funded", jobId: "j", refunds: [{ leafIndex: 4, vault: "0x" + "e1".repeat(20), amount: (10n ** 18n).toString() }] }), facts({ escrowBalance: 0n, job: job("lapsed") }))).toMatchObject({ state: "REFUNDED" });
  });
});

describe("a partial fill whose rest came back (a V6 follow-up of 2026-10-16)", () => {
  it("reads Partial with both amounts, not Refunded; a never-executed order's refund note still reads Refunded", () => {
    const f = order({ fundedTx: "0x1", state: "executing", jobId: "j", refunds: [{ leafIndex: 9, vault: "0x" + "e7".repeat(20), amount: "300000000000000000" }] });
    const back = deriveState(f, facts({ escrowBalance: 0n, refundFound: true, job: job("completed", { executionTx: "0xee" }), track: { state: "partial", deliveredAmount: "2000000", refundedAmount: "300000000000000000" } }));
    expect(back).toMatchObject({ state: "PARTIAL", label: "Partial", deliveredAmount: "0.02 BTC", deliveredUnits: "2000000", refundedAmount: "0.3 ETH" });
    const never = deriveState(order({ fundedTx: "0x1", refunds: [{ leafIndex: 9, vault: "0x" + "e7".repeat(20), amount: "1000000000000000000" }] }), facts({ escrowBalance: 0n, refundFound: true, job: job("refunded") }));
    expect(never).toMatchObject({ state: "REFUNDED", label: "Refunded" });
  });
  it("reads Partial when the relayer re-shielded the rest before its note is found (audit round 2, r14)", () => {
    const f = order({ fundedTx: "0x1", state: "executing", jobId: "j" });
    const reshielded = deriveState(f, facts({ escrowBalance: 0n, job: job("refunded", { executionTx: "0xee" }), track: { state: "partial", deliveredAmount: "2000000", refundedAmount: "300000000000000000" } }));
    expect(reshielded).toMatchObject({ state: "PARTIAL", label: "Partial", deliveredAmount: "0.02 BTC", refundedAmount: "0.3 ETH" });
    // nothing delivered: the re-shielded escrow is a refund
    expect(deriveState(f, facts({ escrowBalance: 0n, job: job("refunded", { executionTx: "0xee" }) }))).toMatchObject({ state: "REFUNDED" });
  });
});

describe("another token at the destination (the audit's unverified m60)", () => {
  it("reads Partial with the token it came in, no amount of the output and nothing said to have come back", () => {
    const f = order({ fundedTx: "0x1", state: "executing", jobId: "j", provider: "lifi" });
    // its escrow read (the twelfth review round, XL's critique: on a balance not read the order is read again first)
    const other = deriveState(f, facts({ job: job("completed", { executionTx: "0xee" }), escrowBalance: 0n, track: { state: "partial", deliveredAsset: "USDC.e" } }));
    expect(other).toMatchObject({ state: "PARTIAL", label: "Partial" });
    expect(other.deliveredUnits).toBeUndefined();
    expect(other.detail).toBe("Delivered in USDC.e at the destination instead of BTC: the route gave another token.");
    expect(other.detail).not.toMatch(/came back|comes back/);
  });

  it("with a leftover re-shielded too it stays Partial, never Refunded in full: the delivered step is not swapped again (audit round 2, n06)", () => {
    const f = order({ fundedTx: "0x1", state: "executing", jobId: "j", provider: "lifi" });
    const track = { state: "partial", deliveredAsset: "USDC.e" } as const;
    for (const fx of [facts({ escrowBalance: 0n, job: job("completed", { executionTx: "0xee" }), track, refundFound: true }), facts({ escrowBalance: 0n, job: job("refunded", { executionTx: "0xee" }), track })]) {
      const other = deriveState(f, fx);
      expect(other).toMatchObject({ state: "PARTIAL", label: "Partial" });
      expect(other.detail).toMatch(/^Delivered in USDC\.e at the destination instead of BTC; .* came back to the escrow and was re-shielded into your private balance\.$/);
    }
  });
});

describe("a delivery once read is never forgotten (the seventh review round, 2026-11-03)", () => {
  it("an executed order whose rest came back reads Partial on its journaled units when this read has none — never Refunded in full", () => {
    const f = order({ fundedTx: "0x1", state: "executed", jobId: "j", executionTx: "0xee", track: { state: "PARTIAL", label: "Partial", at: NOW - 60_000, deliveredAmount: "120000000" } });
    const t = deriveState(f, facts({ escrowBalance: 0n, job: job("refunded", { executionTx: "0xee" }), track: null }));
    expect(t).toMatchObject({ state: "PARTIAL", deliveredUnits: "120000000", deliveredAmount: "1.2 BTC" });
  });
  it("another token is named on the read, so a campaign ends the step without a delivery of the output", () => {
    const f = order({ fundedTx: "0x1", state: "executing", jobId: "j", provider: "lifi" });
    const t = deriveState(f, facts({ job: job("executed", { executionTx: "0xee" }), track: { state: "partial", deliveredAsset: "USDC.e" } }));
    expect(t).toMatchObject({ state: "PARTIAL", deliveredAsset: "USDC.e" });
    expect(t.deliveredUnits).toBeUndefined();
  });
});

describe("trackOrder", () => {
  const KDF = { N: 1 << 12, r: 8, p: 1 };
  let s: WalletSession;
  beforeEach(async () => { noteStore.clear(); s = new WalletSession(memoryStorage(), KDF); await s.create("pw"); });

  it("journals the execution transaction once, the track read, one history entry per transition and the Activity label", async () => {
    const o = order({ fundedTx: "0x1", jobId: "j", state: "executing" });
    s.update((j) => { j.swaps = [o]; });
    recordActivity({ id: activityId("swap", o.orderId), kind: "swap", asset: "ETH", decimals: 18, amount: o.params ? (o.params as any).amount : "1", status: "executing", ref: o.orderId, note: "→ BTC" }, s);
    const reads: string[] = [];
    const deps = (jobState: SwapJob["state"], track: any) => ({ deployment: null, session: s, now: NOW, readers: {
      job: async () => job(jobState, { executionTx: "0x" + "ee".repeat(32) }),
      balance: async () => 0n,
      track: async (_o: StoredSwap, tx: string) => { reads.push(tx); return track; },
    } });
    const a = await trackOrder(o, deps("executed", { state: "destination-submitted", destinationTxHash: "0xdd" }));
    expect(a.tracked.state).toBe("DESTINATION_SUBMITTED");
    expect(reads).toEqual(["0x" + "ee".repeat(32)]); // tracked by the execution tx the relayer reported
    let j = s.journal().swaps[0];
    expect(j.executionTx).toBe("0x" + "ee".repeat(32));
    expect(j.track).toMatchObject({ state: "DESTINATION_SUBMITTED", label: "Waiting for destination", destinationTxHash: "0xdd" });
    expect(j.history?.map((h) => h.state)).toEqual(["DESTINATION_SUBMITTED"]);
    expect(j.state).toBe("executed");
    expect(s.journal().activity![0].note).toBe("→ BTC · Waiting for destination");
    // the same facts again: no new history entry; the job names another execution — a copy of the relayer's call that
    // executed the escrow first, its own reverted (audit round 2, r01): the journal follows it, and the provider is tracked by it
    const tracked: string[] = [];
    const b = await trackOrder(s.journal().swaps[0], { ...deps("executed", { state: "destination-submitted" }), readers: { ...deps("executed", null).readers, job: async () => job("executed", { executionTx: "0x" + "ff".repeat(32) }), track: async (_o: StoredSwap, tx: string) => { tracked.push(tx); return { state: "destination-submitted" }; } } });
    expect(b.tracked.state).toBe("DESTINATION_SUBMITTED");
    expect(tracked).toEqual(["0x" + "ff".repeat(32)]);
    j = s.journal().swaps[0];
    expect(j.executionTx).toBe("0x" + "ff".repeat(32));
    expect(j.history).toHaveLength(1);
    // a transition adds one entry with its time and label
    const c = await trackOrder(j, { ...deps("completed", { state: "completed", deliveredAmount: "3000000" }), now: NOW + 60_000 });
    expect(c.tracked).toMatchObject({ state: "COMPLETED", label: "Completed", deliveredAmount: "0.03 BTC" });
    j = s.journal().swaps[0];
    expect(j.history?.map((h) => [h.state, h.at, h.note])).toEqual([["DESTINATION_SUBMITTED", NOW, "Waiting for destination"], ["COMPLETED", NOW + 60_000, "Completed"]]);
    expect(j.state).toBe("completed");
    expect(j.track?.deliveredAmount).toBe("3000000");
  });

  it("a read without units keeps the units the journal had (the seventh review round)", async () => {
    const o = order({ fundedTx: "0x1", jobId: "j", state: "executing" });
    s.update((j) => { j.swaps = [o]; });
    const deps = (track: unknown) => ({ deployment: null, session: s, now: NOW, readers: { job: async () => job("executed", { executionTx: "0xee" }), balance: async () => 0n, track: async () => track as never } });
    await trackOrder(o, deps({ state: "partial", deliveredAmount: "120000000" }));
    expect(s.journal().swaps[0].track?.deliveredAmount).toBe("120000000");
    const b = await trackOrder(s.journal().swaps[0], deps(null));
    expect(s.journal().swaps[0].track?.deliveredAmount, "kept").toBe("120000000");
    expect(b.tracked.deliveredUnits).toBe("120000000");
  });

  it("a suspected stall names the order's operation, never the wallet's own timing: the service decides from its records (2026-10-14)", async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ track: { state: "pending" }, status: "Pending" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const st = order({ fundedTx: "0x1", state: "executing", jobId: "j", operationId: "op_aaaaaaaaaaaaaaaaaaaaaaaaaa" });
      const readers = { job: async () => job("executed", { executionTx: "0x" + "ee".repeat(32) }), balance: async () => null };
      // on schedule: the transaction alone
      await trackOrder(st, { deployment: null, now: NOW, readers, stall: { since: sec - 600, expected: 600 } });
      // past three times the plan by the wallet's clock: the operation named, so the service can check its own records
      await trackOrder(st, { deployment: null, now: NOW, readers, stall: { since: sec - 3 * 600 - 1, expected: 600 } });
    } finally {
      globalThis.fetch = real;
    }
    expect(urls).toHaveLength(2);
    const [first, second] = urls.map((u) => new URL(u).searchParams);
    // the order's decimals go with every track: THORChain tracks in its own 1e8 units (the audit round of 2026-10-16, c25)
    expect([...first.keys()].sort()).toEqual(["inDecimals", "outDecimals", "tx"]);
    expect([...second.keys()].sort()).toEqual(["inDecimals", "operation", "outDecimals", "tx"]);
    expect(second.get("operation")).toBe("op_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    for (const u of urls) expect(u, "the wallet's own timing never leaves it").not.toMatch(/since=|expected=/);
  });

  it("without a relayer job or a deployment it still derives from the journal, and reads nothing", async () => {
    const o = order({ dueAt: NOW + 10_000 });
    s.update((j) => { j.swaps = [o]; });
    const r = await trackOrder(o, { deployment: null, session: s, now: NOW });
    expect(r).toMatchObject({ job: null, tracked: { state: "COMMITTED", label: "Preparing" } });
    expect(s.journal().swaps[0].history).toHaveLength(1);
  });
});

describe("an executed order the executor stopped watching (audit round 2, r36)", () => {
  const ended = (track: TrackFacts["track"], escrowBalance: bigint | null = 0n, over: Partial<StoredSwap> = {}) =>
    deriveState(order({ fundedTx: "0x1", state: "executed", jobId: "j", executionTx: "0xee", ...over }), facts({ job: job("completed", { executionTx: "0xee" }), escrowBalance, track }));

  it("is completed only on the provider's word; a refund that came back after the watch is the wallet's to return", () => {
    // a chain halt holds the provider's outbound: its track still says the destination transaction is on its way
    expect(ended({ state: "destination-submitted" })).toMatchObject({ state: "DESTINATION_SUBMITTED", label: "Waiting for destination", settlement: "DESTINATION_PENDING" });
    expect(ended({ state: "executing" })).toMatchObject({ state: "PROVIDER_EXECUTING", settlement: "PROVIDER_PENDING" });
    expect(ended(null).state, "an unread track is no delivery").toBe("PROVIDER_EXECUTING");
    expect(ended({ state: "refunded" }), "the watch ended with nothing back: the provider failed, nothing more comes back on its own (the sixth review round)").toMatchObject({ state: "PROVIDER_FAILED", label: "Needs attention" });
    // the refund lands days later: 1 % of the order or more waits for the wallet's return
    const back = ended({ state: "destination-submitted" }, 4n * 10n ** 17n);
    expect(back).toMatchObject({ state: "LATE_REFUND", label: "Needs attention", settlement: "REFUND_AVAILABLE" });
    expect(back.detail).toMatch(/0\.4 ETH back to the one-time escrow/);
    expect(ended({ state: "completed", deliveredAmount: "3000000" }, 10n ** 15n).state, "dust below 1 % is no refund").toBe("COMPLETED");
    // delivered on the provider's word
    expect(ended({ state: "destination-final", deliveredAmount: "3000000" })).toMatchObject({ state: "COMPLETED", settlement: "COMPLETED" });
    // a protected swap: the shield job's or the provider's word
    const shield = { params: { receiptId: "0x01" }, receiver: "0x" + "5e".repeat(20) } as unknown as StoredSwap["shield"];
    expect(ended({ state: "executing" }, 0n, { shield }).state).toBe("DESTINATION_SUBMITTED");
    expect(ended({ state: "completed" }, 0n, { shield }).state).toBe("DESTINATION_FINAL");
  });

  it("keeps the order open meanwhile: journaled executed, closed once the provider confirms", async () => {
    const s = new WalletSession(memoryStorage(), { N: 1 << 12, r: 8, p: 1 });
    await s.create("pw");
    const o = order({ fundedTx: "0x1", jobId: "j", state: "executed", executionTx: "0xee" });
    s.update((j) => { j.swaps = [o]; });
    let track: { state: string } = { state: "destination-submitted" };
    const deps = { deployment: null, session: s, now: NOW, readers: { job: async () => job("completed", { executionTx: "0xee" }), balance: async () => 0n, track: async () => track as any } };
    expect((await trackOrder(o, deps)).tracked.state).toBe("DESTINATION_SUBMITTED");
    expect(s.journal().swaps[0].state, "open: its next reads and its return still reach it").toBe("executed");
    track = { state: "completed" };
    expect((await trackOrder(s.journal().swaps[0], deps)).tracked.state).toBe("COMPLETED");
    expect(s.journal().swaps[0].state).toBe("completed");
  });
});
