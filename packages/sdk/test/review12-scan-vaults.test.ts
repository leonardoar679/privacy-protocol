// The twelfth review round's fifth critique (XE), on the scan's wiring of the fourth's fix: the scan and recoverSwapRefunds pass their deployment to
// journalRefunds, so an order closed as a provider failure before the hand-over journaled its refund tokens' vaults has them derived where its record
// is synced again, and its refund back in USDC at the floor makes it a refund (XD's minor). Run on the loopback pool, as review10-chain.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAddress, type Hex } from "viem";
import { MerkleTree, ZERO_LEAF } from "@privacy-wallet/protocol/merkle";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, type Note } from "@privacy-wallet/protocol/note";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { useCoreModule } from "../src/core";
import { scanNotes, recoverSwapRefunds } from "../src/privateTx";
import { noteStore } from "../src/wallet/notes";
import { depositOwnerCommitment } from "../src/keys/ownerKeys";
import { refundPayload } from "../src/keys/swapKeys";
import type { Deployment } from "../src/chain";
import type { StoredSwap } from "../src/wallet/journal";
import { getOperation, resetOperationsMemory } from "../src/operations/store";
import { swapRecordId, syncSwapRecord } from "../src/operations/swapRecords";
import { startPool, type Insert } from "./helpers/mockPool";

const lc = vi.hoisted(() => ({ proven: 8 }));
vi.mock("../src/verifiedReads", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  verifyTree: async () => ({ kind: "verified", proof: { blockNumber: 100n, slot: 1, nextLeafIndex: lc.proven, root: 0n }, leaves: lc.proven }),
  provenSpent: async (_d: unknown, nfs: bigint[]) => (nfs.length ? { blockNumber: 100n, blocks: nfs.map(() => 100n), spent: nfs.map(() => false) } : null),
}));

const CORE = getAddress("0x5991a2df15a8f6a256d3ec51e99254cd3fb576a9");
const VAULT = getAddress("0x36ffa23fd38ae93e2b01aa5fa1570845ada89469");
const USDC_VAULT = getAddress("0x00000000000000000000000000000000000000c5");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const rootOf = (leaves: Map<number, bigint>, next: number) => {
  const t = new MerkleTree(TX_LEVELS);
  for (let g = 0; g < next; g += 4) t.insertGroup([0, 1, 2, 3].map((k) => leaves.get(g + k) ?? ZERO_LEAF));
  return t.root;
};
let pool: Awaited<ReturnType<typeof startPool>>;
const d = (): Deployment =>
  ({
    chainId: 1,
    core: CORE,
    ethVault: VAULT,
    rpcUrl: pool.url,
    rpcUrls: [pool.url],
    fromBlock: 0n,
    erc20Vaults: [{ symbol: "USDC", decimals: 6, token: USDC, vault: USDC_VAULT }],
  }) as Deployment;
function serve(inserts: Insert[], next: number) {
  pool.state.inserts = inserts;
  pool.state.next = next;
  pool.state.root = rootOf(new Map(inserts.map((i) => [i.leafIndex, i.commitment])), next);
}

describe("the scan derives an old journal's refund vaults where it re-syncs a closed order's record", () => {
  beforeAll(async () => {
    const store = memoryStorage();
    configure(defaultConfig({ kdfLog2N: 12, storage: () => store }));
    await session.create("a strong password", undefined, { replace: true });
    session.acknowledgePhrase();
    pool = await startPool({ core: CORE, inserts: [], next: 0, root: rootOf(new Map(), 0) });
  });
  afterAll(async () => {
    await pool.close();
  });

  for (const via of ["scanNotes", "recoverSwapRefunds"] as const) {
    it(`${via}: a provider failure closed before the hand-over kept its vaults, its refund back in USDC at the floor: the scan makes its record REFUNDED`, async () => {
      useCoreModule(null);
      noteStore.load({ notes: [], noteCounter: 0 });
      resetOperationsMemory();
      lc.proven = 8;
      pool.state.spends = [];
      pool.state.block = 0x80n;
      const seed = session.state().seed!;
      const keys = deriveKeys(seed);
      const counter = 5;
      const secret = deriveNoteSecret(keys.noteKey, counter);
      const oc = depositOwnerCommitment(keys, secret);
      const payload = refundPayload(seed, counter);
      const amount = 1_980_000_000n; // 1,980 USDC
      const note: Note = { vaultId: BigInt(USDC_VAULT), amount, ownerCommitment: oc, noteSecret: secret };
      const ins = (leaf: number): Insert => ({ leafIndex: leaf, commitment: noteCommitment(noteBody(note), BigInt(leaf)), noteData: payload });
      const orderId = "0x" + "01".repeat(32);
      const order = {
        orderId,
        refundCounter: counter,
        refundNoteData: payload,
        provider: "mayan",
        state: "completed",
        executionTx: "0x" + "ee".repeat(32),
        jobId: "job-1",
        fundedTx: "0x" + "fa".repeat(32),
        refundTokens: [USDC],
        refundFloors: { [USDC.toLowerCase()]: "1000000" },
        track: { state: "PROVIDER_FAILED", label: "Needs attention", at: Date.now() },
        request: { from: { chain: "ethereum", symbol: "ETH", decimals: 18 }, to: { chain: "solana", symbol: "SOL", decimals: 9 } },
        params: { refundOwnerCommitment: oc.toString(), amount: (10n ** 18n).toString(), refundVault: VAULT },
      } as unknown as StoredSwap;
      session.update((j) => {
        j.swaps = [order];
        j.notes = [];
        j.operations = [];
        j.schedule = [];
      });
      syncSwapRecord(session.journal().swaps[0], null, null, Date.now(), session);
      expect(getOperation(swapRecordId(orderId))?.state, "before the scan: the provider failure").toBe("RECOVERY_REQUIRED");
      serve([{ leafIndex: 0, commitment: 11n, noteData: ("0x" + "11".repeat(169)) as Hex }, ins(1)], 4);
      pool.state.deposits = [{ vault: USDC_VAULT, ownerCommitment: oc, amount, leafIndex: 1 }];
      if (via === "scanNotes") await scanNotes({ masterSeed: seed, deployment: d() });
      else await recoverSwapRefunds({ masterSeed: seed, deployment: d() });
      const after = session.journal().swaps[0];
      expect(after.refunds?.map((r) => r.vault.toLowerCase())).toEqual([USDC_VAULT.toLowerCase()]);
      expect(after.refundVaults, "derived by the scan from its deployment").toEqual({ [USDC_VAULT.toLowerCase()]: "1000000" });
      expect(getOperation(swapRecordId(orderId))?.state, "the refund in USDC makes it a refund").toBe("REFUNDED");
    });
  }
});
