// LIVE (read-only): the wallet's light client against Ethereum mainnet (Fulu data) and Sepolia (Gloas data)
// through public beacon APIs and RPCs. It syncs from a finalized root both configured beacon APIs report,
// proves a finalized header by the sync committee's signature, takes the execution block it commits to,
// accepts the RPC's header only by its hash and proves contract storage against it (WETH's `decimals`
// word and an empty slot). Then every link is bent on real data and must break: a checkpoint that is not
// the bootstrap, a finality branch, a signer bit, a header field, a proof node.
import { describe, it, expect } from "vitest";
import { bytesToHex, encodeFunctionData, parseAbi, type Hex } from "viem";
import { LightClient, LightClientError, MAINNET, SEPOLIA, ProofError, agreedFinalizedRoot, mappingSlot, provenStorage, syncLightClient, type BeaconChainSpec } from "../../src/sdk/lightclient";
import { beaconApi, type LightClientBootstrap, type LightClientUpdate } from "../../src/sdk/lightclient/beacon";
import { verifyHeader, verifyStorage } from "../../src/sdk/lightclient/execution";
import { currentSlot, periodAtSlot } from "../../src/sdk/lightclient/spec";
import { beaconBlockHeaderRoot } from "../../src/sdk/lightclient/ssz";

const CHAINS: { spec: BeaconChainSpec; rpc: string[]; weth: Hex; fork: string }[] = [
  // eth_getProof at the finalized block is 64–96 blocks deep: some public RPCs cap their proof window below that
  // (PublicNode ≈ 80 blocks on Sepolia, Tenderly fewer, Flashbots, 1RPC) and answer "distance to target block exceeds
  // maximum proof window"; the list is tried in order, so the deep-window endpoints come first (probed 2026-10-08).
  { spec: MAINNET, rpc: ["https://eth.drpc.org", "https://rpc.mevblocker.io", "https://eth.merkle.io"], weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", fork: "fulu" },
  { spec: SEPOLIA, rpc: ["https://rpc.sepolia.ethpandaops.io", "https://api.zan.top/eth-sepolia", "https://sepolia.rpc.thirdweb.com", "https://ethereum-sepolia-rpc.publicnode.com"], weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", fork: "gloas" },
];
type Versioned<T> = { version: string; data: T };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

async function ethCall(rpc: string, to: Hex, data: Hex, block: bigint): Promise<bigint> {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, `0x${block.toString(16)}`] }) });
  return BigInt((await r.json()).result);
}

