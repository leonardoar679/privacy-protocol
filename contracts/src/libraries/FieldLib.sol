// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FieldLib
/// @notice Canonical field / bit-width bounds for every value that reaches the verifier or a hash
/// (spec §1). Closes the field-aliasing class: `x` and `x + p` are the same field element but
/// different Solidity mapping keys, so a non-canonical value is rejected, never reduced.
library FieldLib {
    /// BN254 scalar field modulus.
    uint256 internal constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error InvalidField();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidLeafIndex();

    function requireField(uint256 x) internal pure {
        if (x >= FIELD_SIZE) revert InvalidField();
    }

    function requireAddress(uint256 x) internal pure {
        if (x >= (uint256(1) << 160)) revert InvalidAddress();
    }

    function requireAmount(uint256 x) internal pure {
        if (x >= (uint256(1) << 248)) revert InvalidAmount();
    }

    function requireLeafIndex(uint256 x) internal pure {
        if (x >= (uint256(1) << 32)) revert InvalidLeafIndex();
    }
}
