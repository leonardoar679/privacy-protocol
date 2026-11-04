// The eighth review round (2026-11-03): a funding whose notes another call spent never reads "landed" — the order closes instead of
// reconciling for good with Return funds and Abandon refused (B-4); a phrase restore that keeps this seed's stored journal holds its
// counters until the scan, as every unlock does (B-7).
import { beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { WalletSession, session } from "../src/wallet/session";
import { noteStore } from "../src/wallet/notes";
import { KDF_DEFAULT } from "../src/wallet/keystore";
import { fundingFate, FUNDING_SETTLE_MS, type FundingReads } from "../src/swapFunding";
import { runOrderTick, type OrderIo } from "../src/wallet/orderRunner";
import type { FundingAttempt, ScheduledAction, StoredSwap } from "../src/wallet/journal";

const store = memoryStorage();
const T0 = Date.parse("2026-11-03T12:00:00Z");
const DIGEST = "0x" + "d1".repeat(32);
const attempt = (over: Partial<FundingAttempt> = {}): FundingAttempt => ({
  nullifiers: ["111", "222"],
  by: "relayer",
  relayerUrl: "http://relayer.test",
  txHash: "0x" + "77".repeat(32),
  inputsDigest: DIGEST,
  at: T0,
  ...over,
});
const reads = (over: Partial<FundingReads> = {}): FundingReads => ({
  spent: async (n) => n === 111n,
  relayerJob: async () => null,
  receipt: async () => null,
  txKnown: async () => false,
  txSpends: async () => null,
  ...over,
});

beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});

describe("a funding's fate from its own call (B-4)", () => {
  const later = T0 + FUNDING_SETTLE_MS + 1;
  it("its notes spent with another note — another call — is dead, never landed", async () => {
    expect(await fundingFate(attempt(), reads({ spendOf: async () => "other" }), later)).toBe("dead");
  });
  it("its exact pair spent by a call of other inputs is dead; by its own inputs, landed", async () => {
    const seen = { spendOf: async () => ({ txHash: ("0x" + "88".repeat(32)) as `0x${string}` }) };
    expect(await fundingFate(attempt(), reads({ ...seen, txInputs: async () => ("0x" + "e2".repeat(32)) as `0x${string}` }), later)).toBe("dead");
    expect(await fundingFate(attempt(), reads({ ...seen, txInputs: async () => DIGEST as `0x${string}` }), later)).toBe("landed");
  });
  it("nothing that tells — no index, an older attempt without its digest — reads landed, as before", async () => {
    expect(await fundingFate(attempt(), reads(), later)).toBe("landed");
    expect(
      await fundingFate(attempt({ inputsDigest: undefined }), reads({ spendOf: async () => ({ txHash: ("0x" + "88".repeat(32)) as `0x${string}` }) }), later),
    ).toBe("landed");
  });
  it("the order runner then stops the order — never reconciling for good", async () => {
    const ORDER = "0x" + "cd".repeat(32);
    const end = Math.floor(T0 / 1000) + 1800;
    const s = {
      orderId: ORDER,
      attemptId: "0x" + "01".repeat(32),
      refundCounter: 7,
      provider: "thorchain",
      policy: "balanced",
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" },
        amount: (10n ** 18n).toString(),
      },
      params: { amount: (10n ** 18n).toString(), executeDeadline: end, refundAfter: end + 7200 },
      endpoint: "0x00000000000000000000000000000000000000e5",
      createdAt: T0,
      state: "committed",
      refundNoteData: "0x00",
      runner: { confirmedAt: T0 },
      fundingAttempt: attempt(),
    } as unknown as StoredSwap;
    const action: ScheduledAction = { id: `order-tick:${ORDER}`, kind: "order-tick", orderId: ORDER, dueAt: T0 };
    session.update((j) => {
      j.swaps = [s];
      j.schedule = [action];
    });
    const io = {
      fund: async () => ({ txHash: "0x" }),
      fundingFate: async (st: StoredSwap) => fundingFate(st.fundingAttempt!, reads({ spendOf: async () => "other" }), Date.now()),
      escrowBalance: async () => 0n,
      job: async () => null,
    } as unknown as OrderIo;
    const a = session.journal().schedule.find((x) => x.id === action.id)!;
    const r = await runOrderTick(a, { masterSeed: new Uint8Array(32), deployment: null, session, io, now: () => T0 + 60_000 });
    expect(r?.step).toBe("stopped");
    expect(session.journal().swaps[0].paused?.code).toBe("funding_unconfirmed");
  });
});

describe("a phrase restore that keeps the stored journal holds the counters until the scan (B-7)", () => {
  it("as an unlock does: no counter is handed out before the scan", async () => {
    const own = memoryStorage();
    const s = new WalletSession(own, { ...KDF_DEFAULT, N: 1 << 12 });
    const phrase = await s.create("first password");
    s.acknowledgePhrase();
    for (let i = 0; i < 5; i++) noteStore.allocateCounter(); // an older copy of the profile's journal: counter 5
    s.lock();
    expect(await s.unlock("first password")).toBe(true);
    expect(noteStore.countersHeld(), "the unlock holds them").toBe(true);
    s.lock();
    await s.restoreFromPhrase(phrase, "second password", { replace: true });
    expect(noteStore.countersHeld(), "and so does the restore that keeps the journal").toBe(true);
    noteStore.releaseCounters(256); // the scan after it
    expect(noteStore.countersHeld()).toBe(false);
  });
});
