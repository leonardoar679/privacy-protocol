// The twelfth review round (A12-2, B12-5; W6 §2 items 3–4): a request its wallet app may still send — WalletConnect's request expiry, or the
// wallet app ending its session while the request was open — holds the next Protect back for the hour from the moment its record read so,
// is settled by the chain (a Protect by its note, a Send by the pool's spend of its pair with its own inputs), and an hour on with nothing on
// the chain reads never confirmed (wallet_request_unanswered): never "the page was closed before it was sent", which it had read.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { applyEvent, getOperation, newOperation, resetOperationsMemory, unresolvedOf } from "../src/operations/store";
import { awaitedDeposits, depositAwaited, reconcileStaleOperations, STALE_DROP_WALLET_MS, type StaleReads } from "../src/operations/stale";
import { noteStore } from "../src/wallet/notes";
import { forgetSpendIndexes } from "../src/wallet/spends";
import { walletAppMaySendUntil, WALLET_APP_MAY_SEND_MS, type OperationKind } from "../src/wallet/operationRecord";
import { CATALOG } from "../src/operations/errors/codes";

const store = memoryStorage();
beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterEach(() => {
  vi.restoreAllMocks();
  session.update((j) => {
    j.operations = [];
  });
  resetOperationsMemory();
  noteStore.clear();
  noteStore.setScanView([]);
  forgetSpendIndexes();
});

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const DIGEST = ("0x" + "d1".repeat(32)) as Hex;
const VAULT = "0x00000000000000000000000000000000000000e1";
const BODY = { vault: VAULT, amount: "1000" };
const CODES = ["wallet_request_expired", "wallet_session_ended"] as const;

/**
 * A record whose wallet app was asked — its counter (a Protect's deposit) or its notes (a Send) kept before the prompt, as the flows keep
 * them — and whose request then ended `code` at `at`: the screens' recovery for a row whose funds are unknown. Read back from the journal.
 */
