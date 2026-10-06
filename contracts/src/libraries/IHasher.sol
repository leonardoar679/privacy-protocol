// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IHasher
/// @notice The protocol hash behind an interface, so PrivacyCore stays independent of the concrete
/// implementation and the mock suites can inject a stand-in (MockHasher: keccak-based, NOT Poseidon2).
/// Whatever is deployed MUST be exactly the instance pinned in docs/protocol-spec-v1.0.md §2 —
/// Poseidon2 / BN254 / t=4 with the Noir sponge — or no root a proof references will ever exist
/// on-chain. The production implementation is src/hasher/Poseidon2Hasher.sol, checked against the
/// nargo vectors and circuits/vectors/primitives.json.
interface IHasher {
    /// @param input 1..6 canonical field elements (each < p); reverts otherwise
    function poseidon2(uint256[] memory input) external pure returns (uint256);
}
