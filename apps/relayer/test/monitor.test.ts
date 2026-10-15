// The submissions, looked at again (a V6 follow-up of 2026-10-14). A job left "submitted" only when someone asked GET
// /status/:txHash and found its receipt, and nothing asked: every nullifier ever submitted stayed "in flight" (436 in
// the local stack's relayer), and a dropped or replaced transaction kept its notes from ever being submitted here again.
// Now the relayer's own tick settles a job by its receipt, and drops one the node no longer knows past DROP_AFTER_MS
// whose nullifiers are unspent: it releases them and stops naming that job by nullifier. Offline: fake chain clients.
import { describe, expect, it } from "vitest";
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex, type PublicClient, type WalletClient } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { MemoryJournal } from "../src/journal";
import { DROP_AFTER_MS, Relayer, type Job, type RelayerConfig } from "../src/relayer";

const NOW = 1_800_000_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const job = (n: number, submittedAt: number, over: Partial<Job> = {}): Job => ({
  txHash: hash(n),
  nullifiers: [String(n * 10), String(n * 10 + 1)],
  feeWei: "1",
  feeVault: "0x00000000000000000000000000000000000000e7",
  feeOutputIndex: 2,
  feeNoteSecret: "1",
  feePayloadReadable: true,
  submittedAt,
  status: "submitted",
  ...over,
});

interface Chain {
  mined?: Set<Hex>;
  pending?: Set<Hex>;
  spent?: Set<string>;
  down?: boolean;
}

function relayerOver(jobs: Job[], chain: Chain) {
  const journal = new MemoryJournal<Job>();
  journal.save(jobs);
  const reads = { receipts: 0 };
  const publicClient = {
    getTransactionReceipt: async ({ hash: h }: { hash: Hex }) => {
      reads.receipts++;
      if (chain.down) throw new Error("fetch failed");
      if (chain.mined?.has(h)) return { status: "success", gasUsed: 100n, effectiveGasPrice: 2n, blockNumber: 7n };
      throw new TransactionReceiptNotFoundError({ hash: h });
    },
    getTransaction: async ({ hash: h }: { hash: Hex }) => {
      if (chain.down) throw new Error("fetch failed");
      if (chain.mined?.has(h) || chain.pending?.has(h)) return { hash: h };
      throw new TransactionNotFoundError({ hash: h });
    },
    readContract: async ({ args }: { args: [bigint] }) => {
      if (chain.down) throw new Error("fetch failed");
      return chain.spent?.has(String(args[0])) ?? false;
    },
  } as unknown as PublicClient;
  const cfg: RelayerConfig = {
    chainId: 1,
    core: "0x00000000000000000000000000000000000000c0",
    feeVault: "0x00000000000000000000000000000000000000e7",
    minFeeWei: 0n,
    gasEstimate: 1n,
    feeMarginBps: 0,
    privateKey: `0x${"77".repeat(32)}`,
    masterSeed: utf8ToBytes("relayer-monitor-test"),
    rpcUrl: "http://unused.test",
    requireReadableFeePayload: false,
    journal,
  };
  const relayer = new Relayer(cfg, { publicClient, walletClient: {} as WalletClient });
  const inflight = () => (relayer as unknown as { inflight: Set<string> }).inflight;
  return { relayer, journal, inflight, reads };
}

describe("the relayer's own look at its submissions", () => {
  it("a receipt settles a job on the relayer's tick: its nullifiers leave in flight, and a restart does not load them again", async () => {
    const mined = job(1, NOW - 60_000);
    const pending = job(2, NOW - 60_000);
    const w = relayerOver([mined, pending], { mined: new Set([mined.txHash]), pending: new Set([pending.txHash]) });
    expect(w.inflight().size, "a restart loads every submitted job's nullifiers").toBe(4);
    await w.relayer.monitor(NOW);
    expect(w.relayer.jobByNullifier("10")).toEqual({ txHash: mined.txHash, status: "mined" });
    expect([...w.inflight()].sort()).toEqual(["20", "21"]);
    const again = relayerOver(w.journal.load(), {});
    expect(again.inflight().size, "after a restart, only the pending job's").toBe(2);
  });

  it("a transaction the node no longer knows, past the limit, with its nullifiers unspent, is dropped and released", async () => {
    const lost = job(3, NOW - DROP_AFTER_MS - 1);
    const w = relayerOver([lost], {});
    await w.relayer.monitor(NOW);
    expect(w.journal.load()[0]).toMatchObject({ status: "dropped", droppedAt: NOW });
    expect(w.inflight().size).toBe(0);
    expect(w.relayer.jobByNullifier("30"), "the wallet is never sent to wait on it").toBeNull();
    // the wallet's next attempt is a new job for the same notes, and the lookup names that one
    const retried = relayerOver([...w.journal.load(), job(4, NOW, { nullifiers: ["30", "31"] })], { pending: new Set([hash(4)]) });
    expect(retried.relayer.jobByNullifier("30")).toEqual({ txHash: hash(4), status: "submitted" });
    expect(DROP_AFTER_MS).toBe(600_000);
  });

  it("nothing is dropped before the limit, while the node knows it, when a nullifier is spent, or when the chain cannot be read", async () => {
    const young = job(5, NOW - DROP_AFTER_MS + 1_000);
    const known = job(6, NOW - DROP_AFTER_MS - 1);
    const spentElsewhere = job(7, NOW - DROP_AFTER_MS - 1);
    const w = relayerOver([young, known, spentElsewhere], { pending: new Set([known.txHash]), spent: new Set(["71"]) });
    await w.relayer.monitor(NOW);
    expect(w.journal.load().map((j) => j.status)).toEqual(["submitted", "submitted", "submitted"]);
    expect(w.inflight().size).toBe(6);
    const down = relayerOver([job(8, NOW - DROP_AFTER_MS - 1)], { down: true });
    await down.relayer.monitor(NOW);
    expect(down.journal.load()[0].status, "an unread chain drops nothing").toBe("submitted");
  });

  it("one pass at a time: a tick while another runs does nothing", async () => {
    const w = relayerOver([job(9, NOW - 1_000), job(10, NOW - 1_000)], { pending: new Set([hash(9), hash(10)]) });
    await Promise.all([w.relayer.monitor(NOW), w.relayer.monitor(NOW)]);
    expect(w.reads.receipts, "each job's receipt asked once").toBe(2);
  });
});
