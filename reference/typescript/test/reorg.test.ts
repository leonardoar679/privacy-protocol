import { describe, it, expect } from "vitest";
import { MerkleTree, ZERO_LEAF } from "../src/merkle";
import { ShieldedIndexer, ReorgDetected, type Block, type ChainView } from "../src/indexer";

// A simulated chain: blocks carry leaf groups; a reorg replaces the last `depth` blocks with
// different blocks (different content and hashes) on top of the same ancestor.
class SimChain implements ChainView {
  blocks: Block[] = [];
  private seed = 1n;
  constructor(public readonly levels: number) {}

  private nextLeaf(): bigint {
    this.seed = (this.seed * 6364136223846793005n + 1442695040888963407n) % (1n << 128n);
    return this.seed + 1n;
  }

  mine(groupsPerBlock: number): Block {
    const parent = this.blocks[this.blocks.length - 1];
    const number = parent ? parent.number + 1 : 0;
    const groups = Array.from({ length: groupsPerBlock }, () => [this.nextLeaf(), this.nextLeaf(), this.nextLeaf(), ZERO_LEAF]);
    const hash = (BigInt(number) << 200n) ^ this.nextLeaf();
    const b = { number, hash, parentHash: parent ? parent.hash : 0n, groups };
    this.blocks.push(b);
    return b;
  }

  /** Replace the last `depth` blocks with a competing branch of the same height. */
  reorg(depth: number): void {
    this.blocks.length -= depth;
    for (let i = 0; i < depth; i++) this.mine(2);
  }

  tip(): number {
    return this.blocks.length - 1;
  }

  blockAt(n: number): Block | null {
    return this.blocks[n] ?? null;
  }

  /** The canonical on-chain tree, recomputed from scratch (the ground truth). */
  canonicalRoot(): bigint {
    const t = new MerkleTree(this.levels);
    for (const b of this.blocks) for (const g of b.groups) t.insertGroup(g);
    return t.root;
  }
}

describe("reorg-aware indexer (plan §40, §78)", () => {
  for (const depth of [1, 3, 12, 64]) {
    it(`detects a depth-${depth} reorg, rolls back to the ancestor and re-syncs to the canonical root`, () => {
      const chain = new SimChain(12);
      const idx = new ShieldedIndexer(12);
      for (let i = 0; i < 80; i++) idx.applyBlock(chain.mine(1));
      expect(idx.root).toBe(chain.canonicalRoot());
      const staleRoot = idx.root;
      const headBefore = idx.head!.number;

      chain.reorg(depth);
      // Naively applying the next block is refused: its parent is not our head.
      expect(() => idx.applyBlock(chain.blockAt(chain.tip())!)).toThrow(ReorgDetected);

      const undone = idx.sync(chain);
      expect(undone).toBe(depth);
      expect(idx.head!.number).toBe(headBefore);
      expect(idx.root).toBe(chain.canonicalRoot());
      // The root the wallet held before the reorg was never produced by the canonical chain: a
      // proof against it would fail the contract's isKnownRoot.
      expect(idx.roots()).not.toContain(staleRoot);
    });
  }

  it("sync is a no-op without a reorg", () => {
    const chain = new SimChain(12);
    const idx = new ShieldedIndexer(12);
    for (let i = 0; i < 10; i++) idx.applyBlock(chain.mine(1));
    chain.mine(1);
    expect(idx.sync(chain)).toBe(0);
    expect(idx.root).toBe(chain.canonicalRoot());
  });
});

describe("root stress (plan §78, in-process size)", () => {
  it("1,000 groups: incremental root == recomputed root, cursor aligned", () => {
    const t = new MerkleTree(32);
    const leaves: bigint[] = [];
    for (let i = 0; i < 1000; i++) {
      const g = [BigInt(i) + 1n, BigInt(i) + 2n, BigInt(i) + 3n, ZERO_LEAF];
      t.insertGroup(g);
      leaves.push(...g);
    }
    expect(t.nextIndex).toBe(4000);
    const fresh = new MerkleTree(32);
    for (let i = 0; i < leaves.length; i += 4) fresh.insertGroup(leaves.slice(i, i + 4));
    expect(fresh.root).toBe(t.root);
  }, 120_000);
});
