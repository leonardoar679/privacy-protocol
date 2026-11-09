// A handed-over order is read at the relayer it was handed to (audit round 2, r38): every tick had built its reads from the
// relayer Settings name now, so an order handed to another one read "unknown" there — a handed-over, executed order fell
// back to "Waiting for source", polled every 15 s for good, its refund and shield job asked of a relayer that never had them.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { StoredSwap } from "../src/wallet/journal";

const asked = vi.hoisted(() => [] as string[]);
const refunds = vi.hoisted(() => ({
  asked: [] as string[],
  down: new Set<string>(),
  refusing: new Set<string>(),
  noSwaps: new Set<string>(),
  keeping: new Map<string, string>(),
}));
const escrowNow = vi.hoisted(() => ({ value: null as bigint | null, tokens: {} as Record<string, bigint | null> }));
vi.mock("../src/orderTracker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orderTracker")>()),
  // the order's ETH, else a token's balance: none unless set, null when not read
  escrowBalance: async (_d: unknown, _e: unknown, token: string | null) =>
    token ? (token.toLowerCase() in escrowNow.tokens ? escrowNow.tokens[token.toLowerCase()] : 0n) : escrowNow.value,
}));
vi.mock("../src/relayer", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/relayer")>();
  return {
    ...real,
    relayerSwapStatus: async (url: string, orderId: string) => {
      asked.push(url);
      return url === "http://old.relayer" ? { id: orderId, escrow: "0x00000000000000000000000000000000000e5c00", state: "executed", updatedAt: 1 } : null;
    },
    relayerSwapRefund: async (url: string) => {
      refunds.asked.push(url);
      if (refunds.down.has(url)) throw new TypeError("fetch failed");
      if (refunds.refusing.has(url)) throw new real.RelayerRefusal("this order is not refundable here", "not_refundable", 400);
      if (refunds.noSwaps.has(url)) throw new real.RelayerRefusal(`the relayer at ${url} runs no swap executor`, "swap_unavailable", 503);
      // one that answers with the job it keeps, unchanged (the relayer's addRefund reopens only an executed refunded job)
      if (refunds.keeping.has(url))
        return { id: "0x" + "ab".repeat(32), escrow: "0x00000000000000000000000000000000000e5c00", state: refunds.keeping.get(url), updatedAt: 1 };
      return { id: "0x" + "ab".repeat(32), escrow: "0x00000000000000000000000000000000000e5c00", state: "refunding", updatedAt: 1 };
    },
  };
});

