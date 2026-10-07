// Plan §38 in the wallet (src/sdk/verifiedReads.ts): a tree rebuilt from RPC logs is accepted only if
// its first leaves are exactly the pool the light client proved at the latest finalized block. Offline:
// the light client and the storage prover are stubbed here (both run live in test/live/lightclient).
import { describe, it, expect, afterEach } from "vitest";
import { treeLayers } from "../src/sdk/core";
import { checkTreeAgainstProof, provenPool, resetLightClient, TreeNotProven, verifyStatus, verifyTree, POOL_SLOTS } from "../src/sdk/verifiedReads";
import type { Deployment, TreeState } from "../src/sdk/chain";
import { settings, DEFAULT_SETTINGS } from "../src/wallet/settings";
import { session } from "../src/wallet/session";
import { TX_LEVELS } from "@ref/txInputs";
import { ZERO_LEAF } from "@ref/merkle";

const leaves = (n: number) => Array.from({ length: n }, (_, i) => (i % 4 === 3 ? ZERO_LEAF : BigInt(1000 + i)));
async function tree(n: number): Promise<TreeState> { const ls = leaves(n); const layers = await treeLayers(ls, TX_LEVELS); return { leaves: ls, root: layers.root, nextLeafIndex: n, notes: n, layers }; }
const rootOf = async (n: number) => (await treeLayers(leaves(n), TX_LEVELS)).root;
const dep = (chainId: number): Deployment => ({ chainId, core: "0x00000000000000000000000000000000000000c0", ethVault: "0x00000000000000000000000000000000000000e7", rpcUrl: "http://rpc", rpcUrls: ["http://rpc"], fromBlock: 0n, erc20Vaults: [] });
const stubSync = (slot: number) => (async () => ({ finalizedSlot: slot, snapshot: () => ({ finalized: { beacon: { slot: String(slot) } }, finalizedFork: "fulu", current: { pubkeys: [], aggregate_pubkey: "0x" } }) })) as any;
const stubProver = (count: bigint, root: bigint, seen?: { slots?: string[] }) => (async (_lc: unknown, _rpc: string[], _core: string, slots: string[]) => { if (seen) seen.slots = slots; return { header: { number: 26_000_000n, hash: "0x", stateRoot: "0x", timestamp: 0n }, account: {}, values: [count, root] }; }) as any;

afterEach(() => { settings.set(DEFAULT_SETTINGS); verifyStatus.set({ kind: "idle" }); resetLightClient(); session.forget(); });

describe("the synced tree against the proven pool", () => {
  it("accepts a tree whose first leaves hash to the proven root, including one that grew since finality", async () => {
    await expect(checkTreeAgainstProof(await tree(12), { blockNumber: 1n, slot: 1, nextLeafIndex: 12, root: await rootOf(12) })).resolves.toBeUndefined();
    await expect(checkTreeAgainstProof(await tree(16), { blockNumber: 1n, slot: 1, nextLeafIndex: 12, root: await rootOf(12) })).resolves.toBeUndefined();
  });
  it("refuses a tree with fewer leaves (hidden notes) or other leaves (invented or altered notes)", async () => {
    await expect(checkTreeAgainstProof(await tree(8), { blockNumber: 7n, slot: 1, nextLeafIndex: 12, root: await rootOf(12) })).rejects.toThrow(/hiding notes/);
    const t = await tree(12);
    t.leaves[5] = 42n; t.layers = await treeLayers(t.leaves, TX_LEVELS);
    await expect(checkTreeAgainstProof(t, { blockNumber: 7n, slot: 1, nextLeafIndex: 12, root: await rootOf(12) })).rejects.toThrow(TreeNotProven);
  });
});

describe("verifyTree in the spend flows", () => {
  it("is reported off when switched off, and unavailable on a chain without a light client — neither touches the network", async () => {
    settings.set({ verifyReads: false });
    await expect(verifyTree(dep(1), await tree(4))).resolves.toEqual({ kind: "off" });
    settings.set({ verifyReads: true });
    await expect(verifyTree(dep(31337), await tree(4))).resolves.toMatchObject({ kind: "unavailable" });
    expect(verifyStatus.get().kind).toBe("unavailable");
  });
  it("on mainnet: reads slots 0 and 1, masks the uint32 leaf count, verifies, journals the light client's store", async () => {
    await session.create("a strong password");
    session.acknowledgePhrase();
    const seen: { slots?: string[] } = {};
    const t = await tree(12);
    const s = await verifyTree(dep(1), t, undefined, { sync: stubSync(15_000_000), prover: stubProver((7n << 32n) | 12n, await rootOf(12), seen) });
    expect(s).toMatchObject({ kind: "verified", leaves: 12, proof: { nextLeafIndex: 12, blockNumber: 26_000_000n } });
    expect(seen.slots).toEqual([POOL_SLOTS.nextLeafIndex, POOL_SLOTS.currentRoot]);
    expect(session.journal().lightClient).toMatchObject({ chainId: "1" });
    // a lying RPC quorum: the proven pool has a different root
    await expect(verifyTree(dep(1), t, undefined, { sync: stubSync(15_000_001), prover: stubProver(12n, 999n) })).rejects.toThrow(TreeNotProven);
  });
  it("provenPool refuses a chain it has no light client for", async () => {
    await expect(provenPool(dep(31337))).rejects.toThrow(/no light client/);
  });
});
