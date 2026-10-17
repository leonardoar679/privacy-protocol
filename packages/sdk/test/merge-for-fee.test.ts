// Merges are planned for the fee of the spend they serve (the audit round of 2026-10-16, c33; the audit's unverified m55).
// ensureSpendable planned for the relayer's minimum alone, while the spend then pays the 1 % of what it delivers besides
// it: an amount just under a note pair's sum was never merged for, and the spend failed on two notes that could not pay
// its own fee. And Max spent the whole balance, while every merge it needs pays the minimum out of it. Offline: the
// relayer's terms are stubbed (the minimum F, and p + F for a withdrawal); the plan is the real code's, observed through
// its "merging" event.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "../src/chain";

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
    pickRelayer: async (urls: string[]) => ({
      url: urls[0],
      info: { feePercentBps: 100, privacyAddress: encodePrivacyAddress(5n, viewKeyPair(7n).publicKey) },
    }),
    // the relayer's minimum F (a merge); a withdrawal of W pays p + F, as the real terms compute it
    feeInVault: (_info: unknown, _vault: unknown, _margin?: number, delivered?: bigint) =>
      delivered === undefined ? 5_000n : feeForWithdrawal(delivered, { minimum: 5_000n, feePercentBps: 100 }),
  };
});

import { exactInput } from "@privacy-wallet/protocol/wallet/fees";
import { configure, defaultConfig } from "../src/config";
import { ensureSpendable, maxSpendable } from "../src/privateTx";
import { noteStore, type OwnedNote } from "../src/wallet/notes";
import type { EngineEvent } from "../src/operations/engineEvents";

const VAULT = "0x00000000000000000000000000000000000000e7";
const ETH = 10n ** 18n;
const F = 5_000n;
const relayed = { kind: "relayer" as const, url: "http://relayer.test" };
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as unknown as Deployment;
const note = (leafIndex: number, amount: bigint) =>
  ({ note: { vaultId: BigInt(VAULT), amount, ownerCommitment: 1n, noteSecret: 2n + BigInt(leafIndex) }, leafIndex, noteData: "0x", spent: false }) as OwnedNote;
const notes = (...amounts: bigint[]) => amounts.forEach((a, i) => noteStore.add(note(i, a)));

beforeAll(() => configure(defaultConfig({ kdfLog2N: 12 })));
beforeEach(() => noteStore.clear());

describe("merges for the spend's own fee", () => {
  it("0.995 ETH from 0.5 + 0.5 + 0.02: the pair covers the amount and the minimum but not the 1 % — a merge is planned first", async () => {
    notes(ETH / 2n, ETH / 2n, ETH / 50n);
    const events: EngineEvent["type"][] = [];
    // the merge itself is not carried out here (no chain): the plan is what is observed
    await ensureSpendable({
      masterSeed: new Uint8Array(32),
      deployment,
      needed: (ETH * 995n) / 1000n,
      vault: VAULT,
      submission: relayed,
      onEvent: (e) => events.push(e.type),
    }).catch(() => null);
    expect(events, "a merge before the spend").toContain("merging");
  });

  it("an amount the pair covers with the 1 % and the minimum: no merge", async () => {
    notes(ETH / 2n, ETH / 2n, ETH / 50n);
    const events: EngineEvent["type"][] = [];
    const merges = await ensureSpendable({
      masterSeed: new Uint8Array(32),
      deployment,
      needed: (ETH * 98n) / 100n,
      vault: VAULT,
      submission: relayed,
      onEvent: (e) => events.push(e.type),
    });
    expect(merges).toBe(0);
    expect(events).not.toContain("merging");
  });
});

describe("Max (the audit's unverified m55)", () => {
  it("is the balance less the minimum of each merge that brings the notes down to two", async () => {
    notes(ETH, ETH, ETH, ETH);
    expect(await maxSpendable(deployment, VAULT, relayed), "two merges").toBe(4n * ETH - 2n * F);
    expect(await maxSpendable(deployment, VAULT, { kind: "wallet" }), "through the connected wallet a merge pays no fee note").toBe(4n * ETH);
    noteStore.clear();
    notes(ETH, ETH);
    expect(await maxSpendable(deployment, VAULT, relayed), "two notes: no merge").toBe(2n * ETH);
  });

  it("what Max spends is merged for, never refused as more than the balance before a merge", async () => {
    notes(ETH, ETH, ETH, ETH);
    const max = await maxSpendable(deployment, VAULT, relayed);
    const send = exactInput(max, { minimum: F, feePercentBps: 100 }); // exact input: Max is what leaves
    const events: EngineEvent["type"][] = [];
    const e = await ensureSpendable({
      masterSeed: new Uint8Array(32),
      deployment,
      needed: send.delivered,
      vault: VAULT,
      submission: relayed,
      onEvent: (x) => events.push(x.type),
    }).catch((x: unknown) => x);
    expect(String(e)).not.toMatch(/insufficient/);
    expect(events, "merged down to two first").toContain("merging");
    // the whole balance is more than the merges leave: refused before any merge is paid
    const all = exactInput(4n * ETH, { minimum: F, feePercentBps: 100 });
    const before: EngineEvent["type"][] = [];
    await expect(
      ensureSpendable({
        masterSeed: new Uint8Array(32),
        deployment,
        needed: all.delivered,
        vault: VAULT,
        submission: relayed,
        onEvent: (x) => before.push(x.type),
      }),
    ).rejects.toThrow(/insufficient/);
    expect(before).not.toContain("merging");
  });
});
