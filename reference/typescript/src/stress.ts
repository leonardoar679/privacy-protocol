// Root stress (plan §78): N aligned-group insertions into a depth-32 tree, then a sampled
// membership check against the final root. Usage: npx tsx src/stress.ts [groups=100000]
import { MerkleTree, ZERO_LEAF, merkleProof } from "./merkle";

const N = Number(process.argv[2] ?? 100_000);
const t = new MerkleTree(32);
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const b = BigInt(i) * 4n;
  t.insertGroup([b + 1n, b + 2n, b + 3n, ZERO_LEAF]);
  if ((i + 1) % 10_000 === 0) console.log(`${i + 1} groups, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
const dt = (Date.now() - t0) / 1000;
console.log(`inserted ${N} groups (${N * 4} leaves) in ${dt.toFixed(1)} s = ${(1000 * dt / N).toFixed(2)} ms/group (33 Poseidon2 hashes each)`);

// spot-check: a leaf's authentication path folds to the root (full recompute over 4N leaves)
const probe = Math.floor(N / 2) * 4 + 1;
const t1 = Date.now();
const { root } = merkleProof(t.leaves, probe, 32);
console.log(`merkleProof(leaf ${probe}) root ${root === t.root ? "matches" : "MISMATCH"} (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
process.exit(root === t.root ? 0 : 1);
