// The Classic history against Ethereum mainnet (spec v3.0 §7.4; V7 Stage 7; verify-all --live). Two rungs:
//   1. the frontier of every pool, read now, plus its last deposit hash to its getLastRoot() exactly as the contract
//      inserts — the tree hash and the insertion semantics held to the live chain without any history;
//   2. the 100 ETH pool's history: the local snapshot (public/data/eth-100, `npm run snapshot -- --pool eth-100`) held to
//      its manifest, its checkpoint still standing, the delta synced to head − 12 and the whole tree's root a root the
//      pool knows with the leaf count its nextIndex — or, without a local snapshot, the same from the original UI's cache
//      and the full delta (a few minutes); skipped loudly when neither is on this machine.
// CLASSIC_RPC_URLS names the call endpoints and CLASSIC_LOG_RPC_URLS the log endpoints (the public ones otherwise).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRpc, PUBLIC_LOG_RPC_URLS, PUBLIC_RPC_URLS, readPins } from "../../scripts/deployment.mjs";
import { CLASSIC_UI_EVENTS, seedFromClassicUi } from "../../scripts/snapshot.mjs";
import { MerkleTree } from "../../src/crypto/tree";
import { decodeLogs, type Hex, type RawLog } from "../../src/history/events";
import { verifySnapshot, type SnapshotManifest, type SnapshotTexts } from "../../src/history/snapshot";
import { CONFIRMATIONS, findReorg, headBlockOf, syncDelta } from "../../src/history/sync";
import { readFrontier, rootFromFrontier, verifyAgainstChain } from "../../src/history/verify";

const list = (env: string | undefined, fallback: readonly string[]) =>
  (env ?? fallback.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const rpc = makeRpc(list(process.env.CLASSIC_RPC_URLS, PUBLIC_RPC_URLS));
const logRpc = makeRpc(list(process.env.CLASSIC_LOG_RPC_URLS, PUBLIC_LOG_RPC_URLS));
const pins = readPins() as { pools: Record<string, { address: string; deployedBlock: number; amount: string }> };
const hex32 = (x: bigint): Hex => `0x${x.toString(16).padStart(64, "0")}`;
const SNAPSHOT = join(__dirname, "..", "..", "public", "data", "eth-100");

/** The pool's newest deposit (its leaf index and commitment) from the last `span` blocks. */
async function lastDeposit(address: Hex, head: number, span: number) {
  const logs = (await logRpc("eth_getLogs", [
    { address, topics: [], fromBlock: `0x${(head - span).toString(16)}`, toBlock: `0x${head.toString(16)}` },
  ])) as RawLog[];
  const { deposits } = decodeLogs(logs, address);
  return deposits.at(-1) ?? null;
}

describe("the pools' frontiers", () => {
  for (const [pool, p] of Object.entries(pins.pools)) {
    it(`${pool}: filledSubtrees + the last deposit hash to getLastRoot() as the contract inserts`, async () => {
      const address = p.address.toLowerCase() as Hex;
      for (let attempt = 0; attempt < 2; attempt++) {
        const head = await headBlockOf(rpc);
        const frontier = await readFrontier(rpc, address);
        const last = await lastDeposit(address, head, 400_000);
        expect(last, "a deposit in the last 400,000 blocks").not.toBeNull();
        if (last!.leafIndex !== frontier.nextIndex - 1) continue; // a deposit landed between the reads: once more
        expect(hex32(rootFromFrontier(frontier.filledSubtrees, last!.leafIndex, BigInt(last!.commitment)))).toBe(frontier.lastRoot);
        console.info(
          `FRONTIER  ${pool}: nextIndex ${frontier.nextIndex}, last leaf ${last!.leafIndex} at block ${last!.blockNumber}, root ${frontier.lastRoot.slice(0, 18)}… reproduced`,
        );
        return;
      }
      throw new Error("the pool moved during both attempts");
    }, 120_000);
  }
});

describe("the 100 ETH pool's history", () => {
  const address = pins.pools["eth-100"].address.toLowerCase() as Hex;
  const haveSnapshot = existsSync(join(SNAPSHOT, "manifest.json"));
  const haveClone = existsSync(CLASSIC_UI_EVENTS);

  it.skipIf(!haveSnapshot)(
    "the local snapshot holds, its checkpoint stands, the delta syncs to head − 12 and the root is a root the pool knows with nextIndex leaves",
    async () => {
      const read = (name: string) => readFileSync(join(SNAPSHOT, name), "utf8");
      const manifest = JSON.parse(read("manifest.json")) as SnapshotManifest;
      const texts: SnapshotTexts = { "deposits.json": read("deposits.json"), "withdrawals.json": read("withdrawals.json"), "tree.json": read("tree.json") };
      const checked = await verifySnapshot(manifest, texts, { pool: { id: "eth-100", address } });
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!checked.ok) return;
      const { tree, deposits } = checked.snapshot;
      expect(await findReorg(rpc, [{ blockNumber: manifest.toBlock, blockHash: manifest.blockHash! }])).toEqual({ intact: true });
      const t0 = Date.now();
      const delta = await syncDelta({ rpc: logRpc, address, fromBlock: manifest.toBlock, leaves: deposits.length });
      for (const d of delta.deposits) tree.insert(BigInt(d.commitment));
      const chain = await verifyAgainstChain(rpc, address, tree);
      console.info(
        `HISTORY  eth-100: snapshot to block ${manifest.toBlock} (${deposits.length} leaves), delta ${delta.deposits.length} deposits / ${delta.withdrawals.length} withdrawals in ${delta.windows} windows (${Math.round((Date.now() - t0) / 1000)} s) to block ${delta.toBlock}; nextIndex ${chain.nextIndex}, root ${chain.known ? "known" : chain.lastRoot === chain.root ? "the last root" : "UNKNOWN"}`,
      );
      expect(chain.ok, JSON.stringify(chain)).toBe(true);
      expect(delta.toBlock).toBeGreaterThanOrEqual(manifest.toBlock);
    },
    600_000,
  );

  it.skipIf(haveSnapshot || !haveClone)(
    "without a local snapshot: the original UI's cache plus the full delta reach a root the pool knows (minutes)",
    async () => {
      const seed = seedFromClassicUi(pins.pools["eth-100"].amount)!;
      const t0 = Date.now();
      const delta = await syncDelta({ rpc: logRpc, address, fromBlock: seed.toBlock, leaves: seed.deposits.length });
      const tree = MerkleTree.fromLeaves([...seed.deposits, ...delta.deposits].map((d) => BigInt(d.commitment)));
      const chain = await verifyAgainstChain(rpc, address, tree);
      console.info(
        `HISTORY  eth-100 from the cache: ${seed.deposits.length} + ${delta.deposits.length} leaves in ${delta.windows} windows, ${Math.round((Date.now() - t0) / 1000)} s; nextIndex ${chain.nextIndex}, root known ${chain.known}`,
      );
      expect(chain.ok, JSON.stringify(chain)).toBe(true);
      expect(delta.toBlock).toBeGreaterThan(seed.toBlock + CONFIRMATIONS);
    },
    900_000,
  );

  it.skipIf(haveSnapshot || haveClone)("neither a local snapshot nor the classic-ui clone is on this machine", () => {
    console.info("SKIP  the history rung needs public/data/eth-100 (npm run snapshot -- --pool eth-100) or the classic-ui clone beside the repository");
  });
});
