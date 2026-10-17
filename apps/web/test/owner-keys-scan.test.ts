// Finding deposited notes again (the audit round of 2026-10-16, c18): a protect made out to its own owner commitment is
// found from its self-envelope by the same scan as the privacy address's notes — the payload opens with the view key, and
// the main thread derives its owner commitment from the opened secret —, with its counter, never as a transfer received;
// its spent status is read by its own key's nullifier. A payload that opens but lies about its leaf is no note. Refund
// claims accept the owner commitment the journaled order committed to, or (from the seed alone) the note's own or the
// privacy address's.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { utf8ToBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret, deriveOwnerKey } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { nullifier } from "@privacy-wallet/protocol/nullifier";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { useCoreModule } from "@privacy-wallet/sdk/core";
import { matchCommittedDeposits, refundClaims } from "@privacy-wallet/sdk/refunds";
import { scanNotes } from "@privacy-wallet/sdk/privateTx";
import type { Deployment, DepositedLog, NoteInsertedLog } from "@privacy-wallet/sdk/chain";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { startMockCore } from "./helpers/mockRpc";

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const seed = sha256(utf8ToBytes("owner-keys-scan-test-seed"));
const keys = deriveKeys(seed);
const view = viewKeyPair(keys.viewKey);
const main = ownerCommitmentOf(keys.spendKey);
const hex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
const plain = (n: Note) => ({ amount: n.amount, noteSecret: n.noteSecret, vaultId: n.vaultId });
const ownOc = (counter: number) => ownerCommitmentOf(deriveOwnerKey(keys.spendKey, deriveNoteSecret(keys.noteKey, counter)));

// leaf 0: a protect of the privacy address (counter 0, made before deposits had their own keys); leaf 4: a protect made out
// to its own owner commitment (counter 2); leaf 8: a transfer received (the privacy address, a secret no counter gives);
// leaf 12: a payload encrypted to us that lies about its leaf
const legacy: Note = { vaultId: BigInt(VAULT), amount: 10n ** 18n, ownerCommitment: main, noteSecret: deriveNoteSecret(keys.noteKey, 0) };
const deposited: Note = { vaultId: BigInt(VAULT), amount: 2n * 10n ** 18n, ownerCommitment: ownOc(2), noteSecret: deriveNoteSecret(keys.noteKey, 2) };
const received: Note = { vaultId: BigInt(VAULT), amount: 3n * 10n ** 17n, ownerCommitment: main, noteSecret: 777n };
const events: Record<number, { commitment: bigint; noteData: Hex }> = {
  0: { commitment: noteCommitment(noteBody(legacy), 0n), noteData: hex(encryptNoteData(view.publicKey, plain(legacy))) },
  4: { commitment: noteCommitment(noteBody(deposited), 4n), noteData: hex(encryptNoteData(view.publicKey, plain(deposited))) },
  8: { commitment: noteCommitment(noteBody(received), 8n), noteData: hex(encryptNoteData(view.publicKey, plain(received))) },
  12: { commitment: 0x1212n, noteData: hex(encryptNoteData(view.publicKey, plain(deposited))) },
};
const tree = new MerkleTree(TX_LEVELS);
for (const leaf of [0, 4, 8, 12]) tree.insertGroup([events[leaf].commitment, ZERO_LEAF, ZERO_LEAF, ZERO_LEAF]);

let mock: Awaited<ReturnType<typeof startMockCore>>;
const deployment = (): Deployment => ({
  chainId: 31337,
  core: CORE,
  ethVault: VAULT,
  rpcUrl: mock.url,
  rpcUrls: [mock.url, mock.url],
  fromBlock: 0n,
  erc20Vaults: [],
});
beforeAll(async () => {
  mock = await startMockCore({ core: CORE, events, nextLeafIndex: 16, root: tree.root });
});
afterAll(() => mock.close());
beforeEach(() => {
  useCoreModule(null);
  noteStore.clear();
  mock.state.spent = false;
  mock.state.spentNullifiers.clear();
});

