// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHasher} from "./IHasher.sol";
import {FieldLib} from "./FieldLib.sol";

/// @title MerkleAccumulator
/// @notice Append-only Poseidon2 Merkle tree with **4-aligned leaf groups** and a **block-based**
/// root history (spec §9).
/// @dev Groups: every operation appends one aligned group of 4 leaves (a deposit = one commitment +
/// 3 empty leaves, a transaction = 3 output commitments + 1 empty leaf). The group's 4-leaf subtree
/// is hashed (≤ 3 hashes) and then walked up from level 2, so a transaction costs 33 hashes instead
/// of 3 × 32. The circuit's membership path is the ordinary single-leaf path and knows nothing about
/// groups. Empty leaves hold ZERO_LEAF, which has no known preimage and is therefore unspendable.
/// Root freshness is measured in BLOCKS, never in a count of later insertions (fixes the Classic
/// "liveness cliff", TC-10/TC-14): a root stays valid for ROOT_HISTORY_BLOCKS after it is produced.
abstract contract MerkleAccumulator {
    uint256 internal constant FIELD_SIZE = FieldLib.FIELD_SIZE;
    uint256 public constant ZERO_LEAF = uint256(keccak256("privacy-protocol/v1/empty-leaf")) % FIELD_SIZE;
    uint256 public constant GROUP_SIZE = 4;
    /// Validity window in blocks (spec §9; engineering parameter, benchmark may tune 2048/4096/8192).
    uint256 public constant ROOT_HISTORY_BLOCKS = 4096;

    IHasher internal immutable _HASHER;
    uint256 public immutable LEVELS;

    /// Always a multiple of GROUP_SIZE.
    uint32 public nextLeafIndex;
    bytes32 public currentRoot;

    mapping(uint256 => uint256) private _filledSubtrees; // levels 2 .. LEVELS-1
    mapping(uint256 => uint256) private _zeros; // _zeros[i] = root of an empty subtree of height i
    mapping(bytes32 => bool) public rootKnown;
    mapping(bytes32 => uint256) public rootBlock; // root => block number it was first produced
    bytes32[] public rootHistory;

    error LevelsOutOfRange();
    error TreeFull();
    error ValueOutOfField();

    constructor(uint256 levels_, IHasher hasher_) {
        if (levels_ < 3 || levels_ > 32) revert LevelsOutOfRange();
        LEVELS = levels_;
        _HASHER = hasher_;

        uint256 cur = ZERO_LEAF;
        for (uint256 i = 0; i < levels_; i++) {
            _zeros[i] = cur;
            _filledSubtrees[i] = cur;
            cur = _hashLeftRight(cur, cur);
        }
        _recordRoot(bytes32(cur));
    }

    function _hashLeftRight(uint256 left, uint256 right) internal view returns (uint256) {
        if (left >= FIELD_SIZE || right >= FIELD_SIZE) revert ValueOutOfField();
        uint256[] memory in_ = new uint256[](2);
        in_[0] = left;
        in_[1] = right;
        return _HASHER.poseidon2(in_);
    }

    /// @dev Append one aligned group of 4 leaves; returns the index of its first leaf.
    /// Capacity is 2^LEVELS − GROUP_SIZE leaves (the final group is never used, so the uint32
    /// cursor cannot wrap).
    function _insertGroup(uint256[4] memory leaves) internal returns (uint32 firstIndex) {
        firstIndex = nextLeafIndex;
        uint256 next = uint256(firstIndex) + GROUP_SIZE;
        if (next >= (uint256(1) << LEVELS)) revert TreeFull();

        // 4-leaf subtree (level 2). A deposit's two empty right leaves fold to the precomputed zero.
        uint256 right = (leaves[2] == ZERO_LEAF && leaves[3] == ZERO_LEAF)
            ? _zeros[1]
            : _hashLeftRight(leaves[2], leaves[3]);
        uint256 h = _hashLeftRight(_hashLeftRight(leaves[0], leaves[1]), right);

        uint256 cur = uint256(firstIndex) / GROUP_SIZE; // the group's node index at level 2
        for (uint256 i = 2; i < LEVELS; i++) {
            uint256 left;
            uint256 rightNode;
            if (cur % 2 == 0) {
                left = h;
                rightNode = _zeros[i];
                _filledSubtrees[i] = h;
            } else {
                left = _filledSubtrees[i];
                rightNode = h;
            }
            h = _hashLeftRight(left, rightNode);
            cur /= 2;
        }
        nextLeafIndex = uint32(next);
        _recordRoot(bytes32(h));
    }

    function _recordRoot(bytes32 r) private {
        currentRoot = r;
        if (!rootKnown[r]) {
            rootKnown[r] = true;
            rootBlock[r] = block.number;
            rootHistory.push(r);
        }
    }

    /// @notice A root is accepted if it is the current root, or a historical root produced within
    /// the last ROOT_HISTORY_BLOCKS blocks.
    function isKnownRoot(bytes32 root) public view returns (bool) {
        if (root == bytes32(0)) return false;
        if (root == currentRoot) return true;
        if (!rootKnown[root]) return false;
        return block.number - rootBlock[root] <= ROOT_HISTORY_BLOCKS;
    }

    function rootHistoryLength() external view returns (uint256) {
        return rootHistory.length;
    }

    function zeros(uint256 i) external view returns (uint256) {
        return _zeros[i];
    }
}
