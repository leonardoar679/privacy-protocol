// The SDK facade (doc §61; spec v2.0 §4, §8): every name of §61 is exported; nothing works before the platform configures
// the engine; with a store and a prover passed to configure(), the wallet is created, locked and unlocked, notes are made
// from the seed, a send is planned into a witness the reference builder accepts, a proof goes through the platform's
// prover, a swap's quotes come from the service, an operation's recovery comes from the catalog. No browser, no network.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MerkleTree } from "@privacy-wallet/protocol/merkle";
import { noteBody, noteCommitment, ownerCommitmentOf } from "@privacy-wallet/protocol/note";
import { deriveKeys, deriveOwnerKey } from "@privacy-wallet/protocol/keys";
import { TX_LEVELS, buildTxInputs, type CircuitInputs, type TxSpec } from "@privacy-wallet/protocol/txInputs";
import * as sdk from "../src/index";
import { configure, defaultConfig, type ProofResult } from "../src/config";
import { newOperation, putOperation, resetOperationsMemory } from "../src/operations/store";
import { placeholderNoteData } from "../src/privateTx";
import { NoteStore, noteStore } from "../src/wallet/notes";
import { memoryStorage } from "../src/wallet/storage";
import { WalletSession } from "../src/wallet/session";
import type { Deployment } from "../src/chain";
import type { SwapRequest } from "../src/swapService";

const SECTION_61 = [
  "createWallet",
  "unlockWallet",
  "lockWallet",
  "getProtectedBalance",
  "createNote",
  "prepareProtect",
  "preparePrivateSend",
  "prepareSwap",
  "prepareCrossChainSwap",
  "generateProof",
  "getOperation",
  "recoverOperation",
  "configure",
];
const PASSWORD = "correct horse battery staple";
const deployment: Deployment = {
  chainId: 31337,
  core: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ethVault: "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469",
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
};
const VAULT = BigInt(deployment.ethVault);
const store = memoryStorage();
const proofs: CircuitInputs[] = [];
// V6 Stage 15 (spec v2.0 §14.3): the platform's prover takes the spend plan and builds the circuit inputs itself
const prover = vi.fn(async (spec: TxSpec): Promise<ProofResult> => {
  proofs.push(buildTxInputs(spec));
  return { proof: "0x01", publicInputs: {} as ProofResult["publicInputs"], publicSignals: [1n], ms: 5, verifiedLocally: true };
});
const session = new WalletSession(() => store, { N: 1 << 12, r: 8, p: 1 });

describe("the facade's names (doc §61)", () => {
  it("exports every name of §61 as a function", () => {
    for (const name of SECTION_61) expect(typeof (sdk as Record<string, unknown>)[name], name).toBe("function");
  });
  it("nothing works before configure(): the store is the platform's", async () => {
    await expect(sdk.createWallet(PASSWORD, new WalletSession())).rejects.toThrow(/not configured/);
  });
});

