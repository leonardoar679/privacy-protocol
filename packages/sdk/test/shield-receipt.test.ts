// A same-chain swap into the protected balance (spec v2.0 §11.2; V6 Stage 12), the wallet's side: the receipt it names as
// the destination (the receiver forge's factory would deploy for these parameters; the note derived from the seed by the
// counter; a hundred tips as the minimum), the check before signing (the journaled receiver recomputed from this wallet's
// own factory, the order's destination, this seed's note), the matcher that finds the delivered note — from the journal,
// and from the phrase alone, never confused with a refund of the same counter — and the tracker that completes the order
// on that note.
import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { predictReceiver, receiverParamsOf } from "@privacy-wallet/contracts";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { deriveRefundNote, deriveShieldNote, refundPayload, shieldPayload } from "../src/keys/swapKeys";
import { buildShieldReceipt, checkShieldReceipt, protectable, ShieldReceiptMismatch, shieldJobRequest } from "../src/shieldReceiver";
import { matchCommittedDeposits, refundClaims, seedRefundClaims } from "../src/refunds";
import { deriveState } from "../src/orderTracker";
import type { Deployment, DepositedLog, NoteInsertedLog } from "../src/chain";
import type { StoredSwap } from "../src/wallet/journal";

const seed = new Uint8Array(32).fill(7);
const keys = deriveKeys(seed);
const FACTORY = "0x00000000000000000000000000000000000000f2" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ETH_VAULT = "0x00000000000000000000000000000000000000e1" as Address;
const FALLBACK = "0x00000000000000000000000000000000000000fa" as Address;
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: ETH_VAULT,
  rpcUrl: "http://x",
  rpcUrls: ["http://x"],
  fromBlock: 0n,
  erc20Vaults: [{ symbol: "USDC", token: USDC, vault: "0x00000000000000000000000000000000000000e2", decimals: 6 }],
  shieldFactory: FACTORY,
} as Deployment;
const TIP = 2_000_000_000_000_000n;
const receipt = (counter = 11) =>
  buildShieldReceipt({
    masterSeed: seed,
    deployment,
    counter,
    asset: "native",
    shieldTip: TIP,
    fallbackRecipient: FALLBACK,
    receiptId: ("0x" + "5e".repeat(32)) as Hex,
  });
