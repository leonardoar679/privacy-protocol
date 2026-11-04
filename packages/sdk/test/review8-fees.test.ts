// The eighth review round (2026-11-03): the fees of the private spends. A housekeeping step pays at most the fee its daily cap was
// checked against, and books the fee it paid (B-1); a spend runs no more merges first than its Review named — none named, none run —
// and stops before any is paid (B-2); a private transfer started right after an unlock waits for the scan, as every other spend (B-5).
// The relayer is a stub whose n-th read of its terms answers the n-th minimum; the prover stops each spend before anything is sent.
import { beforeAll, describe, expect, it, vi } from "vitest";

const relayer = vi.hoisted(() => ({ reads: 0, minFees: [] as bigint[] }));
vi.mock("../src/deploymentGuard", async (orig) => ({ ...(await orig<Record<string, unknown>>()), guardDeployment: async () => undefined }));
vi.mock("../src/relayer", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const { encodePrivacyAddress } = await import("@privacy-wallet/protocol/address");
  const { viewKeyPair } = await import("@privacy-wallet/protocol/envelope");
  return {
    ...real,
    pickRelayer: async (urls: string[]) => {
      const minFeeWei = relayer.minFees[Math.min(relayer.reads, relayer.minFees.length - 1)];
      relayer.reads++;
      return {
        url: urls[0],
        info: {
          chainId: 31337,
          core: "0x00000000000000000000000000000000000000c0",
          feeVault: "0x00000000000000000000000000000000000000e7",
          relayer: "0x00000000000000000000000000000000000000aa",
          privacyAddress: encodePrivacyAddress(5n, viewKeyPair(7n).publicKey),
          minFeeWei: minFeeWei.toString(),
          gasPriceWei: "1",
          gasEstimate: "1",
          feeMarginBps: 1000,
          requireReadableFeePayload: false,
          inflight: 0,
          feePercentBps: 100,
        },
      };
    },
  };
});
vi.mock("../src/chain", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  syncTreeQuorum: async () => ({ leaves: [1n], root: 0n, nextLeafIndex: 1, notes: 1, layers: [1n] }),
}));

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { MergesMoved, privateTransfer, privateWithdrawal } from "../src/privateTx";
import { runHousekeepingStep, spentToday } from "../src/wallet/housekeeping";
import { mergeSchedule } from "../src/wallet/mergeSchedule";
import { CountersHeld, noteStore } from "../src/wallet/notes";
import { settings } from "../src/wallet/settings";
import { session } from "../src/wallet/session";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { ownerCommitmentOf } from "@privacy-wallet/protocol/note";
import { encodePrivacyAddress } from "@privacy-wallet/protocol/address";
import { viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { exactInput } from "@privacy-wallet/protocol/wallet/fees";
import type { TxSpec } from "@privacy-wallet/protocol/txInputs";

const ETH = 10n ** 18n;
const VAULT = "0x00000000000000000000000000000000000000e7";
const deployment = {
  chainId: 31337,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as never;
const relayed = { kind: "relayer" as const, url: "http://relayer.test" };
const captured: TxSpec[] = [];
const store = memoryStorage();

beforeAll(async () => {
  configure(
    defaultConfig({
      kdfLog2N: 12,
      storage: () => store,
      prover: async (spec) => {
        captured.push(spec);
        throw new Error("stopped before sending");
      },
    }),
  );
  await session.create("a strong password");
  session.acknowledgePhrase();
});

const seed = () => session.state().seed!;
function notes(...amounts: bigint[]) {
  const keys = deriveKeys(seed());
  noteStore.clear();
  amounts.forEach((amount, i) =>
    noteStore.add({
      note: { vaultId: BigInt(VAULT), amount, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, i) },
      leafIndex: i,
      noteData: "0x",
      counter: i,
      spent: false,
    }),
  );
  noteStore.observeCounter(amounts.length);
}

describe("a housekeeping step pays at most the fee its cap was checked against (B-1)", () => {
  it("a second read of 10 ETH is refused: nothing proved, the step waits, nothing booked", async () => {
    notes(25n * ETH);
    expect(settings.get().housekeeping.enabled).toBe(true);
    relayer.reads = 0;
    relayer.minFees = [10n ** 15n, 10n * ETH]; // the planner's read, then the split's own
    const before = captured.length;
    const r = await runHousekeepingStep({ masterSeed: seed(), deployment, session });
    expect(relayer.reads).toBe(2);
    expect(r).toMatchObject({ ran: null, waitedForCap: false });
    expect(captured.length, "nothing was proved").toBe(before);
    expect(spentToday(session).feeWei, "nothing booked").toBe(0n);
  });
  it("a second read at or below the first is paid as read: the proof's fee note never above the planned fee", async () => {
    notes(25n * ETH);
    relayer.reads = 0;
    relayer.minFees = [10n ** 15n, (9n * 10n ** 14n) / 1n];
    await runHousekeepingStep({ masterSeed: seed(), deployment, session }).catch((e) => e);
    const spec = captured.at(-1)!;
    expect(spec.outputs[2].amount <= (11n * 10n ** 15n) / 10n, String(spec.outputs[2].amount)).toBe(true);
  });
  it("the fee booked is the one paid", async () => {
    notes(25n * ETH);
    relayer.reads = 0;
    relayer.minFees = [10n ** 15n];
    const day0 = spentToday(session).feeWei;
    const r = await runHousekeepingStep({
      masterSeed: seed(),
      deployment,
      session,
      fee: async () => 10n ** 15n,
      exec: { split: async () => 7n, merge: async () => 7n },
    });
    expect(r.ran).not.toBeNull();
    expect(spentToday(session).feeWei - day0).toBe(7n);
  });
});

describe("a spend runs no more merges first than its Review named (B-2)", () => {
  const F = (11n * 10n ** 15n) / 10n;
  const terms = { minimum: F, feePercentBps: 100 };
  const reviewed = (amount: bigint) =>
    mergeSchedule(
      noteStore.unspent(BigInt(VAULT)).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount })),
      amount,
      F,
    ).pairs.length;
  it("a Review that named none: a merge needed by the spend's turn is MergesMoved, before any merge is proved", async () => {
    notes(3n * ETH, ETH, ETH);
    const split = exactInput((25n * ETH) / 10n, terms);
    const shown = reviewed(split.total);
    expect(shown).toBe(0);
    notes(ETH, ETH, (99n * ETH) / 100n, ETH, ETH); // split by housekeeping since
    relayer.reads = 0;
    relayer.minFees = [10n ** 15n, 10n ** 15n, (4n * ETH) / 11n];
    const before = captured.length;
    const err = await privateWithdrawal({
      masterSeed: seed(),
      deployment,
      amount: split.delivered,
      recipient: "0x00000000000000000000000000000000000000b0",
      vault: VAULT,
      submission: relayed,
      maxFee: split.fee,
      maxMergeFee: F,
      maxMerges: shown,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MergesMoved);
    expect((err as MergesMoved).code).toBe("merges_moved");
    expect(captured.length, "no merge proved").toBe(before);
  });
  it("a Review that named one: more by the spend's turn is MergesMoved; the count it named runs", async () => {
    notes(2n * ETH, 2n * ETH, ETH, ETH);
    const split = exactInput((45n * ETH) / 10n, terms);
    const shown = reviewed(split.total);
    expect(shown).toBe(1);
    notes(ETH, ETH, ETH, ETH, ETH, ETH);
    relayer.reads = 0;
    relayer.minFees = [10n ** 15n];
    const err = await privateWithdrawal({
      masterSeed: seed(),
      deployment,
      amount: split.delivered,
      recipient: "0x00000000000000000000000000000000000000b0",
      vault: VAULT,
      submission: relayed,
      maxFee: split.fee,
      maxMergeFee: F,
      maxMerges: shown,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MergesMoved);
    notes(2n * ETH, 2n * ETH, ETH, ETH); // the notes the Review saw
    const ran = await privateWithdrawal({
      masterSeed: seed(),
      deployment,
      amount: split.delivered,
      recipient: "0x00000000000000000000000000000000000000b0",
      vault: VAULT,
      submission: relayed,
      maxFee: split.fee,
      maxMergeFee: F,
      maxMerges: shown,
    }).catch((e) => e);
    expect(String(ran), "its one merge is proved").toMatch(/stopped before sending/);
  });
});

describe("a private transfer right after an unlock waits for the scan (B-5)", () => {
  it("no CountersHeld: it waits, then goes on", async () => {
    notes(2n * ETH);
    noteStore.holdUntilScanned();
    relayer.reads = 0;
    relayer.minFees = [10n ** 15n];
    const before = captured.length;
    const to = encodePrivacyAddress(11n, viewKeyPair(13n).publicKey);
    const t = privateTransfer({ masterSeed: seed(), deployment, amount: ETH, recipient: to, vault: VAULT, submission: relayed }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    expect(captured.length, "it waits").toBe(before);
    noteStore.releaseCounters(256);
    const err = await t;
    expect(err).not.toBeInstanceOf(CountersHeld);
    expect(String(err)).toMatch(/stopped before sending/);
  });
});
