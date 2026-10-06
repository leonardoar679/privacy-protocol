// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHasher} from "./IHasher.sol";
import {DomainSeparators} from "./DomainSeparators.sol";

/// @title NullifierLib
/// @notice 1:1 nullifier (spec §5.3) and the phantom-input nullifier (spec §5.4). PrivacyCore treats
/// nullifiers as opaque public inputs computed in-circuit; these helpers let the tests and the
/// references mirror the circuit exactly.
library NullifierLib {
    /// nullifier = Poseidon2(NULLIFIER, commitment, spendKey)   — 3 inputs
    function nullifier(IHasher h, uint256 commitment, uint256 spendKey) internal pure returns (uint256) {
        uint256[] memory in_ = new uint256[](3);
        in_[0] = DomainSeparators.NULLIFIER;
        in_[1] = commitment;
        in_[2] = spendKey;
        return h.poseidon2(in_);
    }

    /// phantom = Poseidon2(PHANTOM_NULLIFIER, nullifier0, inputIndex, spendKey0)   — 4 inputs.
    /// Unique per transaction, domain-separated from real nullifiers, and NOT recomputable by an
    /// observer (it includes the private spending key), so a 1-input transaction is
    /// indistinguishable from a 2-input one (PP-P02).
    function phantom(IHasher h, uint256 nullifier0, uint256 inputIndex, uint256 spendKey0)
        internal
        pure
        returns (uint256)
    {
        uint256[] memory in_ = new uint256[](4);
        in_[0] = DomainSeparators.PHANTOM_NULLIFIER;
        in_[1] = nullifier0;
        in_[2] = inputIndex;
        in_[3] = spendKey0;
        return h.poseidon2(in_);
    }
}
