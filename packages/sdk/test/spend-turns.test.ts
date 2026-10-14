// One private spend at a time (a V6 follow-up of 2026-10-14): a spend's inputs are marked spent only once its transaction
// is mined, so two spends planned at once picked the same notes and the second failed on the first's nullifier. Every
// spend entry point takes its turn. The deployment check is every spend's first step: mocked here to hold the first
// spend, it shows the second waiting (and saying so), then starting once the first is over — a failed one included.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Deployment } from "../src/chain";

const guard = vi.hoisted(() => ({ calls: [] as string[], gates: [] as { resolve: () => void; reject: (e: Error) => void }[] }));
vi.mock("../src/deploymentGuard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/deploymentGuard")>()),
  guardDeployment: (d: Deployment) =>
    new Promise<void>((resolve, reject) => {
      guard.calls.push(d.core);
      guard.gates.push({ resolve, reject });
    }),
}));

import { configure, defaultConfig } from "../src/config";
import { mergeNotes, privateWithdrawal, splitNote } from "../src/privateTx";
import type { OwnedNote } from "../src/wallet/notes";

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const deployment = (core: string): Deployment =>
  ({
    chainId: 1,
    core,
    ethVault: "0x00000000000000000000000000000000000000e7",
    rpcUrl: "http://127.0.0.1:1",
    rpcUrls: ["http://127.0.0.1:1"],
    fromBlock: 0n,
    erc20Vaults: [],
  }) as unknown as Deployment;
const note = { note: { vaultId: 0xe7n, amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false } as OwnedNote;
const seed = new Uint8Array(32);

beforeAll(() => configure(defaultConfig({ kdfLog2N: 12 })));

describe("one private spend at a time", () => {
  it("a second spend waits for the first, says so, and starts once the first is over — a failed spend never blocks the next", async () => {
    const lines: string[] = [];
    const a = privateWithdrawal({ masterSeed: seed, deployment: deployment("A"), amount: 1n, recipient: "0x00000000000000000000000000000000000000b0" });
    await settle();
    const b = mergeNotes({ masterSeed: seed, deployment: deployment("B"), a: note, b: note, onStatus: (l) => lines.push(l) });
    const c = splitNote({ masterSeed: seed, deployment: deployment("C"), note, piece: 1n });
    await settle();
    expect(guard.calls, "the second and third wait their turn").toEqual(["A"]);
    expect(lines).toEqual(["Waiting for the other private operation to finish…"]);
    guard.gates[0].reject(new Error("the first spend failed"));
    await expect(a).rejects.toThrow(/the first spend failed/);
    await settle();
    expect(guard.calls).toEqual(["A", "B"]);
    guard.gates[1].reject(new Error("the second failed too"));
    await expect(b).rejects.toThrow(/the second failed too/);
    await settle();
    expect(guard.calls).toEqual(["A", "B", "C"]);
    guard.gates[2].reject(new Error("stop"));
    await expect(c).rejects.toThrow(/stop/);
  });
});