import { orderIo, returnFunds, runOrderTick, type OrderIo } from "../src/wallet/orderRunner";
import { trackOrder } from "../src/orderTracker";
import { getOperation } from "../src/operations/store";
import { swapRecordId } from "../src/operations/swapRecords";
import { defaultIo } from "../src/wallet/campaignRunner";
import { session } from "../src/wallet/session";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
beforeAll(async () => {
  configure(defaultConfig({ storage: () => memoryStorage(), kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});

describe("a handed-over order's relayer (audit round 2, r38)", () => {
  it("its job is read where it was handed over; the relayer Settings name now only when that one does not know it", async () => {
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment: null, session, submission: { kind: "relayer", url: "http://new.relayer" } });
    const stored = { orderId: "0x" + "ab".repeat(32), relayerUrl: "http://old.relayer" } as unknown as StoredSwap;
    expect((await io.job(stored))?.state).toBe("executed");
    expect(asked).toEqual(["http://old.relayer"]);
    asked.length = 0;
    expect(await io.job({ ...stored, relayerUrl: "http://gone.relayer" } as StoredSwap)).toBeNull();
    expect(asked, "unknown there: today's relayer asked too").toEqual(["http://gone.relayer", "http://new.relayer"]);
    asked.length = 0;
    await io.job({ ...stored, relayerUrl: undefined } as StoredSwap);
    expect(asked, "an order from before: today's relayer").toEqual(["http://new.relayer"]);
  });

  it("its refund goes where it was handed over; today's relayer takes it only when that one cannot be reached or runs no swaps", async () => {
    const deployment = { swapFactory: "0x00000000000000000000000000000000000000f1" } as never;
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://new.relayer" } });
    const stored = { orderId: "0x" + "ab".repeat(32), relayerUrl: "http://old.relayer", params: {}, refundNoteData: "0x01" } as unknown as StoredSwap;
    await io.refund(stored);
    expect(refunds.asked).toEqual(["http://old.relayer"]);
    refunds.asked.length = 0;
    refunds.down.add("http://old.relayer");
    await io.refund(stored);
    expect(refunds.asked, "unreachable: today's relayer").toEqual(["http://old.relayer", "http://new.relayer"]);
    refunds.asked.length = 0;
    refunds.down.clear();
    refunds.refusing.add("http://old.relayer");
    await expect(io.refund(stored)).rejects.toThrow(/not refundable/);
    expect(refunds.asked, "a refusal is an answer: never asked elsewhere").toEqual(["http://old.relayer"]);
    // one that runs no swaps now (restarted without its executor) holds no job it could carry out: today's relayer takes the refund (the
    // eleventh review round's third critique of slice 4) — and when today's runs none either, its answer is the one shown
    refunds.asked.length = 0;
    refunds.refusing.clear();
    refunds.noSwaps.add("http://old.relayer");
    await io.refund(stored);
    expect(refunds.asked, "no swaps there: today's relayer").toEqual(["http://old.relayer", "http://new.relayer"]);
    refunds.asked.length = 0;
    refunds.noSwaps.add("http://new.relayer");
    await expect(io.refund(stored)).rejects.toThrow(/http:\/\/new\.relayer runs no swap executor/);
  });

  // the twelfth review round, XH's critique: a relayer that dropped the order answers a refund-only request with the job it keeps, and its Return funds
  // had never reached the relayer Settings name
  it("its relayer answers with the job it keeps — 'refunded' over an escrow that still holds the order, or completed —: today's relayer takes the refund; the same one refuses in words naming Settings; a true 'refunded' is answered as it is", async () => {
    refunds.asked.length = 0;
    refunds.down.clear();
    refunds.refusing.clear();
    refunds.noSwaps.clear();
    const deployment = { swapFactory: "0x00000000000000000000000000000000000000f1" } as never;
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://new.relayer" } });
    const stored = {
      orderId: "0x" + "ab".repeat(32),
      relayerUrl: "http://old.relayer",
      params: { amount: (10n ** 18n).toString(), refundAfter: Math.floor(Date.now() / 1000) + 3600 },
      request: { from: { asset: "native" } },
      endpoint: "0x00000000000000000000000000000000000e5c00",
      refundNoteData: "0x01",
    } as unknown as StoredSwap;
    escrowNow.value = 10n ** 18n; // the escrow still holds the order
    refunds.keeping.set("http://old.relayer", "refunded");
    expect((await io.refund(stored)).state).toBe("refunding");
    expect(refunds.asked, "its own relayer keeps a job it will not reopen: today's").toEqual(["http://old.relayer", "http://new.relayer"]);
    refunds.asked.length = 0;
    refunds.keeping.set("http://old.relayer", "completed");
    await io.refund(stored);
    expect(refunds.asked, "a completed job kept closed: the same").toEqual(["http://old.relayer", "http://new.relayer"]);
    // the same relayer in Settings: refused, in words naming Settings and the refund time
    refunds.asked.length = 0;
    refunds.keeping.set("http://old.relayer", "refunded");
    const same = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://old.relayer" } });
    const refusal = await same.refund(stored).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(refusal).toMatchObject({ code: "refund_not_watched" });
    expect(refusal!.message).toMatch(/Choose another relayer in Settings/);
    expect(refusal!.message, "by the way Settings offer it (XI)").toMatch(/Advanced → Submission of private transactions/);
    expect(refusal!.message).toMatch(/deployAndRefund on the factory after /);
    // a true "refunded": the escrow read empty — answered as it is, never refused, never asked elsewhere
    refunds.asked.length = 0;
    escrowNow.value = 0n;
    expect((await io.refund(stored)).state).toBe("refunded");
    expect(refunds.asked).toEqual(["http://old.relayer"]);
    refunds.keeping.clear();
    escrowNow.value = null;
  });

  it("a campaign's step returned through Settings' relayer: a true 'refunded' (the escrow read empty) answered as it is; with the escrow holding it, refused", async () => {
    refunds.asked.length = 0;
    const deployment = { swapFactory: "0x00000000000000000000000000000000000000f1" } as never;
    const io = defaultIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://old.relayer" } });
    const stored = {
      orderId: "0x" + "ac".repeat(32),
      relayerUrl: "http://old.relayer",
      params: { amount: (10n ** 18n).toString(), refundAfter: Math.floor(Date.now() / 1000) + 3600 },
      request: { from: { asset: "native" } },
      endpoint: "0x00000000000000000000000000000000000e5c00",
      refundNoteData: "0x01",
    } as unknown as StoredSwap;
    session.update((j) => {
      j.swaps = [{ ...stored, relayerUrl: "http://older.relayer" } as StoredSwap];
    });
    refunds.keeping.set("http://old.relayer", "refunded");
    escrowNow.value = 0n;
    expect((await io.refund(stored)).state).toBe("refunded");
    // ... journaled with its job and the relayer that answered, a campaign's step never going through returnFunds (XK's critique)
    expect(session.journal().swaps[0]).toMatchObject({ jobId: "0x" + "ab".repeat(32), relayerUrl: "http://old.relayer" });
    session.update((j) => {
      j.swaps = [];
    });
    escrowNow.value = 10n ** 18n;
    await expect(io.refund(stored)).rejects.toMatchObject({ code: "refund_not_watched" });
    refunds.keeping.clear();
    escrowNow.value = null;
  });

  // the twelfth review round, XI's critique: a "refunded" is true only with nothing left to return — a refund token at its floor is something —, an
  // escrow not read is no answer either way, and a refund-failed job is one the relayer keeps
  it("a kept 'refunded' over a refund token held, an escrow not read, a refund-failed job; the same relayer's true 'refunded' answered as it is, one wei left too; the refusals' words", async () => {
    refunds.asked.length = 0;
    refunds.keeping.clear();
    const deployment = { swapFactory: "0x00000000000000000000000000000000000000f1", chainId: 1 } as never;
    const own = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://old.relayer" } });
    const other = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://new.relayer" } });
    const stored = {
      orderId: "0x" + "ad".repeat(32),
      relayerUrl: "http://old.relayer",
      params: { amount: (10n ** 18n).toString(), refundAfter: Math.floor(Date.now() / 1000) + 3600 },
      request: { from: { asset: "native" } },
      endpoint: "0x00000000000000000000000000000000000e5c00",
      refundNoteData: "0x01",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as unknown as StoredSwap;
    refunds.keeping.set("http://old.relayer", "refunded");
    // the same relayer, the escrow read empty: its "refunded" is true — and with one wei left in it
    escrowNow.value = 0n;
    escrowNow.tokens = {};
    expect((await own.refund(stored)).state).toBe("refunded");
    escrowNow.value = 1n;
    expect((await own.refund(stored)).state, "one wei: dust").toBe("refunded");
    expect(refunds.asked).toEqual(["http://old.relayer", "http://old.relayer"]);
    // a refund token held at its floor: nothing was returned — refused, and today's relayer takes it
    escrowNow.value = 0n;
    escrowNow.tokens = { [USDC.toLowerCase()]: 25_000_000n };
    const tokenHeld = await own.refund(stored).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(tokenHeld).toMatchObject({ code: "refund_not_watched" });
    // ... in words naming what is held and the escrow's own call for it (XJ's critique: deployAndRefund never moves a refund in another token)
    expect(tokenHeld!.message).toMatch(/still holds a refund in one of the route's refund tokens/);
    expect(tokenHeld!.message).toMatch(/refundToken on the escrow for the refund token it holds/);
    refunds.asked.length = 0;
    expect((await other.refund(stored)).state).toBe("refunding");
    expect(refunds.asked).toEqual(["http://old.relayer", "http://new.relayer"]);
    // the escrow not read, or one of its tokens: no answer either way — nothing asked elsewhere
    escrowNow.value = null;
    escrowNow.tokens = {};
    refunds.asked.length = 0;
    await expect(other.refund(stored)).rejects.toThrow(/could not be read to confirm it/);
    expect(refunds.asked, "never today's on an unread escrow").toEqual(["http://old.relayer"]);
    escrowNow.value = 0n;
    escrowNow.tokens = { [USDC.toLowerCase()]: null };
    await expect(own.refund(stored)).rejects.toThrow(/could not be read to confirm it/);
    // a refund-failed job, which the relayer never reopens: kept — today's relayer takes it; the same one refuses in its words
    refunds.keeping.set("http://old.relayer", "refund-failed");
    escrowNow.value = 10n ** 18n;
    escrowNow.tokens = {};
    refunds.asked.length = 0;
    expect((await other.refund(stored)).state).toBe("refunding");
    expect(refunds.asked).toEqual(["http://old.relayer", "http://new.relayer"]);
    const failed = await own.refund(stored).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(failed).toMatchObject({ code: "refund_not_watched" });
    expect(failed!.message).toMatch(/failed, and it does not try again/);
    expect(failed!.message, "the order's own asset held: the factory's deployAndRefund").toMatch(/deployAndRefund on the factory/);
    // the completed refusal's words name the way to another relayer and the refund time
    refunds.keeping.set("http://old.relayer", "completed");
    const completed = await own.refund(stored).then(
      () => null,
      (e: Error) => e,
    );
    expect(completed!.message).toMatch(/Choose another relayer in Settings \(Experience: Advanced, then Advanced → Submission of private transactions\)/);
    expect(completed!.message).toMatch(/deployAndRefund on the factory after /);
    // ... and with only a refund token held, each says so and names refundToken, never deployAndRefund (XK's critique: "that token" had named nothing)
    escrowNow.value = 0n;
    escrowNow.tokens = { [USDC.toLowerCase()]: 25_000_000n };
    for (const kept of ["refund-failed", "completed"]) {
      refunds.keeping.set("http://old.relayer", kept);
      const e = await own.refund(stored).then(
        () => null,
        (x: Error) => x,
      );
      expect(e!.message, kept).toMatch(/The escrow holds a refund in one of the route's refund tokens\./);
      expect(e!.message, kept).toMatch(/refundToken on the escrow for the refund token it holds/);
      expect(e!.message, kept).not.toMatch(/deployAndRefund/);
    }
    // ... over an escrow not read, a kept refund-failed job is still refused, and the relayer Settings name asked: it may hold the order still
    escrowNow.value = null;
    escrowNow.tokens = {};
    refunds.keeping.set("http://old.relayer", "refund-failed");
    refunds.asked.length = 0;
    expect((await other.refund(stored)).state).toBe("refunding");
    expect(refunds.asked, "not read: today's relayer asked").toEqual(["http://old.relayer", "http://new.relayer"]);
    escrowNow.value = 0n;
    // ... and over an escrow read holding nothing, a kept completed or refund-failed job is still refused and the relayer Settings name asked: only a
    // "refunded" is answered as it is (the twelfth review round: taken as an answer, a refund-failed job a relayer never reopens had looped a campaign's
    // step — XL's critique — and its readings had not settled since; stated)
    escrowNow.tokens = {};
    for (const kept of ["refund-failed", "completed"]) {
      refunds.keeping.set("http://old.relayer", kept);
      refunds.asked.length = 0;
      expect((await other.refund(stored)).state, kept).toBe("refunding");
      expect(refunds.asked, kept).toEqual(["http://old.relayer", "http://new.relayer"]);
    }
    refunds.keeping.clear();
    escrowNow.value = null;
  });

  it("Return funds answered with a true 'refunded': nothing closed there — the order read at once by its tracker, its refund note looked for (XJ)", async () => {
    const orderId = "0x" + "af".repeat(32);
    const deadline = Math.floor(Date.now() / 1000) - 3 * 86_400;
    const order = {
      orderId,
      attemptId: "0x" + "01".repeat(32),
      refundCounter: 7,
      provider: "lifi",
      policy: "balanced",
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" },
        amount: (10n ** 18n).toString(),
        destination: "So1",
        slippageBps: 50,
      },
      params: { amount: (10n ** 18n).toString(), executeDeadline: deadline, refundAfter: deadline + 7200, refundVault: "0x" + "e7".padStart(40, "0") },
      endpoint: "0x00000000000000000000000000000000000e5c00",
      createdAt: (deadline - 1800) * 1000,
      state: "executed",
      jobId: "job-1",
      relayerUrl: "http://old.relayer",
      handedOverAt: (deadline - 1700) * 1000,
      fundedTx: "0x" + "fa".repeat(32),
      executionTx: "0x" + "ee".repeat(32),
      refundNoteData: "0x01",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as unknown as StoredSwap;
    session.update((j) => {
      j.swaps = [{ ...order }];
      j.schedule = [];
    });
    const deployment = { swapFactory: "0x00000000000000000000000000000000000000f1", chainId: 1 } as never;
    refunds.keeping.set("http://old.relayer", "refunded");
    escrowNow.value = 0n;
    escrowNow.tokens = {};
    const same = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://old.relayer" } });
    expect(await returnFunds(orderId, { masterSeed: new Uint8Array(32), deployment, session, io: same })).toBe("refunding");
    const st = session.journal().swaps[0];
    expect(st.state, "never closed by Return funds").toBe("executed");
    expect(st.jobId).toBe("0x" + "ab".repeat(32));
    expect(getOperation(swapRecordId(orderId), session)?.state ?? "none", "its record never closed on the relayer's word").not.toBe("REFUNDED");
    expect(session.journal().schedule.find((a) => a.id === `order-tick:${orderId}` && !a.done)?.dueAt, "read at once").toBeLessThanOrEqual(Date.now());
    expect(
      session.journal().schedule.some((a) => a.kind === "discovery" && !a.done),
      "its refund note looked for",
    ).toBe(true);
    // ... and the tick that follows closes it on the tracker's own reading: the escrow's flag says executed, the provider's partial delivery is recorded
    // (XK's critique: the tick that closes it had never been run)
    const reading: OrderIo["track"] = (s0) =>
      trackOrder(s0, {
        deployment: null,
        session,
        now: Date.now(),
        readers: {
          job: async () => ({ id: "0x" + "ab".repeat(32), escrow: order.endpoint, state: "refunded", updatedAt: 1 }) as never,
          balance: async () => 0n,
          executed: async () => true,
          track: async () => ({ state: "partial", deliveredAmount: "6000000" }) as never,
          tokenBalance: async () => 0n,
        },
      });
    const tick = session.journal().schedule.find((a) => a.id === `order-tick:${orderId}` && !a.done)!;
    await runOrderTick(tick, { masterSeed: new Uint8Array(32), deployment, session, io: { ...same, track: reading } });
    expect(getOperation(swapRecordId(orderId), session), "the delivery recorded, never Refunded").toMatchObject({ state: "COMPLETED" });
    // ... answered by the relayer Settings name once the order's own could not be reached: journaled with that relayer, which the tracker reads from then on
    session.update((j) => {
      j.swaps = [{ ...order }];
      j.schedule = [];
      j.operations = [];
    });
    refunds.down.add("http://old.relayer");
    refunds.keeping.set("http://new.relayer", "refunded");
    const other = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://new.relayer" } });
    expect(await returnFunds(orderId, { masterSeed: new Uint8Array(32), deployment, session, io: other })).toBe("refunding");
    expect(session.journal().swaps[0]).toMatchObject({ state: "executed", relayerUrl: "http://new.relayer" });
    refunds.down.clear();
    // ... and a kept completed or refund-failed job is refused by the same relayer, nothing journaled: the order stays as it was
    for (const kept of ["refund-failed", "completed"]) {
      session.update((j) => {
        j.swaps = [{ ...order }];
        j.schedule = [];
        j.operations = [];
      });
      refunds.keeping.set("http://old.relayer", kept);
      await expect(returnFunds(orderId, { masterSeed: new Uint8Array(32), deployment, session, io: same }), kept).rejects.toMatchObject({
        code: "refund_not_watched",
      });
      expect(session.journal().swaps[0].state, kept).toBe("executed");
    }
    refunds.keeping.clear();
    escrowNow.value = null;
    session.update((j) => {
      j.swaps = [];
      j.schedule = [];
      j.operations = [];
    });
  });

  it("Return funds on a late refund held in a refund token, its relayer keeping 'refunded': refused with the order kept open — never closed Refunded on the relayer's word — and returned through another relayer (T2)", async () => {
    const orderId = "0x" + "ae".repeat(32);
    const deadline = Math.floor(Date.now() / 1000) - 3 * 86_400;
    const order = {
      orderId,
      attemptId: "0x" + "01".repeat(32),
      refundCounter: 7,
      provider: "lifi",
      policy: "balanced",
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" },
        amount: (10n ** 18n).toString(),
        destination: "So1",
        slippageBps: 50,
      },
      params: { amount: (10n ** 18n).toString(), executeDeadline: deadline, refundAfter: deadline + 7200, refundVault: "0x" + "e7".padStart(40, "0") },
      endpoint: "0x00000000000000000000000000000000000e5c00",
      createdAt: (deadline - 1800) * 1000,
      state: "executed",
      jobId: "job-1",
      relayerUrl: "http://old.relayer",
      handedOverAt: (deadline - 1700) * 1000,
      fundedTx: "0x" + "fa".repeat(32),
      executionTx: "0x" + "ee".repeat(32),
      refundNoteData: "0x01",
      refundTokens: [USDC],
      refundFloors: { [USDC.toLowerCase()]: "1000000" },
    } as unknown as StoredSwap;
    session.update((j) => {
      j.swaps = [{ ...order }];
    });
    const deployment = { swapFactory: "0x00000000000000000000000000000000000000f1", chainId: 1 } as never;
    refunds.keeping.set("http://old.relayer", "refunded");
    escrowNow.value = 0n;
    escrowNow.tokens = { [USDC.toLowerCase()]: 25_000_000n };
    const same = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://old.relayer" } });
    await expect(returnFunds(orderId, { masterSeed: new Uint8Array(32), deployment, session, io: same })).rejects.toMatchObject({ code: "refund_not_watched" });
    expect(session.journal().swaps[0].state, "never closed on the relayer's word").toBe("executed");
    const other = orderIo({ masterSeed: new Uint8Array(32), deployment, session, submission: { kind: "relayer", url: "http://new.relayer" } });
    expect(await returnFunds(orderId, { masterSeed: new Uint8Array(32), deployment, session, io: other })).toBe("refunding");
    expect(session.journal().swaps[0]).toMatchObject({ state: "refunding", relayerUrl: "http://new.relayer" });
    refunds.keeping.clear();
    escrowNow.value = null;
    escrowNow.tokens = {};
    session.update((j) => {
      j.swaps = [];
      j.schedule = [];
      j.operations = [];
    });
  });
});