function asked(
  kind: OperationKind,
  code: string,
  at: number,
  kept: { noteCounter?: number; nullifiers?: [string, string]; inputsDigest?: string; noteBody?: typeof BODY },
  /** when its request ended: at least the request's fifteen minutes after the confirmation, in the flows */ readAt = at,
): string {
  const r = newOperation(
    {
      kind,
      amounts: { asset: "ETH", decimals: 18, input: "1000" },
      destination: { kind: "privacy-address", display: kind === "protect" ? "protected-balance" : "pp1…", chain: "ethereum" },
      tier: "standard",
    } as never,
    at,
  );
  applyEvent(r.id, { type: "review" }, session, at);
  applyEvent(r.id, { type: "confirm" }, session, at);
  if (kind !== "protect") applyEvent(r.id, { type: "progress", step: "proof" }, session, at);
  applyEvent(r.id, { type: "progress", step: "submitting", ...kept } as never, session, at);
  applyEvent(r.id, { type: "recovery-required", code, detail: "the wallet app's answer" }, session, readAt);
  resetOperationsMemory();
  return r.id;
}
/** The chain as the stale mover reads it: the pool's spend of a pair (its transaction, that call's inputs, mined), spent bits. */
function chain(
  o: { index?: Record<string, number>; inputs?: Record<number, string>; mined?: number[]; spent?: string[]; spends?: Record<number, [string, string]> } = {},
): StaleReads {
  const has = (list: number[] | undefined, h: Hex) => (list ?? []).some((n) => hash(n) === h);
  return {
    receipt: async (h) => (has(o.mined, h) ? "success" : null),
    txKnown: async (h) => has(o.mined, h),
    spent: async (n) => (o.spent ?? []).includes(n.toString()),
    relayerJob: async () => null,
    txSpends: async (h) => {
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
const at = (t: number) => vi.spyOn(Date, "now").mockReturnValue(t);
const found = (counter: number, leafIndex: number) =>
  noteStore.add({
    note: { vaultId: BigInt(VAULT), amount: 1000n, ownerCommitment: BigInt(counter), noteSecret: 2n },
    leafIndex,
    noteData: "0x",
    counter,
    spent: false,
  });

describe("a Protect whose deposit request its wallet app may still send (W6 §2 item 3)", () => {
  for (const code of CODES) {
    it(`${code}: the next Protect held for the hour from the moment it read so — never a deposit awaited at the endpoints' tail`, () => {
      const id = asked("protect", code, T0, { noteCounter: 51, noteBody: BODY });
      const rec = getOperation(id)!;
      expect(rec).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { code, fundsClass: "unknown" } });
      expect(walletAppMaySendUntil(rec)).toBe(T0 + WALLET_APP_MAY_SEND_MS);
      at(T0 + 59 * MIN);
      expect(unresolvedOf([rec], "protect")?.id, "held within the hour").toBe(id);
      at(T0 + 60 * MIN + 1);
      expect(unresolvedOf([rec], "protect"), "the hour past: no longer held").toBeNull();
      // no tail trust (VA-N1): not a deposit its wallet reported sent
      expect(awaitedDeposits().map((a) => a.counter)).not.toContain(51);
      expect(depositAwaited(session, T0 + MIN)).toBe(false);
    });

    it(`${code}: an hour on with no note — FAILED wallet_request_unanswered (not moved), never interrupted; no verdict before`, async () => {
      const id = asked("protect", code, T0, { noteCounter: 52, noteBody: BODY });
      await reconcileStaleOperations(chain(), T0 + 59 * MIN);
      expect(getOperation(id)?.state, "within the hour: the chain's word awaited").toBe("RECOVERY_REQUIRED");
      await reconcileStaleOperations(chain(), T0 + 60 * MIN + 1);
      expect(getOperation(id)).toMatchObject({ state: "FAILED", reason: { code: "wallet_request_unanswered", fundsClass: "not-moved" } });
      at(T0 + 60 * MIN + 2);
      expect(unresolvedOf([getOperation(id)!], "protect")).toBeNull();
    });
  }

  it("its note at its counter recorded within the hour completes it through the stale mover — the proven pool's word", async () => {
    const id = asked("protect", "wallet_request_expired", T0, { noteCounter: 53, noteBody: BODY });
    found(53, 9);
    await reconcileStaleOperations(chain(), T0 + 20 * MIN);
    expect(getOperation(id)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: 9 } });
  });

  it("another device's note at the same counter is not its own: still awaited, then never confirmed", async () => {
    const id = asked("protect", "wallet_request_expired", T0, { noteCounter: 54, noteBody: BODY });
    noteStore.add({
      note: { vaultId: BigInt(VAULT), amount: 7n, ownerCommitment: 54n, noteSecret: 2n },
      leafIndex: 4,
      noteData: "0x",
      counter: 54,
      spent: false,
    });
    await reconcileStaleOperations(chain(), T0 + 20 * MIN);
    expect(getOperation(id)?.state).toBe("RECOVERY_REQUIRED");
    await reconcileStaleOperations(chain(), T0 + 61 * MIN);
    expect(getOperation(id)?.reason?.code).toBe("wallet_request_unanswered");
  });

  it("its note in the latest scan's view, not proven yet: no 'never confirmed' past the hour — it landed; recorded, it completes", async () => {
    const id = asked("protect", "wallet_session_ended", T0, { noteCounter: 55, noteBody: BODY });
    noteStore.setScanView([{ counter: 55, vaultId: BigInt(VAULT), amount: 1000n, leafIndex: 11 }]);
    await reconcileStaleOperations(chain(), T0 + 61 * MIN);
    expect(getOperation(id)?.state, "landed, its proof awaited").toBe("RECOVERY_REQUIRED");
    found(55, 11);
    await reconcileStaleOperations(chain(), T0 + 62 * MIN);
    expect(getOperation(id)).toMatchObject({ state: "COMPLETED", refs: { leafIndex: 11 } });
  });

  it("the hour counts from the moment it read so — fifteen minutes and more after its confirmation, never from its creation", async () => {
    const id = asked("protect", "wallet_request_expired", T0, { noteCounter: 59, noteBody: BODY }, T0 + 15 * MIN);
    const rec = getOperation(id)!;
    expect(rec.createdAt).toBe(T0);
    expect(walletAppMaySendUntil(rec)).toBe(T0 + 15 * MIN + WALLET_APP_MAY_SEND_MS);
    at(T0 + 15 * MIN + 59 * MIN);
    expect(unresolvedOf([rec], "protect")?.id, "held at the hour from its creation").toBe(id);
    await reconcileStaleOperations(chain(), T0 + 15 * MIN + 59 * MIN);
    expect(getOperation(id)?.state, "no verdict yet").toBe("RECOVERY_REQUIRED");
    at(T0 + 15 * MIN + 60 * MIN + 1);
    expect(unresolvedOf([rec], "protect")).toBeNull();
    await reconcileStaleOperations(chain(), T0 + 15 * MIN + 60 * MIN + 1);
    expect(getOperation(id)?.reason?.code).toBe("wallet_request_unanswered");
  });

  it("the hour counts from the moment it read so — a note written on the record later moves neither its hold nor its end", async () => {
    const id = asked("protect", "wallet_request_expired", T0, { noteCounter: 56, noteBody: BODY });
    applyEvent(id, { type: "note", note: "a later line" }, session, T0 + 50 * MIN);
    const rec = getOperation(id)!;
    expect(rec.updatedAt, "the note moved its last change").toBe(T0 + 50 * MIN);
    expect(walletAppMaySendUntil(rec)).toBe(T0 + WALLET_APP_MAY_SEND_MS);
    // the hold on the same clock (the critique of 12d1b): its hour, never the note's
    at(T0 + 59 * MIN);
    expect(unresolvedOf([rec], "protect")?.id, "held within its hour").toBe(id);
    at(T0 + 60 * MIN + 1);
    expect(unresolvedOf([rec], "protect"), "its hour past: no longer held, the note's hour notwithstanding").toBeNull();
    await reconcileStaleOperations(chain(), T0 + 61 * MIN);
    expect(getOperation(id)?.reason?.code, "its hour, not the note's").toBe("wallet_request_unanswered");
  });
});

