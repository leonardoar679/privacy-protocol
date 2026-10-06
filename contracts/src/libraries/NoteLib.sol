// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHasher} from "./IHasher.sol";
import {DomainSeparators} from "./DomainSeparators.sol";

/// @title NoteLib
/// @notice Two-layer note commitment (spec §5.2). The body binds asset / amount / owner / a per-note
/// secret (so a known owner commitment cannot be dictionary-attacked against amounts, PP-P01); the
/// final commitment additionally binds the contract-assigned leaf index (structural uniqueness).
library NoteLib {
    /// body = Poseidon2(NOTE_BODY, vaultId, amount, ownerCommitment, noteSecret)   — 5 inputs
    function noteBody(IHasher h, uint256 vaultId, uint256 amount, uint256 owner, uint256 noteSecret)
        internal
        pure
        returns (uint256)
    {
        uint256[] memory in_ = new uint256[](5);
        in_[0] = DomainSeparators.NOTE_BODY;
        in_[1] = vaultId;
        in_[2] = amount;
        in_[3] = owner;
        in_[4] = noteSecret;
        return h.poseidon2(in_);
    }

    /// commitment = Poseidon2(NOTE_COMMITMENT, body, leafIndex)   — 3 inputs
    function noteCommitment(IHasher h, uint256 body, uint256 leafIndex) internal pure returns (uint256) {
        uint256[] memory in_ = new uint256[](3);
        in_[0] = DomainSeparators.NOTE_COMMITMENT;
        in_[1] = body;
        in_[2] = leafIndex;
        return h.poseidon2(in_);
    }

    /// ownerCommitment = Poseidon2(OWNER_COMMITMENT, spendKey)   — 2 inputs (reference/tests only;
    /// the core never sees a spending key)
    function ownerCommitment(IHasher h, uint256 spendKey) internal pure returns (uint256) {
        uint256[] memory in_ = new uint256[](2);
        in_[0] = DomainSeparators.OWNER_COMMITMENT;
        in_[1] = spendKey;
        return h.poseidon2(in_);
    }
}
