// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHasher} from "../libraries/IHasher.sol";
import {FieldLib} from "../libraries/FieldLib.sol";
import {LibPoseidon2Yul} from "./poseidon2/LibPoseidon2Yul.sol";
import {Poseidon2} from "./poseidon2/Poseidon2.sol";

/// @title Poseidon2Hasher
/// @notice The production IHasher: Poseidon2 over BN254, t = 4, with the Noir/barretenberg sponge
/// (spec §2) — the exact function circuits/lib/poseidon2_hash.circom and the wallet reference compute.
/// Stateless, ownerless, pure. Two vendored implementations (see poseidon2/VENDORED.md): the inlined
/// Yul library for 1–3 inputs (every hot path), pure Solidity for 4–6 inputs (deposit note body).
/// @dev Inputs >= p are rejected, never reduced: x and x + p would otherwise hash identically.
contract Poseidon2Hasher is IHasher {
    error InputNotInField();
    error UnsupportedArity();

    function poseidon2(uint256[] memory input) external pure returns (uint256) {
        uint256 n = input.length;
        for (uint256 i; i < n; ++i) {
            if (input[i] >= FieldLib.FIELD_SIZE) revert InputNotInField();
        }
        if (n == 1) return LibPoseidon2Yul.hash_1(input[0]);
        if (n == 2) return LibPoseidon2Yul.hash_2(input[0], input[1]);
        if (n == 3) return LibPoseidon2Yul.hash_3(input[0], input[1], input[2]);
        if (n >= 4 && n <= 6) return Poseidon2.hash(input);
        revert UnsupportedArity();
    }
}