describe("a self-submitted Send whose request its wallet app may still send (W6 §2 item 4)", () => {
  it("held while its notes are unspent; the pool's spend of them by a call with its own inputs completes it, the hash adopted", async () => {
    const id = asked("send", "wallet_request_expired", T0, { nullifiers: ["61", "62"], inputsDigest: DIGEST });
    at(T0 + 20 * MIN); // the hold's own clock, never the machine's
    expect(unresolvedOf([getOperation(id)!], "send")?.id, "the wallet app may still send it").toBe(id);
    await reconcileStaleOperations(
      chain({ index: { "61,62": 7 }, inputs: { 7: DIGEST }, mined: [7], spent: ["61", "62"], spends: { 7: ["61", "62"] } }),
      T0 + 20 * MIN,
    );
    expect(getOperation(id)).toMatchObject({ state: "COMPLETED" });
    expect(getOperation(id)!.refs.txHashes).toContain(hash(7));
  });

  it("its notes spent by another call: spent elsewhere; unspent an hour on: never confirmed, the next Send no longer held", async () => {
    const other = asked("send", "wallet_session_ended", T0, { nullifiers: ["63", "64"], inputsDigest: DIGEST });
    await reconcileStaleOperations(chain({ index: { "63,64": 8 }, inputs: { 8: "0x" + "ee".repeat(32) }, mined: [8], spent: ["63", "64"] }), T0 + 10 * MIN);
    expect(getOperation(other)).toMatchObject({ state: "FAILED", reason: { code: "spent_elsewhere" } });
    const id = asked("send", "wallet_request_expired", T0, { nullifiers: ["65", "66"], inputsDigest: DIGEST });
    await reconcileStaleOperations(chain(), T0 + 59 * MIN);
    expect(getOperation(id)?.state).toBe("RECOVERY_REQUIRED");
    await reconcileStaleOperations(chain(), T0 + 61 * MIN);
    expect(getOperation(id)).toMatchObject({ state: "FAILED", reason: { code: "wallet_request_unanswered", fundsClass: "not-moved" } });
    expect(unresolvedOf([getOperation(id)!], "send")).toBeNull();
  });
});

describe("a Send's view of the pool (the critique of 12d1b)", () => {
  it("a Send's change counter in the latest scan's view is no word of it (only another installation's note can be there): never confirmed at its hour", async () => {
    const id = asked("send", "wallet_request_expired", T0, { nullifiers: ["67", "68"], inputsDigest: DIGEST, noteCounter: 70 });
    noteStore.setScanView([{ counter: 70, vaultId: BigInt(VAULT), amount: 5n, leafIndex: 40 }]);
    await reconcileStaleOperations(chain(), T0 + 61 * MIN);
    expect(getOperation(id)).toMatchObject({ state: "FAILED", reason: { code: "wallet_request_unanswered" } });
  });
});

describe("every other record keeps its own end", () => {
  it("a Protect whose page went away before its send still reads interrupted at the drop limit; one awaiting its deposit's note keeps its day", async () => {
    const r = newOperation(
      {
        kind: "protect",
        amounts: { asset: "ETH", decimals: 18, input: "1000" },
        destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
        tier: "standard",
      } as never,
      T0,
    );
    applyEvent(r.id, { type: "review" }, session, T0);
    applyEvent(r.id, { type: "confirm" }, session, T0);
    applyEvent(r.id, { type: "progress", step: "submitting", noteCounter: 57, noteBody: BODY } as never, session, T0);
    resetOperationsMemory();
    await reconcileStaleOperations(chain(), T0 + STALE_DROP_WALLET_MS + 1);
    expect(getOperation(r.id)).toMatchObject({ state: "FAILED", reason: { code: "interrupted" } });
    const unconfirmed = asked("protect", "deposit_unconfirmed", T0, { noteCounter: 58, noteBody: BODY });
    expect(walletAppMaySendUntil(getOperation(unconfirmed)!), "not a request its wallet app may still send").toBeNull();
    at(T0 + 2 * 60 * MIN);
    expect(unresolvedOf([getOperation(unconfirmed)!], "protect")?.id, "its day's hold").toBe(unconfirmed);
  });

  it("the row: never confirmed, nothing moved, the Review again", () => {
    expect(CATALOG.wallet_request_unanswered).toMatchObject({ source: "wallet", fundsClass: "not-moved", actions: ["review"] });
  });
});
