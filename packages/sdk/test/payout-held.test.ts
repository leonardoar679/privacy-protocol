// A public exit whose payout its recipient refuses (audit round 2, r42; a contract that takes no ETH, a token's blacklisted
// holder): the vault's release never reverts, it books the amount as that address's claim (WithdrawalClaimCreated). The
// wallet read only the core's events, so the Send completed "Sent" while nothing arrived. Now the receipt's claim for the
// withdrawal's own recipient ends it as PayoutHeld (payout_held: recovery, not "sent"); the notes are spent all the same.
// Offline: the chain, the tree check and the prover are stubs; the plan, the receipt reading and the catalog are the real code's.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { Deployment, TreeState } from "../src/chain";
import type { PublicInputs } from "@privacy-wallet/protocol/prover";

const HASH = ("0x" + "6b".repeat(32)) as Hex;
const RECIPIENT = "0x00000000000000000000000000000000000000d1" as Address;
const VAULT = "0x00000000000000000000000000000000000000E7" as Address;
const w = vi.hoisted(() => ({ tree: null as unknown, spec: null as unknown, claims: [] as { vault: string; recipient: string; amount: bigint }[] }));
vi.mock("../src/deploymentGuard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploymentGuard")>()),
  guardDeployment: async () => undefined,
}));
vi.mock("../src/verifiedReads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/verifiedReads")>()),
  verifyTree: async () => undefined,
}));
vi.mock("../src/chain", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/chain")>();
  const { noteBody, noteCommitment } = await import("@privacy-wallet/protocol/note");
  return {
    ...real,
    syncTreeQuorum: async () => w.tree,
    sendViaInjectedWallet: async () => HASH,
    // the receipt: the outputs at the next leaves, the spend's nullifiers, and what the vault did with the payout
    minedTx: async () => {
      const outputs = (w.spec as { outputs: Parameters<typeof noteBody>[0][] }).outputs;
      return {
        inserted: outputs.map((n, i) => ({ leafIndex: 2 + i, commitment: noteCommitment(noteBody(n), BigInt(2 + i)) })),
        costWei: 1n,
        spends: [[N0, N1]],
        claims: w.claims,
      };
    },
  };
});

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { noteStore, type OwnedNote } from "../src/wallet/notes";
import { PayoutHeld, privateWithdrawal } from "../src/privateTx";
import { classify } from "../src/operations/errors/catalog";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { MerkleLayers } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { mainOwnerCommitment } from "../src/keys/ownerKeys";

const N0 = 2_001n;
const N1 = 2_002n;
const ZERO_INPUTS = Object.fromEntries(
  [
    "root",
    "nullifier0",
    "nullifier1",
    "outputBody0",
    "outputBody1",
    "outputBody2",
    "mode",
    "withdrawalVault",
    "withdrawalAmount",
    "withdrawalRecipient",
    "noteData0Hash",
    "noteData1Hash",
    "noteData2Hash",
    "txDomain",
  ].map((k) => [k, 0n]),
) as unknown as PublicInputs;
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as unknown as Deployment;
const seed = new Uint8Array(32).fill(5);
const store = memoryStorage();

beforeAll(async () => {
  configure(
    defaultConfig({
      storage: () => store,
      kdfLog2N: 12,
      prover: async (spec) => {
        w.spec = spec;
        return {
          proof: ("0x" + "00".repeat(256)) as Hex,
          publicInputs: { ...ZERO_INPUTS, nullifier0: N0, nullifier1: N1 },
          publicSignals: [],
          ms: 1,
          verifiedLocally: false,
        };
      },
    }),
  );
  await session.create("a strong password");
  session.acknowledgePhrase();
});

function twoNotes(): void {
  const oc = mainOwnerCommitment(deriveKeys(seed));
  const notes = [0, 1].map(
    (leafIndex) =>
      ({
        note: { vaultId: BigInt(VAULT), amount: 10n ** 18n, ownerCommitment: oc, noteSecret: 11n + BigInt(leafIndex) },
        leafIndex,
        noteData: "0x",
        spent: false,
      }) as OwnedNote,
  );
  const leaves = notes.map((n) => noteCommitment(noteBody(n.note), BigInt(n.leafIndex)));
  w.tree = { leaves, root: 0n, nextLeafIndex: 2, notes: 2, layers: MerkleLayers.build(leaves, TX_LEVELS) } satisfies TreeState;
  for (const n of notes) noteStore.add(n);
}
beforeEach(() => {
  noteStore.clear();
  w.claims = [];
});

describe("a payout its recipient refused (audit round 2, r42)", () => {
  it("is held by the vault as the recipient's claim: never 'sent' — PayoutHeld, a recovery — and the notes are spent", async () => {
    twoNotes();
    w.claims = [{ vault: VAULT, recipient: RECIPIENT, amount: 10n ** 18n }];
    const e = await privateWithdrawal({ masterSeed: seed, deployment, amount: 10n ** 18n, recipient: RECIPIENT, submission: { kind: "wallet" } }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(PayoutHeld);
    expect(e).toMatchObject({ recipient: RECIPIENT, amount: 10n ** 18n, txHash: HASH });
    expect(classify(e)).toMatchObject({ code: "payout_held", fundsClass: "unknown" });
    // the spend is recorded all the same: the note that paid the withdrawal is spent on chain
    expect(
      noteStore.all().filter((n) => n.spent),
      "the note it spent",
    ).toHaveLength(1);
    expect(noteStore.balance(BigInt(VAULT))).toBe(10n ** 18n);
  });
  it("a claim of another vault or for another address is not this payout: the withdrawal is sent", async () => {
    twoNotes();
    w.claims = [
      { vault: "0x00000000000000000000000000000000000000e8", recipient: RECIPIENT, amount: 1n },
      { vault: VAULT, recipient: "0x00000000000000000000000000000000000000d2", amount: 1n },
    ];
    const r = await privateWithdrawal({ masterSeed: seed, deployment, amount: 10n ** 18n, recipient: RECIPIENT, submission: { kind: "wallet" } });
    expect(r.txHash).toBe(HASH);
  });
});
