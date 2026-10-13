//! Append-only Merkle accumulator with 4-aligned leaf groups — the off-chain mirror of
//! MerkleAccumulator.sol (spec §9) and packages/protocol/src/merkle.ts. ZERO_LEAF matches the
//! contract's keccak-derived empty-leaf constant.
use crate::domains::keccak256;
use crate::field::{fr_from_be_mod, Fr};
use crate::poseidon2::hash2;
use std::sync::OnceLock;

pub const GROUP_SIZE: usize = 4;

pub fn zero_leaf() -> Fr {
    static CELL: OnceLock<Fr> = OnceLock::new();
    *CELL.get_or_init(|| fr_from_be_mod(&keccak256(b"privacy-protocol/v1/empty-leaf")))
}

/// z[0] = ZERO_LEAF, z[i+1] = H(z[i], z[i]); z[levels] is the empty-tree root.
pub fn zero_hashes(levels: usize) -> Vec<Fr> {
    let mut z = Vec::with_capacity(levels + 1);
    z.push(zero_leaf());
    for i in 0..levels {
        let h = hash2(z[i], z[i]);
        z.push(h);
    }
    z
}

#[derive(Clone, Debug)]
pub struct TreeSnapshot {
    pub filled: Vec<Fr>,
    pub next_index: usize,
    pub root: Fr,
    pub leaf_count: usize,
}

/// Incremental tree, group insertion only (mirrors `_insertGroup`).
#[derive(Clone, Debug)]
pub struct MerkleTree {
    pub levels: usize,
    zeros: Vec<Fr>,
    filled: Vec<Fr>,
    /// always a multiple of GROUP_SIZE
    pub next_index: usize,
    pub root: Fr,
    /// flat, incl. ZERO_LEAF padding — what `merkle_proof` consumes
    pub leaves: Vec<Fr>,
}

impl MerkleTree {
    pub fn new(levels: usize) -> Self {
        assert!((3..=32).contains(&levels), "levels out of range");
        let zeros = zero_hashes(levels);
        let filled = zeros[..levels].to_vec();
        let root = zeros[levels];
        Self { levels, zeros, filled, next_index: 0, root, leaves: Vec::new() }
    }

    /// O(levels) checkpoint of the incremental state, for reorg rollback.
    pub fn snapshot(&self) -> TreeSnapshot {
        TreeSnapshot { filled: self.filled.clone(), next_index: self.next_index, root: self.root, leaf_count: self.leaves.len() }
    }

    pub fn restore(&mut self, s: &TreeSnapshot) {
        self.filled = s.filled.clone();
        self.next_index = s.next_index;
        self.root = s.root;
        self.leaves.truncate(s.leaf_count);
    }

    /// A deposit: one commitment + three empty leaves. Returns the leaf index.
    pub fn insert_leaf(&mut self, leaf: Fr) -> usize {
        let z = zero_leaf();
        self.insert_group(&[leaf, z, z, z])
    }

    /// Append one aligned group; returns the index of its first leaf.
    pub fn insert_group(&mut self, group: &[Fr; GROUP_SIZE]) -> usize {
        let first = self.next_index;
        assert!(first + GROUP_SIZE < (1usize << self.levels), "tree full");
        let mut h = hash2(hash2(group[0], group[1]), hash2(group[2], group[3]));
        let mut cur = first / GROUP_SIZE;
        for i in 2..self.levels {
            if cur % 2 == 0 {
                self.filled[i] = h;
                h = hash2(h, self.zeros[i]);
            } else {
                h = hash2(self.filled[i], h);
            }
            cur /= 2;
        }
        self.root = h;
        self.leaves.extend_from_slice(group);
        self.next_index = first + GROUP_SIZE;
        first
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MerkleProof {
    pub root: Fr,
    pub path_elements: Vec<Fr>,
    pub path_indices: Vec<u8>,
}

/// Every layer of the tree holding `leaves` (flat, with padding): `layers[0]` is the leaves, and
/// `layers[l + 1][i] = H(layers[l][2i], layers[l][2i + 1])` with the empty-subtree hash `z[l]` standing in
/// for a missing right sibling, up to `layers[levels] = [root]`. About one hash per leaf, once; every
/// authentication path is then a lookup (`proof_from_layers`). No leaves: every layer is empty and the
/// root is the empty-tree root. This is the batch the WASM / native wallets run a sync through.
pub fn layers(leaves: &[Fr], levels: usize) -> Vec<Vec<Fr>> {
    let z = zero_hashes(levels);
    let mut out: Vec<Vec<Fr>> = Vec::with_capacity(levels + 1);
    out.push(leaves.to_vec());
    for lvl in 0..levels {
        let layer = &out[lvl];
        let mut next = Vec::with_capacity(layer.len().div_ceil(2));
        let mut k = 0;
        while k < layer.len() {
            let right = if k + 1 < layer.len() { layer[k + 1] } else { z[lvl] };
            next.push(hash2(layer[k], right));
            k += 2;
        }
        out.push(next);
    }
    out
}

/// The root a `layers(..)` result stands for (the empty-tree root when there are no leaves).
pub fn layers_root(layers: &[Vec<Fr>], levels: usize) -> Fr {
    assert_eq!(layers.len(), levels + 1, "layers must have levels + 1 entries");
    layers[levels].first().copied().unwrap_or_else(|| zero_hashes(levels)[levels])
}

/// Root + authentication path of leaf `index` from precomputed layers.
pub fn proof_from_layers(layers: &[Vec<Fr>], index: usize, levels: usize) -> MerkleProof {
    assert_eq!(layers.len(), levels + 1, "layers must have levels + 1 entries");
    assert!(index < layers[0].len(), "leaf index out of range");
    let z = zero_hashes(levels);
    let mut path_elements = Vec::with_capacity(levels);
    let mut path_indices = Vec::with_capacity(levels);
    let mut idx = index;
    for lvl in 0..levels {
        let bit = idx % 2;
        let sib = if bit == 1 { idx - 1 } else { idx + 1 };
        path_elements.push(if sib < layers[lvl].len() { layers[lvl][sib] } else { z[lvl] });
        path_indices.push(bit as u8);
        idx /= 2;
    }
    MerkleProof { root: layers[levels][0], path_elements, path_indices }
}

/// Root + authentication path of leaf `index` in the tree holding `leaves` (flat, with padding).
pub fn merkle_proof(leaves: &[Fr], index: usize, levels: usize) -> MerkleProof {
    assert!(index < leaves.len(), "leaf index out of range");
    proof_from_layers(&layers(leaves, levels), index, levels)
}

/// Fold a leaf up an authentication path (the circuit's Merkle check): `path_indices[i]` = 1 when the
/// node is the right child at level i.
pub fn fold_path(leaf: Fr, path_elements: &[Fr], path_indices: &[u8]) -> Fr {
    assert_eq!(path_elements.len(), path_indices.len(), "path length mismatch");
    let mut h = leaf;
    for (sib, bit) in path_elements.iter().zip(path_indices) {
        h = if *bit == 1 { hash2(*sib, h) } else { hash2(h, *sib) };
    }
    h
}
