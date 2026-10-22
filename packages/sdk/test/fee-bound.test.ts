// The relayer's fee is bounded (the audit round of 2026-10-16, c46). A Send, a withdrawal and a swap's funding read the
// relayer's terms again at submit and paid whatever fee they had become; and a relayer could ask any percentage. Now a
// spend stops before anything is proved when the fee is above the one its Review showed (FeeMoved, fee_moved: not moved),
// and a relayer asking more than the 1 % privacy fee is not used.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "../src/chain";

const relayer = vi.hoisted(() => ({ bps: 100, fee: 5_000n, picked: 0, bare: null as bigint | null }));
vi.mock("../src/deploymentGuard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploymentGuard")>()),
  guardDeployment: async () => undefined,
}));
vi.mock("../src/relayer", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/relayer")>();
  const { encodePrivacyAddress } = await import("@privacy-wallet/protocol/address");
  const { viewKeyPair } = await import("@privacy-wallet/protocol/envelope");
  const { feeForWithdrawal } = await import("@privacy-wallet/protocol/wallet/fees");
  return {
    ...real,
    pickRelayer: async (urls: string[]) => {
      relayer.picked++;
      return { url: urls[0], info: { feePercentBps: relayer.bps, privacyAddress: encodePrivacyAddress(5n, viewKeyPair(7n).publicKey) } };
    },
    // the fixed fee of the first cases; with `bare` set, the relayer's live minimum with this wallet's margin and its percentage
    // of a withdrawal, as feeInVault computes them (audit round 2, r09)
    feeInVault: (_info: unknown, _vault: unknown, marginBps = 1000, delivered?: bigint) => {
      if (relayer.bare === null) return relayer.fee;
      const minimum = (relayer.bare * BigInt(10_000 + marginBps)) / 10_000n;
      return delivered === undefined ? minimum : feeForWithdrawal(delivered, { minimum, feePercentBps: relayer.bps });
    },
  };
});

import { configure, defaultConfig } from "../src/config";
import { FeeMoved, feeTerms, feeWithinReview, privateTransfer, privateWithdrawal } from "../src/privateTx";
import { feeForWithdrawal, feeMeetsTerms } from "@privacy-wallet/protocol/wallet/fees";
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
  relayer.bare = null;
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

  it("feeWithinReview: the fresh fee when it is no more than the Review's; above it, the Review's own while it meets the relayer's live rule; FeeMoved past that (audit round 2, r09)", () => {
    const W = 10n ** 18n;
    const reviewed = feeForWithdrawal(W, { minimum: 1_100n, feePercentBps: 100 }); // the Review: the minimum 1,000 and this wallet's 10 % margin
    const live = (minimum: bigint) => ({ minimum, feePercentBps: 100 });
    expect(feeWithinReview(reviewed - 1n, reviewed, live(1_000n), W), "a lower fresh fee is paid").toBe(reviewed - 1n);
    const fresh = feeForWithdrawal(W, { minimum: 1_155n, feePercentBps: 100 }); // the gas price 5 % up since the Review
    expect(fresh > reviewed).toBe(true);
    expect(feeMeetsTerms(W, reviewed, 100, 1_050n).ok).toBe(true);
    expect(feeWithinReview(fresh, reviewed, live(1_050n), W), "the Review's own: it still meets the relayer's rule").toBe(reviewed);
    const past = feeForWithdrawal(W, { minimum: 1_320n, feePercentBps: 100 }); // 20 % up: past the margin
    expect(() => feeWithinReview(past, reviewed, live(1_200n), W)).toThrow(FeeMoved);
    expect(feeWithinReview(past, undefined, live(1_200n), W), "no Review to bound it").toBe(past);
  });

  it("a withdrawal whose relayer re-priced its minimum 5 % up since the Review goes on at the Review's fee; 20 % up, it stops (audit round 2, r09)", async () => {
    const W = 10n ** 15n;
    const reviewed = feeForWithdrawal(W, { minimum: 1_100n, feePercentBps: 100 }); // read at the Review: the minimum 1,000 with the margin
    const withdraw = () =>
      privateWithdrawal({
        masterSeed: seed,
        deployment,
        amount: W,
        recipient: "0x00000000000000000000000000000000000000b0",
        vault: VAULT,
        submission: relayed,
        maxFee: reviewed,
      }).catch((e) => e);
    relayer.bare = 1_050n; // a gas uptick: on 433c364 any rise stopped the spend
    expect(await withdraw(), "the wallet's margin is for this move (this wallet holds nothing, so the next step refuses)").not.toBeInstanceOf(FeeMoved);
    relayer.bare = 1_200n;
    expect(await withdraw()).toBeInstanceOf(FeeMoved);
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
