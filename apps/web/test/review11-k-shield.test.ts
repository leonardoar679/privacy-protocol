// The eleventh review round (2026-11-04), slice 2a after its diff critique (T10) — A11-2: a Protect's deposit is recorded in the opening its
// prompt was made in (PreparedShield.epoch, set by prepareShield), never in the one open when trackShieldCost is called. A lock and a REPLACE
// with another phrase while the connected wallet asked for the deposit had put wallet A's note into wallet B's store and journal for good. The
// eighth round's lock test (review8-protect-lock) locks after the wait began, which passes either way; these lock and REPLACE before it, on
// that test's mock core.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from "viem";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";
import { configure, defaultConfig } from "@privacy-wallet/sdk/config";
import { JOURNAL_KEY, memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { decryptJournal, journalKey, type EncryptedJournal } from "@privacy-wallet/sdk/wallet/journal";
import { prepareShield, submitShield, trackShieldCost, type PreparedShield } from "@privacy-wallet/sdk/privateTx";
import { coreAbi } from "@privacy-wallet/sdk/privacyProtocol";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { startMockCore } from "./helpers/mockRpc";

type MockCore = Awaited<ReturnType<typeof startMockCore>>;

const store = memoryStorage();
const CORE = "0x00000000000000000000000000000000000000c0" as Address;
const ETH_VAULT = "0x00000000000000000000000000000000000000e7" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const HASH = ("0x" + "ab".repeat(32)) as Hex;
const HASH_B = ("0x" + "cd".repeat(32)) as Hex;
const AMOUNT = 10n ** 17n;
const seedA = sha256(utf8ToBytes("review11-k-shield wallet A"));
const seedB = sha256(utf8ToBytes("review11-k-shield wallet B"));
// trackShieldCost's outcome when the opening is gone before any receipt was read: sent, never "not moved"
const LOCKED_AFTER_SEND = {
  code: "locked_after_send",
  message: "the wallet was locked before the deposit was recorded; it is sent, and the next scan records its note",
};

const deploymentAt = (url: string): Deployment => ({
  chainId: 31337,
  core: CORE,
  ethVault: ETH_VAULT,
  rpcUrl: url,
  rpcUrls: [url],
  fromBlock: 0n,
  erc20Vaults: [],
});

/** A wallet opened in this tab over the one it holds (the typed REPLACE), its phrase acknowledged. */
async function openWallet(password: string, seed: Uint8Array): Promise<void> {
  await session.create(password, seed, { replace: true });
  session.acknowledgePhrase();
}

/** Wallet A opened and its Protect prepared (a note counter spent); the deposit mined, the endpoint serving its receipt with A's note at leaf 0. */
async function protectPreparedInA(rpc: MockCore): Promise<PreparedShield> {
  await openWallet("password of A", seedA);
  const p = prepareShield({ masterSeed: session.state().seed!, deployment: deploymentAt(rpc.url), amount: AMOUNT });
  rpc.mine(HASH, [{ leafIndex: 0, commitment: noteCommitment(noteBody(p.note), 0n), noteData: p.noteData }], 1n);
  return p;
}

/** While the connected wallet asks for the deposit: the wallet is locked, and another phrase replaces wallet A in this tab. */
async function lockAndReplaceWithB(): Promise<void> {
  session.lock();
  await openWallet("password of B", seedB);
}

/** The deposit's receipt as the connected wallet's own provider gives it: mined, the core's NoteInserted of the note at `leafIndex` (A's at 0). */
function receiptOf(p: PreparedShield, leafIndex = 0, hash: Hex = HASH) {
  const at = { blockNumber: "0x5", blockHash: "0x" + "22".repeat(32), transactionHash: hash, transactionIndex: "0x0" };
  const log = {
    ...at,
    address: CORE,
    topics: encodeEventTopics({ abi: coreAbi, eventName: "NoteInserted", args: { leafIndex } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [noteCommitment(noteBody(p.note), BigInt(leafIndex)), p.noteData]),
    logIndex: "0x0",
    removed: false,
  };
  return {
    ...at,
    from: ACCOUNT,
    to: ETH_VAULT,
    contractAddress: null,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    status: "0x1",
    type: "0x2",
    logsBloom: "0x" + "00".repeat(256),
    logs: [log],
  };
}

/** The connected wallet's provider, on the deployment's chain with the deposit's receipt in hand; `whilePrompted` runs while it shows the deposit prompt. Returns every method it is asked. */
function connectedWallet(receipt: unknown, whilePrompted?: () => Promise<void>): string[] {
  const asked: string[] = [];
  setActiveProvider({
    request: async ({ method }: { method: string }) => {
      asked.push(method);
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [ACCOUNT];
      if (method === "eth_sendTransaction") {
        await whilePrompted?.();
        return HASH;
      }
      return method === "eth_getTransactionReceipt" ? receipt : null;
    },
  } as never);
  return asked;
}

beforeAll(() => {
  // review8-protect-lock's harness; no deployment check before the Protect, as test/setup.ts's testConfig
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12, deploymentCheck: false }));
});
afterEach(() => setActiveProvider(null));

