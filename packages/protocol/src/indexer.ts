// Reorg-aware shielded-state indexer (spec §9, plan §40): the wallet mirrors the on-chain tree from
// NoteInserted events, keeps (blockNumber, blockHash, parentHash, root, leafIndex) per block, detects
// block replacement by hash mismatch, rolls its tree back to the common ancestor, and re-applies the
// canonical blocks. The contract cannot prevent a reorg; a wallet that ignores one would prove
// against a root the canonical chain never produced (UnknownRoot) or spend notes that no longer exist.
import { MerkleTree, type TreeSnapshot } from "./merkle";

export interface Block {
  number: number;
  hash: bigint;
  parentHash: bigint;
  groups: bigint[][]; // the aligned leaf groups this block appended, in order
}

/** What the indexer can ask of a node: the canonical block at a height (null above the tip). */
export interface ChainView {
  tip(): number;
  blockAt(n: number): Block | null;
}

interface Checkpoint {
  number: number;
  hash: bigint;
  parentHash: bigint;
  root: bigint;
  nextIndex: number;
  snapshot: TreeSnapshot; // state BEFORE this block, so the block can be undone
}

export class ReorgDetected extends Error {
  constructor(public readonly atBlock: number) {
    super(`reorg detected at block ${atBlock}`);
  }
}

export class ShieldedIndexer {
  readonly tree: MerkleTree;
  private history: Checkpoint[] = [];
  rollbacks = 0;

  constructor(levels: number) {
    this.tree = new MerkleTree(levels);
  }

  get root(): bigint {
    return this.tree.root;
  }

  get head(): Checkpoint | undefined {
    return this.history[this.history.length - 1];
  }

  /** Every root this indexer has seen on the canonical chain, oldest first. */
  roots(): bigint[] {
    return this.history.map((c) => c.root);
  }

  /** Apply one block that must extend the current head; throws ReorgDetected if it does not. */
  applyBlock(b: Block): void {
    const head = this.head;
    if (head && b.parentHash !== head.hash) throw new ReorgDetected(b.number);
    const snapshot = this.tree.snapshot();
    for (const g of b.groups) this.tree.insertGroup(g);
    this.history.push({ number: b.number, hash: b.hash, parentHash: b.parentHash, root: this.tree.root, nextIndex: this.tree.nextIndex, snapshot });
  }

  /** Undo blocks above `number` (keeps `number`). */
  rollbackTo(number: number): void {
    while (this.history.length && this.history[this.history.length - 1].number > number) {
      const c = this.history.pop()!;
      this.tree.restore(c.snapshot);
      this.rollbacks++;
    }
  }

  /**
   * Bring the local state in line with the canonical chain: walk back from the local head until a
   * block whose hash the chain still agrees with (the common ancestor), roll back to it, then apply
   * every canonical block above it. Returns the number of blocks undone.
   */
  sync(chain: ChainView): number {
    let ancestor = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const c = this.history[i];
      const canonical = chain.blockAt(c.number);
      if (canonical && canonical.hash === c.hash) {
        ancestor = c.number;
        break;
      }
    }
    const before = this.history.length;
    this.rollbackTo(ancestor);
    const undone = before - this.history.length;
    for (let n = ancestor + 1; n <= chain.tip(); n++) {
      const b = chain.blockAt(n);
      if (!b) break;
      this.applyBlock(b);
    }
    return undone;
  }
}
