// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DomainSeparators
/// @notice One distinct tag per semantic object (spec §3), so a generic hash is never reused across
/// purposes. `DOM(tag) = keccak("privacy-protocol/v1/domain/<tag>") mod p`; the circuit, the
/// TypeScript and the Python references MUST use byte-identical tag strings (pinned decimals in
/// circuits/vectors/primitives.json). NOTE_BODY..PHANTOM_NULLIFIER prefix a Poseidon2 input;
/// OUTPUT_BINDING and TX_DOMAIN are keccak prefixes (spec §11–12).
library DomainSeparators {
    uint256 private constant F =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 internal constant NOTE_BODY         = uint256(keccak256("privacy-protocol/v1/domain/NOTE_BODY")) % F;
    uint256 internal constant NOTE_COMMITMENT   = uint256(keccak256("privacy-protocol/v1/domain/NOTE_COMMITMENT")) % F;
    uint256 internal constant OWNER_COMMITMENT  = uint256(keccak256("privacy-protocol/v1/domain/OWNER_COMMITMENT")) % F;
    uint256 internal constant NULLIFIER         = uint256(keccak256("privacy-protocol/v1/domain/NULLIFIER")) % F;
    uint256 internal constant PHANTOM_NULLIFIER = uint256(keccak256("privacy-protocol/v1/domain/PHANTOM_NULLIFIER")) % F;

    bytes internal constant OUTPUT_BINDING_TAG = "privacy-protocol/v1/domain/OUTPUT_BINDING";
    bytes32 internal constant TX_DOMAIN_TAG    = keccak256("privacy-protocol/v1/domain/TX_DOMAIN");
}
