// Private balance maintenance (plan V2 §73–§74): a split plan is a valid 1-in/3-out witness whose two
// notes are ours and whose fee note is the relayer's; a step runs the planner's first action within the
// daily fee cap and schedules the next under a new id (or tomorrow's when the cap is reached); the
// scheduler schedules a step only when maintenance is on and the shape calls for it; and a spend that
// needs more than eight merges says so truthfully, with the maintenance offer, instead of "insufficient".
import { describe, it, expect, beforeEach } from "vitest";
import { utf8ToBytes } from "@noble/hashes/utils";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { decryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { MerkleTree } from "@privacy-wallet/protocol/merkle";
import { txDomain } from "@privacy-wallet/protocol/payload";
import { TX_LEVELS, buildTxInputs } from "@privacy-wallet/protocol/txInputs";
import { noteStore, type OwnedNote } from "@privacy-wallet/sdk/wallet/notes";
import { ensureSpendable, HousekeepingNeeded, planSplit } from "@privacy-wallet/sdk/privateTx";
import { housekeepingPlan, pendingHousekeeping, runHousekeepingStep, scheduleHousekeeping, spentToday } from "@privacy-wallet/sdk/wallet/housekeeping";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { pendingActions } from "@privacy-wallet/sdk/wallet/schedule";
import type { Deployment } from "@privacy-wallet/sdk/chain";

const seed = utf8ToBytes("frontend-housekeeping-test-seed");
const keys = deriveKeys(seed);
const oc = ownerCommitmentOf(keys.spendKey);
const E = 10n ** 18n;
const ETH_VAULT = "0x00000000000000000000000000000000000000e7";
const VAULT = BigInt(ETH_VAULT);
const DOMAIN = txDomain(31337n, 0xc0ffeen);
const deployment: Deployment = { chainId: 31337, core: "0x00000000000000000000000000000000000000c0", ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [] };
const KDF = { N: 1 << 12, r: 8, p: 1 };
const hexToBytes = (h: string) => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));
const owned = (amount: bigint, leafIndex: number, secret = 7n): OwnedNote => ({ note: { vaultId: VAULT, amount, ownerCommitment: oc, noteSecret: secret + BigInt(leafIndex) }, leafIndex, noteData: "0x", spent: false });

describe("planSplit", () => {
  it("builds a valid witness: the piece and the rest are ours (decryptable with our view key), the fee note is the relayer's, value is conserved", () => {
    noteStore.clear();
    const note = owned(130n * E, 0);
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(note.note), 0n));
    const fee = { ownerCommitment: 0xfeen, viewPub: viewKeyPair(deriveKeys(utf8ToBytes("relayer")).viewKey).publicKey, amount: 2n * 10n ** 15n, vault: VAULT };
    const plan = planSplit(seed, tree.leaves, note, 100n * E, DOMAIN, fee);
    expect(plan.piece.note.amount).toBe(100n * E);
    expect(plan.rest.note.amount).toBe(130n * E - 100n * E - fee.amount);
    expect(plan.spec.outputs.map((o: Note) => o.amount)).toEqual([100n * E, 130n * E - 100n * E - fee.amount, fee.amount]);
    expect(plan.spec.outputs[2].ownerCommitment).toBe(0xfeen);
    expect(() => buildTxInputs(plan.spec, { check: true })).not.toThrow();
    const view = viewKeyPair(keys.viewKey);
    for (const i of [0, 1]) expect(decryptNoteData(view, hexToBytes(plan.noteData[i]))?.amount).toBe(plan.spec.outputs[i].amount);
    expect(decryptNoteData(viewKeyPair(deriveKeys(utf8ToBytes("relayer")).viewKey), hexToBytes(plan.noteData[2]))?.amount).toBe(fee.amount); // the relayer its fee
    expect(() => planSplit(seed, tree.leaves, note, 130n * E, DOMAIN, fee)).toThrow(/does not cover/);
  });
});