describe("A11-2: a lock and a REPLACE between prepareShield and trackShieldCost (while the deposit is prompted)", () => {
  it("without a connected provider: locked_after_send before any endpoint is asked for the receipt; B's store, journal and stored journal hold none of A's note; B's own deposit is left to the scan without a provider, and recorded in B alone from its wallet's receipt", async () => {
    const rpc = await startMockCore({ core: CORE, events: {}, nextLeafIndex: 0, root: 0n });
    try {
      const p = await protectPreparedInA(rpc);
      await lockAndReplaceWithB();
      expect(session.epoch(), "B's opening: A's lock and B's open since the prompt was made").toBe(p.epoch! + 2);
      expect(noteStore.isClosed(), "B's store is open: a lock's closed store (NF-2) is not what keeps A's note out").toBe(false);
      await expect(trackShieldCost(p, HASH)).rejects.toMatchObject(LOCKED_AFTER_SEND);
      expect(rpc.state.methods, "no receipt read at the privacy endpoint").toEqual([]);
      expect(noteStore.all(), "nothing of A's in B's store").toEqual([]);
      expect(session.journal().notes, "nothing of A's in B's journal").toEqual([]);
      const stored = decryptJournal(journalKey(seedB), JSON.parse(store.get(JOURNAL_KEY)!) as EncryptedJournal);
      expect(stored?.notes, "nor in the journal B stored (what its backups carry)").toEqual([]);
      // B's own deposit, prepared and tracked in B's opening, is recorded in B — and is all B holds
      const pB = prepareShield({ masterSeed: session.state().seed!, deployment: deploymentAt(rpc.url), amount: AMOUNT });
      rpc.mine(HASH_B, [{ leafIndex: 4, commitment: noteCommitment(noteBody(pB.note), 4n), noteData: pB.noteData }], 2n);
      // without a provider the endpoints are not asked for its receipt either (the eleventh review round, F11-10): the scan records it
      await expect(trackShieldCost(pB, HASH_B)).rejects.toMatchObject({ code: "deposit_unconfirmed" });
      expect(rpc.state.methods, "no receipt read at the privacy endpoint").toEqual([]);
      connectedWallet(receiptOf(pB, 4, HASH_B));
      expect(await trackShieldCost(pB, HASH_B)).toEqual({ leafIndex: 4, costWei: 21_000n });
      expect(noteStore.all().map((n) => ({ leafIndex: n.leafIndex, txHash: n.txHash, noteSecret: n.note.noteSecret }))).toEqual([
        { leafIndex: 4, txHash: HASH_B, noteSecret: pB.note.noteSecret },
      ]);
      expect(session.journal().notes.map((n) => ({ leafIndex: n.leafIndex, txHash: n.txHash, noteSecret: n.noteSecret }))).toEqual([
        { leafIndex: 4, txHash: HASH_B, noteSecret: pB.note.noteSecret.toString() },
      ]);
    } finally {
      await rpc.close();
    }
  });

  it("with the connected wallet's own provider holding the receipt: it is asked nothing for an opening that is gone, the flow ends locked_after_send, and B's store and journal hold none of A's note", async () => {
    const rpc = await startMockCore({ core: CORE, events: {}, nextLeafIndex: 0, root: 0n });
    try {
      const p = await protectPreparedInA(rpc);
      const asked = connectedWallet(receiptOf(p));
      await lockAndReplaceWithB();
      await expect(trackShieldCost(p, HASH)).rejects.toMatchObject(LOCKED_AFTER_SEND);
      expect(asked, "the connected wallet is not asked for the receipt of A's opening").toEqual([]);
      expect(rpc.state.methods, "nor the privacy endpoint (the receipt's `from` is the public address, A4)").toEqual([]);
      expect(noteStore.all(), "nothing of A's in B's store").toEqual([]);
      expect(session.journal().notes, "nothing of A's in B's journal").toEqual([]);
    } finally {
      await rpc.close();
    }
  });

  it("through submitShield, the REPLACE made while the connected wallet shows the deposit prompt: nothing is asked after the deposit, the Protect ends locked_after_send, and B has neither A's note nor a Protect line in its Activity", async () => {
    const rpc = await startMockCore({ core: CORE, events: {}, nextLeafIndex: 0, root: 0n });
    try {
      const p = await protectPreparedInA(rpc);
      // the user locks and restores another phrase over wallet A while the deposit prompt is open; the wallet then sends the deposit
      const asked = connectedWallet(receiptOf(p), lockAndReplaceWithB);
      await expect(submitShield(p)).rejects.toMatchObject(LOCKED_AFTER_SEND);
      expect(session.epoch(), "B's opening").toBe(p.epoch! + 2);
      expect(asked.slice(asked.indexOf("eth_sendTransaction")), "the deposit sent once, nothing asked of the connected wallet after it").toEqual([
        "eth_sendTransaction",
      ]);
      expect(rpc.state.methods, "nor of the privacy endpoint").toEqual([]);
      expect(noteStore.all(), "nothing of A's in B's store").toEqual([]);
      expect(session.journal().notes, "nothing of A's in B's journal").toEqual([]);
      expect(session.journal().activity ?? [], "no Protect line of A's in B's Activity").toEqual([]);
    } finally {
      await rpc.close();
    }
  });
});