for (const c of CHAINS) {
  describe(`light client on ${c.spec.name} (${c.fork} data), live`, () => {
    it("syncs from a cross-checked finalized root and proves WETH storage at the finalized execution block", async () => {
      const t0 = Date.now();
      const lc = await syncLightClient({ spec: c.spec });
      const synced = Date.now() - t0;
      expect(lc.period).toBe(periodAtSlot(currentSlot(c.spec)));
      expect(currentSlot(c.spec) - lc.finalizedSlot, "finalized within the last ~4 epochs").toBeLessThan(4 * 32);
      const decimalsSlot = "0x2" as Hex; // WETH9: name, symbol, decimals, balanceOf (mapping, slot 3)
      const emptySlot = "0x63" as Hex;
      const holderSlot = mappingSlot(BigInt(c.weth), 3); // WETH held by the WETH contract itself: a mapping entry, shaped like the core's nullifier flags
      const t1 = Date.now();
      const p = await provenStorage(lc, c.rpc, c.weth, [decimalsSlot, emptySlot, holderSlot]);
      const proved = Date.now() - t1;
      expect(p.values[0]).toBe(18n);
      expect(p.values[1], "an empty slot is proven absent").toBe(0n);
      expect(p.values[2], "a mapping entry proven = balanceOf at that block").toBe(await ethCall(c.rpc[0], c.weth, encodeFunctionData({ abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [c.weth] }), p.header.number));
      expect(p.account.codeHash).not.toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"); // a contract
      // the proven word equals what the contract itself returns at that block
      expect(await ethCall(c.rpc[0], c.weth, encodeFunctionData({ abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" }), p.header.number)).toBe(18n);
      console.log(`${c.spec.name}: finalized slot ${lc.finalizedSlot} → execution block ${p.header.number}; sync ${synced} ms, proofs ${proved} ms`);
    });

    it("walks the sync committees forward from a checkpoint two periods old, ending where the other API's chain is", async (ctx) => {
      const urls = c.spec.beaconApis;
      const period = periodAtSlot(currentSlot(c.spec));
      const header = async (u: string, slot: number) => { const r = await fetch(`${u}/eth/v1/beacon/headers/${slot}`).catch(() => null); return r?.ok ? ((await r.json()).data.root as Hex) : null; };
      let checkpoint: Hex | null = null;
      for (let slot = (period - 2) * 8192 + 32; slot < (period - 2) * 8192 + 32 * 12 && !checkpoint; slot += 32) {
        for (const u of urls) { checkpoint ??= await header(u, slot); }
      }
      if (!checkpoint) { console.warn(`${c.spec.name}: no block two periods back on either API; skipped`); ctx.skip(); return; }
      let lc: LightClient;
      try { lc = await syncLightClient({ spec: c.spec, checkpoint }); }
      catch (e) { if (/HTTP 404/.test(String(e))) { console.warn(`${c.spec.name}: ${String(e)}; skipped`); ctx.skip(); return; } throw e; }
      expect(lc.period).toBe(period);
      expect(currentSlot(c.spec) - lc.finalizedSlot).toBeLessThan(4 * 32);
      // anchored right: both APIs have exactly this finalized block at that slot
      const ours = bytesToHex(beaconBlockHeaderRoot(lc.finalizedHeader.beacon));
      for (const u of urls) { const theirs = await header(u, lc.finalizedSlot); if (theirs) expect(theirs).toBe(ours); }
      console.log(`${c.spec.name}: walked from period ${period - 2} to ${lc.period}`);
    });

    it("breaks on a bent checkpoint, finality branch, signer bit, header field or proof node", async () => {
      const urls = c.spec.beaconApis;
      const api = beaconApi(urls[0]);
      const root = await agreedFinalizedRoot(urls);
      const boot = await api<Versioned<LightClientBootstrap>>(`/eth/v1/beacon/light_client/bootstrap/${root}`);
      // a checkpoint that is not the bootstrap's block
      expect(() => LightClient.fromBootstrap(c.spec, ("0x" + "11".repeat(32)) as Hex, boot.data, boot.version)).toThrow(/trusted block root/);
      // a committee branch bent
      const badBoot = clone(boot.data); badBoot.current_sync_committee_branch[0] = ("0x" + "00".repeat(32)) as Hex;
      expect(() => LightClient.fromBootstrap(c.spec, root, badBoot, boot.version)).toThrow(/sync committee is not in its state/);
      const fresh = () => LightClient.fromBootstrap(c.spec, root, boot.data, boot.version);
      const lc = fresh();
      const learn = await api<Versioned<LightClientUpdate>[]>(`/eth/v1/beacon/light_client/updates?start_period=${lc.period}&count=1`);
      const fu = await api<Versioned<LightClientUpdate>>("/eth/v1/beacon/light_client/finality_update");
      const apply = (u: LightClientUpdate) => { const l = fresh(); l.applyUpdate(learn[0].data, learn[0].version); l.applyUpdate(u, fu.version); return l; };
      if (Number(fu.data.finalized_header.beacon.slot) <= lc.finalizedSlot) return; // nothing newer finalized since the bootstrap (rare)
      expect(apply(fu.data).finalizedSlot).toBe(Number(fu.data.finalized_header.beacon.slot));
      const b1 = clone(fu.data); b1.finality_branch[2] = ("0x" + "ab".repeat(32)) as Hex;
      expect(() => apply(b1)).toThrow(/finalized header is not the finalized checkpoint/);
      const b2 = clone(fu.data); // drop one signer: the aggregate no longer matches the signature
      const bits = b2.sync_aggregate.sync_committee_bits; const i = bits.slice(2).search(/[1-9a-f]/) + 2;
      const nib = parseInt(bits[i], 16); b2.sync_aggregate.sync_committee_bits = (bits.slice(0, i) + (nib & (nib - 1)).toString(16) + bits.slice(i + 1)) as Hex;
      expect(() => apply(b2)).toThrow(/signature does not verify/);
      const b3 = clone(fu.data); b3.finalized_header.beacon.slot = String(Number(b3.finalized_header.beacon.slot) + 32);
      expect(() => apply(b3)).toThrow(LightClientError);
      // the execution side: a header field bent, a proof node bent
      const synced = apply(fu.data);
      const blockHash = synced.finalizedExecutionBlockHash();
      const block = await (await fetch(c.rpc[0], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByHash", params: [blockHash, false] }) })).json();
      const header = verifyHeader(blockHash, block.result);
      expect(() => verifyHeader(blockHash, { ...block.result, stateRoot: "0x" + "22".repeat(32) })).toThrow(ProofError);
      const pr = await (await fetch(c.rpc[0], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getProof", params: [c.weth, ["0x" + "02".padStart(64, "0")], `0x${header.number.toString(16)}`] }) })).json();
      const sp = pr.result.storageProof[0].proof as Hex[];
      expect(verifyStorage(pr.result.storageHash, "0x2", sp)).toBe(18n);
      const bent = [...sp]; bent[bent.length - 1] = (bent[bent.length - 1].slice(0, -2) + (bent[bent.length - 1].endsWith("12") ? "13" : "12")) as Hex;
      expect(() => verifyStorage(pr.result.storageHash, "0x2", bent)).toThrow(ProofError);
    });
  });
}
