// A transaction of ours is settled by every configured endpoint (audit round 2, r23). The first endpoint alone had decided
// a spend's outcome: its fabricated "reverted" failed a delivered Send as "not moved" (a second Send paid the recipient
// twice), a receipt with shifted leaves recorded the change note at a leaf not its own, and the reads that settle a record
// or a funding later — a receipt, a nullifier's spent bit — were that endpoint's too.
import { describe, expect, it } from "vitest";
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex, type PublicClient } from "viem";
import { minedTx, outcomeReads, ReceiptDisputed, RpcDisagreement, type Deployment } from "../src/chain";
import { classify } from "../src/operations/errors/catalog";

const HASH = ("0x" + "77".repeat(32)) as Hex;
const CORE = "0x00000000000000000000000000000000000000c0" as const;
const BLOCK = ("0x" + "b1".repeat(32)) as Hex;
type Receipt = {
  status: "success" | "reverted";
  blockHash: Hex;
  logs: { address: string; topics: Hex[]; data: Hex }[];
  gasUsed: bigint;
  effectiveGasPrice: bigint;
};
const receipt = (status: Receipt["status"], o: { block?: Hex; leaf?: number } = {}): Receipt => ({
  status,
  blockHash: o.block ?? BLOCK,
  logs: o.leaf === undefined ? [] : [{ address: CORE, topics: [("0x" + o.leaf.toString(16).padStart(64, "0")) as Hex], data: "0x" }],
  gasUsed: 21_000n,
  effectiveGasPrice: 1n,
});
/** An endpoint answering this receipt (null: none, ever), whether it knows the transaction, and a nullifier's spent bit. */
const endpoint = (r: Receipt | null, o: { known?: boolean; spent?: boolean } = {}) =>
  ({
    waitForTransactionReceipt: async () => {
      if (!r) throw new Error("Timed out while waiting for transaction");
      return r;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!r) throw new TransactionReceiptNotFoundError({ hash });
      return r;
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (!(o.known ?? !!r)) throw new TransactionNotFoundError({ hash });
      return {};
    },
    readContract: async () => o.spent ?? false,
  }) as unknown as PublicClient;
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("the outcome of a transaction of ours is every endpoint's (audit round 2, r23)", () => {
  it("a receipt the other endpoints do not give decides nothing: an unknown outcome, never 'not moved'", async () => {
    const lie = await outcome(minedTx(endpoint(receipt("reverted")), HASH, CORE, [endpoint(receipt("success"))]));
    expect(lie).toBeInstanceOf(ReceiptDisputed);
    expect(classify(lie)).toMatchObject({ code: "receipt_disputed", fundsClass: "unknown" });
    // other leaves, another block, none within the wait
    expect(await outcome(minedTx(endpoint(receipt("success", { leaf: 5 })), HASH, CORE, [endpoint(receipt("success", { leaf: 9 }))]))).toBeInstanceOf(
      ReceiptDisputed,
    );
    expect(
      await outcome(minedTx(endpoint(receipt("success")), HASH, CORE, [endpoint(receipt("success", { block: ("0x" + "b2".repeat(32)) as Hex }))])),
    ).toBeInstanceOf(ReceiptDisputed);
    expect(await outcome(minedTx(endpoint(receipt("success")), HASH, CORE, [endpoint(null)]))).toBeInstanceOf(ReceiptDisputed);
    // agreed: a revert is a revert (nothing moved), a mined transaction is mined
    expect(classify(await outcome(minedTx(endpoint(receipt("reverted")), HASH, CORE, [endpoint(receipt("reverted"))])))).toMatchObject({
      code: "receipt_reverted",
      fundsClass: "not-moved",
    });
    expect(await minedTx(endpoint(receipt("success")), HASH, CORE, [endpoint(receipt("success"))])).toMatchObject({ inserted: [], spends: [] });
  });

  it("the reads that settle a record or a funding later: a receipt or a spent bit the endpoints disagree on throws; a transaction is known when any endpoint knows it", async () => {
    const d = { core: CORE } as unknown as Deployment;
    const split = outcomeReads(d, [endpoint(receipt("reverted"), { spent: false }), endpoint(receipt("success"), { spent: true })]);
    await expect(split.receipt(HASH)).rejects.toBeInstanceOf(RpcDisagreement);
    await expect(split.spent(1n)).rejects.toBeInstanceOf(RpcDisagreement);
    const lagging = outcomeReads(d, [endpoint(null, { known: false }), endpoint(null, { known: true })]);
    expect(await lagging.txKnown(HASH), "one node saw it pending").toBe(true);
    expect(await lagging.receipt(HASH)).toBeNull();
    const agreed = outcomeReads(d, [endpoint(receipt("success"), { spent: true }), endpoint(receipt("success"), { spent: true })]);
    expect(await agreed.receipt(HASH)).toBe("success");
    expect(await agreed.spent(1n)).toBe(true);
  });
});