describe("a deposited note made out to its own owner commitment", () => {
  it("is found from its self-envelope with its own owner commitment and its counter; it is no transfer received; a payload that lies is no note", async () => {
    const r = await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(noteStore.all().map((n) => [n.leafIndex, n.counter])).toEqual([
      [0, 0],
      [4, 2],
      [8, undefined],
    ]);
    expect(noteStore.all()[1].note).toEqual(deposited);
    expect(r.received.map((x) => x.leafIndex)).toEqual([8]);
    expect(noteStore.nextCounter()).toBe(3);
  });

  it("reads spent by its own key's nullifier, never the spend key's", async () => {
    const cm = noteCommitment(noteBody(deposited), 4n);
    mock.state.spentNullifiers.add(nullifier(cm, keys.spendKey)); // the spend key's nullifier of this note: never asked
    await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(noteStore.all().find((n) => n.leafIndex === 4)!.spent).toBe(false);
    mock.state.spentNullifiers.add(nullifier(cm, deriveOwnerKey(keys.spendKey, deposited.noteSecret)));
    await scanNotes({ masterSeed: seed, deployment: deployment() });
    expect(noteStore.all().find((n) => n.leafIndex === 4)!.spent).toBe(true);
    expect(noteStore.all().find((n) => n.leafIndex === 0)!.spent).toBe(false);
  });
});

describe("refund claims and the owner commitment an order committed to", () => {
  const COUNTER = 7;
  const PAYLOAD = hex(dummyNoteData());
  const note = (oc: bigint): Note => ({ vaultId: BigInt(VAULT), amount: 5n, ownerCommitment: oc, noteSecret: deriveNoteSecret(keys.noteKey, COUNTER) });
  const tx = (leaf: number): Hex => ("0x" + "33".repeat(31) + leaf.toString(16).padStart(2, "0")) as Hex;
  const ins = (leafIndex: number, oc: bigint): NoteInsertedLog => ({
    leafIndex,
    commitment: noteCommitment(noteBody(note(oc)), BigInt(leafIndex)),
    noteData: PAYLOAD,
    transactionHash: tx(leafIndex),
    blockNumber: 5n,
  });
  const dep = (leafIndex: number, oc: bigint): DepositedLog => ({ vault: VAULT, ownerCommitment: oc, amount: 5n, leafIndex, transactionHash: tx(leafIndex) });
  const own = ownOc(COUNTER);
  const logs = [ins(0, own), ins(4, main), ins(8, 0x0badn)];
  const deposits = [dep(0, own), dep(4, main), dep(8, 0x0badn)];
  const seedClaim = { orderId: "", noteData: PAYLOAD, counter: COUNTER };

  it("a claim from the seed alone accepts the note's own and the privacy address's (an order from before), nothing else", () => {
    const r = matchCommittedDeposits(keys, logs, deposits, [seedClaim]);
    expect(r.map((x) => [x.leafIndex, x.note.ownerCommitment])).toEqual([
      [0, own],
      [4, main],
    ]);
  });

  it("a journaled order's claim accepts exactly the owner commitment it committed to", () => {
    expect(matchCommittedDeposits(keys, logs, deposits, [{ ...seedClaim, ownerCommitment: own }]).map((x) => x.leafIndex)).toEqual([0]);
    expect(matchCommittedDeposits(keys, logs, deposits, [{ ...seedClaim, ownerCommitment: main }]).map((x) => x.leafIndex)).toEqual([4]);
    const s = (params: unknown, shield?: StoredSwap["shield"]) =>
      ({
        orderId: "0x01",
        attemptId: "0x01",
        refundCounter: COUNTER,
        refundNoteData: PAYLOAD,
        provider: "thorchain",
        policy: "best-privacy",
        request: {},
        params,
        endpoint: "0x",
        createdAt: 0,
        state: "funded",
        ...(shield ? { shield } : {}),
      }) as StoredSwap;
    expect(refundClaims([s({ refundOwnerCommitment: own.toString() })])[0].ownerCommitment).toBe(own);
    expect(refundClaims([s({})])[0].ownerCommitment).toBeUndefined();
    const shield = {
      factory: "0x",
      receiver: "0x",
      params: { ownerCommitment: main.toString() },
      counter: 9,
      noteData: PAYLOAD,
    } as unknown as StoredSwap["shield"];
    expect(refundClaims([s({}, shield)]).find((c) => c.kind === "shield")!.ownerCommitment).toBe(main);
  });
});
