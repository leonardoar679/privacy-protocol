// Plan §38 in the wallet (packages/sdk/src/verifiedReads.ts): a tree rebuilt from RPC logs is accepted only if
// its first leaves are exactly the pool the light client proved at the latest finalized block. Offline:
// the light client and the storage prover are stubbed here (both run live in test/live/lightclient).
import { describe, it, expect, afterEach } from "vitest";
import { treeLayers } from "@privacy-wallet/sdk/core";
import { checkTreeAgainstProof, nullifierSlot, provenPool, provenSpent, resetLightClient, TreeNotProven, verifyStatus, verifyTree, POOL_SLOTS } from "@privacy-wallet/sdk/verifiedReads";
import { encodeAbiParameters, keccak256 } from "viem";
import type { Deployment, TreeState } from "@privacy-wallet/sdk/chain";
import { settings, defaultSettings } from "@privacy-wallet/sdk/wallet/settings";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { TX_LEVELS } from "@privacy-wallet/protocol/txInputs";
import { ZERO_LEAF } from "@privacy-wallet/protocol/merkle";

const leaves = (n: number) => Array.from({ length: n }, (_, i) => (i % 4 === 3 ? ZERO_LEAF : BigInt(1000 + i)));
async function tree(n: number): Promise<TreeState> { const ls = leaves(n); const layers = await treeLayers(ls, TX_LEVELS); return { leaves: ls, root: layers.root, nextLeafIndex: n, notes: n, layers }; }
const rootOf = async (n: number) => (await treeLayers(leaves(n), TX_LEVELS)).root;
const dep = (chainId: number): Deployment => ({ chainId, core: "0x00000000000000000000000000000000000000c0", ethVault: "0x00000000000000000000000000000000000000e7", rpcUrl: "http://rpc", rpcUrls: ["http://rpc"], fromBlock: 0n, erc20Vaults: [] });
const stubSync = (slot: number) => (async () => ({ finalizedSlot: slot, snapshot: () => ({ finalized: { beacon: { slot: String(slot) } }, finalizedFork: "fulu", current: { pubkeys: [], aggregate_pubkey: "0x" } }) })) as any;
const stubProver = (count: bigint, root: bigint, seen?: { slots?: string[] }) => (async (_lc: unknown, _rpc: string[], _core: string, slots: string[]) => { if (seen) seen.slots = slots; return { header: { number: 26_000_000n, hash: "0x", stateRoot: "0x", timestamp: 0n }, account: {}, values: [count, root] }; }) as any;

afterEach(() => { settings.set(defaultSettings()); verifyStatus.set({ kind: "idle" }); resetLightClient(); session.forget(); });

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
  it("proves spent status at keccak256(nullifier ‖ 8), and stays off the network when off or on a devnet", async () => {
    const nf = 0xbeefn;
    expect(nullifierSlot(nf)).toBe(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [nf, 8n]))); // forge: test_SpentNullifierSlot
    const seen: { slots?: string[] } = {};
    const prover = (async (_lc: unknown, _r: string[], _c: string, slots: string[]) => { seen.slots = slots; return { header: { number: 99n }, account: {}, values: slots.map((_, i) => (i === 0 ? 1n : 0n)) }; }) as any;
    await expect(provenSpent(dep(1), [nf, nf + 1n], { sync: stubSync(15_000_000), prover })).resolves.toEqual({ blockNumber: 99n, spent: [true, false] });
    expect(seen.slots).toEqual([nullifierSlot(nf), nullifierSlot(nf + 1n)]);
    await expect(provenSpent(dep(31337), [nf])).resolves.toBeNull();
    settings.set({ verifyReads: false });
    await expect(provenSpent(dep(1), [nf])).resolves.toBeNull();
  });
  it("reuses a light client synced in the last 20 minutes: beacon APIs are not asked right before each transaction", async () => {
    let syncs = 0;
    const sync = (async (...a: any[]) => { syncs++; return stubSync(15_000_000)(...a); }) as any;
    const t = await tree(12);
    for (let i = 0; i < 3; i++) await verifyTree(dep(1), t, undefined, { sync, prover: stubProver(12n, await rootOf(12)) });
    expect(syncs).toBe(1);
  });
  it("a reused client whose finalized block aged past the endpoints' proof window is synced again once, never failing every proof until the reuse ends (audit round 2, r25)", async () => {
    let syncs = 0;
    const sync = (async (...a: any[]) => { syncs++; return stubSync(15_000_000 + syncs)(...a); }) as any;
    const t = await tree(12);
    const good = stubProver(12n, await rootOf(12));
    await verifyTree(dep(1), t, undefined, { sync, prover: good });
    // minutes later the endpoints no longer serve state at the first sync's block
    const window = (async (lc: { finalizedSlot: number }, ...rest: unknown[]) => {
      if (lc.finalizedSlot === 15_000_001) throw new Error("no RPC answered eth_getProof: distance to target block exceeds maximum proof window");
      return (good as any)(lc, ...rest);
    }) as any;
    await expect(verifyTree(dep(1), t, undefined, { sync, prover: window })).resolves.toMatchObject({ kind: "verified" });
    expect(syncs, "synced again once").toBe(2);
    // a failure of a fresh client's proof is a failure
    resetLightClient();
    const down = (async () => { throw new Error("no RPC answered eth_getProof: fetch failed"); }) as any;
    await expect(verifyTree(dep(1), t, undefined, { sync, prover: down })).rejects.toThrow(/eth_getProof/);
    expect(syncs).toBe(3);
  });
  it("provenPool refuses a chain it has no light client for", async () => {
    await expect(provenPool(dep(31337))).rejects.toThrow(/no light client/);
  });
});