describe("housekeeping steps", () => {
  let s: WalletSession;
  beforeEach(async () => { noteStore.clear(); settings.reset(); s = new WalletSession(memoryStorage(), KDF); await s.create("pw"); });

  it("schedules a step only when maintenance is on and the shape calls for it; one pending at a time", () => {
    noteStore.add(owned(5n * E, 0));
    expect(scheduleHousekeeping(deployment, { session: s }), "well shaped").toBe(false);
    noteStore.add(owned(1330n * E, 1));
    settings.set({ housekeeping: { enabled: false, dailyFeeCapWei: "1" } });
    expect(scheduleHousekeeping(deployment, { session: s }), "off").toBe(false);
    settings.set({ housekeeping: { enabled: true, dailyFeeCapWei: "1" } });
    expect(scheduleHousekeeping(deployment, { session: s })).toBe(true);
    const a = pendingHousekeeping(s)!;
    expect(a.kind).toBe("housekeeping");
    expect(a.dueAt).toBeGreaterThan(Date.now() + 3600_000 - 1000); // never immediate: the balanced window
    expect(scheduleHousekeeping(deployment, { session: s }), "already pending").toBe(false);
    expect(scheduleHousekeeping(null, { session: s }), "no deployment").toBe(false);
  });

  it("a step runs the first action within the daily cap, journals the fee and schedules the next under a new id; at the cap it waits for tomorrow", async () => {
    noteStore.add(owned(1330n * E, 0));
    settings.set({ housekeeping: { enabled: true, dailyFeeCapWei: (5n * 10n ** 15n).toString() } }); // 0.005 ETH a day at a 0.002 fee: two steps
    const FEE = 2n * 10n ** 15n;
    const splits: { note: number; piece: bigint }[] = [];
    const exec = {
      split: async (_a: unknown, note: OwnedNote, piece: bigint) => { splits.push({ note: note.leafIndex, piece }); noteStore.markSpent([note.leafIndex]); noteStore.add(owned(piece, 100 + splits.length)); noteStore.add(owned(note.note.amount - piece - FEE, 200 + splits.length)); },
      merge: async () => { throw new Error("no merge expected"); },
    };
    const NOW = Date.UTC(2026, 9, 8, 10, 0, 0);
    const first = await runHousekeepingStep({ masterSeed: seed, deployment, session: s, now: NOW, fee: async () => FEE, exec });
    expect(first.ran).toMatchObject({ kind: "split", outputs: [100n * E, 1330n * E - 100n * E - FEE] });
    expect(splits).toEqual([{ note: 0, piece: 100n * E }]);
    expect(first.remaining).toBeGreaterThan(10);
    expect(spentToday(s, NOW)).toEqual({ feeWei: FEE, steps: 1 });
    const next = pendingHousekeeping(s)!;
    expect(next.dueAt).toBeGreaterThanOrEqual(NOW + 3600_000);
    expect(next.dueAt).toBeLessThanOrEqual(NOW + 24 * 3600_000);
    const second = await runHousekeepingStep({ masterSeed: seed, deployment, session: s, now: NOW + 5000, fee: async () => FEE, exec });
    expect(second.ran?.kind).toBe("split");
    expect(splits).toHaveLength(2);
    expect(spentToday(s, NOW).steps).toBe(2);
    // the cap: the third step waits for tomorrow's window
    const third = await runHousekeepingStep({ masterSeed: seed, deployment, session: s, now: NOW + 10_000, fee: async () => FEE, exec });
    expect(third).toMatchObject({ ran: null, waitedForCap: true });
    expect(splits).toHaveLength(2);
    const tomorrow = pendingActions(s).filter((a) => a.kind === "housekeeping");
    expect(tomorrow.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...tomorrow.map((a) => a.dueAt))).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 9, 1, 0, 0));
    // a new day: the counter restarts
    expect(spentToday(s, Date.UTC(2026, 9, 9, 2, 0, 0))).toEqual({ feeWei: 0n, steps: 0 });
    // the plan on the current notes reflects the two pieces
    const plan = housekeepingPlan(deployment, FEE);
    expect(plan[0].shape.count).toBe(3);
    // switched off: nothing runs
    settings.set({ housekeeping: { enabled: false, dailyFeeCapWei: "1" } });
    expect(await runHousekeepingStep({ masterSeed: seed, deployment, session: s, now: NOW + 20_000, fee: async () => FEE, exec })).toMatchObject({ ran: null, remaining: 0 });
  });

  it("a spend spread over too many notes is HousekeepingNeeded with a true message, not 'insufficient'", async () => {
    const submission = { kind: "wallet" as const }; // no relayer fee, no network
    for (let i = 0; i < 12; i++) noteStore.add(owned(E / 10n, i));
    const needed = (11n * E) / 10n; // 1.1 ETH from 0.1 notes: nine merges, one more than one go does
    await expect(ensureSpendable({ masterSeed: seed, deployment, needed, submission })).rejects.toThrow(HousekeepingNeeded);
    await expect(ensureSpendable({ masterSeed: seed, deployment, needed, submission })).rejects.toThrow(/spread over 12 notes.*more than 8 merges.*Private balance maintenance/);
    await expect(ensureSpendable({ masterSeed: seed, deployment, needed: 5n * E, submission })).rejects.toThrow(/insufficient shielded balance/);
  });
});