describe("over a configured engine", () => {
  beforeAll(() => configure(defaultConfig({ storage: () => store, prover, kdfLog2N: 12, deployment })));
  afterAll(() => {
    session.forget();
    resetOperationsMemory();
  });

  it("creates the wallet (a 24-word phrase, the keystore in the platform's store), locks it, unlocks it only with the password", async () => {
    const phrase = await sdk.createWallet(PASSWORD, session);
    expect(phrase.split(" ")).toHaveLength(24);
    expect(store.get("pp.keystore")).toContain('"v"');
    expect(session.isUnlocked()).toBe(true);
    sdk.lockWallet(session);
    expect(session.isUnlocked()).toBe(false);
    expect(() => sdk.createNote({ vault: VAULT, amount: 1n }, session)).toThrow(/locked/);
    expect(await sdk.unlockWallet("wrong password", session)).toBe(false);
    expect(await sdk.unlockWallet(PASSWORD, session)).toBe(true);
  });

  it("makes notes from the seed: each made out to its own owner commitment (audit c18), the next counter each time, a payload of its own", () => {
    const seed = session.state().seed!;
    const a = sdk.createNote({ vault: VAULT, amount: 5n }, session);
    const b = sdk.createNote({ vault: deployment.ethVault, amount: 7n }, session);
    const k = deriveKeys(seed);
    expect(a.note).toMatchObject({ vaultId: VAULT, amount: 5n, ownerCommitment: ownerCommitmentOf(deriveOwnerKey(k.spendKey, a.note.noteSecret)) });
    expect(a.note.ownerCommitment).not.toBe(ownerCommitmentOf(k.spendKey));
    expect(b.note.ownerCommitment).not.toBe(a.note.ownerCommitment);
    expect(b.counter).toBe(a.counter + 1);
    expect(b.note.noteSecret).not.toBe(a.note.noteSecret);
    expect(a.noteData).not.toBe(b.noteData);
  });

  it("prepares a Protect: the deposit of the amount into the vault, its note the wallet's", () => {
    const p = sdk.prepareProtect({ deployment, amount: 10n ** 18n }, session);
    expect(p.vault).toBe(deployment.ethVault);
    expect(p.deposit.to).toBe(deployment.ethVault);
    expect(p.deposit.value).toBe(10n ** 18n);
    expect(p.note.amount).toBe(10n ** 18n);
    expect(p.approve).toBeUndefined();
  });

  it("reads the protected balance from the unspent notes of a vault", () => {
    const notes = new NoteStore();
    const own = sdk.createNote({ vault: VAULT, amount: 3n }, session);
    notes.add({ note: own.note, leafIndex: 0, noteData: own.noteData, spent: false, label: "shield" });
    notes.add({ note: { ...own.note, amount: 4n }, leafIndex: 1, noteData: own.noteData, spent: false, label: "shield" });
    notes.add({ note: { ...own.note, amount: 100n }, leafIndex: 2, noteData: own.noteData, spent: true, label: "shield" });
    expect(sdk.getProtectedBalance(VAULT, notes)).toBe(7n);
    expect(sdk.getProtectedBalance(deployment.ethVault, notes)).toBe(7n);
    expect(sdk.getProtectedBalance(1n, notes)).toBe(0n);
  });

  it("plans a private send over the tree: the recipient's withdrawal and the change, a witness the reference builder accepts", async () => {
    noteStore.markSpent(noteStore.all().map((n) => n.leafIndex));
    const own = sdk.createNote({ vault: VAULT, amount: 10n ** 18n }, session);
    const tree = new MerkleTree(TX_LEVELS);
    tree.insertLeaf(noteCommitment(noteBody(own.note), 0n));
    noteStore.add({ note: own.note, leafIndex: 0, noteData: placeholderNoteData(), spent: false, label: "shield" });
    const plan = sdk.preparePrivateSend(
      { deployment, tree: tree.leaves, amount: 4n * 10n ** 17n, recipient: "0x000000000000000000000000000000000000b0b0" },
      session,
    );
    expect(plan.spec.withdrawal).toEqual({ vault: VAULT, amount: 4n * 10n ** 17n, recipient: 0xb0b0n });
    expect(plan.change?.note.amount).toBe(6n * 10n ** 17n);
    const proof = await sdk.generateProof(plan.spec);
    expect(prover).toHaveBeenCalledTimes(1);
    expect(proofs[0], "the prover built the witness the reference builder makes").toEqual(buildTxInputs(plan.spec));
    expect(proof.verifiedLocally).toBe(true);
  });

  it("asks the swap service for quotes, same-chain and cross-chain each through its own name", async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ quotes: [], scores: [], errors: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const eth = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
      const usdc = { chain: "ethereum", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, symbol: "USDC" };
      const btc = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };
      const req = (to: SwapRequest["to"]): SwapRequest => ({ from: eth, to, amount: "1000", destination: "dest", slippageBps: 50 });
      expect(await sdk.prepareSwap(req(usdc))).toEqual({ quotes: [], scores: [], errors: {} });
      expect(await sdk.prepareCrossChainSwap(req(btc))).toEqual({ quotes: [], scores: [], errors: {} });
      await expect(sdk.prepareSwap(req(btc))).rejects.toThrow(/another chain/);
      await expect(sdk.prepareCrossChainSwap(req(usdc))).rejects.toThrow(/one chain/);
      expect(calls, "V6: the API's /v1 quotes route").toEqual(["http://127.0.0.1:8787/v1/quotes", "http://127.0.0.1:8787/v1/quotes"]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("reads an operation and its recovery from the catalog; an unknown id is null", () => {
    const rec = newOperation({
      kind: "swap",
      amounts: { asset: "ETH", decimals: 18, input: "1000" },
      destination: { kind: "entered", display: "bc1q…", chain: "bitcoin" },
      tier: "standard",
      refs: { orderId: "0x01" },
      state: "SOURCE_CONFIRMING",
    });
    putOperation({ ...rec, state: "RECOVERY_REQUIRED", reason: { code: "minimum_moved", fundsClass: "still-protected" } }, session);
    expect(sdk.getOperation(rec.id, session)?.state).toBe("RECOVERY_REQUIRED");
    const r = sdk.recoverOperation(rec.id, session)!;
    expect(r.record.id).toBe(rec.id);
    expect(r).toMatchObject({ code: "minimum_moved", fundsClass: "still-protected" });
    expect(r.actions).toEqual(expect.arrayContaining(["new-quote", "start-refund"]));
    expect(sdk.recoverOperation("nothing", session)).toBeNull();
    expect(sdk.getOperation("nothing", session)).toBeNull();
  });
});
