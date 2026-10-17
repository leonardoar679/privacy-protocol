// The relayer's fee is bounded (the audit round of 2026-10-16, c46). A Send, a withdrawal and a swap's funding read the
// relayer's terms again at submit and paid whatever fee they had become; and a relayer could ask any percentage. Now a
// spend stops before anything is proved when the fee is above the one its Review showed (FeeMoved, fee_moved: not moved),
// and a relayer asking more than the 1 % privacy fee is not used.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "../src/chain";

const relayer = vi.hoisted(() => ({ bps: 100, fee: 5_000n, picked: 0 }));
vi.mock("../src/deploymentGuard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploymentGuard")>()),
  guardDeployment: async () => undefined,
}));
vi.mock("../src/relayer", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/relayer")>();
  const { encodePrivacyAddress } = await import("@privacy-wallet/protocol/address");
  const { viewKeyPair } = await import("@privacy-wallet/protocol/envelope");
  return {
    ...real,
    pickRelayer: async (urls: string[]) => {
      relayer.picked++;
      return { url: urls[0], info: { feePercentBps: relayer.bps, privacyAddress: encodePrivacyAddress(5n, viewKeyPair(7n).publicKey) } };
    },
    feeInVault: () => relayer.fee,
  };
});

import { configure, defaultConfig } from "../src/config";
import { FeeMoved, feeTerms, privateTransfer, privateWithdrawal } from "../src/privateTx";
import { classify } from "../src/operations/errors/catalog";
import { noteStore } from "../src/wallet/notes";

const VAULT = "0x00000000000000000000000000000000000000e7";
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as unknown as Deployment;
const seed = new Uint8Array(32).fill(3);
const relayed = { kind: "relayer" as const, url: "http://relayer.test" };

beforeAll(() => configure(defaultConfig({ kdfLog2N: 12 })));
beforeEach(() => {
  relayer.bps = 100;
  relayer.fee = 5_000n;
  relayer.picked = 0;
  noteStore.clear();
});

describe("a relayer asking more than the 1 % privacy fee", () => {
  it("is not used: its terms are refused, and with no other relayer the spend cannot go privately", async () => {
    expect((await feeTerms(deployment, relayed, VAULT, []))!.fee.amount).toBe(5_000n);
    relayer.bps = 150;
    await expect(feeTerms(deployment, relayed, VAULT, [])).rejects.toThrow(/asks 150 bps, above the 1 % privacy fee/);
    relayer.bps = 10_000;
    await expect(feeTerms(deployment, relayed, VAULT, [])).rejects.toThrow(/above the 1 % privacy fee/);
  });
});

describe("the fee the Review showed bounds the spend's", () => {
  it("a withdrawal whose fee rose stops before anything is proved; at or below the Review's fee it goes on", async () => {
    relayer.fee = 7_000n;
    const moved = await privateWithdrawal({
      masterSeed: seed,
      deployment,
      amount: 10n ** 15n,
      recipient: "0x00000000000000000000000000000000000000b0",
      vault: VAULT,
      submission: relayed,
      maxFee: 5_000n,
    }).catch((e) => e);
    expect(moved).toBeInstanceOf(FeeMoved);
    expect((moved as FeeMoved).now).toBe(7_000n);
    expect(classify(moved)).toMatchObject({ code: "fee_moved", fundsClass: "not-moved", actions: ["review"] });
    // the same fee as reviewed: past the bound (this wallet holds nothing, so the next step refuses)
    const same = await privateWithdrawal({
      masterSeed: seed,
      deployment,
      amount: 10n ** 15n,
      recipient: "0x00000000000000000000000000000000000000b0",
      vault: VAULT,
      submission: relayed,
      maxFee: 7_000n,
    }).catch((e) => e);
    expect(same).not.toBeInstanceOf(FeeMoved);
  });

  it("a private transfer whose fee rose stops too", async () => {
    relayer.fee = 9_000n;
    const { encodePrivacyAddress } = await import("@privacy-wallet/protocol/address");
    const { viewKeyPair } = await import("@privacy-wallet/protocol/envelope");
    const to = encodePrivacyAddress(11n, viewKeyPair(13n).publicKey);
    const moved = await privateTransfer({
      masterSeed: seed,
      deployment,
      amount: 10n ** 15n,
      recipient: to,
      vault: VAULT,
      submission: relayed,
      maxFee: 8_999n,
    }).catch((e) => e);
    expect(moved).toBeInstanceOf(FeeMoved);
  });
});
