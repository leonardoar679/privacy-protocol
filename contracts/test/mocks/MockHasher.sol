// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHasher} from "../../src/libraries/IHasher.sol";

/// @dev Deterministic, field-reduced stand-in for the hash so the fund-safety / asset-isolation
/// state machine is testable without a circuit. NOT Poseidon2 (keccak-based); the real-crypto
/// suites (test/hasher, test/e2e) use src/hasher/Poseidon2Hasher. Tree logic only needs a
/// deterministic collision-resistant map into the field.
contract MockHasher is IHasher {
    uint256 internal constant FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function poseidon2(uint256[] memory input) external pure returns (uint256) {
        return uint256(keccak256(abi.encode(input))) % FIELD;
    }
}