const ORDER = "0x" + "ab".repeat(32);
const swap = (extra: Partial<StoredSwap> = {}): StoredSwap => {
  const sh = receipt();
  return {
    orderId: ORDER,
    attemptId: "0x01",
    refundCounter: 10,
    provider: "thorchain",
    policy: "balanced",
    request: {
      from: { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" },
      to: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
      amount: "7900000000",
      destination: sh.receiver,
      slippageBps: 50,
      destinationType: "protected",
    },
    params: { amount: "7900000000", executeDeadline: 2_000_000_000, refundAfter: 2_000_003_600 },
    endpoint: "0x00000000000000000000000000000000000000e5",
    createdAt: 0,
    state: "executed",
    refundNoteData: refundPayload(seed, 10),
    shield: sh,
    fundedTx: "0xf00d",
    jobId: ORDER,
    ...extra,
  } as StoredSwap;
};

describe("the receipt a same-chain swap names (spec v2.0 §11.2)", () => {
  it("is the receiver the factory deploys for its parameters, with this seed's note for the counter and a hundred tips as the minimum", () => {
    const sh = receipt();
    const params = receiverParamsOf(sh.params as never);
    expect(sh.receiver).toBe(predictReceiver(FACTORY, params));
    const note = deriveShieldNote(seed, 11);
    expect(params).toMatchObject({
      asset: "0x0000000000000000000000000000000000000000",
      shieldTip: TIP,
      minAmount: TIP * 100n,
      ownerCommitment: ownerCommitmentOf(keys.spendKey),
      noteSecret: deriveNoteSecret(keys.noteKey, 11),
      noteDataHash: note.noteDataHash,
      fallbackRecipient: FALLBACK,
    });
    expect(sh.noteData).toBe(shieldPayload(seed, 11));
    expect(sh.counter).toBe(11);
  });
  it("a token receipt names the token; an asset the pool cannot hold, or a deployment without the factory, is refused", () => {
    expect(
      receiverParamsOf(
        buildShieldReceipt({ masterSeed: seed, deployment, counter: 1, asset: USDC, shieldTip: 5_000_000n, fallbackRecipient: FALLBACK }).params as never,
      ).asset,
    ).toBe(USDC);
    expect(protectable(deployment, "native")).toBe(true);
    expect(protectable(deployment, "0xdAC17F958D2ee523a2206206994597C13D831ec7")).toBe(false);
    expect(protectable({ ...deployment, shieldFactory: undefined }, "native")).toBe(false);
    expect(() =>
      buildShieldReceipt({
        masterSeed: seed,
        deployment,
        counter: 1,
        asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        shieldTip: 1n,
        fallbackRecipient: FALLBACK,
      }),
    ).toThrow(/cannot hold/);
    expect(() =>
      buildShieldReceipt({
        masterSeed: seed,
        deployment: { ...deployment, shieldFactory: undefined },
        counter: 1,
        asset: "native",
        shieldTip: 1n,
        fallbackRecipient: FALLBACK,
      }),
    ).toThrow(/VITE_SHIELD_FACTORY/);
  });
  it("a shield payload is not a refund payload: the two families never collide on a counter", () => {
    expect(shieldPayload(seed, 11)).not.toBe(refundPayload(seed, 11));
    expect(deriveShieldNote(seed, 11).noteSecret).toBe(deriveRefundNote(seed, 11).noteSecret); // the secret is the counter's: one counter, one note
    expect(shieldPayload(seed, 11).length).toBe(2 + 169 * 2);
  });
  it("the executor's job is the receipt, until the order's refundAfter", () => {
    const s = swap();
    expect(shieldJobRequest(s)).toEqual({ factory: FACTORY, params: s.shield!.params, noteData: s.shield!.noteData, deliverBy: 2_000_003_600 });
  });
});

describe("before signing: the receiver recomputed from the journal and this wallet's factory", () => {
  it("passes for the order this wallet committed", () => {
    expect(checkShieldReceipt(swap(), deployment, seed)).toBe(getAddress(receipt().receiver));
  });
  it("refuses another factory, a journaled receiver its parameters do not give, a destination that is not the receiver, a note that is not this seed's", () => {
    const s = swap();
    expect(() => checkShieldReceipt(s, { ...deployment, shieldFactory: "0x00000000000000000000000000000000000000f9" })).toThrow(ShieldReceiptMismatch);
    expect(() => checkShieldReceipt({ ...s, shield: { ...s.shield!, receiver: "0x00000000000000000000000000000000000000c7" } }, deployment)).toThrow(
      /the parameters give/,
    );
    expect(() =>
      checkShieldReceipt({ ...s, request: { ...(s.request as object), destination: "0x00000000000000000000000000000000000000c7" } }, deployment),
    ).toThrow(/the order pays/);
    expect(() => checkShieldReceipt(s, deployment, new Uint8Array(32).fill(8))).toThrow(/not this wallet's/);
  });
});

describe("the delivered note: found from the journal and from the phrase alone", () => {
  const amount = 2_278_000_000_000_000_000n;
  const note: Note = { vaultId: BigInt(ETH_VAULT), amount, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, 11) };
  const tx = ("0x" + "33".repeat(32)) as Hex;
  const logs: NoteInsertedLog[] = [
    { leafIndex: 42, commitment: noteCommitment(noteBody(note), 42n), noteData: shieldPayload(seed, 11), transactionHash: tx, blockNumber: 5n },
  ];
  const deposits: DepositedLog[] = [{ vault: ETH_VAULT, ownerCommitment: note.ownerCommitment, amount, leafIndex: 42, transactionHash: tx }];

  it("the journal's claim names the order and the kind", () => {
    const claims = refundClaims([swap()]);
    expect(claims.map((c) => c.kind)).toEqual(["refund", "shield"]);
    expect(matchCommittedDeposits(keys, logs, deposits, claims)).toEqual([
      expect.objectContaining({ orderId: ORDER, leafIndex: 42, kind: "shield", counter: 11, note }),
    ]);
  });
  it("a wallet restored from its phrase finds it among the seed's payloads, as a delivery, not a refund", () => {
    const found = matchCommittedDeposits(keys, logs, deposits, seedRefundClaims(seed, 16));
    expect(found).toEqual([expect.objectContaining({ orderId: "", leafIndex: 42, kind: "shield", counter: 11 })]);
  });
  it("an amount the vault did not deposit is not accepted", () => {
    expect(matchCommittedDeposits(keys, logs, [{ ...deposits[0], amount: amount + 1n }], refundClaims([swap()]))).toEqual([]);
  });
});

describe("the tracker: the delivered note completes the order", () => {
  const facts = {
    now: 2_000_000_100_000,
    job: { id: ORDER, escrow: "0x00000000000000000000000000000000000000e5", state: "executed", updatedAt: 0 } as never,
    escrowBalance: 0n,
    track: null,
    refundFound: false,
  };
  it("the executor shielded, the note not found yet: delivered, being added to the protected balance", () => {
    const s = swap();
    s.shield!.job = { state: "shielded", leafIndex: 42, at: 0 };
    expect(deriveState(s, facts)).toMatchObject({
      state: "DESTINATION_FINAL",
      label: "Waiting for destination",
      detail: expect.stringMatching(/adding it to your protected balance/),
    });
  });
  it("the note found: completed with the amount received, whatever the provider's tracking says", () => {
    const s = swap();
    s.shield!.leaves = [{ leafIndex: 42, vault: ETH_VAULT, amount: "2278000000000000000" }];
    const t = deriveState(s, facts);
    expect(t).toMatchObject({ state: "COMPLETED", label: "Completed", deliveredAmount: "2.278 ETH", detail: "2.278 ETH added to your protected balance." });
    expect(t.settlement, "the settlement: delivered").toBe("COMPLETED");
  });
  it("nothing shielded yet: the provider is executing", () => {
    expect(deriveState(swap(), facts).state).toBe("PROVIDER_EXECUTING");
  });
});
